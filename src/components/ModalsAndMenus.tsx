import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  X,
  ExternalLink,
  FolderPlus,
  FilePlus,
  Copy,
  Scissors,
  ClipboardPaste,
  Trash2,
  Info,
  Edit3,
  Eye,
  Files,
  Archive,
  Star,
  ChevronRight,
  Folder,
  FolderOpen,
  HardDrive,
  Usb,
  Disc,
  Eraser,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
} from "lucide-react";
import {
  FileEntry,
  FilePreview,
  FormatTypeOption,
  TAG_COLORS,
  ViewMode,
  VolumeInfo,
  ArchiveEntryInfo,
  formatBytes,
  formatMacDate,
} from "../types";
import { FileIcon } from "./FileIcon";
import {
  apiReadFilePreview,
  apiGetFilePreviewUrl,
  apiGetAvailableFormatTypes,
  apiReadArchiveContents,
} from "../api";
import { useToolbarOutsideDismiss } from "./useToolbarOutsideDismiss";

/* ============================================================================
 * 1. QUICK LOOK MODAL (Spacebar Preview)
 * ========================================================================== */
interface QuickLookModalProps {
  entry: FileEntry | null;
  onClose: () => void;
  onOpenExternal: (entry: FileEntry) => void;
  darkMode: boolean;
}

