use crate::models::{
    FileEntry, FilePreview, FormatTypeOption, OpenWithConfig, SidebarData, UserDirectory,
    VolumeInfo,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

static TAGS_CACHE: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
static OPEN_WITH_CACHE: OnceLock<Mutex<OpenWithConfig>> = OnceLock::new();
static META_CONFIG_VERSION: AtomicU64 = AtomicU64::new(1);
static DETACHED_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

fn encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[tauri::command]
pub async fn open_detached_tab_window(
    window: tauri::WebviewWindow,
    path: String,
    title: String,
    active_tag: Option<String>,
) -> Result<String, String> {
    let counter = DETACHED_WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("explorer-{}-{counter}", std::process::id());
    let mut app_path = format!(
        "index.html?vfinder_detached=1&vfinder_path={}&vfinder_title={}",
        encode_query_value(&path),
        encode_query_value(&title)
    );
    if let Some(tag) = active_tag {
        app_path.push_str("&vfinder_tag=");
        app_path.push_str(&encode_query_value(&tag));
    }

    let app_handle = window.app_handle();
    let new_window = tauri::WebviewWindowBuilder::new(
        app_handle,
        &label,
        tauri::WebviewUrl::App(PathBuf::from(app_path)),
    )
    .title(if is_root_session() { "vFinder (Root)" } else { "vFinder" })
    .inner_size(1160.0, 740.0)
    .min_inner_size(760.0, 480.0)
    .decorations(false)
    .resizable(true)
    .transparent(false)
    .visible(true)
    .center()
    .build()
    .map_err(|error| error.to_string())?;

    if app_handle.get_webview_window(&label).is_none() {
        let _ = new_window.close();
        return Err("Detached window was not registered".to_string());
    }

    let _ = new_window.set_background_color(Some(tauri::window::Color(30, 30, 34, 255)));
    #[cfg(target_os = "linux")]
    crate::setup_linux_webview(&new_window);
    crate::download_server::activate_window_cross_desktop(&new_window);
    Ok(label)
}

struct CachedVolumeList {
    signature: String,
    updated_at: Instant,
    volumes: Vec<VolumeInfo>,
}

struct CachedDirList {
    mtime_ns: u128,
    config_ver: u64,
    updated_at: Instant,
    entries: Vec<FileEntry>,
}

static VOLUMES_CACHE: OnceLock<Mutex<Option<CachedVolumeList>>> = OnceLock::new();
static DIR_ENTRIES_CACHE: OnceLock<Mutex<HashMap<(String, bool), CachedDirList>>> = OnceLock::new();
static RECENTS_CACHE: OnceLock<Mutex<HashMap<bool, CachedDirList>>> = OnceLock::new();

pub fn bump_cache_version() {
    META_CONFIG_VERSION.fetch_add(1, Ordering::Relaxed);
}

pub fn invalidate_volumes_cache() {
    if let Some(m) = VOLUMES_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
}

fn path_mtime_ns(p: &Path) -> u128 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
struct LsblkOutput {
    blockdevices: Vec<LsblkDevice>,
}

#[derive(Debug, Deserialize)]
struct LsblkDevice {
    name: String,
    path: Option<String>,
    label: Option<String>,
    partlabel: Option<String>,
    fstype: Option<String>,
    size: Option<u64>,
    fsavail: Option<u64>,
    fsused: Option<u64>,
    mountpoint: Option<String>,
    #[serde(default)]
    mountpoints: Vec<Option<String>>,
    #[serde(default)]
    rm: bool,
    #[serde(default)]
    hotplug: bool,
    model: Option<String>,
    vendor: Option<String>,
    tran: Option<String>,
    #[serde(default)]
    children: Vec<LsblkDevice>,
}

pub fn get_system_os_name() -> String {
    for path in ["/etc/os-release", "/usr/lib/os-release"] {
        if let Ok(content) = fs::read_to_string(path) {
            let mut name_fallback = None;
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("PRETTY_NAME=") {
                    let val = trimmed
                        .trim_start_matches("PRETTY_NAME=")
                        .trim_matches('"')
                        .trim_matches('\'')
                        .trim();
                    if !val.is_empty() {
                        return val.to_string();
                    }
                } else if trimmed.starts_with("NAME=") && name_fallback.is_none() {
                    let val = trimmed
                        .trim_start_matches("NAME=")
                        .trim_matches('"')
                        .trim_matches('\'')
                        .trim();
                    if !val.is_empty() {
                        name_fallback = Some(val.to_string());
                    }
                }
            }
            if let Some(name) = name_fallback {
                return name;
            }
        }
    }
    "Linux".to_string()
}

fn collect_lsblk_partitions(
    devices: &[LsblkDevice],
    parent_is_removable: bool,
    parent_vendor: Option<&str>,
    parent_model: Option<&str>,
    out: &mut Vec<VolumeInfo>,
) {
    for dev in devices {
        let is_usb_tran = dev
            .tran
            .as_deref()
            .map(|t| t.eq_ignore_ascii_case("usb"))
            .unwrap_or(false);
        let this_removable = dev.rm || dev.hotplug || is_usb_tran || parent_is_removable;
        let this_vendor = dev.vendor.as_deref().or(parent_vendor);
        let this_model = dev.model.as_deref().or(parent_model);

        if !dev.children.is_empty() {
            collect_lsblk_partitions(
                &dev.children,
                this_removable,
                this_vendor,
                this_model,
                out,
            );
        }

        let fstype = match dev.fstype.as_deref() {
            Some(fs) if !fs.is_empty() && fs != "swap" && fs != "squashfs" => fs.to_string(),
            _ => {
                // If it's a removable device with no children (e.g. raw or unformatted thumb drive), don't skip it
                if this_removable && dev.children.is_empty() && dev.size.unwrap_or(0) > 0 {
                    "unformatted".to_string()
                } else {
                    continue;
                }
            }
        };

        if dev.name.starts_with("zram") || dev.name.starts_with("loop") {
            continue;
        }

        let device_path = dev
            .path
            .clone()
            .unwrap_or_else(|| format!("/dev/{}", dev.name));

        // Resolve primary mountpoint (prefer "/" if present in mountpoints)
        let valid_mounts: Vec<String> = dev
            .mountpoints
            .iter()
            .filter_map(|m| m.clone())
            .filter(|m| !m.is_empty() && m != "[SWAP]")
            .collect();

        let mut mount_point = if valid_mounts.iter().any(|m| m == "/") {
            "/".to_string()
        } else if let Some(first) = valid_mounts.first() {
            first.clone()
        } else if let Some(mp) = &dev.mountpoint {
            if mp != "[SWAP]" {
                mp.clone()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Fallback: check /proc/mounts (for FUSE / exfat-fuse / udisks mounts that lsblk might omit)
        if mount_point.is_empty() {
            if let Ok(proc_mounts) = fs::read_to_string("/proc/mounts") {
                for line in proc_mounts.lines() {
                    let mut parts = line.split_whitespace();
                    let src = parts.next().unwrap_or("");
                    let dst = parts.next().unwrap_or("");
                    if src == device_path && !dst.is_empty() {
                        mount_point = dst.replace("\\040", " ");
                        break;
                    }
                }
            }
        }

        let is_mounted = !mount_point.is_empty();
        let mut total_space = dev.size.unwrap_or(0);
        let mut available_space = dev.fsavail.unwrap_or(0);
        let mut used_space = dev
            .fsused
            .unwrap_or_else(|| total_space.saturating_sub(available_space));

        // If mounted (e.g. via FUSE) and lsblk did not report fsavail, query df -B1
        if is_mounted && dev.fsavail.is_none() {
            if let Ok(df_out) = Command::new("df")
                .args(["-B1", "--output=size,used,avail", &mount_point])
                .output()
            {
                if df_out.status.success() {
                    let stdout = String::from_utf8_lossy(&df_out.stdout);
                    if let Some(data_line) = stdout.lines().nth(1) {
                        let nums: Vec<u64> = data_line
                            .split_whitespace()
                            .filter_map(|s| s.parse::<u64>().ok())
                            .collect();
                        if nums.len() >= 3 {
                            if total_space == 0 {
                                total_space = nums[0];
                            }
                            used_space = nums[1];
                            available_space = nums[2];
                        }
                    }
                }
            }
        }

        let label = dev.label.clone().unwrap_or_default();
        let partlabel = dev.partlabel.clone().unwrap_or_default();

        // Check if this is an EFI or small recovery system partition (removable drives are NEVER system)
        let is_efi = partlabel.eq_ignore_ascii_case("EFI")
            || mount_point.eq_ignore_ascii_case("/boot/efi")
            || mount_point.eq_ignore_ascii_case("/efi")
            || (fstype == "vfat" && total_space < 1_200_000_000);
        let is_recovery = fstype == "ntfs" && label.is_empty() && total_space < 2_500_000_000;
        let is_system = !this_removable && (is_efi || is_recovery);

        // Build a user-friendly brand / hardware name for USB drives
        let hardware_name = {
            let v = this_vendor.map(|s| s.trim()).unwrap_or("");
            let m = this_model.map(|s| s.trim()).unwrap_or("");
            if !v.is_empty() && !m.is_empty() {
                if m.to_lowercase().starts_with(&v.to_lowercase()) {
                    m.to_string()
                } else {
                    format!("{} {}", v, m)
                }
            } else if !m.is_empty() {
                m.to_string()
            } else if !v.is_empty() {
                v.to_string()
            } else {
                String::new()
            }
        };

        let display_name = if mount_point == "/" {
            if !label.is_empty() {
                label.clone()
            } else if !partlabel.is_empty() {
                partlabel.clone()
            } else {
                get_system_os_name()
            }
        } else if !label.is_empty() {
            label.clone()
        } else if this_removable && !hardware_name.is_empty() {
            hardware_name
        } else if this_removable {
            format!("USB Drive ({})", dev.name)
        } else if is_efi {
            format!("EFI Boot ({})", dev.name)
        } else if is_recovery {
            format!("Windows Recovery ({})", dev.name)
        } else if !partlabel.is_empty() && !partlabel.eq_ignore_ascii_case("Micr") {
            partlabel.clone()
        } else if fstype == "ntfs" {
            "Windows (NTFS)".to_string()
        } else if fstype == "unformatted" {
            format!("Unformatted ({})", dev.name)
        } else {
            format!("{} Volume", fstype.to_uppercase())
        };

        let can_unmount =
            is_mounted && mount_point != "/" && !mount_point.starts_with("/boot");

        out.push(VolumeInfo {
            name: display_name,
            device: device_path,
            short_device: dev.name.clone(),
            mount_point,
            is_mounted,
            can_unmount,
            total_space,
            available_space,
            used_space,
            file_system: fstype,
            is_removable: this_removable,
            is_system,
        });
    }
}

pub fn list_system_partitions() -> Vec<VolumeInfo> {
    let mounts_sig = fs::read_to_string("/proc/mounts").unwrap_or_default();
    let parts_sig = fs::read_to_string("/proc/partitions").unwrap_or_default();
    let combined_sig = format!("{}|{}", mounts_sig, parts_sig);

    let cache_mutex = VOLUMES_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache_mutex.lock() {
        if let Some(ref cached) = *guard {
            if cached.signature == combined_sig && cached.updated_at.elapsed().as_secs() < 30 {
                return cached.volumes.clone();
            }
        }
    }

    let output = Command::new("lsblk")
        .args([
            "-J",
            "-b",
            "-o",
            "NAME,PATH,LABEL,PARTLABEL,FSTYPE,SIZE,FSAVAIL,FSUSED,MOUNTPOINT,MOUNTPOINTS,RM,HOTPLUG,MODEL,VENDOR,TRAN,TYPE",
        ])
        .output();

    let mut volumes = Vec::new();
    if let Ok(out) = output {
        if let Ok(parsed) = serde_json::from_slice::<LsblkOutput>(&out.stdout) {
            collect_lsblk_partitions(&parsed.blockdevices, false, None, None, &mut volumes);
        }
    }

    // Sort: Root ("/") first, then Removable USB drives, then internal partitions, then system partitions
    volumes.sort_by(|a, b| {
        let a_root = a.mount_point == "/";
        let b_root = b.mount_point == "/";
        if a_root != b_root {
            return b_root.cmp(&a_root);
        }
        if a.is_removable != b.is_removable {
            return b.is_removable.cmp(&a.is_removable);
        }
        if a.is_system != b.is_system {
            return a.is_system.cmp(&b.is_system);
        }
        b.total_space.cmp(&a.total_space)
    });

    if let Ok(mut guard) = cache_mutex.lock() {
        *guard = Some(CachedVolumeList {
            signature: combined_sig,
            updated_at: Instant::now(),
            volumes: volumes.clone(),
        });
    }

    volumes
}

pub fn is_root_session() -> bool {
    crate::is_effective_root() || crate::is_admin_mode()
}

pub fn effective_user_home_dir() -> PathBuf {
    if let Ok(orig) = std::env::var("VFINDER_ORIGINAL_HOME") {
        let p = PathBuf::from(orig.trim());
        if !orig.trim().is_empty() && p.exists() {
            return p;
        }
    }
    if let Ok(sudo_user) = std::env::var("SUDO_USER") {
        let trimmed = sudo_user.trim();
        if !trimmed.is_empty() && trimmed != "root" {
            let candidate = PathBuf::from(format!("/home/{trimmed}"));
            if candidate.exists() {
                return candidate;
            }
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn effective_user_subdir(dir_fn: fn() -> Option<PathBuf>, fallback_name: &str) -> Option<PathBuf> {
    if is_root_session() {
        let candidate = effective_user_home_dir().join(fallback_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    dir_fn().or_else(|| {
        let candidate = effective_user_home_dir().join(fallback_name);
        if candidate.exists() {
            Some(candidate)
        } else {
            None
        }
    })
}

static SUDO_SESSION_PASS: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn get_cached_sudo_password() -> Option<String> {
    SUDO_SESSION_PASS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|g| g.clone())
}

fn set_cached_sudo_password(pwd: Option<String>) {
    if let Ok(mut guard) = SUDO_SESSION_PASS
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        *guard = pwd;
    }
}

fn run_sudo_command(password: &str, args: &[&str]) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    if is_root_session() {
        if args.is_empty() || args[0].starts_with('-') {
            return Ok(());
        }
        let output = Command::new(args[0])
            .env("LC_ALL", "C")
            .args(&args[1..])
            .output()
            .map_err(|e| format!("Failed to run {}: {}", args[0], e))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Command failed".to_string()
        } else {
            stderr
        });
    }

    let mut child = Command::new("sudo")
        .env("LC_ALL", "C")
        .arg("-S")
        .arg("-p")
        .arg("")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start sudo: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n", password).as_bytes());
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed waiting for sudo: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let lower = stderr.to_lowercase();
        if lower.contains("sorry, try again")
            || lower.contains("incorrect password")
            || lower.contains("authentication failure")
        {
            set_cached_sudo_password(None);
            Err("INVALID_PASSWORD".to_string())
        } else {
            Err(if stderr.is_empty() {
                "Command failed".to_string()
            } else {
                stderr
            })
        }
    }
}

fn validate_sudo_password(password: &str) -> Result<(), String> {
    if crate::is_effective_root() {
        return Ok(());
    }
    run_sudo_command(password, &["-k", "-v"])?;
    set_cached_sudo_password(Some(password.to_string()));
    Ok(())
}

fn execute_privileged_task<F>(mut task: F, sudo_args: &[&str]) -> Result<(), String>
where
    F: FnMut() -> std::io::Result<()>,
{
    match task() {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(13) => {
            // Permission denied: try executing targeted sudo command if privileged credentials exist
            #[cfg(unix)]
            {
                let pass = if crate::is_effective_root() {
                    String::new()
                } else if let Some(cached) = get_cached_sudo_password() {
                    cached
                } else {
                    return Err("AUTH_REQUIRED".to_string());
                };

                run_sudo_command(&pass, sudo_args)
            }
            #[cfg(not(unix))]
            Err(format!("{e}"))
        }
        Err(e) => Err(format!("{e}")),
    }
}

#[tauri::command]
pub async fn elevate_to_root_session(
    _window: tauri::WebviewWindow,
    password: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_sudo_password(&password)?;
        crate::set_admin_mode(true);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn find_exfat_fuse_binary() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("bin/mount.exfat-fuse"));
            candidates.push(exe_dir.join("mount.exfat-fuse"));
            if let Some(parent) = exe_dir.parent() {
                candidates.push(parent.join("bin/mount.exfat-fuse"));
                candidates.push(parent.join("mount.exfat-fuse"));
                if let Some(grandparent) = parent.parent() {
                    candidates.push(grandparent.join("bin/mount.exfat-fuse"));
                }
            }
        }
    }
    candidates.push(PathBuf::from("/usr/bin/mount.exfat-fuse"));
    candidates.push(PathBuf::from("/usr/sbin/mount.exfat-fuse"));
    candidates.push(PathBuf::from("/usr/bin/mount.exfat"));
    candidates.push(PathBuf::from("/sbin/mount.exfat-fuse"));

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

