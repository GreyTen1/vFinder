import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  LayoutGrid,
  List,
  Columns3,
  GalleryHorizontalEnd,
  Search,
  SlidersHorizontal,
  FolderPlus,
  FilePlus,
  Eye,
  EyeOff,
  Info,
  Sun,
  Moon,
  PanelLeft,
  Plus,
  X,
  ArrowUpDown,
  RefreshCw,
  Download,
  Minus,
  Square,
  Folder,
  Columns2,
  Trash2,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FinderTab, SortDirection, SortField, ViewMode } from "../types";
import { apiOpenDetachedTab } from "../api";

interface ToolbarProps {
  currentTitle: string;
  canGoBack: boolean;
  canGoForward: boolean;
  canGoUp: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  viewMode: ViewMode;
  onChangeViewMode: (mode: ViewMode) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onChangeSort: (field: SortField) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  showHidden: boolean;
  onToggleHidden: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onGetInfo: () => void;
  onRefresh: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  tabs: FinderTab[];
  activeTabId: string;
  splitTab?: Pick<FinderTab, "id" | "title" | "path" | "archiveWorkspaceRoot"> | null;
  splitTabLeft?: number | null;
  tabStripStartOffset?: number;
  canSplitTab: boolean;
  onCloseSplitPane: () => void;
  onSelectTab: (id: string) => void;
  onSplitTab: (tab: FinderTab) => void;
  onReorderTabs: (draggedId: string, targetId: string, after: boolean) => void;
  onNewTab: () => void;
  onCloseTab: (id: string, allowLastTab?: boolean) => void;
  dropTargetPath?: string | null;
  activeDownloadsCount?: number;
  onToggleDownloads?: () => void;
  downloadsOpen?: boolean;
  isRoot?: boolean;
  isTrashActive?: boolean;
  onOpenTrash?: () => void;
}

interface TabDragState {
  tab: FinderTab;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
  detachStarted: boolean;
  lastReorderKey: string | null;
}

function isInsideArchiveWorkspace(path: string, root?: string): boolean {
  if (!root) return false;
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

const ArchiveZipperMark: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 1.75h8v12.5H4z" fill="currentColor" fillOpacity=".13" stroke="currentColor" strokeWidth="1.1" />
    <path d="M7 2.2v1.4m2 1v1.4m-2 1v1.4m2 1v1.4m-2 1v1.4" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    <path d="M8 6.3h3v2.6H8z" fill="currentColor" />
  </svg>
);

