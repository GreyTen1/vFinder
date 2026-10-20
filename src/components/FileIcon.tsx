import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FileEntry } from "../types";
import { apiGetImageThumbnail, apiReadFilePreview } from "../api";

interface FileIconProps {
  entry: Pick<
    FileEntry,
    "name" | "isDir" | "extension" | "mimeType" | "isSymlink"
  > & {
    path?: string;
    size?: number;
    modified?: number;
  };
  size?: number;
  className?: string;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
  "jfif",
]);

// Module-level cache of resolved image thumbnail URLs keyed by `${path}::${modified}::${targetSize}`
const THUMBNAIL_URL_CACHE = new Map<string, string>();
const FAILED_THUMBNAILS = new Set<string>();
const INFLIGHT_REQUESTS = new Map<string, Promise<string | null>>();

// Concurrent queue for thumbnail generation
const MAX_CONCURRENT = 6;
let activeTasks = 0;
const pendingQueue: Array<() => void> = [];
let folderAnimEndTime = 0;

export function markFolderAnimationActive(durationMs = 220) {
  folderAnimEndTime = Math.max(folderAnimEndTime, performance.now() + durationMs);
}

function enqueueTask(task: () => Promise<void>) {
  const run = () => {
    activeTasks++;
    task().finally(() => {
      activeTasks--;
      if (pendingQueue.length > 0) {
        const next = pendingQueue.shift();
        next?.();
      }
    });
  };

  if (activeTasks < MAX_CONCURRENT) {
    run();
  } else {
    pendingQueue.push(run);
  }
}

function fetchThumbnail(
  cacheKey: string,
  path: string,
  targetSize: number,
  isSvg: boolean,
  fileSize?: number
): Promise<string | null> {
  const existing = INFLIGHT_REQUESTS.get(cacheKey);
  if (existing) return existing;

  // SVGs are vector graphics; render directly without raster thumbnail
  if (isSvg) {
    try {
      const url = convertFileSrc(path);
      THUMBNAIL_URL_CACHE.set(cacheKey, url);
      return Promise.resolve(url);
    } catch {
      return Promise.resolve(null);
    }
  }

  const promise = new Promise<string | null>((resolve) => {
    enqueueTask(async () => {
      try {
        const thumbPath = await apiGetImageThumbnail(path, targetSize);
        if (thumbPath) {
          try {
            const assetUrl = convertFileSrc(thumbPath);
            THUMBNAIL_URL_CACHE.set(cacheKey, assetUrl);
            resolve(assetUrl);
            return;
          } catch {
            // ignore
          }
        }
        // Fallback: read directly via read_file_preview
        if (fileSize && fileSize <= 5 * 1024 * 1024) {
          try {
            const preview = await apiReadFilePreview(path, 5 * 1024 * 1024);
            if (preview.dataUrl) {
              THUMBNAIL_URL_CACHE.set(cacheKey, preview.dataUrl);
              resolve(preview.dataUrl);
              return;
            }
          } catch {
            // ignore
          }
        }
        resolve(null);
      } catch {
        // Fallback: only if original image is reasonably small (<= 5MB)
        if (fileSize && fileSize <= 5 * 1024 * 1024) {
          try {
            const preview = await apiReadFilePreview(path, 5 * 1024 * 1024);
            if (preview.dataUrl) {
              THUMBNAIL_URL_CACHE.set(cacheKey, preview.dataUrl);
              resolve(preview.dataUrl);
              return;
            }
          } catch {
            // ignore
          }
        }
        resolve(null);
      }
    });
  }).finally(() => {
    INFLIGHT_REQUESTS.delete(cacheKey);
  });

  INFLIGHT_REQUESTS.set(cacheKey, promise);
  return promise;
}

// Shared singleton IntersectionObserver so we never create hundreds of observers when rendering large folders
const observerCallbacks = new Map<Element, () => void>();
let sharedObserver: IntersectionObserver | null = null;

