#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
fn init_linux_app_icon() {
    use gtk::gdk_pixbuf::PixbufLoader;
    use gtk::prelude::*;

    gtk::glib::set_prgname(Some("vfinder"));
    gtk::glib::set_application_name("vFinder");

    let loader = PixbufLoader::new();
    let _ = loader.write(include_bytes!("../icons/128x128.png"));
    let _ = loader.close();
    if let Some(pixbuf) = loader.pixbuf() {
        gtk::Window::set_default_icon(&pixbuf);
        gtk::Window::set_default_icon_name("vfinder");
    }
}

mod commands;
mod download_manager;
mod download_server;
mod models;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};
use tauri::window::Color;

static STARTUP_DIRECTORY: OnceLock<Option<String>> = OnceLock::new();
static STARTUP_SELECTION: OnceLock<Option<String>> = OnceLock::new();
static NEEDS_GUI_SUDO_ELEVATION: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
pub fn is_effective_root() -> bool {
    extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() == 0 }
}

#[cfg(not(unix))]
pub fn is_effective_root() -> bool {
    false
}

pub fn needs_gui_sudo_elevation() -> bool {
    NEEDS_GUI_SUDO_ELEVATION.load(Ordering::SeqCst)
}

#[cfg(unix)]
pub fn build_sudo_env_pairs() -> Vec<String> {
    extern "C" {
        fn geteuid() -> u32;
        fn getegid() -> u32;
    }
    let uid = unsafe { geteuid() };
    let gid = unsafe { getegid() };
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let xdg_runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_default();

    let mut pairs = vec![
        "VFINDER_SUDO_SESSION=1".to_string(),
        format!("VFINDER_ORIGINAL_UID={uid}"),
        format!("VFINDER_ORIGINAL_GID={gid}"),
        "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1".to_string(),
        "WEBKIT_DISABLE_DMABUF_RENDERER=1".to_string(),
        "WEBKIT_DISABLE_COMPOSITING_MODE=0".to_string(),
    ];
    if !user.is_empty() {
        pairs.push(format!("VFINDER_ORIGINAL_USER={user}"));
    }
    if !home.is_empty() {
        pairs.push(format!("VFINDER_ORIGINAL_HOME={home}"));
    }
    if !xdg_runtime.is_empty() {
        pairs.push(format!("VFINDER_ORIGINAL_XDG_RUNTIME_DIR={xdg_runtime}"));
    }

    let preserved_keys = [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "GDK_BACKEND",
        "GTK_THEME",
        "XCURSOR_THEME",
        "XCURSOR_SIZE",
        "MOZ_ENABLE_WAYLAND",
        "LANG",
        "LC_ALL",
        "VFINDER_WEBVIEW_DEBUG",
    ];
    for key in preserved_keys {
        if let Ok(val) = std::env::var(key) {
            if !val.is_empty() {
                pairs.push(format!("{key}={val}"));
            }
        }
    }
    pairs
}

#[cfg(unix)]
fn lookup_passwd_home(user_or_uid: &str) -> Option<String> {
    let content = std::fs::read_to_string("/etc/passwd").ok()?;
    for line in content.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() >= 6 && (fields[0] == user_or_uid || fields[2] == user_or_uid) {
            let dir = fields[5].trim();
            if !dir.is_empty() {
                return Some(dir.to_string());
            }
        }
    }
    None
}

