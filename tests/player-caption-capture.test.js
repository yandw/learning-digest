const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8",
);
const authorizedUrl =
  "https://www.youtube.com/api/timedtext?v=KvLWuK2TU-w&lang=en&potc=1&pot=token&c=WEB&fmt=json3";

function createHarness({ captionsInitiallyOn }) {
  const listeners = { addListener() {} };
  const timers = new Map();
  let nextTimer = 1;
  let button;
  const originalFetch = async () => ({ ok: true });
  const window = {
    location: { origin: "https://www.youtube.com" },
    fetch: originalFetch,
  };
  button = {
    pressed: captionsInitiallyOn,
    getAttribute(name) {
      return name === "aria-pressed" ? String(this.pressed) : null;
    },
    click() {
      this.pressed = !this.pressed;
      if (this.pressed) void window.fetch(authorizedUrl);
    },
  };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    FormData,
    Blob,
    window,
    document: {
      querySelector(selector) {
        return selector === ".ytp-subtitles-button" ? button : null;
      },
    },
    XMLHttpRequest: class {},
    setTimeout(fn, ms) {
      const id = nextTimer++;
      if (ms < 1000) fn();
      else timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    importScripts() {},
    chrome: {
      storage: { local: { setAccessLevel: () => Promise.resolve() } },
      action: { onClicked: listeners },
      sidePanel: { setPanelBehavior() {}, setOptions: () => Promise.resolve() },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        onConnect: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SPEECH_TRANSCRIPTION: {},
    YTD_CAPTIONS: {},
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return {
    capture: sandbox.__YTD_TRANSLATION_TESTING__.capturePlayerCaptionRequest,
    button,
    window,
    originalFetch,
    timers,
  };
}

test("capturing player authorization restores captions that were originally off", async () => {
  const harness = createHarness({ captionsInitiallyOn: false });
  const result = await harness.capture("KvLWuK2TU-w", 8000);

  assert.equal(result, authorizedUrl);
  assert.equal(harness.button.pressed, false);
  assert.equal(harness.window.fetch, harness.originalFetch);
});

test("capturing player authorization leaves captions on when they were already on", async () => {
  const harness = createHarness({ captionsInitiallyOn: true });
  const result = await harness.capture("KvLWuK2TU-w", 8000);

  assert.equal(result, authorizedUrl);
  assert.equal(harness.button.pressed, true);
  assert.equal(harness.window.fetch, harness.originalFetch);
});
