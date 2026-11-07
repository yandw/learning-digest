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
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    // Speech Transcription Provider: independent of the AI Provider above.
    // Defaults to Groq's OpenAI-compatible endpoint, but the user can point
    // it at any OpenAI-compatible /audio/transcriptions host.
    sttApiKey: "",
    sttBaseUrl: "https://api.groq.com/openai/v1",
    sttModel: "whisper-large-v3-turbo",
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
