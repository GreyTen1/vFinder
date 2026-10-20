use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static ACTIVE_DOWNLOADS: OnceLock<Mutex<HashMap<String, DownloadHandle>>> = OnceLock::new();

struct DownloadHandle {
    cancel_flag: Arc<AtomicBool>,
    child_pid: Option<u32>,
    part_path: PathBuf,
    hdr_path: PathBuf,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartDownloadArgs {
    pub id: String,
    pub url: String,
    pub target_path: String,
    pub total_bytes: i64,
    pub referrer: Option<String>,
    pub user_agent: Option<String>,
    pub cookies: Option<String>,
    pub blob_base64: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressPayload {
    pub id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: i64,
    pub speed: u64, // bytes/sec
    pub percentage: f64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCompletedPayload {
    pub id: String,
    pub target_path: String,
    pub filename: String,
    pub total_bytes: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFailedPayload {
    pub id: String,
    pub error: String,
}

pub fn get_default_downloads_dir() -> String {
    dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .to_string_lossy()
        .to_string()
}

pub fn cancel_download(id: &str) -> bool {
    let mut map = match ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        Ok(g) => g,
        Err(_) => return false,
    };

    if let Some(handle) = map.remove(id) {
        handle.cancel_flag.store(true, Ordering::SeqCst);
        if let Some(pid) = handle.child_pid {
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
        }
        if handle.part_path.exists() {
            let _ = fs::remove_file(&handle.part_path);
        }
        if handle.hdr_path.exists() {
            let _ = fs::remove_file(&handle.hdr_path);
        }
        true
    } else {
        false
    }
}

fn apply_browser_headers(
    cmd: &mut Command,
    user_agent: Option<&str>,
    referrer: Option<&str>,
    cookies: Option<&str>,
) {
    let ua = user_agent.filter(|s| !s.is_empty()).unwrap_or(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    );
    cmd.arg("-A").arg(ua);
    cmd.args([
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "-H", "Accept-Language: en-US,en;q=0.9",
        "-H", "Sec-Ch-Ua: \"Chromium\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
        "-H", "Sec-Ch-Ua-Mobile: ?0",
        "-H", "Sec-Ch-Ua-Platform: \"Linux\"",
        "-H", "Sec-Fetch-Dest: document",
        "-H", "Sec-Fetch-Mode: navigate",
        "-H", "Sec-Fetch-User: ?1",
        "-H", "Upgrade-Insecure-Requests: 1",
    ]);

    if let Some(ref_url) = referrer {
        if !ref_url.is_empty() {
            cmd.arg("-e").arg(ref_url);
            cmd.args(["-H", "Sec-Fetch-Site: same-origin"]);
        } else {
            cmd.args(["-H", "Sec-Fetch-Site: none"]);
        }
    } else {
        cmd.args(["-H", "Sec-Fetch-Site: none"]);
    }

    if let Some(ck) = cookies {
        if !ck.is_empty() {
            cmd.arg("-b").arg(ck);
        }
    }
}

pub fn start_download(app: AppHandle, args: StartDownloadArgs) {
    std::thread::spawn(move || {
        let target = PathBuf::from(&args.target_path);
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let filename = target
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "downloaded-file".to_string());

        // Handle in-memory blob data if supplied
        if let Some(b64) = args.blob_base64 {
            match BASE64.decode(b64.trim()) {
                Ok(bytes) => {
                    let total_bytes = bytes.len() as u64;
                    if let Err(e) = fs::write(&target, bytes) {
                        let _ = app.emit(
                            "download-failed",
                            DownloadFailedPayload {
                                id: args.id,
                                error: e.to_string(),
                            },
                        );
                    } else {
                        let _ = app.emit(
                            "download-completed",
                            DownloadCompletedPayload {
                                id: args.id,
                                target_path: target.to_string_lossy().to_string(),
                                filename,
                                total_bytes,
                            },
                        );
                    }
                    return;
                }
                Err(e) => {
                    let _ = app.emit(
                        "download-failed",
                        DownloadFailedPayload {
                            id: args.id,
                            error: format!("Failed to decode blob data: {}", e),
                        },
                    );
                    return;
                }
            }
        }

        let part_path = PathBuf::from(format!("{}.download", args.target_path));
        let hdr_path = PathBuf::from(format!("{}.download.headers", args.target_path));
        if part_path.exists() {
            let _ = fs::remove_file(&part_path);
        }
        if hdr_path.exists() {
            let _ = fs::remove_file(&hdr_path);
        }

        let mut total_bytes = args.total_bytes;

        // Spawn curl download process with browser headers and response header dump
        let mut cmd = Command::new("curl");
        cmd.args(["-f", "-s", "-S", "-L", "--compressed"]);
        apply_browser_headers(
            &mut cmd,
            args.user_agent.as_deref(),
            args.referrer.as_deref(),
            args.cookies.as_deref(),
        );
        cmd.arg("--dump-header").arg(&hdr_path);
        cmd.arg("-o").arg(&part_path);
        cmd.arg(&args.url);
        cmd.stderr(std::process::Stdio::piped());

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(
                    "download-failed",
                    DownloadFailedPayload {
                        id: args.id,
                        error: e.to_string(),
                    },
                );
                return;
            }
        };

        let pid = child.id();

        // Register in active downloads
        if let Ok(mut map) = ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
            map.insert(
                args.id.clone(),
                DownloadHandle {
                    cancel_flag: cancel_flag.clone(),
                    child_pid: Some(pid),
                    part_path: part_path.clone(),
                    hdr_path: hdr_path.clone(),
                },
            );
        }

        let mut last_bytes = 0u64;
        let mut last_time = Instant::now();
        let mut current_speed = 0u64;

        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&part_path);
                if hdr_path.exists() {
                    let _ = fs::remove_file(&hdr_path);
                }
                return;
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    // Remove from active downloads
                    if let Ok(mut map) =
                        ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new())).lock()
                    {
                        map.remove(&args.id);
                    }
                    if hdr_path.exists() {
                        let _ = fs::remove_file(&hdr_path);
                    }

                    if status.success() && part_path.exists() {
                        if fs::rename(&part_path, &target).is_ok() {
                            let final_size =
                                fs::metadata(&target).map(|m| m.len()).unwrap_or(last_bytes);
                            let _ = app.emit(
                                "download-completed",
                                DownloadCompletedPayload {
                                    id: args.id,
                                    target_path: target.to_string_lossy().to_string(),
                                    filename,
                                    total_bytes: final_size,
                                },
                            );
                        } else {
                            let _ = app.emit(
                                "download-failed",
                                DownloadFailedPayload {
                                    id: args.id,
                                    error: "Failed to move completed download to destination"
                                        .to_string(),
                                },
                            );
                        }
                    } else {
                        let mut err_msg = String::new();
                        if let Some(mut err_stream) = child.stderr.take() {
                            let _ = err_stream.read_to_string(&mut err_msg);
                        }
                        let _ = fs::remove_file(&part_path);
                        let clean_err = err_msg.trim();
                        let error_desc = if !clean_err.is_empty() {
                            clean_err.to_string()
                        } else {
                            format!(
                                "Download interrupted or server returned an error (code {:?})",
                                status.code()
                            )
                        };
                        let _ = app.emit(
                            "download-failed",
                            DownloadFailedPayload {
                                id: args.id,
                                error: error_desc,
                            },
                        );
                    }
                    break;
                }
                Ok(None) => {
                    // Inspect dumped headers to update total_bytes if previously unknown
                    if total_bytes <= 0 && hdr_path.exists() {
                        if let Ok(content) = fs::read_to_string(&hdr_path) {
                            for line in content.lines() {
                                let lower = line.to_ascii_lowercase();
                                if lower.starts_with("content-length:") {
                                    if let Some(val_str) = lower.strip_prefix("content-length:") {
                                        if let Ok(val) = val_str.trim().parse::<i64>() {
                                            if val > 0 {
                                                total_bytes = val;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let current_bytes = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
                    let now = Instant::now();
                    let elapsed = now.duration_since(last_time).as_secs_f64();
                    if elapsed >= 0.25 {
                        let diff = current_bytes.saturating_sub(last_bytes);
                        last_bytes = current_bytes;
                        last_time = now;
                        current_speed = (diff as f64 / elapsed) as u64;
                    }

                    let percentage = if total_bytes > 0 {
                        ((current_bytes as f64 / total_bytes as f64) * 100.0).clamp(0.0, 100.0)
                    } else {
                        0.0
                    };

                    let _ = app.emit(
                        "download-progress",
                        DownloadProgressPayload {
                            id: args.id.clone(),
                            downloaded_bytes: current_bytes,
                            total_bytes,
                            speed: current_speed,
                            percentage,
                        },
                    );

                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(e) => {
                    if let Ok(mut map) =
                        ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new())).lock()
                    {
                        map.remove(&args.id);
                    }
                    let _ = fs::remove_file(&part_path);
                    if hdr_path.exists() {
                        let _ = fs::remove_file(&hdr_path);
                    }
                    let _ = app.emit(
                        "download-failed",
                        DownloadFailedPayload {
                            id: args.id,
                            error: e.to_string(),
                        },
                    );
                    break;
                }
            }
        }
    });
}
