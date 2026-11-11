/**
 * Bilibili caption reader (Ticket 2.5, issue #68): the page-side seam that
 * reads the captions a bilibili video page exposes, so the captions path can
 * archive them directly (contract-r2 §3.3, decision D15) — 全程零 ASR.
 *
 * The reader probes the two places a bilibili video page exposes its
 * subtitle track list, in order:
 * - the embedded page state (window.__INITIAL_STATE__.videoData.subtitle.list)
 *   — the desktop page always embeds it; CC and AI subtitle tracks alike
 *     appear there as {id, lan, ai_type, subtitle_url};
 * - the player instance (window.player.getVideoDetail().subtitle.list) — a
 *   defensive fallback for builds that keep the detail in the player only.
 * A track's subtitle_url (protocol-relative aisubtitle JSON, body[] of
 * {from, to, content} in seconds) is fetched and parsed into contract-shaped
 * segments {startMs, endMs, text} on the SOURCE video timeline.
 *
 * 不猜、不误报: a missing/empty track list, a failed fetch or an unusable
 * body all answer {available: false, reason} — the reader never invents
 * segments, so "无字幕" is always an honest observation. The studied
 * interval can be passed to read(); the coverage block it returns (which
 * ranges of the interval have no captions) is the 强制转写 ticket's input.
 *
 * Structure: YTD_BILIBILI_CAPTIONS.createBilibiliCaptionReader(env) builds
 * the behavior over an injected DOM/window/fetch environment so the Node
 * tests drive the SAME code the content script runs
 * (tests/bilibili-captions.test.js, hand-stubbed — no jsdom). The factory
 * has no auto-start of its own: page-bridge.js owns the message seam and
 * creates the reader over its own environment.
 */
