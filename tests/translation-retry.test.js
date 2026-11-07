const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadRetryHelpers(scriptedResponses = []) {
  const listeners = { addListener() {} };
  const sendCalls = [];
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    // Fire short timers (retry backoff) immediately; never fire the 130s
    // watchdog, so scripted responses decide the outcome.
    setTimeout: (fn, ms) => {
      if ((ms || 0) < 100000) fn();
      return 0;
    },
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ set textContent(v) {}, get innerHTML() { return ""; } }),
    },
    chrome: {
      runtime: {
        onMessage: listeners,
        sendMessage: (message) => {
          sendCalls.push(message);
          const next = scriptedResponses.length
            ? scriptedResponses.shift()
            : { success: true, translatedContent: { segments: [] } };
          return next instanceof Error
            ? Promise.reject(next)
            : Promise.resolve(next);
        },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return { ...sandbox.__YTD_TRANSCRIPT_TESTING__, sendCalls };
}

test("isRetryableTranslationError separates config errors from transient ones", () => {
  const { isRetryableTranslationError } = loadRetryHelpers();

  assert.equal(isRetryableTranslationError({ success: false, code: "NO_AI_KEY" }), false);
  assert.equal(isRetryableTranslationError({ success: false, code: "INVALID_AI_KEY" }), false);
  assert.equal(isRetryableTranslationError({ success: false, code: "RATE_LIMITED" }), true);
  assert.equal(isRetryableTranslationError({ success: false, code: "EMPTY_AI_RESPONSE" }), true);
  assert.equal(
    isRetryableTranslationError({
      success: false,
      error: "Unterminated string in JSON at position 79 (line 1 column 80)",
    }),
    true,
  );
  assert.equal(
    isRetryableTranslationError({ success: false, error: "Translation request timed out after 130 seconds." }),
    true,
  );
  assert.equal(isRetryableTranslationError({ success: false }), false);
});

test("sendTranslationWithRetry recovers after transient failures", async () => {
  const { sendTranslationWithRetry, sendCalls } = loadRetryHelpers([
    { success: false, code: "RATE_LIMITED", error: "Rate limited" },
    { success: false, error: "Unterminated string in JSON at position 79" },
    { success: true, translatedContent: { segments: [{ id: "a", text: "好" }] } },
  ]);

  const result = await sendTranslationWithRetry({ action: "translateContent" }, () => false);
  assert.equal(result.success, true);
  assert.equal(sendCalls.length, 3);
});

test("sendTranslationWithRetry does not retry auth/config errors", async () => {
  const { sendTranslationWithRetry, sendCalls } = loadRetryHelpers([
    { success: false, code: "INVALID_AI_KEY", error: "bad key" },
  ]);

  const result = await sendTranslationWithRetry({}, () => false);
  assert.equal(result.success, false);
  assert.equal(sendCalls.length, 1);
});

test("sendTranslationWithRetry gives up after 3 attempts and keeps the last error", async () => {
  const { sendTranslationWithRetry, sendCalls } = loadRetryHelpers([
    { success: false, code: "RATE_LIMITED", error: "first" },
    { success: false, code: "RATE_LIMITED", error: "second" },
    { success: false, code: "RATE_LIMITED", error: "third" },
  ]);

  const result = await sendTranslationWithRetry({}, () => false);
  assert.equal(result.success, false);
  assert.equal(result.error, "third");
  assert.equal(sendCalls.length, 3);
});

test("sendTranslationWithRetry stops early when the generation is stale", async () => {
  const { sendTranslationWithRetry, sendCalls } = loadRetryHelpers();

  const result = await sendTranslationWithRetry({}, () => true);
  assert.equal(result.success, false);
  assert.equal(sendCalls.length, 0);
});
