import React, { useState, useEffect, useRef } from "react";
import {
  Download,
  Folder,
  File,
  FileText,
  FileArchive,
  Image,
  Music,
  Video,
  Code,
  ExternalLink,
  Search,
  X,
  Plus,
  Trash2,
  Globe,
  CheckCircle2,
  AlertCircle,
  HardDrive,
  Monitor,
} from "lucide-react";
import {
  InterceptedDownload,
  DownloadItem,
  formatBytes,
} from "../types";

/* ============================================================================
 * HELPER: File Icon by Filename Extension
 * ========================================================================== */
function getDownloadIcon(filename: string, className = "w-8 h-8") {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (
    ["zip", "tar", "gz", "tgz", "xz", "txz", "7z", "rar", "bz2", "tbz", "tbz2", "zst", "tzst", "lzma", "deb", "rpm"].includes(ext)
  ) {
    return <FileArchive className={`${className} text-amber-500`} />;
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) {
    return <Image className={`${className} text-emerald-500`} />;
  }
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].includes(ext)) {
    return <Music className={`${className} text-pink-500`} />;
  }
  if (["mp4", "mkv", "mov", "avi", "webm", "m4v"].includes(ext)) {
    return <Video className={`${className} text-purple-500`} />;
  }
  if (["pdf", "doc", "docx", "txt", "md", "rtf", "odt", "csv", "xlsx", "xls"].includes(ext)) {
    return <FileText className={`${className} text-[#0a84ff]`} />;
  }
  if (["js", "ts", "json", "py", "rs", "c", "cpp", "h", "html", "css", "sh"].includes(ext)) {
    return <Code className={`${className} text-orange-500`} />;
  }
  return <File className={`${className} text-zinc-400`} />;
}

/* ============================================================================
 * 1. DOWNLOAD PROMPT MODAL (Save As / Where to store)
 * ========================================================================== */
interface DownloadPromptModalProps {
  download: InterceptedDownload;
  currentPath: string;
  defaultDownloadsDir: string;
  darkMode: boolean;
  onClose: () => void;
  onConfirm: (destinationDir: string, filename: string) => void;
}

