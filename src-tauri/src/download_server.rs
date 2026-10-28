use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static PENDING_DOWNLOADS_BY_WINDOW: OnceLock<Mutex<HashMap<String, Vec<InterceptedDownloadPayload>>>> = OnceLock::new();
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);
static INITIAL_DOWNLOAD_CLAIMED: AtomicBool = AtomicBool::new(false);
static FILE_PREVIEW_COUNTER: AtomicU64 = AtomicU64::new(1);
static DOWNLOAD_SERVER_PORT: AtomicU16 = AtomicU16::new(0);
static FILE_PREVIEWS: OnceLock<Mutex<HashMap<String, (PathBuf, std::time::Instant)>>> = OnceLock::new();

pub fn register_file_preview(path: &Path) -> Result<String, String> {
    let canonical_path = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_path.is_file() {
        return Err("Preview file does not exist".to_string());
    }

    let mut random = [0u8; 24];
    let token = if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut random))
        .is_ok()
    {
        random.iter().map(|b| format!("{b:02x}")).collect::<String>()
    } else {
        format!(
            "{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
            FILE_PREVIEW_COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    };
    let previews = FILE_PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut previews = previews.lock().map_err(|_| "Preview registry unavailable".to_string())?;
    previews.retain(|_, (_, created)| created.elapsed() < Duration::from_secs(2 * 60 * 60));
    previews.insert(token.clone(), (canonical_path, std::time::Instant::now()));
    let port = DOWNLOAD_SERVER_PORT.load(Ordering::Acquire);
    if port == 0 {
        return Err("Local preview server is not ready".to_string());
    }
    Ok(format!("http://127.0.0.1:{port}/preview/file?token={token}"))
}

pub fn add_pending_download_for_window(window_label: &str, payload: InterceptedDownloadPayload) {
    if let Ok(mut map) = PENDING_DOWNLOADS_BY_WINDOW.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        let list = map.entry(window_label.to_string()).or_default();
        if !list.iter().any(|item| item.id == payload.id) {
            list.push(payload);
        }
    }
}

pub fn take_pending_downloads_for_window(window_label: &str) -> Vec<InterceptedDownloadPayload> {
    if let Ok(mut map) = PENDING_DOWNLOADS_BY_WINDOW.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        if let Some(list) = map.get_mut(window_label) {
            return list.drain(..).collect();
        }
    }
    Vec::new()
}

pub fn has_pending_downloads_for_window(window_label: &str) -> bool {
    if let Ok(map) = PENDING_DOWNLOADS_BY_WINDOW.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        if let Some(list) = map.get(window_label) {
            return !list.is_empty();
        }
    }
    false
}

