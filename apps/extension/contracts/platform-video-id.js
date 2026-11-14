/**
 * Platform Video ID extraction + URL normalization (contract v1, round 1).
 *
 * Implements contracts/platform-video-id-rules.md for the four round-1
 * Source Platforms (xiaoe-tech, bilibili, youtube, xiaohongshu):
 * - extractVideoIdentity(url): the platform identity a URL carries, or
 *   null when the URL alone cannot confirm one. Per decision 1 the client
 *   submits this identity on POST /v1/resources and /v1/sources/resolve;
 *   per D6/D8 the client omits it for image-text notes and unresolvable
 *   short links (the URL alone cannot confirm those).
 * - normalizeUrl(url): the §0 normalized address used for url-exact
 *   matching — scheme + lowercase host + path + query, fragment dropped,
 *   the platform's share/tracking params and all utm_* dropped, remaining
 *   query params name-sorted. Storage keeps the raw first-favorited URL.
 * - platformVideoIdFormats: the §1 per-platform platformVideoId regexes
 *   (the same ones the extractors pin), the single format-judgment source
 *   for consumers that validate declared identities.
 *
 * Like source-platforms.js: pure logic, zero dependencies, total functions
 * — any input (including garbage) returns a result and never throws, so
 * callers can feed it whatever a tab or a paste box happens to contain.
 * UMD: browser <script> global + module.exports, consumable from the API,
 * the Web library and the extension.
 */
