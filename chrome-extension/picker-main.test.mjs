import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pickerMainSource = fs.readFileSync(
  path.join(__dirname, "picker-main.js"),
  "utf8"
);

function createMockEnvironment({ hasNativeShowOpenFilePicker = true } = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const dispatchedPickRequests = [];
  const allFileInputs = [];

  class MockEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.composed = Boolean(init.composed);
    }
  }

  class MockCustomEvent extends MockEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail;
    }
  }

  class MockFile {
    constructor(chunks, name, options = {}) {
      this._chunks = chunks;
      this.name = name;
      this.type = options.type || "";
      this.lastModified = options.lastModified || 0;
    }
    async text() {
      return Buffer.concat(this._chunks.map((c) => Buffer.from(c))).toString("utf8");
    }
  }

  class MockFileList {
    constructor(items) {
      this._items = items;
      for (let i = 0; i < items.length; i++) {
        this[i] = items[i];
      }
    }
    get length() {
      return this._items.length;
    }
    item(i) {
      return this._items[i] || null;
    }
  }

  class MockDataTransfer {
    constructor() {
      this._files = [];
      this.items = {
        add: (file) => {
          this._files.push(file);
        },
      };
    }
    get files() {
      return new MockFileList(this._files);
    }
  }

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.isConnected = true;
      this.disabled = false;
      this._attrs = new Map();
      this._events = [];
      this.children = [];
      this.parentElement = null;
    }
    setAttribute(k, v) {
      this._attrs.set(k, String(v));
    }
    hasAttribute(k) {
      return this._attrs.has(k);
    }
    dispatchEvent(ev) {
      this._events.push(ev);
      return true;
    }
    querySelector(selector) {
      if (selector === 'input[type="file"]') {
        for (const child of this.children) {
          if (child instanceof MockHTMLInputElement && child.type === "file") {
            return child;
          }
          const nested = child.querySelector?.(selector);
          if (nested) return nested;
        }
      }
      return null;
    }
  }

  let nativeFilesSetterCalls = 0;
  class MockHTMLInputElement extends MockElement {
    constructor() {
      super("INPUT");
      this.type = "file";
      this.accept = "";
      this.multiple = false;
      this.webkitdirectory = false;
      this._files = new MockFileList([]);
      allFileInputs.push(this);
    }
    click() {}
    showPicker() {}
  }

  Object.defineProperty(MockHTMLInputElement.prototype, "files", {
    configurable: true,
    get() {
      return this._files;
    },
    set(val) {
      nativeFilesSetterCalls++;
      this._files = val;
    },
  });

  class MockHTMLLabelElement extends MockElement {
    constructor(control = null) {
      super("LABEL");
      this.control = control;
    }
  }

  const document = {
    documentElement: { dataset: { vfinderEnabled: "1" } },
    addEventListener(type, fn) {
      const list = documentListeners.get(type) || [];
      list.push(fn);
      documentListeners.set(type, list);
    },
    dispatchEvent(ev) {
      if (ev.type === "__vfinder_pick_request") {
        dispatchedPickRequests.push(
          typeof ev.detail === "string" ? JSON.parse(ev.detail) : ev.detail
        );
      }
      for (const fn of documentListeners.get(ev.type) || []) {
        fn(ev);
      }
      return true;
    },
    querySelector(selector) {
      if (selector === 'input[type="file"]') {
        return allFileInputs.find((i) => i.isConnected) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') {
        return allFileInputs.filter((i) => i.isConnected);
      }
      return [];
    },
  };

  const windowObj = {
    location: { href: "https://upload.example.test/form" },
    addEventListener(type, fn, capture) {
      const list = windowListeners.get(type) || [];
      list.push({ fn, capture: Boolean(capture) });
      windowListeners.set(type, list);
    },
  };
  if (hasNativeShowOpenFilePicker) {
    windowObj.showOpenFilePicker = async () => {
      throw new Error("Native showOpenFilePicker should have been intercepted");
    };
  }

  const sandbox = {
    window: windowObj,
    document,
    HTMLInputElement: MockHTMLInputElement,
    HTMLLabelElement: MockHTMLLabelElement,
    Event: MockEvent,
    CustomEvent: MockCustomEvent,
    DataTransfer: MockDataTransfer,
    File: MockFile,
    Uint8Array,
    atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
    Map,
    WeakMap,
    WeakSet,
    Date,
    Math,
    JSON,
    Promise,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowObj;

  vm.createContext(sandbox);
  vm.runInContext(pickerMainSource, sandbox);

  function fireWindowClick(target, { isTrusted = true, path = null } = {}) {
    let defaultPrevented = false;
    let propagationStopped = false;
    let immediateStopped = false;
    const composed = path || [target, target.parentElement].filter(Boolean);
    const event = {
      type: "click",
      isTrusted,
      target,
      composedPath: () => composed,
      preventDefault() {
        defaultPrevented = true;
      },
      stopPropagation() {
        propagationStopped = true;
      },
      stopImmediatePropagation() {
        immediateStopped = true;
      },
    };
    for (const entry of windowListeners.get("click") || []) {
      entry.fn(event);
    }
    return { defaultPrevented, propagationStopped, immediateStopped };
  }

  function sendResponse(detail) {
    document.dispatchEvent(
      new MockCustomEvent("__vfinder_pick_response", {
        detail: JSON.stringify(detail),
      })
    );
  }

  return {
    window: windowObj,
    document,
    MockHTMLInputElement,
    MockHTMLLabelElement,
    MockElement,
    dispatchedPickRequests,
    fireWindowClick,
    sendResponse,
    getNativeFilesSetterCalls: () => nativeFilesSetterCalls,
  };
}

