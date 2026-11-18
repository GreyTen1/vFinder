import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronUp, RefreshCw, X } from "lucide-react";
import { apiGetFilesByTag, apiOpenItem, apiReadDirectory } from "../api";
import { FileEntry } from "../types";
import type { MarqueeRect, ScrollFrameHandle, SelectionModifiers } from "./Views";
import { cancelScrollUpdate, scheduleScrollUpdate, useMarqueeSelection } from "./Views";
import { FileIcon } from "./FileIcon";

const SPLIT_VIRTUALIZATION_THRESHOLD = 120;
const SPLIT_CELL_WIDTH = 96;
const SPLIT_CELL_HEIGHT = 88;
const SPLIT_GRID_GAP = 4;
const SPLIT_ROW_PITCH = SPLIT_CELL_HEIGHT + SPLIT_GRID_GAP;

interface PaneLocation {
  path: string;
  title: string;
  activeTag?: string | null;
}

interface SplitExplorerPaneProps {
  initialPath: string;
  initialTitle: string;
  initialTag?: string | null;
  darkMode: boolean;
  showHidden: boolean;
  refreshVersion: number;
  panelWidthPercent: number;
  dropTargetPath: string | null;
  getCachedEntries?: (path: string, showHidden: boolean) => FileEntry[] | undefined;
  onCacheEntries?: (path: string, showHidden: boolean, entries: FileEntry[]) => void;
  onActivePane?: () => void;
  onStartItemDrag: (
    event: React.MouseEvent,
    entry: FileEntry,
    orderedEntries?: FileEntry[],
    onClickOverride?: (entry: FileEntry, modifiers: SelectionModifiers) => void,
    selectedPathsOverride?: string[]
  ) => void;
  onClose: () => void;
  onLocationChange: (location: PaneLocation) => void;
  onHoverChange: (hovered: boolean) => void;
  onSelectionChange: (paths: string[], selectedEntries: FileEntry[]) => void;
  onSelectAllChange: (selectAll: (() => void) | null) => void;
  onNavigateSelectionChange?: (
    navigateByKey: ((key: string, shiftKey: boolean) => FileEntry | null) | null
  ) => void;
  onContextMenu?: (
    e: React.MouseEvent,
    entry?: FileEntry,
    targetDir?: string
  ) => void;
}

