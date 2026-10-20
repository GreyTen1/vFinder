#!/usr/bin/env bash
# vFinder Download Manager - Native Messaging Host Installer
# Registers the native messaging manifest for all installed Chromium and Firefox based browsers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/native-messaging-host.py"

chmod +x "$HOST_SCRIPT"

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "com.macosfinder.downloader",
  "description": "vFinder Native Messaging Host for Downloads",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://einmkmankeaejiohfdpjjlgllaldefme/"
  ]
}
EOF
)

# Standard Chromium-based browser config paths
BROWSER_DIRS=(
  "$HOME/.config/google-chrome"
  "$HOME/.config/google-chrome-beta"
  "$HOME/.config/google-chrome-unstable"
  "$HOME/.config/chromium"
  "$HOME/.config/BraveSoftware/Brave-Browser"
  "$HOME/.config/microsoft-edge"
  "$HOME/.config/microsoft-edge-dev"
  "$HOME/.config/vivaldi"
  "$HOME/.config/opera"
)

COUNT=0

for b_dir in "${BROWSER_DIRS[@]}"; do
  if [ -d "$b_dir" ]; then
    nm_dir="$b_dir/NativeMessagingHosts"
    mkdir -p "$nm_dir"
    echo "$MANIFEST_CONTENT" > "$nm_dir/com.macosfinder.downloader.json"
    echo "Registered Native Host for: $(basename "$b_dir")"
    COUNT=$((COUNT + 1))
  fi
done

if [ "$COUNT" -eq 0 ]; then
  # Fallback to standard Google Chrome and Chromium dirs
  default_nm="$HOME/.config/google-chrome/NativeMessagingHosts"
  mkdir -p "$default_nm"
  echo "$MANIFEST_CONTENT" > "$default_nm/com.macosfinder.downloader.json"
  echo "Created default manifest in $default_nm"
fi

echo "vFinder Native Messaging Host setup complete ($COUNT browser(s) configured)."
