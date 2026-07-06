use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::ShellExt;

const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(5);
const DAEMON_POLL_INTERVAL: Duration = Duration::from_millis(100);
const HTTP_TIMEOUT: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    courses: Vec<CourseEntry>,
    last_course_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CourseEntry {
    course_dir: String,
    title: String,
    working_dir: Option<String>,
    last_opened_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherState {
    config: AppConfig,
    config_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenCourseResult {
    url: String,
    port: u16,
    started_by_app: bool,
}

#[derive(Debug, Clone)]
struct RunningDaemon {
    course_dir: String,
    port: u16,
}

#[derive(Debug, Deserialize)]
struct DaemonMetadata {
    pid: u32,
    port: u16,
    #[serde(rename = "startedAt")]
    _started_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthPayload {
    course_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusPayload {
    status: String,
    _has_seen_wait: bool,
}

#[derive(Default)]
struct DesktopState {
    config: Mutex<AppConfig>,
    window_focused: AtomicBool,
    sse_generation: AtomicU64,
    current_status: Mutex<Option<String>>,
    owned_daemon: Mutex<Option<RunningDaemon>>,
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

    fn take_owned_daemon(&self) -> Result<Option<RunningDaemon>, String> {
        Ok(lock_mutex(&self.owned_daemon)?.take())
    }

    fn set_owned_daemon(&self, daemon: Option<RunningDaemon>) -> Result<(), String> {
        *lock_mutex(&self.owned_daemon)? = daemon;
        Ok(())
    }
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Desktop state lock was poisoned.".to_string())
}

fn app_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir().map_err(stringify_error)?;
    Ok(config_dir.join("app.json"))
}

fn read_config_file(path: &Path) -> Result<AppConfig, String> {
    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid desktop config in {}: {error}", path.display()))
}

fn save_config_file(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = app_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let contents = serde_json::to_string_pretty(config).map_err(stringify_error)?;
    fs::write(&path, format!("{contents}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn load_config_into_state(app: &AppHandle) -> Result<(), String> {
    let config = read_config_file(&app_config_path(app)?)?;
    let state = app.state::<DesktopState>();
    *lock_mutex(&state.config)? = config;
    Ok(())
}

fn launcher_state(app: &AppHandle, state: &DesktopState) -> Result<LauncherState, String> {
    Ok(LauncherState {
        config: lock_mutex(&state.config)?.clone(),
        config_path: app_config_path(app)?.display().to_string(),
    })
}

fn now_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    seconds.to_string()
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Failed to resolve {}: {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a directory.", canonical.display()));
    }

    Ok(canonical)
}

fn read_course_title(course_dir: &Path) -> Result<String, String> {
    let manifest_path = course_dir.join("course.json");
    let contents = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?;
    let manifest: Value = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "Invalid course manifest {}: {error}",
            manifest_path.display()
        )
    })?;

    for key in ["title", "name"] {
        if let Some(title) = manifest.get(key).and_then(Value::as_str) {
            let trimmed = title.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }

    Ok(course_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled course")
        .to_string())
}

fn validate_course_dir(path: &Path) -> Result<CourseEntry, String> {
    let course_dir = canonical_dir(path)?;
    let manifest_path = course_dir.join("course.json");
    if !manifest_path.is_file() {
        return Err(format!(
            "{} is not an Overlearn course directory.",
            course_dir.display()
        ));
    }

    Ok(CourseEntry {
        course_dir: course_dir.display().to_string(),
        title: read_course_title(&course_dir)?,
        working_dir: None,
        last_opened_at: None,
    })
}

fn upsert_course(config: &mut AppConfig, mut next: CourseEntry) {
    if let Some(existing) = config
        .courses
        .iter()
        .find(|course| course.course_dir == next.course_dir)
    {
        next.working_dir = existing.working_dir.clone();
        next.last_opened_at = existing.last_opened_at.clone();
    }

    config
        .courses
        .retain(|course| course.course_dir != next.course_dir);
    config.courses.insert(0, next);
}

fn update_course(
    app: &AppHandle,
    state: &DesktopState,
    update: impl FnOnce(&mut AppConfig) -> Result<(), String>,
) -> Result<LauncherState, String> {
    let config = {
        let mut config = lock_mutex(&state.config)?;
        update(&mut config)?;
        config.clone()
    };

    save_config_file(app, &config)?;
    launcher_state(app, state)
}

fn file_path_to_path_buf(path: FilePath) -> Result<PathBuf, String> {
    path.into_path()
        .map_err(|_| "Only local directories are supported.".to_string())
}

#[tauri::command]
fn get_launcher_state(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<LauncherState, String> {
    launcher_state(&app, state.inner())
}

#[tauri::command]
fn pick_course_dir(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<LauncherState>, String> {
    let Some(path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let entry = validate_course_dir(&file_path_to_path_buf(path)?)?;

    update_course(&app, state.inner(), |config| {
        upsert_course(config, entry);
        Ok(())
    })
    .map(Some)
}

#[tauri::command]
fn pick_working_dir(
    app: AppHandle,
    state: State<'_, DesktopState>,
    course_dir: String,
) -> Result<Option<LauncherState>, String> {
    let Some(path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let working_dir = canonical_dir(&file_path_to_path_buf(path)?)?
        .display()
        .to_string();

    update_course(&app, state.inner(), |config| {
        let course = config
            .courses
            .iter_mut()
            .find(|course| course.course_dir == course_dir)
            .ok_or_else(|| "Course is not in the launcher list.".to_string())?;
        course.working_dir = Some(working_dir);
        Ok(())
    })
    .map(Some)
}

#[tauri::command]
fn clear_working_dir(
    app: AppHandle,
    state: State<'_, DesktopState>,
    course_dir: String,
) -> Result<LauncherState, String> {
    update_course(&app, state.inner(), |config| {
        let course = config
            .courses
            .iter_mut()
            .find(|course| course.course_dir == course_dir)
            .ok_or_else(|| "Course is not in the launcher list.".to_string())?;
        course.working_dir = None;
        Ok(())
    })
}

#[tauri::command]
fn remove_course(
    app: AppHandle,
    state: State<'_, DesktopState>,
    course_dir: String,
) -> Result<LauncherState, String> {
    update_course(&app, state.inner(), |config| {
        config
            .courses
            .retain(|course| course.course_dir != course_dir);
        if config.last_course_dir.as_deref() == Some(course_dir.as_str()) {
            config.last_course_dir = None;
        }
        Ok(())
    })
}

#[tauri::command]
async fn open_course(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    course_dir: String,
) -> Result<OpenCourseResult, String> {
    let course_dir = canonical_dir(Path::new(&course_dir))?;
    validate_course_dir(&course_dir)?;
    let course_dir_string = course_dir.display().to_string();

    state.inner().cancel_sse();
    stop_owned_daemon(&app, state.inner())?;

    let was_running = read_live_daemon(&course_dir)?.is_some();
    let (course_name, courses_dir) = course_cli_parts(&course_dir)?;
    let output = app
        .shell()
        .sidecar("learn")
        .map_err(stringify_error)?
        .args(["resume", course_name.as_str()])
        .env("OVERLEARN_COURSES_DIR", courses_dir.display().to_string())
        .env("OVERLEARN_NO_BROWSER", "1")
        .output()
        .await
        .map_err(stringify_error)?;

    if !output.status.success() {
        return Err(format_command_failure(output.stdout, output.stderr));
    }

    let daemon = wait_for_live_daemon(&course_dir)?;
    let started_by_app = !was_running;
    if started_by_app {
        state.inner().set_owned_daemon(Some(daemon.clone()))?;
    } else {
        state.inner().set_owned_daemon(None)?;
    }

    update_course(&app, state.inner(), |config| {
        let entry = validate_course_dir(&course_dir)?;
        upsert_course(config, entry);
        if let Some(course) = config
            .courses
            .iter_mut()
            .find(|course| course.course_dir == course_dir_string)
        {
            course.last_opened_at = Some(now_timestamp());
        }
        config.last_course_dir = Some(course_dir_string.clone());
        Ok(())
    })?;

    start_sse_subscription(app.clone(), state.inner(), daemon.clone());
    let url = format!("http://127.0.0.1:{}/", daemon.port);
    window.set_focus().ok();

    Ok(OpenCourseResult {
        url,
        port: daemon.port,
        started_by_app,
    })
}

fn course_cli_parts(course_dir: &Path) -> Result<(String, PathBuf), String> {
    let name = course_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Course directory must have a valid UTF-8 name.".to_string())?;
    if name.is_empty() || name == "." || name == ".." {
        return Err("Course directory must have a plain directory name.".to_string());
    }

    let parent = course_dir
        .parent()
        .ok_or_else(|| "Course directory must have a parent directory.".to_string())?;

    Ok((name.to_string(), parent.to_path_buf()))
}

fn format_command_failure(stdout: Vec<u8>, stderr: Vec<u8>) -> String {
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&stdout).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    if !stdout.is_empty() {
        return stdout;
    }

    "learn sidecar command failed.".to_string()
}

fn daemon_metadata_path(course_dir: &Path) -> PathBuf {
    course_dir.join(".overlearn").join("daemon.json")
}

fn read_daemon_metadata(course_dir: &Path) -> Result<Option<DaemonMetadata>, String> {
    let path = daemon_metadata_path(course_dir);
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("Invalid daemon metadata in {}: {error}", path.display()))
}

fn read_live_daemon(course_dir: &Path) -> Result<Option<RunningDaemon>, String> {
    let Some(metadata) = read_daemon_metadata(course_dir)? else {
        return Ok(None);
    };

    if !pid_is_alive(metadata.pid) {
        return Ok(None);
    }

    let Some(health) = get_daemon_health(metadata.port)? else {
        return Ok(None);
    };

    if Path::new(&health.course_path) != course_dir {
        return Ok(None);
    }

    Ok(Some(RunningDaemon {
        course_dir: course_dir.display().to_string(),
        port: metadata.port,
    }))
}

fn wait_for_live_daemon(course_dir: &Path) -> Result<RunningDaemon, String> {
    let started_at = SystemTime::now();

    while started_at.elapsed().unwrap_or_default() < DAEMON_START_TIMEOUT {
        if let Some(daemon) = read_live_daemon(course_dir)? {
            return Ok(daemon);
        }

        thread::sleep(DAEMON_POLL_INTERVAL);
    }

    Err("Daemon did not become healthy within 5 seconds.".to_string())
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

fn get_daemon_health(port: u16) -> Result<Option<HealthPayload>, String> {
    let (status, body) = http_request(port, "GET", "/api/health")?;
    if status != 200 {
        return Ok(None);
    }

    serde_json::from_str(&body)
        .map(Some)
        .map_err(|error| format!("Invalid daemon health response: {error}"))
}

fn post_shutdown(port: u16) -> Result<(), String> {
    let (status, body) = http_request(port, "POST", "/api/shutdown")?;
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

fn http_request(port: u16, method: &str, path: &str) -> Result<(u16, String), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HTTP_TIMEOUT).map_err(stringify_error)?;
    stream
        .set_read_timeout(Some(HTTP_TIMEOUT))
        .map_err(stringify_error)?;
    stream
        .set_write_timeout(Some(HTTP_TIMEOUT))
        .map_err(stringify_error)?;

    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
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

fn stop_owned_daemon(app: &AppHandle, state: &DesktopState) -> Result<(), String> {
    let Some(daemon) = state.take_owned_daemon()? else {
        return Ok(());
    };

    state.cancel_sse();
    if let Err(error) = post_shutdown(daemon.port) {
        eprintln!(
            "Failed to stop Overlearn daemon for {}: {error}",
            daemon.course_dir
        );
    }

    let _ = app;
    Ok(())
}

fn start_sse_subscription(app: AppHandle, state: &DesktopState, daemon: RunningDaemon) {
    let generation = state.next_sse_generation();

    thread::spawn(move || {
        let result = read_sse_stream(&app, generation, daemon.port);
        let state = app.state::<DesktopState>();

        if state.sse_generation() != generation || state.quitting.load(Ordering::SeqCst) {
            return;
        }

        if let Err(error) = result {
            eprintln!("Overlearn SSE subscription ended: {error}");
            notify_if_unfocused(
                &app,
                "Overlearn needs attention",
                "The course daemon stopped responding.",
            );
        }
    });
}

fn read_sse_stream(app: &AppHandle, generation: u64, port: u16) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HTTP_TIMEOUT).map_err(stringify_error)?;
    let request = format!(
        "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n"
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

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    load_config_into_state(app.handle()).map_err(to_boxed_error)?;
    setup_window_focus(app.handle()).map_err(to_boxed_error)?;
    build_tray(app.handle()).map_err(to_boxed_error)?;
    Ok(())
}

fn handle_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { .. } = event {
        let state = app.state::<DesktopState>();
        state.quitting.store(true, Ordering::SeqCst);
        if let Err(error) = stop_owned_daemon(app, state.inner()) {
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            get_launcher_state,
            pick_course_dir,
            pick_working_dir,
            clear_working_dir,
            remove_course,
            open_course
        ])
        .setup(setup_app)
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(handle_run_event);
}
