/**
 * Worker config (ticket 2.3): env wiring only — the provider seam and the
 * loop are the behavior. apiBase / token / provider / poll interval come
 * from LD_WORKER_* env vars; the Qwen key from QWEN_API_KEY. A qwen
 * selection without a key fails at startup (fail fast, not per task).
 */

const DEFAULTS = Object.freeze({
  apiBase: "http://127.0.0.1:8787",
  provider: "stub",
  pollIntervalMs: 5000,
  qwenBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  qwenModel: "qwen3-asr-flash",
});

function envString(env, name, fallback = "") {
  const value = typeof env?.[name] === "string" ? env[name].trim() : "";
  return value || fallback;
}

function envNumber(env, name, fallback) {
  const raw = typeof env?.[name] === "string" ? env[name].trim() : "";
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @param {Record<string, string|undefined>} env
 */
function loadWorkerConfig(env = {}) {
  return {
    apiBase: envString(env, "LD_WORKER_API_BASE", DEFAULTS.apiBase),
    token: envString(env, "LD_WORKER_TOKEN"),
    provider: envString(env, "LD_WORKER_PROVIDER", DEFAULTS.provider),
    pollIntervalMs: envNumber(env, "LD_WORKER_POLL_INTERVAL_MS", DEFAULTS.pollIntervalMs),
    errorBackoffMs: envNumber(env, "LD_WORKER_ERROR_BACKOFF_MS", undefined),
    qwenApiKey: envString(env, "QWEN_API_KEY"),
    qwenBaseUrl: envString(env, "LD_WORKER_QWEN_BASE_URL", DEFAULTS.qwenBaseUrl),
    qwenModel: envString(env, "LD_WORKER_QWEN_MODEL", DEFAULTS.qwenModel),
  };
}

/**
 * Builds the Speech Provider from config. Unknown selections and a qwen
 * selection without a key throw here, at startup — never per task.
 *
 * @param {ReturnType<typeof loadWorkerConfig>} config
 */
function createProviderFromConfig(config) {
  switch (config.provider) {
    case "stub": {
      const { createStubProvider } = require("./providers/stub");
      return createStubProvider();
    }
    case "qwen": {
      const { createQwenProvider } = require("./providers/qwen");
      return createQwenProvider({
        apiKey: config.qwenApiKey,
        baseUrl: config.qwenBaseUrl,
        model: config.qwenModel,
      });
    }
    default:
      throw new Error(`unknown LD_WORKER_PROVIDER: ${config.provider} (expected stub | qwen)`);
  }
}

module.exports = { loadWorkerConfig, createProviderFromConfig, DEFAULTS };