export const QuickLookModal: React.FC<QuickLookModalProps> = ({
  entry,
  onClose,
  onOpenExternal,
  darkMode,
}) => {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoErrorCopied, setVideoErrorCopied] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useToolbarOutsideDismiss(dialogRef, Boolean(entry), onClose);

  useLayoutEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    setVideoError(null);
    setVideoErrorCopied(false);
    setVideoUrl(null);
    apiReadFilePreview(entry.path, 65536)
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry?.path]);

  useEffect(() => {
    if (!entry || (preview?.previewType !== "video" && preview?.previewType !== "pdf")) return;
    let cancelled = false;
    apiGetFilePreviewUrl(entry.path)
      .then((url) => {
        if (!cancelled) setVideoUrl(url);
      })
      .catch((error) => {
        if (!cancelled) setVideoError(`Could not prepare local preview: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [entry?.path, preview?.previewType]);

  if (!entry) return null;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-xs p-8"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-3xl h-[540px] rounded-2xl border shadow-2xl flex flex-col overflow-hidden backdrop-blur-2xl ${
          darkMode
            ? "bg-[#242428]/95 border-white/15 text-zinc-100"
            : "bg-white/95 border-black/15 text-zinc-900"
        }`}
      >
        {/* Quick Look Header */}
        <div
          className={`h-11 px-4 border-b flex items-center justify-between ${
            darkMode ? "border-white/10" : "border-black/10"
          }`}
        >
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="w-3.5 h-3.5 rounded-full bg-[#ff5f57] border border-[#e0443e] flex items-center justify-center hover:opacity-85 transition-opacity cursor-pointer p-0"
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
            <span className="ml-2 text-xs font-semibold truncate max-w-md">
              {entry.name}
            </span>
          </div>

          <button
            onClick={() => onOpenExternal(entry)}
            className="px-2.5 py-1 rounded-md text-xs font-medium bg-[#0a84ff] text-white hover:opacity-90 flex items-center gap-1.5"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {entry.defaultApp ? `Open with ${entry.defaultApp}` : "Open with Default App"}
          </button>
        </div>

        {/* Quick Look Body */}
        <div className="flex-1 overflow-auto p-6 flex items-center justify-center">
          {loading ? (
            <div className="text-xs opacity-50">Loading Quick Look preview...</div>
          ) : preview?.previewType === "image" && preview.dataUrl ? (
            <img
              src={preview.dataUrl}
              alt={entry.name}
              className="max-h-full max-w-full object-contain rounded-lg shadow-lg"
            />
          ) : preview?.previewType === "pdf" ? (
            videoUrl ? (
              <iframe
                key={entry.path}
                src={videoUrl}
                title={`PDF preview: ${entry.name}`}
                className="h-full w-full rounded-lg bg-white shadow-lg"
              />
            ) : (
              <div className="text-xs opacity-50">{videoError || "Preparing PDF preview..."}</div>
            )
          ) : preview?.previewType === "video" ? (
            <div className="flex max-h-full max-w-full flex-col items-center gap-2">
              {!videoUrl && videoError === null && (
                <div className="text-xs opacity-50">Preparing video preview...</div>
              )}
              {videoUrl && (
              <video
                key={entry.path}
                controls
                playsInline
                preload="metadata"
                onError={(event) => {
                  const video = event.currentTarget;
                  const error = video.error;
                  const code = error?.code ?? 0;
                  const codeName = [
                    "",
                    "aborted",
                    "network error",
                    "decode error",
                    "unsupported source or codec",
                  ][code] ?? "unknown media error";
                  const source = video.currentSrc || "not selected";
                  const safeSource = source.replace(/([?&]token=)[^&]*/, "$1[redacted]");
                  setVideoError(
                    `Error ${code} (${codeName})${error?.message ? `: ${error.message}` : ""}. ` +
                      `MIME: ${preview.mimeType || "unknown"}; ` +
                      `canPlayType: ${video.canPlayType(preview.mimeType || "") || "no"}; ` +
                      `networkState: ${video.networkState}; readyState: ${video.readyState}; ` +
                      `source: ${safeSource}`,
                  );
                }}
                className="max-h-full max-w-full rounded-lg bg-black shadow-lg"
                aria-label={`Video preview: ${entry.name}`}
              >
                <source
                  src={videoUrl}
                  type={preview.mimeType || undefined}
                />
              </video>
              )}
              {videoError !== null && (
                <div className="flex max-w-lg items-start gap-2 text-xs text-amber-400">
                  <p className="min-w-0 select-text text-center">
                    WebKitGTK could not play this video: {videoError}. Open it in an external player if needed.
                  </p>
                  <button
                    type="button"
                    onClick={async () => {
                      const diagnostic = `Video preview error for ${entry.name}\n${videoError}`;
                      try {
                        await navigator.clipboard.writeText(diagnostic);
                      } catch {
                        const textarea = document.createElement("textarea");
                        textarea.value = diagnostic;
                        textarea.style.position = "fixed";
                        textarea.style.opacity = "0";
                        document.body.appendChild(textarea);
                        textarea.select();
                        const copied = document.execCommand("copy");
                        textarea.remove();
                        if (!copied) return;
                      }
                      setVideoErrorCopied(true);
                      window.setTimeout(() => setVideoErrorCopied(false), 1800);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-amber-200 hover:bg-white/10"
                    title="Copy video diagnostic"
                    aria-label="Copy video diagnostic"
                  >
                    {videoErrorCopied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {videoErrorCopied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
            </div>
          ) : preview?.previewType === "text" && preview.textContent !== undefined ? (
            <div
              className={`w-full h-full rounded-xl border overflow-auto p-4 font-mono text-xs leading-relaxed ${
                darkMode
                  ? "bg-[#161618] border-white/10 text-zinc-200"
                  : "bg-zinc-50 border-black/10 text-zinc-800"
              }`}
            >
              <pre className="whitespace-pre-wrap break-words">
                {preview.textContent || "(Empty text file)"}
              </pre>
              {preview.truncated && (
                <div className="mt-4 pt-2 border-t border-current/10 text-[11px] opacity-50">
                  Preview truncated at 64 KB — open file to view full contents.
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center text-center space-y-2">
              <FileIcon entry={entry} size={112} />
              <h2 className="text-base font-semibold mt-2">{entry.name}</h2>
              <p className="text-xs opacity-60">{entry.kind}</p>
              <p className="text-xs opacity-50">
                {entry.isDir
                  ? `${entry.childCount ?? 0} items`
                  : formatBytes(entry.size)}
              </p>
              <p className="text-[11px] opacity-45">
                Modified {formatMacDate(entry.modified)}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * 2. GET INFO MODAL (Ctrl + I Inspector)
 * ========================================================================== */
interface GetInfoModalProps {
  entry: FileEntry | null;
  volume?: VolumeInfo | null;
  onClose: () => void;
  onToggleTag: (path: string, color: string) => void;
  onSetDefaultApp?: (
    path: string,
    program: string,
    applyToExtension: boolean
  ) => Promise<void>;
  darkMode: boolean;
}

export const GetInfoModal: React.FC<GetInfoModalProps> = ({
  entry,
  volume,
  onClose,
  onToggleTag,
  onSetDefaultApp,
  darkMode,
}) => {
  const [appInput, setAppInput] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useToolbarOutsideDismiss(dialogRef, Boolean(entry || volume), onClose);

  useEffect(() => {
    setAppInput(entry?.defaultApp || "");
  }, [entry?.path, entry?.defaultApp]);

  if (!entry && !volume) return null;

  if (volume) {
    const isMounted = volume.isMounted && Boolean(volume.mountPoint);
    const usedRatio =
      isMounted && volume.totalSpace > 0
        ? Math.min(100, Math.round((volume.usedSpace / volume.totalSpace) * 100))
        : 0;

    return (
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      >
        <div
          ref={dialogRef}
          onClick={(e) => e.stopPropagation()}
          className={`w-88 rounded-2xl border shadow-2xl overflow-hidden backdrop-blur-2xl text-xs ${
            darkMode
              ? "bg-[#26262b]/95 border-white/15 text-zinc-100"
              : "bg-[#f5f5f7]/95 border-black/15 text-zinc-900"
          }`}
        >
          {/* Titlebar */}
          <div
            className={`h-9 px-3 border-b flex items-center justify-between ${
              darkMode ? "border-white/10" : "border-black/10"
            }`}
          >
            <button
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
            <span className="font-semibold truncate max-w-[200px]">
              {volume.name} Info
            </span>
            <span className="w-3" />
          </div>

          {/* Summary Header */}
          <div className="p-4 flex items-center gap-3.5 border-b border-current/10">
            <div className="w-12 h-12 rounded-xl bg-[#0a84ff]/15 flex items-center justify-center shrink-0">
              {volume.isRemovable ? (
                <Usb className="w-7 h-7 text-amber-400" />
              ) : volume.isSystem ? (
                <Disc className="w-7 h-7 text-purple-400" />
              ) : (
                <HardDrive className="w-7 h-7 text-[#0a84ff]" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm truncate">{volume.name}</div>
              <div className="opacity-55 text-[11px]">
                {volume.fileSystem ? volume.fileSystem.toUpperCase() : "STORAGE"} Partition
              </div>
            </div>
            <div className="font-semibold text-xs text-right">
              {formatBytes(volume.totalSpace)}
            </div>
          </div>

          {/* Capacity Progress Bar */}
          {isMounted && volume.totalSpace > 0 && (
            <div className="px-4 py-3 border-b border-current/10">
              <div className="flex justify-between text-[11px] font-medium mb-1.5">
                <span className="opacity-60">Storage Used</span>
                <span>{usedRatio}%</span>
              </div>
              <div
                className={`w-full h-2 rounded-full overflow-hidden ${
                  darkMode ? "bg-white/10" : "bg-black/10"
                }`}
              >
                <div
                  className="h-full bg-[#0a84ff] rounded-full transition-all duration-300"
                  style={{ width: `${usedRatio}%` }}
                />
              </div>
              <div className="flex justify-between text-[10.5px] opacity-60 mt-1.5">
                <span>Used: {formatBytes(volume.usedSpace)}</span>
                <span>Free: {formatBytes(volume.availableSpace)}</span>
              </div>
            </div>
          )}

          {/* General Device Info */}
          <div className="p-4 space-y-2 border-b border-current/10">
            <div className="text-[11px] font-semibold opacity-55 mb-1">
              General:
            </div>
            <div className="grid grid-cols-3 gap-1">
              <span className="opacity-55 text-right pr-2">Device:</span>
              <span className="col-span-2 font-mono text-[11px]">{volume.device}</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              <span className="opacity-55 text-right pr-2">Filesystem:</span>
              <span className="col-span-2 uppercase font-medium">{volume.fileSystem || "Unknown"}</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              <span className="opacity-55 text-right pr-2">Mount Point:</span>
              <span className="col-span-2 break-all opacity-85">
                {isMounted ? volume.mountPoint : "(Not Mounted)"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              <span className="opacity-55 text-right pr-2">Capacity:</span>
              <span className="col-span-2">{formatBytes(volume.totalSpace)}</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              <span className="opacity-55 text-right pr-2">Status:</span>
              <span className="col-span-2 font-medium">
                {isMounted ? "Mounted" : "Unmounted"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              <span className="opacity-55 text-right pr-2">Type:</span>
              <span className="col-span-2">
                {volume.isRemovable ? "Removable USB / Drive" : "Internal Drive"}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!entry) return null;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={`w-84 rounded-2xl border shadow-2xl overflow-hidden backdrop-blur-2xl text-xs ${
          darkMode
            ? "bg-[#26262b]/95 border-white/15 text-zinc-100"
            : "bg-[#f5f5f7]/95 border-black/15 text-zinc-900"
        }`}
      >
        {/* Titlebar */}
        <div
          className={`h-9 px-3 border-b flex items-center justify-between ${
            darkMode ? "border-white/10" : "border-black/10"
          }`}
        >
          <button
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
          <span className="font-semibold truncate max-w-[200px]">
            {entry.name} Info
          </span>
          <span className="w-3" />
        </div>

        {/* Summary Header */}
        <div className="p-4 flex items-center gap-3 border-b border-current/10">
          <FileIcon entry={entry} size={48} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm truncate">{entry.name}</div>
            <div className="opacity-55 text-[11px]">{entry.kind}</div>
          </div>
          <div className="font-semibold text-xs">
            {entry.isDir ? "--" : formatBytes(entry.size)}
          </div>
        </div>

        {/* Color Tags Bar */}
        <div className="px-4 py-3 border-b border-current/10">
          <div className="text-[11px] font-semibold opacity-55 mb-2">Tags:</div>
          <div className="flex items-center gap-2">
            {TAG_COLORS.map((tc) => {
              const active = entry.tags.includes(tc.id);
              return (
                <button
                  key={tc.id}
                  onClick={() => onToggleTag(entry.path, tc.id)}
                  title={tc.name}
                  className={`w-4 h-4 rounded-full ${tc.bgClass} transition ${
                    active ? "ring-2 ring-white scale-110" : "opacity-55 hover:opacity-100"
                  }`}
                />
              );
            })}
          </div>
        </div>

        {/* Open With (for files) */}
        {!entry.isDir && onSetDefaultApp && (
          <div className="px-4 py-3 border-b border-current/10 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold opacity-55">
                Open with:
              </span>
              {entry.defaultApp && (
                <button
                  type="button"
                  onClick={() => {
                    setAppInput("");
                    void onSetDefaultApp(entry.path, "", true);
                  }}
                  className="text-[10.5px] text-[#ff453a] hover:underline cursor-pointer"
                >
                  Reset to Default
                </button>
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void onSetDefaultApp(entry.path, appInput.trim(), true);
              }}
              className="flex items-center gap-1.5"
            >
              <input
                type="text"
                value={appInput}
                onChange={(e) => setAppInput(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="System Default (e.g. gwenview)"
                className={`flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border outline-none text-xs transition focus:ring-2 focus:ring-[#0a84ff] ${
                  darkMode
                    ? "bg-black/30 border-white/15 text-white placeholder:text-zinc-500"
                    : "bg-white border-black/15 text-zinc-900 placeholder:text-zinc-400"
                }`}
              />
              <button
                type="submit"
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-[#0a84ff] text-white hover:opacity-90 transition shrink-0 cursor-pointer"
              >
                Save
              </button>
            </form>
          </div>
        )}

        {/* General Info */}
        <div className="p-4 space-y-2 border-b border-current/10">
          <div className="text-[11px] font-semibold opacity-55 mb-1">
            General:
          </div>
          <div className="grid grid-cols-3 gap-1">
            <span className="opacity-55 text-right pr-2">Kind:</span>
            <span className="col-span-2">{entry.kind}</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <span className="opacity-55 text-right pr-2">Size:</span>
            <span className="col-span-2">
              {entry.isDir
                ? `${entry.childCount ?? 0} items`
                : `${formatBytes(entry.size)} (${entry.size.toLocaleString()} bytes)`}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <span className="opacity-55 text-right pr-2">Where:</span>
            <span className="col-span-2 break-all opacity-85">{entry.path}</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <span className="opacity-55 text-right pr-2">Created:</span>
            <span className="col-span-2">{formatMacDate(entry.created)}</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <span className="opacity-55 text-right pr-2">Modified:</span>
            <span className="col-span-2">{formatMacDate(entry.modified)}</span>
          </div>
        </div>

        {/* Sharing & Permissions */}
        <div className="p-4 space-y-1.5">
          <div className="text-[11px] font-semibold opacity-55">
            Sharing & Permissions:
          </div>
          <div className="flex justify-between">
            <span className="opacity-60">Unix Mode</span>
            <span className="font-mono">{entry.permissions}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-60">Access</span>
            <span>{entry.isReadonly ? "Read only" : "Read & Write"}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ArchiveContentsModalProps {
  archivePath: string | null;
  onClose: () => void;
  onExtract: (archivePath: string) => void;
  darkMode: boolean;
}

export const ArchiveContentsModal: React.FC<ArchiveContentsModalProps> = ({
  archivePath,
  onClose,
  onExtract,
  darkMode,
}) => {
  const [entries, setEntries] = useState<ArchiveEntryInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!archivePath) return;
    let cancelled = false;
    setEntries([]);
    setError(null);
    setLoading(true);
    apiReadArchiveContents(archivePath)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [archivePath]);

  if (!archivePath) return null;
  const archiveName = archivePath.split(/[\\/]/).pop() || archivePath;
  const visibleEntries = entries.slice(0, 500);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 backdrop-blur-xs p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Archive contents: ${archiveName}`}
        className={`flex max-h-[min(720px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl ${
          darkMode
            ? "border-white/15 bg-[#242428] text-zinc-100"
            : "border-black/10 bg-white text-zinc-900"
        }`}
      >
        <header className="flex items-center gap-3 border-b border-current/10 px-5 py-4">
          <Archive className="h-5 w-5 shrink-0 text-[#0a84ff]" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{archiveName}</h2>
            <p className="mt-0.5 text-xs opacity-55">
              {loading ? "Reading archive…" : `${entries.length} items`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close archive"
            className="rounded-lg p-2 opacity-60 hover:bg-current/10 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm opacity-60">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading archive contents…
            </div>
          ) : error ? (
            <p className="px-3 py-8 text-center text-sm text-[#ff453a]">{error}</p>
          ) : entries.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm opacity-55">This archive is empty.</p>
          ) : (
            <div className="space-y-0.5">
              {visibleEntries.map((entry, index) => (
                <div
                  key={`${entry.name}-${index}`}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-xs hover:bg-current/5"
                >
                  {entry.isDir ? (
                    <Folder className="h-4 w-4 shrink-0 text-[#0a84ff]" />
                  ) : (
                    <FilePlus className="h-4 w-4 shrink-0 opacity-45" />
                  )}
                  <span className="min-w-0 flex-1 break-all">{entry.name}</span>
                  {!entry.isDir && (
                    <span className="shrink-0 tabular-nums opacity-50">
                      {formatBytes(entry.size)}
                    </span>
                  )}
                </div>
              ))}
              {entries.length > visibleEntries.length && (
                <p className="px-3 py-2 text-center text-[11px] opacity-50">
                  Showing the first {visibleEntries.length} of {entries.length} items
                </p>
              )}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-current/10 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs opacity-70 hover:bg-current/10"
          >
            Close
          </button>
          <button
            type="button"
            disabled={loading || Boolean(error)}
            onClick={() => onExtract(archivePath)}
            className="rounded-lg bg-[#0a84ff] px-3 py-2 text-xs font-medium text-white hover:bg-[#0077ed] disabled:cursor-not-allowed disabled:opacity-45"
          >
            Extract to Folder
          </button>
        </footer>
      </section>
    </div>
  );
};

/* ============================================================================
 * 3. MACOS CONTEXT MENU (Right-Click Menu)
 * ========================================================================== */
export interface ContextMenuState {
  x: number;
  y: number;
  entry?: FileEntry;
  targetDir?: string;
  favorite?: {
    name: string;
    path: string;
    isCustom?: boolean;
  };
  volume?: VolumeInfo;
}

interface ContextMenuProps {
  menu: ContextMenuState | null;
  selectedPaths?: string[];
  onClose: () => void;
  onOpen: (entry: FileEntry) => void;
  onOpenWith?: (entry: FileEntry) => void;
  onQuickLook: (entry: FileEntry) => void;
  onGetInfo: (entry?: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onDuplicate: (entry?: FileEntry) => void;
  onCompress?: (entry?: FileEntry) => void;
  onViewArchive?: (entry: FileEntry) => void;
  onExtractArchive?: (entry: FileEntry) => void;
  onCopy: (entry?: FileEntry) => void;
  onCut: (entry?: FileEntry) => void;
  onPaste: () => void;
  canPaste: boolean;
  onTrash: (entry?: FileEntry) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onToggleTag: (path: string, color: string) => void;
  onAddFavorite: (entry: FileEntry) => void;
  darkMode: boolean;

  onNavigate?: (path: string, title?: string) => void;
  onOpenInNewTab?: (path: string, title?: string) => void;
  onGetFavoriteInfo?: (path: string, name?: string) => void;
  onRemoveFavorite?: (path: string) => void;
  onSelectVolume?: (vol: VolumeInfo) => void;
  onUnmountVolume?: (vol: VolumeInfo) => void;
  onMountVolume?: (vol: VolumeInfo) => void;
  onGetVolumeInfo?: (vol: VolumeInfo) => void;
  onFormatVolume?: (vol: VolumeInfo) => void;
  onFirstAidVolume?: (vol: VolumeInfo) => void;
  onToast?: (message: string) => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  menu,
  selectedPaths = [],
  onClose,
  onOpen,
  onOpenWith,
  onQuickLook,
  onGetInfo,
  onRename,
  onDuplicate,
  onCompress,
  onViewArchive,
  onExtractArchive,
  onCopy,
  onCut,
  onPaste,
  canPaste,
  onTrash,
  onNewFolder,
  onNewFile,
  onToggleTag,
  onAddFavorite,
  darkMode,
  onNavigate,
  onOpenInNewTab,
  onGetFavoriteInfo,
  onRemoveFavorite,
  onSelectVolume,
  onUnmountVolume,
  onMountVolume,
  onGetVolumeInfo,
  onFormatVolume,
  onFirstAidVolume,
  onToast,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  useToolbarOutsideDismiss(menuRef, Boolean(menu), onClose);
  if (!menu) return null;

  const entry = menu.entry;
  const favorite = menu.favorite;
  const volume = menu.volume;

  const isMultiSelected =
    Boolean(entry) &&
    selectedPaths.length > 1 &&
    selectedPaths.includes(entry!.path);
  const countSuffix = isMultiSelected ? ` (${selectedPaths.length} Items)` : "";
  const isArchiveEntry = Boolean(
    entry &&
      !entry.isDir &&
      /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst|tar\.lzma)$/i.test(
        entry.name
      )
  );

  const top = Math.max(10, Math.min(menu.y, window.innerHeight - 340));
  const left = Math.max(10, Math.min(menu.x, window.innerWidth - 240));

  const itemCls =
    "w-full px-3 py-1.5 text-left flex items-center gap-2.5 rounded-md hover:bg-[#0a84ff] hover:text-white transition cursor-pointer";

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 z-50"
    >
      <div
        ref={menuRef}
        onClick={(e) => e.stopPropagation()}
        style={{ top, left }}
        className={`fixed min-w-60 w-auto max-w-xs p-1.5 rounded-xl border shadow-2xl backdrop-blur-2xl text-xs select-none ${
          darkMode
            ? "bg-[#2b2b30]/95 border-white/15 text-zinc-100"
            : "bg-white/95 border-black/15 text-zinc-800"
        }`}
      >
        {volume ? (
          <>
            <button
              onClick={() => {
                onSelectVolume?.(volume);
                onClose();
              }}
              className={itemCls}
            >
              <FolderOpen className="w-3.5 h-3.5 text-[#0a84ff]" />
              <span className="font-medium truncate">
                {volume.isMounted && volume.mountPoint
                  ? `Open “${volume.name}”`
                  : `Mount and Open`}
              </span>
            </button>
            {volume.isMounted && volume.mountPoint && (
              <button
                onClick={() => {
                  onOpenInNewTab?.(volume.mountPoint, volume.name);
                  onClose();
                }}
                className={itemCls}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open in New Tab</span>
              </button>
            )}
            <div className="my-1 border-t border-current/10" />
            <button
              onClick={() => {
                onGetVolumeInfo?.(volume);
                onClose();
              }}
              className={itemCls}
            >
              <Info className="w-3.5 h-3.5" />
              <span>Get Info</span>
              <span className="ml-auto opacity-60 text-[10px]">Ctrl+I</span>
            </button>
            <div className="my-1 border-t border-current/10" />
            {volume.canUnmount && (
              <button
                onClick={() => {
                  onUnmountVolume?.(volume);
                  onClose();
                }}
                className={itemCls}
              >
                <Disc className="w-3.5 h-3.5 text-amber-400" />
                <span className="truncate">Eject “{volume.name}”</span>
                <span className="ml-auto opacity-60 text-[10px]">⏏</span>
              </button>
            )}
            {!volume.isMounted && (
              <button
                onClick={() => {
                  if (onMountVolume) onMountVolume(volume);
                  else onSelectVolume?.(volume);
                  onClose();
                }}
                className={itemCls}
              >
                <HardDrive className="w-3.5 h-3.5 text-[#0a84ff]" />
                <span className="truncate">Mount “{volume.name}”</span>
              </button>
            )}
            <button
              onClick={() => {
                const target = volume.mountPoint || volume.device;
                navigator.clipboard.writeText(target);
                onToast?.(`Copied: ${target}`);
                onClose();
              }}
              className={itemCls}
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy {volume.isMounted ? "Mount Path" : "Device"}</span>
            </button>
            {volume.mountPoint !== "/" && !volume.mountPoint.startsWith("/boot") && (
              <>
                <div className="my-1 border-t border-current/10" />
                <button
                  onClick={() => {
                    onFirstAidVolume?.(volume);
                    onClose();
                  }}
                  className={itemCls}
                >
                  <Activity className="w-3.5 h-3.5 text-[#32d74b]" />
                  <span>First Aid...</span>
                </button>
                <button
                  onClick={() => {
                    onFormatVolume?.(volume);
                    onClose();
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 rounded-md text-[#ff453a] hover:bg-[#ff453a] hover:text-white transition cursor-pointer"
                >
                  <Eraser className="w-3.5 h-3.5" />
                  <span>Erase / Format...</span>
                </button>
              </>
            )}
          </>
        ) : favorite ? (
          <>
            <button
              onClick={() => {
                onNavigate?.(favorite.path, favorite.name);
                onClose();
              }}
              className={itemCls}
            >
              <FolderOpen className="w-3.5 h-3.5 text-[#0a84ff]" />
              <span className="font-medium truncate">Open “{favorite.name}”</span>
            </button>
            <button
              onClick={() => {
                onOpenInNewTab?.(favorite.path, favorite.name);
                onClose();
              }}
              className={itemCls}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Open in New Tab</span>
            </button>
            {favorite.path !== "__RECENTS__" && (
              <>
                <div className="my-1 border-t border-current/10" />
                <button
                  onClick={() => {
                    onGetFavoriteInfo?.(favorite.path, favorite.name);
                    onClose();
                  }}
                  className={itemCls}
                >
                  <Info className="w-3.5 h-3.5" />
                  <span>Get Info</span>
                  <span className="ml-auto opacity-60 text-[10px]">Ctrl+I</span>
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(favorite.path);
                    onToast?.(`Copied path: ${favorite.path}`);
                    onClose();
                  }}
                  className={itemCls}
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Path</span>
                </button>
              </>
            )}
            <div className="my-1 border-t border-current/10" />
            <button
              onClick={() => {
                onRemoveFavorite?.(favorite.path);
                onClose();
              }}
              className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 rounded-md text-[#ff453a] hover:bg-[#ff453a] hover:text-white transition cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remove from Sidebar</span>
            </button>
          </>
        ) : entry ? (
          <>
            <button
              onClick={() => {
                onOpen(entry);
                onClose();
              }}
              className={itemCls}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="font-medium truncate">
                {!isMultiSelected && entry.defaultApp
                  ? `Open with “${entry.defaultApp}”`
                  : `Open${countSuffix}`}
              </span>
            </button>
            {isArchiveEntry && !isMultiSelected && onViewArchive && (
              <button
                onClick={() => {
                  onViewArchive(entry);
                  onClose();
                }}
                className={itemCls}
              >
                <Archive className="w-3.5 h-3.5 text-[#0a84ff]" />
                <span>View Archive Contents</span>
              </button>
            )}
            {isArchiveEntry && !isMultiSelected && onExtractArchive && (
              <button
                onClick={() => {
                  onExtractArchive(entry);
                  onClose();
                }}
                className={itemCls}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Extract to Folder</span>
              </button>
            )}
            {!entry.isDir && !isMultiSelected && onOpenWith && (
              <button
                onClick={() => {
                  onOpenWith(entry);
                  onClose();
                }}
                className={itemCls}
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>Open With / Default App...</span>
              </button>
            )}
            <button
              onClick={() => {
                onQuickLook(entry);
                onClose();
              }}
              className={itemCls}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Quick Look</span>
              <span className="ml-auto opacity-60 text-[10px]">Space</span>
            </button>
            <div className="my-1 border-t border-current/10" />
            <button
              onClick={() => {
                onGetInfo(entry);
                onClose();
              }}
              className={itemCls}
            >
              <Info className="w-3.5 h-3.5" />
              <span>Get Info</span>
              <span className="ml-auto opacity-60 text-[10px]">Ctrl+I</span>
            </button>
            {!isMultiSelected && (
              <button
                onClick={() => {
                  onRename(entry);
                  onClose();
                }}
                className={itemCls}
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>Rename</span>
                <span className="ml-auto opacity-60 text-[10px]">F2</span>
              </button>
            )}
            {entry.isDir && !isMultiSelected && (
              <button
                onClick={() => {
                  onAddFavorite(entry);
                  onClose();
                }}
                className={itemCls}
              >
                <Star className="w-3.5 h-3.5" />
                <span>Add to Sidebar</span>
              </button>
            )}
            <button
              onClick={() => {
                onDuplicate(isMultiSelected ? undefined : entry);
                onClose();
              }}
              className={itemCls}
            >
              <Files className="w-3.5 h-3.5" />
              <span>Duplicate{countSuffix}</span>
              <span className="ml-auto opacity-60 text-[10px]">Ctrl+D</span>
            </button>
            {onCompress && (
              <button
                onClick={() => {
                  onCompress(isMultiSelected ? undefined : entry);
                  onClose();
                }}
                className={itemCls}
              >
                <Archive className="w-3.5 h-3.5" />
                <span>Compress as ZIP{countSuffix}</span>
              </button>
            )}
            <div className="my-1 border-t border-current/10" />
            <button
              onClick={() => {
                onCopy(isMultiSelected ? undefined : entry);
                onClose();
              }}
              className={itemCls}
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy{countSuffix}</span>
              <span className="ml-auto opacity-60 text-[10px]">Ctrl+C</span>
            </button>
            <button
              onClick={() => {
                onCut(isMultiSelected ? undefined : entry);
                onClose();
              }}
              className={itemCls}
            >
              <Scissors className="w-3.5 h-3.5" />
              <span>Cut{countSuffix}</span>
              <span className="ml-auto opacity-60 text-[10px]">Ctrl+X</span>
            </button>
            <div className="my-1 border-t border-current/10" />

            {/* macOS Color Tag Dots Row */}
            <div className="px-3 py-1.5 flex items-center justify-between">
              {TAG_COLORS.map((tc) => {
                const active = entry.tags.includes(tc.id);
                return (
                  <button
                    key={tc.id}
                    onClick={() => {
                      onToggleTag(entry.path, tc.id);
                      onClose();
                    }}
                    title={`Tag ${tc.name}`}
                    className={`w-3.5 h-3.5 rounded-full ${tc.bgClass} transition transform hover:scale-125 ${
                      active ? "ring-2 ring-white" : ""
                    }`}
                  />
                );
              })}
            </div>

            <div className="my-1 border-t border-current/10" />
            <button
              onClick={() => {
                onTrash(isMultiSelected ? undefined : entry);
                onClose();
              }}
              className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 rounded-md text-[#ff453a] hover:bg-[#ff453a] hover:text-white transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Move to Trash{countSuffix}</span>
              <span className="ml-auto opacity-60 text-[10px]">Ctrl+Del</span>
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                onNewFolder();
                onClose();
              }}
              className={itemCls}
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>New Folder</span>
              <span className="ml-auto opacity-60 text-[10px]">Ctrl+Shift+N</span>
            </button>
            <button
              onClick={() => {
                onNewFile();
                onClose();
              }}
              className={itemCls}
            >
              <FilePlus className="w-3.5 h-3.5" />
              <span>New Blank File</span>
            </button>
            {canPaste && (
              <>
                <div className="my-1 border-t border-current/10" />
                <button
                  onClick={() => {
                    onPaste();
                    onClose();
                  }}
                  className={itemCls}
                >
                  <ClipboardPaste className="w-3.5 h-3.5" />
                  <span>Paste Item(s) Here</span>
                  <span className="ml-auto opacity-60 text-[10px]">Ctrl+V</span>
                </button>
              </>
            )}
            <div className="my-1 border-t border-current/10" />
            <button
              onClick={() => {
                onGetInfo(undefined);
                onClose();
              }}
              className={itemCls}
            >
              <Info className="w-3.5 h-3.5" />
              <span>Get Folder Info</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
};

/* ============================================================================
 * 4. BOTTOM PATH BAR & STATUS BAR
 * ========================================================================== */
interface BottomBarsProps {
  currentPath: string;
  rootPartitionName?: string;
  activeTag: string | null;
  totalItems: number;
  selectedCount: number;
  availableSpace: number;
  viewMode: ViewMode;
  iconSize: number;
  onChangeIconSize: (size: number) => void;
  onNavigate: (path: string) => void;
  darkMode: boolean;
  dropTargetPath?: string | null;
}

export const BottomBars: React.FC<BottomBarsProps> = ({
  currentPath,
  rootPartitionName,
  activeTag,
  totalItems,
  selectedCount,
  availableSpace,
  iconSize,
  onChangeIconSize,
  onNavigate,
  darkMode,
  dropTargetPath,
}) => {
  const rootLabel = rootPartitionName || "Linux";
  const segments =
    currentPath === "__RECENTS__"
      ? [{ name: "Recents", path: "__RECENTS__" }]
      : currentPath === "/"
      ? [{ name: rootLabel, path: "/" }]
      : [
          { name: rootLabel, path: "/" },
          ...currentPath
            .split("/")
            .filter(Boolean)
            .map((part, idx, arr) => ({
              name: part,
              path: "/" + arr.slice(0, idx + 1).join("/"),
            })),
        ];

  return (
    <div
      onDragStart={(e) => e.preventDefault()}
      className={`macos-layer-isolate select-none text-[11px] border-t ${
        darkMode
          ? "bg-[#202024] border-white/10 text-zinc-400"
          : "bg-[#f2f2f5] border-black/10 text-zinc-600"
      }`}
    >
      {/* Interactive Breadcrumb Path Bar */}
      <div
        className={`h-6 px-3 flex items-center gap-1 overflow-x-auto border-b ${
          darkMode ? "border-white/5" : "border-black/5"
        }`}
      >
        {activeTag ? (
          <div className="flex items-center gap-1.5">
            <span>Tag:</span>
            <span className="font-semibold capitalize text-zinc-200">
              {activeTag}
            </span>
          </div>
        ) : (
          segments.map((seg, i) => {
            const canDrop = seg.path !== "__RECENTS__";
            const isDropTarget = canDrop && dropTargetPath === seg.path;
            return (
              <React.Fragment key={seg.path}>
                {i > 0 && <ChevronRight className="w-3 h-3 opacity-40 shrink-0" />}
                <button
                  data-drop-path={canDrop ? seg.path : undefined}
                  data-drop-name={canDrop ? seg.name : undefined}
                  onClick={() => onNavigate(seg.path)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition shrink-0 ${
                    isDropTarget
                      ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/30 text-white"
                      : "hover:bg-white/10"
                  }`}
                >
                  <Folder className="w-3 h-3 text-[#0a84ff]" />
                  <span
                    className={
                      i === segments.length - 1 ? "font-medium text-current" : ""
                    }
                  >
                    {seg.name}
                  </span>
                </button>
              </React.Fragment>
            );
          })
        )}
      </div>

      {/* Status Bar */}
      <div className="h-6 px-4 flex items-center justify-between">
        <span className="w-24" />
        <div className="font-medium">
          {totalItems} {totalItems === 1 ? "item" : "items"}
          {selectedCount > 0 && `, ${selectedCount} selected`}
          {availableSpace > 0 && `, ${formatBytes(availableSpace)} available`}
        </div>
        <div className="w-28 flex items-center justify-end">
          <input
            type="range"
            min={40}
            max={144}
            value={iconSize}
            onChange={(e) => onChangeIconSize(Number(e.target.value))}
            onMouseUp={(e) => e.currentTarget.blur()}
            onKeyUp={(e) => e.currentTarget.blur()}
            title="Adjust Zoom (Ctrl+ / Ctrl-)"
            className="w-20 accent-[#0a84ff] cursor-pointer h-1"
          />
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * 5. MACOS SUDO PASSWORD AUTHENTICATION PROMPT
 * ========================================================================== */
export interface SudoPromptState {
  action: "mount" | "unmount" | "format" | "firstaid";
  volumeName: string;
  device: string;
  error?: string | null;
  busy?: boolean;
  extra?: {
    fstype?: string;
    label?: string;
  };
}

interface SudoPromptModalProps {
  prompt: SudoPromptState | null;
  onCancel: () => void;
  onSubmit: (password: string) => void;
  darkMode: boolean;
}

export const SudoPromptModal: React.FC<SudoPromptModalProps> = ({
  prompt,
  onCancel,
  onSubmit,
  darkMode,
}) => {
  const [password, setPassword] = useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  useToolbarOutsideDismiss(dialogRef, Boolean(prompt), onCancel, Boolean(prompt?.busy));

  useEffect(() => {
    if (prompt) {
      setPassword("");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [prompt?.device, prompt?.action]);

  useEffect(() => {
    if (prompt && !prompt.busy && prompt.error) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [prompt?.busy, prompt?.error]);

  if (!prompt) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || prompt.busy) return;
    onSubmit(password);
  };

  const actionVerb =
    prompt.action === "format"
      ? "erase and format"
      : prompt.action === "firstaid"
      ? "run First Aid on"
      : prompt.action;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !prompt.busy) {
          onCancel();
        }
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !prompt.busy) {
          onCancel();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
    >
      <form
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className={`w-[390px] rounded-2xl border shadow-2xl p-5 flex flex-col items-center text-center select-none ${
          darkMode
            ? "bg-[#28282e] border-white/15 text-zinc-100"
            : "bg-[#f5f5f7] border-black/15 text-zinc-900"
        }`}
      >
        {/* macOS Golden Padlock Icon */}
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-b from-amber-300 to-amber-500 flex items-center justify-center shadow-lg mb-3 border border-white/25">
          <svg
            viewBox="0 0 24 24"
            width="28"
            height="28"
            fill="none"
            stroke="#1e1e22"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="4" y="11" width="16" height="10" rx="2" fill="#1e1e22" fillOpacity="0.15" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            <circle cx="12" cy="16" r="1" fill="#1e1e22" />
          </svg>
        </div>

        <h3 className="text-[14px] font-bold leading-snug">
          vFinder wants to {actionVerb} “{prompt.volumeName}”
        </h3>
        <p className="text-xs opacity-65 mt-1">
          Enter your administrator (sudo) password to {actionVerb}{" "}
          <span className="font-mono">{prompt.device}</span>.
        </p>

        <div className="w-full mt-4 text-left space-y-2">
          <div className="flex items-center gap-2">
            <label className="w-20 text-right text-xs opacity-70 font-medium">
              Password:
            </label>
            <input
              ref={inputRef}
              type="password"
              autoFocus
              readOnly={prompt.busy}
              value={password}
              onChange={(e) => {
                if (!prompt.busy) setPassword(e.target.value);
              }}
              placeholder="Enter password"
              className={`flex-1 px-2.5 py-1.5 rounded-lg text-xs border outline-none focus:ring-2 focus:ring-[#0a84ff] ${
                prompt.busy ? "opacity-60" : ""
              } ${
                darkMode
                  ? "bg-black/35 border-white/15 text-white"
                  : "bg-white border-black/15 text-zinc-900"
              }`}
            />
          </div>

          {prompt.error && (
            <p className="text-[11px] text-[#ff453a] text-center font-medium pt-1 break-words">
              {prompt.error}
            </p>
          )}
        </div>

        <div className="w-full flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            disabled={prompt.busy}
            onClick={onCancel}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition ${
              darkMode
                ? "border-white/15 bg-white/5 hover:bg-white/10"
                : "border-black/15 bg-black/5 hover:bg-black/10"
            }`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password || prompt.busy}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#0a84ff] text-white hover:opacity-90 disabled:opacity-40 transition"
          >
            {prompt.busy
              ? "Authenticating..."
              : prompt.action === "mount"
              ? "Mount"
              : prompt.action === "unmount"
              ? "Unmount"
              : prompt.action === "format"
              ? "Format"
              : "Run First Aid"}
          </button>
        </div>
      </form>
    </div>
  );
};

/* ============================================================================
 * 6. FORMAT / ERASE MODAL (macOS Disk Utility Style)
 * ========================================================================== */
interface FormatModalProps {
  volume: VolumeInfo | null;
  onClose: () => void;
  onFormat: (volume: VolumeInfo, fstype: string, label: string, password?: string) => Promise<void>;
  darkMode: boolean;
}

export const FormatModal: React.FC<FormatModalProps> = ({
  volume,
  onClose,
  onFormat,
  darkMode,
}) => {
  const [label, setLabel] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [fstype, setFstype] = useState("vfat");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [password, setPassword] = useState("");
  useToolbarOutsideDismiss(dialogRef, Boolean(volume), onClose, busy);
  const [formatTypes, setFormatTypes] = useState<FormatTypeOption[]>([
    {
      id: "vfat",
      name: "MS-DOS (FAT32)",
      description: "Universal compatibility (Mac, PC, Linux, USBs)",
      isAvailable: true,
    },
    {
      id: "exfat",
      name: "ExFAT",
      description: "Large files & modern OS compatibility (Mac, PC, Linux)",
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
  ]);

  useEffect(() => {
    if (volume) {
      const initial = volume.name
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 11)
        .toUpperCase();
      setLabel(initial || "UNTITLED");
      setConfirmed(false);
      setError(null);
      setBusy(false);
      setNeedsAuth(false);
      setPassword("");

      apiGetAvailableFormatTypes()
        .then((types) => {
          setFormatTypes(types);
          if (
            volume.fileSystem.toLowerCase().includes("exfat") &&
            types.some((t) => t.id === "exfat" && t.isAvailable)
          ) {
            setFstype("exfat");
          } else if (types.some((t) => t.id === "vfat" && t.isAvailable)) {
            setFstype("vfat");
          } else if (types.length > 0) {
            setFstype(types[0].id);
          }
        })
        .catch(() => {});
    }
  }, [volume]);

  if (!volume) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmed || busy || !label.trim()) return;
    if (needsAuth && !password) return;
    setBusy(true);
    setError(null);
    try {
      await onFormat(volume, fstype, label.trim(), needsAuth ? password : undefined);
      onClose();
    } catch (err) {
      const msg = String(err);
      if (msg.includes("AUTH_REQUIRED")) {
        setNeedsAuth(true);
        setError("Administrator privileges are required to erase this device.");
      } else if (msg.includes("INVALID_PASSWORD")) {
        setNeedsAuth(true);
        setError("Incorrect sudo password. Please try again.");
      } else {
        setError(msg);
      }
      setBusy(false);
    }
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={`w-[460px] rounded-2xl border shadow-2xl overflow-hidden backdrop-blur-2xl text-xs select-none ${
          darkMode
            ? "bg-[#28282e]/95 border-white/15 text-zinc-100"
            : "bg-[#f5f5f7]/95 border-black/15 text-zinc-900"
        }`}
      >
        {/* Header */}
        <div className="p-5 pb-3 flex items-start gap-3.5 border-b border-current/10">
          <div className="w-12 h-12 rounded-2xl bg-[#ff453a]/15 text-[#ff453a] flex items-center justify-center shrink-0">
            <Eraser className="w-6 h-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold leading-snug">
              Erase “{volume.name}”?
            </h3>
            <p className="text-xs opacity-70 mt-1 leading-relaxed">
              Erasing <span className="font-semibold">{volume.shortDevice}</span> (
              {formatBytes(volume.totalSpace)}) will permanently delete all data stored on this drive.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Name Field */}
          <div className="space-y-1.5">
            <label className="font-semibold opacity-75">Volume Name</label>
            <input
              type="text"
              value={label}
              disabled={busy}
              maxLength={16}
              onChange={(e) => setLabel(e.target.value.toUpperCase())}
              placeholder="UNTITLED"
              className={`w-full px-3 py-2 rounded-lg border outline-none font-mono text-sm uppercase transition focus:ring-2 focus:ring-[#0a84ff] ${
                darkMode
                  ? "bg-black/30 border-white/15 text-white"
                  : "bg-white border-black/15 text-zinc-900"
              }`}
            />
            <span className="text-[10px] opacity-50 block">
              Up to 11 characters for FAT32, 16 for other formats.
            </span>
          </div>

          {/* Format Selector */}
          <div className="space-y-1.5">
            <label className="font-semibold opacity-75">Format</label>
            <select
              value={fstype}
              disabled={busy}
              onChange={(e) => setFstype(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg border outline-none text-xs transition focus:ring-2 focus:ring-[#0a84ff] ${
                darkMode
                  ? "bg-[#1f1f23] border-white/15 text-white"
                  : "bg-white border-black/15 text-zinc-900"
              }`}
            >
              {formatTypes.map((ft) => (
                <option key={ft.id} value={ft.id} disabled={!ft.isAvailable}>
                  {ft.name} {!ft.isAvailable ? "(Not installed)" : ""}
                </option>
              ))}
            </select>
            <p className="text-[11px] opacity-60 leading-normal">
              {formatTypes.find((f) => f.id === fstype)?.description}
            </p>
          </div>

          {/* Safety Confirmation Checkbox */}
          <label className="flex items-start gap-2.5 p-3 rounded-xl border border-red-500/20 bg-red-500/10 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded text-red-600 focus:ring-red-500 cursor-pointer accent-[#ff453a]"
            />
            <span className="text-[11.5px] leading-snug font-medium text-red-400">
              I understand that formatting will permanently erase all partitions and files on{" "}
              <span className="font-mono">{volume.device}</span>.
            </span>
          </label>

          {/* Inline Sudo Authentication Field if needed */}
          {needsAuth && (
            <div className="space-y-2 p-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10">
              <label className="font-semibold text-yellow-500 flex items-center gap-1.5 text-xs">
                <Lock className="w-3.5 h-3.5" />
                <span>Administrator Password</span>
              </label>
              <input
                type="password"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter sudo password"
                className={`w-full px-3 py-1.5 rounded-lg border outline-none text-xs transition ${
                  darkMode
                    ? "bg-[#1f1f23] border-white/20 text-white"
                    : "bg-white border-black/20 text-zinc-900"
                }`}
                autoFocus
              />
            </div>
          )}

          {error && (
            <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-[11px] text-[#ff453a] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className={`px-4 py-2 rounded-xl text-xs font-medium border transition ${
                darkMode
                  ? "border-white/15 bg-white/5 hover:bg-white/10"
                  : "border-black/15 bg-black/5 hover:bg-black/10"
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!confirmed || !label.trim() || busy || (needsAuth && !password)}
              className="px-5 py-2 rounded-xl text-xs font-semibold bg-[#ff453a] text-white hover:bg-[#ff3b30] disabled:opacity-40 transition flex items-center gap-1.5 shadow-md"
            >
              {busy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Formatting...</span>
                </>
              ) : (
                <>
                  <Eraser className="w-3.5 h-3.5" />
                  <span>{needsAuth ? "Authenticate & Erase" : "Erase"}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/* ============================================================================
 * 7. FIRST AID MODAL (macOS Disk Utility First Aid)
 * ========================================================================== */
interface FirstAidModalProps {
  volume: VolumeInfo | null;
  onClose: () => void;
  onRunFirstAid: (volume: VolumeInfo, password?: string) => Promise<string>;
  darkMode: boolean;
}

export const FirstAidModal: React.FC<FirstAidModalProps> = ({
  volume,
  onClose,
  onRunFirstAid,
  darkMode,
}) => {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [password, setPassword] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useToolbarOutsideDismiss(dialogRef, Boolean(volume), onClose, running);

  useEffect(() => {
    setRunning(false);
    setReport(null);
    setError(null);
    setNeedsAuth(false);
    setPassword("");
  }, [volume?.device]);

  if (!volume) return null;

  const handleRun = async () => {
    if (needsAuth && !password) return;
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const res = await onRunFirstAid(volume, needsAuth ? password : undefined);
      setReport(res);
      setNeedsAuth(false);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("AUTH_REQUIRED")) {
        setNeedsAuth(true);
        setError("Administrator privileges are required to inspect this drive.");
      } else if (msg.includes("INVALID_PASSWORD")) {
        setNeedsAuth(true);
        setError("Incorrect sudo password. Please try again.");
      } else {
        setError(msg);
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={`w-[520px] rounded-2xl border shadow-2xl overflow-hidden backdrop-blur-2xl text-xs select-none ${
          darkMode
            ? "bg-[#28282e]/95 border-white/15 text-zinc-100"
            : "bg-[#f5f5f7]/95 border-black/15 text-zinc-900"
        }`}
      >
        {/* Titlebar */}
        <div className="p-5 pb-3 flex items-start gap-3.5 border-b border-current/10">
          <div className="w-12 h-12 rounded-2xl bg-[#32d74b]/15 text-[#32d74b] flex items-center justify-center shrink-0">
            <Activity className="w-6 h-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold leading-snug">
              First Aid: {volume.name}
            </h3>
            <p className="text-xs opacity-70 mt-1 leading-relaxed">
              First Aid inspects <span className="font-semibold">{volume.shortDevice}</span> (
              {volume.fileSystem.toUpperCase()}) for directory structure and filesystem integrity errors.
            </p>
          </div>
        </div>

        {/* Report / Log Console */}
        <div className="p-5 space-y-3">
          {report ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[#32d74b] font-semibold text-xs">
                <CheckCircle2 className="w-4 h-4" />
                <span>First Aid completed successfully.</span>
              </div>
              <pre
                className={`p-3 rounded-xl font-mono text-[11px] max-h-48 overflow-y-auto leading-relaxed border ${
                  darkMode
                    ? "bg-black/50 border-white/10 text-zinc-300"
                    : "bg-black/5 border-black/10 text-zinc-700"
                }`}
              >
                {report}
              </pre>
            </div>
          ) : running ? (
            <div className="py-8 flex flex-col items-center justify-center gap-3">
              <Loader2 className="w-8 h-8 text-[#0a84ff] animate-spin" />
              <span className="font-semibold text-sm">Checking filesystem on {volume.shortDevice}...</span>
              <span className="text-[11px] opacity-50">This may take a few moments.</span>
            </div>
          ) : (
            <p className="text-xs opacity-70 py-2 leading-relaxed">
              Click <span className="font-semibold">Run</span> to check the drive for errors. The check is non-destructive and will report the filesystem status.
            </p>
          )}

          {/* Inline Sudo Authentication Field if needed */}
          {needsAuth && (
            <div className="space-y-2 p-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10">
              <label className="font-semibold text-yellow-500 flex items-center gap-1.5 text-xs">
                <Lock className="w-3.5 h-3.5" />
                <span>Administrator Password</span>
              </label>
              <input
                type="password"
                value={password}
                disabled={running}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter sudo password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRun();
                }}
                className={`w-full px-3 py-1.5 rounded-lg border outline-none text-xs transition ${
                  darkMode
                    ? "bg-[#1f1f23] border-white/20 text-white"
                    : "bg-white border-black/20 text-zinc-900"
                }`}
                autoFocus
              />
            </div>
          )}

          {error && (
            <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-[11px] text-[#ff453a] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-current/10">
            <button
              type="button"
              disabled={running}
              onClick={onClose}
              className={`px-4 py-2 rounded-xl text-xs font-medium border transition ${
                darkMode
                  ? "border-white/15 bg-white/5 hover:bg-white/10"
                  : "border-black/15 bg-black/5 hover:bg-black/10"
              }`}
            >
              {report ? "Done" : "Cancel"}
            </button>
            {!report && (
              <button
                type="button"
                disabled={running || (needsAuth && !password)}
                onClick={handleRun}
                className="px-5 py-2 rounded-xl text-xs font-semibold bg-[#0a84ff] text-white hover:opacity-90 disabled:opacity-40 transition flex items-center gap-1.5 shadow-md"
              >
                <Activity className="w-3.5 h-3.5" />
                <span>{needsAuth ? "Authenticate & Run" : "Run First Aid"}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * 8. OPEN WITH / DEFAULT PROGRAM MODAL
 * ========================================================================== */
interface OpenWithModalProps {
  entry: FileEntry | null;
  onClose: () => void;
  onSaveDefaultApp: (
    entry: FileEntry,
    program: string,
    applyToExtension: boolean,
    openNow: boolean
  ) => Promise<void>;
  darkMode: boolean;
}

export const OpenWithModal: React.FC<OpenWithModalProps> = ({
  entry,
  onClose,
  onSaveDefaultApp,
  darkMode,
}) => {
  const [program, setProgram] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  useToolbarOutsideDismiss(dialogRef, Boolean(entry), onClose, busy);

  useEffect(() => {
    if (entry) {
      setProgram(entry.defaultApp || "");
      setBusy(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [entry?.path, entry?.defaultApp]);

  if (!entry) return null;

  const handleSave = async (openNow: boolean) => {
    const trimmed = program.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSaveDefaultApp(entry, trimmed, true, openNow);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSaveDefaultApp(entry, "", true, false);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !busy) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
    >
      <form
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave(true);
        }}
        className={`w-[400px] rounded-2xl border shadow-2xl overflow-hidden backdrop-blur-2xl text-xs select-none ${
          darkMode
            ? "bg-[#26262b]/95 border-white/15 text-zinc-100"
            : "bg-[#f5f5f7]/95 border-black/15 text-zinc-900"
        }`}
      >
        {/* Titlebar */}
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
          <span className="font-semibold truncate max-w-[260px]">
            Open With / Default Program
          </span>
          <span className="w-3" />
        </div>

        {/* File Summary */}
        <div className="p-4 flex items-center gap-3 border-b border-current/10">
          <FileIcon entry={entry} size={44} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm truncate">{entry.name}</div>
            <div className="opacity-60 text-[11px] truncate">
              {entry.kind} • Current:{" "}
              <span className="font-medium">
                {entry.defaultApp || "System Default"}
              </span>
            </div>
          </div>
        </div>

        {/* Input */}
        <div className="p-4 space-y-2">
          <label className="block font-semibold opacity-80">
            Program or Command
          </label>
          <input
            ref={inputRef}
            type="text"
            value={program}
            disabled={busy}
            onChange={(e) => setProgram(e.target.value)}
            placeholder="e.g. gwenview"
            className={`w-full px-3 py-2 rounded-lg border outline-none text-xs font-mono transition focus:ring-2 focus:ring-[#0a84ff] ${
              darkMode
                ? "bg-black/35 border-white/15 text-white placeholder:text-zinc-500"
                : "bg-white border-black/15 text-zinc-900 placeholder:text-zinc-400"
            }`}
          />
          {entry.extension && (
            <p className="text-[11px] opacity-60 pt-0.5">
              This will set the default program for all{" "}
              <span className="font-mono font-semibold">.{entry.extension}</span>{" "}
              files.
            </p>
          )}
        </div>

        {/* Footer Buttons */}
        <div
          className={`px-4 py-3 border-t flex items-center justify-between gap-2 ${
            darkMode ? "border-white/10 bg-black/20" : "border-black/10 bg-black/5"
          }`}
        >
          <div>
            {entry.defaultApp && (
              <button
                type="button"
                disabled={busy}
                onClick={handleReset}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-[#ff453a] hover:bg-[#ff453a]/15 transition cursor-pointer"
              >
                Reset Default
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer ${
                darkMode
                  ? "border-white/15 bg-white/5 hover:bg-white/10"
                  : "border-black/15 bg-black/5 hover:bg-black/10"
              }`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!program.trim() || busy}
              onClick={() => void handleSave(false)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition disabled:opacity-40 cursor-pointer ${
                darkMode
                  ? "border-white/15 bg-white/10 hover:bg-white/15 text-white"
                  : "border-black/15 bg-white hover:bg-zinc-100 text-zinc-900"
              }`}
            >
              Save Default
            </button>
            <button
              type="submit"
              disabled={!program.trim() || busy}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-[#0a84ff] text-white hover:opacity-90 disabled:opacity-40 transition cursor-pointer"
            >
              Save & Open
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};



