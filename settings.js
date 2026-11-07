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
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
    // Speech Transcription Provider: independent of the AI Provider above.
    // Defaults to Groq's OpenAI-compatible endpoint, but the user can point
    // it at any OpenAI-compatible /audio/transcriptions host.
    sttApiKey: "",
    sttBaseUrl: "https://api.groq.com/openai/v1",
    sttModel: "whisper-large-v3-turbo",
    // Speech Provider (Learning Digest): which provider transcribes Segments,
    // and that provider's own credentials. Credentials are keyed by provider
    // id so later providers (Tencent Cloud ASR, Aliyun ASR) add their own
    // slot without touching existing ones. Stored locally only.
    speechProvider: "groq",
    speechProviders: {},
    // Session capture: target Segment length in seconds. The browser layer
    // hands this to session-segmenter.js, which clamps to the same range.
    segmentLengthSeconds: 120,
    // Rolling Summary cadence: how often the AI Provider refreshes the
    // summary while a Session is active (minutes, clamped to [5, 180]).
    summaryIntervalMinutes: 30,
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
      result[providerId] = clean;
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
   * session-segmenter.js supports ([30, 600]); anything else falls back to
   * the default so a corrupted setting can never break capture.
   */
  function normalizeSegmentLengthSeconds(value) {
    const { min, max } = segmentLengthBounds();
    return clampIntegerSetting(value, min, max, DEFAULTS.segmentLengthSeconds);
  }

  /**
   * Rolling Summary cadence in minutes: finite numbers are clamped to
   * [5, 180] so a corrupted setting can never hammer the AI Provider or
   * silently disable summaries.
   */
  function normalizeSummaryIntervalMinutes(value) {
    return clampIntegerSetting(value, 5, 180, DEFAULTS.summaryIntervalMinutes);
  }

  function normalize(input = {}) {
    return {
      provider: DEFAULTS.provider,
      aiApiKey: isLegacyCustom(input)
        ? ""
        : typeof input.aiApiKey === "string"
          ? input.aiApiKey.trim()
          : "",
      aiBaseUrl: isLegacyCustom(input)
        ? DEFAULTS.aiBaseUrl
        : normalizeBaseUrl(input.aiBaseUrl, DEFAULTS.aiBaseUrl),
      aiModel: isLegacyCustom(input)
        ? DEFAULTS.aiModel
        : normalizeModel(input.aiModel, DEFAULTS.aiModel),
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
      segmentLengthSeconds: normalizeSegmentLengthSeconds(input.segmentLengthSeconds),
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
