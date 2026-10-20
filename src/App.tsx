import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
  apiCopyItems,
  apiCreateDirectory,
  apiCreateFile,
  apiDisarmExternalDrag,
  apiDuplicateItem,
  apiFormatPartition,
  apiGetFileInfo,
  apiGetFilesByTag,
  apiGetSidebarData,
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
  apiUnmountPartition,
  apiStartDownload,
  apiCancelDownload,
  apiGetDefaultDownloadsDir,
  apiGetPendingDownloads,
} from "./api";
import { Toolbar } from "./components/Toolbar";
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

const DEFAULT_ZOOM_BY_VIEW: Record<ViewMode, number> = {
  icons: 64,
  list: 64,
  columns: 64,
  gallery: 64,
};

export const App: React.FC = () => {
  const [sidebarData, setSidebarData] = useState<SidebarData | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [darkMode, setDarkMode] = useState(true);

  const [tabs, setTabs] = useState<FinderTab[]>([
    {
      id: "tab-1",
      title: "Home",
      path: "",
      history: [""],
      historyIndex: 0,
      activeTag: null,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState("tab-1");

  const [entries, setEntries] = useState<FileEntry[]>([]);
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
  const [sudoPrompt, setSudoPrompt] = useState<SudoPromptState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
    refreshSidebar().then((data) => {
      if (data?.homeDir) {
        setTabs((prev) => {
          if (
            prev.length === 1 &&
            (prev[0].path === "" ||
              prev[0].path === "~" ||
              prev[0].path === data.homeDir)
          ) {
            return [
              {
                id: prev[0].id || "tab-1",
                title: "Home",
                path: data.homeDir,
                history: [data.homeDir],
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

    const interval = setInterval(pollVolumes, 2500);
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
          activeTab.path !== "__RECENTS__"
        ) {
          list = await apiSearchDirectory(
            activeTab.path,
            effectiveSearch,
            showHidden
          );
        } else {
          list = await apiReadDirectory(activeTab.path, showHidden);
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
        }
      }
    },
    [activeTab?.path, activeTab?.activeTag, debouncedSearchQuery, showHidden, showToast]
  );

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
    activeTab.path !== "__RECENTS__"
  );

  const goUp = useCallback(() => {
    if (!activeTab || activeTab.path === "/" || activeTab.path === "__RECENTS__") return;
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
    (id: string) => {
      setTabs((prev) => {
        if (prev.length <= 1) return prev;
        const filtered = prev.filter((t) => t.id !== id);
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
      applyFavoriteViewModeIfPinned,
      applyCachedEntriesIfAvailable,
    ]
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
            if (modifiers.metaOrCtrl) {
              return Array.from(new Set([...prev, ...rangePaths]));
            }
            return rangePaths;
          }
          lastSelectedPathRef.current = entry.path;
          return prev.includes(entry.path) ? prev : [...prev, entry.path];
        }

        if (modifiers.metaOrCtrl) {
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
      } else {
        try {
          await apiOpenItem(entry.path);
        } catch (err) {
          showToast(`${err}`);
        }
      }
    },
    [navigateTo, showToast]
  );

  // File Operations
  const handleNewFolder = useCallback(async () => {
    if (!activeTab || activeTab.path === "__RECENTS__" || activeTab.activeTag) {
      showToast("Navigate to a folder first to create a new folder");
      return;
    }
    const baseName = "untitled folder";
    let candidate = baseName;
    let counter = 2;
    const existingNames = new Set(entries.map((e) => e.name));
    while (existingNames.has(candidate)) {
      candidate = `${baseName} ${counter++}`;
    }
    try {
      const created = await apiCreateDirectory(activeTab.path, candidate);
      await loadCurrentEntries(true);
      setSelectedPaths([created.path]);
      lastSelectedPathRef.current = created.path;
      setRenamingPath(created.path);
      setRenameValue(created.name);
    } catch (err) {
      showToast(`${err}`);
    }
  }, [activeTab, entries, loadCurrentEntries, showToast]);

  const handleNewFile = useCallback(async () => {
    if (!activeTab || activeTab.path === "__RECENTS__" || activeTab.activeTag) {
      showToast("Navigate to a folder first to create a file");
      return;
    }
    const baseName = "untitled.txt";
    let candidate = baseName;
    let counter = 2;
    const existingNames = new Set(entries.map((e) => e.name));
    while (existingNames.has(candidate)) {
      candidate = `untitled ${counter++}.txt`;
    }
    try {
      const created = await apiCreateFile(activeTab.path, candidate);
      await loadCurrentEntries(true);
      setSelectedPaths([created.path]);
      lastSelectedPathRef.current = created.path;
      setRenamingPath(created.path);
      setRenameValue(created.name);
    } catch (err) {
      showToast(`${err}`);
    }
  }, [activeTab, entries, loadCurrentEntries, showToast]);

  const startRename = useCallback((entry: FileEntry) => {
    knownEntriesMapRef.current.set(entry.path, entry);
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
  }, []);

  const submitRename = useCallback(async () => {
    if (!renamingPath) return;
    const trimmed = renameValue.trim();
    const targetEntry =
      entries.find((e) => e.path === renamingPath) ||
      knownEntriesMapRef.current.get(renamingPath);
    setRenamingPath(null);
    if (!trimmed || (targetEntry && targetEntry.name === trimmed)) return;

    try {
      const updated = await apiRenameItem(renamingPath, trimmed);
      knownEntriesMapRef.current.set(updated.path, updated);
      await loadCurrentEntries(true);
      setSelectedPaths([updated.path]);
      lastSelectedPathRef.current = updated.path;
    } catch (err) {
      showToast(`${err}`);
    }
  }, [renamingPath, renameValue, entries, loadCurrentEntries, showToast]);

  const handleDuplicate = useCallback(
    async (entry?: FileEntry) => {
      const targets = entry ? [entry.path] : selectedPaths;
      if (targets.length === 0) return;
      try {
        const createdPaths: string[] = [];
        for (const p of targets) {
          const dup = await apiDuplicateItem(p);
          createdPaths.push(dup.path);
        }
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
    [selectedPaths, loadCurrentEntries, showToast]
  );

  const handleTrash = useCallback(
    async (targetEntry?: FileEntry) => {
      const targets = targetEntry ? [targetEntry.path] : selectedPaths;
      if (targets.length === 0) return;
      try {
        await apiTrashItems(targets);
        setSelectedPaths([]);
        await loadCurrentEntries(true);
        showToast(`Moved ${targets.length} item(s) to Trash`);
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [selectedPaths, loadCurrentEntries, showToast]
  );

  const handleCopy = useCallback(
    (entry?: FileEntry) => {
      const paths = entry ? [entry.path] : selectedPaths;
      if (paths.length === 0) return;
      setClipboard({ paths, mode: "copy" });
      showToast(`Copied ${paths.length} item(s)`);
    },
    [selectedPaths, showToast]
  );

  const handleCut = useCallback(
    (entry?: FileEntry) => {
      const paths = entry ? [entry.path] : selectedPaths;
      if (paths.length === 0) return;
      setClipboard({ paths, mode: "cut" });
      showToast(`Cut ${paths.length} item(s)`);
    },
    [selectedPaths, showToast]
  );

  const handlePaste = useCallback(async () => {
    if (!clipboard || !activeTab || activeTab.path === "__RECENTS__") return;
    try {
      if (clipboard.mode === "copy") {
        const created = await apiCopyItems(clipboard.paths, activeTab.path);
        setSelectedPaths(created);
        showToast(`Pasted ${created.length} item(s)`);
      } else {
        const moved = await apiMoveItems(clipboard.paths, activeTab.path);
        setSelectedPaths(moved);
        setClipboard(null);
        showToast(`Moved ${moved.length} item(s)`);
      }
      await loadCurrentEntries(true);
    } catch (err) {
      showToast(`${err}`);
    }
  }, [clipboard, activeTab, loadCurrentEntries, showToast]);

  const handleToggleTag = useCallback(
    async (path: string, color: string) => {
      try {
        const currentSelected = selectedPathsRef.current;
        const targets =
          currentSelected.length > 1 && currentSelected.includes(path)
            ? currentSelected
            : [path];

        let lastUpdatedTags: string[] = [];
        for (const targetPath of targets) {
          lastUpdatedTags = await apiToggleItemTag(targetPath, color);
        }
        await loadCurrentEntries(true);
        await refreshSidebar();
        setGetInfoEntry((prev) =>
          prev && prev.path === path
            ? { ...prev, tags: lastUpdatedTags }
            : prev
        );
      } catch (err) {
        showToast(`${err}`);
      }
    },
    [loadCurrentEntries, refreshSidebar, showToast]
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
      ) => void
    ) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target && target.closest("input, textarea, button")) return;

      e.stopPropagation();
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const metaOrCtrl = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      const currentSelected = selectedPathsRef.current;
      const alreadySelected = currentSelected.includes(entry.path);

      // Determine which paths will be dragged if the user moves the cursor
      let dragPaths: string[];
      if (alreadySelected) {
        dragPaths = [...currentSelected];
      } else if (metaOrCtrl || shift) {
        dragPaths = [...currentSelected, entry.path];
      } else {
        // Select immediately on mousedown so single un-selected item highlights right away
        setSelectedPaths([entry.path]);
        lastSelectedPathRef.current = entry.path;
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
          setSelectedPaths(dragPaths);
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
            metaOrCtrl: ev.metaKey || ev.ctrlKey,
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
          try {
            if (isCopy) {
              const copied = await apiCopyItems(dragPaths, destDir);
              await loadCurrentEntries(true);
              setSelectedPaths(copied);
              showToast(
                `Copied ${copied.length} item(s) to "${destLabel}"`
              );
            } else {
              const sourcesToMove = dragPaths.filter(
                (src) => getParentPath(src) !== destDir
              );
              if (sourcesToMove.length > 0) {
                await apiMoveItems(sourcesToMove, destDir);
                setSelectedPaths([]);
                await loadCurrentEntries(true);
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
    [handleSelectEntry, loadCurrentEntries, refreshSidebar, showToast]
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
          const saved = await apiSaveDroppedUrls(urls, target.targetPath);
          await loadCurrentEntries(true);
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
              const moved = await apiMoveItems(validSources, destDir);
              await loadCurrentEntries(true);
              if (destDir === activeTabRef.current?.path) {
                setSelectedPaths(moved);
              }
              showToast(
                `Moved ${moved.length} item(s) to "${target.targetName}"`
              );
            } else {
              const copied = await apiCopyItems(validSources, destDir);
              await loadCurrentEntries(true);
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
  }, [loadCurrentEntries, showToast]);

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
        const mountedPath = await apiMountPartition(vol.device);
        await refreshSidebar();
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
    [navigateTo, refreshSidebar, showToast]
  );

  const handleUnmountVolume = useCallback(
    async (vol: VolumeInfo) => {
      try {
        await apiUnmountPartition(vol.device);
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
    [activeTab, navigateTo, refreshSidebar, sidebarData?.homeDir, showToast]
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
        if (sudoPrompt.action === "mount") {
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
  const scrollEntryIntoView = useCallback((path: string, index?: number) => {
    requestAnimationFrame(() => {
      try {
        const el = document.querySelector(`[data-entry-path="${CSS.escape(path)}"]`);
        if (el) {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
          return;
        }
        if (typeof index === "number" && index >= 0) {
          const container = document.querySelector(".list-view-container");
          if (container) {
            const rowHeight = 28;
            container.scrollTop = Math.max(0, index * rowHeight - container.clientHeight / 2);
          }
        }
      } catch {
        // ignore
      }
    });
  }, []);

  const typeAheadBufferRef = useRef("");
  const typeAheadTimerRef = useRef<number | null>(null);

  // Global macOS Finder Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;

      // Zoom In: Cmd/Ctrl + Plus / Equal (always active)
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

      // Zoom Out: Cmd/Ctrl + Minus / Underscore (always active)
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

      // Zoom Reset: Cmd/Ctrl + 0 (always active)
      if (
        cmdOrCtrl &&
        (e.key === "0" || e.code === "Numpad0" || e.code === "Digit0")
      ) {
        e.preventDefault();
        setIconSize(64);
        showToast("Zoom: 100% (Default)");
        return;
      }

      // Cmd/Ctrl + 1/2/3/4 -> Switch View Mode (always active)
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

      // Toggle Sidebar: Cmd/Ctrl + Option/Alt + S or Cmd/Ctrl + B
      if (
        (cmdOrCtrl && e.altKey && e.key.toLowerCase() === "s") ||
        (cmdOrCtrl && !e.altKey && e.key.toLowerCase() === "b")
      ) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }

      const targetEl = e.target as HTMLInputElement | null;
      const tag = targetEl?.tagName;
      if (
        tag === "TEXTAREA" ||
        (tag === "INPUT" && targetEl?.type !== "range")
      ) {
        return;
      }

      // Cmd/Ctrl + A -> Select All items in current folder
      if (cmdOrCtrl && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedPaths(sortedEntries.map((item) => item.path));
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

      // Enter -> Rename selected item (macOS Finder standard!)
      if (
        e.key === "Enter" &&
        !cmdOrCtrl &&
        primarySelectedEntry &&
        !renamingPath
      ) {
        e.preventDefault();
        startRename(primarySelectedEntry);
        return;
      }

      // Cmd/Ctrl + O or Cmd/Ctrl + Down -> Open item(s)
      if (cmdOrCtrl && (e.key.toLowerCase() === "o" || e.key === "ArrowDown")) {
        if (primarySelectedEntry) {
          e.preventDefault();
          handleOpenEntry(primarySelectedEntry);
        }
        return;
      }

      // Cmd/Ctrl + Up or Alt + Up -> Go to parent folder (cd ..)
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

      // Cmd/Ctrl + I -> Get Info
      if (cmdOrCtrl && e.key.toLowerCase() === "i") {
        e.preventDefault();
        if (primarySelectedEntry) {
          setGetInfoEntry(primarySelectedEntry);
        }
        return;
      }

      // Cmd/Ctrl + T -> New Tab
      if (cmdOrCtrl && e.key.toLowerCase() === "t") {
        e.preventDefault();
        handleNewTab();
        return;
      }

      // Super/Ctrl + R or F5 -> Reload Folder
      if (e.key === "F5" || (cmdOrCtrl && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        loadCurrentEntries(true);
        return;
      }

      // Cmd/Ctrl + Shift + . -> Toggle Hidden Dotfiles
      if (cmdOrCtrl && e.shiftKey && e.key === ".") {
        e.preventDefault();
        setShowHidden((v) => !v);
        return;
      }

      // Cmd/Ctrl + Shift + N -> New Folder
      if (cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNewFolder();
        return;
      }

      // Cmd/Ctrl + C / X / V / D
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
        handlePaste();
        return;
      }
      if (cmdOrCtrl && e.key.toLowerCase() === "d" && selectedPaths.length > 0) {
        e.preventDefault();
        handleDuplicate();
        return;
      }

      // Delete or Cmd+Backspace -> Move to Trash
      if (e.key === "Delete" || (cmdOrCtrl && e.key === "Backspace")) {
        e.preventDefault();
        handleTrash();
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
    handleDuplicate,
    handleTrash,
    showToast,
    setIconSize,
    setViewMode,
    scrollEntryIntoView,
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

  const handleContextMenu = useCallback((e: React.MouseEvent, entry?: FileEntry) => {
    e.preventDefault();
    if (entry && !selectedPathsRef.current.includes(entry.path)) {
      setSelectedPaths([entry.path]);
      lastSelectedPathRef.current = entry.path;
    }
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

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

  const handleCancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleQuickLook = useCallback(() => {
    if (primarySelectedEntry) setQuickLookEntry(primarySelectedEntry);
  }, [primarySelectedEntry]);

  const activeDropTargetPath =
    dragState?.dropTargetPath ||
    (externalDropInfo?.isSpecificFolder ? externalDropInfo.targetPath : null);

  const commonViewProps = {
    entries: sortedEntries,
    selectedPaths,
    onSelect: handleSelectEntry,
    onSetSelection: setSelectedPaths,
    onClearSelection: handleClearSelection,
    onOpenEntry: handleOpenEntry,
    onContextMenu: handleContextMenu,
    onStartItemDrag: handleStartItemDrag,
    dropTargetPath: activeDropTargetPath,
    draggedPaths: dragState?.paths || [],
    refreshVersion,
    renamingPath,
    renameValue,
    onRenameChange: setRenameValue,
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
        const saved = await apiSaveDroppedUrls(urls, destPath);
        await loadCurrentEntries(true);
        if (destPath === activeTabRef.current?.path) {
          setSelectedPaths(saved);
        }
        showToast(`Saved ${saved.length} item(s) to "${destName}"`);
      } catch (err) {
        showToast(`Failed to save dropped URL: ${err}`);
      }
    },
    [loadCurrentEntries, showToast]
  );

  return (
    <div
      onDragOver={handleNativeDomDragOver}
      onDrop={handleNativeDomDrop}
      className={`w-screen h-screen flex flex-col rounded-xl overflow-hidden macos-window-shadow border ${
        darkMode
          ? "bg-[#1e1e22] text-zinc-100 border-white/15"
          : "bg-white text-zinc-900 border-black/15"
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
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((v) => !v)}
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onNewTab={handleNewTab}
        onCloseTab={handleCloseTab}
        dropTargetPath={activeDropTargetPath}
        activeDownloadsCount={
          downloads.filter((d) => d.status === "downloading").length
        }
        downloadsOpen={downloadsPopoverOpen}
        onToggleDownloads={() => setDownloadsPopoverOpen((v) => !v)}
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
          className={`macos-sidebar-container ${
            sidebarOpen ? "" : "is-collapsed"
          }`}
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
            externalDropInfo && !externalDropInfo.isSpecificFolder
              ? "ring-2 ring-inset ring-[#0a84ff]/80 bg-[#0a84ff]/5"
              : ""
          }`}
        >
          {viewMode === "icons" && <IconView {...commonViewProps} />}
          {viewMode === "list" && <ListView {...commonViewProps} />}
          {viewMode === "columns" && (
            <ColumnView
              {...commonViewProps}
              currentPath={activeTab?.path || "/"}
              rootPartitionName={mainPartitionName}
            />
          )}
          {viewMode === "gallery" && <GalleryView {...commonViewProps} />}

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
        currentPath={activeTab?.path || "/"}
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

      {/* Get Info Inspector Modal (Cmd/Ctrl + I) */}
      <GetInfoModal
        entry={getInfoEntry}
        volume={getInfoVolume}
        onClose={() => {
          setGetInfoEntry(null);
          setGetInfoVolume(null);
        }}
        onToggleTag={handleToggleTag}
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
        onCopy={handleCopy}
        onCut={handleCut}
        onPaste={handlePaste}
        canPaste={Boolean(clipboard && clipboard.paths.length > 0)}
        onTrash={handleTrash}
        onNewFolder={handleNewFolder}
        onNewFile={handleNewFile}
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
      />

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

      {/* Subtle macOS Floating Toast */}
      {toast && (
        <div className="fixed bottom-14 left-1/2 -translate-x-1/2 z-50 px-4 py-1.5 rounded-full text-xs font-medium bg-black/80 text-white border border-white/15 shadow-lg backdrop-blur-md">
          {toast}
        </div>
      )}
    </div>
  );
};
