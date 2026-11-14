/**
 * Source Platform registry: the switchable adapter layer between the
 * extension and each learning platform (first: xiaoe-tech.com).
 *
 * A Source Platform adapter exposes:
 * - id: the platform identifier used in recognition results,
 * - recognizePage(url): a PURE function over the page URL returning
 *   { platformId, kind, timestampKind } where kind is one of
 *   "course" | "live" | "replay" | "none" and timestampKind is "video"
 *   (media position) or "wallclock" (elapsed since Session start) — null
 *   when kind is "none". Recognition must be total: any input, including
 *   garbage, returns a result and never throws, because callers feed it
 *   whatever the active tab's URL happens to be.
 *
 * The side panel and background script talk only to this registry, so a
 * new platform plugs in without touching the core pipeline.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node
 * and loaded with importScripts / <script> tags.
 */
var YTD_SOURCE_PLATFORMS = (() => {
  const registry = [];

  function registerSourcePlatform(adapter) {
    if (!adapter || typeof adapter.id !== "string" || !adapter.id) {
      throw new Error("Source Platform requires an id");
    }
    if (typeof adapter.recognizePage !== "function") {
      throw new Error(`Source Platform ${adapter.id} requires recognizePage`);
    }
    registry.push(adapter);
    return adapter;
  }

  function listSourcePlatforms() {
    return [...registry];
  }

  const NONE = Object.freeze({ platformId: null, kind: "none", timestampKind: null });

  /**
   * Recognizes a page URL against every registered Source Platform, in
   * registration order. The first non-"none" result wins; when no platform
   * recognizes the URL the shared "none" result is returned.
   *
   * @param {unknown} url
   * @returns {{platformId: string|null, kind: string, timestampKind: string|null}}
   */
  function recognizePage(url) {
    for (const adapter of registry) {
      let result;
      try {
        result = adapter.recognizePage(url);
      } catch (_error) {
        // A misbehaving adapter must never break recognition overall.
        continue;
      }
      if (result && result.kind && result.kind !== "none") return result;
    }
    return NONE;
  }

  return { registerSourcePlatform, listSourcePlatforms, recognizePage };
})();

// --- xiaoe-tech.com Source Platform ----------------------------------------
//
// URL shapes are implemented as data + pure functions and covered
// defensively: the extension cannot assume every shop uses the same path
// layout, and unknown pages must resolve to "none" rather than throw.
// Known resource-id tokens (from xiaoe-tech's own tooling conventions):
// p_ = product/column, v_ = video, a_ = audio, i_ = image-text,
// l_ = live/replay. Live pages take precedence because an l_ page that is
// currently broadcasting has no recording, so wall-clock timestamps and
// the explicit end action are the safe defaults there.

var YTD_SOURCE_PLATFORM_XIAOE = (() => {
  const ID = "xiaoe-tech";
  const HOST_SUFFIX = "xiaoe-tech.com";

  // Ordered: the first matcher that hits decides kind and timestampKind.
  // Explicit replay/playback paths beat the l_ token, because the same
  // live resource id serves both the broadcast and its recording: when
  // the URL says replay, the recording (video timestamps) wins.
  const PAGE_MATCHERS = Object.freeze([
    {
      kind: "replay",
      timestampKind: "video",
      // Explicit replay/playback paths.
      test: (path) => /(^|\/)(replay|playback)([_\/-]|s|$)/i.test(path),
    },
    {
      kind: "live",
      timestampKind: "wallclock",
      // /live/..., /live_player/..., /live-room..., or an l_ live resource id.
      test: (path) =>
        /(^|\/)live([_\/-]|player|$)/i.test(path) || /\/l_[a-z0-9]{4,}/i.test(path),
    },
    {
      kind: "course",
      timestampKind: "video",
      // Goods/course detail pages and playable resource ids (video, audio,
      // image-text, product/column). These pages carry a media player, so
      // timestamps follow the media position.
      test: (path) =>
        /goods_(pc_)?detail/i.test(path) ||
        /\/(p|v|a|i)_[a-z0-9]{4,}/i.test(path) ||
        /\/term_[a-z0-9]{4,}/i.test(path),
    },
  ]);

  function hostMatches(hostname) {
    return (
      hostname === HOST_SUFFIX || hostname.endsWith(`.${HOST_SUFFIX}`)
    );
  }

  /**
   * @param {unknown} url
   * @returns {{platformId: string|null, kind: string, timestampKind: string|null}}
   */
  function recognizePage(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (_error) {
      return { platformId: null, kind: "none", timestampKind: null };
    }
    if (!/^https?:$/.test(parsed.protocol) || !hostMatches(parsed.hostname)) {
      return { platformId: null, kind: "none", timestampKind: null };
    }
    for (const matcher of PAGE_MATCHERS) {
      if (matcher.test(parsed.pathname)) {
        return { platformId: ID, kind: matcher.kind, timestampKind: matcher.timestampKind };
      }
    }
    return { platformId: null, kind: "none", timestampKind: null };
  }

  return { id: ID, hostSuffix: HOST_SUFFIX, recognizePage };
})();

YTD_SOURCE_PLATFORMS.registerSourcePlatform(YTD_SOURCE_PLATFORM_XIAOE);

