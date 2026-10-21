use crate::models::{
    FileEntry, FilePreview, FormatTypeOption, OpenWithConfig, SidebarData, UserDirectory,
    VolumeInfo,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
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
    .title("vFinder")
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
    #[serde(rename = "type")]
    #[allow(dead_code)]
    dev_type: Option<String>,
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
    run_sudo_command(password, &["-k", "-v"])?;
    set_cached_sudo_password(Some(password.to_string()));
    Ok(())
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
                if let Some(cached) = get_cached_sudo_password() {
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
                if let Some(cached) = get_cached_sudo_password() {
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
                if let Some(cached) = get_cached_sudo_password() {
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
                if let Some(cached) = get_cached_sudo_password() {
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

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed waiting for check tool: {}", e))?;

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

    let spawn_result = Command::new(bin)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    match spawn_result {
        Ok(_) => Ok(()),
        Err(err) => {
            let lower_bin = bin.to_lowercase();
            if lower_bin != *bin {
                if Command::new(&lower_bin)
                    .args(&args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .is_ok()
                {
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
        "zip" | "tar" | "gz" | "xz" | "zst" | "7z" | "rar" => "Archive".to_string(),
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
        "gz" => "application/gzip",
        "xz" => "application/x-xz",
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

    Some(FileEntry {
        name,
        path: path_str,
        is_dir,
        is_symlink,
        is_hidden,
        size,
        modified,
        created,
        extension,
        kind,
        mime_type,
        permissions,
        is_readonly,
        child_count,
        tags,
        default_app,
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

    Some(FileEntry {
        name,
        path: path_str,
        is_dir,
        is_symlink,
        is_hidden,
        size,
        modified,
        created,
        extension,
        kind,
        mime_type,
        permissions,
        is_readonly,
        child_count,
        tags,
        default_app,
    })
}

fn read_directory_sync(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    if path == "__RECENTS__" {
        return get_recent_files_sync(show_hidden);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let resolved_path = if path.is_empty() || path == "~" {
        home
    } else if let Some(stripped) = path.strip_prefix("~/") {
        home.join(stripped)
    } else {
        PathBuf::from(&path)
    };
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

    let read_dir = fs::read_dir(&resolved_path).map_err(|e| format!("Cannot read {}: {}", resolved_str, e))?;
    let tags_map = load_tags_map();
    let open_cfg = load_open_with_config();

    let mut entries = Vec::with_capacity(64);
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
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let home_str = home.to_string_lossy().to_string();

        let mut favorites = Vec::new();
        let standard_dirs = [
            ("recents", "Recents", Some(PathBuf::from("__RECENTS__")), "clock"),
            ("home", "Home", Some(home.clone()), "home"),
            ("desktop", "Desktop", dirs::desktop_dir(), "monitor"),
            ("documents", "Documents", dirs::document_dir(), "file-text"),
            ("downloads", "Downloads", dirs::download_dir(), "download"),
            ("pictures", "Pictures", dirs::picture_dir(), "image"),
            ("music", "Music", dirs::audio_dir(), "music"),
            ("videos", "Movies", dirs::video_dir(), "film"),
        ];

        for (id, label, dir_opt, icon) in standard_dirs {
            if let Some(p) = dir_opt {
                if id == "recents" || p.exists() {
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
        fs::create_dir_all(&target).map_err(|e| format!("Failed to create folder: {}", e))?;
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
        fs::write(&target, "").map_err(|e| format!("Failed to create file: {}", e))?;
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
        fs::rename(src, &dst).map_err(|e| format!("Failed to rename item: {}", e))?;
        bump_cache_version();

        let dst_str = dst.to_string_lossy().to_string();
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
            if src.is_dir() {
                copy_dir_recursive(src, &target)?;
            } else {
                fs::copy(src, &target).map_err(|e| format!("Copy failed: {}", e))?;
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
            if fs::rename(src, &target).is_err() {
                if src.is_dir() {
                    copy_dir_recursive(src, &target)?;
                    fs::remove_dir_all(src).map_err(|e| e.to_string())?;
                } else {
                    fs::copy(src, &target).map_err(|e| e.to_string())?;
                    fs::remove_file(src).map_err(|e| e.to_string())?;
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

#[tauri::command]
pub async fn trash_items(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for p in paths {
            if let Err(err) = trash::delete(&p) {
                let path = Path::new(&p);
                if path.is_dir() {
                    fs::remove_dir_all(path)
                        .map_err(|e| format!("Trash error ({}): {}", err, e))?;
                } else {
                    fs::remove_file(path)
                        .map_err(|e| format!("Trash error ({}): {}", err, e))?;
                }
            }
        }
        bump_cache_version();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_item(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let cfg = load_open_with_config();
        if let Some(program) = resolve_default_app(&path, &ext, &cfg) {
            return launch_with_program(&path, &program);
        }
        open::that(&path).map_err(|e| format!("Failed to open '{}': {}", path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_item_with(path: String, program: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch_with_program(&path, &program))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_default_app(
    path: String,
    program: String,
    #[allow(unused_variables)] apply_to_extension: Option<bool>,
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
    let file_path = Path::new(&path);
    if !file_path.is_file() {
        return Err("Preview file no longer exists".to_string());
    }
    crate::download_server::register_file_preview(file_path)
}

#[tauri::command]
pub async fn read_file_preview(
    path: String,
    max_bytes: Option<usize>,
) -> Result<FilePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
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
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let root = if root_path.is_empty() || root_path == "~" {
            home
        } else if let Some(stripped) = root_path.strip_prefix("~/") {
            home.join(stripped)
        } else {
            PathBuf::from(&root_path)
        };
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
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let search_roots: Vec<PathBuf> = [
        dirs::desktop_dir(),
        dirs::document_dir(),
        dirs::download_dir(),
        dirs::picture_dir(),
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
        let p = Path::new(&path);
        let tags_map = load_tags_map();
        build_file_entry(p, &tags_map, true)
            .ok_or_else(|| "Failed to get item info".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_webview_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    window.set_zoom(scale).map_err(|e| e.to_string())
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
}