var YTD_PLATFORM_VIDEO_ID = (() => {
  const PROTOCOL_RE = /^https?:$/;
  const XIAOE_SUFFIX = ".xiaoe-tech.com";
  // Resource tokens: p_ column/product, v_ video, a_ audio, i_ image-text,
  // l_ live/replay; the prefix stays part of the platformVideoId (D7).
  const XIAOE_TOKEN_RE = /^(p|v|a|i|l)_[a-z0-9]{4,}$/i;
  const BILI_HOSTS = new Set(["www.bilibili.com", "m.bilibili.com", "b23.tv"]);
  const BV_RE = /^BV[0-9A-Za-z]{10}$/;
  const YT_HOSTS = new Set(["www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
  const YT_ID_RE = /^[0-9A-Za-z_-]{11}$/;
  const XHS_HOSTS = new Set(["www.xiaohongshu.com", "xhslink.com"]);
  // Case-insensitive so the extractor agrees with source-platforms.js's
  // recognition adapter (NOTE_ID_RE, also /i): a URL whose note id carries
  // uppercase hex must not recognize as a video page yet fail extraction.
  // Hex digits are otherwise lowercase in the wild; the rules table pins
  // "24 位十六进制" without a case qualifier.
  const XHS_NOTE_RE = /^[0-9a-f]{24}$/i;

  // Share/tracking params each platform's ignore list drops (rules §1).
  // All platforms additionally drop every utm_* param.
  const IGNORE_PARAMS = {
    "xiaoe-tech": ["app_id"],
    "bilibili": [
      "spm_id_from", "vd_source", "share_medium", "share_source",
      "share_plat", "share_tag", "share_session_id", "share_token",
      "unique_k", "buvid", "is_story_h5", "from_spmid", "up_id", "mid",
      "pop_share", "bsource", "broadcast_type", "plat_id",
    ],
    "youtube": [
      "si", "t", "start", "time_continue", "list", "index", "feature",
      "pp", "app", "persist_app", "redir_token", "html5_redirect",
    ],
    "xiaohongshu": [
      "xsec_token", "xsec_source", "share_token", "app_platform",
      "app_id", "share_plat", "share_from", "share_session_id",
    ],
  };

  function safeParseUrl(url) {
    try {
      const parsed = new URL(String(url));
      if (!PROTOCOL_RE.test(parsed.protocol)) {
        return null;
      }
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  function platformIdForHost(hostname) {
    if (hostname === XIAOE_SUFFIX.slice(1) || hostname.endsWith(XIAOE_SUFFIX)) {
      return "xiaoe-tech";
    }
    if (BILI_HOSTS.has(hostname)) {
      return "bilibili";
    }
    if (YT_HOSTS.has(hostname)) {
      return "youtube";
    }
    if (XHS_HOSTS.has(hostname)) {
      return "xiaohongshu";
    }
    return null;
  }

  /**
   * §0 normalized address for url-exact matching. Returns null for
   * garbage or non-http(s) input; never throws.
   */
  function normalizeUrl(url) {
    const parsed = safeParseUrl(url);
    if (!parsed) {
      return null;
    }
    const platformId = platformIdForHost(parsed.hostname);
    const ignored = new Set(IGNORE_PARAMS[platformId] || []);
    const kept = [];
    for (const [name, value] of parsed.searchParams.entries()) {
      if (name.toLowerCase().startsWith("utm_") || ignored.has(name)) {
        continue;
      }
      kept.push([name, value]);
    }
    // Remaining params sorted by name (stable for duplicate names).
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const query = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`;
  }

  function pathSegments(pathname) {
    return pathname.split("/").filter((segment) => segment.length > 0);
  }

  // --- per-station extractors ------------------------------------------------

  function extractXiaoe(parsed) {
    // D7: the shop subdomain is part of the identity.
    const host = parsed.hostname;
    const scopeId = host === XIAOE_SUFFIX.slice(1)
      ? null
      : host.slice(0, host.length - XIAOE_SUFFIX.length);
    for (const segment of pathSegments(parsed.pathname)) {
      if (XIAOE_TOKEN_RE.test(segment)) {
        return {
          platformId: "xiaoe-tech",
          platformVideoId: segment,
          episodeId: null,
          platformScopeId: scopeId,
        };
      }
    }
    // term_ / goods_..._detail container pages carry no video identity.
    return null;
  }

  function extractBilibili(parsed) {
    const segments = pathSegments(parsed.pathname);
    let bv = null;
    if (parsed.hostname === "b23.tv") {
      // D8: b23.tv/<BV> is locally confirmable; a bare short code is not.
      if (segments.length > 0 && BV_RE.test(segments[0])) {
        bv = segments[0];
      }
    } else {
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (segments[i] === "video" && BV_RE.test(segments[i + 1])) {
          bv = segments[i + 1];
          break;
        }
      }
    }
    if (!bv) {
      return null;
    }
    // The p query value is the episode id, decimal; absent (or not a
    // decimal) means the first episode, so p=1 and no-p are one Source.
    const p = parsed.searchParams.get("p");
    const episodeId = p !== null && /^\d+$/.test(p) ? String(Number.parseInt(p, 10)) : "1";
    return {
      platformId: "bilibili",
      platformVideoId: bv,
      episodeId,
      platformScopeId: null,
    };
  }

  function extractYoutube(parsed) {
    let videoId = null;
    if (parsed.hostname === "youtu.be") {
      const segments = pathSegments(parsed.pathname);
      if (segments.length > 0 && YT_ID_RE.test(segments[0])) {
        videoId = segments[0];
      }
    } else if (parsed.pathname === "/watch") {
      const v = parsed.searchParams.get("v");
      if (v !== null && YT_ID_RE.test(v)) {
        videoId = v;
      }
    }
    if (!videoId) {
      return null;
    }
    return {
      platformId: "youtube",
      platformVideoId: videoId,
      episodeId: null,
      platformScopeId: null,
    };
  }

  function extractXiaohongshu(parsed) {
    // xhslink.com short codes are not locally confirmable (D8); the note
    // id only appears on www.xiaohongshu.com paths.
    if (parsed.hostname !== "www.xiaohongshu.com") {
      return null;
    }
    const segments = pathSegments(parsed.pathname);
    let noteId = null;
    if (segments[0] === "explore" && XHS_NOTE_RE.test(segments[1] || "")) {
      noteId = segments[1];
    } else if (
      segments[0] === "discovery" &&
      segments[1] === "item" &&
      XHS_NOTE_RE.test(segments[2] || "")
    ) {
      noteId = segments[2];
    }
    if (!noteId) {
      return null;
    }
    // URL shape alone cannot tell video notes from image-text ones; the
    // client submits this identity only for playable video notes (D6).
    return {
      platformId: "xiaohongshu",
      platformVideoId: noteId,
      episodeId: null,
      platformScopeId: null,
    };
  }

  const EXTRACTORS = {
    "xiaoe-tech": extractXiaoe,
    "bilibili": extractBilibili,
    "youtube": extractYoutube,
    "xiaohongshu": extractXiaohongshu,
  };

  /**
   * The §1 platformVideoId formats, one regex per platform — the SAME
   * regexes the extractors pin above, exported so consumers (the API's
   * declared-identity validation) judge formats from this module instead
   * of re-declaring them and drifting. Frozen: the formats are contract
   * data, not caller-mutable state.
   */
  const platformVideoIdFormats = Object.freeze({
    "xiaoe-tech": XIAOE_TOKEN_RE,
    "bilibili": BV_RE,
    "youtube": YT_ID_RE,
    "xiaohongshu": XHS_NOTE_RE,
  });

  /**
   * The platform identity a URL carries, per platform-video-id-rules.md.
   * Returns null when no identity is confirmable from the URL alone;
   * never throws on any input.
   */
  function extractVideoIdentity(url) {
    const parsed = safeParseUrl(url);
    if (!parsed) {
      return null;
    }
    const platformId = platformIdForHost(parsed.hostname);
    if (!platformId) {
      return null;
    }
    try {
      return EXTRACTORS[platformId](parsed);
    } catch (_error) {
      return null;
    }
  }

  return { normalizeUrl, extractVideoIdentity, platformVideoIdFormats };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_PLATFORM_VIDEO_ID;
}