// --- bilibili.com Source Platform (P10b, #63) -------------------------------
//
// Only real playback pages recognize: /video/<BV> on the desktop and mobile
// hosts, the URL shapes contracts/platform-video-id-rules.md §1 pins. b23.tv
// is a redirect host with no player of its own — recognition stays "none"
// there and the redirect lands on /video/<BV>, where the page-bridge injects.
// The multi-episode p= query does not change recognition (one BV page hosts
// every episode; the identity extractor reads p as the episode id).

var YTD_SOURCE_PLATFORM_BILIBILI = (() => {
  const ID = "bilibili";
  const HOSTS = new Set(["www.bilibili.com", "m.bilibili.com"]);
  // Same BV shape the identity extractor pins (contracts/platform-video-id.js
  // BV_RE). Duplicated here on purpose: the registry must stay load-order
  // independent of the contracts module (importScripts order differs between
  // the service worker and the Node test harness).
  const BV_RE = /^BV[0-9A-Za-z]{10}$/;

  /**
   * @param {unknown} url
   * @returns {{platformId: string|null, kind: string, timestampKind: string|null}}
   */
  function recognizePage(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (_error) {
      return { platformId: null, kind: "none", timestampKind: null };
    }
    if (!/^https?:$/.test(parsed.protocol) || !HOSTS.has(parsed.hostname)) {
      return { platformId: null, kind: "none", timestampKind: null };
    }
    const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
    if (segments[0] === "video" && BV_RE.test(segments[1] || "")) {
      return { platformId: ID, kind: "video", timestampKind: "video" };
    }
    return { platformId: null, kind: "none", timestampKind: null };
  }

  return { id: ID, recognizePage };
})();

YTD_SOURCE_PLATFORMS.registerSourcePlatform(YTD_SOURCE_PLATFORM_BILIBILI);

// --- youtube.com Source Platform (P10b, #63) --------------------------------
//
// Only the /watch playback page recognizes, with a well-formed v= id, on the
// three watch hosts (www / m / music). youtu.be is a redirect host with no
// player of its own — recognition stays "none" there and the redirect lands
// on www.youtube.com/watch, where the page-bridge injects. Shorts, feeds and
// channel pages carry no recognizable round-1 playback identity and stay
// "none"; the id shape mirrors contracts/platform-video-id.js YT_ID_RE.

var YTD_SOURCE_PLATFORM_YOUTUBE = (() => {
  const ID = "youtube";
  const HOSTS = new Set(["www.youtube.com", "m.youtube.com", "music.youtube.com"]);
  const VIDEO_ID_RE = /^[0-9A-Za-z_-]{11}$/;

  /**
   * @param {unknown} url
   * @returns {{platformId: string|null, kind: string, timestampKind: string|null}}
   */
  function recognizePage(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (_error) {
      return { platformId: null, kind: "none", timestampKind: null };
    }
    if (!/^https?:$/.test(parsed.protocol) || !HOSTS.has(parsed.hostname)) {
      return { platformId: null, kind: "none", timestampKind: null };
    }
    if (parsed.pathname === "/watch" && VIDEO_ID_RE.test(parsed.searchParams.get("v") || "")) {
      return { platformId: ID, kind: "video", timestampKind: "video" };
    }
    return { platformId: null, kind: "none", timestampKind: null };
  }

  return { id: ID, recognizePage };
})();

YTD_SOURCE_PLATFORMS.registerSourcePlatform(YTD_SOURCE_PLATFORM_YOUTUBE);

// --- xiaohongshu.com Source Platform (P10b, #63) ----------------------------
//
// Note pages recognize: /explore/<id> and /discovery/item/<id> with a 24-hex
// note id on www.xiaohongshu.com. The URL shape cannot tell a video note from
// an image-text one (contract decision D6), so the adapter commits to the
// video-note reading — those are the pages a learner opens to play, and the
// ticket's "视频笔记 video" semantics. On an image-text page the page-bridge
// finds no media and the position stream simply stays quiet (the same
// "bridge without media" state live pages already live with). xhslink.com is
// a redirect host with no player — recognition stays "none" there.

var YTD_SOURCE_PLATFORM_XIAOHONGSHU = (() => {
  const ID = "xiaohongshu";
  const HOST = "www.xiaohongshu.com";
  // Same note-id shape the identity extractor pins (contracts/platform-video-id.js
  // XHS_NOTE_RE): 24 hex characters.
  const NOTE_ID_RE = /^[0-9a-f]{24}$/i;

  /**
   * @param {unknown} url
   * @returns {{platformId: string|null, kind: string, timestampKind: string|null}}
   */
  function recognizePage(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (_error) {
      return { platformId: null, kind: "none", timestampKind: null };
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.hostname !== HOST) {
      return { platformId: null, kind: "none", timestampKind: null };
    }
    const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
    const noteId =
      segments[0] === "explore" && NOTE_ID_RE.test(segments[1] || "")
        ? segments[1]
        : segments[0] === "discovery" && segments[1] === "item" && NOTE_ID_RE.test(segments[2] || "")
          ? segments[2]
          : null;
    if (noteId) {
      return { platformId: ID, kind: "video", timestampKind: "video" };
    }
    return { platformId: null, kind: "none", timestampKind: null };
  }

  return { id: ID, recognizePage };
})();

YTD_SOURCE_PLATFORMS.registerSourcePlatform(YTD_SOURCE_PLATFORM_XIAOHONGSHU);

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SOURCE_PLATFORMS;
}
