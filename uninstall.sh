#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/com.vfinder.filemanager"
APP_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/com.vfinder.filemanager"
APP_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/com.vfinder.filemanager"

echo "========================================================"
echo "  vFinder File Manager - Uninstaller & Cleanup"
echo "========================================================"
echo ""
echo "Note: No new system (pacman) packages were installed because"
echo "webkit2gtk-4.1, rust/cargo, and nodejs/npm were already present."
echo ""

# 1. Remove heavy build & dependency directories
echo "[1/3] Removing downloaded project dependencies and build artifacts..."
rm -rf "$PROJECT_DIR/node_modules"
rm -rf "$PROJECT_DIR/dist"
rm -rf "$PROJECT_DIR/src-tauri/target"
echo "  -> Removed node_modules/, dist/, and src-tauri/target/"

# 2. Remove any local app config/cache/tags created by the app
echo "[2/3] Removing application config, cache, tag metadata, and desktop shortcuts..."
rm -rf "$APP_CONFIG_DIR" "$APP_DATA_DIR" "$APP_CACHE_DIR"
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/com.apple-style.finder" "${XDG_DATA_HOME:-$HOME/.local/share}/com.apple-style.finder" "${XDG_CACHE_HOME:-$HOME/.cache}/com.apple-style.finder"
rm -f "$HOME/.config/vfinder-tags.json" "$HOME/.config/finder-tags.json"
rm -f "$HOME/.local/share/applications/vfinder.desktop" "$HOME/.local/share/applications/macos-finder.desktop"
rm -f "$HOME/.local/share/icons/hicolor/"*"/apps/vfinder.png" "$HOME/.local/share/icons/hicolor/"*"/apps/macos-finder.png"
echo "  -> Removed app configuration, tag files, and desktop entry."

# 3. Ask if user wants to delete the source code files too
echo ""
read -r -p "[3/3] Do you also want to delete all project source files in $PROJECT_DIR? [y/N] " response
case "$response" in
    [yY][eE][sS]|[yY])
        find "$PROJECT_DIR" -mindepth 1 -maxdepth 1 ! -name "uninstall.sh" -exec rm -rf {} +
        echo "  -> Deleted all project files in $PROJECT_DIR (kept uninstall.sh)."
        read -r -p "Remove uninstall.sh as well? [y/N] " self_rm
        if [[ "$self_rm" =~ ^([yY][eE][sS]|[yY])$ ]]; then
            rm -f "$PROJECT_DIR/uninstall.sh"
            echo "  -> Removed uninstall.sh. Directory is completely clean!"
        fi
        ;;
    *)
        echo "  -> Kept source code files (only dependencies, caches, and build artifacts were removed)."
        ;;
esac

echo ""
echo "Uninstall complete!"
