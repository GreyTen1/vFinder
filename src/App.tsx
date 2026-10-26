import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Archive, Loader2, Trash2, RotateCcw, AlertTriangle } from "lucide-react";
import {
  ClipboardState,
  FileEntry,
  FinderTab,
  SidebarData,
  SortDirection,
  SortField,
  ViewMode,
  VolumeInfo,
  DownloadItem,
  DownloadProgressPayload,
  DownloadCompletedPayload,
  DownloadFailedPayload,
  InterceptedDownload,
} from "./types";
import {
  apiArmExternalDrag,
  apiCheckFinderDrag,
  apiCheckPartition,
  apiCompressItems,
  apiCopyItems,
  apiCreateDirectory,
  apiCreateFile,
  apiDisarmExternalDrag,
  apiDuplicateItem,
  apiFormatPartition,
  apiGetFileInfo,
  apiSetFileExecutable,
  apiGetFilesByTag,
  apiGetSidebarData,
  apiGetStartupDirectory,
  apiGetStartupSelection,
  apiElevateToRootSession,
  apiFileManagerFrontendReady,
  apiTakeFileManagerRequests,
  apiExtractArchive,
  apiMountPartition,
  apiMoveItems,
  apiOpenItem,
  apiOpenItemWith,
  apiPrefetchDirectories,
  apiReadDirectory,
  apiRenameItem,
  apiSaveDroppedUrls,
  apiSearchDirectory,
  apiSetDefaultApp,
  apiShowMainWindow,
  apiCloseMainWindow,
  apiToggleItemTag,
  apiTrashItems,
  apiGetTrashFiles,
  apiRestoreTrashItems,
  apiDeleteTrashItemsPermanently,
  apiEmptyTrash,
  apiUnmountPartition,
  apiStartDownload,
  apiCancelDownload,
  apiGetDefaultDownloadsDir,
  apiGetPendingDownloads,
} from "./api";
import { Toolbar } from "./components/Toolbar";
import { SplitExplorerPane } from "./components/SplitExplorerPane";
import { Sidebar } from "./components/Sidebar";
import { FileIcon } from "./components/FileIcon";
import {
  ColumnView,
  GalleryView,
  IconView,
  ListView,
  SelectionModifiers,
} from "./components/Views";
import {
  BottomBars,
  ContextMenu,
  ContextMenuState,
  FirstAidModal,
  FormatModal,
  GetInfoModal,
  OpenWithModal,
  QuickLookModal,
  SudoPromptModal,
  SudoPromptState,
} from "./components/ModalsAndMenus";
import {
  DownloadsPopover,
  DownloadSaveBar,
} from "./components/DownloadModals";

const FAST_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function areEntriesEqual(a: FileEntry[], b: FileEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.path !== y.path ||
      x.modified !== y.modified ||
      x.size !== y.size ||
      x.defaultApp !== y.defaultApp ||
      x.tags.length !== y.tags.length
    ) {
      return false;
    }
    for (let t = 0; t < x.tags.length; t++) {
      if (x.tags[t] !== y.tags[t]) return false;
    }
  }
  return true;
}