#[cfg(unix)]
fn prepare_root_gui_environment() {
    use std::os::unix::fs::PermissionsExt;

    std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    let orig_uid = std::env::var("VFINDER_ORIGINAL_UID")
        .or_else(|_| std::env::var("SUDO_UID"))
        .or_else(|_| std::env::var("PKEXEC_UID"))
        .ok()
        .filter(|s| !s.is_empty() && s != "0");

    let orig_user = std::env::var("VFINDER_ORIGINAL_USER")
        .or_else(|_| std::env::var("SUDO_USER"))
        .ok()
        .filter(|s| !s.is_empty() && s != "root");

    if std::env::var_os("VFINDER_ORIGINAL_HOME").is_none() {
        let resolved_home = orig_user
            .as_deref()
            .and_then(lookup_passwd_home)
            .or_else(|| orig_uid.as_deref().and_then(lookup_passwd_home));
        if let Some(home) = resolved_home {
            std::env::set_var("VFINDER_ORIGINAL_HOME", &home);
        }
    }

    let orig_runtime_dir = std::env::var("VFINDER_ORIGINAL_XDG_RUNTIME_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("XDG_RUNTIME_DIR")
                .ok()
                .filter(|s| !s.is_empty() && s != "/tmp/vfinder-runtime-root")
        })
        .or_else(|| orig_uid.as_ref().map(|uid| format!("/run/user/{uid}")));

    if let Some(ref user_rt) = orig_runtime_dir {
        let user_rt_path = std::path::Path::new(user_rt);
        if user_rt_path.is_dir() {
            if std::env::var_os("WAYLAND_DISPLAY").is_none() {
                if let Ok(entries) = std::fs::read_dir(user_rt_path) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.starts_with("wayland-") && !name.ends_with(".lock") {
                            std::env::set_var("WAYLAND_DISPLAY", &name);
                            break;
                        }
                    }
                }
            }

            let root_rt = std::path::PathBuf::from("/tmp/vfinder-runtime-root");
            let _ = std::fs::create_dir_all(&root_rt);
            let _ = std::fs::set_permissions(&root_rt, std::fs::Permissions::from_mode(0o700));

            if let Ok(entries) = std::fs::read_dir(user_rt_path) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with("wayland-")
                        || name_str.starts_with("pipewire-")
                        || name_str == "pulse"
                        || name_str == "bus"
                    {
                        let dst = root_rt.join(&name);
                        let _ = std::fs::remove_file(&dst);
                        let _ = std::os::unix::fs::symlink(entry.path(), &dst);
                    }
                }
            }
            std::env::set_var("XDG_RUNTIME_DIR", &root_rt);
        }
    }

    // Keep WebKitGTK / GTK root cache inside /root so root-owned files never pollute the user's home
    if std::path::Path::new("/root").is_dir() {
        std::env::set_var("XDG_CACHE_HOME", "/root/.cache");
        std::env::set_var("XDG_DATA_HOME", "/root/.local/share");
    }
}

