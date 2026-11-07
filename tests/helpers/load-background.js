/**
 * Shared test seam: runs background.js inside a Node VM with a stubbed
 * chrome API and injectable fetch/timers, exposing the pure-ish helpers
 * background.js exports for tests (__YTD_TRANSLATION_TESTING__).
 *
 * Used by translation.test.js (which introduced it) and
 * session-summary.test.js (Session Digest glue, #18).
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  setIntervalImpl = () => 0,
  clearIntervalImpl = () => {},
  offscreenDocument = true,
  sidePanel = {
    setPanelBehavior() {},
    setOptions: () => Promise.resolve(),
  },
  stored = {},
} = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: settings, ...stored };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
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
        getMediaStreamId: async () => "test-stream-id",
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
    YTD_SPEECH_TRANSCRIPTION: require("../../speech-transcription.js"),
    YTD_SESSION_PIPELINE: require("../../session-pipeline.js"),
    YTD_SESSION_SUMMARY: require("../../session-summary.js"),
    YTD_SESSION_PERSISTENCE: require("../../session-persistence.js"),
    YTD_SEGMENTER: require("../../session-segmenter.js"),
    YTD_SOURCE_PLATFORMS: require("../../source-platforms.js"),
    YTD_SPEECH_PROVIDERS: require("../../speech-providers.js"),
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      sttTranscriptionsUrl: (baseUrl) => `${baseUrl}/audio/transcriptions`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

module.exports = { loadBackgroundHelpers };
