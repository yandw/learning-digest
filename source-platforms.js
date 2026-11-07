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

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SOURCE_PLATFORMS;
}
