import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Eye,
} from "lucide-react";
import {
  FileEntry,
  FilePreview,
  SortDirection,
  SortField,
  TAG_COLORS,
  formatBytes,
  formatMacDate,
} from "../types";
import { FileIcon, markFolderAnimationActive } from "./FileIcon";
import { apiGetFilePreviewUrl, apiReadDirectory, apiReadFilePreview } from "../api";
import { convertFileSrc } from "@tauri-apps/api/core";

export interface SelectionModifiers {
  ctrlKey: boolean;
  shift: boolean;
}

export interface CommonViewProps {
  entries: FileEntry[];
  selectedPaths: string[];
  onSelect: (
    entry: FileEntry,
    modifiers: SelectionModifiers,
    orderedEntries?: FileEntry[]
  ) => void;
  onSetSelection: (paths: string[]) => void;
  onClearSelection: () => void;
  onOpenEntry: (entry: FileEntry) => void;
  onContextMenu: (
    e: React.MouseEvent,
    entry?: FileEntry,
    targetDir?: string
  ) => void;
  onStartItemDrag: (
    e: React.MouseEvent,
    entry: FileEntry,
    orderedEntries?: FileEntry[],
    onClickOverride?: (entry: FileEntry, modifiers: SelectionModifiers) => void
  ) => void;
  dropTargetPath: string | null;
  draggedPaths: string[];
  refreshVersion: number;
  renamingPath: string | null;
  renameValue: string;
  onRenameChange: (val: string) => void;
  onStartRename: (entry: FileEntry) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  darkMode: boolean;
  iconSize: number;
  sortField: SortField;
  sortDirection: SortDirection;
  onChangeSort: (field: SortField) => void;
  showHidden: boolean;
  onToggleTag: (path: string, color: string) => void;
  onQuickLook: () => void;
}

interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Reusable hook for macOS Finder rubber-band (marquee) cursor selection
 * inside a scrollable view container, including auto-scrolling on edges.
 */
export function useMarqueeSelection({
  containerRef,
  selectedPaths,
  onSetSelection,
  onClearSelection,
  onClickEntryFallback,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  selectedPaths: string[];
  onSetSelection: (paths: string[]) => void;
  onClearSelection: () => void;
  onClickEntryFallback?: (
    path: string,
    modifiers: SelectionModifiers
  ) => void;
}) {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;

  const onSetSelectionRef = useRef(onSetSelection);
  onSetSelectionRef.current = onSetSelection;

  const onClearSelectionRef = useRef(onClearSelection);
  onClearSelectionRef.current = onClearSelection;

  const onClickEntryFallbackRef = useRef(onClickEntryFallback);
  onClickEntryFallbackRef.current = onClickEntryFallback;

  const handleContainerMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target) return;

    // Ignore interactive controls or inputs
    if (
      target.closest("input, textarea, button, thead, [data-no-marquee]")
    ) {
      return;
    }

    // If user pressed directly on an item's drag handle, let item drag handler run
    if (target.closest("[data-drag-handle]")) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    // Ignore clicks on scrollbar track or thumb (vertical and horizontal)
    const cRect = container.getBoundingClientRect();
    if (
      e.clientX >= cRect.left + container.clientWidth ||
      e.clientY >= cRect.top + container.clientHeight
    ) {
      return;
    }

    const entryEl = target.closest("[data-entry-path]") as HTMLElement | null;
    const clickedEntryPath = entryEl?.getAttribute("data-entry-path") || null;

    // If clicking on an already-selected row in ListView without modifiers, let item drag handle it
    if (
      clickedEntryPath &&
      selectedPathsRef.current.includes(clickedEntryPath) &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey
    ) {
      return;
    }

    e.preventDefault();

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const rectInit = container.getBoundingClientRect();
    const startScrollX = container.scrollLeft + (startClientX - rectInit.left);
    const startScrollY = container.scrollTop + (startClientY - rectInit.top);

    const additive = e.ctrlKey || e.shiftKey;
    const baseSelection = additive ? [...selectedPathsRef.current] : [];

    let isMarqueeActive = false;
    let lastClientX = startClientX;
    let lastClientY = startClientY;
    let autoScrollFrame: number | null = null;
    let cachedItems: {
      path: string;
      left: number;
      top: number;
      right: number;
      bottom: number;
    }[] | null = null;
    let prevSelectionKey = selectedPathsRef.current.join("\0");

    const buildCachedItems = (
      c: HTMLDivElement,
      previousItems: NonNullable<typeof cachedItems> = []
    ) => {
      const cRect = c.getBoundingClientRect();
      const sLeft = c.scrollLeft;
      const sTop = c.scrollTop;
      const nodes = c.querySelectorAll<HTMLElement>("[data-entry-path]");
      const itemsByPath = new Map(previousItems.map((item) => [item.path, item]));
      const list: {
        path: string;
        left: number;
        top: number;
        right: number;
        bottom: number;
      }[] = [];
      nodes.forEach((node) => {
        const p = node.getAttribute("data-entry-path");
        if (!p) return;
        const nRect = node.getBoundingClientRect();
        if (nRect.width <= 0 || nRect.height <= 0) return;
        const left = nRect.left - cRect.left + sLeft;
        const top = nRect.top - cRect.top + sTop;
        itemsByPath.set(p, {
          path: p,
          left,
          top,
          right: left + nRect.width,
          bottom: top + nRect.height,
        });
      });
      return Array.from(itemsByPath.values());
    };

    const updateMarquee = (clientX: number, clientY: number) => {
      const c = containerRef.current;
      if (!c) return;
      if (!cachedItems) {
        cachedItems = buildCachedItems(c);
      }
      const cRect = c.getBoundingClientRect();
      const curScrollX = Math.max(
        0,
        Math.min(c.scrollWidth, c.scrollLeft + (clientX - cRect.left))
      );
      const curScrollY = Math.max(
        0,
        Math.min(c.scrollHeight, c.scrollTop + (clientY - cRect.top))
      );

      const left = Math.min(startScrollX, curScrollX);
      const top = Math.min(startScrollY, curScrollY);
      const width = Math.abs(curScrollX - startScrollX);
      const height = Math.abs(curScrollY - startScrollY);

      setMarqueeRect({ left, top, width, height });

      const hitPaths: string[] = [];
      for (let i = 0; i < cachedItems.length; i++) {
        const item = cachedItems[i];
        if (
          item.left < left + width &&
          item.right > left &&
          item.top < top + height &&
          item.bottom > top
        ) {
          hitPaths.push(item.path);
        }
      }

      let nextSelection: string[];
      if (additive) {
        const combined = new Set(baseSelection);
        for (let i = 0; i < hitPaths.length; i++) {
          const p = hitPaths[i];
          if (baseSelection.includes(p)) {
            combined.delete(p);
          } else {
            combined.add(p);
          }
        }
        nextSelection = Array.from(combined);
      } else {
        nextSelection = hitPaths;
      }

      const nextKey = nextSelection.join("\0");
      if (nextKey !== prevSelectionKey) {
        prevSelectionKey = nextKey;
        onSetSelectionRef.current(nextSelection);
      }
    };

    const tickAutoScroll = () => {
      const c = containerRef.current;
      if (!c || !isMarqueeActive) return;
      const cRect = c.getBoundingClientRect();
      const edgeThreshold = 36;
      const maxSpeed = 14;
      let scrolled = false;

      if (lastClientY < cRect.top + edgeThreshold && c.scrollTop > 0) {
        const ratio = Math.min(
          1,
          (cRect.top + edgeThreshold - lastClientY) / edgeThreshold
        );
        c.scrollTop = Math.max(0, c.scrollTop - Math.ceil(ratio * maxSpeed));
        scrolled = true;
      } else if (
        lastClientY > cRect.bottom - edgeThreshold &&
        c.scrollTop < c.scrollHeight - c.clientHeight
      ) {
        const ratio = Math.min(
          1,
          (lastClientY - (cRect.bottom - edgeThreshold)) / edgeThreshold
        );
        c.scrollTop = Math.min(
          c.scrollHeight - c.clientHeight,
          c.scrollTop + Math.ceil(ratio * maxSpeed)
        );
        scrolled = true;
      }

      if (scrolled) {
        cachedItems = buildCachedItems(c, cachedItems || []);
        updateMarquee(lastClientX, lastClientY);
      }
      autoScrollFrame = requestAnimationFrame(tickAutoScroll);
    };

    let marqueeRaf: number | null = null;
    let pendingMouseX = startClientX;
    let pendingMouseY = startClientY;

    const scheduleMarqueeUpdate = (clientX: number, clientY: number) => {
      pendingMouseX = clientX;
      pendingMouseY = clientY;
      if (marqueeRaf === null) {
        marqueeRaf = requestAnimationFrame(() => {
          marqueeRaf = null;
          updateMarquee(pendingMouseX, pendingMouseY);
        });
      }
    };

    const onMouseMove = (ev: MouseEvent) => {
      lastClientX = ev.clientX;
      lastClientY = ev.clientY;
      const dist = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
      if (!isMarqueeActive && dist > 3) {
        isMarqueeActive = true;
        autoScrollFrame = requestAnimationFrame(tickAutoScroll);
      }
      if (isMarqueeActive) {
        scheduleMarqueeUpdate(ev.clientX, ev.clientY);
      }
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (autoScrollFrame !== null) {
        cancelAnimationFrame(autoScrollFrame);
      }
      if (marqueeRaf !== null) {
        cancelAnimationFrame(marqueeRaf);
        marqueeRaf = null;
      }
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      if (isMarqueeActive) {
        updateMarquee(ev.clientX, ev.clientY);
        setMarqueeRect(null);
      } else {
        // Plain click without marquee drag
        if (clickedEntryPath && onClickEntryFallbackRef.current) {
          onClickEntryFallbackRef.current(clickedEntryPath, {
            ctrlKey: ev.ctrlKey,
            shift: ev.shiftKey,
          });
        } else if (!additive) {
          onClearSelectionRef.current();
        }
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [containerRef]);

  return { marqueeRect, handleContainerMouseDown };
}

