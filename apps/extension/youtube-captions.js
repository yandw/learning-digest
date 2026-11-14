/**
 * YouTube caption reader (Ticket 2.6, issue #69): the page-side seam that
 * reads the captions a YouTube watch page exposes, so the captions path can
 * archive them directly (contract-r2 §3.3, decision D15) — 全程零 ASR.
 *
 * Ported from the youtube-digest repo (~/Workspace/youtube-digest, frozen
 * per ADR 0001 — no two-way sync): captions.js there is the caption-track
 * selection and timedtext parsing core; content.js/background.js there own
 * the page wiring. Migration notes (what changed and why):
 * - the reader follows the bilibili-captions.js factory form (Ticket 2.5):
 *   createYouTubeCaptionReader(env) over an injected DOM/window/fetch, so
 *   the Node tests drive the SAME code the content script runs;
 * - discovery is adapted to the isolated-world content script: the upstream
 *   MAIN world reads movie_player.getPlayerResponse(), which the page-bridge
 *   cannot see — the reader reads the watch page's embedded
 *   ytInitialPlayerResponse (window global first, then the <script> body)
 *   and only a frame whose player response describes the video its own URL
 *   names answers (the only-the-owning-frame rule, extended);
 * - segments are contract-shaped {startMs, endMs, text} on the source video
 *   timeline (json3 speaks milliseconds natively), not the upstream
 *   {text, start, duration, language} display shape;
 * - the upstream's PO-token capture (background.js MAIN-world fetch hook)
 *   is NOT ported — a timedtext request that needs the player-issued token
 *   fails honestly to available:false; withPlayerCaptionAuthorization stays
 *   as the pure seam for a future MAIN-world caller.
 *
 * 不猜、不误报: a missing/stale player response, an empty track list, a
 * failed fetch or an unusable body all answer {available: false, reason} —
 * the reader never invents segments, so "无字幕" is always an honest
 * observation. The studied interval can be passed to read(); the coverage
 * block it returns (which ranges of the interval have no captions) is the
 * 强制转写 ticket's input.
 */
