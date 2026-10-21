export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  isHidden: boolean;
  size: number;
  modified: number;
  created: number;
  extension: string;
  kind: string;
  mimeType: string;
  permissions: string;
  isReadonly: boolean;
  childCount?: number | null;
  tags: string[];
  defaultApp?: string | null;
}

export interface UserDirectory {
  id: string;
  name: string;
  path: string;
  icon: string;
}

export interface VolumeInfo {
  name: string;
  device: string;
  shortDevice: string;
  mountPoint: string;
  isMounted: boolean;
  canUnmount: boolean;
  totalSpace: number;
  availableSpace: number;
  usedSpace: number;
  fileSystem: string;
  isRemovable: boolean;
  isSystem: boolean;
}

export interface SidebarData {
  homeDir: string;
  osName?: string;
  favorites: UserDirectory[];
  volumes: VolumeInfo[];
  tags: Record<string, string[]>;
}

export interface FilePreview {
  path: string;
  name: string;
  kind: string;
  mimeType: string;
  size: number;
  modified: number;
  created: number;
  permissions: string;
  isDir: boolean;
  childCount?: number | null;
  previewType: "text" | "image" | "audio" | "video" | "pdf" | "directory" | "binary";
  textContent?: string | null;
  dataUrl?: string | null;
  truncated: boolean;
}

export type ViewMode = "icons" | "list" | "columns" | "gallery";
export type SortField = "name" | "modified" | "size" | "kind";
export type SortDirection = "asc" | "desc";

export interface FinderTab {
  id: string;
  title: string;
  path: string;
  history: string[];
  historyIndex: number;
  activeTag?: string | null;
}

export interface ClipboardState {
  paths: string[];
  mode: "copy" | "cut";
}

export interface TagColorDef {
  id: string;
  name: string;
  hex: string;
  bgClass: string;
  ringClass: string;
}

export const TAG_COLORS: TagColorDef[] = [
  { id: "red", name: "Red", hex: "#ff453a", bgClass: "bg-[#ff453a]", ringClass: "ring-[#ff453a]" },
  { id: "orange", name: "Orange", hex: "#ff9f0a", bgClass: "bg-[#ff9f0a]", ringClass: "ring-[#ff9f0a]" },
  { id: "yellow", name: "Yellow", hex: "#ffd60a", bgClass: "bg-[#ffd60a]", ringClass: "ring-[#ffd60a]" },
  { id: "green", name: "Green", hex: "#32d74b", bgClass: "bg-[#32d74b]", ringClass: "ring-[#32d74b]" },
  { id: "blue", name: "Blue", hex: "#0a84ff", bgClass: "bg-[#0a84ff]", ringClass: "ring-[#0a84ff]" },
  { id: "purple", name: "Purple", hex: "#bf5af2", bgClass: "bg-[#bf5af2]", ringClass: "ring-[#bf5af2]" },
  { id: "gray", name: "Gray", hex: "#8e8e93", bgClass: "bg-[#8e8e93]", ringClass: "ring-[#8e8e93]" },
];

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

const MAC_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const MAC_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const MAC_DATE_CACHE = new Map<number, string>();
let macDateCacheDay = "";

export function formatMacDate(unixSecs: number): string {
  if (!unixSecs) return "—";

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (todayKey !== macDateCacheDay) {
    MAC_DATE_CACHE.clear();
    macDateCacheDay = todayKey;
  }

  const cached = MAC_DATE_CACHE.get(unixSecs);
  if (cached !== undefined) return cached;

  const date = new Date(unixSecs * 1000);
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  const timeStr = MAC_TIME_FORMATTER.format(date);
  const formatted = isToday
    ? `Today at ${timeStr}`
    : `${MAC_DATE_FORMATTER.format(date)} at ${timeStr}`;

  if (MAC_DATE_CACHE.size >= 20_000) {
    const oldestKey = MAC_DATE_CACHE.keys().next().value;
    if (oldestKey !== undefined) MAC_DATE_CACHE.delete(oldestKey);
  }
  MAC_DATE_CACHE.set(unixSecs, formatted);
  return formatted;
}

export interface FormatTypeOption {
  id: string;
  name: string;
  description: string;
  isAvailable: boolean;
}

export interface InterceptedDownload {
  id: string;
  url: string;
  originalUrl?: string;
  filename: string;
  totalBytes: number;
  mime?: string;
  referrer?: string;
  userAgent?: string;
  cookies?: string;
  blobData?: string;
}

export interface DownloadItem {
  id: string;
  filename: string;
  targetPath: string;
  targetDir: string;
  url: string;
  totalBytes: number;
  downloadedBytes: number;
  speed: number; // bytes/sec
  percentage: number;
  status: "downloading" | "completed" | "failed" | "cancelled";
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface DownloadProgressPayload {
  id: string;
  downloadedBytes: number;
  totalBytes: number;
  speed: number;
  percentage: number;
}

export interface DownloadCompletedPayload {
  id: string;
  targetPath: string;
  filename: string;
  totalBytes: number;
}

export interface DownloadFailedPayload {
  id: string;
  error: string;
}


