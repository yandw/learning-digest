/**
 * Shared API client helpers (round-1 review fix): the error-envelope and
 * URL-joining primitives every contract module needs, extracted from their
 * per-module copies (auth-gate.js, collect.js, notes.js, learning-start.js)
 * so the §1 envelope shape and the base-URL joining rule have one source.
 *
 * - parseEnvelope(data, fallback): the §1 error envelope's message, or the
 *   caller's fallback when the body is not a well-formed envelope.
 * - envelopeCode(data): the envelope's error code, or null.
 * - buildApiUrl(baseUrl, path): joins a configured base URL and a /v1 path;
 *   null when the base is not an http(s) URL (a misconfigured setting must
 *   fail loudly at the call site, not build a nonsense request).
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded with importScripts / <script> tags. UMD like source-platforms.js:
 * consumer modules fall back to require() when the global is absent (Node
 * tests), which keeps the load order irrelevant there.
 */
var YTD_API_CLIENT = (() => {
  /** §1 error envelope: the server's message when well-formed. */
  function parseEnvelope(data, fallback) {
    const message = data && data.error && data.error.message;
    return typeof message === "string" && message ? message : fallback;
  }

  /** §1 error envelope: the error code, null when absent or not a string. */
  function envelopeCode(data) {
    const code = data && data.error && data.error.code;
    return typeof code === "string" ? code : null;
  }

  /**
   * Joins a configured base URL and a /v1 path. Returns null when the base
   * URL is not an http(s) URL (a misconfigured setting must fail loudly at
   * the call site, not build a nonsense request).
   */
  function buildApiUrl(baseUrl, path) {
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
    try {
      const url = new URL(baseUrl.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      const base = baseUrl.trim().replace(/\/+$/, "");
      const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
      return `${base}${suffix}`;
    } catch (_error) {
      return null;
    }
  }

  return { parseEnvelope, envelopeCode, buildApiUrl };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_API_CLIENT;
}