function observeThumbnailElement(el: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => {};
  }
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const item of entries) {
          if (item.isIntersecting) {
            const cb = observerCallbacks.get(item.target);
            if (cb) {
              observerCallbacks.delete(item.target);
              sharedObserver?.unobserve(item.target);
              cb();
            }
          }
        }
      },
      { rootMargin: "180px" }
    );
  }
  observerCallbacks.set(el, onVisible);
  sharedObserver.observe(el);
  return () => {
    observerCallbacks.delete(el);
    sharedObserver?.unobserve(el);
  };
}

function renderDocumentIcon(
  ext: string,
  size: number,
  isSymlink: boolean,
  className: string,
  containerRef?: React.RefObject<HTMLDivElement>
) {
  let badgeColor = "#0A84FF";
  let badgeText = ext ? ext.slice(0, 4).toUpperCase() : "FILE";

  if (["rs", "toml", "c", "cpp", "go"].includes(ext)) {
    badgeColor = "#FF6B35";
  } else if (["ts", "tsx", "js", "jsx", "json"].includes(ext)) {
    badgeColor = "#0A84FF";
  } else if (["py", "sh", "bash", "zsh"].includes(ext)) {
    badgeColor = "#30D158";
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    badgeColor = "#BF5AF2";
    badgeText = ext ? ext.toUpperCase() : "IMG";
  } else if (["mp4", "mkv", "mov", "webm"].includes(ext)) {
    badgeColor = "#FF375F";
    badgeText = "MOV";
  } else if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) {
    badgeColor = "#FF2D55";
    badgeText = "AUD";
  } else if (ext === "pdf") {
    badgeColor = "#FF453A";
    badgeText = "PDF";
  } else if (["zip", "tar", "gz", "xz", "zst", "7z", "rar"].includes(ext)) {
    badgeColor = "#AC8E68";
    badgeText = "ZIP";
  } else if (["md", "txt", "log"].includes(ext)) {
    badgeColor = "#64D2FF";
    badgeText = ext ? ext.toUpperCase() : "TXT";
  }

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Document Page with Folded Corner */}
        <path
          d="M14 11C14 8.23858 16.2386 6 19 6H38.5L50 17.5V53C50 55.7614 47.7614 58 45 58H19C16.2386 58 14 55.7614 14 53V11Z"
          fill="url(#macos-doc-page)"
          stroke="#CBD5E1"
          strokeWidth="1"
        />
        {/* Dog-ear fold */}
        <path
          d="M38.5 6L50 17.5H41.5C39.8431 17.5 38.5 16.1569 38.5 14.5V6Z"
          fill="#D0D7DE"
        />
        {/* Subtle document lines */}
        <rect x="20" y="23" width="18" height="2.4" rx="1.2" fill="#CBD5E1" />
        <rect x="20" y="28.5" width="24" height="2.4" rx="1.2" fill="#CBD5E1" />
        <rect x="20" y="34" width="15" height="2.4" rx="1.2" fill="#CBD5E1" />

        {/* Colored extension badge */}
        <rect x="17" y="41" width="30" height="11" rx="3.5" fill={badgeColor} />
        <text
          x="32"
          y="49"
          textAnchor="middle"
          fill="white"
          fontSize="7.5"
          fontWeight="700"
          fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
        >
          {badgeText}
        </text>
      </svg>

      {isSymlink && (
        <span className="absolute bottom-1 left-2 w-4 h-4 rounded-sm bg-black/75 text-white text-[10px] flex items-center justify-center">
          ↗
        </span>
      )}
    </div>
  );
}