#[cfg(unix)]
fn handle_sudo_flag_and_root_env() {
    extern "C" {
        fn isatty(fd: i32) -> i32;
    }
    let wants_sudo = std::env::args().skip(1).any(|arg| arg == "--sudo");
    if wants_sudo && !is_effective_root() {
        let has_tty = unsafe { isatty(0) != 0 || isatty(1) != 0 || isatty(2) != 0 };
        let sudo_cached = std::process::Command::new("sudo")
            .args(["-n", "true"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if has_tty || sudo_cached {
            if let Ok(exe) = std::env::current_exe() {
                use std::os::unix::process::CommandExt;
                let env_pairs = build_sudo_env_pairs();
                let orig_args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
                eprintln!("[vFinder] Elevating session with root privileges (--sudo)...");
                let err = std::process::Command::new("sudo")
                    .arg("env")
                    .args(&env_pairs)
                    .arg(&exe)
                    .args(&orig_args)
                    .exec();
                eprintln!("[vFinder] Failed to elevate with sudo: {err}");
                std::process::exit(1);
            }
        } else {
            NEEDS_GUI_SUDO_ELEVATION.store(true, Ordering::SeqCst);
        }
    }

    if is_effective_root() {
        prepare_root_gui_environment();
    }
}
#[derive(Default)]
struct FileManagerBridgeState {
    frontend_ready: bool,
    pending_requests: Vec<serde_json::Value>,
}

static FILE_MANAGER_BRIDGE: OnceLock<Mutex<FileManagerBridgeState>> = OnceLock::new();

#[tauri::command]
fn file_manager_frontend_ready() -> Vec<serde_json::Value> {
    let bridge = FILE_MANAGER_BRIDGE.get_or_init(|| Mutex::new(FileManagerBridgeState::default()));
    let Ok(mut state) = bridge.lock() else { return Vec::new() };
    state.frontend_ready = true;
    std::mem::take(&mut state.pending_requests)
}

#[tauri::command]
fn take_file_manager_requests() -> Vec<serde_json::Value> {
    let bridge = FILE_MANAGER_BRIDGE.get_or_init(|| Mutex::new(FileManagerBridgeState::default()));
    let Ok(mut state) = bridge.lock() else { return Vec::new() };
    std::mem::take(&mut state.pending_requests)
}

fn startup_argument_path(argument: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    let value = argument.to_string_lossy();
    #[cfg(target_os = "linux")]
    use gtk::gio::prelude::*;
    #[cfg(target_os = "linux")]
    let path = if value.starts_with("file://") {
        gtk::gio::File::for_uri(&value).path()?
    } else {
        std::path::PathBuf::from(value.as_ref())
    };
    #[cfg(not(target_os = "linux"))]
    let path = std::path::PathBuf::from(value.as_ref());
    path.canonicalize().ok()
}

#[cfg(target_os = "linux")]
fn setup_file_manager_dbus(app: tauri::AppHandle) {
    use gtk::gio;
    use gtk::gio::prelude::*;

    const INTERFACE_XML: &str = r#"
      <node>
        <interface name="org.freedesktop.FileManager1">
          <method name="ShowItems">
            <arg name="URIs" type="as" direction="in"/>
            <arg name="StartupId" type="s" direction="in"/>
          </method>
          <method name="ShowFolders">
            <arg name="URIs" type="as" direction="in"/>
            <arg name="StartupId" type="s" direction="in"/>
          </method>
          <method name="ShowItemProperties">
            <arg name="URIs" type="as" direction="in"/>
            <arg name="StartupId" type="s" direction="in"/>
          </method>
        </interface>
      </node>
    "#;

    let connection = match gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>) {
        Ok(connection) => connection,
        Err(error) => {
            eprintln!("[file-manager-dbus] Could not connect to session bus: {error}");
            return;
        }
    };
    let node = match gio::DBusNodeInfo::for_xml(INTERFACE_XML) {
        Ok(node) => node,
        Err(error) => {
            eprintln!("[file-manager-dbus] Invalid interface description: {error}");
            return;
        }
    };
    let Some(interface) = node.interfaces().first() else {
        eprintln!("[file-manager-dbus] Interface description is empty");
        return;
    };

    let app_for_methods = app.clone();
    if let Err(error) = connection.register_object(
        "/org/freedesktop/FileManager1",
        interface,
        move |_connection, _sender, _object_path, _interface, method, parameters, invocation| {
            let Some((uris, _startup_id)) = parameters.get::<(Vec<String>, String)>() else {
                invocation.return_value(Some(&().to_variant()));
                return;
            };
            let paths = uris
                .iter()
                .filter_map(|uri| gio::File::for_uri(uri).path())
                .filter(|path| path.exists())
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>();

            if !paths.is_empty() {
                let (directory, selected_paths) = match method {
                    "ShowFolders" if std::path::Path::new(&paths[0]).is_file() => {
                        let first = std::path::PathBuf::from(&paths[0]);
                        let parent = first.parent().unwrap_or(first.as_path());
                        (parent.to_string_lossy().into_owned(), vec![paths[0].clone()])
                    }
                    "ShowFolders" => (paths[0].clone(), Vec::new()),
                    "ShowItems" | "ShowItemProperties" => {
                        let first = std::path::PathBuf::from(&paths[0]);
                        let parent = first.parent().unwrap_or(first.as_path());
                        let parent = parent.to_string_lossy().into_owned();
                        let selected = paths
                            .into_iter()
                            .filter(|path| {
                                std::path::Path::new(path).parent()
                                    == Some(std::path::Path::new(&parent))
                            })
                            .collect();
                        (parent, selected)
                    }
                    _ => (String::new(), Vec::new()),
                };

                if !directory.is_empty() {
                    if let Some(window) = app_for_methods.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let request = serde_json::json!({
                        "directory": directory,
                        "selectedPaths": selected_paths,
                        "showProperties": method == "ShowItemProperties",
                    });
                    let bridge = FILE_MANAGER_BRIDGE
                        .get_or_init(|| Mutex::new(FileManagerBridgeState::default()));
                    let should_emit = if let Ok(mut state) = bridge.lock() {
                        state.pending_requests.push(request);
                        state.frontend_ready
                    } else {
                        false
                    };
                    if should_emit {
                        let _ = app_for_methods.emit_to("main", "file-manager-show-items", ());
                    }
                }
            }
            invocation.return_value(Some(&().to_variant()));
        },
        |_connection, _sender, _object_path, _interface, _property| ().to_variant(),
        |_connection, _sender, _object_path, _interface, _property, _value| false,
    ) {
        eprintln!("[file-manager-dbus] Could not register FileManager1: {error}");
        return;
    }

    gio::bus_own_name_on_connection(
        &connection,
        "org.freedesktop.FileManager1",
        gio::BusNameOwnerFlags::NONE,
        |_connection, _name| println!("[file-manager-dbus] FileManager1 service registered"),
        |_connection, _name| eprintln!("[file-manager-dbus] Could not own FileManager1 bus name"),
    );
}

#[tauri::command]
fn get_startup_directory() -> Option<String> {
    STARTUP_DIRECTORY.get().cloned().flatten()
}

#[tauri::command]
fn get_startup_selection() -> Option<String> {
    STARTUP_SELECTION.get().cloned().flatten()
}

static ARMED_DRAG_PATHS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static ACTIVE_OUTBOUND_PATHS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
pub static OUTBOUND_DRAG_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

pub fn set_armed_drag_paths(paths: Vec<String>) {
    if let Ok(mut guard) = ARMED_DRAG_PATHS.get_or_init(|| Mutex::new(Vec::new())).lock() {
        *guard = paths;
    }
}

pub fn take_armed_drag_paths() -> Vec<String> {
    if let Ok(mut guard) = ARMED_DRAG_PATHS.get_or_init(|| Mutex::new(Vec::new())).lock() {
        std::mem::take(&mut *guard)
    } else {
        Vec::new()
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct CrossWindowDragState {
    pub pid: u32,
    pub active: bool,
    pub started_at_ms: u128,
    pub ended_at_ms: u128,
    pub paths: Vec<String>,
}

fn current_epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn drag_state_file_path() -> std::path::PathBuf {
    std::env::temp_dir().join("vfinder-drag-state.json")
}

pub fn write_cross_window_drag_start(paths: &[String]) {
    let state = CrossWindowDragState {
        pid: std::process::id(),
        active: true,
        started_at_ms: current_epoch_ms(),
        ended_at_ms: 0,
        paths: paths.to_vec(),
    };
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(drag_state_file_path(), json);
    }
}

pub fn mark_cross_window_drag_end() {
    let path = drag_state_file_path();
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(mut state) = serde_json::from_str::<CrossWindowDragState>(&raw) {
            if state.pid == std::process::id() {
                state.active = false;
                state.ended_at_ms = current_epoch_ms();
                if let Ok(json) = serde_json::to_string(&state) {
                    let _ = std::fs::write(&path, json);
                }
            }
        }
    }
}

pub fn check_is_finder_drag(dropped_paths: Option<&[String]>, consume: bool) -> bool {
    let path = drag_state_file_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(state) = serde_json::from_str::<CrossWindowDragState>(&raw) else {
        return false;
    };
    let now = current_epoch_ms();
    let time_valid = (state.active && now.saturating_sub(state.started_at_ms) < 60_000)
        || (state.ended_at_ms > 0 && now.saturating_sub(state.ended_at_ms) < 3_000);
    if !time_valid || state.paths.is_empty() {
        return false;
    }
    if let Some(dp) = dropped_paths {
        if !dp.is_empty() && !dp.iter().any(|p| state.paths.contains(p)) {
            return false;
        }
    }
    if consume {
        let _ = std::fs::remove_file(&path);
    }
    true
}

#[derive(Clone, serde::Serialize)]
struct ExternalUrlDropPayload {
    urls: Vec<String>,
    x: i32,
    y: i32,
}

#[cfg(target_os = "linux")]
pub fn setup_linux_webview(window: &tauri::WebviewWindow) {
    if let Ok(gtk_win) = window.gtk_window() {
        use gtk::gdk_pixbuf::PixbufLoader;
        use gtk::prelude::*;
        let loader = PixbufLoader::new();
        let _ = loader.write(include_bytes!("../icons/128x128.png"));
        let _ = loader.close();
        if let Some(pixbuf) = loader.pixbuf() {
            gtk_win.set_icon(Some(&pixbuf));
            gtk_win.set_icon_name(Some("vfinder"));
        }
    }
    let app_handle = window.app_handle().clone();
    let _ = window.with_webview(move |webview| {
        use gtk::glib::object::ObjectType;
        use gtk::prelude::*;
        use webkit2gtk::{SettingsExt, WebViewExt};
        use std::ffi::c_void;

        extern "C" {
            fn g_object_get_data(object: *mut c_void, key: *const std::os::raw::c_char) -> *mut c_void;
            fn g_signal_handlers_disconnect_matched(
                instance: *mut c_void,
                mask: u32,
                signal_id: u32,
                detail: u32,
                closure: *mut c_void,
                func: *mut c_void,
                data: *mut c_void,
            ) -> u32;
            fn gtk_event_controller_set_propagation_phase(
                controller: *mut c_void,
                phase: i32,
            );
        }

        let wv = webview.inner();
        let wv_ptr = wv.as_ptr() as *mut c_void;

        if std::env::var_os("VFINDER_WEBVIEW_DEBUG").is_some() {
            if let Some(settings) = WebViewExt::settings(&wv) {
                settings.set_enable_write_console_messages_to_stdout(true);
            }
            wv.connect_load_failed(|_, event, uri, error| {
                eprintln!("[webview] Load failed at {event:?} for {uri}: {error}");
                false
            });
            wv.connect_web_process_terminated(|_, reason| {
                eprintln!("[webview] Web process terminated: {reason:?}");
            });
        }

        unsafe {
            // WebKitWebViewBase stores its internal GtkGestureZoom under "wk-view-zoom-gesture".
            // Setting propagation phase to GTK_PHASE_NONE (0) and disconnecting its signal handlers
            // completely disables WebKitGTK's native touchpad pinch-zoom animation.
            let zoom_gesture = g_object_get_data(
                wv_ptr,
                b"wk-view-zoom-gesture\0".as_ptr() as *const std::os::raw::c_char,
            );
            if !zoom_gesture.is_null() {
                gtk_event_controller_set_propagation_phase(zoom_gesture, 0);
                // G_SIGNAL_MATCH_DATA = 1 << 4 = 16
                g_signal_handlers_disconnect_matched(
                    zoom_gesture,
                    16,
                    0,
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    wv_ptr,
                );
            }
        }

        // Provide file:// URIs to external apps (Brave, Chrome, Discord, etc.) when an outbound drag is dropped
        wv.connect_drag_data_get(|_, _ctx, selection_data, _info, _time| {
            let paths = ACTIVE_OUTBOUND_PATHS
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            if paths.is_empty() {
                return;
            }
            let uris: Vec<String> = paths
                .iter()
                .filter_map(|p| {
                    gtk::glib::filename_to_uri(p, None)
                        .ok()
                        .map(|g| g.to_string())
                })
                .collect();
            let uri_refs: Vec<&str> = uris.iter().map(|s| s.as_str()).collect();
            if !selection_data.set_uris(&uri_refs) {
                let text = uris.join("\r\n");
                selection_data.set_text(&text);
            }
        });

        let app_for_end = app_handle.clone();
        wv.connect_drag_end(move |_, _ctx| {
            OUTBOUND_DRAG_IN_PROGRESS.store(false, Ordering::SeqCst);
            mark_cross_window_drag_end();
            let _ = app_for_end.emit("outbound-drag-ended", ());
        });

        // Also intercept HTTP/HTTPS/data URLs dragged from Brave/Chrome web pages into the File Manager
        let app_for_recv = app_handle.clone();
        wv.connect_drag_data_received(move |_, _ctx, x, y, selection_data, _info, _time| {
            if OUTBOUND_DRAG_IN_PROGRESS.load(Ordering::SeqCst) {
                return;
            }
            let mut web_urls: Vec<String> = Vec::new();
            for u in selection_data.uris() {
                let s = u.to_string();
                if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:") {
                    web_urls.push(s);
                }
            }
            if web_urls.is_empty() {
                if let Some(txt) = selection_data.text() {
                    for line in txt.lines() {
                        let trimmed = line.trim();
                        if trimmed.starts_with("http://")
                            || trimmed.starts_with("https://")
                            || trimmed.starts_with("data:")
                        {
                            web_urls.push(trimmed.to_string());
                        }
                    }
                }
            }
            if !web_urls.is_empty() {
                let _ = app_for_recv.emit(
                    "external-url-drop",
                    ExternalUrlDropPayload {
                        urls: web_urls,
                        x,
                        y,
                    },
                );
            }
        });

        let app_for_event = app_handle.clone();
        wv.connect_event(move |widget, event| {
            let ev_type = event.event_type();
            if ev_type == gtk::gdk::EventType::TouchpadPinch {
                return gtk::glib::Propagation::Stop;
            }

            if ev_type == gtk::gdk::EventType::ButtonPress {
                OUTBOUND_DRAG_IN_PROGRESS.store(false, Ordering::SeqCst);
            } else if ev_type == gtk::gdk::EventType::ButtonRelease {
                set_armed_drag_paths(Vec::new());
            } else if ev_type == gtk::gdk::EventType::MotionNotify
                || ev_type == gtk::gdk::EventType::LeaveNotify
            {
                let should_check = !OUTBOUND_DRAG_IN_PROGRESS.load(Ordering::SeqCst)
                    && ARMED_DRAG_PATHS
                        .get_or_init(|| Mutex::new(Vec::new()))
                        .lock()
                        .map(|g| !g.is_empty())
                        .unwrap_or(false);

                if should_check {
                    let w = widget.allocated_width() as f64;
                    let h = widget.allocated_height() as f64;
                    let near_edge = if ev_type == gtk::gdk::EventType::LeaveNotify {
                        true
                    } else if let Some((x, y)) = event.coords() {
                        w > 40.0
                            && h > 40.0
                            && (x <= 12.0 || y <= 12.0 || x >= w - 12.0 || y >= h - 12.0)
                    } else {
                        false
                    };

                    if near_edge {
                        let paths = take_armed_drag_paths();
                        if !paths.is_empty() {
                            let is_dir = paths
                                .first()
                                .map(|p| std::path::Path::new(p).is_dir())
                                .unwrap_or(false);
                            write_cross_window_drag_start(&paths);
                            if let Ok(mut out_guard) = ACTIVE_OUTBOUND_PATHS
                                .get_or_init(|| Mutex::new(Vec::new()))
                                .lock()
                            {
                                *out_guard = paths;
                            }
                            OUTBOUND_DRAG_IN_PROGRESS.store(true, Ordering::SeqCst);

                            let target_list = gtk::TargetList::new(&[]);
                            target_list.add_uri_targets(1);
                            target_list.add_text_targets(2);

                            let actions = gtk::gdk::DragAction::COPY
                                | gtk::gdk::DragAction::MOVE
                                | gtk::gdk::DragAction::LINK;

                            if let Some(ctx) = widget.drag_begin_with_coordinates(
                                &target_list,
                                actions,
                                1,
                                Some(event),
                                -1,
                                -1,
                            ) {
                                ctx.drag_set_icon_name(
                                    if is_dir { "folder" } else { "text-x-generic" },
                                    16,
                                    16,
                                );
                            }

                            let _ = app_for_event.emit("outbound-drag-started", ());
                            return gtk::glib::Propagation::Stop;
                        }
                    }
                }
            }

            gtk::glib::Propagation::Proceed
        });
    });
}

