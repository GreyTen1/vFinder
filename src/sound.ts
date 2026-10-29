import emptyTrashUrl from "./assets/audio/empty-trash.ogg";
import fileTrashUrl from "./assets/audio/file-trash.ogg";
import moveCopyUrl from "./assets/audio/move-copy.ogg";
import { apiPlaySoundEffect } from "./api";

export type SoundEffect = "file-trash" | "empty-trash" | "move-copy";

const SOUND_URLS: Record<SoundEffect, string> = {
  "empty-trash": emptyTrashUrl,
  "file-trash": fileTrashUrl,
  "move-copy": moveCopyUrl,
};

// Cache Audio elements for instant, low-latency playback in browser / WebKitGTK
const audioCache = new Map<SoundEffect, HTMLAudioElement>();

function getAudio(effect: SoundEffect): HTMLAudioElement {
  let audio = audioCache.get(effect);
  if (!audio) {
    audio = new Audio(SOUND_URLS[effect]);
    audio.preload = "auto";
    audioCache.set(effect, audio);
  }
  return audio;
}

/**
 * Play a UI sound effect.
 * Triggers both native system playback (canberra-gtk-play / pw-play / paplay)
 * and HTML5 WebAudio/Audio fallback so it always plays reliably on Linux desktops.
 */
export function playSound(effect: SoundEffect): void {
  // 1. Invoke native Linux desktop sound player via Tauri backend
  void apiPlaySoundEffect(effect);

  // 2. Also attempt HTML5 Audio playback in WebView
  try {
    const primary = getAudio(effect);
    if (primary.paused || primary.ended) {
      primary.currentTime = 0;
      void primary.play().catch(() => {});
    } else {
      const clone = primary.cloneNode(true) as HTMLAudioElement;
      void clone.play().catch(() => {});
    }
  } catch {
    // Silently continue
  }
}

