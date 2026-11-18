// vFinder Download Manager - Main World File Input Interceptor
// Replaces the browser's OS file picker for <input type="file"> and
// window.showOpenFilePicker when enabled.

(function () {
  if (window.__vfinderPickerMainLoaded) return;
  window.__vfinderPickerMainLoaded = true;

  const pendingInputs = new Map();
  const pendingHandleResolvers = new Map();
  const bypassInputs = new WeakSet();
  const lastTriggeredAt = new WeakMap();
  const incomingTransfers = new Map();

  const origClick = HTMLInputElement.prototype.click;
  const origShowPicker =
    typeof HTMLInputElement.prototype.showPicker === "function"
      ? HTMLInputElement.prototype.showPicker
      : null;
  const origShowOpenFilePicker =
    typeof window.showOpenFilePicker === "function"
      ? window.showOpenFilePicker
      : null;

  function isEnabled() {
    const flag = document.documentElement?.dataset?.vfinderEnabled;
    return flag !== "0";
  }

  function decodeBase64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function newPickerId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function dispatchPickRequest(detail) {
    document.dispatchEvent(
      new CustomEvent("__vfinder_pick_request", {
        detail: JSON.stringify(detail),
      })
    );
  }

  function triggerVfinderPicker(input) {
    const now = Date.now();
    const prev = lastTriggeredAt.get(input) || 0;
    if (now - prev < 300) {
      return;
    }
    lastTriggeredAt.set(input, now);

    const pickerId = newPickerId();
    pendingInputs.set(pickerId, {
      input,
      wasConnected: Boolean(input.isConnected),
    });
    dispatchPickRequest({
      pickerId,
      url: window.location.href,
      accept: input.accept || "",
      multiple: Boolean(input.multiple),
      directory: Boolean(
        input.webkitdirectory ||
          input.hasAttribute("webkitdirectory") ||
          input.hasAttribute("directory")
      ),
    });
  }

  function extractAcceptFromOpenPickerOptions(options) {
    if (!options || !Array.isArray(options.types)) return "";
    const tokens = [];
    for (const entry of options.types) {
      if (!entry || !entry.accept || typeof entry.accept !== "object") continue;
      for (const mime of Object.keys(entry.accept)) {
        const exts = entry.accept[mime];
        if (Array.isArray(exts) && exts.length > 0) {
          for (const ext of exts) {
            if (typeof ext === "string" && ext) tokens.push(ext);
          }
        } else if (mime) {
          tokens.push(mime);
        }
      }
    }
    return tokens.join(",");
  }

  function findFileInputFromEvent(e) {
    const path =
      typeof e.composedPath === "function" ? e.composedPath() : [e.target];
    for (const node of path) {
      if (!node) continue;
      if (node instanceof HTMLInputElement && node.type === "file") {
        return node;
      }
      if (typeof HTMLLabelElement !== "undefined" && node instanceof HTMLLabelElement) {
        if (node.control instanceof HTMLInputElement && node.control.type === "file") {
          return node.control;
        }
        if (typeof node.querySelector === "function") {
          const nested = node.querySelector('input[type="file"]');
          if (nested instanceof HTMLInputElement && nested.type === "file") {
            return nested;
          }
        }
      }
    }
    return null;
  }

  function resolveTargetInput(entry) {
    if (!entry || !entry.input) return null;
    const { input, wasConnected } = entry;
    if (!wasConnected || input.isConnected) {
      return input;
    }
    if (typeof document.querySelectorAll === "function") {
      const candidates = Array.from(
        document.querySelectorAll('input[type="file"]')
      );
      const accept = input.accept || "";
      const multiple = Boolean(input.multiple);
      const exact = candidates.find(
        (el) => (el.accept || "") === accept && Boolean(el.multiple) === multiple
      );
      if (exact) return exact;
      if (candidates.length > 0) return candidates[0];
    }
    if (typeof document.querySelector === "function") {
      return document.querySelector('input[type="file"]') || input;
    }
    return input;
  }

  HTMLInputElement.prototype.click = function () {
    if (
      this instanceof HTMLInputElement &&
      this.type === "file" &&
      !bypassInputs.has(this) &&
      !this.disabled &&
      isEnabled()
    ) {
      triggerVfinderPicker(this);
      return;
    }
    return origClick.apply(this, arguments);
  };

  if (origShowPicker) {
    HTMLInputElement.prototype.showPicker = function () {
      if (
        this instanceof HTMLInputElement &&
        this.type === "file" &&
        !bypassInputs.has(this) &&
        !this.disabled &&
        isEnabled()
      ) {
        triggerVfinderPicker(this);
        return;
      }
      return origShowPicker.apply(this, arguments);
    };
  }

  if (origShowOpenFilePicker) {
    window.showOpenFilePicker = function (options) {
      if (!isEnabled()) {
        return origShowOpenFilePicker.apply(this, arguments);
      }
      const args = Array.from(arguments);
      const pickerId = newPickerId();
      return new Promise((resolve, reject) => {
        pendingHandleResolvers.set(pickerId, { resolve, reject, args });
        dispatchPickRequest({
          pickerId,
          url: window.location.href,
          accept: extractAcceptFromOpenPickerOptions(options),
          multiple: Boolean(options && options.multiple),
          directory: false,
        });
      });
    };
  }

  window.addEventListener(
    "click",
    function (e) {
      if (!isEnabled()) return;
      const target = findFileInputFromEvent(e);
      if (!target || target.disabled || bypassInputs.has(target)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      triggerVfinderPicker(target);
    },
    true
  );

  document.addEventListener("__vfinder_pick_response", function (event) {
    let msg;
    try {
      msg =
        typeof event.detail === "string"
          ? JSON.parse(event.detail)
          : event.detail;
    } catch {
      return;
    }
    if (!msg || !msg.pickerId) return;
    const { pickerId } = msg;

    if (msg.type === "PICKER_FILE_START") {
      let transfer = incomingTransfers.get(pickerId);
      if (!transfer) {
        transfer = [];
        incomingTransfers.set(pickerId, transfer);
      }
      transfer[msg.index] = {
        name: msg.name || "file",
        mimeType: msg.mimeType || "application/octet-stream",
        lastModified: msg.lastModified || Date.now(),
        webkitRelativePath: msg.webkitRelativePath || "",
        chunks: [],
      };
      return;
    }

    if (msg.type === "PICKER_FILE_CHUNK") {
      const transfer = incomingTransfers.get(pickerId);
      const slot = transfer && transfer[msg.index];
      if (slot && msg.chunkB64) {
        slot.chunks.push(decodeBase64ToBytes(msg.chunkB64));
      }
      return;
    }

    if (msg.type === "PICKER_COMPLETE") {
      const inputEntry = pendingInputs.get(pickerId);
      const handleResolver = pendingHandleResolvers.get(pickerId);
      const transfer = incomingTransfers.get(pickerId) || [];
      pendingInputs.delete(pickerId);
      pendingHandleResolvers.delete(pickerId);
      incomingTransfers.delete(pickerId);

      const files = [];
      for (const item of transfer) {
        if (!item) continue;
        const file = new File(item.chunks, item.name, {
          type: item.mimeType,
          lastModified: item.lastModified,
        });
        if (item.webkitRelativePath) {
          try {
            Object.defineProperty(file, "webkitRelativePath", {
              value: item.webkitRelativePath,
              configurable: true,
            });
          } catch {
            // ignore
          }
        }
        files.push(file);
      }

      if (handleResolver) {
        const handles = files.map((file) => ({
          kind: "file",
          name: file.name,
          getFile: async () => file,
          isSameEntry: async (other) =>
            Boolean(other && other.kind === "file" && other.name === file.name),
          queryPermission: async () => "granted",
          requestPermission: async () => "granted",
        }));
        handleResolver.resolve(handles);
        return;
      }

      const input = resolveTargetInput(inputEntry);
      if (!input) return;

      const dt = new DataTransfer();
      for (const file of files) {
        dt.items.add(file);
      }

      const nativeFilesSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "files"
      )?.set;
      if (nativeFilesSetter) {
        nativeFilesSetter.call(input, dt.files);
      } else {
        input.files = dt.files;
      }
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }

    if (msg.type === "PICKER_CANCEL" || msg.type === "PICKER_FALLBACK") {
      const inputEntry = pendingInputs.get(pickerId);
      const handleResolver = pendingHandleResolvers.get(pickerId);
      pendingInputs.delete(pickerId);
      pendingHandleResolvers.delete(pickerId);
      incomingTransfers.delete(pickerId);

      if (handleResolver) {
        if (msg.type === "PICKER_FALLBACK" && msg.fallback && origShowOpenFilePicker) {
          origShowOpenFilePicker
            .apply(window, handleResolver.args)
            .then(handleResolver.resolve, handleResolver.reject);
        } else {
          const abortErr = new Error("The user aborted a request.");
          abortErr.name = "AbortError";
          handleResolver.reject(abortErr);
        }
        return;
      }

      const input = resolveTargetInput(inputEntry);
      if (!input) return;

      if (msg.type === "PICKER_FALLBACK" && msg.fallback) {
        bypassInputs.add(input);
        try {
          origClick.call(input);
        } finally {
          bypassInputs.delete(input);
        }
      } else {
        input.dispatchEvent(new Event("cancel", { bubbles: false }));
      }
    }
  });
})();
