import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronUp, RefreshCw, X } from "lucide-react";
import { apiGetFilesByTag, apiOpenItem, apiReadDirectory } from "../api";
import { FileEntry } from "../types";
import type { SelectionModifiers } from "./Views";
import { useMarqueeSelection } from "./Views";
import { FileIcon } from "./FileIcon";

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
  refreshVersion: number;
  panelWidthPercent: number;
  dropTargetPath: string | null;
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
  onSelectionChange: (paths: string[]) => void;
  onSelectAllChange: (selectAll: (() => void) | null) => void;
}

export const SplitExplorerPane: React.FC<SplitExplorerPaneProps> = ({
  initialPath,
  initialTitle,
  initialTag,
  darkMode,
  refreshVersion,
  panelWidthPercent,
  dropTargetPath,
  onStartItemDrag,
  onClose,
  onLocationChange,
  onHoverChange,
  onSelectionChange,
  onSelectAllChange,
}) => {
  const [history, setHistory] = useState<PaneLocation[]>([
    { path: initialPath, title: initialTitle, activeTag: initialTag },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selectedPathsRef = useRef<string[]>([]);
  selectedPathsRef.current = selectedPaths;
  const containerRef = useRef<HTMLDivElement>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const location = history[historyIndex] || history[0];

  useEffect(() => {
    onLocationChange(location);
  }, [location.path, location.title, location.activeTag, onLocationChange]);

  useEffect(() => {
    let mounted = true;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    const readEntries = location.activeTag
      ? apiGetFilesByTag(location.activeTag)
      : apiReadDirectory(location.path, false);
    void readEntries
      .then((result) => {
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
    onSelectionChange([]);
    selectionAnchorRef.current = null;
    return () => {
      mounted = false;
    };
  }, [location.path, location.activeTag, refreshVersion, onSelectionChange]);

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
    if (!location.path || location.path === "/" || location.path === "__RECENTS__") {
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
    const requestId = ++requestIdRef.current;
    const readEntries = location.activeTag
      ? apiGetFilesByTag(location.activeTag)
      : apiReadDirectory(location.path, false);
    void readEntries
      .then((result) => {
        if (requestIdRef.current === requestId) setEntries(result);
      })
      .catch((reason) => {
        if (requestIdRef.current === requestId) setError(String(reason));
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
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

  const setSelection = useCallback((paths: string[]) => {
    selectedPathsRef.current = paths;
    setSelectedPaths(paths);
    onSelectionChange(paths);
  }, [onSelectionChange]);
  const clearSelection = useCallback(() => {
    selectedPathsRef.current = [];
    selectionAnchorRef.current = null;
    setSelectedPaths([]);
    onSelectionChange([]);
  }, [onSelectionChange]);
  const selectAll = useCallback(() => {
    setSelection(entries.map((entry) => entry.path));
  }, [entries, setSelection]);
  useEffect(() => {
    onSelectAllChange(selectAll);
    return () => onSelectAllChange(null);
  }, [onSelectAllChange, selectAll]);
  const { marqueeRect, handleContainerMouseDown } = useMarqueeSelection({
    containerRef,
    selectedPaths,
    onSetSelection: setSelection,
    onClearSelection: clearSelection,
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
            disabled={!location.path || location.path === "/" || location.path === "__RECENTS__"}
            onClick={goUp}
            aria-label="Go to parent folder in split pane"
            title="Enclosing Folder"
            className={`rounded-md p-1.5 transition ${location.path && location.path !== "/" && location.path !== "__RECENTS__" ? buttonClass : "cursor-default opacity-30"}`}
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
        onMouseDown={handleContainerMouseDown}
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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1">
            {entries.map((entry) => {
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
                    onSelectionChange(nextSelection);
                    onStartItemDrag(
                      event,
                      entry,
                      entries,
                      () => {
                        if (wasSelected && !modifiers.ctrlKey && !modifiers.shift) {
                          const singleSelection = [entry.path];
                          selectedPathsRef.current = singleSelection;
                          setSelectedPaths(singleSelection);
                          onSelectionChange(singleSelection);
                        }
                      },
                      nextSelection
                    );
                  }}
                  onDoubleClick={() => void openEntry(entry)}
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
