import { invoke } from "@tauri-apps/api/core";
import { FileEntry, FilePreview, FormatTypeOption, SidebarData, InterceptedDownload } from "./types";

const isTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export async function apiGetSidebarData(): Promise<SidebarData> {
  if (!isTauri()) {
    return {
      homeDir: "~",
      osName: "Linux",
      favorites: [
        { id: "recents", name: "Recents", path: "__RECENTS__", icon: "clock" },
        { id: "home", name: "Home", path: "~", icon: "home" },
        { id: "desktop", name: "Desktop", path: "~/Desktop", icon: "monitor" },
        { id: "documents", name: "Documents", path: "~/Documents", icon: "file-text" },
        { id: "downloads", name: "Downloads", path: "~/Downloads", icon: "download" },
      ],
      volumes: [
        {
          name: "Linux",
          device: "/dev/root",
          shortDevice: "root",
          mountPoint: "/",
          isMounted: true,
          canUnmount: false,
          totalSpace: 140441026560,
          availableSpace: 34516791296,
          usedSpace: 104935788544,
          fileSystem: "btrfs",
          isRemovable: false,
          isSystem: false,
        },
      ],
      tags: {},
    };
  }
  return invoke<SidebarData>("get_sidebar_data");
}

export async function apiGetStartupDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("get_startup_directory");
}

export async function apiMountPartition(
  device: string,
  password?: string
): Promise<string> {
  return invoke<string>("mount_partition", {
    device,
    password: password ?? null,
  });
}

export async function apiUnmountPartition(
  device: string,
  password?: string
): Promise<void> {
  return invoke<void>("unmount_partition", {
    device,
    password: password ?? null,
  });
}

export async function apiReadDirectory(
  path: string,
  showHidden: boolean
): Promise<FileEntry[]> {
  if (path === "__RECENTS__") {
    return apiGetRecentFiles(showHidden);
  }
  if (!isTauri()) {
    return [];
  }
  return invoke<FileEntry[]>("read_directory", { path, showHidden });
}

export async function apiGetRecentFiles(showHidden: boolean): Promise<FileEntry[]> {
  if (!isTauri()) return [];
  return invoke<FileEntry[]>("get_recent_files", { showHidden });
}

export async function apiPrefetchDirectories(
  paths: string[],
  showHidden: boolean
): Promise<Record<string, FileEntry[]>> {
  if (!isTauri() || paths.length === 0) return {};
  return invoke<Record<string, FileEntry[]>>("prefetch_directories", {
    paths,
    showHidden,
  });
}

export async function apiCreateDirectory(
  parentPath: string,
  name: string
): Promise<FileEntry> {
  return invoke<FileEntry>("create_directory", { parentPath, name });
}

export async function apiCreateFile(
  parentPath: string,
  name: string
): Promise<FileEntry> {
  return invoke<FileEntry>("create_file", { parentPath, name });
}

export async function apiRenameItem(
  oldPath: string,
  newName: string
): Promise<FileEntry> {
  return invoke<FileEntry>("rename_item", { oldPath, newName });
}

export async function apiCopyItems(
  sources: string[],
  destinationDir: string
): Promise<string[]> {
  return invoke<string[]>("copy_items", { sources, destinationDir });
}

export async function apiMoveItems(
  sources: string[],
  destinationDir: string
): Promise<string[]> {
  return invoke<string[]>("move_items", { sources, destinationDir });
}

export async function apiDuplicateItem(path: string): Promise<FileEntry> {
  return invoke<FileEntry>("duplicate_item", { path });
}

export async function apiTrashItems(paths: string[]): Promise<void> {
  return invoke<void>("trash_items", { paths });
}

export async function apiOpenItem(path: string): Promise<void> {
  return invoke<void>("open_item", { path });
}

export async function apiOpenItemWith(
  path: string,
  program: string
): Promise<void> {
  return invoke<void>("open_item_with", { path, program });
}

export async function apiSetDefaultApp(
  path: string,
  program: string,
  applyToExtension = false
): Promise<string | null> {
  return invoke<string | null>("set_default_app", {
    path,
    program,
    applyToExtension,
  });
}

export async function apiReadFilePreview(
  path: string,
  maxBytes = 65536
): Promise<FilePreview> {
  return invoke<FilePreview>("read_file_preview", { path, maxBytes });
}

