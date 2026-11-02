# vFinder

A macOS-inspired desktop file manager for Linux.

![vFinder_logo](https://github.com/GreyTen1/vFinder/blob/main/src-tauri/icons/Square142x142Logo.png)

## What is this?

A file explorer written in TypeScript, Tailwind, and Rust.

![showcase_png](https://github.com/GreyTen1/vFinder/blob/main/md_assets/showcase.png)

## Why would I use it?

It looks cool! Currently, there are many other incredibly good options available, but none of them look like macOS's file explorer (Finder).

Although it's far from perfect right now, I believe it can be a usable daily driver for those who enjoy this aesthetic.

### IMPORTANT!!!

1. If you want to use Apple's fonts, you have to obtain them from their official website. However, fallback fonts commonly bundled with Linux distributions are included.
2. Optionally, this program includes a download manager function, which you can use by executing a small `.sh` script and installing a Chrome extension that intercepts downloads (yeah, quite messy). For now, it only works with Edge, Chrome, and Brave.

## Features

- Drag & Drop between programs
- Split tabs
- Thumbnail previews
- Download manager (optional)

## Compatible distros

An AppImage is available and bundles the necessary libraries.

Dependencies are also handled automatically when installing the appropriate release for your distribution (`.deb`, `.rpm`).

For transparency, here's a list of the distributions and versions tested so far:

| Distribution | Tested versions | Status |
|---|---|---|
| Ubuntu | 26.04, 25.04, 24.04, 23.04, 22.04 | Tested |
| Debian | 13, 12 | Tested |
| Arch Linux and derivatives | — | Tested |
| Fedora | — | Tested |

## Archive support

ZIP creation, viewing, and extraction are built into vFinder.

Reading and extracting TAR archives is also supported for:

- `.tar`
- `.tar.gz` / `.tgz`
- `.tar.bz2` / `.tbz` / `.tbz2`
- `.tar.xz` / `.txz`
- `.tar.zst` / `.tzst`
- `.tar.lzma`

No separate `zip` command or archive utility is required at runtime.

## Build from source

These are the dependencies you'll need if you want to compile it yourself (Ubuntu):

```bash
sudo apt install -y \
  build-essential \
  pkg-config \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libsoup-3.0-dev \
  libxdo-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  curl \
  wget \
  file \
  nodejs \
  npm
```

Install Rust using rustup and Node.js 18.x, 20.x, or 22+, then build vFinder with:

```bash
npm install
npm run tauri build
```

The Linux build packages above follow [Tauri's Linux prerequisites](https://v2.tauri.app/start/prerequisites/).

### Optional browser download integration

The native messaging host used by the optional browser download integration requires Python 3:

- Ubuntu/Debian/Fedora: install `python3`.
- Arch Linux: install `python`.

`curl` is listed as a runtime dependency because vFinder also uses it for URL downloads.