describe("chrome-extension/picker-main.js", () => {
  it("intercepts clicks on a <label> wrapping an <input type='file'> and prevents native picker", () => {
    const env = createMockEnvironment();
    const input = new env.MockHTMLInputElement();
    input.accept = ".png,.jpg";
    input.multiple = true;
    const label = new env.MockHTMLLabelElement(input);
    const span = new env.MockElement("SPAN");
    span.parentElement = label;
    label.children.push(input, span);

    const outcome = env.fireWindowClick(span, {
      isTrusted: true,
      path: [span, label, env.document],
    });

    assert.equal(outcome.defaultPrevented, true);
    assert.equal(env.dispatchedPickRequests.length, 1);
    assert.equal(env.dispatchedPickRequests[0].accept, ".png,.jpg");
    assert.equal(env.dispatchedPickRequests[0].multiple, true);
  });

  it("populates input.files via HTMLInputElement.prototype.files setter and dispatches input/change events", async () => {
    const env = createMockEnvironment();
    const input = new env.MockHTMLInputElement();

    // Define an instance property trap to verify HTMLInputElement.prototype.files setter is used directly (React pattern)
    let ownAssignCount = 0;
    Object.defineProperty(input, "files", {
      configurable: true,
      get() {
        return this._files;
      },
      set(val) {
        ownAssignCount++;
        this._files = val;
      },
    });
    input.click();
    assert.equal(env.dispatchedPickRequests.length, 1);
    const { pickerId } = env.dispatchedPickRequests[0];

    const payloadBytes = Buffer.from("hello-vfinder-upload", "utf8").toString("base64");
    env.sendResponse({
      type: "PICKER_FILE_START",
      pickerId,
      index: 0,
      name: "hello.txt",
      mimeType: "text/plain",
      lastModified: 1700000001234,
      webkitRelativePath: "",
    });
    env.sendResponse({
      type: "PICKER_FILE_CHUNK",
      pickerId,
      index: 0,
      chunkB64: payloadBytes,
    });
    env.sendResponse({
      type: "PICKER_COMPLETE",
      pickerId,
    });

    assert.equal(ownAssignCount, 0);
    assert.equal(env.getNativeFilesSetterCalls(), 1);
    assert.equal(input.files.length, 1);
    assert.equal(input.files.item(0).name, "hello.txt");
    assert.equal(await input.files.item(0).text(), "hello-vfinder-upload");
    assert.deepEqual(
      input._events.map((e) => e.type),
      ["input", "change"]
    );
  });

  it("falls back to a connected replacement input if original input was unmounted while picking", async () => {
    const env = createMockEnvironment();
    const originalInput = new env.MockHTMLInputElement();
    originalInput.accept = ".png";
    originalInput.click();
    assert.equal(env.dispatchedPickRequests.length, 1);
    const { pickerId } = env.dispatchedPickRequests[0];

    // Simulate React re-rendering and replacing the original <input type="file">
    originalInput.isConnected = false;
    const replacementInput = new env.MockHTMLInputElement();
    replacementInput.accept = ".png";

    env.sendResponse({
      type: "PICKER_FILE_START",
      pickerId,
      index: 0,
      name: "replacement.png",
      mimeType: "image/png",
      lastModified: 1700000003000,
    });
    env.sendResponse({
      type: "PICKER_FILE_CHUNK",
      pickerId,
      index: 0,
      chunkB64: Buffer.from("OK", "utf8").toString("base64"),
    });
    env.sendResponse({
      type: "PICKER_COMPLETE",
      pickerId,
    });

    assert.equal(replacementInput.files.length, 1);
    assert.equal(replacementInput.files.item(0).name, "replacement.png");
    assert.deepEqual(
      replacementInput._events.map((e) => e.type),
      ["input", "change"]
    );
  });

  it("intercepts window.showOpenFilePicker and resolves with FileSystemFileHandle-compatible objects", async () => {
    const env = createMockEnvironment({ hasNativeShowOpenFilePicker: true });

    const handlesPromise = env.window.showOpenFilePicker({
      multiple: true,
      types: [
        {
          accept: {
            "image/png": [".png"],
          },
        },
      ],
    });

    assert.equal(env.dispatchedPickRequests.length, 1);
    const req = env.dispatchedPickRequests[0];
    assert.equal(req.multiple, true);
    assert.match(req.accept, /\.png/);

    env.sendResponse({
      type: "PICKER_FILE_START",
      pickerId: req.pickerId,
      index: 0,
      name: "shot.png",
      mimeType: "image/png",
      lastModified: 1700000002000,
    });
    env.sendResponse({
      type: "PICKER_FILE_CHUNK",
      pickerId: req.pickerId,
      index: 0,
      chunkB64: Buffer.from("PNGDATA", "utf8").toString("base64"),
    });
    env.sendResponse({
      type: "PICKER_COMPLETE",
      pickerId: req.pickerId,
    });

    const handles = await handlesPromise;
    assert.equal(handles.length, 1);
    assert.equal(handles[0].kind, "file");
    assert.equal(handles[0].name, "shot.png");
    const file = await handles[0].getFile();
    assert.equal(await file.text(), "PNGDATA");
  });
});
