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

/**
 * P6 auth verdict seam: the real gate module, with checkAuthorization
 * pinned to the requested verdict so tests never need a live /v1 for the
 * gate. `auth: { real: true }` keeps the real module (the sandbox fetch
 * then observes the actual /v1/me probe). The default keeps the pre-P6
 * behavior: the worker counts as linked.
 */
function withAuthVerdict(gate, auth) {
  if (auth.real) return gate;
  const verdict = auth.verdict || {
    authorized: !!auth.authorized,
    reason: auth.authorized ? null : auth.reason || "unauthorized",
  };
  return {
    ...gate,
    checkAuthorization: async () => verdict,
  };
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aiModel: "qwen3.8-flash",
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
  // Controllable Date.now for the #48 probe window; defaults to real time.
  dateNow = () => Date.now(),
  sidePanel = {
    setPanelBehavior() {},
    setOptions: () => Promise.resolve(),
    open: () => Promise.resolve(),
  },
  stored = {},
  // chrome.tabs.sendMessage seam (0.1.63 从头开始): records into tabMessages
  // and answers via tabMessageImpl (default success).
  tabMessages = null,
  tabMessageImpl = null,
  // P6 authorization seam: by default the worker counts as linked so every
  // pre-P6 orchestration test is untouched. Pass { authorized: false,
  // reason } to exercise the gate, or a full verdict object.
  auth = { authorized: true, reason: null },
  // P8 collect seam: chrome.tabs.query({ active, lastFocusedWindow }) —
  // the collect handlers read the learner's current page through it.
  tabsQuery = async () => [],
  // P10 learning-start seam: chrome.tabs.get(tabId) — the course-tab target
  // handlers read a chosen (possibly background) tab through it.
  tabsGet = null,
} = {}) {
  const listeners = { addListener() {} };
  const createdTabs = [];
  const removedTabIds = [];
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
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        onRemoved: listeners,
        query: tabsQuery,
        // P10 learning-start: read one chosen (possibly background) tab.
        get: tabsGet || (async () => { throw new Error("tab not found"); }),
        // P6 link flow: tabs the worker opens for linking (and closes after
        // the code exchange). Recorded so tests can assert the flow.
        create: async ({ url }) => {
          const tab = { id: 90 + createdTabs.length, url };
          createdTabs.push(tab);
          return tab;
        },
        remove: async (tabId) => {
          removedTabIds.push(tabId);
        },
        sendMessage: (tabId, msg) => {
          if (tabMessages) tabMessages.push({ tabId, ...msg });
          if (tabMessageImpl) return Promise.resolve(tabMessageImpl(msg));
          return Promise.resolve({ success: true });
        },
      },
    },
    YTD_SPEECH_TRANSCRIPTION: require("../../speech-transcription.js"),
    // Round-1 review fix: the shared envelope/URL helpers, loaded first in
    // the worker (importScripts) and required here for parity.
    YTD_API_CLIENT: require("../../api-client.js"),
    YTD_SESSION_PIPELINE: require("../../session-pipeline.js"),
    YTD_SESSION_TIMELINE: require("../../session-timeline.js"),
    YTD_SESSION_SUMMARY: require("../../session-summary.js"),
    YTD_SESSION_PERSISTENCE: require("../../session-persistence.js"),
    YTD_SEGMENTER: require("../../session-segmenter.js"),
    YTD_SOURCE_PLATFORMS: require("../../source-platforms.js"),
    // P8 collect-current-page: the shared identity extractor (contracts/,
    // shared with the API) and the pure collect state machine.
    YTD_PLATFORM_VIDEO_ID: require("../../contracts/platform-video-id.js"),
    YTD_COLLECT: require("../../collect.js"),
    // P12 library notes: the pure note state machine the save-note handler
    // drives (tests/plugin-note-timestamp.test.js).
    YTD_NOTES: require("../../notes.js"),
    // P10 learning-start: the course tab list, the locked-target state
    // machine and the progress write client (learning-start.js).
    YTD_LEARNING_START: require("../../learning-start.js"),
    // Ticket 2.5 (#68): the Session archive client (contract-r2 §3.1/§3.2/
    // §3.3/§3.5) and the page-side caption reader the bridge command uses.
    YTD_SESSION_ARCHIVE: require("../../session-archive.js"),
    YTD_BILIBILI_CAPTIONS: require("../../bilibili-captions.js"),
    // Ticket 2.4 (#67): the D11 audio-segment upload client the ASR path's
    // dispatch/poll wiring reads.
    YTD_TRANSCRIPT_PIPELINE: require("../../transcript-pipeline.js"),
    YTD_REPORT_RENDER: require("../../report-render.js"),
    // The real settings module (require-able, pure): the identity stub this
    // used to be predated the versioned migration in normalize() and hid it
    // from every orchestration test.
    YTD_SETTINGS: require("../../settings.js"),
    // P6 authorization gate: the real pure module, with checkAuthorization
    // overridden when the test asks for a non-default verdict.
    YTD_AUTH_GATE: withAuthVerdict(require("../../auth-gate.js"), auth),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return {
    ...sandbox.__YTD_TRANSLATION_TESTING__,
    // Direct view of the storage backing, for asserting what was persisted.
    readStored: (key) => localStorage[key],
    // P6 link flow seams: tabs the worker opened/closed, for asserting the
    // authorization page lifecycle.
    createdTabs,
    removedTabIds,
  };
}

module.exports = { loadBackgroundHelpers };
