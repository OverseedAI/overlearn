use serde::Deserialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime},
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
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Desktop state lock was poisoned.".to_string())
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

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("Invalid daemon metadata in {}: {error}", path.display()))
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

    if let Some(daemon) = read_live_daemon(&data_dir)? {
        return Ok(daemon);
    }

    let (mut rx, child) = app
        .shell()
        .sidecar("learn")
        .map_err(stringify_error)?
        .arg("daemon")
        .env("OVERLEARN_DATA_DIR", data_dir.display().to_string())
        .spawn()
        .map_err(stringify_error)?;
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

fn pid_is_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        Path::new("/proc").join(pid.to_string()).exists()
    }

    #[cfg(not(target_os = "linux"))]
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

    Ok((status, body.to_string()))
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

fn navigate_to_daemon(app: &AppHandle, daemon: &RunningDaemon) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("Main window was not created.".to_string());
    };
    let url = tauri::Url::parse(&format!(
        "http://127.0.0.1:{}/?token={}",
        daemon.port, daemon.token
    ))
    .map_err(stringify_error)?;

    window.navigate(url).map_err(stringify_error)?;
    window.set_focus().ok();
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
    navigate_to_daemon(app.handle(), &daemon).map_err(to_boxed_error)?;
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
        .setup(setup_app)
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(handle_run_event);
}
