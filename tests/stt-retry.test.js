const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSttRetryHelpers({ fetchImpl } = {}) {
  const listeners = { addListener() {} };
  const localStorage = {
    ytd_settings: {
      sttApiKey: "stt-test-key",
      sttBaseUrl: "https://api.groq.com/openai/v1",
      sttModel: "whisper-large-v3-turbo",
    },
  };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    FormData,
    Blob,
    // Fire only the retry backoff delays (STT_RETRY_BASE_DELAY_MS * attempt,
    // so at most 6000ms) immediately; never fire the 50s/120s per-request
    // idle/hard timeouts, so the scripted fetch's resolution/rejection is
    // what decides each attempt's outcome, not a race against a fake timer.
    setTimeout: (fn, ms) => {
      if ((ms || 0) <= 6000) fn();
      return 0;
    },
    clearTimeout() {},
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => ({ [key]: localStorage[key] }),
        },
      },
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

function scriptedFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body ?? {},
      };
    },
  };
}

test("isRetryableSttError separates auth/config errors from transient ones", () => {
  const { isRetryableSttError } = loadSttRetryHelpers();

  assert.equal(isRetryableSttError({ status: 401 }), false);
  assert.equal(isRetryableSttError({ status: 403 }), false);
  assert.equal(isRetryableSttError({ status: 429 }), true);
  assert.equal(isRetryableSttError({ status: 500 }), true);
  assert.equal(isRetryableSttError({ code: "STT_TIMEOUT" }), true);
  assert.equal(
    isRetryableSttError({ message: "Failed to fetch" }),
    true,
  );
  assert.equal(isRetryableSttError({ status: 404 }), false);
  assert.equal(isRetryableSttError({}), false);
});

test("requestSttTranscriptionWithRetry recovers after a transient failure", async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 429, body: { error: { message: "rate limited" } } },
    { status: 200, body: { segments: [{ start: 0, end: 1, text: "ok" }] } },
  ]);
  const { requestSttTranscriptionWithRetry } = loadSttRetryHelpers({ fetchImpl });

  const result = await requestSttTranscriptionWithRetry(
    new Blob(["audio"]),
    "audio/webm",
    { sttApiKey: "k", sttBaseUrl: "https://api.groq.com/openai/v1", sttModel: "m" },
  );
  assert.deepEqual(result, { segments: [{ start: 0, end: 1, text: "ok" }] });
});

test("requestSttTranscriptionWithRetry does not retry an auth error", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    { status: 401, body: { error: { message: "bad key" } } },
  ]);
  const { requestSttTranscriptionWithRetry } = loadSttRetryHelpers({ fetchImpl });

  await assert.rejects(
    requestSttTranscriptionWithRetry(new Blob(["audio"]), "audio/webm", {
      sttApiKey: "k",
      sttBaseUrl: "https://api.groq.com/openai/v1",
      sttModel: "m",
    }),
    /bad key/,
  );
  assert.equal(calls.length, 1);
});

test("requestSttTranscriptionWithRetry gives up after 3 attempts", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    { status: 500, body: {} },
    { status: 500, body: {} },
    { status: 500, body: {} },
  ]);
  const { requestSttTranscriptionWithRetry } = loadSttRetryHelpers({ fetchImpl });

  await assert.rejects(
    requestSttTranscriptionWithRetry(new Blob(["audio"]), "audio/webm", {
      sttApiKey: "k",
      sttBaseUrl: "https://api.groq.com/openai/v1",
      sttModel: "m",
    }),
  );
  assert.equal(calls.length, 3);
});
