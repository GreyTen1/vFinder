use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static PENDING_DOWNLOADS_BY_WINDOW: OnceLock<Mutex<HashMap<String, Vec<InterceptedDownloadPayload>>>> = OnceLock::new();
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);
static INITIAL_DOWNLOAD_CLAIMED: AtomicBool = AtomicBool::new(false);

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

#[allow(dead_code)]
pub fn add_pending_download(payload: InterceptedDownloadPayload) {
    add_pending_download_for_window("main", payload);
}

#[allow(dead_code)]
pub fn take_pending_downloads() -> Vec<InterceptedDownloadPayload> {
    take_pending_downloads_for_window("main")
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
                .args(["dispatch", "focuswindow", "class:^(finder)$"])
                .output();
            let _ = std::process::Command::new("hyprctl")
                .args(["dispatch", "alterzorder", "top,class:^(finder)$"])
                .output();
        } else if is_sway {
            let _ = std::process::Command::new("swaymsg")
                .args(["[app_id=\"(?i)finder\"] focus"])
                .output();
        } else if is_i3 {
            let _ = std::process::Command::new("i3-msg")
                .args(["[class=\"(?i)finder\"] focus"])
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
                    .args(["-x", "-a", "finder"])
                    .output();
            } else {
                let has_xdotool = std::process::Command::new("which")
                    .arg("xdotool")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if has_xdotool {
                    let _ = std::process::Command::new("xdotool")
                        .args(["search", "--class", "finder", "windowactivate"])
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
    std::thread::spawn(move || {
        let port = 45456;
        let addr = format!("127.0.0.1:{}", port);
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => {
                println!("[download_server] Listening on http://{}", addr);
                l
            }
            Err(e) => {
                eprintln!("[download_server] Failed to bind {}: {}", addr, e);
                return;
            }
        };

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
