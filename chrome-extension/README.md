# macOS Finder Download Manager Extension

This Chrome/Brave extension intercepts downloads and routes them directly to your macOS Finder file manager application, allowing you to choose where to store the file and manage active downloads with real-time speed and progress.

## How to Install in Chrome or Brave

1. Open **Google Chrome** or **Brave Browser**.
2. Navigate to:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
3. Toggle on **Developer mode** (in the top right corner).
4. Click the **Load unpacked** button.
5. Select this folder:
   `<path-to-fileManager>/chrome-extension` (e.g. `~/fileManager/chrome-extension`)
6. That's it! The extension icon will appear in your browser toolbar.

## Features

- **Automatic Interception**: When you click to download any file, Chrome halts the native download and Finder pops up asking where you want to store it.
- **Save Location Selector**: Quickly save to Current Folder, Downloads, Desktop, Documents, or any folder in Finder.
- **Cookie & Session Preservation**: Seamlessly supports authenticated downloads (Google Drive, GitHub, intranet portals) by forwarding cookies.
- **Offline Safe**: If macOS Finder is closed, Chrome automatically falls back to native downloads without interrupting your workflow.
- **Context Menu**: Right-click any link, image, or media and click *Download with macOS Finder*.
