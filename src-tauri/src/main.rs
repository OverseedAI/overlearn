use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

// Generous: on first macOS launch Gatekeeper deep-scans the ~64MB sidecar
// before it may execute, which alone can take several seconds.
const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(30);
const DAEMON_POLL_INTERVAL: Duration = Duration::from_millis(100);
const HTTP_TIMEOUT: Duration = Duration::from_millis(800);
const STALE_DAEMON_TERM_TIMEOUT: Duration = Duration::from_secs(3);
const STALE_DAEMON_KILL_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
struct RunningDaemon {
    pid: u32,
    port: u16,
    token: String,
    data_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
struct DaemonMetadata {
    pid: u32,
    port: u16,
    token: String,
    #[serde(rename = "startedAt")]
    _started_at: String,
}

#[derive(Debug, Deserialize)]
struct HealthPayload {
    ok: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusPayload {
    status: String,
    _has_seen_wait: bool,
}

#[derive(Debug, Serialize)]
struct DaemonInfo {
    port: u16,
    token: String,
}

#[derive(Default)]
struct DesktopState {
    window_focused: AtomicBool,
    sse_generation: AtomicU64,
    current_status: Mutex<Option<String>>,
    daemon: Mutex<Option<RunningDaemon>>,
    quitting: AtomicBool,
}

impl DesktopState {
    fn replace_status(&self, status: String) -> Result<Option<String>, String> {
        let mut current = lock_mutex(&self.current_status)?;
        Ok(current.replace(status))
    }

    fn cancel_sse(&self) {
        self.sse_generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut status) = self.current_status.lock() {
            *status = None;
        }
    }