export const Toolbar: React.FC<ToolbarProps> = ({
  currentTitle,
  canGoBack,
  canGoForward,
  canGoUp,
  onBack,
  onForward,
  onUp,
  viewMode,
  onChangeViewMode,
  sortField,
  sortDirection,
  onChangeSort,
  searchQuery,
  onSearchChange,
  showHidden,
  onToggleHidden,
  onNewFolder,
  onNewFile,
  onGetInfo,
  onRefresh,
  sidebarOpen,
  onToggleSidebar,
  darkMode,
  onToggleDarkMode,
  tabs,
  activeTabId,
  splitTab = null,
  splitTabLeft = null,
  tabStripStartOffset = 0,
  canSplitTab,
  onCloseSplitPane,
  onSelectTab,
  onSplitTab,
  onReorderTabs,
  onNewTab,
  onCloseTab,
  dropTargetPath,
  activeDownloadsCount = 0,
  onToggleDownloads,
  downloadsOpen = false,
  isRoot = false,
  isTrashActive = false,
  onOpenTrash,
}) => {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [windowControlsSide, setWindowControlsSide] = useState<"left" | "right">(() => {
    try {
      return localStorage.getItem("finder-window-controls-side") === "right"
        ? "right"
        : "left";
    } catch {
      return "left";
    }
  });
  const [windowControlsStyle, setWindowControlsStyle] = useState<"macos" | "vscode">(() => {
    try {
      return localStorage.getItem("finder-window-controls-style") === "vscode"
        ? "vscode"
        : "macos";
    } catch {
      return "macos";
    }
  });
  const sortRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const leftToolbarRef = useRef<HTMLDivElement>(null);
  const rightToolbarRef = useRef<HTMLDivElement>(null);
  const tabDragRef = useRef<TabDragState | null>(null);
  const tabElementsRef = useRef(new Map<string, HTMLDivElement>());
  const splitTabElementRef = useRef<HTMLDivElement>(null);
  const animatedTabMoveRef = useRef<typeof tabMoveAnimation>(null);
  const pendingTabPositionsRef = useRef<Map<string, number> | null>(null);
  const suppressTabClickRef = useRef(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    tab: FinderTab;
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const [tabMoveAnimation, setTabMoveAnimation] = useState<{
    tab: FinderTab;
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    const previousPositions = pendingTabPositionsRef.current;
    if (!previousPositions) return;
    pendingTabPositionsRef.current = null;

    for (const tab of tabs) {
      if (tab.id === draggingTabId) continue;
      const element = tabElementsRef.current.get(tab.id);
      const previousLeft = previousPositions.get(tab.id);
      if (!element || previousLeft === undefined) continue;
      const deltaX = previousLeft - element.getBoundingClientRect().left;
      if (Math.abs(deltaX) < 1) continue;
      element.animate(
        [
          { transform: `translateX(${deltaX}px)` },
          { transform: "translateX(0)" },
        ],
        { duration: 180, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)" }
      );
    }
  }, [tabs, draggingTabId]);

  useLayoutEffect(() => {
    const moving = tabMoveAnimation;
    if (
      !moving ||
      !splitTab ||
      splitTab.id !== moving.tab.id ||
      splitTabLeft === null ||
      animatedTabMoveRef.current === moving
    ) {
      return;
    }
    const target = splitTabElementRef.current;
    if (!target) return;

    const targetRect = target.getBoundingClientRect();
    animatedTabMoveRef.current = moving;
    const deltaX = moving.left - targetRect.left;
    const deltaY = moving.top - targetRect.top;
    const animation = target.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: "translate(0, 0)" },
      ],
      {
        duration: 320,
        easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
        fill: "forwards",
      }
    );
    animation.onfinish = () => {
      // Commit the identity transform before dropping the animation effect.
      // The destination node remains mounted, so there is no overlay handoff.
      try {
        animation.commitStyles();
      } catch {
        // Older WebKit versions may not implement commitStyles.
      }
      animation.cancel();
      animatedTabMoveRef.current = null;
      setTabMoveAnimation((current) => (current === moving ? null : current));
    };
  }, [tabMoveAnimation, splitTab?.id, splitTab?.title, splitTabLeft]);
  const [viewSwitcherOffset, setViewSwitcherOffset] = useState(0);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false);
      }
      if (actionRef.current && !actionRef.current.contains(e.target as Node)) {
        setActionMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleCloseWindow = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  };

  const handleMinimizeWindow = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      // ignore in browser fallback
    }
  };

  const handleMaximizeWindow = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {
      // ignore in browser fallback
    }
  };

  const btnBase = darkMode
    ? "text-zinc-300 hover:bg-white/10 active:bg-white/15"
    : "text-zinc-700 hover:bg-black/5 active:bg-black/10";

  const updateWindowControlsSide = (side: "left" | "right") => {
    setWindowControlsSide(side);
    try {
      localStorage.setItem("finder-window-controls-side", side);
    } catch {
      // Keep the selection for this session if storage is unavailable.
    }
  };

  const updateWindowControlsStyle = (style: "macos" | "vscode") => {
    setWindowControlsStyle(style);
    try {
      localStorage.setItem("finder-window-controls-style", style);
    } catch {
      // Keep the selection for this session if storage is unavailable.
    }
  };

  const startTabDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    tab: FinderTab
  ) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    tabDragRef.current = {
      tab,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      moved: false,
      detachStarted: false,
      lastReorderKey: null,
    };
    setDraggingTabId(null);
    setDragPreview(null);
    event.currentTarget
      .closest<HTMLElement>("[role='tablist']")
      ?.setPointerCapture(event.pointerId);
  };

  const splitTabToRight = (tab: FinderTab) => {
    if (!canSplitTab) return;
    animatedTabMoveRef.current = null;
    const element = tabElementsRef.current.get(tab.id);
    const rect = element?.getBoundingClientRect();
    if (rect) {
      setTabMoveAnimation({
        tab,
        left: rect.left,
        top: rect.top,
      });
    }
    onSplitTab(tab);
  };

  const reorderTabAtPointer = (
    event: React.PointerEvent<HTMLDivElement>,
    drag: TabDragState
  ) => {
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-tab-id]");
    const targetId = target?.dataset.tabId;
    if (!target || !targetId || targetId === drag.tab.id) {
      drag.lastReorderKey = null;
      return;
    }

    const bounds = target.getBoundingClientRect();
    const after = event.clientX >= bounds.left + bounds.width / 2;
    const reorderKey = `${targetId}:${after ? "after" : "before"}`;
    if (drag.lastReorderKey === reorderKey) return;
    drag.lastReorderKey = reorderKey;

    const fromIndex = tabs.findIndex((tab) => tab.id === drag.tab.id);
    const targetIndexAfterRemoval = tabs
      .filter((tab) => tab.id !== drag.tab.id)
      .findIndex((tab) => tab.id === targetId);
    if (fromIndex < 0 || targetIndexAfterRemoval < 0) return;
    if (targetIndexAfterRemoval + (after ? 1 : 0) === fromIndex) {
      pendingTabPositionsRef.current = null;
      return;
    }

    pendingTabPositionsRef.current = new Map(
      Array.from(tabElementsRef.current, ([id, element]) => [
        id,
        element.getBoundingClientRect().left,
      ])
    );
    onReorderTabs(drag.tab.id, targetId, after);
  };

  const moveTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 7) {
      drag.moved = true;
      setDraggingTabId(drag.tab.id);
      const draggedElement = tabElementsRef.current.get(drag.tab.id);
      setDragPreview((current) => ({
        tab: drag.tab,
        left: event.clientX - drag.offsetX,
        top: event.clientY - drag.offsetY,
        width: current?.tab.id === drag.tab.id
          ? current.width
          : draggedElement?.getBoundingClientRect().width ?? 160,
      }));
      event.preventDefault();
      if (!drag.detachStarted) reorderTabAtPointer(event, drag);
    }
    const outsideWindow =
      event.clientX <= 0 ||
      event.clientY <= 0 ||
      event.clientX >= window.innerWidth ||
      event.clientY >= window.innerHeight;
    if (drag.moved && outsideWindow && !drag.detachStarted) {
      drag.detachStarted = true;
      void apiOpenDetachedTab(drag.tab)
        .then((newWindowLabel) => {
          if (!newWindowLabel) {
            throw new Error("Detached window creation was not confirmed");
          }
          if (tabDragRef.current === drag) {
            tabDragRef.current = null;
            setDraggingTabId(null);
            setDragPreview(null);
          }
          onCloseTab(drag.tab.id, true);
        })
        .catch((error) => {
          drag.detachStarted = false;
          console.error("Failed to detach tab:", error);
        });
    }
  };

  const finishTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved =
      drag.moved ||
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 7;
    if (moved && !drag.detachStarted) reorderTabAtPointer(event, drag);
    tabDragRef.current = null;
    setDraggingTabId(null);
    setDragPreview(null);

    if (moved) {
      suppressTabClickRef.current = true;
      window.setTimeout(() => {
        suppressTabClickRef.current = false;
      }, 0);
    }
  };

  const cancelTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tabDragRef.current?.pointerId === event.pointerId) {
      tabDragRef.current = null;
      setDraggingTabId(null);
      setDragPreview(null);
    }
  };

  const handleTabStripClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressTabClickRef.current) return;
    const eventElement = event.target instanceof Element ? event.target : null;
    const target = eventElement?.closest<HTMLElement>("[data-tab-id]") ??
      document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-tab-id]");
    const tabId = target?.dataset.tabId;
    if (tabId) onSelectTab(tabId);
  };

  const windowControls = (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className={`flex items-center shrink-0 ${windowControlsStyle === "vscode" ? "gap-0" : "gap-2 mr-2"}`}
    >
      <button
        onClick={handleCloseWindow}
        title="Close Window"
        aria-label="Close window"
        className={windowControlsStyle === "vscode"
          ? "order-3 w-8 h-[52px] flex items-center justify-center text-zinc-500 hover:bg-[#e81123] hover:text-white transition-colors"
          : "w-3 h-3 rounded-full bg-[#ff5f57] border border-[#e0443e] flex items-center justify-center hover:opacity-90 cursor-pointer p-0 group/close"}
      >
        {windowControlsStyle === "vscode" ? <X className="w-3.5 h-3.5" /> : (
          <svg viewBox="0 0 12 12" className="w-2 h-2 text-black/80 opacity-0 group-hover/close:opacity-100 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" />
          </svg>
        )}
      </button>
      <button
        onClick={handleMinimizeWindow}
        title="Minimize Window"
        aria-label="Minimize window"
        className={windowControlsStyle === "vscode"
          ? `order-1 w-8 h-[52px] flex items-center justify-center transition-colors ${darkMode ? "text-zinc-400 hover:bg-white/10" : "text-zinc-600 hover:bg-black/10"}`
          : "w-3 h-3 rounded-full bg-[#febc2e] border border-[#d89e24] flex items-center justify-center hover:opacity-90 cursor-pointer p-0 group/minimize"}
      >
        {windowControlsStyle === "vscode" ? <Minus className="w-3.5 h-3.5" /> : (
          <svg viewBox="0 0 12 12" className="w-2 h-2 text-black/80 opacity-0 group-hover/minimize:opacity-100 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M2.5 6H9.5" />
          </svg>
        )}
      </button>
      <button
        onClick={handleMaximizeWindow}
        title="Maximize Window"
        aria-label="Maximize window"
        className={windowControlsStyle === "vscode"
          ? `order-2 w-8 h-[52px] flex items-center justify-center transition-colors ${darkMode ? "text-zinc-400 hover:bg-white/10" : "text-zinc-600 hover:bg-black/10"}`
          : "w-3 h-3 rounded-full bg-[#28c840] border border-[#1aab29] flex items-center justify-center hover:opacity-90 cursor-pointer p-0 group/maximize"}
      >
        {windowControlsStyle === "vscode" ? <Square className="w-3 h-3" /> : (
          <svg viewBox="0 0 12 12" className="w-2 h-2 text-black/80 opacity-0 group-hover/maximize:opacity-100 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M6 2.5V9.5M2.5 6H9.5" />
          </svg>
        )}
      </button>
    </div>
  );
  const vscodeControlsOnRight =
    windowControlsSide === "right" && windowControlsStyle === "vscode";

  useEffect(() => {
    const updateViewSwitcherOffset = () => {
      const compact = window.matchMedia("(max-width: 999px)").matches;
      const leftWidth = leftToolbarRef.current?.getBoundingClientRect().width ?? 0;
      const rightWidth = rightToolbarRef.current?.getBoundingClientRect().width ?? 0;
      const nextOffset = compact ? (leftWidth - rightWidth) / 2 : 0;
      setViewSwitcherOffset((current) =>
        Math.abs(current - nextOffset) < 0.5 ? current : nextOffset
      );
    };

    updateViewSwitcherOffset();
    const resizeObserver = new ResizeObserver(updateViewSwitcherOffset);
    if (leftToolbarRef.current) resizeObserver.observe(leftToolbarRef.current);
    if (rightToolbarRef.current) resizeObserver.observe(rightToolbarRef.current);
    window.addEventListener("resize", updateViewSwitcherOffset);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateViewSwitcherOffset);
    };
  }, []);

  return (
    <div
      data-app-toolbar
      className={`macos-layer-isolate relative z-30 flex flex-col border-b select-none ${
        darkMode
          ? "bg-[#202024] border-white/10 text-zinc-100"
          : "bg-[#f2f2f5] border-black/10 text-zinc-800"
      }`}
    >
      {/* Unified macOS Finder Header Bar */}
      <div
        data-tauri-drag-region
        className="relative h-[52px] px-3.5 flex items-center justify-between gap-2 overflow-visible"
      >
        {/* Left Section: Traffic Lights + Sidebar Toggle + Back/Forward/Up + Folder Title */}
        <div
          ref={leftToolbarRef}
          data-tauri-drag-region
          className="flex-1 flex items-center gap-2 min-w-0 justify-start max-w-full max-[999px]:flex-none max-[999px]:max-w-[45%]"
        >
          {windowControlsSide === "left" && windowControls}

          {/* Sidebar Toggle */}
          <button
            onClick={onToggleSidebar}
            title={sidebarOpen ? "Hide Sidebar (Ctrl+Alt+S)" : "Show Sidebar (Ctrl+Alt+S)"}
            className={`p-1.5 rounded-md transition ${btnBase} ${
              sidebarOpen
                ? darkMode
                  ? "bg-white/10 text-white"
                  : "bg-black/10 text-zinc-900"
                : ""
            }`}
          >
            <PanelLeft className="w-4 h-4" />
          </button>

          {/* Back / Forward / Up Navigation */}
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={onBack}
              disabled={!canGoBack}
              title="Back (Alt+Left)"
              className={`p-1.5 rounded-md transition ${
                canGoBack ? btnBase : "opacity-30 cursor-default"
              }`}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={onForward}
              disabled={!canGoForward}
              title="Forward (Alt+Right)"
              className={`p-1.5 rounded-md transition ${
                canGoForward ? btnBase : "opacity-30 cursor-default"
              }`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={onUp}
              disabled={!canGoUp}
              title="Enclosing Folder (Up / cd ..)"
              className={`p-1.5 rounded-md transition ${
                canGoUp ? btnBase : "opacity-30 cursor-default"
              }`}
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          </div>

          {/* Current Folder Name */}
          <h1
            data-tauri-drag-region
            className="text-[13px] sm:text-[14px] font-semibold tracking-tight truncate ml-1 min-w-0"
          >
            {currentTitle}
          </h1>

          {/* Root Session Privilege Badge / Logo */}
          {isRoot && (
            <div
              data-tauri-drag-region
              title="Root Session (--sudo) • Running with elevated root privileges"
              className={`shrink-0 ml-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wider uppercase shadow-xs ${
                darkMode
                  ? "bg-gradient-to-r from-[#ff453a]/20 via-[#ff6961]/15 to-[#ff9f0a]/20 border-[#ff453a]/45 text-[#ff6961]"
                  : "bg-gradient-to-r from-[#ff453a]/15 to-[#ff9f0a]/15 border-[#ff453a]/40 text-[#d70015]"
              }`}
            >
              <svg
                data-tauri-drag-region
                viewBox="0 0 16 16"
                className="w-3.5 h-3.5 shrink-0"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M8 1.5L2.75 3.75V7.6C2.75 11.05 5.02 13.95 8 14.75C10.98 13.95 13.25 11.05 13.25 7.6V3.75L8 1.5Z"
                  fill="currentColor"
                  fillOpacity="0.22"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinejoin="round"
                />
                <path
                  d="M6.35 5.5L5.65 10.5M10.35 5.5L9.65 10.5M5.1 7.15H10.9M4.85 8.95H10.65"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                />
              </svg>
              <span data-tauri-drag-region>ROOT</span>
            </div>
          )}
        </div>

        {/* Center Section: 4-Way macOS Segmented View Switcher (Horizontally centered via flex-1 balance) */}
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            transform: `translate(calc(-50% + ${viewSwitcherOffset}px), -50%)`,
          }}
          className="absolute left-1/2 top-1/2 z-10 flex items-center justify-center px-1 pointer-events-auto transition-transform duration-300 ease-in-out"
        >
          <div
            className={`flex items-center p-0.5 rounded-lg border ${
              darkMode
                ? "bg-black/30 border-white/10"
                : "bg-black/[0.06] border-black/10"
            }`}
          >
            {(
              [
                { id: "icons", label: " as Icons (Ctrl+1)", icon: LayoutGrid },
                { id: "list", label: "as List (Ctrl+2)", icon: List },
                { id: "columns", label: "as Columns (Ctrl+3)", icon: Columns3 },
                {
                  id: "gallery",
                  label: "as Gallery (Ctrl+4)",
                  icon: GalleryHorizontalEnd,
                },
              ] as const
            ).map(({ id, label, icon: Icon }) => {
              const active = viewMode === id;
              return (
                <button
                  key={id}
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChangeViewMode(id);
                  }}
                  title={`View ${label}`}
                  className={`px-2 sm:px-2.5 py-1 rounded-md transition flex items-center justify-center ${
                    active
                      ? darkMode
                        ? "bg-white/20 text-white shadow-xs"
                        : "bg-white text-zinc-900 shadow-xs"
                      : darkMode
                      ? "text-zinc-400 hover:text-zinc-200"
                      : "text-zinc-600 hover:text-zinc-900"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Section: Quick New Folder, Sort, Action Menu, Downloads, Search */}
        <div
          ref={rightToolbarRef}
          data-tauri-drag-region
          className={`flex-1 flex items-center min-w-0 justify-end pointer-events-auto max-w-full max-[999px]:flex-none max-[999px]:max-w-[55%] ${vscodeControlsOnRight ? "gap-1" : "gap-1.5"}`}
        >
          {/* Quick New Folder button */}
          <button
            onClick={() => onNewFolder()}
            title="New Folder (Ctrl+Shift+N)"
            className={`p-1.5 rounded-md transition shrink-0 ${btnBase}`}
          >
            <FolderPlus className="w-4 h-4" />
          </button>

          {/* Sort Dropdown */}
          <div className="relative" ref={sortRef}>
            <button
              onClick={() => setSortMenuOpen((v) => !v)}
              title="Sort Items By"
              className={`px-2 py-1.5 rounded-md transition flex items-center gap-1 text-xs ${btnBase}`}
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
            </button>
            {sortMenuOpen && (
              <div
                className={`absolute right-0 mt-1.5 w-44 rounded-xl border py-1.5 shadow-xl z-50 backdrop-blur-xl ${
                  darkMode
                    ? "bg-[#2c2c31]/95 border-white/15 text-zinc-100"
                    : "bg-white/95 border-black/10 text-zinc-800"
                }`}
              >
                <div className="px-3 py-1 text-[11px] font-medium opacity-50">
                  Sort By
                </div>
                {(
                  [
                    { id: "name", label: "Name" },
                    { id: "kind", label: "Kind" },
                    { id: "modified", label: "Date Modified" },
                    { id: "size", label: "Size" },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      onChangeSort(item.id);
                      setSortMenuOpen(false);
                    }}
                    className="w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-[#0a84ff] hover:text-white transition"
                  >
                    <span>{item.label}</span>
                    {sortField === item.id && (
                      <span className="text-[10px] font-semibold">
                        {sortDirection === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Action Menu (Ellipsis / Gear) */}
          <div className="relative" ref={actionRef}>
            <button
              onClick={() => setActionMenuOpen((v) => !v)}
              title="Actions & Options"
              className={`p-1.5 rounded-md transition ${btnBase}`}
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
            {actionMenuOpen && (
              <div
                className={`absolute right-0 mt-1.5 w-64 rounded-xl border py-1.5 shadow-xl z-50 backdrop-blur-xl text-xs ${
                  darkMode
                    ? "bg-[#2c2c31]/95 border-white/15 text-zinc-100"
                    : "bg-white/95 border-black/10 text-zinc-800"
                }`}
              >
                <button
                  onClick={() => {
                    onNewFolder();
                    setActionMenuOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 hover:bg-[#0a84ff] hover:text-white"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  <span>New Folder</span>
                  <span className="ml-auto opacity-60 text-[10px]">Ctrl+Shift+N</span>
                </button>
                <button
                  onClick={() => {
                    onNewFile();
                    setActionMenuOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 hover:bg-[#0a84ff] hover:text-white"
                >
                  <FilePlus className="w-3.5 h-3.5" />
                  <span>New Blank File</span>
                </button>
                <button
                  onClick={() => {
                    onGetInfo();
                    setActionMenuOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 hover:bg-[#0a84ff] hover:text-white"
                >
                  <Info className="w-3.5 h-3.5" />
                  <span>Get Info</span>
                  <span className="ml-auto opacity-60 text-[10px]">Ctrl+I</span>
                </button>
                <div
                  className={`my-1 border-t ${
                    darkMode ? "border-white/10" : "border-black/10"
                  }`}
                />
                <button
                  onClick={() => {
                    onToggleHidden();
                    setActionMenuOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 hover:bg-[#0a84ff] hover:text-white"
                >
                  {showHidden ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                  <span>{showHidden ? "Hide Dotfiles" : "Show Dotfiles"}</span>
                  <span className="ml-auto opacity-60 text-[10px]">Ctrl+Shift+.</span>
                </button>
                <button
                  onClick={() => {
                    onRefresh();
                    setActionMenuOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 hover:bg-[#0a84ff] hover:text-white"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Reload Folder</span>
                  <span className="ml-auto opacity-60 text-[10px]">Ctrl+R</span>
                </button>
                <button
                  onClick={() => {
                    onToggleDarkMode();
                    setActionMenuOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 hover:bg-[#0a84ff] hover:text-white"
                >
                  {darkMode ? (
                    <Sun className="w-3.5 h-3.5" />
                  ) : (
                    <Moon className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {darkMode ? "Switch to Light Appearance" : "Switch to Dark Appearance"}
                  </span>
                </button>
                <div className={`my-1 border-t ${darkMode ? "border-white/10" : "border-black/10"}`} />
                <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide opacity-50">
                  Window Controls
                </div>
                <div className="px-3 pb-2">
                  <div className="mb-1.5 opacity-70">Position</div>
                  <div className={`flex rounded-md p-0.5 ${darkMode ? "bg-black/25" : "bg-black/5"}`}>
                    {(["left", "right"] as const).map((side) => (
                      <button
                        key={side}
                        onClick={() => updateWindowControlsSide(side)}
                        className={`flex-1 rounded px-2 py-1 capitalize ${windowControlsSide === side ? darkMode ? "bg-white/15 text-white" : "bg-white text-zinc-900 shadow-sm" : "opacity-70 hover:opacity-100"}`}
                      >
                        {side}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="px-3 pb-1">
                  <div className="mb-1.5 opacity-70">Style</div>
                  <div className={`flex rounded-md p-0.5 ${darkMode ? "bg-black/25" : "bg-black/5"}`}>
                    {([ ["macos", "macOS"], ["vscode", "VS Code"] ] as const).map(([style, label]) => (
                      <button
                        key={style}
                        onClick={() => updateWindowControlsStyle(style)}
                        className={`flex-1 rounded px-2 py-1 ${windowControlsStyle === style ? darkMode ? "bg-white/15 text-white" : "bg-white text-zinc-900 shadow-sm" : "opacity-70 hover:opacity-100"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Recycle Bin / Trash Button */}
          {onOpenTrash && (
            <button
              type="button"
              data-drop-path="__TRASH__"
              data-drop-name="Trash"
              onClick={onOpenTrash}
              title="Trash / Recycle Bin"
              className={`p-1.5 rounded-md transition relative ${btnBase} ${
                dropTargetPath === "__TRASH__"
                  ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/25 text-white"
                  : isTrashActive
                  ? darkMode
                    ? "bg-white/15 text-[#0a84ff]"
                    : "bg-black/10 text-[#0a84ff]"
                  : ""
              }`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}

          {/* Downloads Manager Toggle Button */}
          {onToggleDownloads && (
            <div className="relative">
              <button
                type="button"
                onClick={onToggleDownloads}
                title="Downloads Manager"
                className={`p-1.5 rounded-md transition relative ${btnBase} ${
                  downloadsOpen ? "bg-black/15 dark:bg-white/15" : ""
                }`}
              >
                <Download className="w-4 h-4" />
                {activeDownloadsCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#0a84ff] text-[9px] text-white font-bold flex items-center justify-center shadow-sm animate-pulse">
                    {activeDownloadsCount}
                  </span>
                )}
              </button>
            </div>
          )}

          {/* Spotlight-style Search Field */}
          <div
            className={`relative flex items-center rounded-lg border px-2.5 py-1 ${vscodeControlsOnRight ? "w-20 sm:w-24 lg:w-28 focus-within:w-20 sm:focus-within:w-24 lg:focus-within:w-28" : "w-28 sm:w-36 lg:w-44 focus-within:w-40 sm:focus-within:w-48 lg:focus-within:w-56"} transition-all shrink-0 ${
              darkMode
                ? "bg-black/25 border-white/10 focus-within:border-[#0a84ff]"
                : "bg-black/[0.05] border-black/10 focus-within:border-[#0a84ff]"
            }`}
          >
            <Search className="w-3.5 h-3.5 opacity-50 mr-1.5 shrink-0" />
            <input
              data-file-search
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search"
              className="bg-transparent text-xs outline-none w-full placeholder:opacity-50"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange("")}
                className="ml-1 opacity-60 hover:opacity-100"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {windowControlsSide === "right" && windowControls}
        </div>
      </div>

      {/* macOS Finder Multi-Tab Strip (shown when > 1 tab or via + button) */}
      <div
        onDragStart={(e) => e.preventDefault()}
        role="tablist"
        aria-label="Open folders"
        onPointerMove={moveTabDrag}
        onPointerUp={finishTabDrag}
        onPointerCancel={cancelTabDrag}
        onClick={handleTabStripClick}
        style={{ paddingLeft: `${12 + tabStripStartOffset}px` }}
        className={`relative z-10 flex items-end h-10 px-3 gap-1 text-xs border-t overflow-visible ${
          darkMode
            ? "bg-[#202024] border-white/5"
            : "bg-[#f2f2f5] border-black/5"
        }`}
      >
        <div
          className={`flex h-[calc(100%+2px)] min-w-0 self-start items-end gap-3 overflow-x-auto px-3.5 -mx-3.5 pb-[2px] ${splitTab ? "w-1/2 shrink-0" : "w-full"}`}
          style={
            splitTab && splitTabLeft !== null
              ? {
                  width: `${Math.max(
                    0,
                    splitTabLeft - 12 - tabStripStartOffset
                  )}px`,
                }
              : undefined
          }
        >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isArchiveWorkspace = isInsideArchiveWorkspace(
            tab.path,
            tab.archiveWorkspaceRoot
          );
          const canDrop = !tab.activeTag && tab.path !== "__RECENTS__";
          const isDropTarget = canDrop && dropTargetPath === tab.path;
          return (
            <div
              key={tab.id}
              ref={(element) => {
                if (element) tabElementsRef.current.set(tab.id, element);
                else tabElementsRef.current.delete(tab.id);
              }}
              data-tab-id={tab.id}
              data-drop-path={canDrop ? tab.path : undefined}
              data-drop-name={canDrop ? tab.title : undefined}
              onPointerDown={(e) => startTabDrag(e, tab)}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`group relative flex min-w-[88px] flex-[1_1_220px] items-center gap-1.5 pl-3 pr-1.5 h-8 rounded-t-2xl rounded-b-none ${isActive ? `workspace-tab-active ${darkMode ? (isArchiveWorkspace ? "workspace-tab-active-archive-dark" : "workspace-tab-active-dark") : (isArchiveWorkspace ? "workspace-tab-active-archive-light" : "workspace-tab-active-light")} z-20 translate-y-[2px]` : "translate-y-[1px]"} ${draggingTabId === tab.id ? "cursor-grabbing opacity-30" : "cursor-default"} transition-colors duration-150 max-w-[260px] border select-none ${
                isDropTarget
                  ? "border-[#0a84ff]/70 bg-[#0a84ff]/20 text-white shadow-sm"
                  : isActive
                  ? darkMode
                    ? isArchiveWorkspace
                      ? "border-[#4f4c71] border-b-0 bg-[#29273a] text-white"
                      : "border-[#36363a] border-b-0 bg-[#202024] text-white"
                    : isArchiveWorkspace
                      ? "border-[#cecbe7] border-b-0 bg-[#efedf8] text-zinc-900"
                      : "border-[#dadadd] border-b-0 bg-[#f2f2f5] text-zinc-900"
                  : darkMode
                  ? isArchiveWorkspace
                    ? "border-[#9692D6]/10 bg-[#9692D6]/[0.07] text-zinc-300 hover:bg-[#9692D6]/[0.13] hover:text-zinc-100"
                    : "border-transparent bg-white/[0.035] text-zinc-400 hover:bg-white/[0.075] hover:text-zinc-100"
                  : isArchiveWorkspace
                    ? "border-[#807bc0]/10 bg-[#807bc0]/[0.06] text-zinc-600 hover:bg-[#807bc0]/[0.12] hover:text-zinc-900"
                    : "border-transparent bg-black/[0.025] text-zinc-600 hover:bg-white/75 hover:text-zinc-900"
              }`}
            >
              {isArchiveWorkspace ? (
                <ArchiveZipperMark
                  className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-[#a6a0ef]" : "opacity-70"}`}
                />
              ) : tab.path === "__TRASH__" ? (
                <Trash2
                  className={`w-3.5 h-3.5 shrink-0 ${
                    isActive ? "text-[#0a84ff]" : "opacity-65"
                  }`}
                />
              ) : (
                <Folder
                  className={`w-3.5 h-3.5 shrink-0 ${
                    isActive ? "text-[#0a84ff]" : "opacity-65"
                  }`}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{tab.title}</span>
              {canSplitTab && !splitTab ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    splitTabToRight(tab);
                  }}
                  title={`Move ${tab.title} to the right pane`}
                  aria-label={`Move ${tab.title} to split view`}
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors ${
                    isActive
                      ? "opacity-65 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-75 focus-visible:opacity-100"
                  } hover:bg-black/10 dark:hover:bg-white/10`}
                >
                  <Columns2 className="h-3 w-3" />
                </button>
              ) : (
                <span aria-hidden="true" className="h-5 w-5 shrink-0" />
              )}
              <button
                type="button"
                disabled={tabs.length <= 1}
                aria-hidden={tabs.length <= 1}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title={tabs.length > 1 ? `Close ${tab.title}` : undefined}
                aria-label={`Close ${tab.title}`}
                className={`shrink-0 p-1 rounded-md transition-colors ${
                  tabs.length <= 1
                    ? "invisible pointer-events-none"
                    : isActive
                    ? "opacity-60 hover:opacity-100"
                    : "opacity-0 group-hover:opacity-80 focus-visible:opacity-100"
                } hover:bg-black/10 dark:hover:bg-white/10`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
        {dragPreview && (
          <div
            aria-hidden="true"
            className={`pointer-events-none fixed z-[9999] flex h-8 items-center gap-2 rounded-t-xl rounded-b-none border px-3 shadow-xl scale-[1.03] ${
              darkMode
                ? "border-white/15 bg-[#38383e] text-white"
                : "border-black/10 bg-white text-zinc-900"
            }`}
            style={{
              left: dragPreview.left,
              top: dragPreview.top,
              width: dragPreview.width,
              cursor: "grabbing",
            }}
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-[#0a84ff]" />
            <span className="truncate text-[11px] font-medium">{dragPreview.tab.title}</span>
          </div>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNewTab();
          }}
          title="New Tab (Ctrl+T)"
          aria-label="New tab"
          className={`flex items-center justify-center w-7 h-7 mb-0.5 ml-0.5 rounded-full shrink-0 cursor-pointer transition-colors ${
            darkMode
              ? "text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
              : "text-zinc-600 hover:bg-black/[0.06] hover:text-zinc-900"
          }`}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        </div>
        {splitTab && splitTabLeft !== null && (
          (() => {
            const splitIsArchiveWorkspace = isInsideArchiveWorkspace(
              splitTab.path,
              splitTab.archiveWorkspaceRoot
            );
            return (
          <div
            className="absolute bottom-0 top-0 z-20 flex items-end pl-3"
            style={{ left: `${splitTabLeft}px`, right: 0 }}
          >
            <div
              ref={splitTabElementRef}
              key={splitTab.id}
              className={`workspace-tab-active ${darkMode ? (splitIsArchiveWorkspace ? "workspace-tab-active-archive-dark" : "workspace-tab-active-dark") : (splitIsArchiveWorkspace ? "workspace-tab-active-archive-light" : "workspace-tab-active-light")} group relative z-20 flex h-8 min-w-[88px] flex-[1_1_220px] max-w-[260px] translate-y-[2px] items-center gap-1.5 rounded-t-2xl rounded-b-none border pl-3 pr-1.5 text-[11px] font-medium ${
                darkMode
                  ? splitIsArchiveWorkspace
                    ? "border-[#4f4c71] border-b-0 bg-[#29273a] text-white"
                    : "border-[#36363a] border-b-0 bg-[#202024] text-white"
                  : splitIsArchiveWorkspace
                    ? "border-[#cecbe7] border-b-0 bg-[#efedf8] text-zinc-900"
                    : "border-[#dadadd] border-b-0 bg-[#f2f2f5] text-zinc-900"
              }`}
              role="tab"
              aria-selected="true"
              title={splitTab.title}
            >
              {splitIsArchiveWorkspace ? (
                <ArchiveZipperMark className="h-3.5 w-3.5 shrink-0 text-[#a6a0ef]" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-[#0a84ff]" />
              )}
              <span className="min-w-0 flex-1 truncate">{splitTab.title}</span>
              <span aria-hidden="true" className="h-5 w-5 shrink-0" />
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseSplitPane();
                }}
                title={`Close ${splitTab.title}`}
                aria-label={`Close ${splitTab.title}`}
                className="shrink-0 rounded-md p-1 opacity-60 transition-colors hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
            );
          })()
        )}
      </div>
    </div>
  );
};