export async function apiGetFilePreviewUrl(path: string): Promise<string> {
  return invoke<string>("get_file_preview_url", { path });
}

export async function apiSearchDirectory(
  rootPath: string,
  query: string,
  showHidden: boolean
): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("search_directory", { rootPath, query, showHidden });
}

export async function apiToggleItemTag(
  path: string,
  tagColor: string
): Promise<string[]> {
  return invoke<string[]>("toggle_item_tag", { path, tagColor });
}

export async function apiGetFilesByTag(tagColor: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("get_files_by_tag", { tagColor });
}

export async function apiShowMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke<void>("show_main_window");
  } catch {
    // ignore if window already shown
  }
}

export async function apiCloseMainWindow(): Promise<void> {
  if (!isTauri()) {
    window.close();
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    try {
      await invoke<void>("close_main_window");
    } catch {
      window.close();
    }
  }
}

export async function apiGetImageThumbnail(
  path: string,
  maxSize = 256
): Promise<string> {
  return invoke<string>("get_image_thumbnail", { path, maxSize });
}

export async function apiGetFileInfo(path: string): Promise<FileEntry> {
  return invoke<FileEntry>("get_file_info", { path });
}

export async function apiGetAvailableFormatTypes(): Promise<FormatTypeOption[]> {
  if (!isTauri()) {
    return [
      {
        id: "vfat",
        name: "MS-DOS (FAT32)",
        description: "Universal compatibility (Mac, Windows, Linux, USBs)",
        isAvailable: true,
      },
      {
        id: "ext4",
        name: "Linux (Ext4)",
        description: "Standard Linux journaling filesystem",
        isAvailable: true,
      },
      {
        id: "btrfs",
        name: "Btrfs (Copy-on-Write)",
        description: "Modern Linux filesystem with snapshots",
        isAvailable: true,
      },
    ];
  }
  return invoke<FormatTypeOption[]>("get_available_format_types");
}

export async function apiFormatPartition(
  device: string,
  fstype: string,
  label: string,
  password?: string
): Promise<void> {
  return invoke<void>("format_partition", {
    device,
    fstype,
    label,
    password: password ?? null,
  });
}

export async function apiCheckPartition(
  device: string,
  password?: string
): Promise<string> {
  return invoke<string>("check_partition", {
    device,
    password: password ?? null,
  });
}

export async function apiSetWebviewZoom(scale = 1.0): Promise<void> {
  return invoke<void>("set_webview_zoom", { scale });
}

export async function apiArmExternalDrag(paths: string[]): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("arm_external_drag", { paths });
}

export async function apiDisarmExternalDrag(): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("disarm_external_drag");
}

export async function apiCheckFinderDrag(
  droppedPaths?: string[],
  consume = false
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("check_finder_drag", {
    droppedPaths: droppedPaths ?? null,
    consume,
  });
}

export async function apiSaveDroppedUrls(
  urls: string[],
  destinationDir: string
): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("save_dropped_urls", {
    urls,
    destinationDir,
  });
}

export async function apiStartDownload(args: {
  id: string;
  url: string;
  targetPath: string;
  totalBytes: number;
  referrer?: string | null;
  userAgent?: string | null;
  cookies?: string | null;
  blobBase64?: string | null;
}): Promise<void> {
  if (isTauri()) {
    await invoke("start_download", { args });
  }
}

export async function apiCancelDownload(id: string): Promise<boolean> {
  if (isTauri()) {
    return await invoke<boolean>("cancel_download", { id });
  }
  return false;
}

export async function apiGetDefaultDownloadsDir(): Promise<string> {
  if (isTauri()) {
    return await invoke<string>("get_default_downloads_dir");
  }
  return "~/Downloads";
}

export async function apiOpenDetachedTab(tab: {
  path: string;
  title: string;
  activeTag?: string | null;
}): Promise<string> {
  if (!isTauri()) throw new Error("Detached tabs require the desktop app");
  return invoke<string>("open_detached_tab_window", {
    path: tab.path,
    title: tab.title,
    activeTag: tab.activeTag ?? null,
  });
}

export async function apiGetPendingDownloads(): Promise<InterceptedDownload[]> {
  if (isTauri()) {
    return await invoke<InterceptedDownload[]>("get_pending_downloads");
  }
  return [];
}