    fn next_sse_generation(&self) -> u64 {
        self.sse_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn sse_generation(&self) -> u64 {
        self.sse_generation.load(Ordering::SeqCst)
    }

    fn set_daemon(&self, daemon: Option<RunningDaemon>) -> Result<(), String> {
        *lock_mutex(&self.daemon)? = daemon;
        Ok(())
    }

    fn take_daemon(&self) -> Result<Option<RunningDaemon>, String> {
        Ok(lock_mutex(&self.daemon)?.take())
    }

    fn daemon_info_snapshot(&self) -> Result<Option<DaemonInfo>, String> {
        let daemon = lock_mutex(&self.daemon)?;
        let Some(daemon) = daemon.as_ref() else {
            return Ok(None);
        };

        Ok(Some(DaemonInfo {
            port: daemon.port,
            token: daemon.token.clone(),
        }))
    }
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Desktop state lock was poisoned.".to_string())
}

#[tauri::command]
async fn daemon_info(state: tauri::State<'_, DesktopState>) -> Result<DaemonInfo, String> {
    wait_for_daemon_info(state.inner(), DAEMON_START_TIMEOUT, DAEMON_POLL_INTERVAL).await
}

async fn wait_for_daemon_info(
    state: &DesktopState,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<DaemonInfo, String> {
    let deadline = Instant::now() + timeout;

    loop {
        if let Some(info) = state.daemon_info_snapshot()? {
            return Ok(info);
        }

        if Instant::now() >= deadline {
            return Err("Overlearn daemon did not start in time.".to_string());
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        let delay = poll_interval.min(remaining);
        if delay.is_zero() {
            continue;
        }

        tauri::async_runtime::spawn_blocking(move || thread::sleep(delay))
            .await
            .map_err(|error| format!("Daemon info wait failed: {error}"))?;
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(stringify_error)
}

fn daemon_metadata_path(data_dir: &Path) -> PathBuf {
    data_dir.join("daemon.json")
}

fn read_daemon_metadata(data_dir: &Path) -> Result<Option<DaemonMetadata>, String> {
    let path = daemon_metadata_path(data_dir);
    if !path.exists() {
        return Ok(None);
    }

    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    Ok(serde_json::from_str(&contents).ok())
}

fn read_live_daemon(data_dir: &Path) -> Result<Option<RunningDaemon>, String> {
    let Some(metadata) = read_daemon_metadata(data_dir)? else {
        return Ok(None);
    };

    if !pid_is_alive(metadata.pid) {
        return Ok(None);
    }

    let Some(health) = get_daemon_health(metadata.port, &metadata.token)? else {
        return Ok(None);
    };

    if !health.ok {
        return Ok(None);
    }

    Ok(Some(RunningDaemon {
        pid: metadata.pid,
        port: metadata.port,
        token: metadata.token,
        data_dir: data_dir.to_path_buf(),
    }))
}

fn wait_for_live_daemon(data_dir: &Path) -> Result<RunningDaemon, String> {
    let started_at = SystemTime::now();

    while started_at.elapsed().unwrap_or_default() < DAEMON_START_TIMEOUT {
        if let Some(daemon) = read_live_daemon(data_dir)? {
            return Ok(daemon);
        }

        thread::sleep(DAEMON_POLL_INTERVAL);
    }

    Err(format!(
        "Daemon did not become healthy within {} seconds.",
        DAEMON_START_TIMEOUT.as_secs()
    ))
}

fn start_app_daemon(app: &AppHandle) -> Result<RunningDaemon, String> {
    let data_dir = app_data_dir(app)?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Failed to create {}: {error}", data_dir.display()))?;

    terminate_existing_daemon(&data_dir)?;

    let mut command = app
        .shell()
        .sidecar("learn")
        .map_err(stringify_error)?
        .arg("daemon")
        .env("OVERLEARN_DATA_DIR", data_dir.display().to_string());

    #[cfg(debug_assertions)]
    {
        command = command.env("OVERLEARN_DEV_ORIGINS", tauri_dev_origins());
    }

    let (mut rx, child) = command.spawn().map_err(stringify_error)?;
    let child_pid = child.pid();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    eprintln!("{}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Stdout(line) => {
                    eprintln!("{}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Error(error) => {
                    eprintln!("Overlearn sidecar error: {error}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "Overlearn sidecar {child_pid} exited with code {:?}.",
                        payload.code
                    );
                }
                _ => {}
            }
        }
    });

    wait_for_live_daemon(&data_dir)
}

#[cfg(debug_assertions)]
fn tauri_dev_origins() -> String {
    const VITE_DEV_ORIGINS: &str = "http://localhost:1420,http://127.0.0.1:1420";

    match std::env::var("OVERLEARN_DEV_ORIGINS") {
        Ok(existing) if !existing.trim().is_empty() => format!("{existing},{VITE_DEV_ORIGINS}"),
        _ => VITE_DEV_ORIGINS.to_string(),
    }
}

fn terminate_existing_daemon(data_dir: &Path) -> Result<(), String> {
    let Some(metadata) = read_daemon_metadata(data_dir)? else {
        remove_daemon_metadata(data_dir);
        return Ok(());
    };

    if !pid_is_alive(metadata.pid) {
        remove_daemon_metadata(data_dir);
        return Ok(());
    }

    terminate_pid(metadata.pid)?;
    remove_daemon_metadata(data_dir);
    Ok(())
}

fn terminate_pid(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        signal_pid(pid, libc::SIGTERM, "SIGTERM")?;
        if wait_for_pid_exit(pid, STALE_DAEMON_TERM_TIMEOUT) {
            return Ok(());
        }

        signal_pid(pid, libc::SIGKILL, "SIGKILL")?;
        if wait_for_pid_exit(pid, STALE_DAEMON_KILL_TIMEOUT) {
            return Ok(());
        }

        Err(format!("Daemon pid {pid} did not exit after SIGKILL."))
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        Ok(())
    }
}

#[cfg(unix)]
fn signal_pid(pid: u32, signal: libc::c_int, signal_name: &str) -> Result<(), String> {
    let result = unsafe { libc::kill(pid as libc::pid_t, signal) };
    if result == 0 {
        return Ok(());
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }

    Err(format!(
        "Failed to send {signal_name} to daemon pid {pid}: {error}"
    ))
}

fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    let started_at = Instant::now();

