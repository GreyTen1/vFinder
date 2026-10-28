import React, { useState } from "react";
import {
  Clock,
  Home,
  Monitor,
  FileText,
  Download,
  Image,
  Music,
  Film,
  HardDrive,
  Folder,
  ChevronRight,
  Usb,
  Disc,
  X,
  Trash2,
} from "lucide-react";
import { SidebarData, TAG_COLORS, VolumeInfo, formatBytes } from "../types";

interface SidebarProps {
  data: SidebarData | null;
  currentPath: string;
  activeTag: string | null;
  onNavigate: (path: string, title?: string) => void;
  onSelectVolume: (vol: VolumeInfo) => void;
  onUnmountVolume: (vol: VolumeInfo) => void;
  onSelectTag: (tagColor: string) => void;
  darkMode: boolean;
  customFavorites: { name: string; path: string }[];
  onRemoveFavorite: (path: string) => void;
  dropTargetPath?: string | null;
  dropTargetTag?: string | null;
  dropFavoriteZone?: boolean;
  isDraggingDirs?: boolean;
  onContextMenuFavorite?: (
    e: React.MouseEvent,
    fav: { name: string; path: string; isCustom?: boolean }
  ) => void;
  onContextMenuVolume?: (e: React.MouseEvent, vol: VolumeInfo) => void;
  hiddenFavorites?: string[];
  onPrefetch?: (path: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = React.memo(({
  data,
  currentPath,
  activeTag,
  onNavigate,
  onSelectVolume,
  onUnmountVolume,
  onSelectTag,
  darkMode,
  customFavorites,
  onRemoveFavorite,
  dropTargetPath,
  dropTargetTag,
  dropFavoriteZone,
  isDraggingDirs,
  onContextMenuFavorite,
  onContextMenuVolume,
  hiddenFavorites,
  onPrefetch,
}) => {
  const [favOpen, setFavOpen] = useState(true);
  const [locOpen, setLocOpen] = useState(true);
  const [showSystemParts, setShowSystemParts] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(true);

  const renderFavIcon = (iconName: string) => {
    const cls = "w-4 h-4 shrink-0 text-[#0a84ff]";
    switch (iconName) {
      case "clock":
        return <Clock className={cls} />;
      case "home":
        return <Home className={cls} />;
      case "monitor":
        return <Monitor className={cls} />;
      case "file-text":
        return <FileText className={cls} />;
      case "download":
        return <Download className={cls} />;
      case "image":
        return <Image className={cls} />;
      case "music":
        return <Music className={cls} />;
      case "film":
        return <Film className={cls} />;
      case "trash":
        return <Trash2 className={cls} />;
      default:
        return <Folder className={cls} />;
    }
  };

  const tagCounts: Record<string, number> = {};
  if (data?.tags) {
    Object.values(data.tags).forEach((colorList) => {
      colorList.forEach((c) => {
        tagCounts[c] = (tagCounts[c] || 0) + 1;
      });
    });
  }

  const allVolumes = data?.volumes || [];
  const removableVolumes = allVolumes.filter((v) => v.isRemovable && !v.isSystem);
  const internalVolumes = allVolumes.filter((v) => !v.isRemovable && !v.isSystem);
  const systemVolumes = allVolumes.filter((v) => v.isSystem);

  const renderVolumeCard = (vol: VolumeInfo) => {
    const selected =
      !activeTag &&
      vol.isMounted &&
      vol.mountPoint &&
      (currentPath === vol.mountPoint ||
        (vol.mountPoint !== "/" && currentPath.startsWith(vol.mountPoint + "/")));

    const isDropTarget =
      vol.isMounted && Boolean(vol.mountPoint) && dropTargetPath === vol.mountPoint;

    const usedRatio =
      vol.isMounted && vol.totalSpace > 0
        ? Math.min(100, Math.round((vol.usedSpace / vol.totalSpace) * 100))
        : 0;

    return (
      <div
        key={vol.device}
        data-drop-path={vol.isMounted && vol.mountPoint ? vol.mountPoint : undefined}
        data-drop-name={vol.name}
        onMouseEnter={() => {
          if (vol.isMounted && vol.mountPoint) {
            onPrefetch?.(vol.mountPoint);
          }
        }}
        onClick={() => onSelectVolume(vol)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenuVolume?.(e, vol);
        }}
        className={`group w-full flex flex-col gap-1 px-2.5 py-1.5 rounded-lg text-left cursor-pointer transition-colors ${
          isDropTarget
            ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/25 text-white"
            : selected
            ? darkMode
              ? "bg-white/15 text-white"
              : "bg-black/10 text-zinc-900"
            : darkMode
            ? "hover:bg-white/[0.07] text-zinc-300"
            : "hover:bg-black/[0.05] text-zinc-700"
        }`}
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-2 min-w-0">
            {vol.isRemovable ? (
              <Usb
                className={`w-4 h-4 shrink-0 ${
                  vol.isMounted ? "text-[#0a84ff]" : "opacity-45"
                }`}
              />
            ) : vol.isSystem ? (
              <Disc
                className={`w-4 h-4 shrink-0 ${
                  vol.isMounted ? "text-purple-400" : "opacity-40"
                }`}
              />
            ) : (
              <HardDrive
                className={`w-4 h-4 shrink-0 ${
                  vol.isMounted ? "text-[#0a84ff]" : "opacity-45"
                }`}
              />
            )}
            <span
              className={`truncate text-[12.5px] font-medium ${
                vol.isMounted ? "" : "opacity-75"
              }`}
            >
              {vol.name}
            </span>
          </div>

          {/* Status badge or Eject button */}
          <div className="flex items-center gap-1 shrink-0">
            {!vol.isMounted && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#0a84ff]/20 text-[#0a84ff] font-medium group-hover:bg-[#0a84ff]/30">
                Mount
              </span>
            )}
            {vol.canUnmount && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onUnmountVolume(vol);
                }}
                title={`Unmount ${vol.name} (${vol.device})`}
                className="opacity-60 hover:opacity-100 px-1 py-0.5 rounded hover:bg-current/10 text-[11px] leading-none"
              >
                ⏏
              </button>
            )}
          </div>
        </div>

