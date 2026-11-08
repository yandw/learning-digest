/**
 * Shared test seam: runs background.js inside a Node VM with a stubbed
 * chrome API and injectable fetch/timers, exposing the pure-ish helpers
 * background.js exports for tests (__YTD_TRANSLATION_TESTING__).
 *
 * Used by translation.test.js (which introduced it),
 * session-summary.test.js (Topic tick + global pass glue, #18/#29) and
 * background-capture.test.js (capture orchestration).
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Serves prompts/*.md to the loadPromptSection fetch seam (in the service
 * worker it is chrome.runtime.getURL + fetch). Real files are read from
 * disk so the flows exercise the shipped templates; `promptFiles` overrides
 * a file by name, where null simulates a missing file (404) for the failure
 * tests. Every other URL goes to the injected fetchImpl (AI Provider,
 * speech providers).
 */
function promptAwareFetch(fetchImpl, promptFiles = {}) {
  return async (url, options) => {
    const match = String(url).match(/\/prompts\/([^/?#]+)$/);
    if (match) {
      const fileName = match[1];
      if (Object.hasOwn(promptFiles, fileName)) {
        const content = promptFiles[fileName];
        if (content === null) return { ok: false, status: 404 };
        return { ok: true, text: async () => content };
      }
      const filePath = path.join(root, "prompts", fileName);
      if (!fs.existsSync(filePath)) return { ok: false, status: 404 };
      return { ok: true, text: async () => fs.readFileSync(filePath, "utf8") };
    }
    return fetchImpl(url, options);
  };
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
  },
  fetchImpl = fetch,
  promptFiles = {},
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  setIntervalImpl = () => 0,
  clearIntervalImpl = () => {},
  offscreenDocument = true,
  getMediaStreamId = async () => "test-stream-id",
  sentMessages = null,
  // Per-action override for runtime.sendMessage (the offscreen channel):
  // return the response for a given message, e.g. a captureCut chunk.
  sendMessageImpl = null,
  // Transcription stub for the Speech Provider seam: speech-providers.js is
  // require()'d on the HOST (its fetch never sees the VM's fetch stub), so
  // dispatch tests re-register the selected provider with this function.
  // It receives (segmentAudio, credentials) and resolves provider-relative
  // records, or rejects to fail the Segment.
  transcribeImpl = null,
  // Controllable Date.now for the #48 probe window; defaults to real time.
  dateNow = () => Date.now(),
  sidePanel = {
    setPanelBehavior() {},
    setOptions: () => Promise.resolve(),
    open: () => Promise.resolve(),
  },
  stored = {},
} = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: settings, ...stored };
  // A Date subclass with an injectable now(): everything else (parse, UTC,
  // instances) inherits unchanged, so only clock reads are controllable.
  class SandboxDate extends Date {}
  SandboxDate.now = dateNow;
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    // The dispatch path (#48 tests) constructs Blobs from cut data URLs and
    // submits them as FormData: all standard Node globals.
    atob,
    btoa,
    Blob,
    File,
    FormData,
    fetch: promptAwareFetch(fetchImpl, promptFiles),
    AbortController,
    Date: SandboxDate,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval: setIntervalImpl,
    clearInterval: clearIntervalImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null) return { ...localStorage };
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, localStorage[item]]));
            }
            return { [key]: localStorage[key] };
          },
          set: async (values) => Object.assign(localStorage, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel,
      offscreen: {
        hasDocument: async () => offscreenDocument,
        createDocument: async () => {},
        closeDocument: async () => {},
      },
      tabCapture: {
        getMediaStreamId,
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        onConnect: listeners,
        openOptionsPage() {},
        getManifest: () => ({ version: "0.1.41" }),
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: (msg) => {
          if (sentMessages) sentMessages.push(msg);
          if (sendMessageImpl) return Promise.resolve(sendMessageImpl(msg));
          return Promise.resolve({ success: true });
        },
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SPEECH_TRANSCRIPTION: require("../../speech-transcription.js"),
    YTD_SESSION_PIPELINE: require("../../session-pipeline.js"),
    YTD_SESSION_SUMMARY: require("../../session-summary.js"),
    YTD_SESSION_PERSISTENCE: require("../../session-persistence.js"),
    YTD_SEGMENTER: require("../../session-segmenter.js"),
    YTD_SOURCE_PLATFORMS: require("../../source-platforms.js"),
    YTD_SPEECH_PROVIDERS: require("../../speech-providers.js"),
    YTD_REPORT_RENDER: require("../../report-render.js"),
    // The real settings module (require-able, pure): the identity stub this
    // used to be predated the versioned migration in normalize() and hid it
    // from every orchestration test.
    YTD_SETTINGS: require("../../settings.js"),
  };
  if (transcribeImpl) {
    sandbox.YTD_SPEECH_PROVIDERS.registerSpeechProvider({
      id: "groq",
      label: "Stub Groq (test)",
      credentialFields: [{ key: "apiKey", type: "password" }],
      transcribe: transcribeImpl,
    });
  }
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return {
    ...sandbox.__YTD_TRANSLATION_TESTING__,
    // Direct view of the storage backing, for asserting what was persisted.
    readStored: (key) => localStorage[key],
  };
}

module.exports = { loadBackgroundHelpers };
