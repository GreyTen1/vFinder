import React, { useState, useRef, useEffect } from "react";
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
  Check,
  RefreshCw,
  Download,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FinderTab, SortDirection, SortField, ViewMode } from "../types";

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
  onSelectTab: (id: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  dropTargetPath?: string | null;
  activeDownloadsCount?: number;
  onToggleDownloads?: () => void;
  downloadsOpen?: boolean;
}

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
  onSelectTab,
  onNewTab,
  onCloseTab,
  dropTargetPath,
  activeDownloadsCount = 0,
  onToggleDownloads,
  downloadsOpen = false,
}) => {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);

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

  return (
    <div
      className={`macos-layer-isolate relative z-30 flex flex-col border-b select-none ${
        darkMode
          ? "bg-[#252529]/95 border-white/10 text-zinc-100"
          : "bg-[#f3f3f6]/95 border-black/10 text-zinc-800"
      }`}
    >
      {/* Unified macOS Finder Header Bar */}
      <div
        data-tauri-drag-region
        className="relative h-[52px] px-3.5 flex items-center justify-between gap-2 overflow-visible"
      >
        {/* Left Section: Traffic Lights + Sidebar Toggle + Back/Forward/Up + Folder Title */}
        <div
          data-tauri-drag-region
          className="flex-1 flex items-center gap-2 min-w-0 justify-start"
        >
          {/* Authentic macOS Traffic Lights */}
          <div className="group flex items-center gap-2 mr-2 shrink-0">
            <button
              onClick={handleCloseWindow}
              title="Close Window"
              className="w-3 h-3 rounded-full bg-[#ff5f57] border border-[#e0443e] flex items-center justify-center hover:opacity-90 cursor-pointer p-0"
            >
              <svg
                viewBox="0 0 12 12"
                className="w-2 h-2 text-black/80 opacity-0 group-hover:opacity-100 pointer-events-none"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              >
                <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" />
              </svg>
            </button>
            <button
              onClick={handleMinimizeWindow}
              title="Minimize Window"
              className="w-3 h-3 rounded-full bg-[#febc2e] border border-[#d89e24] flex items-center justify-center hover:opacity-90 cursor-pointer p-0"
            >
              <svg
                viewBox="0 0 12 12"
                className="w-2 h-2 text-black/80 opacity-0 group-hover:opacity-100 pointer-events-none"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              >
                <path d="M2.5 6H9.5" />
              </svg>
            </button>
            <button
              onClick={handleMaximizeWindow}
              title="Zoom / Full Screen"
              className="w-3 h-3 rounded-full bg-[#28c840] border border-[#1aab29] flex items-center justify-center hover:opacity-90 cursor-pointer p-0"
            >
              <svg
                viewBox="0 0 12 12"
                className="w-2 h-2 text-black/80 opacity-0 group-hover:opacity-100 pointer-events-none"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              >
                <path d="M6 2.5V9.5M2.5 6H9.5" />
              </svg>
            </button>
          </div>

          {/* Sidebar Toggle */}
          <button
            onClick={onToggleSidebar}
            title={sidebarOpen ? "Hide Sidebar (Cmd+Option+S)" : "Show Sidebar (Cmd+Option+S)"}
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
        </div>

        {/* Center Section: 4-Way macOS Segmented View Switcher (Horizontally centered via flex-1 balance) */}
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="flex shrink-0 items-center justify-center px-1 pointer-events-auto"
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
          onMouseDown={(e) => e.stopPropagation()}
          className="flex-1 flex items-center gap-1.5 min-w-0 justify-end pointer-events-auto"
        >
          {/* Quick New Folder button */}
          <button
            onClick={onNewFolder}
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
                className={`absolute right-0 mt-1.5 w-56 rounded-xl border py-1.5 shadow-xl z-50 backdrop-blur-xl text-xs ${
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
                  <span className="ml-auto opacity-60 text-[10px]">Super+Shift+N</span>
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
                  <span className="ml-auto opacity-60 text-[10px]">Super+I</span>
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
                  <span className="ml-auto opacity-60 text-[10px]">Super+Shift+.</span>
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
                  <span className="ml-auto opacity-60 text-[10px]">Super+R</span>
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
              </div>
            )}
          </div>

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
            className={`relative flex items-center rounded-lg border px-2.5 py-1 w-28 sm:w-36 lg:w-44 focus-within:w-40 sm:focus-within:w-48 lg:focus-within:w-56 transition-all shrink-0 ${
              darkMode
                ? "bg-black/25 border-white/10 focus-within:border-[#0a84ff]"
                : "bg-black/[0.05] border-black/10 focus-within:border-[#0a84ff]"
            }`}
          >
            <Search className="w-3.5 h-3.5 opacity-50 mr-1.5 shrink-0" />
            <input
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
        </div>
      </div>

      {/* macOS Finder Multi-Tab Strip (shown when > 1 tab or via + button) */}
      <div
        onDragStart={(e) => e.preventDefault()}
        className={`flex items-center h-7 px-2 gap-1 text-xs border-t overflow-x-auto ${
          darkMode
            ? "bg-[#1c1c1f]/90 border-white/5"
            : "bg-[#e5e5ea]/90 border-black/5"
        }`}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const canDrop = !tab.activeTag && tab.path !== "__RECENTS__";
          const isDropTarget = canDrop && dropTargetPath === tab.path;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              data-drop-path={canDrop ? tab.path : undefined}
              data-drop-name={canDrop ? tab.title : undefined}
              onClick={() => onSelectTab(tab.id)}
              className={`group flex items-center gap-2 px-3 h-5.5 rounded-md cursor-pointer transition max-w-[200px] ${
                isDropTarget
                  ? "ring-2 ring-[#0a84ff] bg-[#0a84ff]/30 text-white"
                  : isActive
                  ? darkMode
                    ? "bg-[#323237] text-white shadow-xs"
                    : "bg-white text-zinc-900 shadow-xs"
                  : "opacity-65 hover:opacity-100"
              }`}
            >
              <span className="truncate text-[11px] font-medium">{tab.title}</span>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="opacity-0 group-hover:opacity-80 hover:opacity-100 p-0.5 rounded"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNewTab();
          }}
          title="New Tab (Ctrl+T)"
          className="p-1 rounded opacity-60 hover:opacity-100 transition ml-0.5 shrink-0 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
