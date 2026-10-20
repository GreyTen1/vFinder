// macOS Finder Download Manager - Content Script
// Intercepts Ctrl+S / Cmd+S on web pages and media tabs to route directly to Finder

(function () {
  // Prevent duplicate execution if injected multiple times
  if (window.__finderContentScriptLoaded) return;
  window.__finderContentScriptLoaded = true;

  function handleSaveKey(e) {
    const isS = e.key === "s" || e.key === "S" || e.code === "KeyS" || e.keyCode === 83;
    if ((e.ctrlKey || e.metaKey) && isS && !e.altKey) {
      const active = document.activeElement;

      // Do not intercept if user is inside a form input, textarea, or web-based code/text editor
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable ||
          active.closest?.(
            "[contenteditable='true'], .monaco-editor, .cm-editor, .ace_editor, .CodeMirror, .kix-appview"
          ))
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Check if current tab is viewing a standalone image or media element
      let mediaUrl = null;
      const onlyImg = document.querySelector("body > img:only-child");
      if (onlyImg && onlyImg.src && onlyImg.src.startsWith("http")) {
        mediaUrl = onlyImg.src;
      }
      const onlyVideo = document.querySelector("body > video:only-child");
      if (onlyVideo && onlyVideo.currentSrc && onlyVideo.currentSrc.startsWith("http")) {
        mediaUrl = onlyVideo.currentSrc;
      }

      // If saving an HTML webpage, capture the rendered HTML DOM
      let base64Html = null;
      if (!mediaUrl && document.documentElement) {
        try {
          const docType = document.doctype
            ? new XMLSerializer().serializeToString(document.doctype) + "\n"
            : "<!DOCTYPE html>\n";
          const fullHtml = docType + document.documentElement.outerHTML;
          const bytes = new TextEncoder().encode(fullHtml);
          let binary = "";
          const len = bytes.length;
          const chunkSize = 8192;
          for (let i = 0; i < len; i += chunkSize) {
            const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
            binary += String.fromCharCode.apply(null, chunk);
          }
          base64Html = btoa(binary);
        } catch (err) {
          console.warn("[Finder] Error serializing HTML:", err);
        }
      }

      try {
        chrome.runtime.sendMessage(
          {
            type: "INTERCEPT_CTRL_S",
            url: mediaUrl || window.location.href,
            title: document.title,
            htmlData: base64Html,
          },
          () => {
            // Check for lastError to silence harmless port closures
            if (chrome.runtime.lastError) {
              // Service worker will handle on wake
            }
          }
        );
      } catch (err) {
        console.warn("[Finder] Failed to send INTERCEPT_CTRL_S message:", err);
      }
    }
  }

  window.addEventListener("keydown", handleSaveKey, { capture: true, passive: false });
  document.addEventListener("keydown", handleSaveKey, { capture: true, passive: false });
})();