function folderDisplayName(path: string, rootName = "Linux"): string {
  if (path === "__RECENTS__") return "Recents";
  if (path === "__TRASH__") return "Trash";
  if (path === "/" || path === "") return rootName;
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function getParentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

interface ActiveDragState {
  paths: string[];
  primaryEntry: FileEntry;
  hasDirs: boolean;
  x: number;
  y: number;
  isCopy: boolean;
  dropTargetPath: string | null;
  dropTargetName: string | null;
  dropTargetTag: string | null;
  dropTargetTagName: string | null;
  dropFavoriteZone: boolean;
}

interface MoveUndoAction {
  items: Array<{ movedPath: string; originalParent: string }>;
}

const DEFAULT_ZOOM_BY_VIEW: Record<ViewMode, number> = {
  icons: 64,
  list: 64,
  columns: 64,
  gallery: 64,
};

function getInitialFinderTab(): FinderTab {
  const params = new URLSearchParams(window.location.search);
  if (params.get("vfinder_detached") !== "1") {
    return {
      id: "tab-1",
      title: "Home",
      path: "",
      history: [""],
      historyIndex: 0,
      activeTag: null,
    };
  }

  const path = params.get("vfinder_path") || "";
  return {
    id: "tab-1",
    title: params.get("vfinder_title") || folderDisplayName(path),
    path,
    history: [path],
    historyIndex: 0,
    activeTag: params.get("vfinder_tag"),
  };
}

export const App: React.FC = () => {
  const [sidebarData, setSidebarData] = useState<SidebarData | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarLayoutOpen, setSidebarLayoutOpen] = useState(true);
  const sidebarCollapseTimerRef = useRef<number | null>(null);
  const sidebarExpandFrameRef = useRef<number | null>(null);
  const finishSidebarCollapse = useCallback(() => {
    if (sidebarOpen) return;
    if (sidebarCollapseTimerRef.current !== null) {
      window.clearTimeout(sidebarCollapseTimerRef.current);
      sidebarCollapseTimerRef.current = null;
    }
    setSidebarLayoutOpen(false);
  }, [sidebarOpen]);
  const toggleSidebar = useCallback(() => {
    if (sidebarCollapseTimerRef.current !== null) {
      window.clearTimeout(sidebarCollapseTimerRef.current);
      sidebarCollapseTimerRef.current = null;
    }
    if (sidebarExpandFrameRef.current !== null) {
      cancelAnimationFrame(sidebarExpandFrameRef.current);
      sidebarExpandFrameRef.current = null;
    }
    if (sidebarOpen) {
      setSidebarOpen(false);
      sidebarCollapseTimerRef.current = window.setTimeout(() => {
        setSidebarLayoutOpen(false);
        sidebarCollapseTimerRef.current = null;
      }, 320);
    } else {
      setSidebarLayoutOpen(true);
      sidebarExpandFrameRef.current = requestAnimationFrame(() => {
        setSidebarOpen(true);
        sidebarExpandFrameRef.current = null;
      });
    }
  }, [sidebarOpen]);

  useEffect(
    () => () => {
      if (sidebarCollapseTimerRef.current !== null) {
        window.clearTimeout(sidebarCollapseTimerRef.current);
      }
      if (sidebarExpandFrameRef.current !== null) {
        cancelAnimationFrame(sidebarExpandFrameRef.current);
      }
    },
    []
  );
  const [darkMode, setDarkMode] = useState(true);

  const [tabs, setTabs] = useState<FinderTab[]>(() => [getInitialFinderTab()]);
  const [activeTabId, setActiveTabId] = useState("tab-1");
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const tabScrollPositionsRef = useRef(
    new Map<string, { top: number; left: number }>()
  );
  const restoringTabScrollRef = useRef(false);
  const [splitPane, setSplitPane] = useState<{
    tabId: string;
    path: string;
    title: string;
    activeTag: string | null;
    archiveWorkspaceRoot?: string;
    key: number;
  } | null>(null);
  const splitPaneHoveredRef = useRef(false);
  const splitPaneSelectedPathsRef = useRef<string[]>([]);
  const splitPaneSelectAllRef = useRef<(() => void) | null>(null);
  const closeSplitPane = useCallback(() => {
    splitPaneHoveredRef.current = false;
    splitPaneSelectedPathsRef.current = [];
    splitPaneSelectAllRef.current = null;
    setSplitPane(null);
  }, []);
  const appShellRef = useRef<HTMLDivElement>(null);
  const primaryPaneRef = useRef<HTMLDivElement>(null);
  const splitContentRef = useRef<HTMLDivElement>(null);
  const previousSplitContentWidthRef = useRef<number | null>(null);
  const [splitTabLeft, setSplitTabLeft] = useState<number | null>(null);
  const [splitPaneRatio, setSplitPaneRatio] = useState(0.5);
  const [splitPaneRefreshVersion, setSplitPaneRefreshVersion] = useState(0);

  const handleSplitResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = splitContentRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    const minRatio = Math.min(0.5, 280 / bounds.width);
    const rightRatio = (bounds.right - event.clientX) / bounds.width;
    const nextRatio = Math.max(minRatio, Math.min(1 - minRatio, rightRatio));
    setSplitPaneRatio(nextRatio);
    const shell = appShellRef.current;
    if (shell) {
      const dividerX = bounds.right - nextRatio * bounds.width;
      const left = dividerX - shell.getBoundingClientRect().left - shell.clientLeft;
      setSplitTabLeft(left);
    }
  };

  useLayoutEffect(() => {
    if (!splitPane) {
      setSplitTabLeft(null);
      previousSplitContentWidthRef.current = null;
      return;
    }

    const content = splitContentRef.current;
    if (!content) return;
    const currentWidth = content.getBoundingClientRect().width;
    const previousWidth = previousSplitContentWidthRef.current;
    if (previousWidth !== null && Math.abs(previousWidth - currentWidth) > 1) {
      // Keep the right pane's pixel width when the sidebar changes the
      // workspace origin/width, which keeps its tab aligned on screen.
      const rightWidth = previousWidth * splitPaneRatio;
      const minRatio = Math.min(0.5, 280 / currentWidth);
      const nextRatio = Math.max(
        minRatio,
        Math.min(1 - minRatio, rightWidth / currentWidth)
      );
      setSplitPaneRatio(nextRatio);
    }
    previousSplitContentWidthRef.current = currentWidth;

    const updateSplitTabAlignment = () => {
      const shell = appShellRef.current;
      const primaryPane = primaryPaneRef.current;
      if (!shell || !primaryPane) return;
      const left =
        primaryPane.getBoundingClientRect().right -
        shell.getBoundingClientRect().left -
        shell.clientLeft;
      setSplitTabLeft((current) =>
        current !== null && Math.abs(current - left) < 0.5 ? current : left
      );
    };

    updateSplitTabAlignment();
    const observer = new ResizeObserver(updateSplitTabAlignment);
    if (appShellRef.current) observer.observe(appShellRef.current);
    if (primaryPaneRef.current) observer.observe(primaryPaneRef.current);
    const contentObserver = new ResizeObserver(() => {
      const width = splitContentRef.current?.getBoundingClientRect().width;
      if (width && width > 0) previousSplitContentWidthRef.current = width;
    });
    contentObserver.observe(content);
    window.addEventListener("resize", updateSplitTabAlignment);
    return () => {
      observer.disconnect();
      contentObserver.disconnect();
      window.removeEventListener("resize", updateSplitTabAlignment);
    };
  }, [Boolean(splitPane), sidebarLayoutOpen, splitPaneRatio]);

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [entriesLoadedPath, setEntriesLoadedPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const lastSelectedPathRef = useRef<string | null>(null);
  const selectedPathsRef = useRef<string[]>([]);
  selectedPathsRef.current = selectedPaths;

  const [favoriteViewModes, setFavoriteViewModes] = useState<
    Record<string, ViewMode>
  >(() => {
    try {
      const saved = localStorage.getItem("finder-favorite-view-modes");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return {};
  });

  const favoriteViewModesRef =
    useRef<Record<string, ViewMode>>(favoriteViewModes);
  favoriteViewModesRef.current = favoriteViewModes;

  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem("finder-view-mode");
      if (saved === "icons" || saved === "list" || saved === "columns" || saved === "gallery") {
        return saved;
      }
    } catch {
      // ignore
    }
    return "icons";
  });

  const viewModeRef = useRef<ViewMode>(viewMode);
  viewModeRef.current = viewMode;

  const [zoomByView, setZoomByView] = useState<Record<ViewMode, number>>(() => {
    try {
      const saved = localStorage.getItem("finder-zoom-selections");
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          icons:
            typeof parsed.icons === "number"
              ? Math.max(40, Math.min(144, parsed.icons))
              : 64,
          list:
            typeof parsed.list === "number"
              ? Math.max(40, Math.min(144, parsed.list))
              : 64,
          columns:
            typeof parsed.columns === "number"
              ? Math.max(40, Math.min(144, parsed.columns))
              : 64,
          gallery:
            typeof parsed.gallery === "number"
              ? Math.max(40, Math.min(144, parsed.gallery))
              : 64,
        };
      }
    } catch {
      // ignore
    }
    return DEFAULT_ZOOM_BY_VIEW;
  });

  const iconSize = zoomByView[viewMode] ?? 64;

  const setIconSize = useCallback(
    (updater: number | ((prev: number) => number)) => {
      const mode = viewModeRef.current;
      setZoomByView((prevMap) => {
        const current = prevMap[mode] ?? 64;
        const rawNext =
          typeof updater === "function" ? updater(current) : updater;
        const next = Math.max(40, Math.min(144, rawNext));
        const updated = { ...prevMap, [mode]: next };
        try {
          localStorage.setItem(
            "finder-zoom-selections",
            JSON.stringify(updated)
          );
        } catch {
          // ignore
        }
        return updated;
      });
    },
    []
  );

  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [showHidden, setShowHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);


  useEffect(() => {
    if (!searchQuery.trim()) {
      setDebouncedSearchQuery("");
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 160);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Inline rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameCommitPathRef = useRef<string | null>(null);

  // Active Drag & Drop state
  const [dragState, setDragState] = useState<ActiveDragState | null>(null);
  const [externalDropInfo, setExternalDropInfo] = useState<{
    targetPath: string;
    targetName: string;
    isSpecificFolder: boolean;
    isMove?: boolean;
  } | null>(null);
  const cancelInternalDragRef = useRef<(() => void) | null>(null);
  const outboundDragActiveRef = useRef(false);
  const lastOutboundDragEndRef = useRef(0);
  const lastUrlDropTimeRef = useRef(0);

  // Modals & menus
  const [quickLookEntry, setQuickLookEntry] = useState<FileEntry | null>(null);
  const [getInfoEntry, setGetInfoEntry] = useState<FileEntry | null>(null);
  const [getInfoVolume, setGetInfoVolume] = useState<VolumeInfo | null>(null);
  const [openWithEntry, setOpenWithEntry] = useState<FileEntry | null>(null);
  const [formatVolume, setFormatVolume] = useState<VolumeInfo | null>(null);
  const [firstAidVolume, setFirstAidVolume] = useState<VolumeInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeOperations, setActiveOperations] = useState<Array<{ id: number; label: string }>>([]);
  const [openingArchive, setOpeningArchive] = useState<string | null>(null);
  const operationIdRef = useRef(0);
  const [columnActivePath, setColumnActivePath] = useState<string | null>(null);
  const columnActivePathRef = useRef<string | null>(null);
  columnActivePathRef.current = columnActivePath;
  const [sudoPrompt, setSudoPrompt] = useState<SudoPromptState | null>(null);
  const [trashConfirmModal, setTrashConfirmModal] = useState<{
    mode: "empty" | "delete-selected";
    paths?: string[];
    count: number;
  } | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const undoStackRef = useRef<MoveUndoAction[]>([]);
  const undoInProgressRef = useRef(false);
  const [toast, setToast] = useState<string | null>(null);

  const runWithActivity = useCallback(async <T,>(
    label: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const id = ++operationIdRef.current;
    const revealTimer = window.setTimeout(() => {
      setActiveOperations((current) => [...current, { id, label }]);
    }, 180);
    try {
      return await operation();
    } finally {
      window.clearTimeout(revealTimer);
      setActiveOperations((current) => current.filter((item) => item.id !== id));
    }
  }, []);

  // Download Manager state
  const [downloadQueue, setDownloadQueue] = useState<InterceptedDownload[]>([]);
  const pendingDownload = downloadQueue.length > 0 ? downloadQueue[0] : null;
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [downloadsPopoverOpen, setDownloadsPopoverOpen] = useState(false);
  const [defaultDownloadsDir, setDefaultDownloadsDir] = useState<string>("");

  const enqueueDownload = useCallback((item: InterceptedDownload) => {
    setDownloadQueue((prev) => {
      if (prev.some((d) => d.id === item.id)) return prev;
      return [...prev, item];
    });
  }, []);

  useEffect(() => {
    void apiGetDefaultDownloadsDir()
      .then((dir) => {
        if (dir) setDefaultDownloadsDir(dir);
      })
      .catch(() => {});
  }, []);

  const [customFavorites, setCustomFavorites] = useState<
    { name: string; path: string }[]
  >(() => {
    try {
      const saved = localStorage.getItem("finder-custom-favorites");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [hiddenFavorites, setHiddenFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("finder-hidden-favorites");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // In-memory directory cache for 0ms instant folder switching
  const dirCacheRef = useRef<Map<string, FileEntry[]>>(new Map());
  const requestIdRef = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 2800);
  }, []);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) || tabs[0],
    [tabs, activeTabId]
  );
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [pendingFileManagerReveal, setPendingFileManagerReveal] = useState<{
    directory: string;
    selectedPaths: string[];
    showProperties?: boolean;
  } | null>(null);
  const pendingFileManagerRevealRef = useRef(pendingFileManagerReveal);
  pendingFileManagerRevealRef.current = pendingFileManagerReveal;
  const [pendingRevealScrollPath, setPendingRevealScrollPath] = useState<string | null>(null);

  const isFavoritePath = useCallback(
    (p: string) => {
      if (!p) return false;
      if (sidebarData?.favorites?.some((f) => f.path === p)) return true;
      if (customFavorites.some((cf) => cf.path === p)) return true;
      return false;
    },
    [sidebarData?.favorites, customFavorites]
  );
  const isFavoritePathRef = useRef(isFavoritePath);
  isFavoritePathRef.current = isFavoritePath;

  const saveFavoriteViewMode = useCallback((path: string, mode: ViewMode) => {
    setFavoriteViewModes((prev) => {
      if (prev[path] === mode) return prev;
      const updated = { ...prev, [path]: mode };
      favoriteViewModesRef.current = updated;
      try {
        localStorage.setItem(
          "finder-favorite-view-modes",
          JSON.stringify(updated)
        );
      } catch {
        // ignore
      }
      return updated;
    });
  }, []);

  const applyFavoriteViewModeIfPinned = useCallback((path: string) => {
    if (isFavoritePathRef.current(path)) {
      const remembered = favoriteViewModesRef.current[path] || "icons";
      if (viewModeRef.current !== remembered) {
        viewModeRef.current = remembered;
        setViewModeState(remembered);
      }
    }
  }, []);

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      if (viewModeRef.current !== mode) {
        viewModeRef.current = mode;
        setViewModeState(mode);
      }
      try {
        localStorage.setItem("finder-view-mode", mode);
      } catch {
        // ignore
      }
      const curTab = activeTabRef.current;
      if (curTab && !curTab.activeTag && isFavoritePathRef.current(curTab.path)) {
        saveFavoriteViewMode(curTab.path, mode);
      }
    },
    [saveFavoriteViewMode]
  );

  const [entriesReady, setEntriesReady] = useState(false);
  const windowShownRef = useRef(false);
  const prefetchingPathsRef = useRef<Set<string>>(new Set());

  const handlePrefetchPath = useCallback(
    (path: string) => {
      if (!path) return;
      const cacheKey = `${path}::${showHidden}::`;
      if (
        dirCacheRef.current.has(cacheKey) ||
        prefetchingPathsRef.current.has(cacheKey)
      ) {
        return;
      }
      prefetchingPathsRef.current.add(cacheKey);
      apiReadDirectory(path, showHidden)
        .then((list) => {
          dirCacheRef.current.set(cacheKey, list);
        })
        .catch(() => {
          // ignore background prefetch errors
        })
        .finally(() => {
          prefetchingPathsRef.current.delete(cacheKey);
        });
    },
    [showHidden]
  );

  const applyCachedEntriesIfAvailable = useCallback(
    (targetPath: string, targetTag: string | null = null) => {
      const cacheKey = `${targetTag || targetPath}::${showHidden}::`;
      const cached = dirCacheRef.current.get(cacheKey);
      if (cached) {
        setEntries((prev) => (areEntriesEqual(prev, cached) ? prev : cached));
      }
    },
    [showHidden]
  );

  // Initial sidebar load (does not reset tabs if path already matches homeDir)
  const refreshSidebar = useCallback(async () => {
    try {
      const data = await apiGetSidebarData();
      setSidebarData(data);
      return data;
    } catch (err) {
      showToast(`Failed to load sidebar: ${err}`);
      return null;
    }
  }, [showToast]);

  useEffect(() => {
    Promise.all([
      refreshSidebar(),
      apiGetStartupDirectory(),
      apiGetStartupSelection(),
    ]).then(([data, startupDirectory, startupSelection]) => {
      if (data?.needsSudoElevation) {
        setSudoPrompt({
          action: "elevate",
          volumeName: "vFinder",
          device: "root",
          error: null,
          busy: false,
        });
      }
      if (data?.homeDir) {
        if (startupSelection && startupDirectory) {
          setPendingFileManagerReveal({
            directory: startupDirectory,
            selectedPaths: [startupSelection],
          });
        }
        setTabs((prev) => {
          if (
            prev.length === 1 &&
            (prev[0].path === "" ||
              prev[0].path === "~" ||
              prev[0].path === data.homeDir) &&
            !prev[0].activeTag
          ) {
            const initialPath = startupDirectory || data.homeDir;
            return [
              {
                id: prev[0].id || "tab-1",
                title: startupDirectory ? folderDisplayName(startupDirectory) : "Home",
                path: initialPath,
                history: [initialPath],
                historyIndex: 0,
                activeTag: null,
              },
            ];
          }
          return prev;
        });
      }
    });
  }, [refreshSidebar]);

  // Pre-warm all favorite folders in the background once initial entries are ready
  useEffect(() => {
    if (!entriesReady) return;
    const favPaths = new Set<string>();
    for (const fav of sidebarData?.favorites || []) {
      if (fav.path && !hiddenFavorites.includes(fav.path)) {
        favPaths.add(fav.path);
      }
    }
    for (const cf of customFavorites) {
      if (cf.path) favPaths.add(cf.path);
    }

    const uncachedPaths = Array.from(favPaths).filter((p) => {
      const key = `${p}::${showHidden}::`;
      return (
        !dirCacheRef.current.has(key) && !prefetchingPathsRef.current.has(key)
      );
    });
    if (uncachedPaths.length === 0) return;

    const timer = window.setTimeout(() => {
      for (const p of uncachedPaths) {
        prefetchingPathsRef.current.add(`${p}::${showHidden}::`);
      }
      apiPrefetchDirectories(uncachedPaths, showHidden)
        .then((batchMap) => {
          for (const [p, list] of Object.entries(batchMap)) {
            dirCacheRef.current.set(`${p}::${showHidden}::`, list);
          }
        })
        .catch(() => {
          // ignore batch prefetch errors
        })
        .finally(() => {
          for (const p of uncachedPaths) {
            prefetchingPathsRef.current.delete(`${p}::${showHidden}::`);
          }
        });
    }, 30);

    return () => clearTimeout(timer);
  }, [
    entriesReady,
    sidebarData?.favorites,
    customFavorites,
    hiddenFavorites,
    showHidden,
  ]);

  // Auto-detect removable thumb drives & hardware volume changes
  useEffect(() => {
    let mounted = true;
    const pollVolumes = async () => {
      try {
        const newData = await apiGetSidebarData();
        if (!mounted) return;
        setSidebarData((prev) => {
          if (!prev) return newData;
          const prevVols = JSON.stringify(prev.volumes);
          const nextVols = JSON.stringify(newData.volumes);
          if (prevVols !== nextVols) {
            // Check if a new removable volume appeared
            const oldRemovable = new Set(
              prev.volumes.filter((v) => v.isRemovable).map((v) => v.device)
            );
            const newlyAdded = newData.volumes.find(
              (v) => v.isRemovable && !oldRemovable.has(v.device)
            );
            if (newlyAdded) {
              showToast(`Connected: ${newlyAdded.name}`);
            }
            return { ...prev, volumes: newData.volumes };
          }
          return prev;
        });
      } catch {
        // ignore background poll errors
      }
    };

    // Sidebar data includes favorite discovery and volume metadata. Polling it
    // every 2.5s repeats that work even when nothing changed; focus still
    // triggers an immediate refresh when returning to the app.
    const interval = setInterval(pollVolumes, 10_000);
    const onFocus = () => {
      pollVolumes();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      mounted = false;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [showToast]);

  // Load entries for current tab or tag or search
  const loadCurrentEntries = useCallback(
    async (invalidateCache = false) => {
      if (!activeTab) return;
      const reqId = ++requestIdRef.current;
      const effectiveSearch = debouncedSearchQuery.trim();
      const cacheKey = `${activeTab.activeTag || activeTab.path}::${showHidden}::${effectiveSearch}`;

      if (invalidateCache) {
        dirCacheRef.current.clear();
        setRefreshVersion((v) => v + 1);
      } else {
        const cached = dirCacheRef.current.get(cacheKey);
        if (cached) {
          setEntries((prev) => (areEntriesEqual(prev, cached) ? prev : cached));
        }
      }

      try {
        let list: FileEntry[];
        if (activeTab.activeTag) {
          list = await apiGetFilesByTag(activeTab.activeTag);
        } else if (
          effectiveSearch.length > 0 &&
          activeTab.path !== "__RECENTS__" &&
          activeTab.path !== "__TRASH__"
        ) {
          list = await apiSearchDirectory(
            activeTab.path,
            effectiveSearch,
            showHidden
          );
        } else {
          list = await apiReadDirectory(activeTab.path, showHidden);
          if (effectiveSearch.length > 0) {
            const q = effectiveSearch.toLowerCase();
            list = list.filter((e) => e.name.toLowerCase().includes(q));
          }
        }

        if (reqId !== requestIdRef.current) return;
        dirCacheRef.current.set(cacheKey, list);
        setEntries((prev) => (areEntriesEqual(prev, list) ? prev : list));
      } catch (err) {
        if (reqId === requestIdRef.current) {
          showToast(`${err}`);
        }
      } finally {
        if (reqId === requestIdRef.current) {
          setEntriesReady(true);
          setEntriesLoadedPath(activeTab.path);
        }
      }
    },
    [activeTab?.path, activeTab?.activeTag, debouncedSearchQuery, showHidden, showToast]
  );

  const recordMoveUndo = useCallback(
    (sourcePaths: string[], movedPaths: string[]) => {
      if (sourcePaths.length !== movedPaths.length) return;
      const items = sourcePaths
        .slice(0, movedPaths.length)
        .map((sourcePath, index) => ({
          movedPath: movedPaths[index],
          originalParent: getParentPath(sourcePath),
        }))
        .filter((item, index) => item.movedPath !== sourcePaths[index]);
      if (items.length === 0) return;
      undoStackRef.current.push({ items });
      if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    },
    []
  );

  const handleUndo = useCallback(async () => {
    if (undoInProgressRef.current) return;
    const action = undoStackRef.current[undoStackRef.current.length - 1];
    if (!action) {
      showToast("Nothing to undo");
      return;
    }
    undoInProgressRef.current = true;

    const movesByParent = new Map<string, string[]>();
    for (const item of action.items) {
      const paths = movesByParent.get(item.originalParent) || [];
      paths.push(item.movedPath);
      movesByParent.set(item.originalParent, paths);
    }

    try {
      const restoredPaths: string[] = [];
      await runWithActivity("Undoing move...", async () => {
        for (const [parent, paths] of movesByParent) {
          restoredPaths.push(...(await apiMoveItems(paths, parent)));
        }
      });
      undoStackRef.current.pop();
      await loadCurrentEntries(true);
      setSplitPaneRefreshVersion((version) => version + 1);
      setSelectedPaths(restoredPaths);
      showToast(`Undid move of ${restoredPaths.length} item(s)`);
    } catch (error) {
      showToast(`Undo failed: ${error}`);
    } finally {
      undoInProgressRef.current = false;
    }
  }, [loadCurrentEntries, runWithActivity, showToast]);

  useEffect(() => {
    loadCurrentEntries(false);
  }, [loadCurrentEntries]);

  // Reveal the native window immediately once initial directory entries are committed to DOM.
  // Note: Do NOT use requestAnimationFrame here because WebKitGTK suspends rAF while the window is hidden!
  useEffect(() => {
    if (!entriesReady || windowShownRef.current) return;
    windowShownRef.current = true;
    const timerId = window.setTimeout(() => {
      void apiShowMainWindow();
    }, 12);
    return () => clearTimeout(timerId);
  }, [entriesReady]);

  // Sorted entries (fast-paths default name+asc since backend already returns sorted entries)
  const sortedEntries = useMemo(() => {
    if (sortField === "name" && sortDirection === "asc") {
      return entries;
    }
    // Fast O(N) reverse for name descending since backend already grouped and sorted ascending
    if (sortField === "name" && sortDirection === "desc") {
      const dirs: FileEntry[] = [];
      const files: FileEntry[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.isDir) dirs.push(e);
        else files.push(e);
      }
      dirs.reverse();
      files.reverse();
      return dirs.concat(files);
    }
    const copy = [...entries];
    copy.sort((a, b) => {
      // Folders always first
      if (a.isDir !== b.isDir) {
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
  }, [entries, sortField, sortDirection]);

  const sortedEntriesRef = useRef<FileEntry[]>(sortedEntries);
  sortedEntriesRef.current = sortedEntries;

  useEffect(() => {
    const rememberScrollPosition = (event: Event) => {
      if (restoringTabScrollRef.current) return;
      const element = event.target as HTMLElement | null;
      const mode = element?.dataset.tabScrollView;
      if (!element || !mode) return;
      tabScrollPositionsRef.current.set(`${activeTabIdRef.current}:${mode}`, {
        top: element.scrollTop,
        left: element.scrollLeft,
      });
    };
    document.addEventListener("scroll", rememberScrollPosition, true);
    return () => document.removeEventListener("scroll", rememberScrollPosition, true);
  }, []);

  useLayoutEffect(() => {
    const element = document.querySelector<HTMLElement>(
      `[data-tab-scroll-view="${viewMode}"]`
    );
    if (!element) return;
    const position = tabScrollPositionsRef.current.get(`${activeTabId}:${viewMode}`);
    restoringTabScrollRef.current = true;
    element.scrollTop = position?.top ?? 0;
    element.scrollLeft = position?.left ?? 0;
    const frame = requestAnimationFrame(() => {
      restoringTabScrollRef.current = false;
    });
    return () => {
      cancelAnimationFrame(frame);
      restoringTabScrollRef.current = false;
    };
  }, [activeTabId, viewMode, entries]);

  const knownEntriesMapRef = useRef<Map<string, FileEntry>>(new Map());
  useEffect(() => {
    const map = new Map<string, FileEntry>();
    for (let i = 0; i < sortedEntries.length; i++) {
      const item = sortedEntries[i];
      map.set(item.path, item);
    }
    knownEntriesMapRef.current = map;
  }, [sortedEntries]);

  const mainPartitionName = useMemo(() => {
    const rootVol = sidebarData?.volumes?.find((v) => v.mountPoint === "/");
    if (!rootVol) return sidebarData?.osName || "Linux";
    return rootVol.name || rootVol.shortDevice || sidebarData?.osName || "Linux";
  }, [sidebarData]);

  // Ensure switching tabs or navigating to a pinned/favorite folder restores its remembered view mode
  useEffect(() => {
    if (activeTab && !activeTab.activeTag) {
      applyFavoriteViewModeIfPinned(activeTab.path);
    }
  }, [activeTab?.id, activeTab?.path, activeTab?.activeTag, applyFavoriteViewModeIfPinned]);

  // Navigation handlers (synchronously swap cached entries in the same state batch!)
  const navigateTo = useCallback(
    (path: string, customTitle?: string) => {
      setSearchQuery("");
      setDebouncedSearchQuery("");
      setSelectedPaths([]);
      lastSelectedPathRef.current = null;
      setRenamingPath(null);
      setColumnActivePath(null);
      applyFavoriteViewModeIfPinned(path);
      applyCachedEntriesIfAvailable(path, null);
      const title = customTitle || folderDisplayName(path, mainPartitionName);

      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== activeTabId) return t;
          const nextHistory = t.history.slice(0, t.historyIndex + 1);
          nextHistory.push(path);
          return {
            ...t,
            title,
            path,
            history: nextHistory,
            historyIndex: nextHistory.length - 1,
            activeTag: null,
          };
        })
      );
    },
    [
      activeTabId,
      mainPartitionName,
      applyFavoriteViewModeIfPinned,
      applyCachedEntriesIfAvailable,
    ]
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let pollTimer: number | undefined;
    let active = true;
    const handleFileManagerRequest = (payload: {
      directory: string;
      selectedPaths: string[];
      showProperties?: boolean;
    }) => {
      if (!payload.directory) return;
      const selectedPaths = payload.selectedPaths || [];
      setPendingFileManagerReveal({
        directory: payload.directory,
        selectedPaths,
        showProperties: payload.showProperties,
      });
      if (activeTabRef.current?.path !== payload.directory) {
        navigateTo(payload.directory);
      } else {
        setSearchQuery("");
        setDebouncedSearchQuery("");
        if (selectedPaths.length > 0) {
          // Refresh the current folder too, since a download may have just
          // completed before Brave requested that it be revealed.
          void loadCurrentEntries(true);
        }
      }
    };
    const drainPendingRequests = () => {
      void apiTakeFileManagerRequests()
        .then((requests) => requests.forEach(handleFileManagerRequest))
        .catch(() => {});
    };
    void listen("file-manager-show-items", drainPendingRequests).then(async (fn) => {
      unlisten = fn;
      // The native D-Bus service can receive Brave's request before this
      // WebView has mounted. Drain those requests only after the listener is
      // active, so the first reveal is not lost during app startup.
      const pendingRequests = await apiFileManagerFrontendReady();
      if (!active) return;
      pendingRequests.forEach(handleFileManagerRequest);
      pollTimer = window.setInterval(drainPendingRequests, 500);
    });
    return () => {
      active = false;
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      unlisten?.();
    };
  }, [navigateTo, loadCurrentEntries]);

  useEffect(() => {
    const pending = pendingFileManagerReveal;
    if (
      !pending ||
      activeTab?.path !== pending.directory ||
      entriesLoadedPath !== pending.directory
    ) return;
    const findRequestedEntry = (path: string) => {
      const exactMatch = entries.find((entry) => entry.path === path);
      if (exactMatch) return exactMatch;
      const requestedName = path.split(/[\\/]/).pop();
      return requestedName
        ? entries.find((entry) => entry.name === requestedName)
        : undefined;
    };
    const requestedEntries = pending.selectedPaths.map(findRequestedEntry);
    if (
      pending.selectedPaths.length > 0 &&
      requestedEntries.some((entry) => !entry)
    ) {
      // Navigation can render once with the previous folder's entries. Keep
      // the reveal request until the requested item arrives in this listing.
      return;
    }
    if (pending.selectedPaths.length > 0) {
      const matchedPaths = requestedEntries
        .filter((entry): entry is FileEntry => Boolean(entry))
        .map((entry) => entry.path);
      setSelectedPaths(matchedPaths);
      lastSelectedPathRef.current = matchedPaths[0];
      setPendingRevealScrollPath(matchedPaths[0]);
    } else {
      setPendingFileManagerReveal(null);
      windowShownRef.current = true;
      void apiShowMainWindow();
    }
    if (pending.showProperties && pending.selectedPaths[0]) {
      const targetPath = pending.selectedPaths[0];
      const entry = findRequestedEntry(targetPath);
      if (entry) setGetInfoEntry(entry);
      else void apiGetFileInfo(targetPath).then(setGetInfoEntry).catch(() => {});
    }
  }, [activeTab?.path, entries, entriesLoadedPath, pendingFileManagerReveal]);

  const selectTagFilter = useCallback(
    (tagColor: string) => {
      setSearchQuery("");
      setSelectedPaths([]);
      lastSelectedPathRef.current = null;
      applyCachedEntriesIfAvailable("", tagColor);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                title: `${tagColor.charAt(0).toUpperCase() + tagColor.slice(1)} Tag`,
                activeTag: tagColor,
              }
            : t
        )
      );
    },
    [activeTabId, applyCachedEntriesIfAvailable]
  );

  const goBack = useCallback(() => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== activeTabId || t.historyIndex <= 0) return t;
        const newIdx = t.historyIndex - 1;
        const newPath = t.history[newIdx];
        applyFavoriteViewModeIfPinned(newPath);
        applyCachedEntriesIfAvailable(newPath, null);
        return {
          ...t,
          path: newPath,
          title: folderDisplayName(newPath, mainPartitionName),
          historyIndex: newIdx,
          activeTag: null,
        };
      })
    );
  }, [
    activeTabId,
    mainPartitionName,
    applyFavoriteViewModeIfPinned,
    applyCachedEntriesIfAvailable,
  ]);

  const goForward = useCallback(() => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== activeTabId || t.historyIndex >= t.history.length - 1)
          return t;
        const newIdx = t.historyIndex + 1;
        const newPath = t.history[newIdx];
        applyFavoriteViewModeIfPinned(newPath);
        applyCachedEntriesIfAvailable(newPath, null);
        return {
          ...t,
          path: newPath,
          title: folderDisplayName(newPath, mainPartitionName),
          historyIndex: newIdx,
          activeTag: null,
        };
      })
    );
  }, [
    activeTabId,
    mainPartitionName,
    applyFavoriteViewModeIfPinned,
    applyCachedEntriesIfAvailable,
  ]);

  const canGoUp = Boolean(
    activeTab &&
    activeTab.path !== "/" &&
    activeTab.path !== "__RECENTS__" &&
    activeTab.path !== "__TRASH__"
  );

  const goUp = useCallback(() => {
    if (!activeTab || activeTab.path === "/" || activeTab.path === "__RECENTS__" || activeTab.path === "__TRASH__") return;
    const parts = activeTab.path.split("/").filter(Boolean);
    parts.pop();
    const parent = "/" + parts.join("/");
    navigateTo(parent);
  }, [activeTab, navigateTo]);

  // Tab handlers
  const handleSelectTab = useCallback(
    (id: string) => {
      setActiveTabId(id);
      const targetTab = tabs.find((t) => t.id === id);
      if (targetTab) {
        if (!targetTab.activeTag) {
          applyFavoriteViewModeIfPinned(targetTab.path);
        }
        applyCachedEntriesIfAvailable(targetTab.path, targetTab.activeTag);
      }
    },
    [tabs, applyFavoriteViewModeIfPinned, applyCachedEntriesIfAvailable]
  );

  const handleSplitTab = useCallback(
    (tab: FinderTab) => {
      if (tabs.length < 2) return;
      const primaryTab = tabs.find((candidate) => candidate.id !== tab.id);
      if (!primaryTab) return;
      setActiveTabId(primaryTab.id);
      setSelectedPaths([]);
      setSearchQuery("");
      setDebouncedSearchQuery("");
      if (!primaryTab.activeTag) {
        applyFavoriteViewModeIfPinned(primaryTab.path);
      }
      applyCachedEntriesIfAvailable(primaryTab.path, primaryTab.activeTag);
      setSplitPane({
        tabId: tab.id,
        path: tab.path || sidebarData?.homeDir || "/",
        title: tab.title,
        activeTag: tab.activeTag || null,
        archiveWorkspaceRoot: tab.archiveWorkspaceRoot,
        key: Date.now(),
      });
    },
    [tabs, sidebarData?.homeDir, applyFavoriteViewModeIfPinned, applyCachedEntriesIfAvailable]
  );

  const handleSplitPaneLocationChange = useCallback(
    (location: { path: string; title: string; activeTag?: string | null }) => {
      setSplitPane((prev) => {
        if (!prev) return prev;
        const activeTag = location.activeTag || null;
        if (
          prev.path === location.path &&
          prev.title === location.title &&
          prev.activeTag === activeTag
        ) {
          return prev;
        }
        return { ...prev, ...location, activeTag };
      });
    },
    []
  );

  const handleSplitPaneHoverChange = useCallback((hovered: boolean) => {
    splitPaneHoveredRef.current = hovered;
  }, []);
  const handleSplitPaneSelectionChange = useCallback((paths: string[]) => {
    splitPaneSelectedPathsRef.current = paths;
  }, []);
  const handleSplitPaneSelectAllChange = useCallback(
    (selectAll: (() => void) | null) => {
      splitPaneSelectAllRef.current = selectAll;
    },
    []
  );

  const handleNewTab = useCallback(
    (initialPath?: string, initialTitle?: string) => {
      const validPath =
        typeof initialPath === "string" && initialPath.length > 0
          ? initialPath
          : undefined;
      const validTitle =
        typeof initialTitle === "string" && initialTitle.length > 0
          ? initialTitle
          : undefined;
      const homePath = sidebarData?.homeDir || "/";
      const targetPath = validPath || homePath;
      applyFavoriteViewModeIfPinned(targetPath);
      applyCachedEntriesIfAvailable(targetPath, null);
      const title =
        validTitle ||
        (targetPath === homePath
          ? "Home"
          : folderDisplayName(targetPath, mainPartitionName));
      const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      for (const mode of ["icons", "list", "columns", "gallery"] as const) {
        tabScrollPositionsRef.current.set(`${id}:${mode}`, { top: 0, left: 0 });
      }
      setTabs((prev) => [
        ...prev,
        {
          id,
          title,
          path: targetPath,
          history: [targetPath],
          historyIndex: 0,
          activeTag: null,
        },
      ]);
      setActiveTabId(id);
    },
    [
      sidebarData,
      mainPartitionName,
      applyFavoriteViewModeIfPinned,
      applyCachedEntriesIfAvailable,
    ]
  );

  const handleCloseTab = useCallback(
    (id: string, allowLastTab = false) => {
      if (allowLastTab) {
        setSearchQuery("");
        setDebouncedSearchQuery("");
        setSelectedPaths([]);
      }
      const replacementId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setTabs((prev) => {
        if (prev.length <= 1 && !allowLastTab) return prev;
        const filtered = prev.filter((t) => t.id !== id);
        if (filtered.length === 0) {
          const homePath = sidebarData?.homeDir || "";
          const homeTab: FinderTab = {
            id: replacementId,
            title: "Home",
            path: homePath,
            history: [homePath],
            historyIndex: 0,
            activeTag: null,
          };
          setActiveTabId(homeTab.id);
          applyFavoriteViewModeIfPinned(homePath);
          applyCachedEntriesIfAvailable(homePath, null);
          return [homeTab];
        }
        if (activeTabId === id) {
          const nextTab = filtered[filtered.length - 1];
          setActiveTabId(nextTab.id);
          if (!nextTab.activeTag) {
            applyFavoriteViewModeIfPinned(nextTab.path);
          }
          applyCachedEntriesIfAvailable(nextTab.path, nextTab.activeTag);
        }
        return filtered;
      });
    },
    [
      activeTabId,
      sidebarData?.homeDir,
      applyFavoriteViewModeIfPinned,
      applyCachedEntriesIfAvailable,
    ]
  );

  const handleReorderTabs = useCallback(
    (draggedId: string, targetId: string, after: boolean) => {
      setTabs((prev) => {
        const fromIndex = prev.findIndex((tab) => tab.id === draggedId);
        const targetIndex = prev.findIndex((tab) => tab.id === targetId);
        if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
          return prev;
        }

        const reordered = [...prev];
        const [draggedTab] = reordered.splice(fromIndex, 1);
        const targetPosition = reordered.findIndex((tab) => tab.id === targetId);
        const destination = targetPosition + (after ? 1 : 0);
        if (destination === fromIndex) return prev;
        reordered.splice(destination, 0, draggedTab);
        return reordered;
      });
    },
    []
  );

  // Selection & Range Selection
  const handleSelectEntry = useCallback(
    (
      entry: FileEntry,
      modifiers: SelectionModifiers,
      orderedEntries?: FileEntry[]
    ) => {
      knownEntriesMapRef.current.set(entry.path, entry);
      if (orderedEntries) {
        for (const item of orderedEntries) {
          knownEntriesMapRef.current.set(item.path, item);
        }
      }
      const list = orderedEntries || sortedEntriesRef.current;

      setSelectedPaths((prev) => {
        if (modifiers.shift) {
          const anchorPath =
            lastSelectedPathRef.current ||
            (prev.length > 0 ? prev[prev.length - 1] : null);
          const anchorIdx = anchorPath
            ? list.findIndex((e) => e.path === anchorPath)
            : -1;
          const targetIdx = list.findIndex((e) => e.path === entry.path);

          if (anchorIdx !== -1 && targetIdx !== -1) {
            const start = Math.min(anchorIdx, targetIdx);
            const end = Math.max(anchorIdx, targetIdx);
            const rangePaths = list.slice(start, end + 1).map((e) => e.path);
            if (modifiers.ctrlKey) {
              return Array.from(new Set([...prev, ...rangePaths]));
            }
            return rangePaths;
          }
          lastSelectedPathRef.current = entry.path;
          return prev.includes(entry.path) ? prev : [...prev, entry.path];
        }

        if (modifiers.ctrlKey) {
          lastSelectedPathRef.current = entry.path;
          return prev.includes(entry.path)
            ? prev.filter((p) => p !== entry.path)
            : [...prev, entry.path];
        }

        lastSelectedPathRef.current = entry.path;
        return [entry.path];
      });
    },
    []
  );

  const handleBrowseArchive = useCallback(
    async (path: string) => {
      const archiveName = path.split(/[\\/]/).pop() || path;
      setOpeningArchive(archiveName);
      try {
        const destination = await runWithActivity(
          `Opening ${archiveName}...`,
          () => apiExtractArchive(path)
        );
        await loadCurrentEntries(true);
        setSplitPaneRefreshVersion((version) => version + 1);
        navigateTo(destination, archiveName);
        setTabs((tabs) =>
          tabs.map((tab) =>
            tab.id === activeTabId
              ? { ...tab, archiveWorkspaceRoot: destination }
              : tab
          )
        );
        showToast(`Opened extracted copy of ${archiveName}`);
      } catch (error) {
        showToast(`Could not open archive: ${error}`);
      } finally {
        setOpeningArchive(null);
      }
    },
    [activeTabId, loadCurrentEntries, navigateTo, runWithActivity, showToast]
  );

  const handleOpenEntry = useCallback(
    async (entry: FileEntry) => {
      knownEntriesMapRef.current.set(entry.path, entry);
      const currentSelected = selectedPathsRef.current;
      const isMulti =
        currentSelected.length > 1 && currentSelected.includes(entry.path);

      if (isMulti) {
        const selectedItems = currentSelected
          .map(
            (p) =>
              knownEntriesMapRef.current.get(p) ||
              sortedEntriesRef.current.find((e) => e.path === p)
          )
          .filter((e): e is FileEntry => Boolean(e));
        const dirs = selectedItems.filter((e) => e.isDir);
        const files = selectedItems.filter((e) => !e.isDir);

        for (const f of files) {
          try {
            await apiOpenItem(f.path);
          } catch (err) {
            showToast(`${err}`);
          }
        }
        if (dirs.length === 1 && files.length === 0) {
          navigateTo(dirs[0].path, dirs[0].name);
        } else if (dirs.length > 0 && files.length === 0) {
          navigateTo(dirs[0].path, dirs[0].name);
        }
        return;
      }

      if (entry.isDir) {
        navigateTo(entry.path, entry.name);
      } else if (
        /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst|tar\.lzma)$/i.test(
          entry.name
        )
      ) {
        void handleBrowseArchive(entry.path);
      } else {
        try {
          await apiOpenItem(entry.path);
        } catch (err) {
          showToast(`${err}`);
        }
      }
    },
    [handleBrowseArchive, navigateTo, showToast]
  );

  // File Operations
  const handleNewFolder = useCallback(
    async (targetDirOverride?: string) => {
      const targetDir =
        targetDirOverride ||
        contextMenu?.targetDir ||
        (viewMode === "columns" && columnActivePathRef.current
          ? columnActivePathRef.current
          : activeTab?.path);
      if (!targetDir || targetDir === "__RECENTS__" || targetDir === "__TRASH__" || activeTab?.activeTag) {
        showToast("Navigate to a folder first to create a new folder");
        return;
      }
      const baseName = "untitled folder";
      let candidate = baseName;
      let counter = 2;
      let existingNames = new Set(entries.map((e) => e.name));
      if (targetDir !== activeTab?.path) {
        try {
          const targetEntries = await apiReadDirectory(targetDir, showHidden);
          existingNames = new Set(targetEntries.map((e) => e.name));
        } catch {
          // ignore
        }
      }
      while (existingNames.has(candidate)) {
        candidate = `${baseName} ${counter++}`;
      }
      try {
        const created = await runWithActivity("Creating folder...", () =>
          apiCreateDirectory(targetDir, candidate)
        );
        knownEntriesMapRef.current.set(created.path, created);
        await loadCurrentEntries(true);
        setSelectedPaths([created.path]);
        lastSelectedPathRef.current = created.path;
        setRenamingPath(created.path);
        setRenameValue(created.name);
      renameCommitPathRef.current = null;
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [
      contextMenu?.targetDir,
      viewMode,
      activeTab?.path,
      activeTab?.activeTag,
      entries,
      showHidden,
      loadCurrentEntries,
      runWithActivity,
      showToast,
    ]
  );

  const handleNewFile = useCallback(
    async (targetDirOverride?: string) => {
      const targetDir =
        targetDirOverride ||
        contextMenu?.targetDir ||
        (viewMode === "columns" && columnActivePathRef.current
          ? columnActivePathRef.current
          : activeTab?.path);
      if (!targetDir || targetDir === "__RECENTS__" || targetDir === "__TRASH__" || activeTab?.activeTag) {
        showToast("Navigate to a folder first to create a file");
        return;
      }
      const baseName = "untitled.txt";
      let candidate = baseName;
      let counter = 2;
      let existingNames = new Set(entries.map((e) => e.name));
      if (targetDir !== activeTab?.path) {
        try {
          const targetEntries = await apiReadDirectory(targetDir, showHidden);
          existingNames = new Set(targetEntries.map((e) => e.name));
        } catch {
          // ignore
        }
      }
      while (existingNames.has(candidate)) {
        candidate = `untitled ${counter++}.txt`;
      }
      try {
        const created = await runWithActivity("Creating file...", () =>
          apiCreateFile(targetDir, candidate)
        );
        knownEntriesMapRef.current.set(created.path, created);
        await loadCurrentEntries(true);
        setSelectedPaths([created.path]);
        lastSelectedPathRef.current = created.path;
        setRenamingPath(created.path);
        setRenameValue(created.name);
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [
      contextMenu?.targetDir,
      viewMode,
      activeTab?.path,
      activeTab?.activeTag,
      entries,
      showHidden,
      loadCurrentEntries,
      runWithActivity,
      showToast,
    ]
  );

  const startRename = useCallback((entry: FileEntry) => {
    knownEntriesMapRef.current.set(entry.path, entry);
    renameCommitPathRef.current = null;
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
  }, []);

  const submitRename = useCallback(async () => {
    if (!renamingPath) return;
    if (renameCommitPathRef.current === renamingPath) return;
    renameCommitPathRef.current = renamingPath;
    const trimmed = renameValue.trim();
    const targetEntry =
      entries.find((e) => e.path === renamingPath) ||
      knownEntriesMapRef.current.get(renamingPath);
    setRenamingPath(null);
    if (!trimmed || (targetEntry && targetEntry.name === trimmed)) return;

    try {
      const updated = await runWithActivity("Renaming item...", () =>
        apiRenameItem(renamingPath, trimmed)
      );
      knownEntriesMapRef.current.set(updated.path, updated);
      await loadCurrentEntries(true);
      setSelectedPaths([updated.path]);
      lastSelectedPathRef.current = updated.path;
    } catch (err) {
      showToast(`${err}`);
    }
  }, [renamingPath, renameValue, entries, loadCurrentEntries, runWithActivity, showToast]);

  // Commit inline names on any outside click, including controls that prevent
  // the input from losing focus (where the input's onBlur would not fire).
  useEffect(() => {
    if (!renamingPath) return;
    const commitOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-rename-input]")) {
        return;
      }
      void submitRename();
    };
    document.addEventListener("pointerdown", commitOnOutsidePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", commitOnOutsidePointerDown, true);
  }, [renamingPath, submitRename]);

  const handleDuplicate = useCallback(
    async (entry?: FileEntry) => {
      const targets = entry ? [entry.path] : selectedPaths;
      if (targets.length === 0) return;
      try {
        const createdPaths = await runWithActivity(
          `Duplicating ${targets.length} item(s)...`,
          async () => {
            const created: string[] = [];
            for (const path of targets) {
              const duplicate = await apiDuplicateItem(path);
              created.push(duplicate.path);
            }
            return created;
          }
        );
        await loadCurrentEntries(true);
        setSelectedPaths(createdPaths);
        showToast(
          targets.length === 1
            ? `Duplicated item`
            : `Duplicated ${targets.length} items`
        );
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [selectedPaths, loadCurrentEntries, runWithActivity, showToast]
  );

  const handleCompress = useCallback(
    async (entry?: FileEntry) => {
      const targets = entry ? [entry.path] : selectedPaths;
      if (targets.length === 0) return;
      try {
        const archivePath = await runWithActivity(
          `Compressing ${targets.length} item(s)...`,
          () => apiCompressItems(targets)
        );
        await loadCurrentEntries(true);
        setSelectedPaths([archivePath]);
        showToast(`Created ${archivePath.split(/[\\/]/).pop() || "ZIP archive"}`);
      } catch (error) {
        showToast(`Compression failed: ${error}`);
      }
    },
    [selectedPaths, loadCurrentEntries, runWithActivity, showToast]
  );

  const handleExtractArchive = useCallback(
    async (path: string) => {
      const archiveName = path.split(/[\\/]/).pop() || path;
      try {
        const destination = await runWithActivity(
          `Extracting ${archiveName}...`,
          () => apiExtractArchive(path)
        );
        await loadCurrentEntries(true);
        setSplitPaneRefreshVersion((version) => version + 1);
        setSelectedPaths([destination]);
        showToast(`Extracted to ${destination.split(/[\\/]/).pop() || destination}`);
      } catch (error) {
        showToast(`Extraction failed: ${error}`);
      }
    },
    [loadCurrentEntries, runWithActivity, showToast]
  );

  const handleTrash = useCallback(
    async (targetEntry?: FileEntry) => {
      const targets = targetEntry ? [targetEntry.path] : selectedPaths;
      if (targets.length === 0) return;
      try {
        await runWithActivity(`Moving ${targets.length} item(s) to Trash...`, () =>
          apiTrashItems(targets)
        );
        setSelectedPaths([]);
        await loadCurrentEntries(true);
        showToast(`Moved ${targets.length} item(s) to Trash`);
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [selectedPaths, loadCurrentEntries, runWithActivity, showToast]
  );

  const handleRestoreTrash = useCallback(
    async (targetEntry?: FileEntry) => {
      const targets = targetEntry ? [targetEntry.path] : selectedPaths;
      if (targets.length === 0) return;
      try {
        const restored = await runWithActivity(
          `Restoring ${targets.length} item(s)...`,
          () => apiRestoreTrashItems(targets)
        );
        setSelectedPaths([]);
        await loadCurrentEntries(true);
        setSplitPaneRefreshVersion((version) => version + 1);
        showToast(
          restored.length === 1
            ? `Restored to "${restored[0]}"`
            : `Restored ${restored.length} items to their original locations`
        );
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [selectedPaths, loadCurrentEntries, runWithActivity, showToast]
  );

  const handleRestoreAllTrash = useCallback(async () => {
    try {
      const allTrashPaths =
        activeTab?.path === "__TRASH__"
          ? entries.map((e) => e.path)
          : (await apiGetTrashFiles(true)).map((e) => e.path);
      if (allTrashPaths.length === 0) {
        showToast("Trash is already empty");
        return;
      }
      const restored = await runWithActivity(
        `Restoring ${allTrashPaths.length} item(s)...`,
        () => apiRestoreTrashItems(allTrashPaths)
      );
      setSelectedPaths([]);
      await loadCurrentEntries(true);
      setSplitPaneRefreshVersion((version) => version + 1);
      showToast(`Restored ${restored.length} item(s) from Trash`);
    } catch (err) {
      showToast(`${err}`);
    }
  }, [activeTab?.path, entries, loadCurrentEntries, runWithActivity, showToast]);

  const handleDeletePermanently = useCallback(
    (targetEntry?: FileEntry) => {
      const targets = targetEntry ? [targetEntry.path] : selectedPaths;
      if (targets.length === 0) return;
      setTrashConfirmModal({
        mode: "delete-selected",
        paths: targets,
        count: targets.length,
      });
    },
    [selectedPaths]
  );

  const handleEmptyTrash = useCallback(async () => {
    const count =
      activeTab?.path === "__TRASH__"
        ? entries.length
        : (await apiGetTrashFiles(true).catch(() => [])).length;
    if (count === 0) {
      showToast("Trash is already empty");
      return;
    }
    setTrashConfirmModal({
      mode: "empty",
      count,
    });
  }, [activeTab?.path, entries.length, showToast]);

  const confirmTrashAction = useCallback(async () => {
    if (!trashConfirmModal) return;
    const modal = trashConfirmModal;
    setTrashConfirmModal(null);
    try {
      if (modal.mode === "empty") {
        await runWithActivity("Emptying Trash...", () => apiEmptyTrash());
        setSelectedPaths([]);
        await loadCurrentEntries(true);
        setSplitPaneRefreshVersion((version) => version + 1);
        showToast("Emptied Trash");
      } else if (modal.paths && modal.paths.length > 0) {
        await runWithActivity(
          `Permanently deleting ${modal.paths.length} item(s)...`,
          () => apiDeleteTrashItemsPermanently(modal.paths!)
        );
        setSelectedPaths([]);
        await loadCurrentEntries(true);
        setSplitPaneRefreshVersion((version) => version + 1);
        showToast(`Permanently deleted ${modal.paths.length} item(s)`);
      }
    } catch (err) {
      showToast(`${err}`);
    }
  }, [trashConfirmModal, loadCurrentEntries, runWithActivity, showToast]);

  const handleCopy = useCallback(
    (entry?: FileEntry) => {
      const paths = entry
        ? [entry.path]
        : splitPaneHoveredRef.current
        ? splitPaneSelectedPathsRef.current
        : selectedPaths;
      if (paths.length === 0) return;
      setClipboard({ paths, mode: "copy" });
      showToast(`Copied ${paths.length} item(s)`);
    },
    [selectedPaths, showToast]
  );

  const handleCut = useCallback(
    (entry?: FileEntry) => {
      const paths = entry
        ? [entry.path]
        : splitPaneHoveredRef.current
        ? splitPaneSelectedPathsRef.current
        : selectedPaths;
      if (paths.length === 0) return;
      setClipboard({ paths, mode: "cut" });
      showToast(`Cut ${paths.length} item(s)`);
    },
    [selectedPaths, showToast]
  );

  const handlePaste = useCallback(
    async (targetDirOverride?: string) => {
      const destDir =
        targetDirOverride ||
        contextMenu?.targetDir ||
        (viewMode === "columns" && columnActivePathRef.current
          ? columnActivePathRef.current
          : activeTab?.path);
      if (!clipboard || !destDir || destDir === "__RECENTS__" || destDir === "__TRASH__") return;
      try {
        if (clipboard.mode === "copy") {
          const created = await runWithActivity(
            `Copying ${clipboard.paths.length} item(s)...`,
            async () => {
              const result = await apiCopyItems(clipboard.paths, destDir);
              await loadCurrentEntries(true);
              return result;
            }
          );
          setSelectedPaths(created);
          setClipboard((current) => (current === clipboard ? null : current));
          showToast(`Pasted ${created.length} item(s)`);
        } else {
          const moved = await runWithActivity(
            `Moving ${clipboard.paths.length} item(s)...`,
            async () => {
              const result = await apiMoveItems(clipboard.paths, destDir);
              await loadCurrentEntries(true);
              return result;
            }
          );
          recordMoveUndo(clipboard.paths, moved);
          setSelectedPaths(moved);
          setClipboard((current) => (current === clipboard ? null : current));
          showToast(`Moved ${moved.length} item(s)`);
        }
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [clipboard, contextMenu?.targetDir, viewMode, activeTab?.path, loadCurrentEntries, recordMoveUndo, runWithActivity, showToast]
  );

  const handleToggleTag = useCallback(
    async (path: string, color: string) => {
      try {
        const currentSelected = selectedPathsRef.current;
        const targets =
          currentSelected.length > 1 && currentSelected.includes(path)
            ? currentSelected
            : [path];

        const lastUpdatedTags = await runWithActivity(
          `Updating tags for ${targets.length} item(s)...`,
          async () => {
            let updatedTags: string[] = [];
            for (const targetPath of targets) {
              updatedTags = await apiToggleItemTag(targetPath, color);
            }
            await loadCurrentEntries(true);
            await refreshSidebar();
            return updatedTags;
          }
        );
        setGetInfoEntry((prev) =>
          prev && prev.path === path
            ? { ...prev, tags: lastUpdatedTags }
            : prev
        );
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [loadCurrentEntries, refreshSidebar, runWithActivity, showToast]
  );

  const handleSetDefaultApp = useCallback(
    async (path: string, program: string, applyToExtension: boolean) => {
      try {
        const updatedApp = await apiSetDefaultApp(
          path,
          program,
          applyToExtension
        );
        await loadCurrentEntries(true);
        setGetInfoEntry((prev) =>
          prev && prev.path === path
            ? { ...prev, defaultApp: updatedApp }
            : prev
        );
        setQuickLookEntry((prev) =>
          prev && prev.path === path
            ? { ...prev, defaultApp: updatedApp }
            : prev
        );
        if (!program.trim()) {
          showToast("Reset to system default program");
        } else if (applyToExtension) {
          const ext = path.split(".").pop() || "";
          showToast(
            ext
              ? `Default program set to "${program.trim()}" for all .${ext} files`
              : `Default program set to "${program.trim()}"`
          );
        } else {
          showToast(`Default program set to "${program.trim()}"`);
        }
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [loadCurrentEntries, showToast]
  );

  const handleSaveDefaultAppFromModal = useCallback(
    async (
      entry: FileEntry,
      program: string,
      applyToExtension: boolean,
      openNow: boolean
    ) => {
      await handleSetDefaultApp(entry.path, program, applyToExtension);
      if (openNow && program.trim()) {
        try {
          await apiOpenItemWith(entry.path, program.trim());
        } catch (err) {
          showToast(`${err}`);
        }
      }
    },
    [handleSetDefaultApp, showToast]
  );

  const handleAddFavorite = useCallback(
    (entry: FileEntry) => {
      if (!entry.isDir) return;
      // If previously hidden, unhide it
      setHiddenFavorites((prev) => {
        if (!prev.includes(entry.path)) return prev;
        const next = prev.filter((p) => p !== entry.path);
        localStorage.setItem("finder-hidden-favorites", JSON.stringify(next));
        return next;
      });
      setCustomFavorites((prev) => {
        if (prev.some((f) => f.path === entry.path)) return prev;
        const next = [...prev, { name: entry.name, path: entry.path }];
        localStorage.setItem("finder-custom-favorites", JSON.stringify(next));
        return next;
      });
      if (!favoriteViewModesRef.current[entry.path]) {
        saveFavoriteViewMode(entry.path, viewModeRef.current);
      }
      showToast(`Added "${entry.name}" to Favorites`);
    },
    [showToast, saveFavoriteViewMode]
  );

  const handleRemoveFavorite = useCallback(
    (path: string) => {
      setCustomFavorites((prev) => {
        const next = prev.filter((f) => f.path !== path);
        localStorage.setItem("finder-custom-favorites", JSON.stringify(next));
        return next;
      });
      setHiddenFavorites((prev) => {
        if (prev.includes(path)) return prev;
        const next = [...prev, path];
        localStorage.setItem("finder-hidden-favorites", JSON.stringify(next));
        return next;
      });
      showToast("Removed from Sidebar");
    },
    [showToast]
  );

  // Pointer-based Drag & Drop handler (works for single or multiple selected items)
  const handleStartItemDrag = useCallback(
    (
      e: React.MouseEvent,
      entry: FileEntry,
      orderedEntries?: FileEntry[],
      onClickOverride?: (
        entry: FileEntry,
        modifiers: SelectionModifiers
      ) => void,
      selectedPathsOverride?: string[]
    ) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target && target.closest("input, textarea, button")) return;
      const startedInSplitPane = Boolean(target.closest("[data-split-pane]"));

      e.stopPropagation();
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const ctrlKey = e.ctrlKey;
      const shift = e.shiftKey;

      const currentSelected = startedInSplitPane
        ? selectedPathsOverride || [entry.path]
        : selectedPathsRef.current;
      const alreadySelected = currentSelected.includes(entry.path);

      // Determine which paths will be dragged if the user moves the cursor
      let dragPaths: string[];
      if (alreadySelected) {
        dragPaths = [...currentSelected];
      } else if (ctrlKey || shift) {
        dragPaths = [...currentSelected, entry.path];
      } else {
        // Select immediately on mousedown so single un-selected item highlights right away
        if (!startedInSplitPane) {
          setSelectedPaths([entry.path]);
          lastSelectedPathRef.current = entry.path;
        }
        dragPaths = [entry.path];
      }

      const allKnownEntries = orderedEntries || sortedEntriesRef.current;
      knownEntriesMapRef.current.set(entry.path, entry);
      for (const item of allKnownEntries) {
        knownEntriesMapRef.current.set(item.path, item);
      }
      const pathMap = new Map(allKnownEntries.map((item) => [item.path, item]));
      const draggedEntries = dragPaths
        .map((p) => pathMap.get(p))
        .filter((item): item is FileEntry => Boolean(item));
      const hasDirs =
        entry.isDir || draggedEntries.some((item) => item.isDir);

      let isDragging = false;
      let latestDropPath: string | null = null;
      let latestDropName: string | null = null;
      let latestDropTag: string | null = null;
      let latestDropTagName: string | null = null;
      let latestDropFavZone = false;
      let hoveredTabId: string | null = null;
      let tabSwitchTimer: ReturnType<typeof setTimeout> | null = null;

      const clearTabTimer = () => {
        if (tabSwitchTimer) {
          clearTimeout(tabSwitchTimer);
          tabSwitchTimer = null;
        }
        hoveredTabId = null;
      };

      const resolveDropTarget = (clientX: number, clientY: number, isCopy: boolean) => {
        const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        if (!el) {
          clearTabTimer();
          return {
            dropTargetPath: null,
            dropTargetName: null,
            dropTargetTag: null,
            dropTargetTagName: null,
            dropFavoriteZone: false,
          };
        }

        // Spring-load tab switching when hovering over an inactive tab for 600ms
        const tabEl = el.closest("[data-tab-id]") as HTMLElement | null;
        const tabId = tabEl?.getAttribute("data-tab-id") || null;
        if (tabId && tabId !== hoveredTabId) {
          clearTabTimer();
          hoveredTabId = tabId;
          tabSwitchTimer = setTimeout(() => {
            setActiveTabId(tabId);
          }, 600);
        } else if (!tabId) {
          clearTabTimer();
        }

        // 1. Check Tag drop target in Sidebar
        const tagEl = el.closest("[data-drop-tag]") as HTMLElement | null;
        if (tagEl) {
          return {
            dropTargetPath: null,
            dropTargetName: null,
            dropTargetTag: tagEl.getAttribute("data-drop-tag"),
            dropTargetTagName: tagEl.getAttribute("data-drop-tag-name"),
            dropFavoriteZone: false,
          };
        }

        // 2. Check Folder / Volume / Favorite / Tab / Breadcrumb drop target
        const dropEl = el.closest("[data-drop-path]") as HTMLElement | null;
        if (dropEl) {
          const candidatePath = dropEl.getAttribute("data-drop-path");
          const candidateName =
            dropEl.getAttribute("data-drop-name") ||
            (candidatePath ? folderDisplayName(candidatePath) : null);

          if (candidatePath && candidatePath !== "__RECENTS__") {
            if (candidatePath === "__TRASH__") {
              if (activeTabRef.current?.path !== "__TRASH__") {
                return {
                  dropTargetPath: "__TRASH__",
                  dropTargetName: "Trash",
                  dropTargetTag: null,
                  dropTargetTagName: null,
                  dropFavoriteZone: false,
                };
              }
              return {
                dropTargetPath: null,
                dropTargetName: null,
                dropTargetTag: null,
                dropTargetTagName: null,
                dropFavoriteZone: false,
              };
            }
            // Cannot drop a folder into itself or its own descendant
            const invalidSelfDrop = dragPaths.some(
              (src) =>
                src === candidatePath ||
                candidatePath.startsWith(src + "/")
            );
            // Moving into the exact same parent directory is a no-op (unless copying)
            const hasValidSource =
              isCopy ||
              dragPaths.some((src) => getParentPath(src) !== candidatePath);

            if (!invalidSelfDrop && hasValidSource) {
              return {
                dropTargetPath: candidatePath,
                dropTargetName: candidateName,
                dropTargetTag: null,
                dropTargetTagName: null,
                dropFavoriteZone: false,
              };
            }
          }
        }

        // 3. Check Sidebar Favorites pin zone when dragging folder(s)
        const favZoneEl = el.closest("[data-drop-favorite-zone]") as HTMLElement | null;
        if (favZoneEl && hasDirs) {
          return {
            dropTargetPath: null,
            dropTargetName: null,
            dropTargetTag: null,
            dropTargetTagName: null,
            dropFavoriteZone: true,
          };
        }

        return {
          dropTargetPath: null,
          dropTargetName: null,
          dropTargetTag: null,
          dropTargetTagName: null,
          dropFavoriteZone: false,
        };
      };

      let dragRaf: number | null = null;

      const cancelInternalDrag = () => {
        clearTabTimer();
        if (dragRaf !== null) {
          cancelAnimationFrame(dragRaf);
          dragRaf = null;
        }
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        cancelInternalDragRef.current = null;
        setDragState(null);
      };

      const onMouseMove = (ev: MouseEvent) => {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (!isDragging && dist > 5) {
          isDragging = true;
          if (!startedInSplitPane) setSelectedPaths(dragPaths);
          cancelInternalDragRef.current = cancelInternalDrag;
          void apiArmExternalDrag(dragPaths);
        }
        if (!isDragging) return;

        if (dragRaf === null) {
          const clientX = ev.clientX;
          const clientY = ev.clientY;
          const isCopy = ev.altKey || ev.ctrlKey;
          dragRaf = requestAnimationFrame(() => {
            dragRaf = null;
            const resolved = resolveDropTarget(clientX, clientY, isCopy);
            latestDropPath = resolved.dropTargetPath;
            latestDropName = resolved.dropTargetName;
            latestDropTag = resolved.dropTargetTag;
            latestDropTagName = resolved.dropTargetTagName;
            latestDropFavZone = resolved.dropFavoriteZone;

            setDragState({
              paths: dragPaths,
              primaryEntry: entry,
              hasDirs,
              x: clientX,
              y: clientY,
              isCopy,
              ...resolved,
            });
          });
        }
      };

      const onMouseUp = async (ev: MouseEvent) => {
        clearTabTimer();
        if (dragRaf !== null) {
          cancelAnimationFrame(dragRaf);
          dragRaf = null;
        }
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        cancelInternalDragRef.current = null;
        void apiDisarmExternalDrag();

        if (!isDragging) {
          // User clicked without dragging
          const mods: SelectionModifiers = {
            ctrlKey: ev.ctrlKey,
            shift: ev.shiftKey,
          };
          if (onClickOverride) {
            onClickOverride(entry, mods);
          } else {
            handleSelectEntry(entry, mods, orderedEntries);
          }
          return;
        }

        setDragState(null);
        const isCopy = ev.altKey || ev.ctrlKey;

        // Handle Drop onto Folder / Volume / Favorite / Tab / Path Bar
        if (latestDropPath) {
          const destDir = latestDropPath;
          const destLabel = latestDropName || folderDisplayName(destDir);
          const droppedIntoSplitPane = Boolean(
            document
              .elementFromPoint(ev.clientX, ev.clientY)
              ?.closest("[data-split-pane]")
          );
          if (destDir === "__TRASH__") {
            try {
              await runWithActivity(
                `Moving ${dragPaths.length} item(s) to Trash...`,
                async () => {
                  await apiTrashItems(dragPaths);
                  await loadCurrentEntries(true);
                }
              );
              setSelectedPaths([]);
              if (startedInSplitPane || droppedIntoSplitPane) {
                setSplitPaneRefreshVersion((version) => version + 1);
              }
              showToast(`Moved ${dragPaths.length} item(s) to Trash`);
            } catch (err) {
              showToast(`${err}`);
            }
            return;
          }
          try {
            if (isCopy) {
              const copied = await runWithActivity(
                `Copying ${dragPaths.length} item(s)...`,
                async () => {
                  const result = await apiCopyItems(dragPaths, destDir);
                  await loadCurrentEntries(true);
                  return result;
                }
              );
              if (startedInSplitPane || droppedIntoSplitPane) {
                setSplitPaneRefreshVersion((version) => version + 1);
              }
              setSelectedPaths(copied);
              showToast(
                `Copied ${copied.length} item(s) to "${destLabel}"`
              );
            } else {
              const sourcesToMove = dragPaths.filter(
                (src) => getParentPath(src) !== destDir
              );
              if (sourcesToMove.length > 0) {
                const moved = await runWithActivity(
                  `Moving ${sourcesToMove.length} item(s)...`,
                  async () => {
                    const result = await apiMoveItems(sourcesToMove, destDir);
                    await loadCurrentEntries(true);
                    return result;
                  }
                );
                recordMoveUndo(sourcesToMove, moved);
                setSelectedPaths([]);
                if (startedInSplitPane || droppedIntoSplitPane) {
                  setSplitPaneRefreshVersion((version) => version + 1);
                }
                showToast(
                  `Moved ${sourcesToMove.length} item(s) to "${destLabel}"`
                );
              }
            }
          } catch (err) {
            showToast(`${err}`);
          }
          return;
        }

        // Handle Drop onto Sidebar Tag
        if (latestDropTag) {
          try {
            for (const p of dragPaths) {
              await apiToggleItemTag(p, latestDropTag);
            }
            await loadCurrentEntries(true);
            await refreshSidebar();
            showToast(
              `Tagged ${dragPaths.length} item(s) with ${
                latestDropTagName || latestDropTag
              }`
            );
          } catch (err) {
            showToast(`${err}`);
          }
          return;
        }

        // Handle Drop onto Sidebar Favorites zone (pin folders)
        if (latestDropFavZone && hasDirs) {
          const dirsToPin =
            draggedEntries.filter((d) => d.isDir).length > 0
              ? draggedEntries.filter((d) => d.isDir)
              : entry.isDir
              ? [entry]
              : [];
          if (dirsToPin.length > 0) {
            const dirPaths = dirsToPin.map((d) => d.path);
            setHiddenFavorites((prev) => {
              const next = prev.filter((p) => !dirPaths.includes(p));
              localStorage.setItem("finder-hidden-favorites", JSON.stringify(next));
              return next;
            });
            setCustomFavorites((prev) => {
              const next = [...prev];
              for (const d of dirsToPin) {
                if (!next.some((f) => f.path === d.path)) {
                  next.push({ name: d.name, path: d.path });
                }
              }
              localStorage.setItem(
                "finder-custom-favorites",
                JSON.stringify(next)
              );
              return next;
            });
            showToast(
              `Added ${dirsToPin.length} folder(s) to Sidebar Favorites`
            );
          }
        }
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [handleSelectEntry, loadCurrentEntries, recordMoveUndo, refreshSidebar, runWithActivity, showToast]
  );

  // Cross-App Drag & Drop (Outbound to Brave/Chrome & Inbound from Brave/Chrome/External Apps)
  useEffect(() => {
    const isTauriEnv =
      typeof window !== "undefined" &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
    if (!isTauriEnv) return;

    const resolveExternalTargetAt = (physX: number, physY: number) => {
      const dpr = window.devicePixelRatio || 1;
      // Try both CSS coordinates (phys / dpr) and raw coordinates in case backend already scaled
      const candidates = [
        { x: physX / dpr, y: physY / dpr },
        { x: physX, y: physY },
      ];
      for (const pt of candidates) {
        if (pt.x < 0 || pt.y < 0 || pt.x > window.innerWidth || pt.y > window.innerHeight) {
          continue;
        }
        const el = document.elementFromPoint(pt.x, pt.y) as HTMLElement | null;
        const dropEl = el?.closest("[data-drop-path]") as HTMLElement | null;
        if (dropEl) {
          const candidatePath = dropEl.getAttribute("data-drop-path");
          if (candidatePath && candidatePath !== "__RECENTS__") {
            const candidateName =
              dropEl.getAttribute("data-drop-name") ||
              folderDisplayName(candidatePath);
            return {
              targetPath: candidatePath,
              targetName: candidateName,
              isSpecificFolder: true,
            };
          }
        }
      }
      const curPath = activeTabRef.current?.path;
      if (curPath && curPath !== "__RECENTS__" && !activeTabRef.current?.activeTag) {
        return {
          targetPath: curPath,
          targetName: folderDisplayName(curPath),
          isSpecificFolder: false,
        };
      }
      return null;
    };

    let unlistenStart: (() => void) | null = null;
    let unlistenEnd: (() => void) | null = null;
    let unlistenUrlDrop: (() => void) | null = null;
    let unlistenFileDrop: (() => void) | null = null;
    let disposed = false;

    void listen<string[]>("outbound-drag-started", () => {
      if (disposed) return;
      outboundDragActiveRef.current = true;
      if (cancelInternalDragRef.current) {
        cancelInternalDragRef.current();
      } else {
        setDragState(null);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenStart = fn;
    });

    void listen("outbound-drag-ended", () => {
      if (disposed) return;
      outboundDragActiveRef.current = false;
      lastOutboundDragEndRef.current = Date.now();
      setExternalDropInfo(null);
      // Refresh source window after cross-window move completes in target window
      setTimeout(() => {
        if (!disposed) void loadCurrentEntries(true);
      }, 120);
      setTimeout(() => {
        if (!disposed) void loadCurrentEntries(true);
      }, 420);
      setTimeout(() => {
        if (!disposed) void loadCurrentEntries(true);
      }, 900);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenEnd = fn;
    });

    void listen<{ urls: string[]; x: number; y: number }>(
      "external-url-drop",
      async (ev) => {
        if (disposed) return;
        if (
          outboundDragActiveRef.current ||
          Date.now() - lastOutboundDragEndRef.current < 450
        ) {
          return;
        }
        const urls = ev.payload?.urls || [];
        if (urls.length === 0) return;

        lastUrlDropTimeRef.current = Date.now();
        const target = resolveExternalTargetAt(ev.payload.x, ev.payload.y);
        setExternalDropInfo(null);
        if (!target) {
          showToast("Open a folder first to drop web files");
          return;
        }

        try {
          showToast(`Saving ${urls.length} dropped item(s) to "${target.targetName}"...`);
          const saved = await runWithActivity(
            `Saving ${urls.length} dropped item(s)...`,
            async () => {
              const result = await apiSaveDroppedUrls(urls, target.targetPath);
              await loadCurrentEntries(true);
              return result;
            }
          );
          if (target.targetPath === activeTabRef.current?.path) {
            setSelectedPaths(saved);
          }
          showToast(`Saved ${saved.length} item(s) to "${target.targetName}"`);
        } catch (err) {
          showToast(`Failed to save dropped URL: ${err}`);
        }
      }
    ).then((fn) => {
      if (disposed) fn();
      else unlistenUrlDrop = fn;
    });

    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (disposed) return;
        const payload = event.payload;

        if (
          outboundDragActiveRef.current ||
          Date.now() - lastOutboundDragEndRef.current < 450
        ) {
          setExternalDropInfo(null);
          return;
        }

        if (payload.type === "enter" || payload.type === "over") {
          const target = resolveExternalTargetAt(
            payload.position.x,
            payload.position.y
          );
          if (!target) {
            setExternalDropInfo(null);
            return;
          }
          const isMove = await apiCheckFinderDrag(undefined, false);
          setExternalDropInfo({ ...target, isMove });
        } else if (payload.type === "leave") {
          setExternalDropInfo(null);
        } else if (payload.type === "drop") {
          const target = resolveExternalTargetAt(
            payload.position.x,
            payload.position.y
          );
          setExternalDropInfo(null);
          const droppedPaths = payload.paths || [];
          if (droppedPaths.length === 0 || !target) return;

          const destDir = target.targetPath;
          if (destDir === "__TRASH__") {
            try {
              await runWithActivity(
                `Moving ${droppedPaths.length} item(s) to Trash...`,
                async () => {
                  await apiTrashItems(droppedPaths);
                  await loadCurrentEntries(true);
                }
              );
              showToast(`Moved ${droppedPaths.length} item(s) to Trash`);
            } catch (err) {
              showToast(`${err}`);
            }
            return;
          }
          const validSources = droppedPaths.filter(
            (src) =>
              src !== destDir &&
              !destDir.startsWith(src + "/") &&
              getParentPath(src) !== destDir
          );
          if (validSources.length === 0) return;

          try {
            const isFinderMove = await apiCheckFinderDrag(validSources, true);
            if (isFinderMove) {
              const moved = await runWithActivity(
                `Moving ${validSources.length} item(s)...`,
                async () => {
                  const result = await apiMoveItems(validSources, destDir);
                  await loadCurrentEntries(true);
                  return result;
                }
              );
              recordMoveUndo(validSources, moved);
              if (destDir === activeTabRef.current?.path) {
                setSelectedPaths(moved);
              }
              showToast(
                `Moved ${moved.length} item(s) to "${target.targetName}"`
              );
            } else {
              const copied = await runWithActivity(
                `Copying ${validSources.length} item(s)...`,
                async () => {
                  const result = await apiCopyItems(validSources, destDir);
                  await loadCurrentEntries(true);
                  return result;
                }
              );
              if (destDir === activeTabRef.current?.path) {
                setSelectedPaths(copied);
              }
              showToast(
                `Copied ${copied.length} item(s) to "${target.targetName}"`
              );
            }
          } catch (err) {
            showToast(`${err}`);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlistenFileDrop = fn;
      });

    return () => {
      disposed = true;
      unlistenStart?.();
      unlistenEnd?.();
      unlistenUrlDrop?.();
      unlistenFileDrop?.();
    };
  }, [loadCurrentEntries, recordMoveUndo, runWithActivity, showToast]);

  // Listen for Tauri download manager events
  useEffect(() => {
    let disposed = false;
    let unlistenIntercepted: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;
    let unlistenCompleted: (() => void) | null = null;
    let unlistenFailed: (() => void) | null = null;

    void listen<InterceptedDownload>("external-download-intercepted", (ev) => {
      if (disposed || !ev.payload) return;
      enqueueDownload(ev.payload);
      void apiShowMainWindow();
    }).then((fn) => {
      if (disposed) fn();
      else unlistenIntercepted = fn;
    });

    // Check for any pending downloads buffered before React finished mounting
    const checkPending = async () => {
      try {
        const pending = await apiGetPendingDownloads();
        if (!disposed && pending && pending.length > 0) {
          for (const item of pending) {
            enqueueDownload(item);
          }
          void apiShowMainWindow();
        }
      } catch (err) {
        console.warn("Failed to check pending downloads:", err);
      }
    };

    void checkPending();
    const t1 = setTimeout(checkPending, 200);
    const t2 = setTimeout(checkPending, 600);
    const t3 = setTimeout(checkPending, 1200);

    void listen<DownloadProgressPayload>("download-progress", (ev) => {
      if (disposed || !ev.payload) return;
      const { id, downloadedBytes, totalBytes, speed, percentage } = ev.payload;
      setDownloads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                downloadedBytes,
                totalBytes: totalBytes > 0 ? totalBytes : item.totalBytes,
                speed,
                percentage,
              }
            : item
        )
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlistenProgress = fn;
    });

    void listen<DownloadCompletedPayload>("download-completed", (ev) => {
      if (disposed || !ev.payload) return;
      const { id, targetPath, filename, totalBytes } = ev.payload;
      setDownloads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "completed",
                totalBytes,
                downloadedBytes: totalBytes,
                percentage: 100,
                finishedAt: Date.now(),
              }
            : item
        )
      );

      showToast(`Downloaded “${filename}”`);

      // If current active folder matches the download folder, refresh view
      const targetDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
      if (activeTabRef.current && activeTabRef.current.path === targetDir) {
        void loadCurrentEntries(true);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenCompleted = fn;
    });

    void listen<DownloadFailedPayload>("download-failed", (ev) => {
      if (disposed || !ev.payload) return;
      const { id, error } = ev.payload;
      setDownloads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "failed",
                error,
              }
            : item
        )
      );
      showToast(`Download failed: ${error}`);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenFailed = fn;
    });

    return () => {
      disposed = true;
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      unlistenIntercepted?.();
      unlistenProgress?.();
      unlistenCompleted?.();
      unlistenFailed?.();
    };
  }, [enqueueDownload, loadCurrentEntries, showToast]);

  const handleConfirmDownload = useCallback(
    async (destinationDir: string, filename: string) => {
      if (!pendingDownload) return;
      const download = pendingDownload;
      setDownloadQueue((prev) => prev.filter((d) => d.id !== download.id));

      const targetPath = `${destinationDir.replace(/\/$/, "")}/${filename}`;
      const downloadItem: DownloadItem = {
        id: download.id,
        filename,
        targetPath,
        targetDir: destinationDir,
        url: download.url,
        totalBytes: download.totalBytes,
        downloadedBytes: 0,
        speed: 0,
        percentage: 0,
        status: "downloading",
        startedAt: Date.now(),
      };

      setDownloads((prev) => [downloadItem, ...prev.filter((d) => d.id !== download.id)]);
      setDownloadsPopoverOpen(true);
      showToast(`Starting download: ${filename}`);

      try {
        await apiStartDownload({
          id: download.id,
          url: download.url,
          targetPath,
          totalBytes: download.totalBytes,
          referrer: download.referrer || null,
          userAgent: download.userAgent || null,
          cookies: download.cookies || null,
          blobBase64: download.blobData || null,
        });
      } catch (err) {
        showToast(`Failed to start download: ${err}`);
      }
    },
    [pendingDownload, showToast]
  );

  const handleCancelDownload = useCallback(async (id: string) => {
    try {
      await apiCancelDownload(id);
      setDownloads((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status: "cancelled" } : d))
      );
    } catch (err) {
      console.warn("Cancel download error:", err);
    }
  }, []);

  const handleDismissPendingDownload = useCallback(async (id: string) => {
    setDownloadQueue((prev) => prev.filter((d) => d.id !== id));
    void apiCancelDownload(id).catch(() => {});
    await apiCloseMainWindow();
  }, []);

  const handleShowInFolder = useCallback(
    (targetPath: string) => {
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/")) || "/";
      navigateTo(parentDir);
      setSelectedPaths([targetPath]);
      setDownloadsPopoverOpen(false);
    },
    [navigateTo]
  );

  const handleOpenFile = useCallback(
    async (targetPath: string) => {
      try {
        await apiOpenItem(targetPath);
      } catch (err) {
        showToast(`Could not open file: ${err}`);
      }
    },
    [showToast]
  );

  const handleClearCompletedDownloads = useCallback(() => {
    setDownloads((prev) => prev.filter((d) => d.status === "downloading"));
  }, []);

  const handleManualDownloadUrl = useCallback((url: string) => {
    const rawName = url.split("?")[0].split("#")[0].split("/").pop() || "downloaded-file";
    const filename = decodeURIComponent(rawName);
    enqueueDownload({
      id: `manual-${Date.now()}`,
      url,
      originalUrl: url,
      filename,
      totalBytes: -1,
    });
  }, [enqueueDownload]);

  const handleSelectVolume = useCallback(
    async (vol: VolumeInfo) => {
      if (vol.isMounted && vol.mountPoint) {
        navigateTo(vol.mountPoint, vol.name);
        return;
      }
      try {
        const mountedPath = await runWithActivity(`Mounting ${vol.name}...`, async () => {
          const path = await apiMountPartition(vol.device);
          await refreshSidebar();
          return path;
        });
        navigateTo(mountedPath, vol.name);
        showToast(`Mounted ${vol.name}`);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("AUTH_REQUIRED")) {
          setSudoPrompt({
            action: "mount",
            volumeName: vol.name,
            device: vol.device,
            error: null,
            busy: false,
          });
        } else {
          showToast(msg);
        }
      }
    },
    [navigateTo, refreshSidebar, runWithActivity, showToast]
  );

  const handleUnmountVolume = useCallback(
    async (vol: VolumeInfo) => {
      try {
        await runWithActivity(`Ejecting ${vol.name}...`, () =>
          apiUnmountPartition(vol.device)
        );
        if (
          activeTab &&
          vol.mountPoint &&
          (activeTab.path === vol.mountPoint ||
            activeTab.path.startsWith(vol.mountPoint + "/"))
        ) {
          navigateTo(sidebarData?.homeDir || "/", "Home");
        }
        await refreshSidebar();
        showToast(`Ejected ${vol.name}`);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("AUTH_REQUIRED")) {
          setSudoPrompt({
            action: "unmount",
            volumeName: vol.name,
            device: vol.device,
            error: null,
            busy: false,
          });
        } else {
          showToast(msg);
        }
      }
    },
    [activeTab, navigateTo, refreshSidebar, runWithActivity, sidebarData?.homeDir, showToast]
  );

  const handleFormatSubmit = useCallback(
    async (
      volume: VolumeInfo,
      fstype: string,
      label: string,
      password?: string
    ) => {
      await apiFormatPartition(volume.device, fstype, label, password);
      setFormatVolume(null);
      await refreshSidebar();
      showToast(`Formatted “${label || volume.name}”`);
    },
    [refreshSidebar, showToast]
  );

  const handleFirstAidRun = useCallback(
    async (volume: VolumeInfo, password?: string): Promise<string> => {
      return await apiCheckPartition(volume.device, password);
    },
    []
  );

  const handleSudoSubmit = useCallback(
    async (password: string) => {
      if (!sudoPrompt) return;
      setSudoPrompt((prev) =>
        prev ? { ...prev, busy: true, error: null } : null
      );
      try {
        if (sudoPrompt.action === "elevate") {
          await apiElevateToRootSession(password);
          setSudoPrompt(null);
        } else if (sudoPrompt.action === "mount") {
          const mountedPath = await apiMountPartition(
            sudoPrompt.device,
            password
          );
          setSudoPrompt(null);
          await refreshSidebar();
          navigateTo(mountedPath, sudoPrompt.volumeName);
          showToast(`Mounted ${sudoPrompt.volumeName}`);
        } else if (sudoPrompt.action === "unmount") {
          await apiUnmountPartition(sudoPrompt.device, password);
          setSudoPrompt(null);
          await refreshSidebar();
          showToast(`Ejected ${sudoPrompt.volumeName}`);
        } else if (sudoPrompt.action === "format") {
          const fstype = sudoPrompt.extra?.fstype || "vfat";
          const label = sudoPrompt.extra?.label || "";
          await apiFormatPartition(sudoPrompt.device, fstype, label, password);
          setSudoPrompt(null);
          await refreshSidebar();
          showToast(`Formatted “${label || sudoPrompt.volumeName}”`);
        } else if (sudoPrompt.action === "firstaid") {
          await apiCheckPartition(sudoPrompt.device, password);
          setSudoPrompt(null);
          showToast(`First Aid check completed for ${sudoPrompt.volumeName}`);
        }
      } catch (err) {
        const msg = String(err);
        setSudoPrompt((prev) =>
          prev
            ? {
                ...prev,
                busy: false,
                error: msg.includes("INVALID_PASSWORD")
                  ? "Incorrect sudo password. Please try again."
                  : msg,
              }
            : null
        );
      }
    },
    [sudoPrompt, navigateTo, refreshSidebar, showToast]
  );

  // Sort handler
  const handleChangeSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDirection("asc");
      }
    },
    [sortField]
  );

  // Selected primary entry helper (O(1) set lookup + nested folder fallback)
  const primarySelectedEntry = useMemo(() => {
    if (selectedPaths.length === 0) return null;
    const set = new Set(selectedPaths);
    return (
      sortedEntries.find((e) => set.has(e.path)) ||
      knownEntriesMapRef.current.get(selectedPaths[0]) ||
      null
    );
  }, [sortedEntries, selectedPaths]);

  // Auto-scroll entry into view helper
  const scrollEntryIntoView = useCallback((
    path: string,
    index?: number,
    block: ScrollLogicalPosition = "nearest",
    inline: ScrollLogicalPosition = "nearest",
    onCentered?: () => void
  ) => {
    const centerWithin = (container: HTMLElement, element: HTMLElement, axis: "x" | "y") => {
      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      if (axis === "y") {
        const viewportCenter = containerRect.top + container.clientTop + container.clientHeight / 2;
        const elementCenter = elementRect.top + elementRect.height / 2;
        container.scrollTop += elementCenter - viewportCenter;
      } else {
        const viewportCenter = containerRect.left + container.clientLeft + container.clientWidth / 2;
        const elementCenter = elementRect.left + elementRect.width / 2;
        container.scrollLeft += elementCenter - viewportCenter;
      }
    };

    const scheduleScroll = (attemptsRemaining: number, virtualPositionApplied: boolean) => {
      const performScroll = () => {
      try {
        const viewContainers = Array.from(
          document.querySelectorAll<HTMLElement>(`[data-tab-scroll-view="${viewMode}"]`)
        );
        const iconContainer = viewContainers[0];
        const el = viewContainers
          .flatMap((container) => Array.from(container.querySelectorAll<HTMLElement>("[data-entry-path]")))
          .find((element) => element.getAttribute("data-entry-path") === path);
        if (el) {
          let hasLayout = false;
          if (block === "center") {
            let verticalScroller: HTMLElement | null = el.parentElement;
            while (
              verticalScroller &&
              verticalScroller !== iconContainer &&
              verticalScroller.scrollHeight <= verticalScroller.clientHeight + 1
            ) {
              verticalScroller = verticalScroller.parentElement;
            }
            if (verticalScroller && verticalScroller.clientHeight > 0 && el.getBoundingClientRect().height > 0) {
              centerWithin(verticalScroller, el, "y");
              hasLayout = true;
            }

            if (inline === "center") {
              let horizontalScroller: HTMLElement | null = el.parentElement;
              while (
                horizontalScroller &&
                horizontalScroller !== iconContainer &&
                horizontalScroller.scrollWidth <= horizontalScroller.clientWidth + 1
              ) {
                horizontalScroller = horizontalScroller.parentElement;
              }
              if (horizontalScroller && horizontalScroller.clientWidth > 0 && el.getBoundingClientRect().width > 0) {
                centerWithin(horizontalScroller, el, "x");
                hasLayout = true;
              }
            }
          } else {
            el.scrollIntoView({ block, inline });
            hasLayout = true;
          }
          if (onCentered && !hasLayout) {
            if (attemptsRemaining > 0) {
              window.setTimeout(() => scheduleScroll(attemptsRemaining - 1, virtualPositionApplied), 20);
            }
            return;
          }
          if (onCentered) window.setTimeout(onCentered, 80);
          return;
        }

        if (!virtualPositionApplied && typeof index === "number" && index >= 0 && viewMode === "icons") {
          if (iconContainer) {
            const container = iconContainer;
            const cellWidth = Math.max(96, iconSize + 44);
            const contentWidth = Math.max(0, container.clientWidth - 40);
            const columns = Math.max(
              1,
              Math.floor((contentWidth + 12) / (cellWidth + 12))
            );
            const rowPitch = iconSize + 73;
            const targetTop = 20 + Math.floor(index / columns) * rowPitch;
            container.scrollTop = block === "center"
              ? Math.max(0, targetTop - (container.clientHeight - rowPitch) / 2)
              : targetTop;
          }
        }
      } catch {
        // ignore
      }
      if (attemptsRemaining > 0) {
        window.setTimeout(() => scheduleScroll(attemptsRemaining - 1, true), 20);
      }
      };
      if (onCentered) window.setTimeout(performScroll, 0);
      else requestAnimationFrame(performScroll);
    };

    scheduleScroll(onCentered ? 30 : 4, false);
  }, [viewMode, iconSize]);

  useEffect(() => {
    if (!pendingRevealScrollPath) return;
    const index = sortedEntries.findIndex((entry) => entry.path === pendingRevealScrollPath);
    scrollEntryIntoView(
      pendingRevealScrollPath,
      index >= 0 ? index : undefined,
      "center",
      "center",
      () => {
        const current = pendingFileManagerRevealRef.current;
        if (
          !current?.selectedPaths.some((path) =>
            path === pendingRevealScrollPath ||
            path.split(/[\\/]/).pop() === pendingRevealScrollPath.split(/[\\/]/).pop()
          )
        ) return;
        setPendingRevealScrollPath(null);
        setPendingFileManagerReveal(null);
        windowShownRef.current = true;
        void apiShowMainWindow();
      }
    );
  }, [pendingRevealScrollPath, sortedEntries, scrollEntryIntoView]);

  useLayoutEffect(() => {
    if (!renamingPath) return;
    const index = sortedEntries.findIndex((entry) => entry.path === renamingPath);
    scrollEntryIntoView(renamingPath, index >= 0 ? index : undefined);
  }, [renamingPath, sortedEntries, scrollEntryIntoView]);

  const typeAheadBufferRef = useRef("");
  const typeAheadTimerRef = useRef<number | null>(null);

  // Global macOS Finder Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmdOrCtrl = e.ctrlKey;

      // Focus the toolbar search field (and select its query) from anywhere.
      if (cmdOrCtrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>("[data-file-search]");
        searchInput?.focus();
        searchInput?.select();
        return;
      }

      if (e.key === "Escape") {
        const searchInput = document.querySelector<HTMLInputElement>("[data-file-search]");
        if (document.activeElement === searchInput) {
          e.preventDefault();
          setSearchQuery("");
          searchInput?.blur();
          return;
        }
      }

      // Zoom In: Ctrl + Plus / Equal (always active)
      if (
        cmdOrCtrl &&
        (e.key === "+" ||
          e.key === "=" ||
          e.code === "NumpadAdd" ||
          e.code === "Equal")
      ) {
        e.preventDefault();
        setIconSize((prev) => {
          const next = Math.min(144, prev + 12);
          showToast(`Zoom: ${Math.round((next / 64) * 100)}%`);
          return next;
        });
        return;
      }

      // Zoom Out: Ctrl + Minus / Underscore (always active)
      if (
        cmdOrCtrl &&
        (e.key === "-" ||
          e.key === "_" ||
          e.code === "NumpadSubtract" ||
          e.code === "Minus")
      ) {
        e.preventDefault();
        setIconSize((prev) => {
          const next = Math.max(40, prev - 12);
          showToast(`Zoom: ${Math.round((next / 64) * 100)}%`);
          return next;
        });
        return;
      }

      // Zoom Reset: Ctrl + 0 (always active)
      if (
        cmdOrCtrl &&
        (e.key === "0" || e.code === "Numpad0" || e.code === "Digit0")
      ) {
        e.preventDefault();
        setIconSize(64);
        showToast("Zoom: 100% (Default)");
        return;
      }

      // Ctrl + 1/2/3/4 -> Switch View Mode (always active)
      if (cmdOrCtrl && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        const map: Record<string, ViewMode> = {
          "1": "icons",
          "2": "list",
          "3": "columns",
          "4": "gallery",
        };
        setViewMode(map[e.key]);
        return;
      }

      // Toggle Sidebar: Ctrl + Alt + S or Ctrl + B
      if (
        (cmdOrCtrl && e.altKey && e.key.toLowerCase() === "s") ||
        (cmdOrCtrl && !e.altKey && e.key.toLowerCase() === "b")
      ) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      const targetEl = e.target as HTMLInputElement | null;
      const tag = targetEl?.tagName;
      if (trashConfirmModal) {
        if (e.key === "Escape") {
          e.preventDefault();
          setTrashConfirmModal(null);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          void confirmTrashAction();
          return;
        }
      }
      // Delete / Supr moves selected files to Trash, even while search has focus.
      const isDeleteKey =
        e.key === "Delete" ||
        e.key === "Del" ||
        e.code === "Delete" ||
        e.keyCode === 46;
      if (isDeleteKey) {
        e.preventDefault();
        if (activeTab?.path === "__TRASH__") {
          handleDeletePermanently();
        } else {
          handleTrash();
        }
        return;
      }
      if (
        e.code === "Space" &&
        !cmdOrCtrl &&
        targetEl?.hasAttribute("data-file-search")
      ) {
        e.preventDefault();
        if (quickLookEntry) {
          setQuickLookEntry(null);
        } else if (primarySelectedEntry) {
          setQuickLookEntry(primarySelectedEntry);
        }
        return;
      }
      if (
        tag === "TEXTAREA" ||
        (tag === "INPUT" && targetEl?.type !== "range")
      ) {
        return;
      }

      // Ctrl+Z -> Undo the last file move.
      if (cmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void handleUndo();
        return;
      }

      // Ctrl + A -> Select All items in current folder
      if (cmdOrCtrl && e.key.toLowerCase() === "a") {
        e.preventDefault();
        if (splitPaneHoveredRef.current && splitPaneSelectAllRef.current) {
          splitPaneSelectAllRef.current();
        } else {
          setSelectedPaths(sortedEntries.map((item) => item.path));
        }
        return;
      }

      // Spacebar -> Toggle Quick Look
      if (e.code === "Space" && !cmdOrCtrl) {
        e.preventDefault();
        if (quickLookEntry) {
          setQuickLookEntry(null);
        } else if (primarySelectedEntry) {
          setQuickLookEntry(primarySelectedEntry);
        }
        return;
      }

      // Escape -> Close modals, cancel pending download, or clear selection
      if (e.key === "Escape") {
        if (pendingDownload) handleDismissPendingDownload(pendingDownload.id);
        else if (openWithEntry) setOpenWithEntry(null);
        else if (quickLookEntry) setQuickLookEntry(null);
        else if (getInfoEntry || getInfoVolume) {
          setGetInfoEntry(null);
          setGetInfoVolume(null);
        } else if (contextMenu) setContextMenu(null);
        else setSelectedPaths([]);
        return;
      }

      // F2 -> Rename selected item
      if (
        e.key === "F2" &&
        primarySelectedEntry &&
        !renamingPath
      ) {
        e.preventDefault();
        startRename(primarySelectedEntry);
        return;
      }

      // Ctrl + O or Ctrl + Down -> Open item(s)
      if (cmdOrCtrl && (e.key.toLowerCase() === "o" || e.key === "ArrowDown")) {
        if (primarySelectedEntry) {
          e.preventDefault();
          handleOpenEntry(primarySelectedEntry);
        }
        return;
      }

      // Ctrl + Up or Alt + Up -> Go to parent folder (cd ..)
      if ((cmdOrCtrl || e.altKey) && e.key === "ArrowUp") {
        if (canGoUp) {
          e.preventDefault();
          goUp();
        }
        return;
      }

      // Alt + Left / Alt + Right -> Back / Forward
      if (e.altKey && e.key === "ArrowLeft") {
        if ((activeTab?.historyIndex ?? 0) > 0) {
          e.preventDefault();
          goBack();
        }
        return;
      }
      if (e.altKey && e.key === "ArrowRight") {
        if ((activeTab?.historyIndex ?? 0) < (activeTab?.history.length ?? 1) - 1) {
          e.preventDefault();
          goForward();
        }
        return;
      }

      // Arrow navigation, Home/End, and Type-Ahead search (desktop file explorer standard)
      if (!cmdOrCtrl && !e.altKey && !renamingPath && sortedEntries.length > 0) {
        // Home -> First item
        if (e.key === "Home") {
          e.preventDefault();
          const first = sortedEntries[0];
          if (first) {
            setSelectedPaths([first.path]);
            lastSelectedPathRef.current = first.path;
            scrollEntryIntoView(first.path, 0);
            if (quickLookEntry) setQuickLookEntry(first);
          }
          return;
        }

        // End -> Last item
        if (e.key === "End") {
          e.preventDefault();
          const lastIdx = sortedEntries.length - 1;
          const last = sortedEntries[lastIdx];
          if (last) {
            setSelectedPaths([last.path]);
            lastSelectedPathRef.current = last.path;
            scrollEntryIntoView(last.path, lastIdx);
            if (quickLookEntry) setQuickLookEntry(last);
          }
          return;
        }

        // Arrow Keys
        if (
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight"
        ) {
          e.preventDefault();
          const curIdx = primarySelectedEntry
            ? sortedEntries.findIndex((item) => item.path === primarySelectedEntry.path)
            : -1;

          let targetIdx = curIdx;
          if (viewMode === "icons") {
            let cols = 1;
            const el = primarySelectedEntry
              ? document.querySelector(`[data-entry-path="${CSS.escape(primarySelectedEntry.path)}"]`)
              : null;
            if (el?.parentElement) {
              const parentW = el.parentElement.clientWidth;
              const itemW = (el as HTMLElement).offsetWidth || 110;
              cols = Math.max(1, Math.round(parentW / (itemW + 12)));
            } else {
              cols = Math.max(1, Math.round(window.innerWidth / (iconSize + 56)));
            }

            if (e.key === "ArrowRight") targetIdx = curIdx === -1 ? 0 : Math.min(sortedEntries.length - 1, curIdx + 1);
            else if (e.key === "ArrowLeft") targetIdx = curIdx === -1 ? 0 : Math.max(0, curIdx - 1);
            else if (e.key === "ArrowDown") targetIdx = curIdx === -1 ? 0 : Math.min(sortedEntries.length - 1, curIdx + cols);
            else if (e.key === "ArrowUp") targetIdx = curIdx === -1 ? sortedEntries.length - 1 : Math.max(0, curIdx - cols);
          } else {
            // List / Columns / Gallery
            if (e.key === "ArrowDown") targetIdx = curIdx === -1 ? 0 : Math.min(sortedEntries.length - 1, curIdx + 1);
            else if (e.key === "ArrowUp") targetIdx = curIdx === -1 ? sortedEntries.length - 1 : Math.max(0, curIdx - 1);
            else if (e.key === "ArrowRight") {
              if (curIdx !== -1) {
                targetIdx = Math.min(sortedEntries.length - 1, curIdx + 1);
              }
            } else if (e.key === "ArrowLeft") {
              if (curIdx !== -1) {
                targetIdx = Math.max(0, curIdx - 1);
              }
            }
          }

          if (targetIdx >= 0 && targetIdx < sortedEntries.length) {
            const targetEntry = sortedEntries[targetIdx];
            if (e.shiftKey) {
              const anchorIdx = lastSelectedPathRef.current
                ? sortedEntries.findIndex((item) => item.path === lastSelectedPathRef.current)
                : curIdx !== -1
                ? curIdx
                : 0;
              const start = Math.min(anchorIdx, targetIdx);
              const end = Math.max(anchorIdx, targetIdx);
              const range = sortedEntries.slice(start, end + 1).map((item) => item.path);
              setSelectedPaths(range);
            } else {
              setSelectedPaths([targetEntry.path]);
              lastSelectedPathRef.current = targetEntry.path;
            }
            scrollEntryIntoView(targetEntry.path, targetIdx);
            if (quickLookEntry) {
              setQuickLookEntry(targetEntry);
            }
          }
          return;
        }

        // Type-Ahead Search (jump by typing filename)
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (typeAheadTimerRef.current !== null) {
            window.clearTimeout(typeAheadTimerRef.current);
          }
          typeAheadBufferRef.current += e.key;
          typeAheadTimerRef.current = window.setTimeout(() => {
            typeAheadBufferRef.current = "";
          }, 750);

          const query = typeAheadBufferRef.current.toLowerCase();
          let match: FileEntry | undefined;
          let matchIdx = -1;

          if (typeAheadBufferRef.current.length === 1 && primarySelectedEntry) {
            const curIdx = sortedEntries.findIndex(
              (item) => item.path === primarySelectedEntry.path
            );
            // Cycle forward from current item
            const afterIdx = sortedEntries
              .slice(curIdx + 1)
              .findIndex((item) => item.name.toLowerCase().startsWith(query));
            if (afterIdx !== -1) {
              matchIdx = curIdx + 1 + afterIdx;
              match = sortedEntries[matchIdx];
            } else {
              matchIdx = sortedEntries.findIndex((item) =>
                item.name.toLowerCase().startsWith(query)
              );
              if (matchIdx !== -1) match = sortedEntries[matchIdx];
            }
          } else {
            matchIdx = sortedEntries.findIndex((item) =>
              item.name.toLowerCase().startsWith(query)
            );
            if (matchIdx === -1) {
              matchIdx = sortedEntries.findIndex((item) =>
                item.name.toLowerCase().includes(query)
              );
            }
            if (matchIdx !== -1) match = sortedEntries[matchIdx];
          }

          if (match && matchIdx !== -1) {
            e.preventDefault();
            setSelectedPaths([match.path]);
            lastSelectedPathRef.current = match.path;
            scrollEntryIntoView(match.path, matchIdx);
            if (quickLookEntry) {
              setQuickLookEntry(match);
            }
            return;
          }
        }
      }

      // Ctrl + I -> Get Info
      if (cmdOrCtrl && e.key.toLowerCase() === "i") {
        e.preventDefault();
        if (primarySelectedEntry) {
          setGetInfoEntry(primarySelectedEntry);
        }
        return;
      }

      // Ctrl + T -> New Tab
      if (cmdOrCtrl && e.key.toLowerCase() === "t") {
        e.preventDefault();
        handleNewTab();
        return;
      }

      // Ctrl + R or F5 -> Reload Folder
      if (e.key === "F5" || (cmdOrCtrl && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        loadCurrentEntries(true);
        return;
      }

      // Ctrl + Shift + . -> Toggle Hidden Dotfiles
      if (cmdOrCtrl && e.shiftKey && e.key === ".") {
        e.preventDefault();
        setShowHidden((v) => !v);
        return;
      }

      // Ctrl + Shift + N -> New Folder
      if (cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNewFolder();
        return;
      }

      // Ctrl + C / X / V / D
      if (cmdOrCtrl && e.key.toLowerCase() === "c") {
        e.preventDefault();
        handleCopy();
        return;
      }
      if (cmdOrCtrl && e.key.toLowerCase() === "x") {
        e.preventDefault();
        handleCut();
        return;
      }
      if (cmdOrCtrl && e.key.toLowerCase() === "v") {
        e.preventDefault();
        handlePaste(
          splitPaneHoveredRef.current ? splitPane?.path : undefined
        );
        return;
      }
      if (cmdOrCtrl && e.key.toLowerCase() === "d" && selectedPaths.length > 0) {
        e.preventDefault();
        handleDuplicate();
        return;
      }

      // Ctrl+Backspace -> Move to Trash (or permanently delete if in Trash)
      if (cmdOrCtrl && e.key === "Backspace") {
        e.preventDefault();
        if (activeTab?.path === "__TRASH__") {
          handleDeletePermanently();
        } else {
          handleTrash();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    sortedEntries,
    selectedPaths,
    openWithEntry,
    quickLookEntry,
    getInfoEntry,
    getInfoVolume,
    contextMenu,
    trashConfirmModal,
    confirmTrashAction,
    handleDeletePermanently,
    primarySelectedEntry,
    renamingPath,
    activeTab,
    startRename,
    handleOpenEntry,
    navigateTo,
    handleNewTab,
    handleNewFolder,
    handleCopy,
    handleCut,
    handlePaste,
    splitPane,
    handleDuplicate,
    handleTrash,
    handleUndo,
    showToast,
    setIconSize,
    setViewMode,
    scrollEntryIntoView,
    toggleSidebar,
  ]);

  // Global prevention for trackpad pinch-to-zoom and WebKit context menu
  useEffect(() => {
    const handleGlobalContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };
    const handleTouch = (e: TouchEvent) => {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
      }
    };
    const handleGesture = (e: Event) => {
      e.preventDefault();
    };

    window.addEventListener("contextmenu", handleGlobalContextMenu);
    window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    document.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    window.addEventListener("touchstart", handleTouch, { passive: false, capture: true });
    window.addEventListener("touchmove", handleTouch, { passive: false, capture: true });
    document.addEventListener("touchstart", handleTouch, { passive: false, capture: true });
    document.addEventListener("touchmove", handleTouch, { passive: false, capture: true });
    window.addEventListener("gesturestart", handleGesture, { passive: false, capture: true });
    window.addEventListener("gesturechange", handleGesture, { passive: false, capture: true });
    window.addEventListener("gestureend", handleGesture, { passive: false, capture: true });

    return () => {
      window.removeEventListener("contextmenu", handleGlobalContextMenu);
      window.removeEventListener("wheel", handleWheel, { capture: true });
      document.removeEventListener("wheel", handleWheel, { capture: true });
      window.removeEventListener("touchstart", handleTouch, { capture: true });
      window.removeEventListener("touchmove", handleTouch, { capture: true });
      document.removeEventListener("touchstart", handleTouch, { capture: true });
      document.removeEventListener("touchmove", handleTouch, { capture: true });
      window.removeEventListener("gesturestart", handleGesture, { capture: true });
      window.removeEventListener("gesturechange", handleGesture, { capture: true });
      window.removeEventListener("gestureend", handleGesture, { capture: true });
    };
  }, []);

  const availableDiskSpace = useMemo(() => {
    if (!sidebarData?.volumes?.length) return 0;
    const rootVol =
      sidebarData.volumes.find((v) => v.mountPoint === "/") ||
      sidebarData.volumes[0];
    return rootVol?.availableSpace || 0;
  }, [sidebarData]);

  const handleClearSelection = useCallback(() => {
    setSelectedPaths([]);
    lastSelectedPathRef.current = null;
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry?: FileEntry, targetDir?: string) => {
      e.preventDefault();
      if (entry && !selectedPathsRef.current.includes(entry.path)) {
        setSelectedPaths([entry.path]);
        lastSelectedPathRef.current = entry.path;
      }
      setContextMenu({ x: e.clientX, y: e.clientY, entry, targetDir });
    },
    []
  );

  const handleContextMenuFavorite = useCallback(
    (
      e: React.MouseEvent,
      fav: { name: string; path: string; isCustom?: boolean }
    ) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        favorite: fav,
      });
    },
    []
  );

  const handleContextMenuVolume = useCallback(
    (e: React.MouseEvent, vol: VolumeInfo) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        volume: vol,
      });
    },
    []
  );

  const handleGetVolumeInfo = useCallback((vol: VolumeInfo) => {
    setGetInfoEntry(null);
    setGetInfoVolume(vol);
  }, []);

  const handleGetFavoriteInfo = useCallback(
    async (path: string, name?: string) => {
      try {
        const entry = await apiGetFileInfo(path);
        setGetInfoVolume(null);
        setGetInfoEntry(entry);
      } catch (err) {
        showToast(`Could not get info for ${name || path}: ${err}`);
      }
    },
    [showToast]
  );

  const handleSetFileExecutable = useCallback(
    async (path: string, executable: boolean) => {
      try {
        await apiSetFileExecutable(path, executable);
        await loadCurrentEntries(true);
        setGetInfoEntry(await apiGetFileInfo(path));
      } catch (error) {
        showToast(`Could not update executable permission: ${error}`);
      }
    },
    [loadCurrentEntries, showToast]
  );

  const handleCancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleQuickLook = useCallback(() => {
    if (primarySelectedEntry) setQuickLookEntry(primarySelectedEntry);
  }, [primarySelectedEntry]);

  const activeDropTargetPath =
    dragState?.dropTargetPath ||
    (externalDropInfo?.isSpecificFolder ? externalDropInfo.targetPath : null);
  const archiveRoot = activeTab?.archiveWorkspaceRoot?.replace(/\\/g, "/").replace(/\/$/, "");
  const activePath = activeTab?.path.replace(/\\/g, "/").replace(/\/$/, "") || "";
  const isArchiveWorkspace = Boolean(
    archiveRoot &&
      (activePath === archiveRoot || activePath.startsWith(`${archiveRoot}/`))
  );

  const commonViewProps = {
    entries: sortedEntries,
    revealPath: pendingRevealScrollPath,
    isArchiveWorkspace,
    selectedPaths,
    onSelect: handleSelectEntry,
    onSetSelection: setSelectedPaths,
    onClearSelection: handleClearSelection,
    onOpenEntry: handleOpenEntry,
    onContextMenu: handleContextMenu,
    onStartItemDrag: handleStartItemDrag,
    dropTargetPath: activeDropTargetPath,
    // Cut items share the subdued treatment used for actively dragged items.
    draggedPaths: [
      ...(dragState?.paths || []),
      ...(clipboard?.mode === "cut" ? clipboard.paths : []),
    ],
    refreshVersion,
    renamingPath,
    renameValue,
    onRenameChange: setRenameValue,
    onStartRename: startRename,
    onRenameSubmit: submitRename,
    onRenameCancel: handleCancelRename,
    darkMode,
    iconSize,
    sortField,
    sortDirection,
    onChangeSort: handleChangeSort,
    showHidden,
    onToggleTag: handleToggleTag,
    onQuickLook: handleQuickLook,
  };

  const handleNativeDomDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleNativeDomDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setExternalDropInfo(null);
      if (
        outboundDragActiveRef.current ||
        Date.now() - lastOutboundDragEndRef.current < 450 ||
        Date.now() - lastUrlDropTimeRef.current < 600
      ) {
        return;
      }
      const uriList =
        e.dataTransfer?.getData("text/uri-list") ||
        e.dataTransfer?.getData("text/plain") ||
        "";
      const urls = uriList
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(
          (s) =>
            !s.startsWith("#") &&
            (s.startsWith("http://") ||
              s.startsWith("https://") ||
              s.startsWith("data:"))
        );
      if (urls.length === 0) return;

      const el = document.elementFromPoint(
        e.clientX,
        e.clientY
      ) as HTMLElement | null;
      const dropEl = el?.closest("[data-drop-path]") as HTMLElement | null;
      const destPath =
        dropEl?.getAttribute("data-drop-path") || activeTabRef.current?.path;
      if (!destPath || destPath === "__RECENTS__") return;
      const destName =
        dropEl?.getAttribute("data-drop-name") || folderDisplayName(destPath);

      try {
        lastUrlDropTimeRef.current = Date.now();
        showToast(`Saving ${urls.length} dropped item(s) to "${destName}"...`);
        const saved = await runWithActivity(
          `Saving ${urls.length} dropped item(s)...`,
          async () => {
            const result = await apiSaveDroppedUrls(urls, destPath);
            await loadCurrentEntries(true);
            return result;
          }
        );
        if (destPath === activeTabRef.current?.path) {
          setSelectedPaths(saved);
        }
        showToast(`Saved ${saved.length} item(s) to "${destName}"`);
      } catch (err) {
        showToast(`Failed to save dropped URL: ${err}`);
      }
    },
    [loadCurrentEntries, runWithActivity, showToast]
  );

  return (
    <div
      ref={appShellRef}
      onDragOver={handleNativeDomDragOver}
      onDrop={handleNativeDomDrop}
      className={`w-screen h-screen flex flex-col overflow-hidden macos-window-shadow border ${
        darkMode
          ? "bg-[#202024] text-zinc-100 border-white/15"
          : "bg-[#f2f2f5] text-zinc-900 border-black/15"
      }`}
    >
      {/* Top Unified macOS Finder Toolbar & Tab Strip */}
      <Toolbar
        currentTitle={activeTab?.title || "vFinder"}
        canGoBack={(activeTab?.historyIndex ?? 0) > 0}
        canGoForward={
          (activeTab?.historyIndex ?? 0) <
          (activeTab?.history.length ?? 1) - 1
        }
        canGoUp={canGoUp}
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
        sortField={sortField}
        sortDirection={sortDirection}
        onChangeSort={handleChangeSort}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden((v) => !v)}
        onNewFolder={handleNewFolder}
        onNewFile={handleNewFile}
        onGetInfo={() => {
          if (primarySelectedEntry) {
            setGetInfoVolume(null);
            setGetInfoEntry(primarySelectedEntry);
          } else {
            showToast("Select a file or folder first to inspect");
          }
        }}
        onRefresh={() => loadCurrentEntries(true)}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((v) => !v)}
        tabs={splitPane ? tabs.filter((tab) => tab.id !== splitPane.tabId) : tabs}
        activeTabId={activeTabId}
        splitTab={splitPane ? {
          id: splitPane.tabId,
          title: splitPane.title,
          path: splitPane.path,
          archiveWorkspaceRoot: splitPane.archiveWorkspaceRoot,
        } : null}
        splitTabLeft={splitTabLeft}
        tabStripStartOffset={sidebarLayoutOpen ? 240 : 0}
        canSplitTab={tabs.length >= 2}
        onSelectTab={handleSelectTab}
        onSplitTab={handleSplitTab}
        onCloseSplitPane={() => {
          if (splitPane) handleCloseTab(splitPane.tabId);
          closeSplitPane();
        }}
        onReorderTabs={handleReorderTabs}
        onNewTab={handleNewTab}
        onCloseTab={handleCloseTab}
        dropTargetPath={activeDropTargetPath}
        activeDownloadsCount={
          downloads.filter((d) => d.status === "downloading").length
        }
        downloadsOpen={downloadsPopoverOpen}
        onToggleDownloads={() => setDownloadsPopoverOpen((v) => !v)}
        isRoot={Boolean(sidebarData?.isRoot)}
        isTrashActive={activeTab?.path === "__TRASH__" && !activeTab?.activeTag}
        onOpenTrash={() => navigateTo("__TRASH__", "Trash")}
      />

      {/* Toolbar Downloads Popover */}
      {downloadsPopoverOpen && (
        <DownloadsPopover
          downloads={downloads}
          darkMode={darkMode}
          onClose={() => setDownloadsPopoverOpen(false)}
          onShowInFolder={handleShowInFolder}
          onOpenFile={handleOpenFile}
          onCancelDownload={handleCancelDownload}
          onClearCompleted={handleClearCompletedDownloads}
          onManualDownloadUrl={handleManualDownloadUrl}
        />
      )}

      {/* Main Content Split: Translucent Sidebar + Active View Mode */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div
          onTransitionEnd={(event) => {
            if (
              event.target === event.currentTarget.firstElementChild &&
              event.propertyName === "transform"
            ) {
              finishSidebarCollapse();
            }
          }}
          className={`macos-sidebar-container ${
            sidebarLayoutOpen ? "" : "is-collapsed"
          } ${sidebarOpen ? "" : "is-hidden"}`}
        >
          <Sidebar
            data={sidebarData}
            currentPath={activeTab?.path || "/"}
            activeTag={activeTab?.activeTag || null}
            onNavigate={navigateTo}
            onSelectVolume={handleSelectVolume}
            onUnmountVolume={handleUnmountVolume}
            onSelectTag={selectTagFilter}
            darkMode={darkMode}
            customFavorites={customFavorites}
            onRemoveFavorite={handleRemoveFavorite}
            dropTargetPath={activeDropTargetPath}
            dropTargetTag={dragState?.dropTargetTag || null}
            dropFavoriteZone={Boolean(dragState?.dropFavoriteZone)}
            isDraggingDirs={Boolean(dragState?.hasDirs)}
            onContextMenuFavorite={handleContextMenuFavorite}
            onContextMenuVolume={handleContextMenuVolume}
            hiddenFavorites={hiddenFavorites}
            onPrefetch={handlePrefetchPath}
          />
        </div>

        <main
          className={`macos-layer-isolate relative flex-1 flex flex-col min-w-0 overflow-hidden transition-colors ${
            isArchiveWorkspace
              ? darkMode
                ? "bg-[#252431]"
                : "bg-[#f7f5fd]"
              : ""
          } ${
            externalDropInfo && !externalDropInfo.isSpecificFolder
              ? "ring-2 ring-inset ring-[#0a84ff]/80 bg-[#0a84ff]/5"
              : ""
          }`}
        >
          <div
            ref={splitContentRef}
            className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <div
              ref={primaryPaneRef}
              data-drop-path={
                activeTab && !activeTab.activeTag && activeTab.path !== "__RECENTS__"
                  ? activeTab.path
                  : undefined
              }
              data-drop-name={activeTab?.title}
              className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
                activeDropTargetPath === activeTab?.path
                  ? "ring-2 ring-inset ring-[#0a84ff]/70"
                  : ""
              }`}
            >
              {activeTab?.path === "__TRASH__" && !activeTab?.activeTag && (
                <div
                  className={`flex items-center justify-between gap-3 px-4 py-2 border-b text-xs shrink-0 select-none ${
                    darkMode
                      ? "bg-[#26262b]/90 border-white/10 text-zinc-200"
                      : "bg-[#ebebf0]/90 border-black/10 text-zinc-800"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Trash2 className="w-4 h-4 text-[#0a84ff] shrink-0" />
                    <span className="font-semibold">Trash</span>
                    <span className="opacity-60 truncate">
                      {sortedEntries.length === 0
                        ? "— Trash is empty"
                        : selectedPaths.length > 0
                        ? `— ${selectedPaths.length} of ${sortedEntries.length} item(s) selected`
                        : `— ${sortedEntries.length} ${
                            sortedEntries.length === 1 ? "item" : "items"
                          }`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {selectedPaths.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleRestoreTrash()}
                          title="Restore selected item(s) to their original locations"
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition cursor-pointer ${
                            darkMode
                              ? "bg-white/10 hover:bg-white/15 text-zinc-100"
                              : "bg-white hover:bg-zinc-100 text-zinc-800 border border-black/10 shadow-2xs"
                          }`}
                        >
                          <RotateCcw className="w-3.5 h-3.5 text-[#0a84ff]" />
                          <span>Put Back</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePermanently()}
                          title="Delete selected item(s) permanently (Del)"
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition cursor-pointer ${
                            darkMode
                              ? "bg-[#ff453a]/15 hover:bg-[#ff453a]/25 text-[#ff6961] border border-[#ff453a]/30"
                              : "bg-[#ff453a]/10 hover:bg-[#ff453a]/20 text-[#d70015] border border-[#ff453a]/25"
                          }`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delete Permanently…</span>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={sortedEntries.length === 0}
                      onClick={() => void handleRestoreAllTrash()}
                      title="Restore all items in Trash to their original locations"
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
                        darkMode
                          ? "bg-white/10 hover:bg-white/15 text-zinc-100"
                          : "bg-white hover:bg-zinc-100 text-zinc-800 border border-black/10 shadow-2xs"
                      }`}
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-[#0a84ff]" />
                      <span>Restore All</span>
                    </button>
                    <button
                      type="button"
                      disabled={sortedEntries.length === 0}
                      onClick={() => void handleEmptyTrash()}
                      title="Permanently delete all items in Trash"
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium bg-[#ff453a] hover:bg-[#e0352b] text-white transition shadow-2xs cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Empty Trash…</span>
                    </button>
                  </div>
                </div>
              )}
              {viewMode === "icons" && <IconView {...commonViewProps} />}
              {viewMode === "list" && <ListView {...commonViewProps} />}
              {viewMode === "columns" && (
                <ColumnView
                  {...commonViewProps}
                  currentPath={activeTab?.path || "/"}
                  rootPartitionName={mainPartitionName}
                  onActiveDirectoryChange={setColumnActivePath}
                />
              )}
              {viewMode === "gallery" && <GalleryView {...commonViewProps} />}
            </div>
            {splitPane && (
              <SplitExplorerPane
                key={splitPane.key}
                initialPath={splitPane.path}
                initialTitle={splitPane.title}
                initialTag={splitPane.activeTag}
                darkMode={darkMode}
                refreshVersion={splitPaneRefreshVersion}
                onStartItemDrag={handleStartItemDrag}
                dropTargetPath={activeDropTargetPath}
                panelWidthPercent={splitPaneRatio * 100}
                onClose={closeSplitPane}
                onLocationChange={handleSplitPaneLocationChange}
                onHoverChange={handleSplitPaneHoverChange}
                onSelectionChange={handleSplitPaneSelectionChange}
                onSelectAllChange={handleSplitPaneSelectAllChange}
              />
            )}
            {splitPane && (
              <div
                role="separator"
                aria-label="Resize split panes"
                aria-orientation="vertical"
                aria-valuenow={Math.round((1 - splitPaneRatio) * 100)}
                tabIndex={0}
                onPointerDown={handleSplitResizeStart}
                onPointerMove={handleSplitResize}
                className="absolute inset-y-0 z-20 w-2 -translate-x-1/2 cursor-col-resize touch-none bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-[#0a84ff]/0 hover:after:bg-[#0a84ff]/60"
                style={{ left: `${(1 - splitPaneRatio) * 100}%` }}
              />
            )}
          </div>

          {externalDropInfo && (
            <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#0a84ff] text-white text-xs font-medium shadow-lg border border-white/25">
              <span>
                Drop to {externalDropInfo.isMove ? "move" : "copy"} into “
                {externalDropInfo.targetName}”
              </span>
            </div>
          )}
        </main>
      </div>

      {/* Download Save Bar (Interactive bottom bar shown only when downloading) */}
      {pendingDownload && (
        <DownloadSaveBar
          download={pendingDownload}
          queueCount={downloadQueue.length}
          currentPath={activeTab?.path || ""}
          defaultDownloadsDir={defaultDownloadsDir}
          darkMode={darkMode}
          onCancel={() => handleDismissPendingDownload(pendingDownload.id)}
          onConfirm={handleConfirmDownload}
        />
      )}

      {/* Bottom Interactive Path Bar & Status Bar */}
      <BottomBars
        currentPath={
          viewMode === "columns" && columnActivePath
            ? columnActivePath
            : activeTab?.path || "/"
        }
        rootPartitionName={mainPartitionName}
        activeTag={activeTab?.activeTag || null}
        totalItems={sortedEntries.length}
        selectedCount={selectedPaths.length}
        availableSpace={availableDiskSpace}
        viewMode={viewMode}
        iconSize={iconSize}
        onChangeIconSize={setIconSize}
        onNavigate={navigateTo}
        darkMode={darkMode}
        dropTargetPath={activeDropTargetPath}
      />

      {/* Floating Quick Look Modal (Spacebar) */}
      <QuickLookModal
        entry={quickLookEntry}
        onClose={() => setQuickLookEntry(null)}
        onOpenExternal={handleOpenEntry}
        darkMode={darkMode}
      />

      {/* Get Info Inspector Modal (Ctrl + I) */}
      <GetInfoModal
        entry={getInfoEntry}
        volume={getInfoVolume}
        onClose={() => {
          setGetInfoEntry(null);
          setGetInfoVolume(null);
        }}
        onToggleTag={handleToggleTag}
        onSetExecutable={handleSetFileExecutable}
        onSetDefaultApp={handleSetDefaultApp}
        darkMode={darkMode}
      />

      {/* Open With / Set Default Program Modal */}
      <OpenWithModal
        entry={openWithEntry}
        onClose={() => setOpenWithEntry(null)}
        onSaveDefaultApp={handleSaveDefaultAppFromModal}
        darkMode={darkMode}
      />

      {/* macOS Sudo Authentication Prompt Modal */}
      <SudoPromptModal
        prompt={sudoPrompt}
        onCancel={() => setSudoPrompt(null)}
        onSubmit={handleSudoSubmit}
        darkMode={darkMode}
      />

      {/* Right-Click Context Menu */}
      <ContextMenu
        menu={contextMenu}
        selectedPaths={selectedPaths}
        onClose={() => setContextMenu(null)}
        onOpen={handleOpenEntry}
        onOpenWith={(entry) => setOpenWithEntry(entry)}
        onQuickLook={(entry) => setQuickLookEntry(entry)}
        onGetInfo={(entry) => {
          if (entry) {
            setGetInfoVolume(null);
            setGetInfoEntry(entry);
          } else if (primarySelectedEntry) {
            setGetInfoVolume(null);
            setGetInfoEntry(primarySelectedEntry);
          }
        }}
        onRename={startRename}
        onDuplicate={handleDuplicate}
        onCompress={handleCompress}
        onViewArchive={(entry) => void handleBrowseArchive(entry.path)}
        onExtractArchive={(entry) => void handleExtractArchive(entry.path)}
        onCopy={handleCopy}
        onCut={handleCut}
        onPaste={() => handlePaste(contextMenu?.targetDir)}
        canPaste={Boolean(clipboard && clipboard.paths.length > 0)}
        onTrash={handleTrash}
        onNewFolder={() => handleNewFolder(contextMenu?.targetDir)}
        onNewFile={() => handleNewFile(contextMenu?.targetDir)}
        onToggleTag={handleToggleTag}
        onAddFavorite={handleAddFavorite}
        darkMode={darkMode}
        onNavigate={navigateTo}
        onOpenInNewTab={handleNewTab}
        onGetFavoriteInfo={handleGetFavoriteInfo}
        onRemoveFavorite={handleRemoveFavorite}
        onSelectVolume={handleSelectVolume}
        onUnmountVolume={handleUnmountVolume}
        onMountVolume={handleSelectVolume}
        onGetVolumeInfo={handleGetVolumeInfo}
        onFormatVolume={setFormatVolume}
        onFirstAidVolume={setFirstAidVolume}
        onToast={showToast}
        isTrashView={activeTab?.path === "__TRASH__" && !activeTab?.activeTag}
        onRestoreTrash={(entry) => void handleRestoreTrash(entry)}
        onRestoreAllTrash={() => void handleRestoreAllTrash()}
        onDeletePermanently={handleDeletePermanently}
        onEmptyTrash={() => void handleEmptyTrash()}
        trashEmpty={activeTab?.path === "__TRASH__" && sortedEntries.length === 0}
      />

      {/* Empty Trash / Delete Permanently Confirmation Modal */}
      {trashConfirmModal && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setTrashConfirmModal(null);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-xs p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-sm rounded-2xl border shadow-2xl p-5 flex flex-col gap-4 backdrop-blur-2xl text-xs select-none ${
              darkMode
                ? "bg-[#26262b]/95 border-white/15 text-zinc-100"
                : "bg-white/95 border-black/15 text-zinc-900"
            }`}
          >
            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-[#ff453a]/15 border border-[#ff453a]/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-[#ff453a]" />
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <h3 className="font-semibold text-sm leading-snug">
                  {trashConfirmModal.mode === "empty"
                    ? "Are you sure you want to permanently erase the items in the Trash?"
                    : `Are you sure you want to permanently delete ${
                        trashConfirmModal.count === 1
                          ? "this item"
                          : `${trashConfirmModal.count} items`
                      }?`}
                </h3>
                <p className="opacity-65 text-xs leading-relaxed">
                  {trashConfirmModal.mode === "empty"
                    ? `All ${trashConfirmModal.count} item(s) in the Trash will be permanently deleted. You can’t undo this action.`
                    : "The selected item(s) will be deleted immediately and permanently. You can’t undo this action."}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setTrashConfirmModal(null)}
                className={`px-3.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                  darkMode
                    ? "bg-white/10 hover:bg-white/15 text-zinc-200"
                    : "bg-black/5 hover:bg-black/10 text-zinc-700"
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => void confirmTrashAction()}
                className="px-3.5 py-1.5 rounded-lg font-semibold bg-[#ff453a] hover:bg-[#e0352b] text-white transition shadow-sm cursor-pointer"
              >
                {trashConfirmModal.mode === "empty"
                  ? "Empty Trash"
                  : "Delete Immediately"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Format / Erase Modal (macOS Disk Utility Style) */}
      <FormatModal
        volume={formatVolume}
        onClose={() => setFormatVolume(null)}
        onFormat={handleFormatSubmit}
        darkMode={darkMode}
      />

      {/* First Aid Inspection Modal (macOS Disk Utility Style) */}
      <FirstAidModal
        volume={firstAidVolume}
        onClose={() => setFirstAidVolume(null)}
        onRunFirstAid={handleFirstAidRun}
        darkMode={darkMode}
      />

      {/* Floating macOS Finder Drag-and-Drop Ghost Preview */}
      {dragState && (
        <div
          style={{
            left: dragState.x + 14,
            top: dragState.y + 14,
          }}
          className="fixed z-[100] pointer-events-none flex items-center gap-2.5 px-3 py-2 rounded-xl border shadow-2xl backdrop-blur-xl bg-[#25252b]/90 border-white/20 text-white"
        >
          <div className="relative">
            <FileIcon entry={dragState.primaryEntry} size={32} />
            {dragState.paths.length > 1 && (
              <span className="absolute -top-1.5 -right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-[#ff453a] text-white text-[10px] font-bold flex items-center justify-center shadow-md border border-white/30">
                {dragState.paths.length}
              </span>
            )}
            {dragState.isCopy && (
              <span className="absolute -bottom-1 -right-1.5 w-4 h-4 rounded-full bg-[#32d74b] text-black text-[11px] font-bold flex items-center justify-center shadow-md border border-white">
                +
              </span>
            )}
          </div>
          <div className="flex flex-col min-w-0 max-w-[200px]">
            <span className="text-xs font-semibold truncate">
              {dragState.paths.length === 1
                ? dragState.primaryEntry.name
                : `${dragState.paths.length} items`}
            </span>
            {dragState.dropTargetName ? (
              <span className="text-[10px] text-[#5ac8fa] font-medium truncate">
                {dragState.isCopy ? "Copy to" : "Move to"} “{dragState.dropTargetName}”
              </span>
            ) : dragState.dropTargetTagName ? (
              <span className="text-[10px] text-[#5ac8fa] font-medium truncate">
                Apply “{dragState.dropTargetTagName}” Tag
              </span>
            ) : dragState.dropFavoriteZone ? (
              <span className="text-[10px] text-[#5ac8fa] font-medium truncate">
                Pin to Sidebar Favorites
              </span>
            ) : (
              <span className="text-[10px] opacity-60">
                {dragState.isCopy
                  ? "Copy"
                  : "Drag to folder, sidebar, tab, or another app"}
              </span>
            )}
          </div>
        </div>
      )}

      {activeOperations.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className={`pointer-events-none fixed bottom-4 right-4 z-[70] flex max-w-xs items-center gap-3 rounded-xl border px-3.5 py-3 shadow-xl backdrop-blur-xl ${
            darkMode
              ? "border-white/15 bg-[#29292e]/95 text-zinc-100"
              : "border-black/10 bg-white/95 text-zinc-800"
          }`}
        >
          <span
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current/20 border-t-[#0a84ff]"
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="block text-xs font-semibold">
              {activeOperations.length > 1
                ? `Working on ${activeOperations.length} tasks`
                : "Working"}
            </span>
            <span className="block truncate text-[11px] opacity-70">
              {activeOperations[0].label}
            </span>
          </span>
        </div>
      )}

      {openingArchive && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 backdrop-blur-[2px]"
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-live="polite"
            aria-label={`Opening ${openingArchive}`}
            className={`flex w-[min(340px,calc(100vw-40px))] flex-col items-center gap-3 rounded-2xl border px-8 py-7 text-center shadow-2xl backdrop-blur-xl ${
              darkMode
                ? "border-white/15 bg-[#29292e]/95 text-zinc-100"
                : "border-black/10 bg-white/95 text-zinc-900"
            }`}
          >
            <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-[#9692D6]/15 text-[#9692D6]">
              <Archive className="h-6 w-6" />
              <Loader2 className="absolute -right-1 -top-1 h-5 w-5 animate-spin rounded-full bg-inherit" />
            </div>
            <span className="text-sm font-semibold">Opening archive…</span>
            <span className="max-w-full truncate text-xs opacity-60">{openingArchive}</span>
            <span className="text-[11px] opacity-45">Extracting contents for browsing</span>
          </div>
        </div>
      )}

      {/* Subtle macOS Floating Toast */}
      {toast && (
        <div className="fixed bottom-14 left-1/2 -translate-x-1/2 z-50 px-4 py-1.5 rounded-full text-xs font-medium bg-black/80 text-white border border-white/15 shadow-lg backdrop-blur-md">
          {toast}
        </div>
      )}
    </div>
  );
};