export const DownloadPromptModal: React.FC<DownloadPromptModalProps> = ({
  download,
  currentPath,
  defaultDownloadsDir,
  darkMode,
  onClose,
  onConfirm,
}) => {
  const [filename, setFilename] = useState(download.filename || "downloaded-file");
  const [destinationDir, setDestinationDir] = useState(() => {
    return defaultDownloadsDir || "~/Downloads";
  });
  const [customPathInput, setCustomPathInput] = useState(false);

  const filenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus and highlight name without extension
    if (filenameInputRef.current) {
      filenameInputRef.current.focus();
      const dotIdx = filename.lastIndexOf(".");
      if (dotIdx > 0) {
        filenameInputRef.current.setSelectionRange(0, dotIdx);
      } else {
        filenameInputRef.current.select();
      }
    }
  }, []);

  // Keyboard escape & enter
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (filename.trim() && destinationDir.trim()) {
          onConfirm(destinationDir.trim(), filename.trim());
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [filename, destinationDir, onClose, onConfirm]);

  // Extract domain from URL
  let host = "web";
  try {
    if (download.url.startsWith("http")) {
      host = new URL(download.url).hostname;
    } else if (download.url.startsWith("blob:")) {
      host = "in-memory web blob";
    }
  } catch (e) {}

  const homeDir = defaultDownloadsDir && defaultDownloadsDir.endsWith("/Downloads")
    ? defaultDownloadsDir.slice(0, -"/Downloads".length)
    : "";
  const desktopDir = homeDir ? `${homeDir}/Desktop` : "";
  const documentsDir = homeDir ? `${homeDir}/Documents` : "";

  const quickFolders = [
    {
      id: "current",
      name: "Current Folder",
      path: currentPath && currentPath !== "__RECENTS__" && currentPath !== "__TRASH__" ? currentPath : defaultDownloadsDir,
      icon: Folder,
    },
    ...(defaultDownloadsDir
      ? [
          {
            id: "downloads",
            name: "Downloads",
            path: defaultDownloadsDir,
            icon: Download,
          },
        ]
      : []),
    ...(desktopDir
      ? [
          {
            id: "desktop",
            name: "Desktop",
            path: desktopDir,
            icon: Monitor,
          },
        ]
      : []),
    ...(documentsDir
      ? [
          {
            id: "documents",
            name: "Documents",
            path: documentsDir,
            icon: FileText,
          },
        ]
      : []),
  ];

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4 animate-in fade-in duration-150"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-[460px] max-w-[94vw] rounded-2xl border shadow-2xl overflow-hidden backdrop-blur-2xl text-xs select-none transition-all ${
          darkMode
            ? "bg-[#28282e]/95 border-white/15 text-zinc-100"
            : "bg-[#f5f5f7]/95 border-black/15 text-zinc-900"
        }`}
      >
        {/* macOS Titlebar */}
        <div
          className={`h-9 px-3 border-b flex items-center justify-between ${
            darkMode ? "border-white/10" : "border-black/10"
          }`}
        >
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="w-3 h-3 rounded-full bg-[#ff5f57] border border-[#e0443e] flex items-center justify-center hover:opacity-85 transition-opacity cursor-pointer p-0"
          >
            <svg
              viewBox="0 0 12 12"
              className="w-2 h-2 text-black/80 pointer-events-none"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            >
              <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" />
            </svg>
          </button>
          <span className="font-semibold text-xs tracking-tight">New Download</span>
          <span className="w-3" />
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4">
          {/* Header Row: File Icon + Source & Size */}
          <div className="flex items-center gap-3.5">
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 border shadow-sm ${
                darkMode ? "bg-white/5 border-white/10" : "bg-black/5 border-black/10"
              }`}
            >
              {getDownloadIcon(filename, "w-6 h-6")}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] opacity-70">
                <Globe className="w-3 h-3 shrink-0" />
                <span className="truncate font-mono">{host}</span>
              </div>
              <div className="text-[11px] opacity-60 mt-0.5">
                {download.totalBytes > 0
                  ? `Size: ${formatBytes(download.totalBytes)}`
                  : "Size: Streaming / Unknown"}
              </div>
            </div>
          </div>

          {/* Filename Input */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium opacity-75">Save As:</label>
            <input
              ref={filenameInputRef}
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              className={`w-full px-3 py-1.5 rounded-lg border text-xs outline-none transition focus:ring-2 focus:ring-[#0a84ff]/50 ${
                darkMode
                  ? "bg-black/20 border-white/15 focus:border-[#0a84ff]"
                  : "bg-white border-black/15 focus:border-[#0a84ff]"
              }`}
              placeholder="Filename"
            />
          </div>

          {/* Destination Location */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium opacity-75">Where:</label>
              <button
                type="button"
                onClick={() => setCustomPathInput((v) => !v)}
                className="text-[10px] text-[#0a84ff] hover:underline cursor-pointer"
              >
                {customPathInput ? "Show quick folders" : "Edit path manually"}
              </button>
            </div>

            {customPathInput ? (
              <input
                type="text"
                value={destinationDir}
                onChange={(e) => setDestinationDir(e.target.value)}
                className={`w-full px-3 py-1.5 rounded-lg border text-xs font-mono outline-none transition focus:ring-2 focus:ring-[#0a84ff]/50 ${
                  darkMode
                    ? "bg-black/20 border-white/15 focus:border-[#0a84ff]"
                    : "bg-white border-black/15 focus:border-[#0a84ff]"
                }`}
                placeholder="/path/to/folder"
              />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {quickFolders.map((qf) => {
                  const active = destinationDir === qf.path;
                  const Icon = qf.icon;
                  return (
                    <button
                      key={qf.id}
                      type="button"
                      onClick={() => setDestinationDir(qf.path)}
                      className={`px-2.5 py-2 rounded-xl border text-left flex items-center gap-2 transition cursor-pointer ${
                        active
                          ? "bg-[#0a84ff] text-white border-[#0a84ff] shadow-sm font-medium"
                          : darkMode
                          ? "bg-white/5 border-white/10 hover:bg-white/10 text-zinc-300"
                          : "bg-black/5 border-black/10 hover:bg-black/10 text-zinc-700"
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      <div className="min-w-0 flex-1 truncate text-[11px]">
                        {qf.name}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="text-[10px] opacity-50 truncate pt-0.5 px-0.5 font-mono">
              Target: {destinationDir}/{filename}
            </div>
          </div>
        </div>

        {/* Footer Buttons */}
        <div
          className={`h-12 px-5 border-t flex items-center justify-end gap-2.5 ${
            darkMode ? "border-white/10 bg-black/10" : "border-black/10 bg-black/[0.02]"
          }`}
        >
          <button
            type="button"
            onClick={onClose}
            className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition cursor-pointer ${
              darkMode
                ? "bg-white/10 border-white/10 hover:bg-white/15 text-zinc-200"
                : "bg-white border-black/10 hover:bg-zinc-100 text-zinc-700 shadow-sm"
            }`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (filename.trim() && destinationDir.trim()) {
                onConfirm(destinationDir.trim(), filename.trim());
              }
            }}
            disabled={!filename.trim() || !destinationDir.trim()}
            className="px-4 py-1.5 rounded-lg bg-[#0a84ff] text-white text-xs font-medium hover:bg-[#0071e3] transition shadow-sm disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * 2. DOWNLOADS POPOVER (Toolbar active & recent downloads list)
 * ========================================================================== */
interface DownloadsPopoverProps {
  downloads: DownloadItem[];
  darkMode: boolean;
  onClose: () => void;
  onShowInFolder: (targetPath: string) => void;
  onOpenFile: (targetPath: string) => void;
  onCancelDownload: (id: string) => void;
  onClearCompleted: () => void;
  onManualDownloadUrl?: (url: string) => void;
}

export const DownloadsPopover: React.FC<DownloadsPopoverProps> = ({
  downloads,
  darkMode,
  onClose,
  onShowInFolder,
  onOpenFile,
  onCancelDownload,
  onClearCompleted,
  onManualDownloadUrl,
}) => {
  const [manualInputOpen, setManualInputOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  const activeCount = downloads.filter((d) => d.status === "downloading").length;

  return (
    <div
      ref={popoverRef}
      className={`absolute right-12 top-11 w-80 max-w-[90vw] rounded-2xl border shadow-2xl overflow-hidden backdrop-blur-2xl text-xs z-50 select-none animate-in fade-in zoom-in-95 duration-100 ${
        darkMode
          ? "bg-[#28282e]/95 border-white/15 text-zinc-100"
          : "bg-white/95 border-black/15 text-zinc-900 shadow-xl"
      }`}
    >
      {/* Header */}
      <div
        className={`h-9 px-3.5 border-b flex items-center justify-between ${
          darkMode ? "border-white/10" : "border-black/10"
        }`}
      >
        <div className="flex items-center gap-1.5 font-semibold text-xs">
          <Download className="w-3.5 h-3.5 text-[#0a84ff]" />
          <span>Downloads</span>
          {activeCount > 0 && (
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-[#0a84ff] text-[9px] text-white font-bold">
              {activeCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onManualDownloadUrl && (
            <button
              type="button"
              onClick={() => setManualInputOpen((v) => !v)}
              title="Download from direct URL"
              className="p-1 rounded-md opacity-60 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {downloads.length > 0 && (
            <button
              type="button"
              onClick={onClearCompleted}
              title="Clear completed downloads"
              className="text-[10px] opacity-60 hover:opacity-100 hover:text-[#ff453a] px-1.5 py-0.5 rounded transition cursor-pointer"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md opacity-60 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 transition cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Optional Manual Download URL Input */}
      {manualInputOpen && (
        <div className="p-2.5 border-b border-current/10 flex items-center gap-2 bg-current/5">
          <input
            type="url"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manualUrl.trim()) {
                onManualDownloadUrl?.(manualUrl.trim());
                setManualUrl("");
                setManualInputOpen(false);
              }
            }}
            placeholder="Paste download URL..."
            className={`flex-1 px-2.5 py-1 text-xs rounded-md border outline-none ${
              darkMode ? "bg-black/30 border-white/10" : "bg-white border-black/10"
            }`}
            autoFocus
          />
          <button
            type="button"
            onClick={() => {
              if (manualUrl.trim()) {
                onManualDownloadUrl?.(manualUrl.trim());
                setManualUrl("");
                setManualInputOpen(false);
              }
            }}
            disabled={!manualUrl.trim()}
            className="px-2 py-1 rounded bg-[#0a84ff] text-white text-[11px] font-medium disabled:opacity-50"
          >
            Go
          </button>
        </div>
      )}

      {/* Downloads List */}
      <div className="max-h-72 overflow-y-auto divide-y divide-current/5">
        {downloads.length === 0 ? (
          <div className="py-8 px-4 text-center opacity-50 space-y-1">
            <Download className="w-7 h-7 mx-auto stroke-1 opacity-60 mb-2" />
            <div className="font-medium text-xs">No Downloads</div>
            <div className="text-[10px]">
              Files downloaded from Chrome will appear here.
            </div>
          </div>
        ) : (
          downloads.map((item) => {
            const isDownloading = item.status === "downloading";
            const isCompleted = item.status === "completed";
            const isFailed = item.status === "failed";
            const isCancelled = item.status === "cancelled";

            return (
              <div
                key={item.id}
                className="p-3 flex items-center gap-2.5 hover:bg-current/[0.04] transition group"
              >
                {/* File Icon */}
                <div className="shrink-0">
                  {getDownloadIcon(item.filename, "w-6 h-6")}
                </div>

                {/* Info & Progress */}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-[11px] truncate" title={item.filename}>
                      {item.filename}
                    </span>
                    {isCompleted && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#32d74b] shrink-0" />
                    )}
                    {isFailed && (
                      <AlertCircle className="w-3.5 h-3.5 text-[#ff453a] shrink-0" />
                    )}
                  </div>

                  {/* Progress Bar for Active Download */}
                  {isDownloading && (
                    <div className="w-full bg-current/10 h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-[#0a84ff] h-full rounded-full transition-all duration-200"
                        style={{
                          width: `${item.percentage > 0 ? item.percentage : 15}%`,
                        }}
                      />
                    </div>
                  )}

                  {/* Status / Subtitle Details */}
                  <div className="flex items-center justify-between text-[10px] opacity-65">
                    {isDownloading && (
                      <span>
                        {item.totalBytes > 0
                          ? `${formatBytes(item.downloadedBytes)} of ${formatBytes(item.totalBytes)} • ${item.percentage.toFixed(0)}%`
                          : `${formatBytes(item.downloadedBytes)}`}
                        {item.speed > 0 && ` (${formatBytes(item.speed)}/s)`}
                      </span>
                    )}
                    {isCompleted && (
                      <span className="text-emerald-500 font-medium">
                        {formatBytes(item.totalBytes)} • Finished
                      </span>
                    )}
                    {isFailed && (
                      <span className="text-[#ff453a] truncate">
                        {item.error || "Failed"}
                      </span>
                    )}
                    {isCancelled && (
                      <span className="opacity-60">Cancelled</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="shrink-0 flex items-center gap-0.5 opacity-80 group-hover:opacity-100">
                  {isDownloading && (
                    <button
                      type="button"
                      onClick={() => onCancelDownload(item.id)}
                      title="Cancel Download"
                      className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 text-[#ff453a] transition cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isCompleted && (
                    <>
                      <button
                        type="button"
                        onClick={() => onShowInFolder(item.targetPath)}
                        title="Show in vFinder"
                        className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 transition cursor-pointer"
                      >
                        <Search className="w-3.5 h-3.5 text-[#0a84ff]" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenFile(item.targetPath)}
                        title="Open File"
                        className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 transition cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

/* ============================================================================
 * 3. DOWNLOAD SAVE BAR (Interactive Bottom Bar for Pending Downloads)
 * ========================================================================== */
export interface DownloadSaveBarProps {
  download: InterceptedDownload;
  queueCount: number;
  currentPath: string;
  defaultDownloadsDir: string;
  darkMode: boolean;
  onCancel: () => void;
  onConfirm: (destinationDir: string, filename: string) => void;
}

export const DownloadSaveBar: React.FC<DownloadSaveBarProps> = ({
  download,
  queueCount,
  currentPath,
  defaultDownloadsDir,
  darkMode,
  onCancel,
  onConfirm,
}) => {
  const [filename, setFilename] = useState(download.filename || "downloaded-file");
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync filename when download item changes and focus/select text
  useEffect(() => {
    const initialName = download.filename || "downloaded-file";
    setFilename(initialName);
    if (inputRef.current) {
      inputRef.current.focus();
      const dotIdx = initialName.lastIndexOf(".");
      if (dotIdx > 0) {
        inputRef.current.setSelectionRange(0, dotIdx);
      } else {
        inputRef.current.select();
      }
    }
  }, [download.id, download.filename]);

  const effectiveDestination =
    currentPath && currentPath !== "__RECENTS__" && currentPath !== "__TRASH__"
      ? currentPath
      : defaultDownloadsDir || "~/Downloads";

  const folderName =
    effectiveDestination === "/"
      ? "/"
      : effectiveDestination.split("/").filter(Boolean).pop() || effectiveDestination;

  let host = "";
  try {
    if (download.url.startsWith("http")) {
      host = new URL(download.url).hostname;
    } else if (download.url.startsWith("blob:")) {
      host = "web page blob";
    }
  } catch {}

  const handleConfirm = () => {
    if (filename.trim()) {
      onConfirm(effectiveDestination, filename.trim());
    }
  };

  return (
    <div
      className={`px-4 py-2.5 border-t flex flex-wrap items-center justify-between gap-3 select-none backdrop-blur-xl z-20 transition-all shadow-lg animate-in slide-in-from-bottom duration-150 ${
        darkMode
          ? "bg-[#25252a]/95 border-white/10 text-zinc-100"
          : "bg-[#f4f4f7]/95 border-black/10 text-zinc-800"
      }`}
    >
      {/* Left: File Icon + Save As Label + Rename Input */}
      <div className="flex items-center gap-2.5 flex-1 min-w-[260px]">
        <div className="shrink-0">
          {getDownloadIcon(filename, "w-6 h-6")}
        </div>
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <label className="text-[11px] font-semibold opacity-75 shrink-0">
            Save As:
          </label>
          <input
            ref={inputRef}
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filename.trim()) {
                e.preventDefault();
                handleConfirm();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            placeholder="File name"
            className={`w-full px-2.5 py-1 text-xs rounded-lg border outline-none font-medium transition focus:ring-2 focus:ring-[#0a84ff]/50 ${
              darkMode
                ? "bg-black/30 border-white/15 focus:border-[#0a84ff] text-zinc-100 placeholder:text-zinc-500"
                : "bg-white border-black/15 focus:border-[#0a84ff] text-zinc-900 placeholder:text-zinc-400"
            }`}
          />
        </div>
      </div>

      {/* Center: Save Location (Folder) & Download Details */}
      <div className="flex items-center gap-2 shrink-0 text-xs">
        <span className="text-[11px] font-medium opacity-60">Where:</span>
        <div
          title={`Saving to: ${effectiveDestination}/${filename}`}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs max-w-[220px] truncate ${
            darkMode
              ? "bg-white/5 border-white/10 text-zinc-200"
              : "bg-black/5 border-black/10 text-zinc-800"
          }`}
        >
          <Folder className="w-3.5 h-3.5 text-[#0a84ff] shrink-0" />
          <span className="truncate font-medium">{folderName}</span>
        </div>
        {download.totalBytes > 0 && (
          <span className="text-[11px] opacity-50 shrink-0">
            ({formatBytes(download.totalBytes)})
          </span>
        )}
        {host && (
          <span className="text-[10px] opacity-40 truncate max-w-[140px] font-mono hidden md:inline">
            from {host}
          </span>
        )}
        {queueCount > 1 && (
          <span className="px-1.5 py-0.5 rounded-full bg-[#0a84ff]/20 text-[#0a84ff] text-[10px] font-bold shrink-0">
            1 of {queueCount}
          </span>
        )}
      </div>

      {/* Right: Action Buttons */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onCancel}
          title="Cancel Download (Esc)"
          className={`px-3 py-1 rounded-lg border text-xs font-medium transition cursor-pointer ${
            darkMode
              ? "bg-white/10 border-white/10 hover:bg-white/15 text-zinc-200"
              : "bg-white border-black/10 hover:bg-zinc-100 text-zinc-700 shadow-xs"
          }`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!filename.trim()}
          title="Save file to current folder (Enter)"
          className="px-3.5 py-1 rounded-lg bg-[#0a84ff] hover:bg-[#0071e3] text-white text-xs font-medium transition shadow-xs disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Download</span>
        </button>
      </div>
    </div>
  );
};