        {/* Device & Filesystem info */}
        <div className="pl-6 pr-1 flex flex-col gap-0.5">
          <div className="flex items-center justify-between text-[10px] opacity-55">
            <span>
              {vol.shortDevice} • {vol.fileSystem.toUpperCase()}{vol.isRemovable ? " • USB" : ""}
            </span>
            <span>{formatBytes(vol.totalSpace)}</span>
          </div>

          {vol.isMounted && vol.totalSpace > 0 ? (
            <>
              <div
                className={`w-full h-1 rounded-full overflow-hidden mt-0.5 ${
                  darkMode ? "bg-white/10" : "bg-black/10"
                }`}
              >
                <div
                  className="h-full bg-[#0a84ff] rounded-full"
                  style={{ width: `${usedRatio}%` }}
                />
              </div>
              <span className="text-[10px] opacity-50">
                {vol.availableSpace > 0
                  ? `${formatBytes(vol.availableSpace)} free`
                  : `Mounted at ${vol.mountPoint}`}
              </span>
            </>
          ) : (
            <span className="text-[10px] opacity-40 italic">
              Not mounted
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      className={`macos-layer-isolate w-60 h-full shrink-0 border-r flex flex-col overflow-y-auto px-2.5 py-3 select-none ${
        darkMode
          ? "macos-sidebar-glass-dark border-white/10 text-zinc-200"
          : "macos-sidebar-glass-light border-black/10 text-zinc-800"
      }`}
    >
      {/* FAVORITES SECTION */}
      <div
        data-drop-favorite-zone="true"
        className={`mb-4 rounded-xl ${
          dropFavoriteZone && isDraggingDirs
            ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/10 p-1 -m-1"
            : ""
        }`}
      >
        <button
          type="button"
          onClick={() => setFavOpen((v) => !v)}
          className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold tracking-wide opacity-55 hover:opacity-85"
        >
          <span>Favorites</span>
          <span className={`disclosure-arrow ${favOpen ? "is-open" : ""}`}>
            <ChevronRight className="w-3 h-3 pointer-events-none" />
          </span>
        </button>

        {favOpen && (
          <div className="mt-0.5 space-y-0.5">
            {(data?.favorites || [])
              .filter((fav) => !hiddenFavorites?.includes(fav.path))
              .map((fav) => {
                const selected = !activeTag && currentPath === fav.path;
                const canDrop = fav.path !== "__RECENTS__";
                const isDropTarget = canDrop && dropTargetPath === fav.path;
                return (
                  <button
                    key={fav.id}
                    type="button"
                    data-drop-path={canDrop ? fav.path : undefined}
                    data-drop-name={canDrop ? fav.name : undefined}
                    onMouseEnter={() => onPrefetch?.(fav.path)}
                    onClick={() => onNavigate(fav.path, fav.name)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onContextMenuFavorite?.(e, {
                        name: fav.name,
                        path: fav.path,
                        isCustom: false,
                      });
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] font-medium ${
                      isDropTarget
                        ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/25 text-white"
                        : selected
                        ? darkMode
                          ? "bg-white/15 text-white"
                          : "bg-black/10 text-zinc-900"
                        : darkMode
                        ? "hover:bg-white/[0.07] text-zinc-300"
                        : "hover:bg-black/[0.05] text-zinc-700"
                    }`}
                  >
                    {renderFavIcon(fav.icon)}
                    <span className="truncate">{fav.name}</span>
                  </button>
                );
              })}

            {customFavorites.map((cf) => {
              const selected = !activeTag && currentPath === cf.path;
              const isDropTarget = dropTargetPath === cf.path;
              return (
                <div
                  key={cf.path}
                  data-drop-path={cf.path}
                  data-drop-name={cf.name}
                  onMouseEnter={() => onPrefetch?.(cf.path)}
                  onClick={() => onNavigate(cf.path, cf.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onContextMenuFavorite?.(e, {
                      name: cf.name,
                      path: cf.path,
                      isCustom: true,
                    });
                  }}
                  className={`group w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer ${
                    isDropTarget
                      ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/25 text-white"
                      : selected
                      ? darkMode
                        ? "bg-white/15 text-white"
                        : "bg-black/10 text-zinc-900"
                      : darkMode
                      ? "hover:bg-white/[0.07] text-zinc-300"
                      : "hover:bg-black/[0.05] text-zinc-700"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Folder className="w-4 h-4 shrink-0 text-[#0a84ff]" />
                    <span className="truncate">{cf.name}</span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveFavorite(cf.path);
                    }}
                    title="Remove from Sidebar"
                    className="invisible group-hover:visible opacity-60 hover:opacity-100 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}

            {isDraggingDirs && (
              <div
                data-drop-favorite-zone="true"
                className={`mt-1 px-2.5 py-1.5 rounded-lg border border-dashed text-[11px] text-center ${
                  dropFavoriteZone
                    ? "border-[#0a84ff] bg-[#0a84ff]/20 text-white font-medium"
                    : "border-current/25 opacity-60"
                }`}
              >
                + Drop folder to pin to Sidebar
              </div>
            )}
          </div>
        )}
      </div>

      {/* LOCATIONS / PARTITIONS SECTION */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setLocOpen((v) => !v)}
          className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold tracking-wide opacity-55 hover:opacity-85"
        >
          <span>Locations</span>
          <span className={`disclosure-arrow ${locOpen ? "is-open" : ""}`}>
            <ChevronRight className="w-3 h-3 pointer-events-none" />
          </span>
        </button>

        {locOpen && (
          <div className="mt-0.5 space-y-1">
            {removableVolumes.length > 0 && (
              <div className="space-y-1 mb-2">
                <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider opacity-50 flex items-center gap-1.5">
                  <Usb className="w-3 h-3 text-[#0a84ff]" />
                  <span>External / USB Drives ({removableVolumes.length})</span>
                </div>
                {removableVolumes.map(renderVolumeCard)}
                <div className="my-1.5 border-t border-current/10" />
              </div>
            )}

            {internalVolumes.map(renderVolumeCard)}

            {systemVolumes.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowSystemParts((v) => !v)}
                  className="w-full px-2.5 py-1 text-left text-[10.5px] opacity-45 hover:opacity-80 flex items-center justify-between"
                >
                  <span>
                    {showSystemParts
                      ? "Hide Boot / Recovery Partitions"
                      : `Show Boot / Recovery (${systemVolumes.length})`}
                  </span>
                  <span
                    className={`disclosure-arrow ${
                      showSystemParts ? "is-open" : ""
                    }`}
                  >
                    <ChevronRight className="w-2.5 h-2.5 pointer-events-none" />
                  </span>
                </button>
                {showSystemParts && (
                  <div className="mt-1 space-y-1">
                    {systemVolumes.map(renderVolumeCard)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* TAGS SECTION */}
      <div>
        <button
          type="button"
          onClick={() => setTagsOpen((v) => !v)}
          className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold tracking-wide opacity-55 hover:opacity-85"
        >
          <span>Tags</span>
          <span className={`disclosure-arrow ${tagsOpen ? "is-open" : ""}`}>
            <ChevronRight className="w-3 h-3 pointer-events-none" />
          </span>
        </button>

        {tagsOpen && (
          <div className="mt-0.5 space-y-0.5">
            {TAG_COLORS.map((tag) => {
              const selected = activeTag === tag.id;
              const isDropTag = dropTargetTag === tag.id;
              const count = tagCounts[tag.id] || 0;
              return (
                <button
                  key={tag.id}
                  type="button"
                  data-drop-tag={tag.id}
                  data-drop-tag-name={tag.name}
                  onClick={() => onSelectTag(tag.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[13px] font-medium ${
                    isDropTag
                      ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/25 text-white"
                      : selected
                      ? darkMode
                        ? "bg-white/15 text-white"
                        : "bg-black/10 text-zinc-900"
                      : darkMode
                      ? "hover:bg-white/[0.07] text-zinc-300"
                      : "hover:bg-black/[0.05] text-zinc-700"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`w-3 h-3 rounded-full ${tag.bgClass} shadow-xs`}
                    />
                    <span>{tag.name}</span>
                  </div>
                  {count > 0 && (
                    <span className="text-[11px] opacity-50">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
});

