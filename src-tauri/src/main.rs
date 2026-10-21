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
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "linux")]
            init_linux_app_icon();
            download_server::start_download_server(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
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
            commands::mount_partition,
            commands::unmount_partition,
            commands::create_directory,
            commands::create_file,
            commands::rename_item,
            commands::copy_items,
            commands::move_items,
            commands::duplicate_item,
            commands::trash_items,
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