var YTD_YOUTUBE_CAPTIONS = (() => {
  // Shared Transcript-shape helpers (transcript-shapes.js): the §2.2
  // Segment check and the coverage block live there now, shared with
  // bilibili-captions.js and session-archive.js. In Node tests we require
  // them; in the content script the global arrives via the manifest's
  // content-script load order.
  const transcriptShapes =
    typeof YTD_TRANSCRIPT_SHAPES !== "undefined"
      ? YTD_TRANSCRIPT_SHAPES
      : require("./transcript-shapes.js");
  const { isValidSegment, computeCaptionCoverage } = transcriptShapes;

  /**
   * The timedtext json3 body → contract segments on the source timeline.
   * One event's segs[].utf8 join is one segment (">>" speaker-change
   * markers stripped — YouTube auto-caption noise, not text); empty-text
   * events are dropped. Null when nothing usable is there — the caller
   * falls through to the next candidate (or answers 无字幕) instead of
   * archiving guesses.
   */
  function parseTimedtextJson3(json3) {
    const events = json3 && typeof json3 === "object" ? json3.events : null;
    if (!Array.isArray(events)) return null;
    const segments = [];
    for (const event of events) {
      const segs = event && typeof event === "object" ? event.segs : null;
      const text = (Array.isArray(segs) ? segs : [])
        .map((s) => (s && typeof s === "object" ? s.utf8 : "") || "")
        .join("")
        .replace(/>> ?/g, "")
        .trim();
      if (text === "") continue;
      const startMs = Math.round(Number(event.tStartMs) || 0);
      const durationMs = Math.round(Number(event.dDurationMs) || 0);
      segments.push({
        startMs: startMs >= 0 ? startMs : 0,
        endMs: (startMs >= 0 ? startMs : 0) + (durationMs > 0 ? durationMs : 0),
        text,
      });
    }
    if (segments.length === 0) return null;
    return segments;
  }

  // ============================================================
  // Caption track selection (verbatim mechanism from upstream captions.js)
  // ============================================================

  function normalizedLanguage(track) {
    return String(track?.languageCode || "").toLowerCase();
  }

  function chineseLanguageGroup(track) {
    const code = normalizedLanguage(track);
    if (["zh", "zh-hans", "zh-cn", "zh-sg"].includes(code)) {
      return "zh-hans";
    }
    if (["zh-hant", "zh-tw", "zh-hk", "zh-mo"].includes(code)) {
      return "zh-hant";
    }
    return "";
  }

  function isEnglish(track) {
    const code = normalizedLanguage(track);
    return code === "en" || code.startsWith("en-");
  }

  function translatedTrack(track, languageCode) {
    const separator = track.baseUrl.includes("?") ? "&" : "?";
    return {
      ...track,
      baseUrl: `${track.baseUrl}${separator}tlang=${encodeURIComponent(languageCode)}`,
      languageCode,
      sourceLanguageCode: track.languageCode,
      isAutoTranslated: true,
    };
  }

  /**
   * The candidate order the fetch walks: direct Simplified Chinese, direct
   * Traditional Chinese, automatic Chinese translations, direct English,
   * automatic English translations — native before auto-generated (asr)
   * within each group. Only tracks the player declares translatable feed
   * the translation candidates.
   */
  function selectCaptionCandidates(tracks, translationLanguages) {
    if (!Array.isArray(tracks)) return [];
    const ordered = tracks
      .filter((track) => track?.baseUrl)
      .sort((a, b) => Number(a.kind === "asr") - Number(b.kind === "asr"));
    const availableTranslations = new Set(
      (Array.isArray(translationLanguages) ? translationLanguages : [])
        .map((language) => language?.languageCode)
        .filter(Boolean),
    );
    const candidates = [];

    function addDirect(predicate) {
      candidates.push(...ordered.filter(predicate));
    }

    function addTranslations(languageCodes) {
      for (const languageCode of languageCodes) {
        if (!availableTranslations.has(languageCode)) continue;
        const targetCode = languageCode.toLowerCase();
        const sources = ordered.filter((track) => {
          if (!track.isTranslatable) return false;
          return languageCode === "en"
            ? !isEnglish(track)
            : chineseLanguageGroup(track) !== targetCode;
        });
        candidates.push(
          ...sources.map((track) => translatedTrack(track, languageCode)),
        );
      }
    }

    addDirect((track) => chineseLanguageGroup(track) === "zh-hans");
    addDirect((track) => chineseLanguageGroup(track) === "zh-hant");
    addTranslations(["zh-Hans", "zh-Hant"]);
    addDirect(isEnglish);
    addTranslations(["en"]);
    return candidates;
  }

  /**
   * The player-issued timedtext request carries the PO Token and client
   * parameters; this pure merge copies the authorization keys onto a
   * candidate URL without replacing the candidate's own language
   * parameters. The MAIN-world capture that obtains the player request is
   * upstream-only (not ported); the merge stays as the pure seam.
   */
  function withPlayerCaptionAuthorization(baseUrl, playerRequestUrl) {
    const candidate = new URL(baseUrl);
    const authorized = new URL(playerRequestUrl);
    const authorizationKeys = [
      "potc",
      "pot",
      "xorb",
      "xobt",
      "xovt",
      "cbrand",
      "cbr",
      "cbrver",
      "c",
      "cver",
      "cplayer",
      "cos",
      "cosver",
      "cplatform",
    ];
    for (const key of authorizationKeys) {
      const value = authorized.searchParams.get(key);
      if (value !== null) candidate.searchParams.set(key, value);
    }
    return candidate.toString();
  }

  /**
   * Walks the caption candidates and fetches their timedtext bodies until
   * one yields usable segments (upstream mechanism, contract-shaped
   * result). A listed track can still return an empty body, a non-ok
   * response or malformed JSON — each falls through to the next candidate
   * rather than failing the whole read. No candidates → 无字幕
   * (no_subtitle_track, nothing fetched); every candidate unusable →
   * timedtext_failed — an honest available:false either way.
   *
   * @param {Array} tracks captionTracks from the player response
   * @param {Array} translationLanguages the player's translation targets
   * @param {Function} fetchImpl the timedtext fetch (page world: same-origin)
   * @param {Function} [authorizeUrl] URL rewriter for the player-issued
   *   authorization merge (see withPlayerCaptionAuthorization)
   */
  async function fetchCaptionTranscript(
    tracks,
    translationLanguages,
    fetchImpl,
    authorizeUrl = (url) => url,
  ) {
    // No fetch seam at all (the page world's same-origin fetch is injected)
    // is a distinct honest verdict — the bilibili reader's fetchSegments
    // discipline: a missing transport can never read as "no captions exist".
    if (typeof fetchImpl !== "function") {
      return { available: false, reason: "subtitle_fetch_failed" };
    }
    const candidates = selectCaptionCandidates(tracks, translationLanguages);
    for (const selectedTrack of candidates) {
      try {
        const baseUrl = authorizeUrl(selectedTrack.baseUrl);
        const separator = baseUrl.includes("?") ? "&" : "?";
        const response = await fetchImpl(`${baseUrl}${separator}fmt=json3`);
        if (!response || !response.ok) continue;
        const json3 = await response.json();
        const segments = parseTimedtextJson3(json3);
        if (!segments) continue;
        return {
          available: true,
          segments,
          track: {
            language: selectedTrack.languageCode,
            asr: selectedTrack.kind === "asr",
            autoTranslated: selectedTrack.isAutoTranslated === true,
          },
        };
      } catch (_error) {
        // A listed track can still return an empty body or malformed JSON.
        // Try the next candidate rather than failing the whole transcript.
      }
    }
    return {
      available: false,
      reason: candidates.length === 0 ? "no_subtitle_track" : "timedtext_failed",
    };
  }

  // ============================================================
  // Coverage (the 强制转写 ticket's input; same block as bilibili-captions)
  // ============================================================

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

  // ============================================================
  // Discovery: the embedded player response (isolated-world adaptation)
  // ============================================================

  /**
   * The video id the frame's own URL names: the watch pages' v= parameter,
   * with the /embed, /shorts and /live path forms as defense for frames the
   * manifest's match patterns could someday inject. Null when the frame
   * names no video at all.
   */
  function frameVideoId(href) {
    let parsed;
    try {
      parsed = new URL(String(href || ""));
    } catch (_error) {
      return null;
    }
    const v = parsed.searchParams.get("v");
    if (v && /^[0-9A-Za-z_-]{11}$/.test(v)) return v;
    const embedded = parsed.pathname.match(/^\/(embed|shorts|live)\/([0-9A-Za-z_-]{11})/);
    return embedded ? embedded[2] : null;
  }

  function rendererOf(playerResponse) {
    if (!playerResponse || typeof playerResponse !== "object") return null;
    const captions =
      playerResponse.captions &&
      typeof playerResponse.captions === "object"
        ? playerResponse.captions
        : null;
    const renderer = captions ? captions.playerCaptionsTracklistRenderer : null;
    if (!renderer || typeof renderer !== "object") return null;
    if (!Array.isArray(renderer.captionTracks)) return null;
    return renderer;
  }

  /**
   * Extracts the JSON object assigned to ytInitialPlayerResponse in a
   * <script> body. The scan finds the assignment, then balances braces with
   * string/escape awareness (script tails and string literals may hold
   * braces of their own). Malformed or absent assignments yield null — a
   * page that does not embed the response stays unread, not guessed.
   */
  function extractEmbeddedPlayerResponse(scriptText) {
    const text = typeof scriptText === "string" ? scriptText : "";
    const marker = text.indexOf("ytInitialPlayerResponse");
    if (marker === -1) return null;
    const start = text.indexOf("{", marker);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let quote = "";
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            return parsed && typeof parsed === "object" ? parsed : null;
          } catch (_error) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * The player responses this frame can see, in probe order: the window
   * global (a page-world visibility some builds and embeds expose), then
   * the <script> bodies. Each entry carries its source name; a body without
   * a captions renderer is not a caption source.
   */
  function discoverPlayerResponses(doc, win) {
    const found = [];
    try {
      const windowResponse = win ? win.ytInitialPlayerResponse : null;
      const renderer = rendererOf(windowResponse);
      if (renderer) {
        found.push({
          renderer,
          videoId:
            windowResponse.videoDetails &&
            typeof windowResponse.videoDetails.videoId === "string"
              ? windowResponse.videoDetails.videoId
              : null,
          source: "window_player_response",
        });
      }
    } catch (_error) {
      // A hostile or cross-world window is not a caption source.
    }
    try {
      const scripts = typeof doc.querySelectorAll === "function" ? doc.querySelectorAll("script") : [];
      for (const script of Array.from(scripts)) {
        const parsed = extractEmbeddedPlayerResponse(script && script.text);
        if (!parsed) continue;
        const renderer = rendererOf(parsed);
        if (!renderer) continue;
        found.push({
          renderer,
          videoId:
            parsed.videoDetails && typeof parsed.videoDetails.videoId === "string"
              ? parsed.videoDetails.videoId
              : null,
          source: "embedded_script",
        });
        break;
      }
    } catch (_error) {
      // An unreadable document is not a caption source.
    }
    return found;
  }

  // ============================================================
  // The reader factory (the bilibili-captions.js form)
  // ============================================================

  /**
   * @param {object} env
   * @param {Document} [env.document]
   * @param {Window} [env.window] - the frame's location decides ownership
   * @param {Function} [env.fetch] - the timedtext fetch (page world:
   *   same-origin for www.youtube.com/api/timedtext)
   */
  function createYouTubeCaptionReader(env) {
    const doc = (env && env.document) || null;
    const win = (env && env.window) || null;
    const fetchImpl =
      env && typeof env.fetch === "function"
        ? env.fetch
        : typeof fetch === "function"
          ? fetch
          : null;

    function ownedResponse() {
      const expected = frameVideoId(win && win.location && win.location.href);
      if (!expected) return null;
      for (const response of discoverPlayerResponses(doc, win)) {
        // Ownership is the videoId: a response describing another video
        // (the SPA staleness case, or an embed iframe's own player) stays
        // silent — an honest timeout beats the wrong video's captions.
        if (response.videoId === expected) return response;
      }
      return null;
    }

    /**
     * Synchronous "can this frame answer for its own video's captions?" —
     * present stays true for a response whose track list is EMPTY (that
     * frame owns the honest 无字幕 answer); a frame without an owned
     * player response stays absent.
     */
    function probe() {
      const owned = ownedResponse();
      if (!owned) return { present: false, source: null };
      return { present: true, source: owned.source };
    }

    async function read(options = {}) {
      const owned = ownedResponse();
      if (!owned) return { available: false, reason: "player_response_unavailable" };

      const renderer = owned.renderer;
      // Defense in depth: a track whose baseUrl names another video is
      // stale even inside an owned response.
      const tracks = renderer.captionTracks.filter((track) => {
        if (!track || typeof track !== "object" || typeof track.baseUrl !== "string") {
          return false;
        }
        try {
          const v = new URL(track.baseUrl).searchParams.get("v");
          return v === null || v === owned.videoId;
        } catch (_error) {
          return false;
        }
      });

      const result = await fetchCaptionTranscript(
        tracks,
        Array.isArray(renderer.translationLanguages) ? renderer.translationLanguages : [],
        fetchImpl,
      );
      if (!result.available) return result;

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
   * The background-side normalizer for the bridge's getYouTubeCaptions
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
      typeof response.track.language === "string"
    ) {
      result.track = {
        language: response.track.language,
        asr: response.track.asr === true,
        autoTranslated: response.track.autoTranslated === true,
      };
    }
    if (isValidCoverage(response.coverage)) result.coverage = response.coverage;
    return result;
  }

  return {
    // Re-exported from transcript-shapes.js: the shared §2.2 Segment check
    // and coverage computation (existing consumers keep importing them
    // from this module).
    isValidSegment,
    computeCaptionCoverage,
    parseTimedtextJson3,
    selectCaptionCandidates,
    withPlayerCaptionAuthorization,
    fetchCaptionTranscript,
    createYouTubeCaptionReader,
    parseBridgeCaptionResponse,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_YOUTUBE_CAPTIONS;
}