    while started_at.elapsed() < timeout {
        if !pid_is_alive(pid) {
            return true;
        }

        thread::sleep(DAEMON_POLL_INTERVAL);
    }

    !pid_is_alive(pid)
}

fn remove_daemon_metadata(data_dir: &Path) {
    let path = daemon_metadata_path(data_dir);
    if let Err(error) = fs::remove_file(&path) {
        if error.kind() != ErrorKind::NotFound {
            eprintln!(
                "Failed to remove stale daemon metadata {}: {error}",
                path.display()
            );
        }
    }
}

fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // Signal 0 probes for existence without delivering anything; EPERM
        // still means the process exists.
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn get_daemon_health(port: u16, token: &str) -> Result<Option<HealthPayload>, String> {
    let Ok((status, body)) = http_request(port, "GET", "/api/health", Some(token)) else {
        return Ok(None);
    };

    if status != 200 {
        return Ok(None);
    }

    serde_json::from_str(&body)
        .map(Some)
        .map_err(|error| format!("Invalid daemon health response: {error}"))
}

fn post_shutdown(daemon: &RunningDaemon) -> Result<(), String> {
    let (status, body) = http_request(daemon.port, "POST", "/api/shutdown", Some(&daemon.token))?;
    if (200..300).contains(&status) {
        return Ok(());
    }

    let message = body.trim();
    if message.is_empty() {
        Err(format!("Daemon shutdown failed with HTTP {status}."))
    } else {
        Err(format!(
            "Daemon shutdown failed with HTTP {status}: {message}"
        ))
    }
}

fn http_request(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
) -> Result<(u16, String), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HTTP_TIMEOUT).map_err(stringify_error)?;
    stream
        .set_read_timeout(Some(HTTP_TIMEOUT))
        .map_err(stringify_error)?;
    stream
        .set_write_timeout(Some(HTTP_TIMEOUT))
        .map_err(stringify_error)?;

    let auth = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(stringify_error)?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(stringify_error)?;

    parse_http_response(&response)
}

fn parse_http_response(response: &str) -> Result<(u16, String), String> {
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Invalid HTTP response from daemon.".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "Invalid HTTP status from daemon.".to_string())?;

    let chunked = head.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value.trim().eq_ignore_ascii_case("chunked")
        })
    });
    let body = if chunked {
        decode_chunked_body(body.as_bytes())?
    } else {
        body.to_string()
    };

    Ok((status, body))
}

// Bun's HTTP server responds with Transfer-Encoding: chunked, so the body
// arrives as hex-size-prefixed chunks rather than a plain payload.
fn decode_chunked_body(mut rest: &[u8]) -> Result<String, String> {
    let malformed = || "Malformed chunked HTTP body from daemon.".to_string();
    let mut decoded: Vec<u8> = Vec::new();

    loop {
        let line_end = rest
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(malformed)?;
        let size_line = std::str::from_utf8(&rest[..line_end]).map_err(|_| malformed())?;
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16).map_err(|_| malformed())?;
        rest = &rest[line_end + 2..];

        if size == 0 {
            break;
        }
        if rest.len() < size + 2 || &rest[size..size + 2] != b"\r\n" {
            return Err(malformed());
        }
        decoded.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }

    String::from_utf8(decoded).map_err(|_| malformed())
}

fn stop_daemon(state: &DesktopState) -> Result<(), String> {
    let Some(daemon) = state.take_daemon()? else {
        return Ok(());
    };

    state.cancel_sse();
    if let Err(error) = post_shutdown(&daemon) {
        eprintln!(
            "Failed to stop Overlearn daemon {} for {}: {error}",
            daemon.pid,
            daemon.data_dir.display()
        );
    }
    Ok(())
}

fn start_sse_subscription(app: AppHandle, state: &DesktopState, daemon: RunningDaemon) {
    let generation = state.next_sse_generation();

    thread::spawn(move || {
        let result = read_sse_stream(&app, generation, &daemon);
        let state = app.state::<DesktopState>();

        if state.sse_generation() != generation || state.quitting.load(Ordering::SeqCst) {
            return;
        }

        if let Err(error) = result {
            eprintln!("Overlearn SSE subscription ended: {error}");
            notify_if_unfocused(
                &app,
                "Overlearn needs attention",
                "The daemon stopped responding.",
            );
        }
    });
}