const ImageFileIcon: React.FC<{
  entry: FileIconProps["entry"];
  ext: string;
  size: number;
  className: string;
}> = React.memo(({ entry, ext, size, className }) => {
  const isSvg = ext === "svg";
  const targetSize = size <= 32 ? 64 : size <= 80 ? 128 : 256;
  const entryPath = entry.path || "";
  const cacheKey = `${entryPath}::${entry.modified ?? 0}::${targetSize}`;

  const cachedUrl = THUMBNAIL_URL_CACHE.get(cacheKey) || null;
  const [imgSrc, setImgSrc] = useState<string | null>(cachedUrl);
  const [imgFailed, setImgFailed] = useState(() =>
    FAILED_THUMBNAILS.has(cacheKey)
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(() => Boolean(cachedUrl));

  const effectiveSrc = cachedUrl || imgSrc;

  useEffect(() => {
    if (FAILED_THUMBNAILS.has(cacheKey)) {
      setImgFailed(true);
      setImgSrc(null);
      return;
    }
    const cached = THUMBNAIL_URL_CACHE.get(cacheKey);
    if (cached) {
      setImgSrc(cached);
      setImgFailed(false);
    }
  }, [cacheKey]);

  useEffect(() => {
    if (effectiveSrc || imgFailed) return;
    const el = containerRef.current;
    if (!el) return;
    return observeThumbnailElement(el, () => setIsVisible(true));
  }, [effectiveSrc, imgFailed]);

  useEffect(() => {
    if (!isVisible || effectiveSrc || imgFailed || !entryPath) return;

    let cancelled = false;
    let timerId: number | null = null;

    const startFetch = () => {
      if (cancelled) return;
      fetchThumbnail(cacheKey, entryPath, targetSize, isSvg, entry.size).then(
        (url) => {
          if (cancelled) return;
          if (url) {
            setImgSrc(url);
            setImgFailed(false);
          } else {
            setImgFailed(true);
          }
        }
      );
    };

    const remainingAnimMs = folderAnimEndTime - performance.now();
    if (remainingAnimMs > 8) {
      timerId = window.setTimeout(startFetch, Math.ceil(remainingAnimMs));
    } else {
      startFetch();
    }

    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [isVisible, effectiveSrc, imgFailed, entryPath, cacheKey, targetSize, isSvg, entry.size]);

  const handleImgError = async () => {
    if (entryPath && (!effectiveSrc || !effectiveSrc.startsWith("data:"))) {
      try {
        const preview = await apiReadFilePreview(entryPath, 5 * 1024 * 1024);
        if (preview.dataUrl) {
          THUMBNAIL_URL_CACHE.set(cacheKey, preview.dataUrl);
          setImgSrc(preview.dataUrl);
          setImgFailed(false);
          return;
        }
      } catch {
        // ignore
      }
    }
    FAILED_THUMBNAILS.add(cacheKey);
    setImgFailed(true);
  };

  if (effectiveSrc && !imgFailed) {
    const isCompact = size < 28;
    return (
      <div
        ref={containerRef}
        className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
        style={{ width: size, height: size }}
      >
        {isCompact ? (
          <img
            src={effectiveSrc}
            alt={entry.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={handleImgError}
            className="w-full h-full object-cover rounded-[3px] border border-white/25 bg-black/20 shadow-xs pointer-events-none"
          />
        ) : (
          <div className="w-full h-full p-[3px] flex items-center justify-center">
            <img
              src={effectiveSrc}
              alt={entry.name}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={handleImgError}
              className="max-w-full max-h-full object-contain rounded-[4px] border border-white/30 bg-black/20 shadow-md pointer-events-none"
            />
          </div>
        )}

        {entry.isSymlink && (
          <span className="absolute bottom-0.5 left-0.5 w-4 h-4 rounded-sm bg-black/75 text-white text-[10px] flex items-center justify-center">
            ↗
          </span>
        )}
      </div>
    );
  }

  return renderDocumentIcon(ext, size, Boolean(entry.isSymlink), className, containerRef);
});

export const FileIcon: React.FC<FileIconProps> = React.memo(
  ({ entry, size = 56, className = "" }) => {
    if (entry.isDir) {
      const lowerName = entry.name.toLowerCase();
      return (
        <div
          className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
          style={{ width: size, height: size }}
        >
          <svg
            viewBox="0 0 64 64"
            width={size}
            height={size}
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Subtle base shadow rect (GPU friendly, avoids slow CSS filter drop-shadow) */}
            <rect
              x="6"
              y="22"
              width="52"
              height="35"
              rx="6"
              fill="#000000"
              fillOpacity="0.22"
            />
            {/* Back tab of macOS folder */}
            <path
              d="M6 15C6 12.2386 8.23858 10 11 10H23.5C25.1 10 26.5 10.8 27.4 12.1L29.6 15.1C30.3 16 31.3 16.5 32.5 16.5H53C55.7614 16.5 58 18.7386 58 21.5V49C58 51.7614 55.7614 54 53 54H11C8.23858 54 6 51.7614 6 49V15Z"
              fill="url(#macos-folder-back)"
            />
            {/* Front pocket of macOS folder */}
            <rect
              x="5"
              y="19"
              width="54"
              height="36"
              rx="6"
              fill="url(#macos-folder-front)"
            />
            {/* Top highlight rim */}
            <path
              d="M11 19.5H53C55.8 19.5 58 21.7 58 24.5V25C58 22.2 55.8 20 53 20H11C8.2 20 6 22.2 6 25V24.5C6 21.7 8.2 19.5 11 19.5Z"
              fill="white"
              fillOpacity="0.45"
            />

            {/* Embossed macOS folder badge for special directories */}
            {lowerName === "downloads" && (
              <path
                d="M32 28V41M32 41L26.5 35.5M32 41L37.5 35.5M25 45H39"
                stroke="#146BB8"
                strokeOpacity="0.65"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {lowerName === "documents" && (
              <g
                stroke="#146BB8"
                strokeOpacity="0.65"
                strokeWidth="2.2"
                strokeLinecap="round"
              >
                <rect x="25" y="27" width="14" height="18" rx="2" />
                <line x1="28.5" y1="32" x2="35.5" y2="32" />
                <line x1="28.5" y1="36" x2="35.5" y2="36" />
                <line x1="28.5" y1="40" x2="33" y2="40" />
              </g>
            )}
            {lowerName === "desktop" && (
              <g
                stroke="#146BB8"
                strokeOpacity="0.65"
                strokeWidth="2.2"
                strokeLinecap="round"
              >
                <rect x="23" y="28" width="18" height="12" rx="2" />
                <line x1="28" y1="44" x2="36" y2="44" />
                <line x1="32" y1="40" x2="32" y2="44" />
              </g>
            )}
            {(lowerName === "pictures" || lowerName === "photos") && (
              <g
                stroke="#146BB8"
                strokeOpacity="0.65"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="23" y="28" width="18" height="15" rx="2.5" />
                <circle
                  cx="28"
                  cy="33"
                  r="1.5"
                  fill="#146BB8"
                  fillOpacity="0.65"
                />
                <path d="M24 41L29.5 36L34 40L37 37.5L40 41" />
              </g>
            )}
            {lowerName === "music" && (
              <g
                stroke="#146BB8"
                strokeOpacity="0.65"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M29 41V30L38 28V39" />
                <circle cx="27" cy="41" r="2.2" />
                <circle cx="36" cy="39" r="2.2" />
              </g>
            )}
          </svg>

          {entry.isSymlink && (
            <span className="absolute bottom-1 left-1 w-4 h-4 rounded-sm bg-black/75 text-white text-[10px] flex items-center justify-center">
              ↗
            </span>
          )}
        </div>
      );
    }

    const ext = (entry.extension || "").toLowerCase();
    const isImageFile =
      Boolean(entry.path) &&
      (IMAGE_EXTENSIONS.has(ext) ||
        (entry.mimeType && entry.mimeType.startsWith("image/")));

    if (isImageFile) {
      return (
        <ImageFileIcon
          entry={entry}
          ext={ext}
          size={size}
          className={className}
        />
      );
    }

    return renderDocumentIcon(ext, size, Boolean(entry.isSymlink), className);
  }
);
