const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8",
);

function createHarness({ contentScriptLoaded }) {
  const listeners = { addListener() {} };
  const calls = [];
  let injectCalls = 0;
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    FormData,
    Blob,
    document: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    importScripts() {},
    chrome: {
      storage: { local: { setAccessLevel: () => Promise.resolve() } },
      action: { onClicked: listeners },
      sidePanel: { setPanelBehavior() {}, setOptions: () => Promise.resolve() },
      scripting: {
        async executeScript(options) {
          calls.push(options);
          return [{ result: options.func ? options.func() : null }];
        },
      },
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
  if (contentScriptLoaded) {
    sandbox.injectDigestButton = () => {
      injectCalls += 1;
      return true;
    };
  }
  vm.runInNewContext(source, sandbox);
  return {
    ensure: sandbox.__YTD_TRANSLATION_TESTING__.ensureYouTubeContentScript,
    calls,
    injectCalls: () => injectCalls,
  };
}

test("an existing content script is asked to reconcile without being re-executed", async () => {
  const harness = createHarness({ contentScriptLoaded: true });
  await harness.ensure(42);

  assert.equal(harness.injectCalls(), 1);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].world, "ISOLATED");
});

test("a missing content script is injected into an already-open YouTube tab", async () => {
  const harness = createHarness({ contentScriptLoaded: false });
  await harness.ensure(42);

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].target.tabId, 42);
  assert.deepEqual(Array.from(harness.calls[1].files), ["content.js"]);
});
