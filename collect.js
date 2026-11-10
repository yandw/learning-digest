/**
 * Collect-current-page state machine (P8, issue #58): the pure contract
 * layer between the extension and the /v1 favorite endpoints. The
 * background service worker calls this module when the side panel's
 * 收藏当前页 entry fires; copy strings and DOM stay in the panel.
 *
 * Contract v1 (contracts/contract-v1.md):
 * - §3.1 POST /v1/resources — { url, title?, identity? }; 201 creates,
 *   200 returns the already-favorited Resource + Source (decision D3:
 *   duplicate favorites return the same resource).
 * - §3.4 POST /v1/sources/resolve — read-only pre-study lookup:
 *   { matched: false } or { matched: true, resource, source }.
 * - §2.5 identity — the platform video identity extracted client-side by
 *   contracts/platform-video-id.js (YTD_PLATFORM_VIDEO_ID); omitted when
 *   the URL alone cannot confirm one.
 * - §1 error envelope — non-2xx bodies are { error: { code, message } }
 *   and the message is what the learner sees.
 *
 * Pure and require()-able — no chrome or DOM dependencies — following the
 * auth-gate.js pattern: fully covered by Node tests, consumed by the
 * service worker via importScripts.
 */
var YTD_COLLECT = (() => {
  // Shared API client helpers (api-client.js): in Node tests we require
  // them, in the service worker the global arrives via importScripts.
  const apiClient =
    typeof YTD_API_CLIENT !== "undefined"
      ? YTD_API_CLIENT
      : require("./api-client.js");

  const RESOURCES_PATH = "/v1/resources";
  const RESOLVE_PATH = "/v1/sources/resolve";

  const GENERIC_COLLECT_ERROR = "收藏失败，请稍后重试";
  const UNAUTHORIZED_MESSAGE = "学习库授权已失效，请重新关联账号";

  function parseUrl(url) {
    try {
      const parsed = new URL(String(url));
      return /^https?:$/.test(parsed.protocol) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * The local collectable-URL guard: only http(s) pages reach the API.
   * chrome://, file:// and garbage URLs fail here so the click never
   * produces a pointless 400 round trip.
   */
  function isCollectableUrl(url) {
    return parseUrl(url) !== null;
  }

  /**
   * §3.1 request body. The title is included only when non-empty (the
   * contract allows titleless favorites; the server falls back to the
   * address). The identity is included only when it carries a platform
   * id AND a platform video id (they are both-null or both-present).
   * Returns null when the URL is not collectable.
   */
  function buildCollectRequest({ url, title, identity } = {}) {
    if (!isCollectableUrl(url)) return null;
    const body = { url: String(url).trim() };
    if (typeof title === "string" && title.trim() !== "") {
      body.title = title.trim();
    }
    if (
      identity &&
      typeof identity === "object" &&
      typeof identity.platformId === "string" &&
      identity.platformId !== "" &&
      typeof identity.platformVideoId === "string" &&
      identity.platformVideoId !== ""
    ) {
      body.identity = {
        platformId: identity.platformId,
        platformVideoId: identity.platformVideoId,
        episodeId: identity.episodeId ?? null,
        platformScopeId: identity.platformScopeId ?? null,
      };
    }
    return body;
  }

  // The §1 envelope readers live in the shared api-client module.
  const parseEnvelope = apiClient.parseEnvelope;
  const envelopeCode = apiClient.envelopeCode;

  function parseFavoriteBody(data) {
    if (!data || typeof data !== "object") return null;
    const resource = data.resource && typeof data.resource === "object" ? data.resource : null;
    const source = data.source && typeof data.source === "object" ? data.source : null;
    return resource && source ? { resource, source } : null;
  }

  /**
   * §3.1 response → outcome. 201 means "created", 200 means "hit an
   * existing favorite and returned the same Resource + Source". Any other
   * status (or a 2xx body missing resource/source) is a failure carrying
   * the envelope message.
   *
   * @returns {{ok: boolean, outcome: "created"|"existing"|null, resource, source, status: number, code: string|null, message: string|null}}
   */
  function parseCollectResponse({ status, data } = {}) {
    const favorite = parseFavoriteBody(data);
    if (favorite && (status === 201 || status === 200)) {
      return {
        ok: true,
        outcome: status === 201 ? "created" : "existing",
        resource: favorite.resource,
        source: favorite.source,
        status,
        code: null,
        message: null,
      };
    }
    return {
      ok: false,
      outcome: null,
      resource: null,
      source: null,
      status: status ?? 0,
      code: envelopeCode(data),
      message: parseEnvelope(
        data,
        status === 401 ? UNAUTHORIZED_MESSAGE : GENERIC_COLLECT_ERROR,
      ),
    };
  }

  /**
   * §3.4 resolve response: a hit keeps resource + source (the source
   * carries the latest progress); a miss is matched:false and nothing
   * else. Failures carry the envelope message — a 401 here routes the
   * learner back through the P6 authorization gate.
   */
  function parseResolveResponse({ status, data } = {}) {
    if (status === 200 && data && typeof data === "object") {
      if (data.matched === false) {
        return { ok: true, matched: false, resource: null, source: null, status, message: null };
      }
      const favorite = parseFavoriteBody(data);
      if (data.matched === true && favorite) {
        return {
          ok: true,
          matched: true,
          resource: favorite.resource,
          source: favorite.source,
          status,
          message: null,
        };
      }
    }
    return {
      ok: false,
      matched: false,
      resource: null,
      source: null,
      status: status ?? 0,
      message: parseEnvelope(
        data,
        status === 401 ? UNAUTHORIZED_MESSAGE : GENERIC_COLLECT_ERROR,
      ),
    };
  }

  return {
    RESOURCES_PATH,
    RESOLVE_PATH,
    GENERIC_COLLECT_ERROR,
    UNAUTHORIZED_MESSAGE,
    isCollectableUrl,
    buildCollectRequest,
    parseCollectResponse,
    parseResolveResponse,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_COLLECT;
}
