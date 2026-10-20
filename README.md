# vFinder #

macOS' file exlorer, but for linux

![vFinder_logo](https://github.com/GreyTen1/vFinder/blob/main/src-tauri/icons/Square142x142Logo.png)

## What is this? ##

A file explorer written in TypeScript and Rust

## Why would I use it? ##

It looks cool! currently, there are many other incredible good options around here, but none of them looks like macos' file explorer (finder)
altough It's way far from perfect right now, I believe it can be a usable daily driver for those who enjoy this aesthetic 

## Compatible distros ##

Ubuntu (26.04,25.04,24,04) 

Dependencies:

    sudo apt install -y \
      libwebkit2gtk-4.1-0 \
      libgtk-3-0 \
      libsoup-3.0-0 \
      udisks2 \
      util-linux \
      curl \
      python3 \
      dosfstools \
      exfatprogs \
      e2fsprogs \
      btrfs-progs \
      ntfs-3g

Debian (13, 12) ☑️ tested

Runtime dependencies:

    sudo apt install -y \
      libwebkit2gtk-4.1-0 \
      libgtk-3-0 \
      libsoup-3.0-0 \
      udisks2 \
      util-linux \
      curl \
      python3 \
      dosfstools \
      exfatprogs \
      e2fsprogs \
      btrfs-progs \
      ntfs-3g

Arch and derivatives ☑️ tested

    sudo pacman -S --needed \
      webkit2gtk-4.1 \
      gtk3 \
      libsoup3 \
      udisks2 \
      util-linux \
      curl \
      python \
      dosfstools \
      exfatprogs \
      e2fsprogs \
      btrfs-progs \
      ntfs-3g



These are the dependencies youll need if you want to compile it by yourself: (ubuntu)

    sudo apt install -y \
      build-essential \
      pkg-config \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libsoup-3.0-dev \
      libssl-dev \
      nodejs \
      npm \
      cargo \
      rustc