export const SplitExplorerPane: React.FC<SplitExplorerPaneProps> = ({
  initialPath,
  initialTitle,
  initialTag,
  darkMode,
  showHidden,
  refreshVersion,
  panelWidthPercent,
  dropTargetPath,
  getCachedEntries,
  onCacheEntries,
  onActivePane,
  onStartItemDrag,
  onClose,
  onLocationChange,
  onHoverChange,
  onSelectionChange,
  onSelectAllChange,
  onNavigateSelectionChange,
  onContextMenu,
}) => {
  const [history, setHistory] = useState<PaneLocation[]>([
    { path: initialPath, title: initialTitle, activeTag: initialTag },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const entriesRef = useRef<FileEntry[]>([]);
  entriesRef.current = entries;
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selectedPathsRef = useRef<string[]>([]);
  selectedPathsRef.current = selectedPaths;
  const containerRef = useRef<HTMLDivElement>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const getCachedEntriesRef = useRef(getCachedEntries);
  getCachedEntriesRef.current = getCachedEntries;
  const onCacheEntriesRef = useRef(onCacheEntries);
  onCacheEntriesRef.current = onCacheEntries;
  const [gridViewport, setGridViewport] = useState({ width: 0, height: 0, top: 0 });
  const gridScrollFrameRef = useRef<ScrollFrameHandle | null>(null);
  const location = history[historyIndex] || history[0];

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    onLocationChange(location);
  }, [location.path, location.title, location.activeTag, onLocationChange]);

  useEffect(() => {
    let mounted = true;
    const requestId = ++requestIdRef.current;
    const cached = !location.activeTag
      ? getCachedEntriesRef.current?.(location.path, showHidden)
      : undefined;
    if (cached) {
      setEntries(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    const readEntries = location.activeTag
      ? apiGetFilesByTag(location.activeTag)
      : apiReadDirectory(location.path, showHidden);
    void readEntries
      .then((result) => {
        if (!location.activeTag) {
          onCacheEntriesRef.current?.(location.path, showHidden, result);
        }
        if (mounted && requestIdRef.current === requestId) setEntries(result);
      })
      .catch((reason) => {
        if (mounted && requestIdRef.current === requestId) {
          setEntries([]);
          setError(String(reason));
        }
      })
      .finally(() => {
        if (mounted && requestIdRef.current === requestId) setLoading(false);
      });
    selectedPathsRef.current = [];
    setSelectedPaths([]);
    onSelectionChange([], []);
    selectionAnchorRef.current = null;
    return () => {
      mounted = false;
    };
  }, [location.path, location.activeTag, refreshVersion, showHidden, onSelectionChange]);

  const navigate = (entry: FileEntry) => {
    setHistory((prev) => [
      ...prev.slice(0, historyIndex + 1),
      { path: entry.path, title: entry.name, activeTag: null },
    ]);
    setHistoryIndex((prev) => prev + 1);
  };

  const goBack = () => setHistoryIndex((prev) => Math.max(0, prev - 1));
  const goForward = () =>
    setHistoryIndex((prev) => Math.min(history.length - 1, prev + 1));

  const goUp = () => {
    if (!location.path || location.path === "/" || location.path === "__RECENTS__" || location.path === "__TRASH__") {
      return;
    }
    const parts = location.path.split("/").filter(Boolean);
    parts.pop();
    const parentPath = `/${parts.join("/")}`;
    setHistory((prev) => [
      ...prev.slice(0, historyIndex + 1),
      { path: parentPath, title: parts[parts.length - 1] || "/" },
    ]);
    setHistoryIndex((prev) => prev + 1);
  };

  const openEntry = async (entry: FileEntry) => {
    if (entry.isDir) {
      navigate(entry);
      return;
    }
    try {
      await apiOpenItem(entry.path);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const refresh = () => {
    setLoading(true);
    setError(null);
    const requestId = ++requestIdRef.current;
    const readEntries = location.activeTag
      ? apiGetFilesByTag(location.activeTag)
      : apiReadDirectory(location.path, showHidden);
    void readEntries
      .then((result) => {
        if (!location.activeTag) {
          onCacheEntriesRef.current?.(location.path, showHidden, result);
        }
        if (isMountedRef.current && requestIdRef.current === requestId) {
          setEntries(result);
        }
      })
      .catch((reason) => {
        if (isMountedRef.current && requestIdRef.current === requestId) {
          setEntries([]);
          setError(String(reason));
        }
      })
      .finally(() => {
        if (isMountedRef.current && requestIdRef.current === requestId) {
          setLoading(false);
        }
      });
  };

  const getNextSelection = (
    entry: FileEntry,
    modifiers: SelectionModifiers
  ) => {
    if (modifiers.shift) {
      const anchorPath =
        selectionAnchorRef.current ||
        selectedPathsRef.current[selectedPathsRef.current.length - 1] ||
        entry.path;
      const anchorIndex = entries.findIndex((item) => item.path === anchorPath);
      const targetIndex = entries.findIndex((item) => item.path === entry.path);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const range = entries.slice(start, end + 1).map((item) => item.path);
        return modifiers.ctrlKey
          ? Array.from(new Set([...selectedPathsRef.current, ...range]))
          : range;
      }
    }
    if (modifiers.ctrlKey) {
      return selectedPathsRef.current.includes(entry.path)
        ? selectedPathsRef.current.filter((path) => path !== entry.path)
        : [...selectedPathsRef.current, entry.path];
    }
    return [entry.path];
  };

  const notifySelection = useCallback(
    (paths: string[], items: FileEntry[] = entriesRef.current) => {
      if (paths.length === 0) {
        onSelectionChange([], []);
        return;
      }
      const pathSet = new Set(paths);
      const selectedItems = items.filter((item) => pathSet.has(item.path));
      onSelectionChange(paths, selectedItems);
    },
    [onSelectionChange]
  );

  const setSelection = useCallback((paths: string[]) => {
    selectedPathsRef.current = paths;
    setSelectedPaths(paths);
    notifySelection(paths);
  }, [notifySelection]);
  const clearSelection = useCallback(() => {
    selectedPathsRef.current = [];
    selectionAnchorRef.current = null;
    setSelectedPaths([]);
    notifySelection([]);
  }, [notifySelection]);
  const selectAll = useCallback(() => {
    setSelection(entries.map((entry) => entry.path));
  }, [entries, setSelection]);
  useEffect(() => {
    onSelectAllChange(selectAll);
    return () => onSelectAllChange(null);
  }, [onSelectAllChange, selectAll]);

  const navigateByKey = useCallback(
    (key: string, shiftKey: boolean): FileEntry | null => {
      const list = entriesRef.current;
      if (list.length === 0) return null;
      const currentSelected = selectedPathsRef.current;
      const primaryPath =
        currentSelected[currentSelected.length - 1] || currentSelected[0] || null;
      const curIdx = primaryPath
        ? list.findIndex((item) => item.path === primaryPath)
        : -1;

      const contentWidth = containerRef.current
        ? Math.max(0, containerRef.current.clientWidth - 16)
        : 300;
      const cols = Math.max(1, Math.floor((contentWidth + 4) / (96 + 4)));

      let targetIdx = curIdx;
      if (key === "Home") targetIdx = 0;
      else if (key === "End") targetIdx = list.length - 1;
      else if (key === "ArrowRight")
        targetIdx = curIdx === -1 ? 0 : Math.min(list.length - 1, curIdx + 1);
      else if (key === "ArrowLeft")
        targetIdx = curIdx === -1 ? 0 : Math.max(0, curIdx - 1);
      else if (key === "ArrowDown")
        targetIdx = curIdx === -1 ? 0 : Math.min(list.length - 1, curIdx + cols);
      else if (key === "ArrowUp")
        targetIdx =
          curIdx === -1 ? list.length - 1 : Math.max(0, curIdx - cols);

      if (targetIdx < 0 || targetIdx >= list.length) return null;
      const targetEntry = list[targetIdx];
      let nextPaths: string[];
      if (shiftKey) {
        const anchorPath =
          selectionAnchorRef.current || primaryPath || targetEntry.path;
        const anchorIdx = list.findIndex((item) => item.path === anchorPath);
        const start = Math.min(anchorIdx >= 0 ? anchorIdx : 0, targetIdx);
        const end = Math.max(anchorIdx >= 0 ? anchorIdx : 0, targetIdx);
        nextPaths = list.slice(start, end + 1).map((item) => item.path);
      } else {
        selectionAnchorRef.current = targetEntry.path;
        nextPaths = [targetEntry.path];
      }
      setSelection(nextPaths);
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-entry-path="${CSS.escape(targetEntry.path)}"]`
      );
      if (el) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      } else if (containerRef.current && list.length > SPLIT_VIRTUALIZATION_THRESHOLD) {
        const container = containerRef.current;
        const rowTop = 8 + Math.floor(targetIdx / cols) * SPLIT_ROW_PITCH;
        if (rowTop < container.scrollTop) {
          container.scrollTop = Math.max(0, rowTop - 8);
        } else if (rowTop + SPLIT_CELL_HEIGHT > container.scrollTop + container.clientHeight) {
          container.scrollTop = rowTop + SPLIT_CELL_HEIGHT + 8 - container.clientHeight;
        }
      }
      return targetEntry;
    },
    [setSelection]
  );

  useEffect(() => {
    onNavigateSelectionChange?.(navigateByKey);
    return () => onNavigateSelectionChange?.(null);
  }, [onNavigateSelectionChange, navigateByKey]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let throttleTimer: number | null = null;
    let lastMeasureTime = 0;
    const THROTTLE_MS = 80;

    const getCols = (w: number) =>
      Math.max(
        1,
        Math.floor((Math.max(0, w - 16) + SPLIT_GRID_GAP) / (SPLIT_CELL_WIDTH + SPLIT_GRID_GAP))
      );
    const getRows = (h: number) => Math.ceil(h / SPLIT_ROW_PITCH);

    const applySize = () => {
      lastMeasureTime = performance.now();
      const width = container.clientWidth;
      const height = container.clientHeight;
      const top = container.scrollTop;
      setGridViewport((current) => {
        if (
          current.width > 0 &&
          getCols(current.width) === getCols(width) &&
          getRows(current.height) === getRows(height) &&
          current.top === top
        ) {
          return current;
        }
        return { width, height, top };
      });
    };

    const scheduleUpdate = () => {
      const elapsed = performance.now() - lastMeasureTime;
      if (elapsed >= THROTTLE_MS) {
        if (throttleTimer !== null) {
          window.clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        applySize();
      } else if (throttleTimer === null) {
        throttleTimer = window.setTimeout(() => {
          throttleTimer = null;
          applySize();
        }, THROTTLE_MS - elapsed);
      }
    };

    applySize();
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(container);
    return () => {
      if (throttleTimer !== null) {
        window.clearTimeout(throttleTimer);
      }
      observer.disconnect();
    };
  }, []);

  const handleGridScroll = useCallback(() => {
    if (gridScrollFrameRef.current !== null) return;
    gridScrollFrameRef.current = scheduleScrollUpdate(() => {
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
      cancelScrollUpdate(gridScrollFrameRef.current);
      gridScrollFrameRef.current = null;
    },
    []
  );

  const isLargeGrid = entries.length > SPLIT_VIRTUALIZATION_THRESHOLD;
  const contentWidth = Math.max(0, gridViewport.width - 16);
  const rawColumnCount = Math.max(
    1,
    Math.floor((contentWidth + SPLIT_GRID_GAP) / (SPLIT_CELL_WIDTH + SPLIT_GRID_GAP))
  );
  const columnCount = isLargeGrid ? rawColumnCount : 1;
  const rowCount = Math.ceil(entries.length / columnCount);
  const firstVisibleRow = isLargeGrid
    ? Math.max(0, Math.floor((gridViewport.top - 8) / SPLIT_ROW_PITCH) - 8)
    : 0;
  const lastVisibleRow = isLargeGrid
    ? Math.min(
        rowCount,
        Math.ceil((gridViewport.top + gridViewport.height - 8) / SPLIT_ROW_PITCH) + 8
      )
    : rowCount;
  const firstVisibleIndex = firstVisibleRow * columnCount;
  const lastVisibleIndex = Math.min(entries.length, lastVisibleRow * columnCount);
  const renderedEntries = isLargeGrid
    ? entries.slice(firstVisibleIndex, lastVisibleIndex)
    : entries;

  const getSplitMarqueeHits = useCallback(
    (rect: MarqueeRect, container: HTMLDivElement): string[] | null => {
      const list = entriesRef.current;
      if (list.length <= SPLIT_VIRTUALIZATION_THRESHOLD) return null;
      if (list.length === 0) return [];
      const cWidth = Math.max(0, container.clientWidth - 16);
      const cols = Math.max(
        1,
        Math.floor((cWidth + SPLIT_GRID_GAP) / (SPLIT_CELL_WIDTH + SPLIT_GRID_GAP))
      );
      const totalRows = Math.ceil(list.length / cols);
      const boxRight = rect.left + rect.width;
      const boxBottom = rect.top + rect.height;
      const minRow = Math.max(0, Math.floor((rect.top - 8) / SPLIT_ROW_PITCH));
      const maxRow = Math.min(
        totalRows - 1,
        Math.floor((boxBottom - 8) / SPLIT_ROW_PITCH)
      );
      const hits: string[] = [];
      for (let r = minRow; r <= maxRow; r++) {
        const itemTop = 8 + r * SPLIT_ROW_PITCH;
        const itemBottom = itemTop + SPLIT_CELL_HEIGHT;
        if (itemTop >= boxBottom || itemBottom <= rect.top) continue;
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (idx >= list.length) break;
          const itemLeft = 8 + c * (SPLIT_CELL_WIDTH + SPLIT_GRID_GAP);
          const itemRight = itemLeft + SPLIT_CELL_WIDTH;
          if (itemLeft < boxRight && itemRight > rect.left) {
            hits.push(list[idx].path);
          }
        }
      }
      return hits;
    },
    []
  );

  const { marqueeRect, handleContainerMouseDown } = useMarqueeSelection({
    containerRef,
    selectedPaths,
    onSetSelection: setSelection,
    onClearSelection: clearSelection,
    getHitPaths: getSplitMarqueeHits,
  });

  const buttonClass = darkMode
    ? "text-zinc-300 hover:bg-white/10 active:bg-white/15"
    : "text-zinc-700 hover:bg-black/5 active:bg-black/10";

  return (
    <section
      aria-label="Split file browser"
      data-split-pane="true"
      data-drop-path={location.activeTag ? undefined : location.path}
      data-drop-name={location.title}
      onPointerDownCapture={onActivePane}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      className={`flex min-w-0 flex-1 flex-col border-l ${
        darkMode ? "border-white/10 bg-[#202024]" : "border-black/10 bg-[#f2f2f5]"
      }`}
      style={{ flex: `0 0 ${panelWidthPercent}%` }}
    >
      <header
        className={`flex h-10 shrink-0 items-center gap-1 border-b px-1 ${
          darkMode ? "border-white/10" : "border-black/10"
        }`}
      >
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={historyIndex <= 0}
            onClick={goBack}
            aria-label="Go back in split pane"
            title="Back"
            className={`rounded-md p-1.5 transition ${historyIndex > 0 ? buttonClass : "cursor-default opacity-30"}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={historyIndex >= history.length - 1}
            onClick={goForward}
            aria-label="Go forward in split pane"
            title="Forward"
            className={`rounded-md p-1.5 transition ${historyIndex < history.length - 1 ? buttonClass : "cursor-default opacity-30"}`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!location.path || location.path === "/" || location.path === "__RECENTS__" || location.path === "__TRASH__"}
            onClick={goUp}
            aria-label="Go to parent folder in split pane"
            title="Enclosing Folder"
            className={`rounded-md p-1.5 transition ${location.path && location.path !== "/" && location.path !== "__RECENTS__" && location.path !== "__TRASH__" ? buttonClass : "cursor-default opacity-30"}`}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={refresh}
            aria-label="Refresh split pane"
            title="Refresh"
            className={`rounded-md p-1.5 transition ${buttonClass}`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close split pane"
          title="Close split view"
          className={`ml-auto mr-2 rounded-md p-1.5 transition ${buttonClass}`}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div
        ref={containerRef}
        onScroll={handleGridScroll}
        onMouseDown={handleContainerMouseDown}
        onContextMenu={(e) =>
          onContextMenu?.(e, undefined, location.activeTag ? undefined : location.path)
        }
        className="relative min-h-0 flex-1 overflow-auto p-2"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs opacity-50">
            Loading…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-red-400">
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs opacity-50">
            This folder is empty
          </div>
        ) : (
          <div
            className={
              isLargeGrid
                ? "relative w-full"
                : "grid grid-cols-[repeat(auto-fill,96px)] justify-start gap-1"
            }
            style={
              isLargeGrid
                ? {
                    height: Math.max(
                      SPLIT_CELL_HEIGHT,
                      rowCount * SPLIT_ROW_PITCH - SPLIT_GRID_GAP
                    ),
                  }
                : undefined
            }
          >
            {renderedEntries.map((entry, visibleIndex) => {
              const index = isLargeGrid
                ? firstVisibleIndex + visibleIndex
                : visibleIndex;
              const selected = selectedPaths.includes(entry.path);
              return (
                <div
                  key={entry.path}
                  role="button"
                  tabIndex={0}
                  data-entry-path={entry.path}
                  data-drag-handle="true"
                  data-drop-path={entry.isDir ? entry.path : undefined}
                  data-drop-name={entry.isDir ? entry.name : undefined}
                  style={
                    isLargeGrid
                      ? {
                          position: "absolute",
                          left: (index % columnCount) * (SPLIT_CELL_WIDTH + SPLIT_GRID_GAP),
                          top: Math.floor(index / columnCount) * SPLIT_ROW_PITCH,
                          width: SPLIT_CELL_WIDTH,
                          minHeight: SPLIT_CELL_HEIGHT,
                          zIndex: selected ? 20 : 1,
                        }
                      : undefined
                  }
                  onMouseDown={(event) => {
                    const modifiers = {
                      ctrlKey: event.ctrlKey,
                      shift: event.shiftKey,
                    };
                    const currentSelection = selectedPathsRef.current;
                    const wasSelected = currentSelection.includes(entry.path);
                    const nextSelection =
                      wasSelected && !modifiers.ctrlKey && !modifiers.shift
                        ? currentSelection
                        : getNextSelection(entry, modifiers);
                    if (!modifiers.shift) selectionAnchorRef.current = entry.path;
                    selectedPathsRef.current = nextSelection;
                    setSelectedPaths(nextSelection);
                    notifySelection(nextSelection);
                    onStartItemDrag(
                      event,
                      entry,
                      entries,
                      () => {
                        if (wasSelected && !modifiers.ctrlKey && !modifiers.shift) {
                          const singleSelection = [entry.path];
                          selectedPathsRef.current = singleSelection;
                          setSelectedPaths(singleSelection);
                          notifySelection(singleSelection);
                        }
                      },
                      nextSelection
                    );
                  }}
                  onDoubleClick={() => void openEntry(entry)}
                  onContextMenu={(event) => {
                    event.stopPropagation();
                    if (!selectedPathsRef.current.includes(entry.path)) {
                      const singleSelection = [entry.path];
                      selectionAnchorRef.current = entry.path;
                      selectedPathsRef.current = singleSelection;
                      setSelectedPaths(singleSelection);
                      notifySelection(singleSelection);
                    }
                    onContextMenu?.(
                      event,
                      entry,
                      location.activeTag ? undefined : location.path
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void openEntry(entry);
                    }
                  }}
                  className={`flex min-h-[88px] min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1.5 py-2 text-center text-[11px] ${
                    selected
                      ? darkMode
                        ? "bg-white/15"
                        : "bg-black/10"
                      : darkMode
                      ? "hover:bg-white/[0.06]"
                      : "hover:bg-black/[0.045]"
                  } ${
                    dropTargetPath === entry.path && entry.isDir
                      ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/15"
                      : ""
                  }`}
                >
                  <FileIcon entry={entry} size={38} />
                  <span className="w-full truncate">{entry.name}</span>
                </div>
              );
            })}
          </div>
        )}
        {marqueeRect && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 border border-[#0a84ff] bg-[#0a84ff]/15"
            style={{
              left: marqueeRect.left,
              top: marqueeRect.top,
              width: marqueeRect.width,
              height: marqueeRect.height,
            }}
          />
        )}
      </div>
      <footer
        className={`h-7 shrink-0 border-t px-3 py-1 text-[10px] opacity-60 ${
          darkMode ? "border-white/10" : "border-black/10"
        }`}
      >
        {entries.length} items
      </footer>
    </section>
  );
};