fn read_sse_stream(app: &AppHandle, generation: u64, daemon: &RunningDaemon) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], daemon.port));
    let mut stream = TcpStream::connect_timeout(&address, HTTP_TIMEOUT).map_err(stringify_error)?;
    let request = format!(
        "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n",
        daemon.port, daemon.token
    );
    stream
        .write_all(request.as_bytes())
        .map_err(stringify_error)?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).map_err(stringify_error)?;
        if bytes == 0 {
            return Err("SSE stream closed.".to_string());
        }

        if line == "\r\n" || line == "\n" {
            break;
        }
    }

    let mut event_name = String::new();
    let mut data = String::new();

    loop {
        let state = app.state::<DesktopState>();
        if state.sse_generation() != generation {
            return Ok(());
        }

        line.clear();
        let bytes = reader.read_line(&mut line).map_err(stringify_error)?;
        if bytes == 0 {
            return Err("SSE stream closed.".to_string());
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if event_name == "status" && !data.is_empty() {
                handle_status_event(app, &data)?;
            }
            event_name.clear();
            data.clear();
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("event: ") {
            event_name = value.to_string();
        } else if let Some(value) = trimmed.strip_prefix("data: ") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value);
        }
    }
}

fn handle_status_event(app: &AppHandle, data: &str) -> Result<(), String> {
    let payload: StatusPayload =
        serde_json::from_str(data).map_err(|error| format!("Invalid status event: {error}"))?;
    let state = app.state::<DesktopState>();
    let previous = state.replace_status(payload.status.clone())?;
    if previous.as_deref() == Some(payload.status.as_str()) {
        return Ok(());
    }

    match payload.status.as_str() {
        "waiting-for-agent" => notify_if_unfocused(
            app,
            "Overlearn turn ready",
            "The course is waiting for your response.",
        ),
        "session-ended" => notify_if_unfocused(
            app,
            "Overlearn needs attention",
            "The course session has ended.",
        ),
        _ => {}
    }

    Ok(())
}

fn notify_if_unfocused(app: &AppHandle, title: &str, body: &str) {
    let state = app.state::<DesktopState>();
    if state.window_focused.load(Ordering::SeqCst) {
        return;
    }

    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        eprintln!("Failed to show Overlearn notification: {error}");
    }
}

fn setup_window_focus(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("Main window was not created.".to_string());
    };

    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            let state = app_handle.state::<DesktopState>();
            state.window_focused.store(*focused, Ordering::SeqCst);
        }
    });

    Ok(())
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let show =
        MenuItem::with_id(app, "show", "Show", true, None::<&str>).map_err(stringify_error)?;
    let hide =
        MenuItem::with_id(app, "hide", "Hide", true, None::<&str>).map_err(stringify_error)?;
    let quit =
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(stringify_error)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit]).map_err(stringify_error)?;
    let icon = make_tray_icon();

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    window.show().ok();
                    window.set_focus().ok();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide().ok();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(stringify_error)?;

    Ok(())
}

fn make_tray_icon() -> Image<'static> {
    let size = 32_u32;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);

    for y in 0..size {
        for x in 0..size {
            let border = x < 3 || y < 3 || x >= size - 3 || y >= size - 3;
            let diagonal = x.abs_diff(y) <= 2 || x + y >= size - 3 && x + y <= size + 1;
            let (r, g, b, a) = if border {
                (20, 28, 36, 255)
            } else if diagonal {
                (0, 142, 110, 255)
            } else {
                (245, 248, 250, 255)
            };
            rgba.extend_from_slice(&[r, g, b, a]);
        }
    }

    Image::new_owned(rgba, size, size)
}