const TagDots: React.FC<{ tags: string[] }> = ({ tags }) => {
  if (!tags || tags.length === 0) return null;
  return (
    <span className="inline-flex items-center -space-x-1 ml-1 shrink-0">
      {tags.slice(0, 3).map((t) => {
        const def = TAG_COLORS.find((c) => c.id === t);
        if (!def) return null;
        return (
          <span
            key={t}
            className={`w-2.5 h-2.5 rounded-full border border-black/20 ${def.bgClass}`}
          />
        );
      })}
    </span>
  );
};

/* ============================================================================
 * 1. ICON VIEW (macOS Finder Grid View)
 * ========================================================================== */
const FAST_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const LIST_VIRTUALIZATION_THRESHOLD = 150;

interface IconViewItemProps {
  entry: FileEntry;
  isSelected: boolean;
  isRenaming: boolean;
  isDropTarget: boolean;
  isBeingDragged: boolean;
  darkMode: boolean;
  iconSize: number;
  renameValue: string;
  virtualStyle?: React.CSSProperties;
  onOpenEntry: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onStartItemDrag: (e: React.MouseEvent, entry: FileEntry) => void;
  onRenameChange: (val: string) => void;
  onStartRename: (entry: FileEntry) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
}

const IconViewItem = React.memo<IconViewItemProps>(
  ({
    entry,
    isSelected,
    isRenaming,
    isDropTarget,
    isBeingDragged,
    darkMode,
    iconSize,
    renameValue,
    virtualStyle,
    onOpenEntry,
    onContextMenu,
    onStartItemDrag,
    onRenameChange,
    onStartRename,
    onRenameSubmit,
    onRenameCancel,
  }) => {
    const maxW = Math.max(120, iconSize + 44);
    return (
      <div
        data-entry-path={entry.path}
        data-drop-path={entry.isDir ? entry.path : undefined}
        data-drop-name={entry.isDir ? entry.name : undefined}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpenEntry(entry);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          onContextMenu(e, entry);
        }}
        style={{
          maxWidth: maxW,
          ...virtualStyle,
        }}
        className={`group flex flex-col items-center p-1.5 rounded-xl cursor-default w-full ${
          entry.isHidden ? "opacity-55" : ""
        } ${isBeingDragged ? "opacity-45" : ""} ${
          isDropTarget ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/20" : ""
        }`}
      >
        {/* Icon container with macOS rounded selection highlight */}
        <div
          data-drag-handle="true"
          onMouseDown={(e) => onStartItemDrag(e, entry)}
          className={`p-2 rounded-xl ${
            isDropTarget
              ? "bg-[#0a84ff]/25"
              : isSelected
              ? darkMode
                ? "bg-white/15"
                : "bg-black/10"
              : "group-hover:bg-white/[0.04]"
          }`}
        >
          <FileIcon entry={entry} size={iconSize} />
        </div>

        {/* Label pill */}
        {isRenaming ? (
          <textarea
            data-rename-input
            autoFocus
            rows={1}
            wrap="soft"
            onFocus={(e) => {
              e.target.select();
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            value={renameValue}
            onChange={(e) => {
              onRenameChange(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameSubmit();
              if (e.key === "Escape") onRenameCancel();
            }}
            onBlur={onRenameSubmit}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              fontSize: "12px",
              lineHeight: "1.25",
              color: isSelected
                ? darkMode
                  ? "rgba(255,255,255,.9)"
                  : "#18181b"
                : undefined,
            }}
            className="mt-1.5 block w-full min-w-0 max-w-full resize-none overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-2 py-0.5 text-center leading-tight rounded-md bg-transparent border-0 outline-none shadow-none focus:ring-0"
          />
        ) : (
          <div
            data-drag-handle="true"
            onMouseDown={(e) => onStartItemDrag(e, entry)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onStartRename(entry);
            }}
            onClick={(e) => e.stopPropagation()}
            className={`mt-1.5 px-2 py-0.5 rounded-md text-[12px] leading-tight text-center max-w-full flex items-center justify-center gap-1 ${
              isDropTarget || isSelected
                ? isDropTarget
                  ? "bg-[#0a84ff]/25 text-white font-medium"
                  : darkMode
                  ? "bg-white/15 text-white font-medium"
                  : "bg-black/10 text-zinc-900 font-medium"
                : darkMode
                ? "text-zinc-200"
                : "text-zinc-800"
            }`}
          >
            <span className="truncate">{entry.name}</span>
            <TagDots tags={entry.tags} />
          </div>
        )}
      </div>
    );
  }
);

