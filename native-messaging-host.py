#!/usr/bin/env python3
import sys
import json
import struct
import urllib.request
import urllib.error
import subprocess
import time
import os

import shutil

SERVER_URL = "http://127.0.0.1:45456"

def find_finder_binary():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "vfinder"),
        os.path.join(script_dir, "vFinder"),
        os.path.join(script_dir, "finder"),
        os.path.join(script_dir, "src-tauri", "target", "release", "vfinder"),
        os.path.join(script_dir, "src-tauri", "target", "release", "macos-finder"),
        shutil.which("vfinder"),
        shutil.which("vFinder"),
        shutil.which("macos-finder"),
        shutil.which("finder"),
        os.path.expanduser("~/.local/bin/vfinder"),
        os.path.expanduser("~/.local/bin/finder"),
        os.path.expanduser("~/.local/bin/macos-finder"),
        "/usr/local/bin/vfinder",
        "/usr/bin/vfinder",
        "/usr/local/bin/finder",
        "/usr/bin/finder",
        "/usr/bin/macos-finder",
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c, os.path.dirname(c)
    fallback = os.path.join(script_dir, "vfinder")
    if not os.path.isfile(fallback):
        fallback = os.path.join(script_dir, "finder")
    return fallback, script_dir

def log(msg):
    # Optional debug logging if needed
    try:
        with open("/tmp/vfinder-native-host.log", "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass

def is_finder_running():
    try:
        req = urllib.request.Request(f"{SERVER_URL}/ping", headers={"User-Agent": "NativeHost"})
        with urllib.request.urlopen(req, timeout=0.3) as resp:
            return resp.status == 200
    except Exception:
        return False

def raise_finder_window():
    """Raise and focus Finder window across various Linux Desktop Environments."""
    xdg_desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
    is_hyprland = bool(os.environ.get("HYPRLAND_INSTANCE_SIGNATURE")) or "hyprland" in xdg_desktop
    is_sway = bool(os.environ.get("SWAYSOCK"))
    is_i3 = bool(os.environ.get("I3SOCK"))

    if is_hyprland and shutil.which("hyprctl"):
        try:
            subprocess.run(["hyprctl", "dispatch", "focuswindow", "class:^(vfinder|vFinder|finder)$"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.5)
            subprocess.run(["hyprctl", "dispatch", "alterzorder", "top,class:^(vfinder|vFinder|finder)$"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.5)
            return
        except Exception as e:
            log(f"hyprctl error: {e}")

    if is_sway and shutil.which("swaymsg"):
        try:
            subprocess.run(["swaymsg", '[app_id="(?i)(vfinder|finder)"] focus'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.5)
            return
        except Exception as e:
            log(f"swaymsg error: {e}")

    if is_i3 and shutil.which("i3-msg"):
        try:
            subprocess.run(["i3-msg", '[class="(?i)(vfinder|finder)"] focus'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.5)
            return
        except Exception as e:
            log(f"i3-msg error: {e}")

    # Generic X11 / Xwayland helpers (GNOME X11, KDE X11, XFCE, Cinnamon, MATE, LXQt, etc.)
    if shutil.which("wmctrl"):
        try:
            res = subprocess.run(["wmctrl", "-x", "-a", "vfinder"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.5)
            if res.returncode != 0:
                subprocess.run(["wmctrl", "-x", "-a", "finder"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.5)
            return
        except Exception as e:
            log(f"wmctrl error: {e}")
    elif shutil.which("xdotool"):
        try:
            res = subprocess.run(["xdotool", "search", "--class", "vfinder", "windowactivate"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.5)
            if res.returncode != 0:
                subprocess.run(["xdotool", "search", "--class", "finder", "windowactivate"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.5)
            return
        except Exception as e:
            log(f"xdotool error: {e}")

def main():
    log("Native messaging host invoked")
    
    # Read message length (4 bytes little-endian uint32)
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        log("No input length received, exiting")
        sys.exit(0)

    message_length = struct.unpack('<I', raw_length)[0]
    raw_message = sys.stdin.buffer.read(message_length)
    if not raw_message:
        log("Empty message body, exiting")
        sys.exit(0)

    try:
        data = json.loads(raw_message.decode('utf-8'))
        log(f"Received payload for URL: {data.get('url')} filename: {data.get('filename')}")
    except Exception as e:
        log(f"JSON parse error: {e}")
        data = {}

    # Check if Finder is running; if not, launch it
    if not is_finder_running():
        finder_bin, finder_dir = find_finder_binary()
        log(f"Finder not running. Launching Finder from {finder_bin}...")
        try:
            env = os.environ.copy()
            env["MACOS_FINDER_SPAWNED_BY_DOWNLOAD"] = "1"
            subprocess.Popen(
                [finder_bin],
                cwd=finder_dir,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                start_new_session=True
            )
        except Exception as e:
            log(f"Failed to launch Finder: {e}")

        # Wait up to 3 seconds for Finder server to become ready
        for i in range(30):
            time.sleep(0.1)
            if is_finder_running():
                log(f"Finder started and ready after {(i + 1) * 100}ms")
                break

    # Send the download payload to Finder server
    success = False
    try:
        payload_bytes = json.dumps(data).encode('utf-8')
        req = urllib.request.Request(
            f"{SERVER_URL}/download/intercept",
            data=payload_bytes,
            headers={"Content-Type": "application/json", "User-Agent": "NativeHost"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            success = (resp.status == 200)
            log("Successfully posted download to Finder server")
    except Exception as e:
        log(f"Error posting to Finder server: {e}")

    # Bring Finder window to front
    time.sleep(0.15)
    raise_finder_window()
    time.sleep(0.35)
    raise_finder_window()

    # Send response back to browser
    resp_obj = {"success": success, "status": "popped_up"}
    resp_json = json.dumps(resp_obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(resp_json)))
    sys.stdout.buffer.write(resp_json)
    sys.stdout.buffer.flush()
    log("Response sent to Chrome, host exiting cleanly")

if __name__ == "__main__":
    main()