fn current_uid_gid_user() -> (String, String, String) {
    if let (Ok(orig_uid), Ok(orig_gid), Ok(orig_user)) = (
        std::env::var("VFINDER_ORIGINAL_UID").or_else(|_| std::env::var("SUDO_UID")),
        std::env::var("VFINDER_ORIGINAL_GID").or_else(|_| std::env::var("SUDO_GID")),
        std::env::var("VFINDER_ORIGINAL_USER").or_else(|_| std::env::var("SUDO_USER")),
    ) {
        if !orig_uid.trim().is_empty() && !orig_user.trim().is_empty() {
            return (
                orig_uid.trim().to_string(),
                orig_gid.trim().to_string(),
                orig_user.trim().to_string(),
            );
        }
    }

    let uid = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "1000".to_string());
    let gid = Command::new("id")
        .arg("-g")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "1000".to_string());
    let user = Command::new("id")
        .arg("-un")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USER").ok())
        .or_else(|| std::env::var("LOGNAME").ok())
        .unwrap_or_else(|| "root".to_string());
    (uid, gid, user)
}

#[tauri::command]
pub async fn mount_partition(
    device: String,
    password: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let partitions = list_system_partitions();
        let target_vol = partitions.iter().find(|v| v.device == device).cloned();

        if let Some(ref v) = target_vol {
            if v.is_mounted && !v.mount_point.is_empty() {
                return Ok(v.mount_point.clone());
            }
        }

        // 1. If no password was provided yet, try passwordless udisksctl or cached session password
        let effective_password = match password {
            Some(p) if !p.is_empty() => p,
            _ => {
                if let Ok(res) = Command::new("udisksctl")
                    .args(["mount", "--no-user-interaction", "-b", &device])
                    .output()
                {
                    if res.status.success() {
                        let out_str = String::from_utf8_lossy(&res.stdout);
                        if let Some(pos) = out_str.find(" at ") {
                            let mp = out_str[pos + 4..].trim().trim_end_matches('.').to_string();
                            if !mp.is_empty() && Path::new(&mp).exists() {
                                return Ok(mp);
                            }
                        }
                        for v in list_system_partitions() {
                            if v.device == device && v.is_mounted {
                                return Ok(v.mount_point);
                            }
                        }
                    }
                }
                if is_root_session() {
                    String::new()
                } else if let Some(cached) = get_cached_sudo_password() {
                    cached
                } else {
                    return Err("AUTH_REQUIRED".to_string());
                }
            }
        };

        // 2. Validate sudo password once up-front
        validate_sudo_password(&effective_password)?;

        let (uid, gid, user) = current_uid_gid_user();

        let folder_name = target_vol
            .as_ref()
            .map(|v| {
                let clean: String = v
                    .name
                    .chars()
                    .map(|c| {
                        if c.is_alphanumeric() || c == '-' || c == '_' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
                let trimmed = clean.trim_matches('_').to_string();
                if trimmed.is_empty() {
                    v.short_device.clone()
                } else {
                    trimmed
                }
            })
            .unwrap_or_else(|| {
                Path::new(&device)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "disk".to_string())
            });

        let mount_dir = format!("/run/media/{}/{}", user, folder_name);
        run_sudo_command(&effective_password, &["mkdir", "-p", &mount_dir])?;

        let fstype = target_vol
            .as_ref()
            .map(|v| v.file_system.as_str())
            .unwrap_or("");

        let mount_res = if fstype.eq_ignore_ascii_case("exfat") {
            let opts = format!("uid={},gid={},umask=0022", uid, gid);
            // Try kernel exfat driver first, then fall back to bundled mount.exfat-fuse
            run_sudo_command(
                &effective_password,
                &["mount", "-t", "exfat", "-o", &opts, &device, &mount_dir],
            )
            .or_else(|e| {
                if let Some(fuse_bin) = find_exfat_fuse_binary() {
                    let fuse_opts =
                        format!("uid={},gid={},umask=0022,allow_other", uid, gid);
                    run_sudo_command(
                        &effective_password,
                        &[&fuse_bin, "-o", &fuse_opts, &device, &mount_dir],
                    )
                    .or_else(|_| {
                        run_sudo_command(
                            &effective_password,
                            &[&fuse_bin, "-o", &opts, &device, &mount_dir],
                        )
                    })
                } else {
                    Err(e)
                }
            })
        } else if matches!(fstype, "vfat" | "fat" | "ntfs") {
            let opts = format!("uid={},gid={},umask=0022", uid, gid);
            run_sudo_command(
                &effective_password,
                &["mount", "-o", &opts, &device, &mount_dir],
            )
            .or_else(|_| {
                run_sudo_command(&effective_password, &["mount", &device, &mount_dir])
            })
        } else {
            run_sudo_command(&effective_password, &["mount", &device, &mount_dir])
        };

        if let Err(err) = mount_res {
            let _ = run_sudo_command(&effective_password, &["rmdir", &mount_dir]);
            return Err(err);
        }

        invalidate_volumes_cache();
        for v in list_system_partitions() {
            if v.device == device && v.is_mounted {
                return Ok(v.mount_point);
            }
        }

        Ok(mount_dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn unmount_partition(
    device: String,
    password: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let partitions = list_system_partitions();
        let current_mount = partitions
            .iter()
            .find(|v| v.device == device)
            .map(|v| v.mount_point.clone())
            .unwrap_or_default();

        let effective_password = match password {
            Some(p) if !p.is_empty() => p,
            _ => {
                if let Ok(res) = Command::new("udisksctl")
                    .args(["unmount", "--no-user-interaction", "-b", &device])
                    .output()
                {
                    if res.status.success() {
                        invalidate_volumes_cache();
                        return Ok(());
                    }
                }
                if is_root_session() {
                    String::new()
                } else if let Some(cached) = get_cached_sudo_password() {
                    cached
                } else {
                    return Err("AUTH_REQUIRED".to_string());
                }
            }
        };

        validate_sudo_password(&effective_password)?;
        run_sudo_command(&effective_password, &["umount", &device]).or_else(|_| {
            if !current_mount.is_empty() {
                run_sudo_command(&effective_password, &["umount", &current_mount])
            } else {
                Err("Failed to unmount partition".to_string())
            }
        })?;

        if current_mount.starts_with("/run/media/") {
            let _ = run_sudo_command(&effective_password, &["rmdir", &current_mount]);
        }
        invalidate_volumes_cache();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn tool_exists(tool: &str) -> bool {
    Path::new(&format!("/usr/bin/{}", tool)).exists()
        || Path::new(&format!("/sbin/{}", tool)).exists()
        || Path::new(&format!("/usr/sbin/{}", tool)).exists()
        || Command::new("which")
            .arg(tool)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
}

#[tauri::command]
pub async fn get_available_format_types() -> Result<Vec<FormatTypeOption>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let has_vfat = tool_exists("mkfs.vfat") || tool_exists("mkfs.fat");
        let has_exfat = tool_exists("mkfs.exfat");
        let has_ext4 = tool_exists("mkfs.ext4");
        let has_btrfs = tool_exists("mkfs.btrfs");
        let has_ntfs = tool_exists("mkfs.ntfs") || tool_exists("mkntfs");

        Ok(vec![
            FormatTypeOption {
                id: "vfat".to_string(),
                name: "MS-DOS (FAT32)".to_string(),
                description: "Compatible with all computers (Mac, PC, Linux) and media players (max 4GB per file).".to_string(),
                is_available: has_vfat,
            },
            FormatTypeOption {
                id: "exfat".to_string(),
                name: "ExFAT".to_string(),
                description: "Compatible with modern Macs and PCs with support for files larger than 4GB.".to_string(),
                is_available: has_exfat,
            },
            FormatTypeOption {
                id: "ext4".to_string(),
                name: "Linux (Ext4)".to_string(),
                description: "Standard Linux journaling filesystem with high performance and reliability.".to_string(),
                is_available: has_ext4,
            },
            FormatTypeOption {
                id: "btrfs".to_string(),
                name: "Btrfs (Copy-on-Write)".to_string(),
                description: "Modern Linux filesystem with snapshots, checksums, and compression.".to_string(),
                is_available: has_btrfs,
            },
            FormatTypeOption {
                id: "ntfs".to_string(),
                name: "Windows (NTFS)".to_string(),
                description: "Standard Windows NT filesystem with journaling and file permissions.".to_string(),
                is_available: has_ntfs,
            },
        ])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn format_partition(
    device: String,
    fstype: String,
    label: String,
    password: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Critical safety check: NEVER allow formatting root or boot
        let partitions = list_system_partitions();
        let target_vol = partitions.iter().find(|v| v.device == device).cloned();

        if let Some(ref v) = target_vol {
            if v.mount_point == "/" || v.mount_point.starts_with("/boot") {
                return Err("Safety Protection: Cannot format root (/) or boot partition.".to_string());
            }
        }

        // 1. Unmount if currently mounted
        let _ = Command::new("udisksctl")
            .args(["unmount", "--no-user-interaction", "-b", &device])
            .output();

        // 2. Validate password or use cached password
        let effective_password = match password {
            Some(p) if !p.is_empty() => p,
            _ => {
                if is_root_session() {
                    String::new()
                } else if let Some(cached) = get_cached_sudo_password() {
                    cached
                } else {
                    return Err("AUTH_REQUIRED".to_string());
                }
            }
        };

        validate_sudo_password(&effective_password)?;

        // Ensure unmounted with sudo if still mounted
        let _ = run_sudo_command(&effective_password, &["umount", "-f", &device]);

        // 3. Prepare clean label
        let clean_label: String = label
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        let final_label = if clean_label.is_empty() {
            "UNTITLED".to_string()
        } else {
            clean_label
        };

        // 4. Construct format command based on fstype
        let fs_lower = fstype.to_lowercase();
        match fs_lower.as_str() {
            "vfat" | "fat32" | "fat" => {
                let short_label = if final_label.len() > 11 {
                    &final_label[..11]
                } else {
                    &final_label
                };
                let short_label_upper = short_label.to_uppercase();
                run_sudo_command(
                    &effective_password,
                    &["mkfs.vfat", "-F", "32", "-n", &short_label_upper, &device],
                )?;
            }
            "exfat" => {
                if !tool_exists("mkfs.exfat") {
                    return Err("mkfs.exfat is not installed. Please format as FAT32 or install exfatprogs.".to_string());
                }
                run_sudo_command(
                    &effective_password,
                    &["mkfs.exfat", "-n", &final_label, &device],
                )?;
            }
            "ext4" => {
                run_sudo_command(
                    &effective_password,
                    &["mkfs.ext4", "-F", "-L", &final_label, &device],
                )?;
            }
            "btrfs" => {
                run_sudo_command(
                    &effective_password,
                    &["mkfs.btrfs", "-f", "-L", &final_label, &device],
                )?;
            }
            "ntfs" => {
                let tool = if tool_exists("mkfs.ntfs") {
                    "mkfs.ntfs"
                } else if tool_exists("mkntfs") {
                    "mkntfs"
                } else {
                    return Err("mkfs.ntfs is not installed. Please format as FAT32 or install ntfsprogs.".to_string());
                };
                run_sudo_command(
                    &effective_password,
                    &[tool, "-f", "-L", &final_label, &device],
                )?;
            }
            other => {
                return Err(format!("Unsupported filesystem type: {}", other));
            }
        }

        // 5. Sync kernel buffer
        let _ = Command::new("sync").output();

        // 6. Try to re-mount using udisksctl
        let _ = Command::new("udisksctl")
            .args(["mount", "--no-user-interaction", "-b", &device])
            .output();

        invalidate_volumes_cache();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_partition(
    device: String,
    password: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let partitions = list_system_partitions();
        let target_vol = partitions.iter().find(|v| v.device == device).cloned();

        let fstype = target_vol
            .as_ref()
            .map(|v| v.file_system.to_lowercase())
            .unwrap_or_else(|| "unknown".to_string());

        let effective_password = match password {
            Some(p) if !p.is_empty() => p,
            _ => {
                if is_root_session() {
                    String::new()
                } else if let Some(cached) = get_cached_sudo_password() {
                    cached
                } else {
                    return Err("AUTH_REQUIRED".to_string());
                }
            }
        };

        validate_sudo_password(&effective_password)?;

        // Run non-destructive inspection
        let (prog, args): (&str, Vec<&str>) = match fstype.as_str() {
            "vfat" | "fat" | "fat32" => {
                if tool_exists("fsck.vfat") {
                    ("fsck.vfat", vec!["-V", "-n", &device])
                } else if tool_exists("dosfsck") {
                    ("dosfsck", vec!["-v", "-n", &device])
                } else {
                    ("fsck", vec!["-n", &device])
                }
            }
            "ext4" | "ext3" | "ext2" => ("e2fsck", vec!["-n", "-v", &device]),
            "btrfs" => ("btrfs", vec!["check", "--readonly", &device]),
            _ => ("fsck", vec!["-n", &device]),
        };

        use std::io::Write;
        use std::process::Stdio;

        let output = if is_root_session() {
            Command::new(prog)
                .env("LC_ALL", "C")
                .args(&args)
                .output()
                .map_err(|e| format!("Failed to run check tool {}: {}", prog, e))?
        } else {
            let mut child = Command::new("sudo")
                .env("LC_ALL", "C")
                .arg("-S")
                .arg("-p")
                .arg("")
                .arg(prog)
                .args(&args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to run check tool {}: {}", prog, e))?;

            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(format!("{}\n", effective_password).as_bytes());
            }

            child
                .wait_with_output()
                .map_err(|e| format!("Failed waiting for check tool: {}", e))?
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let clean_stderr: String = stderr
            .lines()
            .filter(|l| !l.contains("[sudo] password"))
            .collect::<Vec<_>>()
            .join("\n");

        let mut report = String::new();
        if !stdout.trim().is_empty() {
            report.push_str(stdout.trim());
        }
        if !clean_stderr.trim().is_empty() {
            if !report.is_empty() {
                report.push_str("\n\n");
            }
            report.push_str(clean_stderr.trim());
        }

        if report.trim().is_empty() {
            report = format!("First Aid check completed on {}. Filesystem appears clean.", device);
        }

        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn get_tags_file_path() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    config_dir.join("finder-tags.json")
}

pub fn load_tags_map() -> HashMap<String, Vec<String>> {
    let mutex = TAGS_CACHE.get_or_init(|| {
        let path = get_tags_file_path();
        let initial = fs::read_to_string(path)
            .ok()
            .and_then(|c| serde_json::from_str::<HashMap<String, Vec<String>>>(&c).ok())
            .unwrap_or_default();
        Mutex::new(initial)
    });
    mutex.lock().map(|g| g.clone()).unwrap_or_default()
}

pub fn save_tags_map(map: &HashMap<String, Vec<String>>) -> Result<(), String> {
    if let Some(mutex) = TAGS_CACHE.get() {
        if let Ok(mut guard) = mutex.lock() {
            *guard = map.clone();
        }
    }
    bump_cache_version();
    let path = get_tags_file_path();
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn get_open_with_file_path() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    config_dir.join("finder-open-with.json")
}

pub fn load_open_with_config() -> OpenWithConfig {
    let mutex = OPEN_WITH_CACHE.get_or_init(|| {
        let path = get_open_with_file_path();
        let initial = fs::read_to_string(path)
            .ok()
            .and_then(|c| serde_json::from_str::<OpenWithConfig>(&c).ok())
            .unwrap_or_default();
        Mutex::new(initial)
    });
    mutex.lock().map(|g| g.clone()).unwrap_or_default()
}

pub fn save_open_with_config(cfg: &OpenWithConfig) -> Result<(), String> {
    if let Some(mutex) = OPEN_WITH_CACHE.get() {
        if let Ok(mut guard) = mutex.lock() {
            *guard = cfg.clone();
        }
    }
    bump_cache_version();
    let path = get_open_with_file_path();
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn resolve_default_app(path_str: &str, ext: &str, cfg: &OpenWithConfig) -> Option<String> {
    if !ext.is_empty() {
        if let Some(prog) = cfg.by_extension.get(ext) {
            let trimmed = prog.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    if let Some(prog) = cfg.by_path.get(path_str) {
        let trimmed = prog.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

pub fn sanitize_appimage_env(cmd: &mut Command) {
    if std::env::var_os("APPDIR").is_some() || std::env::var_os("APPIMAGE").is_some() {
        cmd.env_remove("APPDIR");
        cmd.env_remove("APPIMAGE");
        cmd.env_remove("ARGV0");
        cmd.env_remove("OWD");

        if let Ok(orig_ld) = std::env::var("LD_LIBRARY_PATH_ORIG") {
            if orig_ld.trim().is_empty() {
                cmd.env_remove("LD_LIBRARY_PATH");
            } else {
                cmd.env("LD_LIBRARY_PATH", orig_ld);
            }
            cmd.env_remove("LD_LIBRARY_PATH_ORIG");
        } else if let Ok(ld) = std::env::var("LD_LIBRARY_PATH") {
            let appdir = std::env::var("APPDIR").unwrap_or_default();
            if !appdir.is_empty() {
                let filtered: Vec<&str> = ld
                    .split(':')
                    .filter(|p| !p.starts_with(&appdir) && !p.is_empty())
                    .collect();
                if filtered.is_empty() {
                    cmd.env_remove("LD_LIBRARY_PATH");
                } else {
                    cmd.env("LD_LIBRARY_PATH", filtered.join(":"));
                }
            }
        }

        if let Ok(reg) = std::env::var("GST_REGISTRY_1_0") {
            if reg.contains("vfinder-appimage-gst-registry") {
                cmd.env_remove("GST_REGISTRY_1_0");
                cmd.env_remove("GST_REGISTRY");
            }
        }
        cmd.env_remove("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS");
        cmd.env_remove("WEBKIT_DISABLE_DMABUF_RENDERER");
    }
}

pub fn launch_with_program(path: &str, program: &str) -> Result<(), String> {
    use std::process::Stdio;

    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err("Program name cannot be empty".to_string());
    }

    let tokens: Vec<String> = trimmed
        .split_whitespace()
        .map(|s| s.trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if tokens.is_empty() {
        return Err("Invalid program command".to_string());
    }

    let bin = &tokens[0];
    let mut args: Vec<String> = Vec::new();
    let mut placeholder_replaced = false;

    for token in &tokens[1..] {
        if token == "%f" || token == "{}" {
            args.push(path.to_string());
            placeholder_replaced = true;
        } else {
            args.push(token.clone());
        }
    }

    if !placeholder_replaced {
        args.push(path.to_string());
    }

    let mut cmd = Command::new(bin);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(parent) = Path::new(path).parent() {
        cmd.current_dir(parent);
    }
    sanitize_appimage_env(&mut cmd);
    let spawn_result = cmd.spawn();

    match spawn_result {
        Ok(_) => Ok(()),
        Err(err) => {
            let lower_bin = bin.to_lowercase();
            if lower_bin != *bin {
                let mut lower_cmd = Command::new(&lower_bin);
                lower_cmd
                    .args(&args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let Some(parent) = Path::new(path).parent() {
                    lower_cmd.current_dir(parent);
                }
                sanitize_appimage_env(&mut lower_cmd);
                if lower_cmd.spawn().is_ok() {
                    return Ok(());
                }
            }
            Err(format!("Failed to launch '{}': {}", bin, err))
        }
    }
}

fn format_unix_permissions(mode: u32, is_dir: bool) -> String {
    let mut s = String::with_capacity(10);
    s.push(if is_dir { 'd' } else { '-' });
    let flags = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (bit, ch) in flags {
        s.push(if mode & bit != 0 { ch } else { '-' });
    }
    s
}

fn describe_kind(is_dir: bool, ext: &str, mime: &str) -> String {
    if is_dir {
        return "Folder".to_string();
    }
    match ext {
        "rs" => "Rust Source".to_string(),
        "ts" | "tsx" => "TypeScript Source".to_string(),
        "js" | "jsx" => "JavaScript Source".to_string(),
        "py" => "Python Script".to_string(),
        "sh" | "bash" | "zsh" => "Shell Script".to_string(),
        "command" => "Terminal Command Script".to_string(),
        "appimage" => "AppImage Application".to_string(),
        "desktop" => "Desktop Application Shortcut".to_string(),
        "bin" | "run" => "Executable Binary".to_string(),
        "json" => "JSON Document".to_string(),
        "md" | "markdown" => "Markdown Document".to_string(),
        "toml" | "yaml" | "yml" | "ini" | "conf" => "Configuration File".to_string(),
        "html" | "htm" => "HTML Document".to_string(),
        "css" | "scss" => "Stylesheet".to_string(),
        "png" => "PNG Image".to_string(),
        "jpg" | "jpeg" => "JPEG Image".to_string(),
        "gif" => "GIF Image".to_string(),
        "webp" => "WebP Image".to_string(),
        "svg" => "SVG Vector Image".to_string(),
        "pdf" => "PDF Document".to_string(),
        "mp3" | "wav" | "flac" | "ogg" | "m4a" => "Audio File".to_string(),
        "mp4" | "mkv" | "webm" | "mov" => "Movie".to_string(),
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "tbz" | "tbz2" | "xz" | "txz"
        | "zst" | "tzst" | "7z" | "rar" => "Archive".to_string(),
        "txt" | "log" => "Plain Text Document".to_string(),
        _ => {
            if mime.starts_with("image/") {
                "Image".to_string()
            } else if mime.starts_with("text/") {
                "Text Document".to_string()
            } else if mime.starts_with("audio/") {
                "Audio".to_string()
            } else if mime.starts_with("video/") {
                "Video".to_string()
            } else if !ext.is_empty() {
                format!("{} Document", ext.to_uppercase())
            } else {
                "Unix Executable / Data".to_string()
            }
        }
    }
}

#[inline]
fn fast_mime_type(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" | "tgz" => "application/gzip",
        "bz2" | "tbz" | "tbz2" => "application/x-bzip2",
        "xz" | "txz" => "application/x-xz",
        "zst" | "tzst" => "application/zstd",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        "js" | "mjs" => "text/javascript",
        "ts" => "text/typescript",
        "tsx" => "text/typescript-jsx",
        "jsx" => "text/javascript-jsx",
        "rs" => "text/rust",
        "py" => "text/x-python",
        "sh" | "bash" | "zsh" => "text/x-shellscript",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "scss" | "sass" => "text/x-scss",
        "md" | "markdown" => "text/markdown",
        "toml" => "text/x-toml",
        "yaml" | "yml" => "text/yaml",
        "xml" => "text/xml",
        "csv" => "text/csv",
        _ => "",
    }
}

pub fn build_file_entry(
    path: &Path,
    tags_map: &HashMap<String, Vec<String>>,
    compute_child_count: bool,
) -> Option<FileEntry> {
    let open_cfg = load_open_with_config();
    build_file_entry_with_cfg(path, tags_map, &open_cfg, compute_child_count)
}

pub fn build_file_entry_with_cfg(
    path: &Path,
    tags_map: &HashMap<String, Vec<String>>,
    open_cfg: &OpenWithConfig,
    compute_child_count: bool,
) -> Option<FileEntry> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    let symlink_meta = fs::symlink_metadata(path).ok()?;
    let is_symlink = symlink_meta.file_type().is_symlink();
    let meta = if is_symlink {
        fs::metadata(path).unwrap_or(symlink_meta)
    } else {
        symlink_meta
    };

    let is_dir = meta.is_dir();
    let is_hidden = name.starts_with('.');
    let size = if is_dir { 0 } else { meta.len() };

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified);

    let extension = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };

    let mime_type = if is_dir {
        "inode/directory".to_string()
    } else {
        let fast = fast_mime_type(&extension);
        if !fast.is_empty() {
            fast.to_string()
        } else {
            mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string()
        }
    };

    let kind = describe_kind(is_dir, &extension, &mime_type);
    let mode = meta.permissions().mode();
    let permissions = format_unix_permissions(mode, is_dir);
    let is_readonly = meta.permissions().readonly();

    let child_count = if compute_child_count && is_dir {
        fs::read_dir(path)
            .ok()
            .map(|entries| entries.take(10_000).filter_map(|e| e.ok()).count())
    } else {
        None
    };

    let path_str = path.to_string_lossy().to_string();
    let tags = tags_map.get(&path_str).cloned().unwrap_or_default();
    let default_app = if is_dir {
        None
    } else {
        resolve_default_app(&path_str, &extension, open_cfg)
    };
    let (original_path, deleted_at) = resolve_trash_metadata_for_path(path);
    let is_executable = !is_dir
        && ((mode & 0o111 != 0)
            || extension == "appimage"
            || extension == "desktop"
            || extension == "bin"
            || extension == "run");

    Some(FileEntry {
        name,
        path: path_str,
        is_dir,
        is_symlink,
        is_hidden,
        size,
        modified: deleted_at.unwrap_or(modified),
        created,
        extension,
        kind,
        mime_type,
        permissions,
        is_readonly,
        child_count,
        tags,
        default_app,
        original_path,
        deleted_at,
        is_executable,
    })
}

pub fn build_file_entry_from_dir_entry(
    item: &fs::DirEntry,
    tags_map: &HashMap<String, Vec<String>>,
    open_cfg: &OpenWithConfig,
) -> Option<FileEntry> {
    let file_name = item.file_name();
    let name = file_name.to_string_lossy().to_string();
    let path = item.path();

    // Use d_type from DirEntry on Linux without extra stat syscall
    let ft = item.file_type().ok()?;
    let is_symlink = ft.is_symlink();

    let meta = if is_symlink {
        fs::metadata(&path).or_else(|_| item.metadata()).ok()?
    } else {
        item.metadata().ok()?
    };

    let is_dir = meta.is_dir();
    let is_hidden = name.starts_with('.');
    let size = if is_dir { 0 } else { meta.len() };

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified);

    let extension = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };

    let mime_type = if is_dir {
        "inode/directory".to_string()
    } else {
        let fast = fast_mime_type(&extension);
        if !fast.is_empty() {
            fast.to_string()
        } else {
            mime_guess::from_path(&path)
                .first_or_octet_stream()
                .to_string()
        }
    };

    let kind = describe_kind(is_dir, &extension, &mime_type);
    let mode = meta.permissions().mode();
    let permissions = format_unix_permissions(mode, is_dir);
    let is_readonly = meta.permissions().readonly();
    let child_count = None;

    let path_str = path.to_string_lossy().to_string();
    let tags = tags_map.get(&path_str).cloned().unwrap_or_default();
    let default_app = if is_dir {
        None
    } else {
        resolve_default_app(&path_str, &extension, open_cfg)
    };
    let (original_path, deleted_at) = resolve_trash_metadata_for_path(&path);
    let is_executable = !is_dir
        && ((mode & 0o111 != 0)
            || extension == "appimage"
            || extension == "desktop"
            || extension == "bin"
            || extension == "run");

    Some(FileEntry {
        name,
        path: path_str,
        is_dir,
        is_symlink,
        is_hidden,
        size,
        modified: deleted_at.unwrap_or(modified),
        created,
        extension,
        kind,
        mime_type,
        permissions,
        is_readonly,
        child_count,
        tags,
        default_app,
        original_path,
        deleted_at,
        is_executable,
    })
}

fn resolve_input_path(path: &str) -> PathBuf {
    let home = effective_user_home_dir();
    if path.is_empty() || path == "~" {
        home
    } else if path == "/" {
        PathBuf::from("/")
    } else {
        let clean = path.trim_end_matches('/');
        if let Some(stripped) = clean.strip_prefix("~/") {
            home.join(stripped)
        } else {
            PathBuf::from(clean)
        }
    }
}

pub fn is_archive_filename(name: &str) -> bool {
    let lower_name = name.to_lowercase();
    let suffixes = [
        ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lzma", ".tgz", ".tbz2", ".tbz", ".txz",
        ".tzst", ".tar", ".zip",
    ];
    suffixes.iter().any(|s| lower_name.ends_with(s))
}

pub fn split_archive_path(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let clean_str = path.to_string_lossy();
    let clean_trimmed = if clean_str.len() > 1 {
        clean_str.trim_end_matches('/')
    } else {
        &clean_str
    };
    let path_buf = PathBuf::from(clean_trimmed);
    let path = path_buf.as_path();

    if path.is_file() {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if is_archive_filename(name) {
                return Some((path.to_path_buf(), PathBuf::new()));
            }
        }
    }

    let mut current = path.parent();
    while let Some(ancestor) = current {
        if ancestor.is_file() {
            if let Some(name) = ancestor.file_name().and_then(|n| n.to_str()) {
                if is_archive_filename(name) {
                    if let Ok(rel) = path.strip_prefix(ancestor) {
                        return Some((ancestor.to_path_buf(), rel.to_path_buf()));
                    }
                }
            }
        }
        current = ancestor.parent();
    }
    None
}

fn normalize_entry_path(raw: &str) -> String {
    let mut s = raw.replace('\\', "/");
    while s.starts_with("./") {
        s = s[2..].to_string();
    }
    while s.starts_with('/') {
        s = s[1..].to_string();
    }
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    s
}

fn zip_datetime_to_unix(dt: Option<zip::DateTime>, fallback: i64) -> i64 {
    if let Some(dt) = dt {
        chrono::NaiveDate::from_ymd_opt(dt.year() as i32, dt.month() as u32, dt.day() as u32)
            .and_then(|d| d.and_hms_opt(dt.hour() as u32, dt.minute() as u32, dt.second() as u32))
            .map(|naive| naive.and_utc().timestamp())
            .unwrap_or(fallback)
    } else {
        fallback
    }
}

#[derive(Clone, Debug)]
pub struct ArchiveEntryInfo {
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: i64,
    pub mode: u32,
}

static ARCHIVE_ENTRIES_CACHE: OnceLock<Mutex<HashMap<(PathBuf, u128), Arc<Vec<ArchiveEntryInfo>>>>> =
    OnceLock::new();

fn get_archive_entries(archive_path: &Path) -> Result<Arc<Vec<ArchiveEntryInfo>>, String> {
    let mtime = path_mtime_ns(archive_path);
    let cache_mutex = ARCHIVE_ENTRIES_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if mtime > 0 {
        if let Ok(guard) = cache_mutex.lock() {
            if let Some(cached) = guard.get(&(archive_path.to_path_buf(), mtime)) {
                return Ok(Arc::clone(cached));
            }
        }
    }

    let archive_name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();

    let fallback_mtime = fs::metadata(archive_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut entries = Vec::new();

    if archive_name.ends_with(".zip") {
        let file = fs::File::open(archive_path)
            .map_err(|e| format!("Could not open ZIP archive: {e}"))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("Could not read ZIP archive: {e}"))?;

        for i in 0..archive.len() {
            let entry = archive
                .by_index(i)
                .map_err(|e| format!("Could not read ZIP entry: {e}"))?;
            let raw_name = entry.name();
            let norm = normalize_entry_path(raw_name);
            let is_dir = entry.is_dir() || norm.ends_with('/') || raw_name.ends_with('/');
            let clean_path = norm.trim_end_matches('/').to_string();
            if clean_path.is_empty() {
                continue;
            }
            let is_symlink = entry
                .unix_mode()
                .map(|mode| mode & 0o170000 == 0o120000)
                .unwrap_or(false);
            let mode = entry.unix_mode().unwrap_or(if is_dir { 0o755 } else { 0o644 });
            let modified = zip_datetime_to_unix(entry.last_modified(), fallback_mtime);

            entries.push(ArchiveEntryInfo {
                relative_path: clean_path,
                is_dir,
                is_symlink,
                size: if is_dir { 0 } else { entry.size() },
                modified,
                mode,
            });
        }
    } else {
        let reader = open_tarball_reader(archive_path)?;
        let mut archive = tar::Archive::new(reader);
        let tar_entries = archive
            .entries()
            .map_err(|e| format!("Could not read TAR archive: {e}"))?;

        for entry_res in tar_entries {
            let entry = entry_res.map_err(|e| format!("Could not read TAR entry: {e}"))?;
            let raw_path = entry
                .path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let norm = normalize_entry_path(&raw_path);
            let entry_type = entry.header().entry_type();
            let is_dir = entry_type.is_dir() || norm.ends_with('/') || raw_path.ends_with('/');
            let clean_path = norm.trim_end_matches('/').to_string();
            if clean_path.is_empty() {
                continue;
            }
            let is_symlink = entry_type.is_symlink();
            let size = if is_dir {
                0
            } else {
                entry.header().size().unwrap_or(0)
            };
            let modified = entry.header().mtime().unwrap_or(fallback_mtime as u64) as i64;
            let mode = entry
                .header()
                .mode()
                .unwrap_or(if is_dir { 0o755 } else { 0o644 });

            entries.push(ArchiveEntryInfo {
                relative_path: clean_path,
                is_dir,
                is_symlink,
                size,
                modified,
                mode,
            });
        }
    }

    let arc = Arc::new(entries);
    if mtime > 0 {
        if let Ok(mut guard) = cache_mutex.lock() {
            guard.insert((archive_path.to_path_buf(), mtime), Arc::clone(&arc));
        }
    }
    Ok(arc)
}

fn read_archive_directory_sync(
    archive_path: &Path,
    subpath: &Path,
    show_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    let all_entries = get_archive_entries(archive_path)?;
    let target_str = normalize_entry_path(&subpath.to_string_lossy());
    let target_norm = target_str.trim_matches('/').to_string();

    struct ChildCollector {
        is_dir: bool,
        is_symlink: bool,
        size: u64,
        modified: i64,
        mode: u32,
    }

    let mut direct_children: HashMap<String, ChildCollector> = HashMap::new();

    for entry in all_entries.iter() {
        let rel = entry.relative_path.as_str();

        if target_norm.is_empty() {
            if let Some((first_comp, _)) = rel.split_once('/') {
                let existing = direct_children
                    .entry(first_comp.to_string())
                    .or_insert_with(|| ChildCollector {
                        is_dir: true,
                        is_symlink: false,
                        size: 0,
                        modified: entry.modified,
                        mode: 0o755,
                    });
                existing.is_dir = true;
                if entry.modified > existing.modified {
                    existing.modified = entry.modified;
                }
            } else {
                let existing = direct_children
                    .entry(rel.to_string())
                    .or_insert_with(|| ChildCollector {
                        is_dir: entry.is_dir,
                        is_symlink: entry.is_symlink,
                        size: entry.size,
                        modified: entry.modified,
                        mode: entry.mode,
                    });
                if entry.is_dir {
                    existing.is_dir = true;
                } else if !existing.is_dir {
                    existing.size = entry.size;
                    existing.is_symlink = entry.is_symlink;
                    existing.mode = entry.mode;
                }
                if entry.modified > existing.modified {
                    existing.modified = entry.modified;
                }
            }
        } else {
            let prefix = format!("{target_norm}/");
            if let Some(rest) = rel.strip_prefix(&prefix) {
                if rest.is_empty() {
                    continue;
                }
                if let Some((first_comp, _)) = rest.split_once('/') {
                    let existing = direct_children
                        .entry(first_comp.to_string())
                        .or_insert_with(|| ChildCollector {
                            is_dir: true,
                            is_symlink: false,
                            size: 0,
                            modified: entry.modified,
                            mode: 0o755,
                        });
                    existing.is_dir = true;
                    if entry.modified > existing.modified {
                        existing.modified = entry.modified;
                    }
                } else {
                    let existing = direct_children
                        .entry(rest.to_string())
                        .or_insert_with(|| ChildCollector {
                            is_dir: entry.is_dir,
                            is_symlink: entry.is_symlink,
                            size: entry.size,
                            modified: entry.modified,
                            mode: entry.mode,
                        });
                    if entry.is_dir {
                        existing.is_dir = true;
                    } else if !existing.is_dir {
                        existing.size = entry.size;
                        existing.is_symlink = entry.is_symlink;
                        existing.mode = entry.mode;
                    }
                    if entry.modified > existing.modified {
                        existing.modified = entry.modified;
                    }
                }
            }
        }
    }

    let mut result = Vec::with_capacity(direct_children.len());

    for (child_name, child) in direct_children {
        if !show_hidden && child_name.starts_with('.') {
            continue;
        }

        let child_virtual_path = if target_norm.is_empty() {
            format!("{}/{}", archive_path.to_string_lossy(), child_name)
        } else {
            format!(
                "{}/{}/{}",
                archive_path.to_string_lossy(),
                target_norm,
                child_name
            )
        };

        let extension = if child.is_dir {
            String::new()
        } else {
            Path::new(&child_name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };

        let mime_type = if child.is_dir {
            "inode/directory".to_string()
        } else {
            let fast = fast_mime_type(&extension);
            if !fast.is_empty() {
                fast.to_string()
            } else {
                mime_guess::from_path(&child_name)
                    .first_or_octet_stream()
                    .to_string()
            }
        };

        let kind = describe_kind(child.is_dir, &extension, &mime_type);
        let permissions = format_unix_permissions(child.mode, child.is_dir);

        let child_count = if child.is_dir {
            let dir_prefix = if target_norm.is_empty() {
                format!("{child_name}/")
            } else {
                format!("{target_norm}/{child_name}/")
            };
            let mut immediate_sub = std::collections::HashSet::new();
            for entry in all_entries.iter() {
                if let Some(sub_rest) = entry.relative_path.strip_prefix(&dir_prefix) {
                    if !sub_rest.is_empty() {
                        let sub_comp = sub_rest.split('/').next().unwrap_or("");
                        if !sub_comp.is_empty() {
                            immediate_sub.insert(sub_comp.to_string());
                        }
                    }
                }
            }
            Some(immediate_sub.len())
        } else {
            None
        };

        result.push(FileEntry {
            name: child_name,
            path: child_virtual_path,
            is_dir: child.is_dir,
            is_symlink: child.is_symlink,
            is_hidden: false,
            size: child.size,
            modified: child.modified,
            created: child.modified,
            extension,
            kind,
            mime_type,
            permissions,
            is_readonly: true,
            child_count,
            tags: Vec::new(),
            default_app: None,
            original_path: None,
            deleted_at: None,
            is_executable: !child.is_dir && (child.mode & 0o111 != 0),
        });
    }

    Ok(result)
}

fn search_archive_sync(
    archive_path: &Path,
    subpath: &Path,
    query: &str,
    show_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    let all_entries = get_archive_entries(archive_path)?;
    let target_str = normalize_entry_path(&subpath.to_string_lossy());
    let target_norm = target_str.trim_matches('/').to_string();
    let q = query.to_lowercase();

    let mut result = Vec::new();

    for entry in all_entries.iter() {
        let rel = entry.relative_path.as_str();

        if !target_norm.is_empty() {
            let prefix = format!("{target_norm}/");
            if !rel.starts_with(&prefix) {
                continue;
            }
        }

        let name = rel.rsplit('/').next().unwrap_or(rel);
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        if !name.to_lowercase().contains(&q) {
            continue;
        }

        let child_virtual_path = format!("{}/{}", archive_path.to_string_lossy(), rel);
        let extension = if entry.is_dir {
            String::new()
        } else {
            Path::new(name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        let mime_type = if entry.is_dir {
            "inode/directory".to_string()
        } else {
            let fast = fast_mime_type(&extension);
            if !fast.is_empty() {
                fast.to_string()
            } else {
                mime_guess::from_path(name)
                    .first_or_octet_stream()
                    .to_string()
            }
        };
        let kind = describe_kind(entry.is_dir, &extension, &mime_type);
        let permissions = format_unix_permissions(entry.mode, entry.is_dir);

        result.push(FileEntry {
            name: name.to_string(),
            path: child_virtual_path,
            is_dir: entry.is_dir,
            is_symlink: entry.is_symlink,
            is_hidden: name.starts_with('.'),
            size: entry.size,
            modified: entry.modified,
            created: entry.modified,
            extension,
            kind,
            mime_type,
            permissions,
            is_readonly: true,
            child_count: None,
            tags: Vec::new(),
            default_app: None,
            original_path: None,
            deleted_at: None,
            is_executable: !entry.is_dir && (entry.mode & 0o111 != 0),
        });
    }

    Ok(result)
}

fn extract_single_archive_entry_to_cache(
    archive_path: &Path,
    subpath: &Path,
) -> Result<PathBuf, String> {
    use md5::Digest;
    let subpath_norm = normalize_entry_path(&subpath.to_string_lossy());
    let clean_subpath = subpath_norm.trim_matches('/');
    if clean_subpath.is_empty() {
        return Err("Cannot extract empty subpath".to_string());
    }

    let mtime = path_mtime_ns(archive_path);
    let hash_str: String = md5::Md5::digest(archive_path.to_string_lossy().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let cache_dir = std::env::temp_dir()
        .join("vfinder_archive_cache")
        .join(format!("{hash_str}_{mtime}"));

    let dest_path = cache_dir.join(clean_subpath);

    if dest_path.is_file() {
        if let Ok(meta) = fs::metadata(&dest_path) {
            if meta.len() > 0 {
                return Ok(dest_path);
            }
        }
    }

    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create cache directory: {e}"))?;
    }

    let archive_name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();

    if archive_name.ends_with(".zip") {
        let file = fs::File::open(archive_path)
            .map_err(|e| format!("Could not open ZIP archive: {e}"))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("Could not read ZIP archive: {e}"))?;

        let target_idx = archive
            .index_for_name(clean_subpath)
            .or_else(|| archive.index_for_name(&format!("./{clean_subpath}")))
            .ok_or_else(|| format!("Could not find file '{clean_subpath}' in ZIP archive"))?;

        let mut entry = archive
            .by_index(target_idx)
            .map_err(|e| format!("Could not read ZIP entry: {e}"))?;

        let mut out = fs::File::create(&dest_path)
            .map_err(|e| format!("Could not create cache file: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("Could not extract file from ZIP: {e}"))?;
    } else {
        let reader = open_tarball_reader(archive_path)?;
        let mut archive = tar::Archive::new(reader);
        let entries = archive
            .entries()
            .map_err(|e| format!("Could not read TAR archive: {e}"))?;

        let mut found = false;
        for entry_res in entries {
            let mut entry = entry_res.map_err(|e| format!("Could not read TAR entry: {e}"))?;
            let raw_p = entry
                .path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let norm = normalize_entry_path(&raw_p);
            let check_p = norm.trim_matches('/');
            if check_p == clean_subpath {
                let mut out = fs::File::create(&dest_path)
                    .map_err(|e| format!("Could not create cache file: {e}"))?;
                std::io::copy(&mut entry, &mut out)
                    .map_err(|e| format!("Could not extract file from TAR: {e}"))?;
                found = true;
                break;
            }
        }
        if !found {
            return Err(format!("Entry {clean_subpath} not found in TAR archive"));
        }
    }

    Ok(dest_path)
}

fn extract_archive_entry_or_dir(
    archive_path: &Path,
    clean_item: &str,
    target_dir: &Path,
) -> Result<(), String> {
    let archive_name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();

    let prefix_match = format!("{clean_item}/");

    if archive_name.ends_with(".zip") {
        let file = fs::File::open(archive_path)
            .map_err(|e| format!("Could not open ZIP archive: {e}"))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("Could not read ZIP archive: {e}"))?;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Could not read ZIP entry: {e}"))?;
            let enclosed = match entry.enclosed_name() {
                Some(name) => name.to_path_buf(),
                None => continue,
            };
            let norm_enclosed = normalize_entry_path(&enclosed.to_string_lossy());
            let clean_enclosed = norm_enclosed.trim_matches('/').to_string();

            let is_match =
                clean_enclosed == clean_item || clean_enclosed.starts_with(&prefix_match);
            if !is_match {
                continue;
            }

            let rel_sub = if clean_enclosed == clean_item {
                PathBuf::from(clean_item.rsplit('/').next().unwrap_or(clean_item))
            } else if let Some(sub) = clean_enclosed.strip_prefix(&prefix_match) {
                let base_name = clean_item.rsplit('/').next().unwrap_or(clean_item);
                PathBuf::from(base_name).join(sub)
            } else {
                PathBuf::from(clean_enclosed)
            };

            let dest = target_dir.join(rel_sub);
            if entry.is_dir() {
                fs::create_dir_all(&dest)
                    .map_err(|e| format!("Could not create directory: {e}"))?;
                continue;
            }

            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Could not create directory: {e}"))?;
            }
            let mut out = fs::File::create(&dest)
                .map_err(|e| format!("Could not create file: {e}"))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("Could not extract file: {e}"))?;
        }
    } else {
        let reader = open_tarball_reader(archive_path)?;
        let mut archive = tar::Archive::new(reader);
        let entries = archive
            .entries()
            .map_err(|e| format!("Could not read TAR archive: {e}"))?;

        for entry_res in entries {
            let mut entry = entry_res.map_err(|e| format!("Could not read TAR entry: {e}"))?;
            let raw_path = entry
                .path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let norm = normalize_entry_path(&raw_path);
            let clean_enclosed = norm.trim_matches('/').to_string();

            let is_match =
                clean_enclosed == clean_item || clean_enclosed.starts_with(&prefix_match);
            if !is_match {
                continue;
            }

            let rel_sub = if clean_enclosed == clean_item {
                PathBuf::from(clean_item.rsplit('/').next().unwrap_or(clean_item))
            } else if let Some(sub) = clean_enclosed.strip_prefix(&prefix_match) {
                let base_name = clean_item.rsplit('/').next().unwrap_or(clean_item);
                PathBuf::from(base_name).join(sub)
            } else {
                PathBuf::from(clean_enclosed)
            };

            let dest = target_dir.join(rel_sub);
            if entry.header().entry_type().is_dir() {
                fs::create_dir_all(&dest)
                    .map_err(|e| format!("Could not create directory: {e}"))?;
                continue;
            }

            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Could not create directory: {e}"))?;
            }
            let mut out = fs::File::create(&dest)
                .map_err(|e| format!("Could not create file: {e}"))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("Could not extract file: {e}"))?;
        }
    }

    Ok(())
}

fn get_archive_entry_file_entry(
    archive_path: &Path,
    subpath: &Path,
) -> Result<FileEntry, String> {
    let all_entries = get_archive_entries(archive_path)?;
    let subpath_norm = normalize_entry_path(&subpath.to_string_lossy());
    let clean_subpath = subpath_norm.trim_matches('/').to_string();

    for entry in all_entries.iter() {
        if entry.relative_path == clean_subpath {
            let name = clean_subpath
                .rsplit('/')
                .next()
                .unwrap_or(&clean_subpath)
                .to_string();
            let child_virtual_path =
                format!("{}/{}", archive_path.to_string_lossy(), clean_subpath);
            let extension = if entry.is_dir {
                String::new()
            } else {
                Path::new(&name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
            };
            let mime_type = if entry.is_dir {
                "inode/directory".to_string()
            } else {
                let fast = fast_mime_type(&extension);
                if !fast.is_empty() {
                    fast.to_string()
                } else {
                    mime_guess::from_path(&name)
                        .first_or_octet_stream()
                        .to_string()
                }
            };
            let kind = describe_kind(entry.is_dir, &extension, &mime_type);
            let permissions = format_unix_permissions(entry.mode, entry.is_dir);

            return Ok(FileEntry {
                name,
                path: child_virtual_path,
                is_dir: entry.is_dir,
                is_symlink: entry.is_symlink,
                is_hidden: false,
                size: entry.size,
                modified: entry.modified,
                created: entry.modified,
                extension,
                kind,
                mime_type,
                permissions,
                is_readonly: true,
                child_count: None,
                tags: Vec::new(),
                default_app: None,
                original_path: None,
                deleted_at: None,
                is_executable: !entry.is_dir && (entry.mode & 0o111 != 0),
            });
        }
    }

    Err(format!("Entry {clean_subpath} not found in archive"))
}

#[tauri::command]
pub async fn extract_archive_items(
    archive_path: String,
    items: Vec<String>,
    destination_dir: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let arch = resolve_input_path(&archive_path);
        let actual_archive = if let Some((parent_arch, _)) = split_archive_path(&arch) {
            parent_arch
        } else {
            arch
        };
        if !actual_archive.is_file() {
            return Err("Archive file does not exist".to_string());
        }
        let target_dir = if let Some(dest) = destination_dir {
            resolve_input_path(&dest)
        } else {
            actual_archive
                .parent()
                .ok_or_else(|| "Cannot determine archive parent".to_string())?
                .to_path_buf()
        };

        if !target_dir.is_dir() {
            fs::create_dir_all(&target_dir)
                .map_err(|e| format!("Could not create destination directory: {e}"))?;
        }

        for item_rel in items {
            let norm_item = normalize_entry_path(&item_rel);
            let clean_item = norm_item.trim_matches('/');
            if clean_item.is_empty() {
                continue;
            }
            extract_archive_entry_or_dir(&actual_archive, clean_item, &target_dir)?;
        }

        bump_cache_version();
        Ok(target_dir.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_directory_sync(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    if path == "__RECENTS__" {
        return get_recent_files_sync(show_hidden);
    }
    if path == "__TRASH__" {
        return get_trash_files_sync(show_hidden);
    }
    let resolved_path = resolve_input_path(&path);

    if let Some((archive_path, subpath)) = split_archive_path(&resolved_path) {
        return read_archive_directory_sync(&archive_path, &subpath, show_hidden);
    }

    if !resolved_path.exists() {
        return Err(format!("Folder does not exist: {}", resolved_path.display()));
    }

    let resolved_str = resolved_path.to_string_lossy().to_string();
    let mtime_ns = path_mtime_ns(&resolved_path);
    let config_ver = META_CONFIG_VERSION.load(Ordering::Relaxed);
    let cache_mutex = DIR_ENTRIES_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if mtime_ns > 0 {
        if let Ok(guard) = cache_mutex.lock() {
            if let Some(cached) = guard.get(&(resolved_str.clone(), show_hidden)) {
                if cached.mtime_ns == mtime_ns
                    && cached.config_ver == config_ver
                    && cached.updated_at.elapsed().as_secs() < 20
                {
                    return Ok(cached.entries.clone());
                }
            }
        }
    }

    let read_dir_res = fs::read_dir(&resolved_path);
    let tags_map = load_tags_map();
    let open_cfg = load_open_with_config();

    let mut entries = Vec::with_capacity(64);
    match read_dir_res {
        Ok(read_dir) => {
            for item in read_dir.flatten() {
                let file_name = item.file_name();
                let name_str = file_name.to_string_lossy();
                if !show_hidden && name_str.starts_with('.') {
                    continue;
                }
                if let Some(entry) = build_file_entry_from_dir_entry(&item, &tags_map, &open_cfg) {
                    entries.push(entry);
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(13) => {
            // Unprivileged read denied: check if we have sudo credentials to list entries
            #[cfg(unix)]
            {
                let pass = if crate::is_effective_root() {
                    Some(String::new())
                } else {
                    get_cached_sudo_password()
                };

                if let Some(password) = pass {
                    use std::io::Write;
                    use std::process::Stdio;

                    let mut child = Command::new("sudo")
                        .env("LC_ALL", "C")
                        .arg("-S")
                        .arg("-p")
                        .arg("")
                        .args(["find", &resolved_str, "-maxdepth", "1", "-mindepth", "1", "-printf", "%f\t%y\t%s\t%T@\t%m\n"])
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped())
                        .spawn()
                        .map_err(|spawn_err| format!("Cannot read {}: {}", resolved_str, spawn_err))?;

                    if let Some(mut stdin) = child.stdin.take() {
                        let _ = stdin.write_all(format!("{}\n", password).as_bytes());
                    }

                    let out = child
                        .wait_with_output()
                        .map_err(|wait_err| format!("Cannot read {}: {}", resolved_str, wait_err))?;

                    if out.status.success() {
                        let stdout = String::from_utf8_lossy(&out.stdout);
                        for line in stdout.lines() {
                            let parts: Vec<&str> = line.split('\t').collect();
                            if parts.is_empty() {
                                continue;
                            }
                            let name = parts[0].to_string();
                            if !show_hidden && name.starts_with('.') {
                                continue;
                            }
                            let item_path = resolved_path.join(&name);
                            if let Some(entry) = build_file_entry_with_cfg(&item_path, &tags_map, &open_cfg, false) {
                                entries.push(entry);
                            }
                        }
                    } else {
                        return Err("AUTH_REQUIRED".to_string());
                    }
                } else {
                    return Err("AUTH_REQUIRED".to_string());
                }
            }
            #[cfg(not(unix))]
            return Err(format!("Cannot read {}: {}", resolved_str, e));
        }
        Err(e) => return Err(format!("Cannot read {}: {}", resolved_str, e)),
    }

    entries.sort_by_cached_key(|a| (!a.is_dir, a.name.to_lowercase()));

    if let Ok(mut guard) = cache_mutex.lock() {
        if guard.len() > 100 {
            let mut keys_by_time: Vec<_> = guard
                .iter()
                .map(|(k, v)| (k.clone(), v.updated_at))
                .collect();
            keys_by_time.sort_by_key(|(_, t)| *t);
            for (k, _) in keys_by_time.into_iter().take(25) {
                guard.remove(&k);
            }
        }
        guard.insert(
            (resolved_str.clone(), show_hidden),
            CachedDirList {
                mtime_ns,
                config_ver,
                updated_at: Instant::now(),
                entries: entries.clone(),
            },
        );
        if path != resolved_str {
            guard.insert(
                (path, show_hidden),
                CachedDirList {
                    mtime_ns,
                    config_ver,
                    updated_at: Instant::now(),
                    entries: entries.clone(),
                },
            );
        }
    }

    Ok(entries)
}

#[tauri::command]
pub async fn read_directory(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || read_directory_sync(path, show_hidden))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn prefetch_directories(
    paths: Vec<String>,
    show_hidden: bool,
) -> Result<HashMap<String, Vec<FileEntry>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = HashMap::with_capacity(paths.len());
        for p in paths {
            if let Ok(entries) = read_directory_sync(p.clone(), show_hidden) {
                out.insert(p, entries);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_sidebar_data() -> Result<SidebarData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = effective_user_home_dir();
        let home_str = home.to_string_lossy().to_string();

        let mut favorites = Vec::new();
        let standard_dirs = [
            ("recents", "Recents", Some(PathBuf::from("__RECENTS__")), "clock"),
            ("home", "Home", Some(home.clone()), "home"),
            ("desktop", "Desktop", effective_user_subdir(dirs::desktop_dir, "Desktop"), "monitor"),
            ("documents", "Documents", effective_user_subdir(dirs::document_dir, "Documents"), "file-text"),
            ("downloads", "Downloads", effective_user_subdir(dirs::download_dir, "Downloads"), "download"),
            ("pictures", "Pictures", effective_user_subdir(dirs::picture_dir, "Pictures"), "image"),
            ("music", "Music", effective_user_subdir(dirs::audio_dir, "Music"), "music"),
            ("videos", "Movies", effective_user_subdir(dirs::video_dir, "Videos"), "film"),
            ("trash", "Trash", Some(PathBuf::from("__TRASH__")), "trash"),
        ];

        for (id, label, dir_opt, icon) in standard_dirs {
            if let Some(p) = dir_opt {
                if id == "recents" || id == "trash" || p.exists() {
                    favorites.push(UserDirectory {
                        id: id.to_string(),
                        name: label.to_string(),
                        path: p.to_string_lossy().to_string(),
                        icon: icon.to_string(),
                    });
                }
            }
        }

        let volumes = list_system_partitions();
        let tags = load_tags_map();

        Ok(SidebarData {
            home_dir: home_str,
            os_name: get_system_os_name(),
            is_root: is_root_session(),
            needs_sudo_elevation: crate::needs_gui_sudo_elevation(),
            favorites,
            volumes,
            tags,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_directory(parent_path: String, name: String) -> Result<FileEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(&parent_path).join(&name);
        if target.exists() {
            return Err(format!("'{}' already exists", name));
        }
        let target_str = target.to_string_lossy().to_string();
        execute_privileged_task(
            || fs::create_dir_all(&target),
            &["mkdir", "-p", &target_str],
        )?;
        bump_cache_version();
        let tags_map = load_tags_map();
        build_file_entry(&target, &tags_map, false)
            .ok_or_else(|| "Failed to read created folder".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_file(parent_path: String, name: String) -> Result<FileEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(&parent_path).join(&name);
        if target.exists() {
            return Err(format!("'{}' already exists", name));
        }
        let target_str = target.to_string_lossy().to_string();
        execute_privileged_task(
            || fs::write(&target, ""),
            &["touch", &target_str],
        )?;
        bump_cache_version();
        let tags_map = load_tags_map();
        build_file_entry(&target, &tags_map, false)
            .ok_or_else(|| "Failed to read created file".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_item(old_path: String, new_name: String) -> Result<FileEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = Path::new(&old_path);
        let parent = src
            .parent()
            .ok_or_else(|| "Cannot determine parent directory".to_string())?;
        let dst = parent.join(&new_name);
        if dst.exists() && dst != src {
            return Err(format!("An item named '{}' already exists", new_name));
        }
        let src_str = src.to_string_lossy().to_string();
        let dst_str = dst.to_string_lossy().to_string();
        execute_privileged_task(
            || fs::rename(src, &dst),
            &["mv", &src_str, &dst_str],
        )?;
        bump_cache_version();

        let mut tags_map = load_tags_map();
        if let Some(existing_tags) = tags_map.remove(&old_path) {
            tags_map.insert(dst_str.clone(), existing_tags);
            let _ = save_tags_map(&tags_map);
        }

        let mut open_cfg = load_open_with_config();
        if let Some(existing_app) = open_cfg.by_path.remove(&old_path) {
            open_cfg.by_path.insert(dst_str, existing_app);
            let _ = save_open_with_config(&open_cfg);
        }

        build_file_entry(&dst, &tags_map, false)
            .ok_or_else(|| "Failed to read renamed item".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn unique_destination_path(dest_dir: &Path, original_name: &str) -> PathBuf {
    let initial = dest_dir.join(original_name);
    if !initial.exists() {
        return initial;
    }
    let stem = Path::new(original_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| original_name.to_string());
    let ext = Path::new(original_name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    for i in 1..1000 {
        let candidate_name = if i == 1 {
            format!("{} copy{}", stem, ext)
        } else {
            format!("{} copy {}{}", stem, i, ext)
        };
        let candidate = dest_dir.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dest_dir.join(format!("{}-copy{}", stem, ext))
}

#[tauri::command]
pub async fn copy_items(
    sources: Vec<String>,
    destination_dir: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest_root = Path::new(&destination_dir);
        if !dest_root.is_dir() {
            return Err("Destination is not a directory".to_string());
        }
        let mut created = Vec::new();
        for src_str in sources {
            let src = Path::new(&src_str);
            if let Some((archive_path, subpath)) = split_archive_path(src) {
                if !subpath.as_os_str().is_empty() {
                    let norm_sub = normalize_entry_path(&subpath.to_string_lossy());
                    let clean_sub = norm_sub.trim_matches('/').to_string();
                    if !clean_sub.is_empty() {
                        let base_name = clean_sub.rsplit('/').next().unwrap_or(&clean_sub);
                        let target = unique_destination_path(dest_root, base_name);
                        extract_archive_entry_or_dir(&archive_path, &clean_sub, dest_root)?;
                        created.push(target.to_string_lossy().to_string());
                        continue;
                    }
                }
            }
            if !src.exists() {
                continue;
            }
            if src.is_dir() && (dest_root == src || dest_root.starts_with(src)) {
                return Err("Cannot copy a folder into itself".to_string());
            }
            let file_name = src
                .file_name()
                .ok_or_else(|| "Invalid source filename".to_string())?
                .to_string_lossy()
                .to_string();
            let target = unique_destination_path(dest_root, &file_name);
            let src_str_clone = src_str.clone();
            let target_str = target.to_string_lossy().to_string();
            if src.is_dir() {
                if let Err(_e) = copy_dir_recursive(src, &target) {
                    execute_privileged_task(
                        || Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied")),
                        &["cp", "-a", &src_str_clone, &target_str],
                    )?;
                }
            } else {
                if let Err(_e) = fs::copy(src, &target) {
                    execute_privileged_task(
                        || Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied")),
                        &["cp", "-a", &src_str_clone, &target_str],
                    )?;
                }
            }
            created.push(target.to_string_lossy().to_string());
        }
        bump_cache_version();
        Ok(created)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn move_items(
    sources: Vec<String>,
    destination_dir: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest_root = Path::new(&destination_dir);
        if !dest_root.is_dir() {
            return Err("Destination is not a directory".to_string());
        }
        let mut tags_map = load_tags_map();
        let mut tags_changed = false;
        let mut open_cfg = load_open_with_config();
        let mut open_cfg_changed = false;
        let mut moved = Vec::new();
        for src_str in sources {
            let src = Path::new(&src_str);
            if let Some((archive_path, subpath)) = split_archive_path(src) {
                if !subpath.as_os_str().is_empty() {
                    let norm_sub = normalize_entry_path(&subpath.to_string_lossy());
                    let clean_sub = norm_sub.trim_matches('/').to_string();
                    if !clean_sub.is_empty() {
                        let base_name = clean_sub.rsplit('/').next().unwrap_or(&clean_sub);
                        let target = unique_destination_path(dest_root, base_name);
                        extract_archive_entry_or_dir(&archive_path, &clean_sub, dest_root)?;
                        moved.push(target.to_string_lossy().to_string());
                        continue;
                    }
                }
            }
            if !src.exists() {
                continue;
            }
            if src.is_dir() && (dest_root == src || dest_root.starts_with(src)) {
                return Err("Cannot move a folder into itself".to_string());
            }
            if src.parent() == Some(dest_root) {
                moved.push(src_str);
                continue;
            }
            let file_name = src
                .file_name()
                .ok_or_else(|| "Invalid source filename".to_string())?
                .to_string_lossy()
                .to_string();
            let target = unique_destination_path(dest_root, &file_name);
            let src_str_clone = src_str.clone();
            let target_str = target.to_string_lossy().to_string();
            if fs::rename(src, &target).is_err() {
                if src.is_dir() {
                    if copy_dir_recursive(src, &target).is_err() || fs::remove_dir_all(src).is_err() {
                        execute_privileged_task(
                            || Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied")),
                            &["mv", &src_str_clone, &target_str],
                        )?;
                    }
                } else {
                    if fs::copy(src, &target).is_err() || fs::remove_file(src).is_err() {
                        execute_privileged_task(
                            || Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied")),
                            &["mv", &src_str_clone, &target_str],
                        )?;
                    }
                }
            }
            let target_str = target.to_string_lossy().to_string();
            if let Some(existing_tags) = tags_map.remove(&src_str) {
                tags_map.insert(target_str.clone(), existing_tags);
                tags_changed = true;
            }
            if let Some(existing_app) = open_cfg.by_path.remove(&src_str) {
                open_cfg.by_path.insert(target_str.clone(), existing_app);
                open_cfg_changed = true;
            }
            moved.push(target_str);
        }
        if tags_changed {
            let _ = save_tags_map(&tags_map);
        }
        if open_cfg_changed {
            let _ = save_open_with_config(&open_cfg);
        }
        bump_cache_version();
        Ok(moved)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn duplicate_item(path: String) -> Result<FileEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = Path::new(&path);
        let parent = src
            .parent()
            .ok_or_else(|| "Cannot duplicate root".to_string())?;
        let name = src
            .file_name()
            .ok_or_else(|| "Invalid item name".to_string())?
            .to_string_lossy()
            .to_string();
        let target = unique_destination_path(parent, &name);
        if src.is_dir() {
            copy_dir_recursive(src, &target)?;
        } else {
            fs::copy(src, &target).map_err(|e| format!("Duplicate failed: {}", e))?;
        }
        bump_cache_version();
        let tags_map = load_tags_map();
        build_file_entry(&target, &tags_map, false)
            .ok_or_else(|| "Failed to read duplicated item".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn append_path_to_zip<W: Write + Seek>(
    writer: &mut zip::ZipWriter<W>,
    source: &Path,
    base: &Path,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("Cannot add symbolic links to ZIP archives: {}", source.display()));
    }

    let relative = source
        .strip_prefix(base)
        .map_err(|error| format!("Could not create archive path: {error}"))?;
    let archive_name = relative.to_string_lossy().replace('\\', "/");
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(metadata.permissions().mode() & 0o777);

    if metadata.is_dir() {
        writer
            .add_directory(format!("{archive_name}/"), options)
            .map_err(|error| format!("Could not add folder to ZIP: {error}"))?;
        for child in fs::read_dir(source)
            .map_err(|error| format!("Could not read folder {}: {error}", source.display()))?
        {
            let child = child.map_err(|error| format!("Could not read folder entry: {error}"))?;
            append_path_to_zip(writer, &child.path(), base)?;
        }
    } else if metadata.is_file() {
        writer
            .start_file(&archive_name, options)
            .map_err(|error| format!("Could not add file to ZIP: {error}"))?;
        let mut input = fs::File::open(source)
            .map_err(|error| format!("Could not open {}: {error}", source.display()))?;
        std::io::copy(&mut input, writer)
            .map_err(|error| format!("Could not compress {}: {error}", source.display()))?;
    } else {
        return Err(format!("Cannot add special files to ZIP archives: {}", source.display()));
    }
    Ok(())
}

#[tauri::command]
pub async fn compress_items(paths: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            return Err("Select at least one file or folder to compress".to_string());
        }

        let items = paths.iter().map(PathBuf::from).collect::<Vec<_>>();
        let first_parent = items[0]
            .parent()
            .ok_or_else(|| "Cannot compress a filesystem root".to_string())?
            .to_path_buf();
        for item in &items {
            if !item.exists() {
                return Err(format!("Item no longer exists: {}", item.display()));
            }
            if item.parent() != Some(first_parent.as_path()) {
                return Err("Selected items must be in the same folder to compress them together".to_string());
            }
        }

        let archive_name = if items.len() == 1 {
            let name = items[0]
                .file_name()
                .ok_or_else(|| "Invalid item name".to_string())?
                .to_string_lossy()
                .to_string();
            format!("{}.zip", Path::new(&name).file_stem().unwrap_or_default().to_string_lossy())
        } else {
            "Archive.zip".to_string()
        };
        let archive_path = unique_destination_path(&first_parent, &archive_name);
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&archive_path)
            .map_err(|error| format!("Could not create ZIP archive: {error}"))?;
        let mut writer = zip::ZipWriter::new(file);
        let write_result = items.iter().try_for_each(|item| {
            append_path_to_zip(&mut writer, item, &first_parent)
        });
        if let Err(error) = write_result {
            drop(writer);
            let _ = fs::remove_file(&archive_path);
            return Err(error);
        }
        if let Err(error) = writer.finish() {
            let _ = fs::remove_file(&archive_path);
            return Err(format!("Could not finish ZIP archive: {error}"));
        }

        bump_cache_version();
        Ok(archive_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn extract_archive(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let input_path = resolve_input_path(&path);
        let archive_path = if let Some((arch, _)) = split_archive_path(&input_path) {
            arch
        } else {
            input_path
        };
        let parent = archive_path
            .parent()
            .ok_or_else(|| "Cannot determine archive folder".to_string())?;
        let archive_name = archive_output_name(&archive_path)?;
        let output_dir = unique_destination_path(parent, &archive_name);
        fs::create_dir(&output_dir)
            .map_err(|error| format!("Could not create extraction folder: {error}"))?;

        let extraction_result = (|| -> Result<(), String> {
            let name = archive_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if name.ends_with(".zip") {
                let file = fs::File::open(&archive_path)
                    .map_err(|error| format!("Could not open ZIP archive: {error}"))?;
                let mut archive = zip::ZipArchive::new(file)
                    .map_err(|error| format!("Could not read ZIP archive: {error}"))?;

                for index in 0..archive.len() {
                    let mut entry = archive
                        .by_index(index)
                        .map_err(|error| format!("Could not read ZIP entry: {error}"))?;
                    let relative_path = entry
                        .enclosed_name()
                        .ok_or_else(|| format!("Unsafe path in ZIP archive: {}", entry.name()))?
                        .to_path_buf();
                    let is_symlink = entry
                        .unix_mode()
                        .map(|mode| mode & 0o170000 == 0o120000)
                        .unwrap_or(false);
                    if is_symlink {
                        return Err(format!(
                            "Archive extraction does not allow symbolic links: {}",
                            entry.name()
                        ));
                    }

                    let destination = output_dir.join(relative_path);
                    if entry.is_dir() {
                        fs::create_dir_all(&destination)
                            .map_err(|error| format!("Could not create folder: {error}"))?;
                        continue;
                    }

                    let destination_parent = destination
                        .parent()
                        .ok_or_else(|| "Invalid file path in ZIP archive".to_string())?;
                    fs::create_dir_all(destination_parent)
                        .map_err(|error| format!("Could not create folder: {error}"))?;
                    let mut output = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&destination)
                        .map_err(|error| format!("Could not create extracted file: {error}"))?;
                    std::io::copy(&mut entry, &mut output)
                        .map_err(|error| format!("Could not extract file: {error}"))?;
                }
            } else {
                let reader = open_tarball_reader(&archive_path)?;
                let mut archive = tar::Archive::new(reader);
                let entries = archive
                    .entries()
                    .map_err(|error| format!("Could not read TAR archive: {error}"))?;
                for entry in entries {
                    let mut entry = entry
                        .map_err(|error| format!("Could not read TAR entry: {error}"))?;
                    let entry_type = entry.header().entry_type();
                    if !entry_type.is_file() && !entry_type.is_dir() {
                        return Err(format!(
                            "Archive extraction does not allow links or special files: {}",
                            entry
                                .path()
                                .map(|path| path.to_string_lossy().into_owned())
                                .unwrap_or_else(|_| "unknown entry".to_string())
                        ));
                    }
                    let extracted = entry
                        .unpack_in(&output_dir)
                        .map_err(|error| format!("Could not extract TAR entry: {error}"))?;
                    if !extracted {
                        return Err("Unsafe path in TAR archive".to_string());
                    }
                }
            }
            Ok(())
        })();

        if let Err(error) = extraction_result {
            let _ = fs::remove_dir_all(&output_dir);
            return Err(error);
        }

        bump_cache_version();
        Ok(output_dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn archive_output_name(path: &Path) -> Result<String, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid archive name".to_string())?;
    let lower_name = file_name.to_lowercase();
    let suffixes = [
        ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lzma", ".tgz", ".tbz2", ".tbz", ".txz",
        ".tzst", ".tar", ".zip",
    ];
    let stem = suffixes
        .iter()
        .find_map(|suffix| lower_name.strip_suffix(suffix).map(|_| &file_name[..file_name.len() - suffix.len()]));
    Ok(stem
        .filter(|stem| !stem.is_empty())
        .unwrap_or("Extracted")
        .to_string())
}

fn open_tarball_reader(path: &Path) -> Result<Box<dyn Read>, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not open TAR archive: {error}"))?;

    if file_name.ends_with(".tar.gz") || file_name.ends_with(".tgz") {
        Ok(Box::new(flate2::read::GzDecoder::new(file)))
    } else if file_name.ends_with(".tar.bz2")
        || file_name.ends_with(".tbz2")
        || file_name.ends_with(".tbz")
    {
        Ok(Box::new(bzip2::read::BzDecoder::new(file)))
    } else if file_name.ends_with(".tar.xz") || file_name.ends_with(".txz") {
        Ok(Box::new(lzma_rust2::XzReader::new(file, true)))
    } else if file_name.ends_with(".tar.zst") || file_name.ends_with(".tzst") {
        zstd::stream::read::Decoder::new(file)
            .map(|reader| Box::new(reader) as Box<dyn Read>)
            .map_err(|error| format!("Could not read compressed TAR archive: {error}"))
    } else if file_name.ends_with(".tar.lzma") {
        lzma_rust2::LzmaReader::new_mem_limit(file, 512 * 1024, None)
            .map(|reader| Box::new(reader) as Box<dyn Read>)
            .map_err(|error| format!("Could not read compressed TAR archive: {error}"))
    } else if file_name.ends_with(".tar") {
        Ok(Box::new(file))
    } else {
        Err("Unsupported archive format".to_string())
    }
}


fn active_trash_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let user_trash = effective_user_home_dir().join(".local/share/Trash");
    roots.push(user_trash);

    if let Some(data_local) = dirs::data_local_dir() {
        let alt_trash = data_local.join("Trash");
        if !roots.contains(&alt_trash) {
            roots.push(alt_trash);
        }
    }
    if is_root_session() {
        let root_trash = PathBuf::from("/root/.local/share/Trash");
        if !roots.contains(&root_trash) {
            roots.push(root_trash);
        }
    }
    roots
}

fn decode_trash_uri_path(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn encode_trash_uri_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn parse_trashinfo_file(info_path: &Path) -> (Option<String>, Option<i64>) {
    let Ok(content) = fs::read_to_string(info_path) else {
        return (None, None);
    };
    let mut orig_path = None;
    let mut deleted_at = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Path=") {
            let decoded = decode_trash_uri_path(rest.trim());
            if !decoded.is_empty() {
                orig_path = Some(decoded);
            }
        } else if let Some(rest) = trimmed.strip_prefix("DeletionDate=") {
            if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(rest.trim(), "%Y-%m-%dT%H:%M:%S") {
                use chrono::TimeZone;
                let ts = chrono::Local
                    .from_local_datetime(&naive)
                    .single()
                    .map(|dt| dt.timestamp())
                    .unwrap_or_else(|| naive.and_utc().timestamp());
                deleted_at = Some(ts);
            }
        }
    }
    (orig_path, deleted_at)
}

fn resolve_trash_metadata_for_path(path: &Path) -> (Option<String>, Option<i64>) {
    let Some(parent) = path.parent() else {
        return (None, None);
    };
    if parent.file_name().and_then(|n| n.to_str()) != Some("files") {
        return (None, None);
    }
    let Some(trash_root) = parent.parent() else {
        return (None, None);
    };
    let Some(file_name) = path.file_name() else {
        return (None, None);
    };
    let info_path = trash_root
        .join("info")
        .join(format!("{}.trashinfo", file_name.to_string_lossy()));
    if !info_path.exists() {
        return (None, None);
    }
    parse_trashinfo_file(&info_path)
}

fn move_item_to_freedesktop_trash(src: &Path) -> Result<(), String> {
    if !src.exists() && fs::symlink_metadata(src).is_err() {
        return Err(format!("Item does not exist: {}", src.display()));
    }
    let abs_src = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let trash_root = effective_user_home_dir().join(".local/share/Trash");
    let files_dir = trash_root.join("files");
    let info_dir = trash_root.join("info");
    fs::create_dir_all(&files_dir).map_err(|e| format!("Could not create Trash/files: {e}"))?;
    fs::create_dir_all(&info_dir).map_err(|e| format!("Could not create Trash/info: {e}"))?;

    let orig_name = src
        .file_name()
        .ok_or_else(|| "Invalid filename".to_string())?
        .to_string_lossy()
        .to_string();
    let stem = Path::new(&orig_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| orig_name.clone());
    let ext = Path::new(&orig_name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let mut trash_name = orig_name.clone();
    for i in 2..10000 {
        let candidate_file = files_dir.join(&trash_name);
        let candidate_info = info_dir.join(format!("{trash_name}.trashinfo"));
        if !candidate_file.exists() && !candidate_info.exists() {
            break;
        }
        trash_name = format!("{stem}.{i}{ext}");
    }

    let target_file = files_dir.join(&trash_name);
    let target_info = info_dir.join(format!("{trash_name}.trashinfo"));
    let now_str = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let info_contents = format!(
        "[Trash Info]\nPath={}\nDeletionDate={}\n",
        encode_trash_uri_path(&abs_src.to_string_lossy()),
        now_str
    );
    fs::write(&target_info, info_contents)
        .map_err(|e| format!("Could not write .trashinfo: {e}"))?;

    if fs::rename(src, &target_file).is_err() {
        let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
        if meta.is_dir() && !meta.file_type().is_symlink() {
            if let Err(err) = copy_dir_recursive(src, &target_file) {
                let _ = fs::remove_file(&target_info);
                return Err(err);
            }
            if let Err(err) = fs::remove_dir_all(src) {
                return Err(err.to_string());
            }
        } else {
            if let Err(err) = fs::copy(src, &target_file) {
                let _ = fs::remove_file(&target_info);
                return Err(err.to_string());
            }
            if let Err(err) = fs::remove_file(src) {
                return Err(err.to_string());
            }
        }
    }
    Ok(())
}

fn remove_permanently_with_trashinfo(target: &Path) -> Result<(), String> {
    let target_str = target.to_string_lossy().to_string();
    let meta = fs::symlink_metadata(target);
    match meta {
        Ok(m) => {
            let is_dir = m.is_dir() && !m.file_type().is_symlink();
            execute_privileged_task(
                || {
                    if is_dir {
                        fs::remove_dir_all(target)
                    } else {
                        fs::remove_file(target)
                    }
                },
                &["rm", "-rf", &target_str],
            )?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(13) => {
            execute_privileged_task(
                || Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied")),
                &["rm", "-rf", &target_str],
            )?;
        }
        Err(e) => return Err(format!("Could not access {target_str}: {e}")),
    }

    if let Some(parent) = target.parent() {
        if parent.file_name().and_then(|n| n.to_str()) == Some("files") {
            if let (Some(trash_root), Some(file_name)) = (parent.parent(), target.file_name()) {
                let info_path = trash_root
                    .join("info")
                    .join(format!("{}.trashinfo", file_name.to_string_lossy()));
                let _ = fs::remove_file(info_path);
            }
        }
    }
    Ok(())
}

fn get_trash_files_sync(show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    let tags_map = load_tags_map();
    let open_cfg = load_open_with_config();
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for trash_root in active_trash_roots() {
        let files_dir = trash_root.join("files");
        if !files_dir.is_dir() {
            continue;
        }
        if let Ok(read_dir) = fs::read_dir(&files_dir) {
            for item in read_dir.flatten() {
                let file_name = item.file_name();
                let name_str = file_name.to_string_lossy();
                if !show_hidden && name_str.starts_with('.') {
                    continue;
                }
                let p = item.path();
                let p_str = p.to_string_lossy().to_string();
                if seen.contains(&p_str) {
                    continue;
                }
                seen.insert(p_str);
                if let Some(entry) = build_file_entry_from_dir_entry(&item, &tags_map, &open_cfg) {
                    entries.push(entry);
                }
            }
        }
    }

    entries.sort_by(|a, b| {
        let a_time = a.deleted_at.unwrap_or(a.modified);
        let b_time = b.deleted_at.unwrap_or(b.modified);
        b_time.cmp(&a_time)
    });
    Ok(entries)
}

#[tauri::command]
pub async fn get_trash_files(show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || get_trash_files_sync(show_hidden))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restore_trash_items(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let targets: Vec<PathBuf> = if paths.is_empty() {
            get_trash_files_sync(true)?
                .into_iter()
                .map(|e| PathBuf::from(e.path))
                .collect()
        } else {
            paths.into_iter().map(PathBuf::from).collect()
        };

        let mut restored = Vec::new();
        let home = effective_user_home_dir();

        for trash_path in targets {
            if !trash_path.exists() && fs::symlink_metadata(&trash_path).is_err() {
                continue;
            }
            let file_name = trash_path
                .file_name()
                .ok_or_else(|| "Invalid trash item name".to_string())?
                .to_string_lossy()
                .to_string();

            let (orig_opt, _) = resolve_trash_metadata_for_path(&trash_path);
            let desired_dest = orig_opt
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(&file_name));

            let dest_parent = desired_dest
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| home.clone());
            fs::create_dir_all(&dest_parent)
                .map_err(|e| format!("Could not create folder {}: {e}", dest_parent.display()))?;

            let dest_name = desired_dest
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| file_name.clone());
            let final_dest = unique_destination_path(&dest_parent, &dest_name);

            if fs::rename(&trash_path, &final_dest).is_err() {
                let meta = fs::symlink_metadata(&trash_path).map_err(|e| e.to_string())?;
                if meta.is_dir() && !meta.file_type().is_symlink() {
                    copy_dir_recursive(&trash_path, &final_dest)?;
                    fs::remove_dir_all(&trash_path).map_err(|e| e.to_string())?;
                } else {
                    fs::copy(&trash_path, &final_dest).map_err(|e| e.to_string())?;
                    fs::remove_file(&trash_path).map_err(|e| e.to_string())?;
                }
            }

            if let Some(parent) = trash_path.parent() {
                if parent.file_name().and_then(|n| n.to_str()) == Some("files") {
                    if let Some(trash_root) = parent.parent() {
                        let info_path = trash_root
                            .join("info")
                            .join(format!("{file_name}.trashinfo"));
                        let _ = fs::remove_file(info_path);
                    }
                }
            }

            restored.push(final_dest.to_string_lossy().to_string());
        }

        bump_cache_version();
        Ok(restored)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_trash_items_permanently(paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut count = 0usize;
        for p in paths {
            let target = Path::new(&p);
            if target.exists() || fs::symlink_metadata(target).is_ok() {
                remove_permanently_with_trashinfo(target)?;
                count += 1;
            }
        }
        bump_cache_version();
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn empty_trash() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut count = 0usize;
        for trash_root in active_trash_roots() {
            let files_dir = trash_root.join("files");
            if files_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&files_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if remove_permanently_with_trashinfo(&p).is_ok() {
                            count += 1;
                        }
                    }
                }
            }
            let info_dir = trash_root.join("info");
            if info_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&info_dir) {
                    for entry in entries.flatten() {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
        bump_cache_version();
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_items(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for p in paths {
            let path = Path::new(&p);
            let already_in_trash = path
                .parent()
                .and_then(|parent| {
                    if parent.file_name().and_then(|n| n.to_str()) == Some("files") {
                        parent.parent()
                    } else {
                        None
                    }
                })
                .map(|root| active_trash_roots().contains(&root.to_path_buf()))
                .unwrap_or(false);

            if already_in_trash {
                remove_permanently_with_trashinfo(path)?;
                continue;
            }

            if is_root_session() {
                move_item_to_freedesktop_trash(path)?;
            } else if trash::delete(&p).is_err() {
                move_item_to_freedesktop_trash(path)?;
            }
        }
        bump_cache_version();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn ensure_file_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let target_buf = if let Ok(target) = fs::canonicalize(path) {
            target
        } else {
            path.to_path_buf()
        };
        let target_path = target_buf.as_path();

        if let Ok(metadata) = fs::metadata(target_path) {
            let current_mode = metadata.permissions().mode();
            if current_mode & 0o111 != 0o111 {
                let updated_mode = current_mode | 0o111;
                let mut perms = metadata.permissions();
                perms.set_mode(updated_mode);
                if fs::set_permissions(target_path, perms.clone()).is_err() {
                    let target_str = target_path.to_string_lossy().to_string();
                    let _ = execute_privileged_task(
                        || fs::set_permissions(target_path, perms.clone()),
                        &["chmod", "+x", &target_str],
                    );
                }
                bump_cache_version();
            }
        }
    }
    Ok(())
}

fn is_appimage_file(path: &Path, ext: &str) -> bool {
    if ext.eq_ignore_ascii_case("appimage") {
        return true;
    }
    if let Ok(mut f) = fs::File::open(path) {
        use std::io::Read;
        let mut buf = [0u8; 12];
        if let Ok(n) = f.read(&mut buf) {
            if n >= 11 && &buf[0..4] == b"\x7fELF" {
                if buf[8] == 0x41 && buf[9] == 0x49 && (buf[10] == 0x01 || buf[10] == 0x02) {
                    return true;
                }
            }
        }
    }
    false
}

fn is_elf_executable_file(path: &Path, ext: &str) -> bool {
    if ext == "so" || ext.starts_with("so.") || ext == "a" || ext == "o" {
        return false;
    }
    if let Ok(mut f) = fs::File::open(path) {
        use std::io::Read;
        let mut buf = [0u8; 4];
        if let Ok(n) = f.read(&mut buf) {
            return n == 4 && &buf == b"\x7fELF";
        }
    }
    false
}

fn launch_desktop_file(path: &Path) -> Result<(), String> {
    use std::process::Stdio;

    // 1. Try gio launch
    let mut cmd = Command::new("gio");
    cmd.arg("launch").arg(path);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    sanitize_appimage_env(&mut cmd);
    if let Ok(mut child) = cmd.spawn() {
        std::thread::sleep(std::time::Duration::from_millis(60));
        if let Ok(Some(status)) = child.try_wait() {
            if status.success() {
                return Ok(());
            }
        } else {
            return Ok(());
        }
    }

    // 2. Try gtk-launch
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        let mut cmd = Command::new("gtk-launch");
        cmd.arg(stem);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        sanitize_appimage_env(&mut cmd);
        if let Ok(_) = cmd.spawn() {
            return Ok(());
        }
    }

    // 3. Fallback: Parse Exec line
    if let Ok(content) = fs::read_to_string(path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("Exec=") {
                let exec_val = &trimmed[5..];
                let tokens: Vec<&str> = exec_val
                    .split_whitespace()
                    .filter(|token| !token.starts_with('%'))
                    .collect();
                if let Some(bin) = tokens.first() {
                    let mut cmd = Command::new(bin);
                    cmd.args(&tokens[1..]);
                    if let Some(parent) = path.parent() {
                        cmd.current_dir(parent);
                    }
                    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                    sanitize_appimage_env(&mut cmd);
                    if cmd.spawn().is_ok() {
                        return Ok(());
                    }
                }
            }
        }
    }

    open::that(path).map_err(|e| format!("Failed to launch desktop entry: {}", e))
}

fn launch_executable_binary(path: &Path) -> Result<(), String> {
    use std::process::Stdio;

    let target_buf = if let Ok(target) = fs::canonicalize(path) {
        target
    } else {
        path.to_path_buf()
    };
    let target_path = target_buf.as_path();

    ensure_file_executable(target_path)?;

    let mut cmd = Command::new(target_path);
    if let Some(parent) = path.parent() {
        cmd.current_dir(parent);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    sanitize_appimage_env(&mut cmd);

    cmd.spawn()
        .map_err(|e| format!("Failed to launch '{}': {}", path.display(), e))?;

    Ok(())
}

fn launch_in_terminal(path: &Path) -> Result<(), String> {
    use std::process::Stdio;

    let target_buf = if let Ok(target) = fs::canonicalize(path) {
        target
    } else {
        path.to_path_buf()
    };
    let target_path = target_buf.as_path();

    ensure_file_executable(target_path)?;

    let path_str = target_path.to_string_lossy().to_string();
    let parent_str = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let script = format!(
        "cd \"$1\" && \"$2\"; status=$?; echo; echo \"[Process completed with exit code $status]\"; read -n 1 -s -r -p \"Press any key to close...\";"
    );

    let user_terminal = std::env::var("TERMINAL").ok();
    let terminal_candidates = [
        user_terminal.as_deref().unwrap_or(""),
        "x-terminal-emulator",
        "konsole",
        "gnome-terminal",
        "xfce4-terminal",
        "kitty",
        "alacritty",
        "foot",
        "wezterm",
        "terminator",
        "xterm",
    ];

    for term in terminal_candidates {
        if term.is_empty() {
            continue;
        }
        if Command::new("which").arg(term).output().map(|o| o.status.success()).unwrap_or(false) {
            let mut cmd = Command::new(term);
            sanitize_appimage_env(&mut cmd);
            cmd.stdin(Stdio::null());

            match term {
                "gnome-terminal" => {
                    cmd.arg("--").arg("sh").arg("-c").arg(&script).arg("_").arg(&parent_str).arg(&path_str);
                }
                "kitty" => {
                    cmd.arg("sh").arg("-c").arg(&script).arg("_").arg(&parent_str).arg(&path_str);
                }
                _ => {
                    cmd.arg("-e").arg("sh").arg("-c").arg(&script).arg("_").arg(&parent_str).arg(&path_str);
                }
            }

            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
    }

    Err("No supported terminal emulator found (tried $TERMINAL, konsole, gnome-terminal, kitty, alacritty, xterm)".to_string())
}

fn open_real_item(p: &Path) -> Result<(), String> {
    let path = p.to_string_lossy().to_string();
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let cfg = load_open_with_config();
    if let Some(program) = resolve_default_app(&path, &ext, &cfg) {
        return launch_with_program(&path, &program);
    }

    if ext == "desktop" {
        return launch_desktop_file(p);
    }

    if is_appimage_file(p, &ext) {
        return launch_executable_binary(p);
    }

    if ext == "bin" || ext == "run" || is_elf_executable_file(p, &ext) {
        return launch_executable_binary(p);
    }

    if ext == "command" {
        return launch_in_terminal(p);
    }

    open::that(&path).map_err(|e| format!("Failed to open '{}': {}", path, e))
}

#[tauri::command]
pub async fn open_item(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_input_path(&path);
        if let Some((archive_path, subpath)) = split_archive_path(&resolved) {
            if !subpath.as_os_str().is_empty() {
                let extracted = extract_single_archive_entry_to_cache(&archive_path, &subpath)?;
                return open_real_item(&extracted);
            }
        }
        open_real_item(&resolved)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn run_item(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        if ext == "desktop" {
            return launch_desktop_file(p);
        }

        launch_executable_binary(p)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn run_item_in_terminal(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        launch_in_terminal(p)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_item_with(path: String, program: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_input_path(&path);
        if let Some((archive_path, subpath)) = split_archive_path(&resolved) {
            if !subpath.as_os_str().is_empty() {
                let extracted = extract_single_archive_entry_to_cache(&archive_path, &subpath)?;
                return launch_with_program(&extracted.to_string_lossy(), &program);
            }
        }
        launch_with_program(&path, &program)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_default_app(
    path: String,
    program: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let trimmed = program.trim().to_string();
        let mut cfg = load_open_with_config();

        if trimmed.is_empty() {
            cfg.by_path.remove(&path);
            if !ext.is_empty() {
                cfg.by_extension.remove(&ext);
            }
        } else if !ext.is_empty() {
            cfg.by_path.remove(&path);
            cfg.by_extension.insert(ext.clone(), trimmed);
        } else {
            cfg.by_path.insert(path.clone(), trimmed);
        }

        save_open_with_config(&cfg)?;
        Ok(resolve_default_app(&path, &ext, &cfg))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_file_preview_url(path: String) -> Result<String, String> {
    let resolved = resolve_input_path(&path);
    if let Some((archive_path, subpath)) = split_archive_path(&resolved) {
        if !subpath.as_os_str().is_empty() {
            let extracted = extract_single_archive_entry_to_cache(&archive_path, &subpath)?;
            return crate::download_server::register_file_preview(&extracted);
        }
    }
    if !resolved.is_file() {
        return Err("Preview file no longer exists".to_string());
    }
    crate::download_server::register_file_preview(&resolved)
}

fn read_file_preview_internal(p: &Path, max_bytes: Option<usize>) -> Result<FilePreview, String> {
    if !p.exists() {
        return Err("File no longer exists".to_string());
    }
    let tags_map = load_tags_map();
    let entry = build_file_entry(p, &tags_map, true)
        .ok_or_else(|| "Unable to read metadata".to_string())?;

    if entry.is_dir {
        return Ok(FilePreview {
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
            mime_type: entry.mime_type,
            size: entry.size,
            modified: entry.modified,
            created: entry.created,
            permissions: entry.permissions,
            is_dir: true,
            child_count: entry.child_count,
            preview_type: "directory".to_string(),
            text_content: None,
            data_url: None,
            truncated: false,
        });
    }

    let ext = entry.extension.as_str();
    let is_image = matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" | "jfif"
    );
    let is_video = matches!(
        ext,
        "mp4" | "m4v" | "mkv" | "mov" | "webm" | "avi" | "mpeg" | "mpg" | "3gp"
    ) || entry.mime_type.starts_with("video/");
    let is_pdf = ext == "pdf" || entry.mime_type == "application/pdf";

    if is_image && entry.size <= 15 * 1024 * 1024 {
        let bytes = fs::read(p).map_err(|e| e.to_string())?;
        let mime = if ext == "svg" {
            "image/svg+xml"
        } else {
            entry.mime_type.as_str()
        };
        let encoded = BASE64.encode(&bytes);
        return Ok(FilePreview {
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
            mime_type: entry.mime_type.clone(),
            size: entry.size,
            modified: entry.modified,
            created: entry.created,
            permissions: entry.permissions,
            is_dir: false,
            child_count: None,
            preview_type: "image".to_string(),
            text_content: None,
            data_url: Some(format!("data:{};base64,{}", mime, encoded)),
            truncated: false,
        });
    }

    if is_video {
        return Ok(FilePreview {
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
            mime_type: entry.mime_type,
            size: entry.size,
            modified: entry.modified,
            created: entry.created,
            permissions: entry.permissions,
            is_dir: false,
            child_count: None,
            preview_type: "video".to_string(),
            text_content: None,
            data_url: None,
            truncated: false,
        });
    }

    if is_pdf {
        return Ok(FilePreview {
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
            mime_type: "application/pdf".to_string(),
            size: entry.size,
            modified: entry.modified,
            created: entry.created,
            permissions: entry.permissions,
            is_dir: false,
            child_count: None,
            preview_type: "pdf".to_string(),
            text_content: None,
            data_url: None,
            truncated: false,
        });
    }

    let limit = max_bytes.unwrap_or(64 * 1024);
    let mut file = fs::File::open(p).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; limit.min(entry.size as usize)];
    let bytes_read = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(bytes_read);

    let is_binary = buf.iter().take(1024).any(|&b| b == 0);
    if !is_binary {
        let text = String::from_utf8_lossy(&buf).to_string();
        return Ok(FilePreview {
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
            mime_type: entry.mime_type,
            size: entry.size,
            modified: entry.modified,
            created: entry.created,
            permissions: entry.permissions,
            is_dir: false,
            child_count: None,
            preview_type: "text".to_string(),
            text_content: Some(text),
            data_url: None,
            truncated: (entry.size as usize) > bytes_read,
        });
    }

    Ok(FilePreview {
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        mime_type: entry.mime_type,
        size: entry.size,
        modified: entry.modified,
        created: entry.created,
        permissions: entry.permissions,
        is_dir: false,
        child_count: None,
        preview_type: "binary".to_string(),
        text_content: None,
        data_url: None,
        truncated: false,
    })
}

#[tauri::command]
pub async fn read_file_preview(
    path: String,
    max_bytes: Option<usize>,
) -> Result<FilePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_input_path(&path);
        if let Some((archive_path, subpath)) = split_archive_path(&resolved) {
            if !subpath.as_os_str().is_empty() {
                let extracted = extract_single_archive_entry_to_cache(&archive_path, &subpath)?;
                let mut preview = read_file_preview_internal(&extracted, max_bytes)?;
                preview.path = path;
                return Ok(preview);
            }
        }
        read_file_preview_internal(&resolved, max_bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_directory(
    root_path: String,
    query: String,
    show_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return read_directory_sync(root_path, show_hidden);
        }

        let tags_map = load_tags_map();
        let open_cfg = load_open_with_config();
        let mut results = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        let root = resolve_input_path(&root_path);
        if let Some((archive_path, subpath)) = split_archive_path(&root) {
            return search_archive_sync(&archive_path, &subpath, &q, show_hidden);
        }
        queue.push_back((root, 0usize));

        while let Some((dir, depth)) = queue.pop_front() {
            if results.len() >= 200 || depth > 3 {
                continue;
            }
            if let Ok(entries) = fs::read_dir(&dir) {
                for item in entries.flatten() {
                    let file_name = item.file_name();
                    let name = file_name.to_string_lossy();
                    if !show_hidden && name.starts_with('.') {
                        continue;
                    }
                    let p = item.path();
                    if name.to_lowercase().contains(&q) {
                        if let Some(fe) =
                            build_file_entry_with_cfg(&p, &tags_map, &open_cfg, false)
                        {
                            results.push(fe);
                            if results.len() >= 200 {
                                break;
                            }
                        }
                    }
                    let is_dir = item.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                    if is_dir
                        && depth < 3
                        && name != "node_modules"
                        && name != "target"
                        && name != ".git"
                    {
                        queue.push_back((p, depth + 1));
                    }
                }
            }
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn toggle_item_tag(path: String, tag_color: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = load_tags_map();
        let entry = map.entry(path).or_default();
        if let Some(pos) = entry.iter().position(|t| t == &tag_color) {
            entry.remove(pos);
        } else {
            entry.push(tag_color);
        }
        let updated = entry.clone();
        save_tags_map(&map)?;
        Ok(updated)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_files_by_tag(tag_color: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let map = load_tags_map();
        let open_cfg = load_open_with_config();
        let mut entries = Vec::new();
        for (path_str, colors) in &map {
            if colors.contains(&tag_color) {
                let p = Path::new(path_str);
                if p.exists() {
                    if let Some(entry) = build_file_entry_with_cfg(p, &map, &open_cfg, false) {
                        entries.push(entry);
                    }
                }
            }
        }
        entries.sort_by_cached_key(|a| a.name.to_lowercase());
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn get_recent_files_sync(show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    let home = effective_user_home_dir();
    let search_roots: Vec<PathBuf> = [
        effective_user_subdir(dirs::desktop_dir, "Desktop"),
        effective_user_subdir(dirs::document_dir, "Documents"),
        effective_user_subdir(dirs::download_dir, "Downloads"),
        effective_user_subdir(dirs::picture_dir, "Pictures"),
        Some(home),
    ]
    .into_iter()
    .flatten()
    .collect();

    let combined_mtime: u128 = search_roots
        .iter()
        .fold(0u128, |acc, p| acc.wrapping_mul(131).wrapping_add(path_mtime_ns(p)));
    let config_ver = META_CONFIG_VERSION.load(Ordering::Relaxed);
    let cache_mutex = RECENTS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if combined_mtime > 0 {
        if let Ok(guard) = cache_mutex.lock() {
            if let Some(cached) = guard.get(&show_hidden) {
                if cached.mtime_ns == combined_mtime
                    && cached.config_ver == config_ver
                    && cached.updated_at.elapsed().as_secs() < 20
                {
                    return Ok(cached.entries.clone());
                }
            }
        }
    }

    let tags_map = load_tags_map();
    let open_cfg = load_open_with_config();
    let mut seen = std::collections::HashSet::new();
    let mut recent = Vec::new();

    for root_opt in search_roots {
        if let Ok(read_dir) = fs::read_dir(&root_opt) {
            for item in read_dir.flatten() {
                let file_name = item.file_name();
                let name_str = file_name.to_string_lossy();
                if !show_hidden && name_str.starts_with('.') {
                    continue;
                }
                let is_dir = item.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                if is_dir {
                    continue;
                }
                let p = item.path();
                let p_str = p.to_string_lossy().to_string();
                if seen.contains(&p_str) {
                    continue;
                }
                seen.insert(p_str);
                if let Some(entry) = build_file_entry_with_cfg(&p, &tags_map, &open_cfg, false) {
                    recent.push(entry);
                }
            }
        }
    }

    recent.sort_by(|a, b| b.modified.cmp(&a.modified));
    recent.truncate(60);

    if let Ok(mut guard) = cache_mutex.lock() {
        guard.insert(
            show_hidden,
            CachedDirList {
                mtime_ns: combined_mtime,
                config_ver,
                updated_at: Instant::now(),
                entries: recent.clone(),
            },
        );
    }

    Ok(recent)
}

#[tauri::command]
pub async fn get_recent_files(show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || get_recent_files_sync(show_hidden))
        .await
        .map_err(|e| e.to_string())?
}

static MAIN_WINDOW_WAS_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn is_main_window_shown() -> bool {
    MAIN_WINDOW_WAS_SHOWN.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
pub fn show_main_window(window: tauri::WebviewWindow) {
    if window.label() == "main" {
        MAIN_WINDOW_WAS_SHOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    crate::download_server::activate_window_cross_desktop(&window);
}

#[tauri::command]
pub fn close_main_window(window: tauri::WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub async fn get_image_thumbnail(
    path: String,
    max_size: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        if !p.exists() || !p.is_file() {
            return Err("File does not exist".to_string());
        }

        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        // SVG files are vector images, return original path directly
        if ext == "svg" {
            return Ok(path);
        }

        let is_image = matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "jfif"
        );
        if !is_image {
            return Err("Not a supported image".to_string());
        }

        let target_size = max_size.unwrap_or(256).clamp(32, 512);
        let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());

        // 1. Check Linux FreeDesktop thumbnail cache (instant hit for existing system thumbs)
        if let Some(home) = dirs::home_dir() {
            use md5::Digest;
            let uri = format!("file://{}", canonical.to_string_lossy());
            let md5_hash: String = md5::Md5::digest(uri.as_bytes())
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect();
            let sub_dir = if target_size <= 128 { "normal" } else { "large" };
            let fd_thumb = home.join(format!(".cache/thumbnails/{}/{}.png", sub_dir, md5_hash));
            if fd_thumb.exists() {
                if let (Ok(m1), Ok(m2)) = (
                    p.metadata().and_then(|m| m.modified()),
                    fd_thumb.metadata().and_then(|m| m.modified()),
                ) {
                    if m2 >= m1 {
                        return Ok(fd_thumb.to_string_lossy().to_string());
                    }
                } else {
                    return Ok(fd_thumb.to_string_lossy().to_string());
                }
            }
        }

        // 2. Check App-specific persistent thumbnail cache
        let metadata = p.metadata().map_err(|e| e.to_string())?;
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let file_size = metadata.len();

        // JPEG cannot store alpha. Keep an alpha-capable cache format for image
        // types that may contain transparent pixels; JPEG inputs remain compact.
        let thumbnail_extension = if matches!(
            ext.as_str(),
            "png" | "gif" | "webp" | "bmp" | "ico" | "avif"
        ) {
            "png"
        } else {
            "jpg"
        };

        let cache_dir = dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("vfinder/thumbnails");
        let _ = fs::create_dir_all(&cache_dir);

        use md5::Digest;
        let key = format!("{}:{}:{}:{}", canonical.to_string_lossy(), mtime, file_size, target_size);
        let cache_hash: String = md5::Md5::digest(key.as_bytes())
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        let cache_file = cache_dir.join(format!("{}.{}", cache_hash, thumbnail_extension));

        if cache_file.exists() && cache_file.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(cache_file.to_string_lossy().to_string());
        }

        // 3. Generate downscaled thumbnail using image crate
        // Skip files > 100MB to avoid excessive memory usage
        if file_size > 100 * 1024 * 1024 {
            return Err("Image too large for thumbnail".to_string());
        }

        let img = image::open(&canonical).map_err(|e| e.to_string())?;
        let thumb = img.thumbnail(target_size, target_size);

        // Save using the cache format selected above so transparent pixels survive.
        thumb.save(&cache_file).map_err(|e| e.to_string())?;

        Ok(cache_file.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_file_info(path: String) -> Result<FileEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_input_path(&path);
        if let Some((archive_path, subpath)) = split_archive_path(&resolved) {
            if !subpath.as_os_str().is_empty() {
                return get_archive_entry_file_entry(&archive_path, &subpath);
            }
        }
        let tags_map = load_tags_map();
        build_file_entry(&resolved, &tags_map, true)
            .ok_or_else(|| "Failed to get item info".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_file_executable(path: String, executable: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let item_path = Path::new(&path);
        let target_buf = if let Ok(target) = fs::canonicalize(item_path) {
            target
        } else {
            item_path.to_path_buf()
        };
        let target_path = target_buf.as_path();

        let metadata = fs::metadata(target_path)
            .or_else(|_| fs::symlink_metadata(item_path))
            .map_err(|error| format!("Could not read file permissions: {error}"))?;
        if metadata.is_dir() {
            return Err("Executable permission can only be changed for regular files".to_string());
        }

        let current_mode = metadata.permissions().mode();
        let updated_mode = if executable {
            current_mode | 0o111
        } else {
            current_mode & !0o111
        };
        let mut permissions = metadata.permissions();
        permissions.set_mode(updated_mode);
        let chmod_arg = if executable { "+x" } else { "-x" };
        let item_str = target_path.to_string_lossy().to_string();
        execute_privileged_task(
            || fs::set_permissions(target_path, permissions.clone()),
            &["chmod", chmod_arg, &item_str],
        )?;
        bump_cache_version();
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn arm_external_drag(paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    crate::set_armed_drag_paths(paths);
    Ok(())
}

#[tauri::command]
pub fn disarm_external_drag() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    crate::set_armed_drag_paths(Vec::new());
    Ok(())
}

#[tauri::command]
pub fn check_finder_drag(
    dropped_paths: Option<Vec<String>>,
    consume: bool,
) -> Result<bool, String> {
    Ok(crate::check_is_finder_drag(
        dropped_paths.as_deref(),
        consume,
    ))
}

#[tauri::command]
pub async fn save_dropped_urls(
    urls: Vec<String>,
    destination_dir: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest_root = Path::new(&destination_dir);
        if !dest_root.is_dir() {
            return Err("Destination is not a directory".to_string());
        }

        let mut saved_paths = Vec::new();

        for raw_url in urls {
            let url = raw_url.trim();
            if url.is_empty() {
                continue;
            }

            if let Some(rest) = url.strip_prefix("data:") {
                if let Some((meta, b64_part)) = rest.split_once(";base64,") {
                    let ext = match meta {
                        "image/png" => "png",
                        "image/jpeg" | "image/jpg" => "jpg",
                        "image/gif" => "gif",
                        "image/webp" => "webp",
                        "image/svg+xml" => "svg",
                        "application/pdf" => "pdf",
                        _ => "bin",
                    };
                    if let Ok(bytes) = BASE64.decode(b64_part.trim()) {
                        let target =
                            unique_destination_path(dest_root, &format!("dropped-image.{}", ext));
                        fs::write(&target, bytes).map_err(|e| e.to_string())?;
                        saved_paths.push(target.to_string_lossy().to_string());
                    }
                }
                continue;
            }

            if url.starts_with("http://") || url.starts_with("https://") {
                let without_query = url.split('?').next().unwrap_or(url);
                let without_hash = without_query.split('#').next().unwrap_or(without_query);
                let raw_segment = without_hash
                    .rsplit('/')
                    .next()
                    .unwrap_or("downloaded-file")
                    .trim();
                let sanitized: String = raw_segment
                    .chars()
                    .map(|c| {
                        if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
                let base_name = if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
                    "downloaded-file".to_string()
                } else {
                    sanitized
                };

                let target = unique_destination_path(dest_root, &base_name);
                let target_str = target.to_string_lossy().to_string();

                let status = Command::new("curl")
                    .args([
                        "-fsSL",
                        "-L",
                        "--max-time",
                        "25",
                        "-A",
                        "Mozilla/5.0 (X11; Linux x86_64) vFinder/1.0",
                        "-o",
                        &target_str,
                        url,
                    ])
                    .status();

                match status {
                    Ok(s) if s.success() && target.exists() => {
                        saved_paths.push(target_str);
                    }
                    _ => {
                        let _ = fs::remove_file(&target);
                    }
                }
            }
        }

        if saved_paths.is_empty() {
            return Err("Could not save dropped URL(s)".to_string());
        }

        Ok(saved_paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn start_download(
    app: AppHandle,
    args: crate::download_manager::StartDownloadArgs,
) -> Result<(), String> {
    crate::download_manager::start_download(app, args);
    Ok(())
}

#[tauri::command]
pub fn cancel_download(id: String) -> Result<bool, String> {
    Ok(crate::download_manager::cancel_download(&id))
}

#[tauri::command]
pub fn get_default_downloads_dir() -> Result<String, String> {
    Ok(crate::download_manager::get_default_downloads_dir())
}

#[tauri::command]
pub fn get_pending_downloads(window: tauri::WebviewWindow) -> Result<Vec<crate::download_server::InterceptedDownloadPayload>, String> {
    Ok(crate::download_server::take_pending_downloads_for_window(window.label()))
}

static AUDIO_EMPTY_TRASH: &[u8] = include_bytes!("../audio-assets/empty-trash.ogg");
static AUDIO_FILE_TRASH: &[u8] = include_bytes!("../audio-assets/file-trash.ogg");
static AUDIO_MOVE_COPY: &[u8] = include_bytes!("../audio-assets/move-copy.ogg");

#[tauri::command]
pub fn play_sound_effect(name: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let bytes: &[u8] = match name.as_str() {
            "empty-trash" => AUDIO_EMPTY_TRASH,
            "file-trash" => AUDIO_FILE_TRASH,
            "move-copy" => AUDIO_MOVE_COPY,
            _ => return,
        };

        let temp_dir = std::env::temp_dir().join("vfinder-audio");
        let _ = std::fs::create_dir_all(&temp_dir);
        let temp_file = temp_dir.join(format!("{name}.ogg"));

        // Only write if not already existing or size differs
        let needs_write = match std::fs::metadata(&temp_file) {
            Ok(meta) => meta.len() != bytes.len() as u64,
            Err(_) => true,
        };
        if needs_write {
            let _ = std::fs::write(&temp_file, bytes);
        }

        // Try canberra-gtk-play first (standard desktop sound provider on Linux/GNOME/GTK)
        if Command::new("canberra-gtk-play")
            .arg(format!("--file={}", temp_file.display()))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return;
        }

        // Fallback: pw-play (PipeWire)
        if Command::new("pw-play")
            .arg(&temp_file)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return;
        }

        // Fallback: paplay (PulseAudio)
        let _ = Command::new("paplay")
            .arg(&temp_file)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_partitions() {
        let vols = list_system_partitions();
        println!("=== FOUND {} VOLUMES ===", vols.len());
        for v in &vols {
            println!(
                "Volume: name='{}', device='{}', fstype='{}', is_removable={}, is_system={}, is_mounted={}, mount='{}'",
                v.name, v.device, v.file_system, v.is_removable, v.is_system, v.is_mounted, v.mount_point
            );
        }
    }

    #[test]
    fn test_archive_filename_recognition() {
        assert!(is_archive_filename("test.zip"));
        assert!(is_archive_filename("test.tar.gz"));
        assert!(is_archive_filename("test.tgz"));
        assert!(is_archive_filename("test.tar.bz2"));
        assert!(is_archive_filename("test.tbz2"));
        assert!(is_archive_filename("test.tar.xz"));
        assert!(is_archive_filename("test.txz"));
        assert!(is_archive_filename("test.tar.zst"));
        assert!(is_archive_filename("test.tar"));
        assert!(!is_archive_filename("test.txt"));
        assert!(!is_archive_filename("test.png"));
        assert!(!is_archive_filename("test.pdf"));
    }

    #[test]
    fn test_zip_virtual_browsing_and_preview() {
        use std::io::Write;
        let tmp_dir = std::env::temp_dir().join("vfinder_test_zip");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();
        let zip_path = tmp_dir.join("sample.zip");

        // Create a test ZIP archive
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);

            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            writer.start_file("file1.txt", options).unwrap();
            writer.write_all(b"Hello World").unwrap();

            writer.start_file("docs/guide.md", options).unwrap();
            writer.write_all(b"# Guide Content").unwrap();

            writer.start_file("docs/deep/nested.txt", options).unwrap();
            writer.write_all(b"Deep file content").unwrap();

            writer.finish().unwrap();
        }

        // Test split_archive_path
        let (arch, sub) = split_archive_path(&zip_path).unwrap();
        assert_eq!(arch, zip_path);
        assert_eq!(sub.as_os_str(), "");

        let (arch2, sub2) = split_archive_path(&zip_path.join("docs")).unwrap();
        assert_eq!(arch2, zip_path);
        assert_eq!(sub2, PathBuf::from("docs"));

        let (arch3, sub3) = split_archive_path(&zip_path.join("docs/guide.md")).unwrap();
        assert_eq!(arch3, zip_path);
        assert_eq!(sub3, PathBuf::from("docs/guide.md"));

        // Test root entries via read_archive_directory_sync and read_directory_sync
        let root_entries = read_archive_directory_sync(&zip_path, Path::new(""), false).unwrap();
        assert_eq!(root_entries.len(), 2);
        let names: Vec<String> = root_entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"file1.txt".to_string()));
        assert!(names.contains(&"docs".to_string()));

        // Ensure read_directory_sync directly resolves archive path both with and without trailing slash
        let sync_entries = read_directory_sync(zip_path.to_string_lossy().to_string(), false).unwrap();
        assert_eq!(sync_entries.len(), 2);
        let sync_slash_entries = read_directory_sync(format!("{}/", zip_path.to_string_lossy()), false).unwrap();
        assert_eq!(sync_slash_entries.len(), 2);

        let docs_entry = root_entries.iter().find(|e| e.name == "docs").unwrap();
        assert!(docs_entry.is_dir);
        assert_eq!(docs_entry.child_count, Some(2)); // guide.md and deep

        let file1_entry = root_entries.iter().find(|e| e.name == "file1.txt").unwrap();
        assert!(!file1_entry.is_dir);
        assert_eq!(file1_entry.size, 11);

        // Test subfolder entries
        let docs_entries = read_archive_directory_sync(&zip_path, Path::new("docs"), false).unwrap();
        assert_eq!(docs_entries.len(), 2);
        let docs_names: Vec<String> = docs_entries.iter().map(|e| e.name.clone()).collect();
        assert!(docs_names.contains(&"guide.md".to_string()));
        assert!(docs_names.contains(&"deep".to_string()));

        // Test single file on-demand cache extraction
        let extracted = extract_single_archive_entry_to_cache(&zip_path, Path::new("docs/guide.md")).unwrap();
        assert!(extracted.exists());
        let content = fs::read_to_string(&extracted).unwrap();
        assert_eq!(content, "# Guide Content");

        // Test search inside archive
        let search_results = search_archive_sync(&zip_path, Path::new(""), "guide", false).unwrap();
        assert_eq!(search_results.len(), 1);
        assert_eq!(search_results[0].name, "guide.md");

        // Test extracting/moving archive item to a normal destination directory
        let out_dir = tmp_dir.join("dest_folder");
        fs::create_dir_all(&out_dir).unwrap();
        extract_archive_entry_or_dir(&zip_path, "docs/guide.md", &out_dir).unwrap();
        assert!(out_dir.join("guide.md").exists());
        assert_eq!(fs::read_to_string(out_dir.join("guide.md")).unwrap(), "# Guide Content");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_tar_gz_virtual_browsing_and_preview() {
        let tmp_dir = std::env::temp_dir().join("vfinder_test_tar");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();
        let tar_path = tmp_dir.join("sample.tar.gz");

        // Create a test TAR.GZ archive
        {
            let file = fs::File::create(&tar_path).unwrap();
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut tar_builder = tar::Builder::new(encoder);

            let data1 = b"Hello from TAR.GZ";
            let mut header1 = tar::Header::new_gnu();
            header1.set_size(data1.len() as u64);
            header1.set_mode(0o644);
            header1.set_cksum();
            tar_builder.append_data(&mut header1, "root_file.txt", &data1[..]).unwrap();

            let data2 = b"<svg><circle/></svg>";
            let mut header2 = tar::Header::new_gnu();
            header2.set_size(data2.len() as u64);
            header2.set_mode(0o644);
            header2.set_cksum();
            tar_builder.append_data(&mut header2, "assets/icon.svg", &data2[..]).unwrap();

            tar_builder.finish().unwrap();
        }

        // Test root entries
        let root_entries = read_archive_directory_sync(&tar_path, Path::new(""), false).unwrap();
        assert_eq!(root_entries.len(), 2);
        let names: Vec<String> = root_entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"root_file.txt".to_string()));
        assert!(names.contains(&"assets".to_string()));

        let assets_entry = root_entries.iter().find(|e| e.name == "assets").unwrap();
        assert!(assets_entry.is_dir);

        // Test subfolder entries
        let assets_entries = read_archive_directory_sync(&tar_path, Path::new("assets"), false).unwrap();
        assert_eq!(assets_entries.len(), 1);
        assert_eq!(assets_entries[0].name, "icon.svg");
        assert_eq!(assets_entries[0].kind, "SVG Vector Image");

        // Test single file on-demand cache extraction
        let extracted = extract_single_archive_entry_to_cache(&tar_path, Path::new("assets/icon.svg")).unwrap();
        assert!(extracted.exists());
        let content = fs::read_to_string(&extracted).unwrap();
        assert_eq!(content, "<svg><circle/></svg>");

        // Test extracting/moving archive item to a normal destination directory
        let out_dir = tmp_dir.join("tar_dest_folder");
        fs::create_dir_all(&out_dir).unwrap();
        extract_archive_entry_or_dir(&tar_path, "assets/icon.svg", &out_dir).unwrap();
        assert!(out_dir.join("icon.svg").exists());
        assert_eq!(fs::read_to_string(out_dir.join("icon.svg")).unwrap(), "<svg><circle/></svg>");

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}