export const IconView: React.FC<CommonViewProps> = ({
  entries,
  selectedPaths,
  onSelect,
  onSetSelection,
  onClearSelection,
  onOpenEntry,
  onContextMenu,
  onStartItemDrag,
  dropTargetPath,
  draggedPaths,
  renamingPath,
  renameValue,
  onRenameChange,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  darkMode,
  iconSize,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [gridViewport, setGridViewport] = useState({ width: 0, height: 0, top: 0 });
  const gridScrollFrameRef = useRef<number | null>(null);
  const cellWidth = Math.max(96, iconSize + 44);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const draggedSet = useMemo(() => new Set(draggedPaths), [draggedPaths]);

  const handleStartDragBound = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => {
      onStartItemDrag(e, entry, entriesRef.current);
    },
    [onStartItemDrag]
  );

  const handleClickEntryByPath = useCallback(
    (path: string, modifiers: SelectionModifiers) => {
      const found = entriesRef.current.find((e) => e.path === path);
      if (found) {
        onSelect(found, modifiers, entriesRef.current);
      }
    },
    [onSelect]
  );

  const { marqueeRect, handleContainerMouseDown } = useMarqueeSelection({
    containerRef,
    selectedPaths,
    onSetSelection,
    onClearSelection,
    onClickEntryFallback: handleClickEntryByPath,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateSize = () => {
      setGridViewport((current) => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        const top = container.scrollTop;
        return current.width === width && current.height === height && current.top === top
          ? current
          : { width, height, top };
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const handleGridScroll = useCallback(() => {
    if (gridScrollFrameRef.current !== null) return;
    gridScrollFrameRef.current = requestAnimationFrame(() => {
      gridScrollFrameRef.current = null;
      const container = containerRef.current;
      if (!container) return;
      setGridViewport((current) =>
        current.top === container.scrollTop
          ? current
          : { ...current, top: container.scrollTop }
      );
    });
  }, []);

  useEffect(
    () => () => {
      if (gridScrollFrameRef.current !== null) {
        cancelAnimationFrame(gridScrollFrameRef.current);
      }
    },
    []
  );

  const isLargeGrid = entries.length > 300;
  const contentWidth = Math.max(0, gridViewport.width - 40);
  const columnCount = isLargeGrid
    ? Math.max(1, Math.floor((contentWidth + 12) / (cellWidth + 12)))
    : 1;
  const itemHeight = iconSize + 53;
  const rowPitch = itemHeight + 20;
  const rowCount = Math.ceil(entries.length / columnCount);
  const firstVisibleRow = isLargeGrid
    ? Math.max(0, Math.floor((gridViewport.top - 20) / rowPitch) - 3)
    : 0;
  const lastVisibleRow = isLargeGrid
    ? Math.min(
        rowCount,
        Math.ceil((gridViewport.top + gridViewport.height - 20) / rowPitch) + 4
      )
    : rowCount;
  const firstVisibleIndex = firstVisibleRow * columnCount;
  const lastVisibleIndex = Math.min(entries.length, lastVisibleRow * columnCount);
  const renderedEntries = isLargeGrid
    ? entries.slice(firstVisibleIndex, lastVisibleIndex)
    : entries;

  return (
    <div
      ref={containerRef}
      onScroll={handleGridScroll}
      data-tab-scroll-view="icons"
      onMouseDown={handleContainerMouseDown}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => onContextMenu(e, undefined)}
      className="macos-layer-isolate relative flex-1 overflow-y-auto p-5 select-none"
    >
      {entries.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center opacity-40 text-sm pointer-events-none">
          This folder is empty
        </div>
      ) : (
        <div
          className="grid gap-y-5 gap-x-3 justify-items-center"
          style={{
            gridTemplateColumns: isLargeGrid
              ? `repeat(${columnCount}, minmax(${cellWidth}px, 1fr))`
              : `repeat(auto-fill, minmax(${cellWidth}px, 1fr))`,
            ...(isLargeGrid ? { gridAutoRows: `${itemHeight}px` } : {}),
          }}
        >
          {renderedEntries.map((entry, visibleIndex) => {
            const index = firstVisibleIndex + visibleIndex;
            return (
              <IconViewItem
                key={entry.path}
                entry={entry}
                isSelected={selectedSet.has(entry.path)}
                isRenaming={renamingPath === entry.path}
                isDropTarget={entry.isDir && dropTargetPath === entry.path}
                isBeingDragged={draggedSet.has(entry.path)}
                darkMode={darkMode}
                iconSize={iconSize}
                renameValue={renameValue}
                virtualStyle={
                  isLargeGrid
                    ? {
                        gridColumn: (index % columnCount) + 1,
                        gridRow: Math.floor(index / columnCount) + 1,
                      }
                    : undefined
                }
                onOpenEntry={onOpenEntry}
                onContextMenu={onContextMenu}
                onStartItemDrag={handleStartDragBound}
                onRenameChange={onRenameChange}
                onStartRename={onStartRename}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
              />
            );
          })}
        </div>
      )}

      {/* macOS Finder Rubber-Band Marquee Selection Box */}
      {marqueeRect && (
        <div
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
          className="absolute z-30 pointer-events-none border border-[#0a84ff] bg-[#0a84ff]/20 rounded-[2px]"
        />
      )}
    </div>
  );
};

/* ============================================================================
 * 2. LIST VIEW (macOS Finder Table with Expandable Folders)
 * ========================================================================== */
let lastDisclosureArrowTime = 0;

function sortEntriesList(
  items: FileEntry[],
  sortField: SortField,
  sortDirection: SortDirection
): FileEntry[] {
  if (sortField === "name" && sortDirection === "asc") {
    return items;
  }
  const copy = [...items];
  copy.sort((a, b) => {
    if (sortField === "name" && a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    let cmp = 0;
    if (sortField === "name") {
      cmp = FAST_COLLATOR.compare(a.name, b.name);
    } else if (sortField === "modified") {
      cmp = a.modified - b.modified;
    } else if (sortField === "size") {
      cmp = a.size - b.size;
    } else if (sortField === "kind") {
      cmp = FAST_COLLATOR.compare(a.kind, b.kind);
    }
    return sortDirection === "asc" ? cmp : -cmp;
  });
  return copy;
}

interface ListViewRowProps {
  entry: FileEntry;
  depth: number;
  rowIndex: number;
  rowHeight: number;
  rowIconSize: number;
  fontSize: number;
  isSelected: boolean;
  isRenaming: boolean;
  isExpanded: boolean;
  isDropTarget: boolean;
  isBeingDragged: boolean;
  darkMode: boolean;
  renameValue: string;
  onOpenEntry: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onStartRowDrag: (e: React.MouseEvent, entry: FileEntry) => void;
  onToggleExpandDir: (entry: FileEntry) => void;
  onPrefetchDir: (dirPath: string) => void;
  onRenameChange: (val: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
}

const ListViewRow = React.memo<ListViewRowProps>(
  ({
    entry,
    depth,
    rowIndex,
    rowHeight,
    rowIconSize,
    fontSize,
    isSelected,
    isRenaming,
    isExpanded,
    isDropTarget,
    isBeingDragged,
    darkMode,
    renameValue,
    onOpenEntry,
    onContextMenu,
    onStartRowDrag,
    onToggleExpandDir,
    onPrefetchDir,
    onRenameChange,
    onRenameSubmit,
    onRenameCancel,
  }) => {
    const metaFontSize = Math.max(10.5, fontSize - 1);
    return (
      <div
        data-entry-path={entry.path}
        data-drop-path={entry.isDir ? entry.path : undefined}
        data-drop-name={entry.isDir ? entry.name : undefined}
        style={{
          height: rowHeight,
          fontSize: `${fontSize}px`,
        }}
        onMouseEnter={() => {
          if (entry.isDir) {
            onPrefetchDir(entry.path);
          }
        }}
        onMouseDown={(e) => {
          const target = e.target as Element | null;
          if (target?.closest("[data-disclosure-arrow]")) {
            return;
          }
          if (isSelected && !e.ctrlKey && !e.shiftKey) {
            onStartRowDrag(e, entry);
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          const target = e.target as Element | null;
          if (
            target?.closest("[data-disclosure-arrow]") ||
            performance.now() - lastDisclosureArrowTime < 450
          ) {
            return;
          }
          onOpenEntry(entry);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          onContextMenu(e, entry);
        }}
        className={`list-view-row w-full flex items-center cursor-default select-none ${
          entry.isHidden ? "opacity-55" : ""
        } ${isBeingDragged ? "opacity-45" : ""} ${
          isDropTarget
            ? "bg-[#0a84ff]/35 text-white ring-2 ring-inset ring-[#0a84ff]"
            : isSelected
            ? darkMode
              ? "bg-white/15 text-white/90"
              : "bg-black/10 text-zinc-900"
            : rowIndex % 2 === 1
            ? darkMode
              ? "bg-white/[0.025] hover:bg-white/[0.05]"
              : "bg-black/[0.025] hover:bg-black/[0.05]"
            : darkMode
            ? "hover:bg-white/[0.04]"
            : "hover:bg-black/[0.04]"
        }`}
      >
        {/* Name Column */}
        <div
          className="flex-1 min-w-0 pr-2 flex items-center gap-1.5 h-full"
          style={{ paddingLeft: `${depth * 18 + 12}px` }}
        >
          {entry.isDir ? (
            <button
              type="button"
              data-disclosure-arrow="true"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                lastDisclosureArrowTime = performance.now();
                if (e.button === 0) {
                  onToggleExpandDir(entry);
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                lastDisclosureArrowTime = performance.now();
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                lastDisclosureArrowTime = performance.now();
              }}
              className="w-4 h-4 shrink-0 flex items-center justify-center rounded hover:bg-white/10 opacity-70 hover:opacity-100 cursor-pointer select-none"
            >
              <span
                className={`disclosure-arrow ${isExpanded ? "is-open" : ""}`}
              >
                <ChevronRight className="w-3.5 h-3.5 pointer-events-none" />
              </span>
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}

          <div
            data-drag-handle="true"
            onMouseDown={(e) => onStartRowDrag(e, entry)}
            className="inline-flex items-center gap-1.5 min-w-0 truncate"
          >
            <FileIcon entry={entry} size={rowIconSize} />
            {isRenaming ? (
              <input
                data-rename-input
                autoFocus
                onFocus={(e) => e.target.select()}
                value={renameValue}
                onChange={(e) => onRenameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRenameSubmit();
                  if (e.key === "Escape") onRenameCancel();
                }}
                onBlur={onRenameSubmit}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                style={{ fontSize: "inherit", lineHeight: "inherit", color: "inherit" }}
                className="min-w-0 bg-transparent border-0 outline-none shadow-none focus:ring-0 p-0"
              />
            ) : (
              <span className="truncate max-w-[340px] font-medium">
                {entry.name}
              </span>
            )}
            <TagDots tags={entry.tags} />
          </div>
        </div>

        {/* Date Modified Column */}
        <div
          style={{ fontSize: `${metaFontSize}px` }}
          className={`w-48 shrink-0 px-3 whitespace-nowrap ${
            isSelected || isDropTarget ? "text-white/90" : "opacity-60"
          }`}
        >
          {formatMacDate(entry.modified)}
        </div>

        {/* Size Column */}
        <div
          style={{ fontSize: `${metaFontSize}px` }}
          className={`w-28 shrink-0 px-3 whitespace-nowrap text-right ${
            isSelected || isDropTarget ? "text-white/90" : "opacity-60"
          }`}
        >
          {entry.isDir ? "--" : formatBytes(entry.size)}
        </div>

        {/* Kind Column */}
        <div
          style={{ fontSize: `${metaFontSize}px` }}
          className={`w-44 shrink-0 px-3 whitespace-nowrap ${
            isSelected || isDropTarget ? "text-white/90" : "opacity-60"
          }`}
        >
          {entry.kind}
        </div>
      </div>
    );
  }
);

export const ListView: React.FC<CommonViewProps> = ({
  entries,
  selectedPaths,
  onSelect,
  onSetSelection,
  onClearSelection,
  onOpenEntry,
  onContextMenu,
  onStartItemDrag,
  dropTargetPath,
  draggedPaths,
  refreshVersion,
  renamingPath,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  iconSize,
  darkMode,
  sortField,
  sortDirection,
  onChangeSort,
  showHidden,
}) => {
  const zoomScale = iconSize / 64;
  const rowIconSize = Math.max(14, Math.min(36, Math.round(18 * zoomScale)));
  const rowHeight = Math.max(24, rowIconSize + 10);
  const fontSize = Math.max(
    11,
    Math.min(16, Math.round(12.5 * (0.75 + 0.25 * zoomScale) * 2) / 2)
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [dirCache, setDirCache] = useState<Record<string, FileEntry[]>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const scrollFrameRef = useRef<number | null>(null);

  const currentFolderKey = entries[0]?.path
    ? entries[0].path.slice(0, Math.max(1, entries[0].path.lastIndexOf("/")))
    : "";
  const prevFolderKeyRef = useRef(currentFolderKey);
  useEffect(() => {
    if (prevFolderKeyRef.current !== currentFolderKey) {
      prevFolderKeyRef.current = currentFolderKey;
      setExpandedPaths(new Set());
    }
  }, [currentFolderKey]);

  const expandedPathsRef = useRef<Set<string>>(expandedPaths);
  expandedPathsRef.current = expandedPaths;

  const dirCacheRef = useRef<Record<string, FileEntry[]>>(dirCache);
  dirCacheRef.current = dirCache;

  // Non-rendering prefetch cache: hovering/prefetching never triggers a React re-render!
  const prefetchedMapRef = useRef<Map<string, FileEntry[]>>(new Map());
  const inflightDirsRef = useRef<Set<string>>(new Set());

  const prefetchDir = useCallback(
    (dirPath: string) => {
      if (
        dirCacheRef.current[dirPath] !== undefined ||
        prefetchedMapRef.current.has(dirPath) ||
        inflightDirsRef.current.has(dirPath)
      ) {
        return;
      }
      inflightDirsRef.current.add(dirPath);
      apiReadDirectory(dirPath, showHidden)
        .then((children) => {
          prefetchedMapRef.current.set(dirPath, children);
        })
        .catch(() => {
          prefetchedMapRef.current.set(dirPath, []);
        })
        .finally(() => {
          inflightDirsRef.current.delete(dirPath);
        });
    },
    [showHidden]
  );

  // Silently pre-fetch top-level folders into prefetchedMapRef after mount paint (zero React re-renders)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const dirs = entries.filter((e) => e.isDir).slice(0, 20);
      for (const d of dirs) {
        prefetchDir(d.path);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [entries, prefetchDir]);

  // Refresh currently open directories ONLY when files are modified or showHidden changes
  useEffect(() => {
    inflightDirsRef.current.clear();
    prefetchedMapRef.current.clear();
    const dirPaths = Array.from(expandedPathsRef.current);
    if (dirPaths.length === 0) return;
    let cancelled = false;
    Promise.all(
      dirPaths.map(async (p) => {
        try {
          const children = await apiReadDirectory(p, showHidden);
          return [p, children] as const;
        } catch {
          return null;
        }
      })
    ).then((results) => {
      if (cancelled) return;
      setDirCache((prev) => {
        const next = { ...prev };
        results.forEach((item) => {
          if (item) {
            next[item[0]] = item[1];
            prefetchedMapRef.current.set(item[0], item[1]);
          }
        });
        dirCacheRef.current = next;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [refreshVersion, showHidden]);

  // Pre-sorted cache ONLY for folders that have been opened
  const sortedDirCache = useMemo(() => {
    const result: Record<string, FileEntry[]> = {};
    for (const [dirPath, items] of Object.entries(dirCache)) {
      result[dirPath] = sortEntriesList(items, sortField, sortDirection);
    }
    return result;
  }, [dirCache, sortField, sortDirection]);

  // Keep selection order flat for range selection. Build the richer virtual row
  // model only when the list is large enough to need virtualization.
  const visibleEntries = useMemo(() => {
    const list: FileEntry[] = [];
    const visit = (items: FileEntry[]) => {
      for (const item of items) {
        list.push(item);
        if (expandedPaths.has(item.path) && sortedDirCache[item.path]) {
          visit(sortedDirCache[item.path]);
        }
      }
    };
    visit(entries);
    return list;
  }, [entries, expandedPaths, sortedDirCache]);
  const renderedRowCount = useMemo(() => {
    let count = 0;
    const visit = (items: FileEntry[]) => {
      for (const item of items) {
        count++;
        const cachedChildren = sortedDirCache[item.path];
        // The animated tree keeps cached children mounted while a folder is
        // collapsed, so count them when deciding whether to virtualize.
        if (item.isDir && cachedChildren) visit(cachedChildren);
      }
    };
    visit(entries);
    return count;
  }, [entries, sortedDirCache]);
  const isLargeList = renderedRowCount > LIST_VIRTUALIZATION_THRESHOLD;

  const virtualRows = useMemo(() => {
    if (!isLargeList) return [];
    const list: {
      entry: FileEntry | null;
      depth: number;
      rowIndex: number;
      placeholder?: string;
    }[] = [];
    const visit = (items: FileEntry[], depth: number) => {
      for (const item of items) {
        list.push({ entry: item, depth, rowIndex: list.length });
        if (expandedPaths.has(item.path)) {
          const children = sortedDirCache[item.path];
          if (children === undefined || children.length === 0) {
            list.push({
              entry: null,
              depth: depth + 1,
              rowIndex: list.length,
              placeholder: children === undefined ? "Loading..." : "Zero items",
            });
          } else {
            visit(children, depth + 1);
          }
        }
      }
    };
    visit(entries, 0);
    return list;
  }, [entries, expandedPaths, isLargeList, sortedDirCache]);

  useEffect(() => {
    if (!isLargeList) return;
    const container = containerRef.current;
    if (!container) return;
    const updateHeight = () => {
      setViewportHeight(container.clientHeight);
      setScrollTop(container.scrollTop);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, [isLargeList]);

  const handleListScroll = useCallback(() => {
    if (!isLargeList) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(containerRef.current?.scrollTop || 0);
    });
  }, [isLargeList]);

  const handleListWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!isLargeList || event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      const container = containerRef.current;
      if (!container) return;

      const deltaScale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? rowHeight
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? container.clientHeight
          : 1;
      const rawDelta = event.deltaY * deltaScale;
      const limitedDelta = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta) * 0.65, 42);

      event.preventDefault();
      container.scrollTop += limitedDelta;
    },
    [isLargeList, rowHeight]
  );

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    []
  );

  const headerHeight = 28;
  const overscan = 12;
  const firstVisibleRow = Math.max(
    0,
    Math.floor((scrollTop - headerHeight) / rowHeight) - overscan
  );
  const lastVisibleRow = Math.min(
    virtualRows.length,
    Math.ceil((scrollTop + viewportHeight - headerHeight) / rowHeight) + overscan
  );
  const renderedRows = isLargeList
    ? virtualRows.slice(firstVisibleRow, lastVisibleRow)
    : [];

  const visibleEntriesRef = useRef<FileEntry[]>(visibleEntries);
  visibleEntriesRef.current = visibleEntries;

  const handleClickEntryByPath = useCallback(
    (path: string, modifiers: SelectionModifiers) => {
      const list = visibleEntriesRef.current;
      const found = list.find((e) => e.path === path);
      if (found) {
        onSelect(found, modifiers, list);
      }
    },
    [onSelect]
  );

  const handleStartRowDrag = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => {
      onStartItemDrag(e, entry, visibleEntriesRef.current);
    },
    [onStartItemDrag]
  );

  const { marqueeRect, handleContainerMouseDown } = useMarqueeSelection({
    containerRef,
    selectedPaths,
    onSetSelection,
    onClearSelection,
    onClickEntryFallback: handleClickEntryByPath,
  });

  const toggleExpandDir = useCallback(
    (dirEntry: FileEntry) => {
      const p = dirEntry.path;
      markFolderAnimationActive(220);

      // If already expanded, collapse it immediately
      if (expandedPathsRef.current.has(p)) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.delete(p);
          expandedPathsRef.current = next;
          return next;
        });
        return;
      }

      // Check if prefetched items exist and put them into dirCache immediately
      const prefetched = prefetchedMapRef.current.get(p);
      if (prefetched !== undefined && dirCacheRef.current[p] === undefined) {
        setDirCache((prev) => {
          const next = { ...prev, [p]: prefetched };
          dirCacheRef.current = next;
          return next;
        });
      }

      // Rotate arrow immediately
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.add(p);
        expandedPathsRef.current = next;
        return next;
      });

      // If not yet in cache or prefetched, fetch from backend in background
      if (dirCacheRef.current[p] === undefined && prefetched === undefined) {
        apiReadDirectory(p, showHidden)
          .then((fetched) => {
            prefetchedMapRef.current.set(p, fetched);
            setDirCache((prev) => {
              const next = { ...prev, [p]: fetched };
              dirCacheRef.current = next;
              return next;
            });
          })
          .catch(() => {
            setDirCache((prev) => {
              const next = { ...prev, [p]: [] };
              dirCacheRef.current = next;
              return next;
            });
          });
      }
    },
    [showHidden]
  );

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const draggedSet = useMemo(() => new Set(draggedPaths), [draggedPaths]);

  const renderAnimatedRow = (
    entry: FileEntry,
    depth = 0,
    rowIndex = 0
  ): React.ReactNode => {
    const isExpanded = expandedPaths.has(entry.path);
    const children = sortedDirCache[entry.path];
    return (
      <div key={entry.path} className="w-full flex flex-col">
        <ListViewRow
          entry={entry}
          depth={depth}
          rowIndex={rowIndex}
          rowHeight={rowHeight}
          rowIconSize={rowIconSize}
          fontSize={fontSize}
          isSelected={selectedSet.has(entry.path)}
          isRenaming={renamingPath === entry.path}
          isExpanded={isExpanded}
          isDropTarget={entry.isDir && dropTargetPath === entry.path}
          isBeingDragged={draggedSet.has(entry.path)}
          darkMode={darkMode}
          renameValue={renameValue}
          onOpenEntry={onOpenEntry}
          onContextMenu={onContextMenu}
          onStartRowDrag={handleStartRowDrag}
          onToggleExpandDir={toggleExpandDir}
          onPrefetchDir={prefetchDir}
          onRenameChange={onRenameChange}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
        />
        {entry.isDir && (
          <div className={`folder-unfold-grid ${isExpanded ? "is-expanded" : ""}`}>
            <div className="folder-unfold-inner">
              {children === undefined ? (
                <div
                  className="flex items-center text-xs opacity-40 italic select-none"
                  style={{ height: rowHeight, paddingLeft: `${(depth + 1) * 18 + 34}px` }}
                >
                  Loading...
                </div>
              ) : children.length === 0 ? (
                <div
                  className="flex items-center text-xs opacity-40 italic select-none"
                  style={{ height: rowHeight, paddingLeft: `${(depth + 1) * 18 + 34}px` }}
                >
                  Zero items
                </div>
              ) : (
                children.map((child, idx) => renderAnimatedRow(child, depth + 1, idx))
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderSortArrow = (field: SortField) => {
    if (sortField !== field) return null;
    return (
      <span className="ml-1 text-[10px]">
        {sortDirection === "asc" ? "▲" : "▼"}
      </span>
    );
  };

  return (
    <div
      ref={containerRef}
      data-tab-scroll-view="list"
      onScroll={handleListScroll}
      onWheel={handleListWheel}
      onMouseDown={handleContainerMouseDown}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => onContextMenu(e, undefined)}
      className="list-view-container macos-layer-isolate relative flex-1 overflow-auto select-none min-w-0"
    >
      <div className="w-full min-w-[640px] flex flex-col">
        {/* Sticky Table Header */}
        <div
          className={`sticky top-0 z-10 flex items-center h-7 text-[11px] font-semibold border-b select-none ${
            darkMode
              ? "bg-[#202024] border-white/10 text-zinc-400"
              : "bg-[#f2f2f5] border-black/10 text-zinc-500"
          }`}
        >
          <div
            onClick={() => onChangeSort("name")}
            className="flex-1 min-w-0 pl-8 pr-3 cursor-pointer hover:opacity-100 flex items-center"
          >
            Name {renderSortArrow("name")}
          </div>
          <div
            onClick={() => onChangeSort("modified")}
            className="w-48 shrink-0 px-3 cursor-pointer hover:opacity-100 flex items-center"
          >
            Date Modified {renderSortArrow("modified")}
          </div>
          <div
            onClick={() => onChangeSort("size")}
            className="w-28 shrink-0 px-3 text-right cursor-pointer hover:opacity-100 flex items-center justify-end"
          >
            Size {renderSortArrow("size")}
          </div>
          <div
            onClick={() => onChangeSort("kind")}
            className="w-44 shrink-0 px-3 cursor-pointer hover:opacity-100 flex items-center"
          >
            Kind {renderSortArrow("kind")}
          </div>
        </div>

        {isLargeList ? (
          // Only mount rows around the viewport; the spacer preserves scroll height.
          <div
            className="relative w-full"
            style={{ height: virtualRows.length * rowHeight }}
          >
            {renderedRows.map((row) => {
              const { entry, depth, rowIndex } = row;
              return (
                <div
                  key={entry?.path || `placeholder-${rowIndex}`}
                  className="absolute inset-x-0"
                  style={{ top: rowIndex * rowHeight, height: rowHeight }}
                >
                  {entry ? (
                    <ListViewRow
                      entry={entry}
                      depth={depth}
                      rowIndex={rowIndex}
                      rowHeight={rowHeight}
                      rowIconSize={rowIconSize}
                      fontSize={fontSize}
                      isSelected={selectedSet.has(entry.path)}
                      isRenaming={renamingPath === entry.path}
                      isExpanded={expandedPaths.has(entry.path)}
                      isDropTarget={entry.isDir && dropTargetPath === entry.path}
                      isBeingDragged={draggedSet.has(entry.path)}
                      darkMode={darkMode}
                      renameValue={renameValue}
                      onOpenEntry={onOpenEntry}
                      onContextMenu={onContextMenu}
                      onStartRowDrag={handleStartRowDrag}
                      onToggleExpandDir={toggleExpandDir}
                      onPrefetchDir={prefetchDir}
                      onRenameChange={onRenameChange}
                      onRenameSubmit={onRenameSubmit}
                      onRenameCancel={onRenameCancel}
                    />
                  ) : (
                    <div
                      className="flex items-center text-xs opacity-40 italic select-none"
                      style={{
                        height: rowHeight,
                        paddingLeft: `${depth * 18 + 34}px`,
                      }}
                    >
                      {row.placeholder}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="w-full flex flex-col">
            {entries.map((item, idx) => renderAnimatedRow(item, 0, idx))}
          </div>
        )}
      </div>

      {entries.length === 0 && (
        <div className="py-20 text-center opacity-40 text-sm pointer-events-none">
          This folder is empty
        </div>
      )}

      {/* macOS Finder Rubber-Band Marquee Selection Box */}
      {marqueeRect && (
        <div
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
          className="absolute z-30 pointer-events-none border border-[#0a84ff] bg-[#0a84ff]/20 rounded-[2px]"
        />
      )}
    </div>
  );
};

/* ============================================================================
 * 3. MILLER COLUMNS VIEW (Signature macOS Cascading Columns + Inspector)
 * ========================================================================== */
interface ColumnPane {
  path: string;
  entries: FileEntry[];
  selectedEntry: FileEntry | null;
}

const ColumnPaneRow: React.FC<{
  entry: FileEntry;
  colIdx: number;
  colFontSize: number;
  rowPadY: number;
  colIconSize: number;
  isSelected: boolean;
  isRenaming: boolean;
  isDropTarget: boolean;
  isBeingDragged: boolean;
  darkMode: boolean;
  renameValue?: string;
  onRenameChange?: (val: string) => void;
  onRenameSubmit?: () => void;
  onRenameCancel?: () => void;
  onActivateEntry: (
    colIdx: number,
    entry: FileEntry,
    modifiers: SelectionModifiers
  ) => void;
  onOpenEntry: (entry: FileEntry) => void;
  onContextMenu: (
    e: React.MouseEvent,
    entry?: FileEntry,
    targetDir?: string
  ) => void;
  onStartItemDrag: (
    e: React.MouseEvent,
    entry: FileEntry,
    orderedEntries?: FileEntry[],
    onClickOverride?: (entry: FileEntry, modifiers: SelectionModifiers) => void
  ) => void;
  colEntries: FileEntry[];
  colPath: string;
}> = ({
  entry,
  colIdx,
  colFontSize,
  rowPadY,
  colIconSize,
  isSelected,
  isRenaming,
  isDropTarget,
  isBeingDragged,
  darkMode,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onActivateEntry,
  onOpenEntry,
  onContextMenu,
  onStartItemDrag,
  colEntries,
  colPath,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isRenaming && rowRef.current) {
      rowRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [isRenaming]);

  return (
    <div
      ref={rowRef}
      key={entry.path}
      data-entry-path={entry.path}
      data-drop-path={entry.isDir ? entry.path : undefined}
      data-drop-name={entry.isDir ? entry.name : undefined}
      style={{
        fontSize: `${colFontSize}px`,
        paddingTop: rowPadY,
        paddingBottom: rowPadY,
      }}
      onMouseDown={(e) => {
        if (!isRenaming && isSelected && !e.ctrlKey && !e.shiftKey) {
          onStartItemDrag(
            e,
            entry,
            colEntries,
            (clicked, mods) => onActivateEntry(colIdx, clicked, mods)
          );
        }
      }}
      onDoubleClick={() => {
        if (!isRenaming) onOpenEntry(entry);
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
        onContextMenu(e, entry, colPath);
      }}
      className={`flex items-center justify-between px-2.5 mx-1 rounded-md cursor-default ${
        entry.isHidden ? "opacity-55" : ""
      } ${isBeingDragged ? "opacity-45" : ""} ${
        isDropTarget
          ? "bg-[#0a84ff]/35 text-white ring-2 ring-[#0a84ff]"
          : isSelected
          ? darkMode
            ? "bg-white/15 text-white/90"
            : "bg-black/10 text-zinc-900"
          : darkMode
          ? "hover:bg-white/[0.06]"
          : "hover:bg-black/[0.05]"
      }`}
    >
      <div
        data-drag-handle={!isRenaming ? "true" : undefined}
        onMouseDown={(e) => {
          if (!isRenaming) {
            onStartItemDrag(
              e,
              entry,
              colEntries,
              (clicked, mods) => onActivateEntry(colIdx, clicked, mods)
            );
          }
        }}
        className="flex items-center gap-2 min-w-0 flex-1 mr-1"
      >
        <FileIcon entry={entry} size={colIconSize} />
        {isRenaming ? (
          <input
            data-rename-input
            autoFocus
            value={renameValue || ""}
            onChange={(e) => onRenameChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameSubmit?.();
              if (e.key === "Escape") onRenameCancel?.();
            }}
            onFocus={(e) => e.target.select()}
            onBlur={onRenameSubmit}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{ fontSize: "inherit", lineHeight: "inherit", color: "inherit" }}
            className="w-full min-w-0 bg-transparent border-0 outline-none shadow-none focus:ring-0 p-0 font-medium"
          />
        ) : (
          <span className="truncate">{entry.name}</span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <TagDots tags={entry.tags} />
        {entry.isDir && (
          <ChevronRight
            className={`w-3.5 h-3.5 ${
              isSelected || isDropTarget ? "text-white" : "opacity-40"
            }`}
          />
        )}
      </div>
    </div>
  );
};

const ColumnPaneView: React.FC<{
  col: ColumnPane;
  colIdx: number;
  rootPartitionName?: string;
  iconSize: number;
  selectedPaths: string[];
  dropTargetPath: string | null;
  draggedPaths: string[];
  darkMode: boolean;
  renamingPath?: string | null;
  renameValue?: string;
  onRenameChange?: (val: string) => void;
  onRenameSubmit?: () => void;
  onRenameCancel?: () => void;
  onFocusColumn?: (colIdx: number) => void;
  onActivateEntry: (
    colIdx: number,
    entry: FileEntry,
    modifiers: SelectionModifiers
  ) => void;
  onSetSelection: (paths: string[]) => void;
  onClearSelection: () => void;
  onOpenEntry: (entry: FileEntry) => void;
  onContextMenu: (
    e: React.MouseEvent,
    entry?: FileEntry,
    targetDir?: string
  ) => void;
  onStartItemDrag: (
    e: React.MouseEvent,
    entry: FileEntry,
    orderedEntries?: FileEntry[],
    onClickOverride?: (entry: FileEntry, modifiers: SelectionModifiers) => void
  ) => void;
}> = ({
  col,
  colIdx,
  rootPartitionName,
  iconSize,
  selectedPaths,
  dropTargetPath,
  draggedPaths,
  darkMode,
  renamingPath,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onFocusColumn,
  onActivateEntry,
  onSetSelection,
  onClearSelection,
  onOpenEntry,
  onContextMenu,
  onStartItemDrag,
}) => {
  const paneRef = useRef<HTMLDivElement>(null);

  const zoomScale = iconSize / 64;
  const colIconSize = Math.max(14, Math.min(32, Math.round(18 * zoomScale)));
  const colFontSize = Math.max(
    11,
    Math.min(16, Math.round(12.5 * (0.75 + 0.25 * zoomScale) * 2) / 2)
  );
  const colWidth = Math.max(
    210,
    Math.min(360, Math.round(256 * (0.8 + 0.2 * zoomScale)))
  );
  const rowPadY = Math.max(4, Math.min(10, Math.round(6 * zoomScale)));

  const handleClickEntryByPath = useCallback(
    (path: string, modifiers: SelectionModifiers) => {
      const found = col.entries.find((e) => e.path === path);
      if (found) {
        onActivateEntry(colIdx, found, modifiers);
      }
    },
    [col.entries, colIdx, onActivateEntry]
  );

  const { marqueeRect, handleContainerMouseDown } = useMarqueeSelection({
    containerRef: paneRef,
    selectedPaths,
    onSetSelection,
    onClearSelection,
    onClickEntryFallback: handleClickEntryByPath,
  });

  const colFolderName =
    col.path === "/"
      ? rootPartitionName || "Linux"
      : col.path.split("/").filter(Boolean).pop() || col.path;
  const isColumnDropTarget =
    col.path !== "__RECENTS__" && dropTargetPath === col.path;

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const draggedSet = useMemo(() => new Set(draggedPaths), [draggedPaths]);

  // Ensure an item being created/renamed appears immediately in its column even before directory refresh
  const displayEntries = useMemo(() => {
    if (
      renamingPath &&
      renamingPath.startsWith(col.path === "/" ? "/" : col.path + "/")
    ) {
      const remainder =
        col.path === "/"
          ? renamingPath.slice(1)
          : renamingPath.slice(col.path.length + 1);
      if (!remainder.includes("/") && !col.entries.some((e) => e.path === renamingPath)) {
        const tempEntry: FileEntry = {
          name: renameValue || remainder,
          path: renamingPath,
          isDir: !remainder.includes(".") || remainder.endsWith("/"),
          isSymlink: false,
          isHidden: remainder.startsWith("."),
          size: 0,
          modified: Date.now() / 1000,
          created: Date.now() / 1000,
          extension: remainder.includes(".") ? remainder.split(".").pop() || "" : "",
          kind: "Folder",
          mimeType: "inode/directory",
          permissions: "rwxr-xr-x",
          isReadonly: false,
          childCount: 0,
          tags: [],
        };
        return [tempEntry, ...col.entries];
      }
    }
    return col.entries;
  }, [col.entries, col.path, renamingPath, renameValue]);

  return (
    <div
      ref={paneRef}
      style={{ width: colWidth }}
      data-drop-path={col.path !== "__RECENTS__" ? col.path : undefined}
      data-drop-name={colFolderName}
      onMouseDown={(e) => {
        onFocusColumn?.(colIdx);
        handleContainerMouseDown(e);
      }}
      onContextMenu={(e) => onContextMenu(e, undefined, col.path)}
      className={`relative shrink-0 border-r overflow-y-auto py-1 select-none transition-colors ${
        darkMode ? "border-white/10" : "border-black/10"
      } ${
        isColumnDropTarget
          ? "bg-[#0a84ff]/15 ring-2 ring-inset ring-[#0a84ff]"
          : ""
      }`}
    >
      {displayEntries.length === 0 ? (
        <div className="h-full flex items-center justify-center text-xs opacity-40 pointer-events-none">
          Empty Folder
        </div>
      ) : (
        displayEntries.map((entry) => (
          <ColumnPaneRow
            key={entry.path}
            entry={entry}
            colIdx={colIdx}
            colFontSize={colFontSize}
            rowPadY={rowPadY}
            colIconSize={colIconSize}
            isSelected={
              selectedSet.has(entry.path) ||
              col.selectedEntry?.path === entry.path
            }
            isRenaming={renamingPath === entry.path}
            isDropTarget={entry.isDir && dropTargetPath === entry.path}
            isBeingDragged={draggedSet.has(entry.path)}
            darkMode={darkMode}
            renameValue={renameValue}
            onRenameChange={onRenameChange}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
            onActivateEntry={onActivateEntry}
            onOpenEntry={onOpenEntry}
            onContextMenu={onContextMenu}
            onStartItemDrag={onStartItemDrag}
            colEntries={col.entries}
            colPath={col.path}
          />
        ))
      )}

      {marqueeRect && (
        <div
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
          className="absolute z-30 pointer-events-none border border-[#0a84ff] bg-[#0a84ff]/20 rounded-[2px]"
        />
      )}
    </div>
  );
};

export const ColumnView: React.FC<
  CommonViewProps & {
    currentPath: string;
    rootPartitionName?: string;
    onActiveDirectoryChange?: (path: string) => void;
  }
> = ({
  currentPath,
  rootPartitionName,
  entries,
  selectedPaths,
  onSelect,
  onSetSelection,
  onClearSelection,
  onOpenEntry,
  onContextMenu,
  onStartItemDrag,
  dropTargetPath,
  draggedPaths,
  refreshVersion,
  renamingPath,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  iconSize,
  darkMode,
  showHidden,
  onToggleTag,
  onQuickLook,
  onActiveDirectoryChange,
}) => {
  const [columns, setColumns] = useState<ColumnPane[]>(() => [
    {
      path: currentPath,
      entries,
      selectedEntry: null,
    },
  ]);
  const columnsRef = useRef<ColumnPane[]>(columns);
  columnsRef.current = columns;

  const [activeColIndex, setActiveColIndex] = useState<number>(0);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<{ path: string; url: string } | null>(null);
  const zoomScale = iconSize / 64;
  const inspectorIconSize = Math.max(
    56,
    Math.min(140, Math.round(84 * zoomScale))
  );
  const inspectorImgMaxH = Math.max(
    120,
    Math.min(280, Math.round(176 * zoomScale))
  );

  // Compute active directory in the columns cascade and notify parent
  const activeColPath = useMemo(() => {
    if (columns.length === 0) return currentPath;
    const col = columns[activeColIndex] || columns[columns.length - 1];
    return col ? col.path : currentPath;
  }, [columns, activeColIndex, currentPath]);

  useEffect(() => {
    onActiveDirectoryChange?.(activeColPath);
  }, [activeColPath, onActiveDirectoryChange]);

  // Reset root column when currentPath changes, or update root entries
  useEffect(() => {
    setColumns((prev) => {
      if (prev.length === 0 || prev[0].path !== currentPath) {
        setActiveColIndex(0);
        return [
          {
            path: currentPath,
            entries,
            selectedEntry: null,
          },
        ];
      }
      const next = [...prev];
      next[0] = { ...next[0], entries };
      return next;
    });
  }, [currentPath, entries]);

  // Refresh sub-columns when files are moved/copied/created/renamed
  useEffect(() => {
    if (columnsRef.current.length <= 1) return;
    let cancelled = false;
    Promise.all(
      columnsRef.current.slice(1).map(async (col) => {
        try {
          const sub = await apiReadDirectory(col.path, showHidden);
          return { path: col.path, entries: sub };
        } catch {
          return null;
        }
      })
    ).then((res) => {
      if (cancelled) return;
      const refreshedByPath = new Map(
        res
          .filter((item): item is { path: string; entries: FileEntry[] } =>
            item !== null
          )
          .map((item) => [item.path, item.entries])
      );
      setColumns((prev) =>
        prev.map((col) => {
          const refreshedEntries = refreshedByPath.get(col.path);
          return refreshedEntries ? { ...col, entries: refreshedEntries } : col;
        })
      );
    });
    return () => {
      cancelled = true;
    };
  }, [refreshVersion, showHidden]);

  const handleFocusColumn = useCallback(
    (colIdx: number) => {
      setActiveColIndex(colIdx);
      onClearSelection();
      setColumns((prev) => {
        if (colIdx >= prev.length - 1) return prev;
        return prev.slice(0, colIdx + 1).map((c, i) =>
          i === colIdx ? { ...c, selectedEntry: null } : c
        );
      });
      setPreview(null);
    },
    [onClearSelection]
  );

  const handleSelectInColumn = useCallback(
    async (
      colIndex: number,
      entry: FileEntry,
      modifiers: SelectionModifiers
    ) => {
      const colEntries = columns[colIndex]?.entries || [];
      onSelect(entry, modifiers, colEntries);

      // If multi-selecting with Ctrl/Cmd or Shift, keep current column cascade
      if (modifiers.ctrlKey || modifiers.shift) {
        return;
      }

      const updated = columns.slice(0, colIndex + 1);
      updated[colIndex] = {
        ...updated[colIndex],
        selectedEntry: entry,
      };

      if (entry.isDir) {
        setPreview(null);
        setActiveColIndex(colIndex + 1);
        try {
          const subEntries = await apiReadDirectory(entry.path, showHidden);
          updated.push({
            path: entry.path,
            entries: subEntries,
            selectedEntry: null,
          });
        } catch {
          // unreadable dir
        }
        setColumns(updated);
      } else {
        setActiveColIndex(colIndex);
        setColumns(updated);
        try {
          const p = await apiReadFilePreview(entry.path, 32768);
          setPreview(p);
        } catch {
          setPreview(null);
        }
      }
    },
    [columns, onSelect, showHidden]
  );

  const activeFile =
    columns[columns.length - 1]?.selectedEntry &&
    !columns[columns.length - 1]?.selectedEntry?.isDir
      ? columns[columns.length - 1].selectedEntry
      : null;

  useEffect(() => {
    if (!activeFile || preview?.previewType !== "pdf") {
      setPdfPreviewUrl(null);
      return;
    }
    let cancelled = false;
    setPdfPreviewUrl(null);
    apiGetFilePreviewUrl(activeFile.path).then((url) => {
      if (!cancelled) setPdfPreviewUrl({ path: activeFile.path, url });
    }).catch(() => {
      if (!cancelled) setPdfPreviewUrl(null);
    });
    return () => { cancelled = true; };
  }, [activeFile?.path, preview?.previewType]);

  return (
    <div
      data-tab-scroll-view="columns"
      onDragStart={(e) => e.preventDefault()}
      className="macos-layer-isolate flex-1 flex overflow-x-auto overflow-y-hidden"
    >
      {columns.map((col, colIdx) => (
        <ColumnPaneView
          key={`${col.path}-${colIdx}`}
          col={col}
          colIdx={colIdx}
          rootPartitionName={rootPartitionName}
          iconSize={iconSize}
          selectedPaths={selectedPaths}
          dropTargetPath={dropTargetPath}
          draggedPaths={draggedPaths}
          darkMode={darkMode}
          renamingPath={renamingPath}
          renameValue={renameValue}
          onRenameChange={onRenameChange}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          onFocusColumn={handleFocusColumn}
          onActivateEntry={handleSelectInColumn}
          onSetSelection={onSetSelection}
          onClearSelection={onClearSelection}
          onOpenEntry={onOpenEntry}
          onContextMenu={onContextMenu}
          onStartItemDrag={onStartItemDrag}
        />
      ))}

      {/* Rightmost Preview & Metadata Inspector Column when a file is selected */}
      {activeFile && (
        <div
          className={`w-80 shrink-0 p-5 overflow-y-auto flex flex-col border-r ${
            darkMode
              ? "border-white/10 bg-white/[0.01]"
              : "border-black/10 bg-black/[0.01]"
          }`}
        >
          <div className="flex flex-col items-center text-center pb-4 border-b border-current/10">
            {preview?.previewType === "image" && preview.dataUrl ? (
              <img
                src={preview.dataUrl}
                alt={activeFile.name}
                style={{ maxHeight: inspectorImgMaxH }}
                className="rounded-lg shadow-md object-contain mb-3 border border-white/10"
              />
            ) : preview?.previewType === "pdf" && pdfPreviewUrl?.path === activeFile.path ? (
              <iframe
                src={pdfPreviewUrl.url}
                title={`PDF preview: ${activeFile.name}`}
                className="mb-3 h-48 w-full rounded-lg bg-white shadow-md"
              />
            ) : preview?.previewType === "text" && preview.textContent ? (
              <pre
                className={`w-full h-40 p-2.5 rounded-lg text-[10px] font-mono text-left overflow-auto mb-3 border ${
                  darkMode
                    ? "bg-black/40 border-white/10 text-zinc-300"
                    : "bg-white border-black/10 text-zinc-700"
                }`}
              >
                {preview.textContent.slice(0, 1200)}
              </pre>
            ) : (
              <FileIcon
                entry={activeFile}
                size={inspectorIconSize}
                className="mb-2"
              />
            )}

            <h3 className="font-semibold text-sm break-all">{activeFile.name}</h3>
            <p className="text-xs opacity-55 mt-0.5">
              {activeFile.kind} — {formatBytes(activeFile.size)}
            </p>

            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={onQuickLook}
                className="px-3 py-1 rounded-md text-xs font-medium bg-[#0a84ff] text-white hover:opacity-90 flex items-center gap-1.5"
              >
                <Eye className="w-3.5 h-3.5" />
                Quick Look
              </button>
              <button
                onClick={() => onOpenEntry(activeFile)}
                className={`px-3 py-1 rounded-md text-xs font-medium border flex items-center gap-1.5 ${
                  darkMode
                    ? "border-white/15 hover:bg-white/10"
                    : "border-black/15 hover:bg-black/5"
                }`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open
              </button>
            </div>
          </div>

          <div className="py-3 text-xs space-y-2 border-b border-current/10">
            <div className="text-[11px] font-semibold opacity-50 uppercase tracking-wider">
              Information
            </div>
            <div className="flex justify-between">
              <span className="opacity-55">Created</span>
              <span>{formatMacDate(activeFile.created)}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-55">Modified</span>
              <span>{formatMacDate(activeFile.modified)}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-55">Permissions</span>
              <span className="font-mono">{activeFile.permissions}</span>
            </div>
          </div>

          <div className="py-3 text-xs">
            <div className="text-[11px] font-semibold opacity-50 uppercase tracking-wider mb-2">
              Tags
            </div>
            <div className="flex items-center gap-2">
              {TAG_COLORS.map((tc) => {
                const hasTag = activeFile.tags.includes(tc.id);
                return (
                  <button
                    key={tc.id}
                    onClick={() => onToggleTag(activeFile.path, tc.id)}
                    title={tc.name}
                    className={`w-4 h-4 rounded-full ${tc.bgClass} transition transform hover:scale-110 ${
                      hasTag
                        ? "ring-2 ring-offset-1 ring-white"
                        : "opacity-60 hover:opacity-100"
                    }`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * 4. GALLERY VIEW (macOS Finder Stage + Filmstrip + Inspector)
 * ========================================================================== */
export const GalleryView: React.FC<CommonViewProps> = ({
  entries,
  selectedPaths,
  onOpenEntry,
  onContextMenu,
  onStartItemDrag,
  dropTargetPath,
  draggedPaths,
  iconSize,
  darkMode,
  onToggleTag,
  onQuickLook,
}) => {
  const zoomScale = iconSize / 64;
  const stageIconSize = Math.max(90, Math.min(240, Math.round(140 * zoomScale)));
  const stageImgScale = Math.max(0.65, Math.min(1.5, 0.75 + 0.25 * zoomScale));
  const thumbIconSize = Math.max(28, Math.min(84, Math.round(40 * zoomScale)));
  const thumbBoxSize = thumbIconSize + 32;
  const stripHeight = thumbBoxSize + 24;

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const draggedSet = useMemo(() => new Set(draggedPaths), [draggedPaths]);

  const activeEntry = useMemo(
    () => entries.find((e) => selectedSet.has(e.path)) || entries[0] || null,
    [entries, selectedSet]
  );
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<{ path: string; url: string } | null>(null);
  const [videoStreamError, setVideoStreamError] = useState<{ path: string; message: string } | null>(null);

  const ext = (activeEntry?.extension || "").toLowerCase();
  const isImage =
    Boolean(activeEntry) &&
    !activeEntry?.isDir &&
    Boolean(activeEntry?.path) &&
    (Boolean(activeEntry?.mimeType?.startsWith("image/")) ||
      ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "jfif"].includes(ext));
  const isVideo =
    Boolean(activeEntry) &&
    !activeEntry?.isDir &&
    (Boolean(activeEntry?.mimeType?.startsWith("video/")) ||
      ["mp4", "m4v", "mkv", "mov", "webm", "avi", "mpeg", "mpg", "3gp"].includes(ext));
  const isPdf = Boolean(activeEntry) && !activeEntry?.isDir &&
    (activeEntry?.mimeType === "application/pdf" || ext === "pdf");
  const needsStreamPreview = isVideo || isPdf;

  const activeImageSrc = useMemo(() => {
    if (!isImage || !activeEntry?.path) return null;
    try {
      return convertFileSrc(activeEntry.path);
    } catch {
      return null;
    }
  }, [isImage, activeEntry?.path]);

  useEffect(() => {
    if (!activeEntry || activeEntry.isDir || isImage) {
      setPreview(null);
      setPreviewPath(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewPath(null);
    apiReadFilePreview(activeEntry.path, 32768)
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
          setPreviewPath(activeEntry.path);
        }
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeEntry?.path, isImage, isVideo]);

  useEffect(() => {
    if (!activeEntry || !needsStreamPreview) {
      setVideoUrl(null);
      setVideoStreamError(null);
      return;
    }
    let cancelled = false;
    setVideoUrl(null);
    setVideoStreamError(null);
    apiGetFilePreviewUrl(activeEntry.path)
      .then((url) => {
        if (!cancelled) setVideoUrl({ path: activeEntry.path, url });
      })
      .catch((error) => {
        if (!cancelled) setVideoStreamError({ path: activeEntry.path, message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [activeEntry?.path, needsStreamPreview]);

  const currentVideoUrl =
    videoUrl && videoUrl.path === activeEntry?.path ? videoUrl.url : null;
  const currentVideoError =
    videoStreamError && videoStreamError.path === activeEntry?.path
      ? videoStreamError.message
      : null;
  const currentPreview = previewPath === activeEntry?.path ? preview : null;

  if (!activeEntry) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-40 text-sm">
        This folder is empty
      </div>
    );
  }

  return (
    <div
      onDragStart={(e) => e.preventDefault()}
      className="macos-layer-isolate flex-1 flex overflow-hidden select-none"
    >
      {/* Main Stage + Bottom Filmstrip */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Central Stage */}
        <div
          onMouseDown={(e) => onStartItemDrag(e, activeEntry, entries)}
          onDoubleClick={() => onOpenEntry(activeEntry)}
          className="flex-1 flex flex-col items-center justify-center p-6 overflow-hidden"
        >
          {activeImageSrc ? (
            <img
              src={activeImageSrc}
              alt={activeEntry.name}
              style={{ transform: `scale(${stageImgScale})` }}
              className="max-h-full max-w-full rounded-xl shadow-2xl object-contain transition-transform duration-150"
            />
          ) : currentPreview?.previewType === "pdf" ? (
            currentVideoUrl ? (
              <iframe
                key={activeEntry.path}
                src={currentVideoUrl}
                title={`PDF preview: ${activeEntry.name}`}
                onMouseDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                className="h-full w-full rounded-xl bg-white shadow-2xl"
              />
            ) : (
              <div className="text-xs opacity-50">
                {currentVideoError ? `Could not load PDF preview: ${currentVideoError}` : "Preparing PDF preview..."}
              </div>
            )
          ) : currentPreview?.previewType === "video" ? (
            currentVideoUrl ? (
              <video
                key={activeEntry.path}
                src={currentVideoUrl}
                controls
                playsInline
                preload="metadata"
                onMouseDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                className="max-h-full max-w-full rounded-xl bg-black shadow-2xl"
                aria-label={`Video preview: ${activeEntry.name}`}
              />
            ) : (
              <div className="text-xs opacity-50">
                {currentVideoError ? `Could not load video preview: ${currentVideoError}` : "Preparing video preview..."}
              </div>
            )
          ) : currentPreview?.previewType === "text" && currentPreview.textContent ? (
            <pre
              style={{
                fontSize: `${Math.max(10, Math.min(16, Math.round(12 * zoomScale)))}px`,
              }}
              className={`w-full max-w-2xl h-full max-h-80 p-4 rounded-xl font-mono overflow-auto border shadow-inner ${
                darkMode
                  ? "bg-black/40 border-white/10 text-zinc-200"
                  : "bg-white border-black/10 text-zinc-800"
              }`}
            >
              {currentPreview.textContent}
            </pre>
          ) : (
            <div className="flex flex-col items-center">
              <FileIcon entry={activeEntry} size={stageIconSize} />
              <div className="mt-3 text-sm font-medium">{activeEntry.name}</div>
            </div>
          )}
        </div>

        {/* Bottom Horizontal Filmstrip */}
        <div
          data-tab-scroll-view="gallery"
          style={{ height: stripHeight }}
          className={`border-t px-4 flex items-center gap-3 overflow-x-auto ${
            darkMode
              ? "bg-black/20 border-white/10"
              : "bg-black/[0.03] border-black/10"
          }`}
        >
          {entries.map((entry) => {
            const isSelected = selectedSet.has(entry.path) || activeEntry.path === entry.path;
            const isDropTarget = entry.isDir && dropTargetPath === entry.path;
            const isBeingDragged = draggedSet.has(entry.path);
            return (
              <div
                key={entry.path}
                data-entry-path={entry.path}
                data-drop-path={entry.isDir ? entry.path : undefined}
                data-drop-name={entry.isDir ? entry.name : undefined}
                style={{ width: thumbBoxSize, height: thumbBoxSize }}
                onMouseDown={(e) => onStartItemDrag(e, entry, entries)}
                onDoubleClick={() => onOpenEntry(entry)}
                onContextMenu={(e) => {
                  e.stopPropagation();
                  onContextMenu(e, entry);
                }}
                className={`p-2 rounded-xl flex flex-col items-center justify-center shrink-0 cursor-pointer ${
                  isBeingDragged ? "opacity-45" : ""
                } ${
                  isDropTarget
                    ? "bg-[#0a84ff]/35 ring-2 ring-[#0a84ff]"
                    : isSelected
                    ? darkMode
                      ? "bg-white/15"
                      : "bg-black/10"
                    : "hover:bg-white/5 opacity-75 hover:opacity-100"
                }`}
              >
                <FileIcon entry={entry} size={thumbIconSize} />
                <span className="text-[10px] truncate w-full mt-1 text-center">
                  {entry.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right Metadata Inspector */}
      <div
        className={`w-72 shrink-0 border-l p-4 overflow-y-auto text-xs space-y-4 ${
          darkMode
            ? "border-white/10 bg-white/[0.02]"
            : "border-black/10 bg-black/[0.02]"
        }`}
      >
        <div>
          <h3 className="text-sm font-semibold break-all">{activeEntry.name}</h3>
          <p className="opacity-55 mt-0.5">
            {activeEntry.kind}{" "}
            {!activeEntry.isDir && `• ${formatBytes(activeEntry.size)}`}
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onQuickLook}
            className="flex-1 py-1.5 rounded-md bg-[#0a84ff] text-white font-medium hover:opacity-90"
          >
            Quick Look (Space)
          </button>
        </div>

        <div className="space-y-2 pt-3 border-t border-current/10">
          <div className="font-semibold opacity-50 uppercase tracking-wider text-[10px]">
            General
          </div>
          <div className="flex justify-between">
            <span className="opacity-60">Created</span>
            <span>{formatMacDate(activeEntry.created)}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-60">Modified</span>
            <span>{formatMacDate(activeEntry.modified)}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-60">Permissions</span>
            <span className="font-mono">{activeEntry.permissions}</span>
          </div>
        </div>

        <div className="space-y-2 pt-3 border-t border-current/10">
          <div className="font-semibold opacity-50 uppercase tracking-wider text-[10px]">
            Tags
          </div>
          <div className="flex items-center gap-2">
            {TAG_COLORS.map((tc) => {
              const active = activeEntry.tags.includes(tc.id);
              return (
                <button
                  key={tc.id}
                  onClick={() => onToggleTag(activeEntry.path, tc.id)}
                  className={`w-4 h-4 rounded-full ${tc.bgClass} ${
                    active ? "ring-2 ring-white" : "opacity-55 hover:opacity-100"
                  }`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