pub fn activate_window_cross_desktop(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();

    #[cfg(target_os = "linux")]
    {
        let xdg_desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();
        let is_hyprland = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() || xdg_desktop.contains("hyprland");
        let is_sway = std::env::var("SWAYSOCK").is_ok();
        let is_i3 = std::env::var("I3SOCK").is_ok();

        if is_hyprland {
            let _ = std::process::Command::new("hyprctl")
                .args(["dispatch", "focuswindow", "class:^(vfinder|vFinder|finder)$"])
                .output();
            let _ = std::process::Command::new("hyprctl")
                .args(["dispatch", "alterzorder", "top,class:^(vfinder|vFinder|finder)$"])
                .output();
        } else if is_sway {
            let _ = std::process::Command::new("swaymsg")
                .args(["[app_id=\"(?i)(vfinder|finder)\"] focus"])
                .output();
        } else if is_i3 {
            let _ = std::process::Command::new("i3-msg")
                .args(["[class=\"(?i)(vfinder|finder)\"] focus"])
                .output();
        } else {
            // Generic X11 / Xwayland focus helpers (GNOME X11, KDE X11, XFCE, Cinnamon, MATE, LXQt, etc.)
            let has_wmctrl = std::process::Command::new("which")
                .arg("wmctrl")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if has_wmctrl {
                let _ = std::process::Command::new("wmctrl")
                    .args(["-x", "-a", "vfinder"])
                    .output();
            } else {
                let has_xdotool = std::process::Command::new("which")
                    .arg("xdotool")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if has_xdotool {
                    let _ = std::process::Command::new("xdotool")
                        .args(["search", "--class", "vfinder", "windowactivate"])
                        .output();
                }
            }
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InterceptedDownloadPayload {
    pub id: String,
    pub url: String,
    pub original_url: Option<String>,
    pub filename: String,
    pub total_bytes: i64,
    pub mime: Option<String>,
    pub referrer: Option<String>,
    pub user_agent: Option<String>,
    pub cookies: Option<String>,
    pub blob_data: Option<String>,
}

use std::path::{Path, PathBuf};

pub fn register_native_messaging_host() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };

    let current_exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = current_exe.parent().unwrap_or(Path::new("/"));

    let candidates = [
        exe_dir.join("native-messaging-host.py"),
        exe_dir.join("../../native-messaging-host.py"),
        exe_dir.join("../../../native-messaging-host.py"),
        home.join(".local/share/vfinder/native-messaging-host.py"),
        home.join(".local/share/macos-finder/native-messaging-host.py"),
        PathBuf::from("/usr/lib/vfinder/native-messaging-host.py"),
        PathBuf::from("/usr/share/vfinder/native-messaging-host.py"),
        PathBuf::from("/usr/lib/macos-finder/native-messaging-host.py"),
        PathBuf::from("/usr/share/macos-finder/native-messaging-host.py"),
    ];

    let host_path = match candidates.into_iter().find(|p| p.is_file()) {
        Some(p) => match p.canonicalize() {
            Ok(cp) => cp,
            Err(_) => p,
        },
        None => return,
    };

    let manifest_content = format!(
        r#"{{
  "name": "com.macosfinder.downloader",
  "description": "macOS Finder Native Messaging Host for Downloads",
  "path": "{}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://einmkmankeaejiohfdpjjlgllaldefme/"
  ]
}}
"#,
        host_path.to_string_lossy()
    );

    let browser_dirs = [
        home.join(".config/google-chrome"),
        home.join(".config/google-chrome-beta"),
        home.join(".config/google-chrome-unstable"),
        home.join(".config/chromium"),
        home.join(".config/BraveSoftware/Brave-Browser"),
        home.join(".config/microsoft-edge"),
        home.join(".config/microsoft-edge-dev"),
        home.join(".config/vivaldi"),
        home.join(".config/opera"),
    ];

    for b_dir in browser_dirs {
        if b_dir.exists() {
            let nm_dir = b_dir.join("NativeMessagingHosts");
            let _ = std::fs::create_dir_all(&nm_dir);
            let target_json = nm_dir.join("com.macosfinder.downloader.json");
            let _ = std::fs::write(target_json, &manifest_content);
        }
    }
}

pub fn start_download_server(app_handle: AppHandle) {
    register_native_messaging_host();
    let listener = match TcpListener::bind("127.0.0.1:45456") {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            match TcpListener::bind("127.0.0.1:0") {
                Ok(listener) => {
                    eprintln!(
                        "[download_server] Port 45456 is occupied; using {} for this instance",
                        listener.local_addr().map(|addr| addr.to_string()).unwrap_or_default()
                    );
                    listener
                }
                Err(fallback_error) => {
                    eprintln!("[download_server] Could not bind a local port: {fallback_error}");
                    return;
                }
            }
        }
        Err(error) => {
            eprintln!("[download_server] Could not bind 127.0.0.1:45456: {error}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(error) => {
            eprintln!("[download_server] Could not read local server address: {error}");
            return;
        }
    };
    DOWNLOAD_SERVER_PORT.store(port, Ordering::Release);
    let addr = format!("127.0.0.1:{port}");
    println!("[download_server] Listening on http://{addr}");

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let app = app_handle.clone();
                    std::thread::spawn(move || {
                        handle_client(&mut stream, &app);
                    });
                }
                Err(e) => {
                    eprintln!("[download_server] Incoming connection error: {:?}", e);
                }
            }
        }
    });
}

