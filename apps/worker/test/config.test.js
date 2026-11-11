/**
 * Worker config (ticket 2.3): env wiring only — the provider seam and the
 * loop above are the behavior. apiBase / token / provider / poll interval
 * come from LD_WORKER_* env vars; the Qwen key from QWEN_API_KEY. A qwen
 * selection without a key fails at startup (fail fast, not per task).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorkerConfig, createProviderFromConfig } = require("../lib/config");

test("config: defaults to the loopback API, stub provider, 5s poll", () => {
  const config = loadWorkerConfig({});
  assert.deepEqual(config, {
    apiBase: "http://127.0.0.1:8787",
    token: "",
    provider: "stub",
    pollIntervalMs: 5000,
    errorBackoffMs: undefined,
    qwenApiKey: "",
    qwenBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    qwenModel: "qwen3-asr-flash",
  });
});

test("config: env overrides flow through", () => {
  const config = loadWorkerConfig({
    LD_WORKER_API_BASE: "https://api.example.com",
    LD_WORKER_TOKEN: "worker-secret",
    LD_WORKER_PROVIDER: "qwen",
    LD_WORKER_POLL_INTERVAL_MS: "12000",
    QWEN_API_KEY: "sk-test",
    LD_WORKER_QWEN_BASE_URL: "https://mirror.example.com/v1/",
    LD_WORKER_QWEN_MODEL: "qwen3-asr-flash-test",
  });
  assert.equal(config.apiBase, "https://api.example.com");
  assert.equal(config.token, "worker-secret");
  assert.equal(config.provider, "qwen");
  assert.equal(config.pollIntervalMs, 12000);
  assert.equal(config.qwenApiKey, "sk-test");
  assert.equal(config.qwenBaseUrl, "https://mirror.example.com/v1/");
  assert.equal(config.qwenModel, "qwen3-asr-flash-test");
});

test("config: unknown provider selection fails at startup", () => {
  assert.throws(
    () => createProviderFromConfig({ ...loadWorkerConfig({}), provider: "magic" }),
    /unknown LD_WORKER_PROVIDER/i,
  );
});

test("config: qwen without an api key fails at startup (fail fast, not per task)", () => {
  assert.throws(
    () => createProviderFromConfig({ ...loadWorkerConfig({}), provider: "qwen" }),
    /requires a Bailian API key/,
  );
  // And with a key it builds.
  const provider = createProviderFromConfig({ ...loadWorkerConfig({}), provider: "qwen", qwenApiKey: "sk-test" });
  assert.equal(provider.id, "qwen");
});

test("config: stub provider builds without any key", () => {
  const provider = createProviderFromConfig(loadWorkerConfig({}));
  assert.equal(provider.id, "stub");
});