fn main() {
    #[cfg(unix)]
    handle_sudo_flag_and_root_env();

    let startup_target = std::env::args_os()
        .skip(1)
        .find(|arg| !arg.to_string_lossy().starts_with('-'))
        .and_then(|argument| startup_argument_path(&argument));
    let startup_selection = startup_target
        .as_ref()
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned());
    let startup_directory = startup_target.map(|path| {
        if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(std::path::Path::new("/")).to_path_buf()
        }
    }).map(|path| path.to_string_lossy().into_owned());
    let _ = STARTUP_DIRECTORY.set(startup_directory);
    let _ = STARTUP_SELECTION.set(startup_selection);

    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "linux")]
            init_linux_app_icon();
            #[cfg(target_os = "linux")]
            if !is_effective_root() {
                setup_file_manager_dbus(app.handle().clone());
            }
            download_server::start_download_server(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                if is_effective_root() {
                    let _ = window.set_title("vFinder (Root)");
                }
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                let _ = window.set_background_color(Some(Color(30, 30, 34, 255)));
                #[cfg(target_os = "linux")]
                setup_linux_webview(&window);
                // Safety fallback: ensure window becomes visible within 350ms if frontend hasn't shown it yet
                let win_clone = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(350));
                    if !win_clone.is_visible().unwrap_or(true) {
                        let _ = win_clone.show();
                        let _ = win_clone.set_focus();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_directory,
            commands::prefetch_directories,
            commands::get_sidebar_data,
            commands::elevate_to_root_session,
            get_startup_directory,
            get_startup_selection,
            file_manager_frontend_ready,
            take_file_manager_requests,
            commands::mount_partition,
            commands::unmount_partition,
            commands::create_directory,
            commands::create_file,
            commands::rename_item,
            commands::copy_items,
            commands::move_items,
            commands::duplicate_item,
            commands::compress_items,
            commands::read_archive_contents,
            commands::extract_archive,
            commands::trash_items,
            commands::get_trash_files,
            commands::restore_trash_items,
            commands::delete_trash_items_permanently,
            commands::empty_trash,
            commands::open_item,
            commands::open_item_with,
            commands::set_default_app,
            commands::read_file_preview,
            commands::get_file_preview_url,
            commands::search_directory,
            commands::toggle_item_tag,
            commands::get_files_by_tag,
            commands::get_recent_files,
            commands::show_main_window,
            commands::close_main_window,
            commands::open_detached_tab_window,
            commands::get_image_thumbnail,
            commands::get_file_info,
            commands::set_file_executable,
            commands::get_available_format_types,
            commands::format_partition,
            commands::check_partition,
            commands::set_webview_zoom,
            commands::arm_external_drag,
            commands::disarm_external_drag,
            commands::check_finder_drag,
            commands::save_dropped_urls,
            commands::start_download,
            commands::cancel_download,
            commands::get_default_downloads_dir,
            commands::get_pending_downloads,
        ])
        .run(tauri::generate_context!())
        .expect("error while running vFinder application");
}
