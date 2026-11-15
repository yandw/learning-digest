/**
 * Shared, non-secret configuration helpers.
 *
 * (Ticket 6.6, issue #91) The plugin holds no AI credentials at all: the
 * panel's AI features (rolling summary, session digest, explain-selection)
 * run server-side through the learning service (contract-r4 §6/§7), which
 * configures its own AI Provider. This file carries defaults and validation
 * for the Session capture settings and the learning service origins only.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    // Session capture: target Segment length in seconds. The browser layer
    // hands this to session-segmenter.js, which clamps to the same range.
    segmentLengthSeconds: 30,
    // Rolling Summary cadence (#28): a tick fires when the Transcript
    // coverage since the last Topic reaches this length (minutes, clamped
    // to [5, 180]) and at least 10 new records exist.
    summaryIntervalMinutes: 15,
    // Learning Digest learning service (P6): the API the extension presents
    // its linked credential to, and the Web app origin whose confirmation
    // page the authorization flow opens. Dev defaults point at the apps/
    // dev servers (apps/api :8787, apps/web :8080); http is accepted for
    // loopback origins only.
    apiBaseUrl: "http://127.0.0.1:8787",
    webAppBaseUrl: "http://127.0.0.1:8080",
  });

  function isValidBaseUrl(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
      const url = new URL(trimmed);
      if (url.protocol === "https:") return true;
      // Local/self-hosted services often serve plain http.
      return (
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      );
    } catch (_error) {
      return false;
    }
  }

  function normalizeBaseUrl(value, fallback) {
    return isValidBaseUrl(value) ? value.trim().replace(/\/+$/, "") : fallback;
  }

  /**
   * Integer clamp shared by every ranged setting: finite numbers are floored
   * and clamped to [min, max]; anything else (null/undefined/"" and
   * non-numeric input alike) falls back to the default, so a corrupted
   * setting can never break capture.
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
   * Rolling Summary cadence in minutes: finite numbers are clamped to
   * [5, 180] so a corrupted setting can never hammer the service or
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

  // Settings blobs are stamped with a version so default changes can reach
  // installs that saved settings under an older default (see the Segment
  // migration above). Callers persist the stamped object once after migrate.
  //
  // v4 (0.3.0, ticket 2.4 / D10): the local ASR key config is retired —
  // the fields are simply not emitted anymore, so a stored blob's ASR keys
  // disappear on the next read+persist.
  //
  // v5 (0.2.16, ticket 6.6 / issue #91): the whole local AI provider config
  // provider config is retired with the panel AI's
  // move to the learning service (contract-r4 §6/§7). Same v4 precedent:
  // the fields are not emitted, so stored AI keys are dropped on the next
  // read+persist. The bump marks the retirement for any future code that
  // needs to tell whether a blob predates it.
  const SETTINGS_VERSION = 5;
  const LEGACY_SEGMENT_DEFAULT = 120;

  function normalize(input = {}) {
    return {
      settingsVersion: SETTINGS_VERSION,
      // (v5, ticket 6.6) The AI provider fields are retired: never emitted,
      // so stored AI keys/base URLs are dropped on the next read+persist.
      segmentLengthSeconds: normalizeSegmentLengthSeconds(
        migrateSegmentLength(input),
      ),
      summaryIntervalMinutes: normalizeSummaryIntervalMinutes(
        input.summaryIntervalMinutes,
      ),
      // Learning service origins (P6): validated like every other base URL
      // (https anywhere, http loopback only) so a typo can never aim the
      // linked credential at a stranger's server.
      apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl, DEFAULTS.apiBaseUrl),
      webAppBaseUrl: normalizeBaseUrl(input.webAppBaseUrl, DEFAULTS.webAppBaseUrl),
    };
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    isValidBaseUrl,
    normalize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
