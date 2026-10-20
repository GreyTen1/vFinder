const NATIVE_HOST_NAME = "com.macosfinder.downloader";
const DEFAULT_PORT = 45456;
const handledDownloads = new Set();
const handledUrls = new Map(); // url -> timestamp

// Helper to identify internal non-downloadable browser pages
function isInternalUrl(url) {
  if (!url) return true;
  return (
    /^(chrome|brave|edge|opera|vivaldi|about|data|view-source):/i.test(url) ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("moz-extension://")
  );
}

// Helper to check if macOS Finder is running
async function isFinderRunning(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      method: "GET",
      signal: AbortSignal.timeout(400),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.status === "ok";
  } catch (err) {
    return false;
  }
}

// Get configured settings
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      { enabled: true, port: DEFAULT_PORT },
      (items) => resolve(items)
    );
  });
}

// Function to dispatch download to Finder (via Native Host or HTTP)
// Launches Finder and raises window to active workspace if closed
async function dispatchToFinder(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (response) => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[Finder] Native messaging unavailable, falling back to HTTP:",
            chrome.runtime.lastError.message
          );
          fetch(`http://127.0.0.1:${DEFAULT_PORT}/download/intercept`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
            .then((res) => resolve(res.ok))
            .catch(() => resolve(false));
        } else {
          console.log("[Finder] Native host launched/delivered payload:", response);
          resolve(true);
        }
      });
    } catch (err) {
      console.warn("[Finder] sendNativeMessage error:", err);
      fetch(`http://127.0.0.1:${DEFAULT_PORT}/download/intercept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((res) => resolve(res.ok))
        .catch(() => resolve(false));
    }
  });
}

// Setup context menus
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: "macos-finder-download",
      title: "Download with vFinder",
      contexts: ["page", "link", "image", "video", "audio"],
    });
  } catch (e) {
    // Already created
  }
});

// Handle Context Menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.linkUrl || info.srcUrl || info.pageUrl || (tab && tab.url);
  if (!targetUrl || isInternalUrl(targetUrl)) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  let cookieString = "";
  try {
    const cookies = await chrome.cookies.getAll({ url: targetUrl });
    if (cookies && cookies.length > 0) {
      cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
  } catch (err) {}

  const rawPart = targetUrl.split("?")[0].split("#")[0].split("/").pop() || "downloaded-file";
  const filename = decodeURIComponent(rawPart);

  const payload = {
    id: `ctx-${Date.now()}`,
    url: targetUrl,
    originalUrl: targetUrl,
    filename: filename,
    totalBytes: -1,
    mime: "",
    referrer: info.pageUrl || "",
    userAgent: navigator.userAgent,
    cookies: cookieString,
  };

  await dispatchToFinder(payload);
});

// Listen to download creation (handles blob: URLs)
chrome.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.enabled) return;

  if (!item.url || (isInternalUrl(item.url) && !item.url.startsWith("blob:"))) {
    return;
  }

  // Handle blob: URLs directly within browser extension memory
  if (item.url.startsWith("blob:")) {
    if (handledDownloads.has(item.id)) return;
    handledDownloads.add(item.id);

    try {
      try {
        await chrome.downloads.cancel(item.id);
        await chrome.downloads.erase({ id: item.id });
      } catch (e) {}

      const res = await fetch(item.url);
      const arrayBuffer = await res.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < uint8.byteLength; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const base64Data = btoa(binary);

      const rawName = item.filename
        ? item.filename.replace(/^.*[\\\/]/, "")
        : "download";

      const payload = {
        id: String(item.id),
        url: item.url,
        originalUrl: item.url,
        filename: rawName,
        totalBytes: arrayBuffer.byteLength,
        mime: item.mime || "",
        referrer: item.referrer || "",
        userAgent: navigator.userAgent,
        blobData: base64Data,
      };

      await dispatchToFinder(payload);
    } catch (e) {
      console.error("Failed to intercept blob download:", e);
    }
  }
});

// Main interception via onDeterminingFilename
// At this point, response headers (Content-Disposition, Content-Length) are available
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    const settings = await getSettings();
    if (!settings.enabled) {
      suggest();
      return;
    }

    if (!item.url || isInternalUrl(item.url)) {
      suggest();
      return;
    }

    if (handledDownloads.has(item.id)) {
      suggest();
      return;
    }

    const now = Date.now();
    const last = handledUrls.get(item.url);
    if (last && now - last < 2000) {
      suggest();
      return;
    }

    handledDownloads.add(item.id);
    handledUrls.set(item.url, now);

    // Cancel Chrome download so it is NOT saved in ~/Downloads twice
    try {
      chrome.downloads.cancel(item.id, () => {
        chrome.downloads.erase({ id: item.id });
      });
    } catch (e) {}

    // Extract cookies for authenticated session
    let cookieString = "";
    try {
      const cookies = await chrome.cookies.getAll({ url: item.url });
      if (cookies && cookies.length > 0) {
        cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }
    } catch (e) {}

    const cleanFilename = item.filename
      ? item.filename.replace(/^.*[\\\/]/, "")
      : item.url.split("?")[0].split("/").pop() || "downloaded-file";

    const payload = {
      id: String(item.id),
      url: item.finalUrl || item.url,
      originalUrl: item.url,
      filename: cleanFilename,
      totalBytes: item.totalBytes > 0 ? item.totalBytes : -1,
      mime: item.mime || "",
      referrer: item.referrer || "",
      userAgent: navigator.userAgent,
      cookies: cookieString,
    };

    // Launch/focus Finder and pop up download dialog
    await dispatchToFinder(payload);
  })();

  return true;
});

// Messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CHECK_STATUS") {
    (async () => {
      const settings = await getSettings();
      const alive = await isFinderRunning(settings.port);
      sendResponse({ enabled: settings.enabled, port: settings.port, alive });
    })();
    return true;
  }

  if (msg.type === "SET_ENABLED") {
    chrome.storage.local.set({ enabled: msg.enabled }, () => {
      sendResponse({ success: true, enabled: msg.enabled });
    });
    return true;
  }

  if (msg.type === "SEND_TEST_DOWNLOAD") {
    (async () => {
      const payload = {
        id: `test-${Date.now()}`,
        url: "https://proof.ovh.net/files/1Mb.dat",
        originalUrl: "https://proof.ovh.net/files/1Mb.dat",
        filename: "1Mb-test-file.dat",
        totalBytes: 1048576,
        mime: "application/octet-stream",
        referrer: "chrome-extension://test",
        userAgent: navigator.userAgent,
      };
      const ok = await dispatchToFinder(payload);
      sendResponse({ success: ok });
    })();
    return true;
  }

  if (msg.type === "INTERCEPT_CTRL_S") {
    (async () => {
      const settings = await getSettings();
      if (!settings.enabled) return;

      const targetUrl = msg.url || (_sender.tab && _sender.tab.url);
      if (!targetUrl || isInternalUrl(targetUrl)) return;

      // Extract cookies for authenticated session
      let cookieString = "";
      try {
        const cookies = await chrome.cookies.getAll({ url: targetUrl });
        if (cookies && cookies.length > 0) {
          cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        }
      } catch (e) {}

      // Derive suitable filename
      let filename = "page.html";
      try {
        const urlObj = new URL(targetUrl);
        const lastPart = urlObj.pathname.split("/").filter(Boolean).pop();
        if (lastPart && lastPart.includes(".")) {
          filename = decodeURIComponent(lastPart);
        } else if (msg.title) {
          const clean = msg.title.replace(/[\/\\?%*:|"<>]/g, "_").trim();
          filename = `${clean || "page"}.html`;
        }
      } catch (e) {
        filename = "downloaded-file.html";
      }

      const payload = {
        id: `ctrls-${Date.now()}`,
        url: targetUrl,
        originalUrl: targetUrl,
        filename,
        totalBytes: -1,
        mime: "",
        referrer: targetUrl,
        userAgent: navigator.userAgent,
        cookies: cookieString,
        blobData: msg.htmlData || null,
      };

      const ok = await dispatchToFinder(payload);
      sendResponse({ success: ok });
    })();
    return true;
  }
});

// Shortcut command listener (Ctrl+Shift+S / Cmd+Shift+S)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "save-with-finder") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !isInternalUrl(tab.url)) {
      let cookieString = "";
      try {
        const cookies = await chrome.cookies.getAll({ url: tab.url });
        if (cookies && cookies.length > 0) {
          cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        }
      } catch (e) {}

      let filename = "page.html";
      try {
        const urlObj = new URL(tab.url);
        const lastPart = urlObj.pathname.split("/").filter(Boolean).pop();
        if (lastPart && lastPart.includes(".")) {
          filename = decodeURIComponent(lastPart);
        } else if (tab.title) {
          const clean = tab.title.replace(/[\/\\?%*:|"<>]/g, "_").trim();
          filename = `${clean || "page"}.html`;
        }
      } catch (e) {}

      const payload = {
        id: `cmd-${Date.now()}`,
        url: tab.url,
        originalUrl: tab.url,
        filename,
        totalBytes: -1,
        mime: "",
        referrer: tab.url,
        userAgent: navigator.userAgent,
        cookies: cookieString,
      };

      await dispatchToFinder(payload);
    }
  }
});

// Automatically inject content.js into all existing HTTP/HTTPS tabs on extension reload
function injectIntoAllTabs() {
  if (!chrome.scripting) return;
  chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs) => {
    if (!tabs || chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (tab.id) {
        chrome.scripting
          .executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ["content.js"],
          })
          .catch(() => {});
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoAllTabs();
});
injectIntoAllTabs();

