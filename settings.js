/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    // AI Provider (0.1.51 default): Alibaba Cloud Bailian's OpenAI-compatible
    // endpoint. One model field drives every AI feature (Topic ticks, the
    // end-of-session report pass, explain-selection).
    aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aiModel: "qwen3.8-flash",
    // Speech Transcription Provider: independent of the AI Provider above.
    // Defaults to Groq's OpenAI-compatible endpoint, but the user can point
    // it at any OpenAI-compatible /audio/transcriptions host.
    sttApiKey: "",
    sttBaseUrl: "https://api.groq.com/openai/v1",
    sttModel: "whisper-large-v3-turbo",
    // Speech Provider (Learning Digest): which provider transcribes Segments,
    // and that provider's own credentials. Credentials are keyed by provider
    // id so later providers (Tencent Cloud ASR, Qwen ASR) add their own
    // slot without touching existing ones. Stored locally only.
    speechProvider: "qwen",
    speechProviders: {},
    // Session capture: target Segment length in seconds. The browser layer
    // hands this to session-segmenter.js, which clamps to the same range.
    segmentLengthSeconds: 30,
    // Topic timeline cadence (#28): a Topic tick fires when the Transcript
    // coverage since the last Topic reaches this length (minutes, clamped
    // to [5, 180]) and at least 10 new records exist.
    summaryIntervalMinutes: 15,
  });

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function isValidBaseUrl(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
      const url = new URL(trimmed);
      if (url.protocol === "https:") return true;
      // Local/self-hosted providers (e.g. Ollama) often serve plain http.
      return (
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      );
    } catch (_error) {
      return false;
    }
  }

  // Kept as a named alias: existing callers (options.js, tests) reference
  // isValidAiBaseUrl specifically for the AI Provider field. The validation
  // rule itself is shared with the Speech Transcription Provider field.
  const isValidAiBaseUrl = isValidBaseUrl;

  function normalizeBaseUrl(value, fallback) {
    return isValidBaseUrl(value) ? value.trim().replace(/\/+$/, "") : fallback;
  }

  function normalizeModel(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  // The Qwen provider's transcription mode (#45): "segment" (default) or
  // "realtime". Scoped to the qwen slot — the only provider whose
  // credentialFields declare the radio — so every other provider's stored
  // credentials keep their exact shape.
  function normalizeProviderTranscribeMode(providerId, credentials) {
    if (providerId !== "qwen") return credentials;
    return {
      ...credentials,
      mode: credentials.mode === "realtime" ? "realtime" : "segment",
    };
  }

  /**
   * Per-provider Speech Provider credentials: an object keyed by provider id
   * whose values are objects of trimmed strings. Malformed entries are
   * dropped rather than passed through.
   */
  function normalizeSpeechProviders(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const result = {};
    for (const [providerId, credentials] of Object.entries(input)) {
      if (!credentials || typeof credentials !== "object") continue;
      const clean = {};
      for (const [key, value] of Object.entries(credentials)) {
        if (typeof value === "string") clean[key] = value.trim();
      }
      result[providerId] = normalizeProviderTranscribeMode(providerId, clean);
    }
    return result;
  }

  /**
   * Integer clamp shared by every ranged setting: finite numbers are floored
   * and clamped to [min, max]; anything else (null/undefined/"" and
   * non-numeric input alike) falls back to the default, so a corrupted
   * setting can never break capture or hammer the AI Provider.
   *
   * @param {*} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  function clampIntegerSetting(value, min, max, fallback) {
    // null/undefined/"" mean "not set" (Number(null) would be 0), not zero.
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  }

  /**
   * The Segment-length bounds, read from session-segmenter.js (the single
   * source of truth) at call time. The service worker loads the segmenter
   * via a later importScripts, and the options page loads it with a plain
   * script tag before settings.js, so the global exists by the time
   * normalize() actually runs in both. In Node tests we require it.
   */
  function segmentLengthBounds() {
    const segmenter =
      typeof YTD_SEGMENTER !== "undefined"
        ? YTD_SEGMENTER
        : require("./session-segmenter.js");
    return {
      min: segmenter.MIN_ALLOWED_SEGMENT_LENGTH,
      max: segmenter.MAX_ALLOWED_SEGMENT_LENGTH,
    };
  }

  /**
   * Segment length in seconds: finite numbers are clamped to the range
   * session-segmenter.js supports ([5, 60]); anything else falls back to
   * the default so a corrupted setting can never break capture.
   */
  function normalizeSegmentLengthSeconds(value) {
    const { min, max } = segmentLengthBounds();
    return clampIntegerSetting(value, min, max, DEFAULTS.segmentLengthSeconds);
  }

  /**
   * Topic timeline cadence in minutes: finite numbers are clamped to
   * [5, 180] so a corrupted setting can never hammer the AI Provider or
   * silently disable ticks.
   */
  function normalizeSummaryIntervalMinutes(value) {
    return clampIntegerSetting(value, 5, 180, DEFAULTS.summaryIntervalMinutes);
  }

  /**
   * v2 migration (0.1.41): the Segment length has no options UI, so a stored
   * 120 is always the pre-0.1.39 default, never a user choice — force the
   * new default on unstamped blobs. Blobs stamped with the current version
   * (or hand-tuned to a non-default value before stamping) pass through.
   */
  function migrateSegmentLength(source) {
    if (Number(source?.settingsVersion) >= SETTINGS_VERSION) {
      return source.segmentLengthSeconds;
    }
    // null means "not set" (Number(null) would be 0), not zero — the
    // same guard clampIntegerSetting applies downstream.
    if (source?.segmentLengthSeconds === null) {
      return DEFAULTS.segmentLengthSeconds;
    }
    const stored = Number(source?.segmentLengthSeconds);
    if (!Number.isFinite(stored) || stored === LEGACY_SEGMENT_DEFAULT) {
      return DEFAULTS.segmentLengthSeconds;
    }
    return stored;
  }

  /**
   * v3 migration (0.1.51): the published AI Provider default moves from
   * OpenRouter (DeepSeek V4.1 Flash) to Alibaba Cloud Bailian (Qwen). Blobs
   * stamped below v3 (or unstamped) that still sit at BOTH old defaults, or
   * lack the fields entirely, were never customized — the same "old default
   * is never a user choice" precedent as the Segment length migration — so
   * they move to the new defaults. Any other stored pair passes through
   * untouched.
   */
  function migrateAiProvider(source) {
    if (Number(source?.settingsVersion) >= SETTINGS_VERSION) {
      return { aiBaseUrl: source.aiBaseUrl, aiModel: source.aiModel };
    }
    const baseUrl =
      typeof source?.aiBaseUrl === "string" ? source.aiBaseUrl.trim() : "";
    const model =
      typeof source?.aiModel === "string" ? source.aiModel.trim() : "";
    const atLegacyDefaults =
      (!baseUrl || baseUrl === LEGACY_AI_BASE_URL) &&
      (!model || model === LEGACY_AI_MODEL);
    if (!atLegacyDefaults) {
      return { aiBaseUrl: source.aiBaseUrl, aiModel: source.aiModel };
    }
    return { aiBaseUrl: DEFAULTS.aiBaseUrl, aiModel: DEFAULTS.aiModel };
  }

  // Settings blobs are stamped with a version so default changes can reach
  // installs that saved settings under an older default (see the Segment
  // and AI Provider migrations above). Callers persist the stamped object
  // once after migrate.
  const SETTINGS_VERSION = 3;
  const LEGACY_SEGMENT_DEFAULT = 120;
  // Pre-0.1.51 AI Provider defaults. Only migrateAiProvider reads them, to
  // recognize blobs that still point at the old published provider.
  const LEGACY_AI_BASE_URL = "https://openrouter.ai/api/v1";
  const LEGACY_AI_MODEL = "deepseek/deepseek-v4.1-flash-1017";

  function normalize(input = {}) {
    const migratedAi = migrateAiProvider(input);
    return {
      settingsVersion: SETTINGS_VERSION,
      provider: DEFAULTS.provider,
      aiApiKey: isLegacyCustom(input)
        ? ""
        : typeof input.aiApiKey === "string"
          ? input.aiApiKey.trim()
          : "",
      aiBaseUrl: isLegacyCustom(input)
        ? DEFAULTS.aiBaseUrl
        : normalizeBaseUrl(migratedAi.aiBaseUrl, DEFAULTS.aiBaseUrl),
      aiModel: isLegacyCustom(input)
        ? DEFAULTS.aiModel
        : normalizeModel(migratedAi.aiModel, DEFAULTS.aiModel),
      // Speech Transcription Provider fields are unrelated to the legacy
      // "custom" AI provider migration, so they're never cleared by it.
      sttApiKey:
        typeof input.sttApiKey === "string" ? input.sttApiKey.trim() : "",
      sttBaseUrl: normalizeBaseUrl(input.sttBaseUrl, DEFAULTS.sttBaseUrl),
      sttModel: normalizeModel(input.sttModel, DEFAULTS.sttModel),
      // Speech Provider fields are unrelated to the legacy "custom" AI
      // provider migration, so they're never cleared by it.
      speechProvider:
        typeof input.speechProvider === "string" && input.speechProvider.trim()
          ? input.speechProvider.trim()
          : DEFAULTS.speechProvider,
      speechProviders: normalizeSpeechProviders(input.speechProviders),
      segmentLengthSeconds: normalizeSegmentLengthSeconds(
        migrateSegmentLength(input),
      ),
      summaryIntervalMinutes: normalizeSummaryIntervalMinutes(
        input.summaryIntervalMinutes,
      ),
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl(baseUrl = DEFAULTS.aiBaseUrl) {
    return `${normalizeBaseUrl(baseUrl, DEFAULTS.aiBaseUrl)}/chat/completions`;
  }

  function sttTranscriptionsUrl(baseUrl = DEFAULTS.sttBaseUrl) {
    return `${normalizeBaseUrl(baseUrl, DEFAULTS.sttBaseUrl)}/audio/transcriptions`;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    isLegacyCustom,
    isValidAiBaseUrl,
    isValidBaseUrl,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    sttTranscriptionsUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