var YTD_BILIBILI_CAPTIONS = (() => {
  // Segment shape of contract-r2 §2.2 minus origin (the server stamps it).
  function isValidSegment(segment) {
    return (
      !!segment &&
      typeof segment === "object" &&
      Number.isInteger(segment.startMs) &&
      segment.startMs >= 0 &&
      Number.isInteger(segment.endMs) &&
      segment.endMs >= segment.startMs &&
      typeof segment.text === "string" &&
      segment.text.trim() !== ""
    );
  }

  function isValidCoverage(coverage) {
    if (!coverage || typeof coverage !== "object") return false;
    if (typeof coverage.covered !== "boolean") return false;
    if (!Array.isArray(coverage.uncovered)) return false;
    return coverage.uncovered.every(
      (range) =>
        !!range &&
        typeof range === "object" &&
        Number.isInteger(range.startMs) &&
        range.startMs >= 0 &&
        Number.isInteger(range.endMs) &&
        range.endMs >= range.startMs,
    );
  }

  /**
   * The subtitle body ({body: [{from, to, content}]}, seconds) → contract
   * segments on the source timeline. Empty-text entries are dropped (they
   * are not text the contract could archive), zero-length segments stay
   * (§2.2 allows endMs === startMs), the list is sorted by startMs. Null
   * when nothing usable is there — the caller answers 无字幕 instead of
   * archiving guesses.
   */
  function parseCaptionSegments(body) {
    const raw = body && typeof body === "object" ? body.body : null;
    if (!Array.isArray(raw)) return null;
    const segments = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const from = Number(entry.from);
      const to = Number(entry.to);
      const text = typeof entry.content === "string" ? entry.content.trim() : "";
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0) continue;
      if (to < from) continue;
      if (text === "") continue;
      segments.push({
        startMs: Math.round(from * 1000),
        endMs: Math.round(to * 1000),
        text,
      });
    }
    if (segments.length === 0) return null;
    segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    return segments;
  }

  /**
   * Which ranges of [intervalStartMs, intervalEndMs] carry no caption
   * segment — the coverage block the 强制转写 ticket consumes. Null when
   * the interval itself is not well-formed (the caller then omits
   * coverage instead of guessing an interval).
   */
  function computeCaptionCoverage(segments, intervalStartMs, intervalEndMs) {
    const start = Number(intervalStartMs);
    const end = Number(intervalEndMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return null;
    }
    if (!Array.isArray(segments)) return null;
    // Garbage in, no coverage out: any malformed segment makes the whole
    // computation refuse (the 强制转写 input must never rest on a guessed
    // union of half-parsed ranges).
    if (!segments.every(isValidSegment)) return null;
    const coveredRanges = [];
    for (const segment of segments) {
      if (!isValidSegment(segment)) continue;
      const from = Math.max(segment.startMs, Math.round(start));
      const to = Math.min(segment.endMs, Math.round(end));
      if (to > from) coveredRanges.push([from, to]);
    }
    coveredRanges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const range of coveredRanges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) {
        last[1] = Math.max(last[1], range[1]);
      } else {
        merged.push([range[0], range[1]]);
      }
    }
    const uncovered = [];
    let cursor = Math.round(start);
    for (const [from, to] of merged) {
      if (from > cursor) uncovered.push({ startMs: cursor, endMs: from });
      cursor = Math.max(cursor, to);
    }
    if (cursor < Math.round(end)) uncovered.push({ startMs: cursor, endMs: Math.round(end) });
    return { covered: uncovered.length === 0, uncovered };
  }

  /**
   * Normalizes one track-list entry to {lan, ai, url} or null. The page API
   * speaks snake_case (ai_type, subtitle_url); a camelCase variant is
   * accepted defensively. url must look like an http(s) or
   * protocol-relative URL — anything else is not a readable track.
   */
  function normalizeTrack(entry) {
    if (!entry || typeof entry !== "object") return null;
    const url = entry.subtitle_url ?? entry.subtitleUrl;
    if (typeof url !== "string" || url === "") return null;
    const lan = typeof entry.lan === "string" && entry.lan ? entry.lan : null;
    const aiType = entry.ai_type ?? entry.aiType;
    const ai =
      aiType === undefined || aiType === null
        ? /ai/i.test(String(lan || ""))
        : Number(aiType) === 1;
    return { lan, ai, url: url.startsWith("//") ? `https:${url}` : url };
  }

  /** The subtitle track list from one probe source, or null. */
  function trackListFrom(source) {
    if (!source || typeof source !== "object") return null;
    const subtitle = source.subtitle;
    if (!subtitle || typeof subtitle !== "object") return null;
    return Array.isArray(subtitle.list) ? subtitle.list : null;
  }

  /**
   * @param {object} env
   * @param {Document} [env.document]
   * @param {Window} [env.window] - carries __INITIAL_STATE__ / player
   * @param {Function} [env.fetch] - the subtitle body fetch (page world:
   *   the native fetch)
   */
  function createBilibiliCaptionReader(env) {
    const win = (env && env.window) || null;
    const fetchImpl =
      env && typeof env.fetch === "function"
        ? env.fetch
        : typeof fetch === "function"
          ? fetch
          : null;

    /** One probe step: a source getter → its track list. Never throws. */
    function probeStep(getSource, sourceName) {
      let list = null;
      try {
        list = trackListFrom(getSource());
      } catch (_error) {
        return { present: false, source: null };
      }
      if (list === null) return { present: false, source: null };
      return { present: true, source: sourceName, list };
    }

    /**
     * Synchronous "can this page expose a subtitle track list?" — the
     * message seam decides whether this frame answers. present stays true
     * for an EMPTY list (that frame owns the honest 无字幕 answer); only a
     * frame that cannot see any subtitle source at all stays absent.
     */
    function probe() {
      const steps = [
        () =>
          probeStep(() => {
            const state = win && win.__INITIAL_STATE__;
            const videoData = state && typeof state === "object" ? state.videoData : null;
            return videoData && typeof videoData === "object" ? videoData : null;
          }, "page_state"),
        () =>
          probeStep(() => {
            const player = win && win.player;
            if (!player || typeof player.getVideoDetail !== "function") return null;
            return player.getVideoDetail();
          }, "player"),
      ];
      for (const step of steps) {
        const result = step();
        if (result.present) {
          return { present: true, source: result.source };
        }
      }
      return { present: false, source: null };
    }

    /** The first probe step that sees a track list (probe()'s fuller twin). */
    function findTrackList() {
      const state = win && win.__INITIAL_STATE__;
      const videoData = state && typeof state === "object" ? state.videoData : null;
      const steps = [
        [videoData, "page_state"],
        [
          (() => {
            try {
              const player = win && win.player;
              return player && typeof player.getVideoDetail === "function"
                ? player.getVideoDetail()
                : null;
            } catch (_error) {
              return null;
            }
          })(),
          "player",
        ],
      ];
      for (const [source, sourceName] of steps) {
        const list = trackListFrom(source);
        if (list !== null) return { list, source: sourceName };
      }
      return null;
    }

    async function fetchSegments(track) {
      if (!fetchImpl) return { available: false, reason: "subtitle_fetch_failed" };
      let body = null;
      try {
        const response = await fetchImpl(track.url);
        if (!response || !response.ok) {
          return { available: false, reason: "subtitle_fetch_failed" };
        }
        body = await response.json();
      } catch (_error) {
        return { available: false, reason: "subtitle_fetch_failed" };
      }
      const segments = parseCaptionSegments(body);
      if (!segments) return { available: false, reason: "no_subtitle_track" };
      return {
        available: true,
        segments,
        track: { lan: track.lan, ai: track.ai },
      };
    }

    /**
     * Reads the captions. Options: {intervalStartMs, intervalEndMs} — the
     * studied interval; when well-formed the answer carries the coverage
     * block over it, otherwise coverage is omitted (never guessed).
     *
     * @returns {Promise<object>} available:true with segments/track (and
     *   optional coverage), or available:false with a reason.
     */
    async function read(options = {}) {
      const found = findTrackList();
      if (!found) return { available: false, reason: "no_subtitle_track" };

      // CC first, AI second (ai_type 1): the CC track is the uploader's own
      // subtitle, the AI track is machine-generated — prefer the human one.
      const tracks = found.list
        .map(normalizeTrack)
        .filter(Boolean)
        .sort((a, b) => Number(a.ai) - Number(b.ai));
      if (tracks.length === 0) return { available: false, reason: "no_subtitle_track" };

      let result = null;
      for (const track of tracks) {
        result = await fetchSegments(track);
        if (result.available) break;
        // A 403 on the AI track URL must not read as "no captions" when the
        // CC track would have worked; try the next track before giving up.
        if (result.reason !== "subtitle_fetch_failed") break;
      }
      if (!result || !result.available) {
        return (
          result || { available: false, reason: "no_subtitle_track" }
        );
      }

      const coverage = computeCaptionCoverage(
        result.segments,
        options && options.intervalStartMs,
        options && options.intervalEndMs,
      );
      if (coverage) result.coverage = coverage;
      return result;
    }

    return { probe, read };
  }

  /**
   * The background-side normalizer for the bridge's getBilibiliCaptions
   * answer. Anything malformed — a failed command reply, a page that did
   * not answer, a shape that does not parse — reads as unavailable, so the
   * caller falls through to the 无字幕 state without ever inventing
   * captions.
   */
  function parseBridgeCaptionResponse(response) {
    if (!response || typeof response !== "object" || response.success !== true) {
      return { available: false, reason: "bridge_malformed" };
    }
    if (response.available !== true) {
      return {
        available: false,
        reason: typeof response.reason === "string" && response.reason
          ? response.reason
          : "no_subtitle_track",
      };
    }
    if (!Array.isArray(response.segments)) {
      return { available: false, reason: "bridge_malformed" };
    }
    const segments = response.segments.filter(isValidSegment);
    if (segments.length === 0) {
      return { available: false, reason: "no_subtitle_track" };
    }
    const result = { available: true, segments };
    if (
      response.track &&
      typeof response.track === "object" &&
      typeof response.track.lan === "string"
    ) {
      result.track = { lan: response.track.lan, ai: response.track.ai === true };
    }
    if (isValidCoverage(response.coverage)) result.coverage = response.coverage;
    return result;
  }

  return {
    createBilibiliCaptionReader,
    parseCaptionSegments,
    computeCaptionCoverage,
    parseBridgeCaptionResponse,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_BILIBILI_CAPTIONS;
}
