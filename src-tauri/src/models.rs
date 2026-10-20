use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub size: u64,
    pub modified: i64,
    pub created: i64,
    pub extension: String,
    pub kind: String,
    pub mime_type: String,
    pub permissions: String,
    pub is_readonly: bool,
    pub child_count: Option<usize>,
    pub tags: Vec<String>,
    pub default_app: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithConfig {
    #[serde(default)]
    pub by_path: HashMap<String, String>,
    #[serde(default)]
    pub by_extension: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDirectory {
    pub id: String,
    pub name: String,
    pub path: String,
    pub icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub name: String,
    pub device: String,
    pub short_device: String,
    pub mount_point: String,
    pub is_mounted: bool,
    pub can_unmount: bool,
    pub total_space: u64,
    pub available_space: u64,
    pub used_space: u64,
    pub file_system: String,
    pub is_removable: bool,
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarData {
    pub home_dir: String,
    pub os_name: String,
    pub favorites: Vec<UserDirectory>,
    pub volumes: Vec<VolumeInfo>,
    pub tags: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub mime_type: String,
    pub size: u64,
    pub modified: i64,
    pub created: i64,
    pub permissions: String,
    pub is_dir: bool,
    pub child_count: Option<usize>,
    pub preview_type: String,
    pub text_content: Option<String>,
    pub data_url: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatTypeOption {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_available: bool,
}