fn show_startup_failure(app: &AppHandle, message: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    app.dialog()
        .message(format!(
            "Overlearn could not start its background service.\n\n{message}\n\n\
             For detailed logs, run the app binary from a terminal:\n\
             /Applications/Overlearn.app/Contents/MacOS/overlearn-desktop"
        ))
        .title("Overlearn failed to start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    setup_window_focus(app.handle()).map_err(to_boxed_error)?;
    build_tray(app.handle()).map_err(to_boxed_error)?;

    let state = app.state::<DesktopState>();
    let daemon = match start_app_daemon(app.handle()) {
        Ok(daemon) => daemon,
        Err(message) => {
            eprintln!("Overlearn daemon failed to start: {message}");
            show_startup_failure(app.handle(), &message);
            std::process::exit(1);
        }
    };
    state
        .set_daemon(Some(daemon.clone()))
        .map_err(to_boxed_error)?;
    start_sse_subscription(app.handle().clone(), state.inner(), daemon);

    Ok(())
}

fn handle_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { .. } = event {
        let state = app.state::<DesktopState>();
        state.quitting.store(true, Ordering::SeqCst);
        if let Err(error) = stop_daemon(state.inner()) {
            eprintln!("Failed to stop Overlearn daemon: {error}");
        }
    }
}

fn stringify_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn to_boxed_error(message: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(message))
}

fn main() {
    // Finder-launched apps inherit launchd's minimal PATH; import the login
    // shell's environment so the sidecar can find harness binaries.
    if let Err(error) = fix_path_env::fix() {
        eprintln!("Failed to import login shell environment: {error}");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                window.show().ok();
                window.set_focus().ok();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![daemon_info])
        .setup(setup_app)
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(handle_run_event);
}

#[cfg(test)]
mod tests {
    use super::{parse_http_response, wait_for_daemon_info, DesktopState, RunningDaemon};
    use std::{
        path::PathBuf,
        sync::Arc,
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn daemon_info_waits_until_daemon_is_registered() {
        let state = Arc::new(DesktopState::default());
        let setter_state = Arc::clone(&state);

        thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            setter_state
                .set_daemon(Some(RunningDaemon {
                    pid: 42,
                    port: 4242,
                    token: "ready-token".to_string(),
                    data_dir: PathBuf::from("/tmp/overlearn-test"),
                }))
                .unwrap();
        });

        let info = tauri::async_runtime::block_on(wait_for_daemon_info(
            &state,
            Duration::from_millis(500),
            Duration::from_millis(5),
        ))
        .unwrap();

        assert_eq!(info.port, 4242);
        assert_eq!(info.token, "ready-token");
    }

    #[test]
    fn daemon_info_returns_poisoned_lock_without_waiting() {
        let state = DesktopState::default();
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.daemon.lock().unwrap();
            panic!("poison daemon lock");
        }));
        std::panic::set_hook(previous_hook);
        assert!(poisoned.is_err());

        let started_at = Instant::now();
        let error = tauri::async_runtime::block_on(wait_for_daemon_info(
            &state,
            Duration::from_secs(30),
            Duration::from_secs(30),
        ))
        .unwrap_err();

        assert_eq!(error, "Desktop state lock was poisoned.");
        assert!(started_at.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn parses_content_length_response() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        assert_eq!(
            parse_http_response(raw).unwrap(),
            (200, "{\"ok\":true}".to_string())
        );
    }

    #[test]
    fn parses_chunked_response() {
        // The exact wire shape Bun's server sends for /api/health.
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n{\"ok\":true}\r\n0\r\n\r\n";
        assert_eq!(
            parse_http_response(raw).unwrap(),
            (200, "{\"ok\":true}".to_string())
        );
    }

    #[test]
    fn parses_multi_chunk_response() {
        let raw =
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n{\"ok\":\r\n5\r\ntrue}\r\n0\r\n\r\n";
        assert_eq!(
            parse_http_response(raw).unwrap(),
            (200, "{\"ok\":true}".to_string())
        );
    }

    #[test]
    fn rejects_truncated_chunked_response() {
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\n{\"ok\":";
        assert!(parse_http_response(raw).is_err());
    }
}
