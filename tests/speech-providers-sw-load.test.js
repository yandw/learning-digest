/**
 * Service-worker load-path regression test.
 *
 * The Node test suite requires() speech-providers.js, where loadNodeCrypto()
 * finds node:crypto and the Web Crypto fallback path never evaluates. The
 * real service worker has no require(), so the fallback runs at load time —
 * and a bare `crypto` reference inside the `const crypto = ...` initializer
 * threw "Cannot access 'crypto' before initialization" (TDZ), killing the
 * service worker registration. This test loads the module the way a service
 * worker does and would catch that class of bug.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadInServiceWorkerLikeContext() {
  // Minimal Web Crypto stand-in: enough shape for module-load-time probing.
  const subtle = {
    async digest() {
      return new Uint8Array(32).buffer;
    },
    async importKey() {
      return {};
    },
    async sign() {
      return new Uint8Array(32).buffer;
    },
  };
  // Deliberately NO require, NO node:crypto — this is the SW environment.
  const sandbox = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    FormData,
    fetch: async () => {
      throw new Error("no network in this test");
    },
    crypto: { subtle },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("speech-transcription.js"), sandbox);
  sandbox.YTD_SPEECH_TRANSCRIPTION = sandbox.YTD_SPEECH_TRANSCRIPTION;
  vm.runInNewContext(read("speech-providers.js"), sandbox);
  return sandbox;
}

test("speech-providers loads in a service-worker-like context (no node:crypto)", () => {
  const sandbox = loadInServiceWorkerLikeContext();
  const providers = sandbox.YTD_SPEECH_PROVIDERS;
  assert.ok(providers, "module evaluated and exported its global");
  const ids = providers.listSpeechProviders().map((p) => p.id);
  for (const id of ["groq", "tencent", "aliyun"]) {
    assert.ok(ids.includes(id), `provider ${id} registered`);
  }
});

test("tencent/aliyun signing functions exist on the Web Crypto path", async () => {
  const sandbox = loadInServiceWorkerLikeContext();
  const providers = sandbox.YTD_SPEECH_PROVIDERS;
  const tencent = providers.getSpeechProvider("tencent");
  const aliyun = providers.getSpeechProvider("aliyun");
  assert.equal(typeof tencent.signRequest, "function");
  assert.equal(typeof aliyun.signRequest, "function");
});
