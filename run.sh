#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ "${1:-}" == "--dev" ]]; then
    shift
    echo "Starting vFinder in development mode (Vite + Cargo watch)..."
    if [[ $# -gt 0 ]]; then
        exec npm run tauri dev -- -- "$@"
    else
        exec npm run tauri dev
    fi
fi

RELEASE_BIN="$SCRIPT_DIR/src-tauri/target/release/vfinder"
if [[ ! -x "$RELEASE_BIN" && -x "$SCRIPT_DIR/src-tauri/target/release/macos-finder" ]]; then
    RELEASE_BIN="$SCRIPT_DIR/src-tauri/target/release/macos-finder"
fi

if [[ ! -x "$RELEASE_BIN" ]]; then
    echo "Building optimized native release binary (first-time setup)..."
    npx tauri build --no-bundle
    RELEASE_BIN="$SCRIPT_DIR/src-tauri/target/release/vfinder"
fi

# Use WebKitGTK hardware acceleration flags for smooth rendering
export WEBKIT_DISABLE_COMPOSITING_MODE=0
exec "$RELEASE_BIN" "$@"