fn handle_client(stream: &mut TcpStream, app: &AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(6)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(6)));

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.is_empty() {
        return;
    }

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }

    let method = parts[0];
    let path = parts[1];

    let mut content_length: usize = 0;
    let mut range_header: Option<String> = None;
    loop {
        let mut header_line = String::new();
        if reader.read_line(&mut header_line).is_err() || header_line == "\r\n" || header_line == "\n" {
            break;
        }
        let lower = header_line.to_lowercase();
        if lower.starts_with("content-length:") {
            if let Some(val_str) = lower.strip_prefix("content-length:") {
                content_length = val_str.trim().parse::<usize>().unwrap_or(0);
            }
        }
        if lower.starts_with("range:") {
            range_header = Some(header_line[6..].trim().to_string());
        }
    }

    if (method == "GET" || method == "HEAD") && path.starts_with("/preview/file?") {
        serve_file_preview(stream, path, method == "HEAD", range_header.as_deref());
        return;
    }

    // CORS preflight OPTIONS request
    if method == "OPTIONS" {
        let response = "HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Authorization, x-requested-with\r\n\
Access-Control-Max-Age: 86400\r\n\
Connection: close\r\n\
\r\n";
        let _ = stream.write_all(response.as_bytes());
        return;
    }

    // Healthcheck / ping route
    if method == "GET" && path == "/ping" {
        let body = r#"{"status":"ok","app":"vfinder","version":"1.0.0"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\n\
Content-Type: application/json\r\n\
Access-Control-Allow-Origin: *\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
\r\n\
{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        return;
    }

    // Download intercept routes
    if method == "POST" && (path == "/download/intercept" || path == "/download/blob") {
        if content_length > 0 && content_length < 50_000_000 {
            // Read JSON body (up to 50MB for potential blob base64 payload)
            let mut body_bytes = vec![0u8; content_length];
            if reader.read_exact(&mut body_bytes).is_ok() {
                if let Ok(payload) = serde_json::from_slice::<InterceptedDownloadPayload>(&body_bytes) {
                    // Send 200 OK response to browser immediately
                    let resp_body = r#"{"status":"intercepted"}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\n\
Content-Type: application/json\r\n\
Access-Control-Allow-Origin: *\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
\r\n\
{}",
                        resp_body.len(),
                        resp_body
                    );
                    let _ = stream.write_all(response.as_bytes());

                    // Determine if an instance is already open:
                    // If vFinder was already open and shown, or if another download is already open,
                    // we MUST open a new window for this download!
                    let is_spawned_by_download = std::env::var("MACOS_FINDER_SPAWNED_BY_DOWNLOAD").is_ok()
                        || std::env::var("VFINDER_SPAWNED_BY_DOWNLOAD").is_ok();
                    let main_win_opt = app.get_webview_window("main");
                    let main_already_open = main_win_opt
                        .as_ref()
                        .map(|w| w.is_visible().unwrap_or(false))
                        .unwrap_or(false)
                        || crate::commands::is_main_window_shown()
                        || has_pending_downloads_for_window("main")
                        || app.webview_windows().len() > 1;

                    let should_open_new_window = !is_spawned_by_download
                        || INITIAL_DOWNLOAD_CLAIMED.swap(true, Ordering::SeqCst)
                        || main_already_open
                        || main_win_opt.is_none();

                    if should_open_new_window {
                        let count = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0);
                        let win_label = format!("downloader-{}-{}", count, now_ms);

                        add_pending_download_for_window(&win_label, payload.clone());

                        let win_builder = tauri::WebviewWindowBuilder::new(
                            app,
                            &win_label,
                            tauri::WebviewUrl::default(),
                        )
                        .title("vFinder")
                        .inner_size(1160.0, 740.0)
                        .min_inner_size(760.0, 480.0)
                        .decorations(false)
                        .resizable(true)
                        .transparent(false)
                        .center();

                        match win_builder.build() {
                            Ok(win) => {
                                let _ = win.set_background_color(Some(tauri::window::Color(30, 30, 34, 255)));
                                #[cfg(target_os = "linux")]
                                crate::setup_linux_webview(&win);

                                activate_window_cross_desktop(&win);

                                let win_clone = win.clone();
                                let payload_clone = payload.clone();
                                std::thread::spawn(move || {
                                    for _ in 0..6 {
                                        std::thread::sleep(std::time::Duration::from_millis(150));
                                        let _ = win_clone.emit("external-download-intercepted", &payload_clone);
                                    }
                                });
                            }
                            Err(e) => {
                                eprintln!("[download_server] Failed to build downloader window: {}", e);
                                if let Some(main_win) = app.get_webview_window("main") {
                                    add_pending_download_for_window("main", payload.clone());
                                    activate_window_cross_desktop(&main_win);
                                    let _ = main_win.emit("external-download-intercepted", payload);
                                }
                            }
                        }
                    } else if let Some(main_win) = main_win_opt {
                        add_pending_download_for_window("main", payload.clone());
                        activate_window_cross_desktop(&main_win);
                        let _ = main_win.emit("external-download-intercepted", payload);
                    }
                    return;
                }
            }
        }

        let resp_body = r#"{"error":"invalid_payload"}"#;
        let response = format!(
            "HTTP/1.1 400 Bad Request\r\n\
Content-Type: application/json\r\n\
Access-Control-Allow-Origin: *\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
\r\n\
{}",
            resp_body.len(),
            resp_body
        );
        let _ = stream.write_all(response.as_bytes());
        return;
    }

    // Fallback 404
    let resp_body = r#"{"error":"not_found"}"#;
    let response = format!(
        "HTTP/1.1 404 Not Found\r\n\
Content-Type: application/json\r\n\
Access-Control-Allow-Origin: *\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
\r\n\
{}",
        resp_body.len(),
        resp_body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn serve_file_preview(stream: &mut TcpStream, request_path: &str, head_only: bool, range: Option<&str>) {
    let token = request_path
        .split_once("token=")
        .map(|(_, value)| value.split('&').next().unwrap_or_default())
        .unwrap_or_default();
    let path = FILE_PREVIEWS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|mut previews| {
            previews.retain(|_, (_, created)| created.elapsed() < Duration::from_secs(2 * 60 * 60));
            previews.get(token).map(|(path, _)| path.clone())
        });
    let Some(path) = path else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let Ok(file_len) = file.metadata().map(|metadata| metadata.len()) else { return };
    let (start, end, partial) = if let Some(value) = range.and_then(|value| value.strip_prefix("bytes=")) {
        if let Some((start, end)) = value.split_once('-') {
            let start = start.parse::<u64>().unwrap_or(u64::MAX);
            let end = if end.is_empty() { file_len.saturating_sub(1) } else { end.parse::<u64>().unwrap_or(u64::MAX) };
            if start < file_len && end >= start {
                (start, end.min(file_len.saturating_sub(1)), true)
            } else {
                let response = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{file_len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                let _ = stream.write_all(response.as_bytes());
                return;
            }
        } else { (0, file_len.saturating_sub(1), false) }
    } else { (0, file_len.saturating_sub(1), false) };
    let length = if file_len == 0 { 0 } else { end.saturating_sub(start).saturating_add(1) };
    if file.seek(SeekFrom::Start(start)).is_err() { return; }
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let status = if partial { "206 Partial Content" } else { "200 OK" };
    let mut headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\nContent-Length: {length}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n"
    );
    if partial { headers.push_str(&format!("Content-Range: bytes {start}-{end}/{file_len}\r\n")); }
    headers.push_str("\r\n");
    if stream.write_all(headers.as_bytes()).is_err() || head_only { return; }
    let mut limited = file.take(length);
    let _ = std::io::copy(&mut limited, stream);
}
