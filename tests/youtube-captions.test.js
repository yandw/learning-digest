/**
 * YouTube caption reader (Ticket 2.6, issue #69), tested through the
 * createYouTubeCaptionReader factory seam with hand-stubbed page
 * environments — the repo style (no jsdom), the same discipline as
 * tests/bilibili-captions.test.js. The factory is the exact code the
 * content script runs, so every stubbed behavior here is the shipped
 * behavior.
 *
 * Contract anchors (contracts/contract-r2.md §3.3, decision D15):
 * - segments are {startMs, endMs, text} on the SOURCE video timeline;
 * - 读不到字幕时明确 available:false（不猜、不误报）—— a failed read can
 *   never produce invented segments;
 * - the owning frame is the one whose player response describes the video
 *   its own URL names — anything else stays silent.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseTimedtextJson3,
  createYouTubeCaptionReader,
  parseBridgeCaptionResponse,
} = require("../youtube-captions.js");

// --- parsing: timedtext json3 → contract segments -------------------------------

test("json3 events map to contract segments on the source timeline", () => {
  const json3 = {
    events: [
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "Hello world" }] },
      {
        tStartMs: 65000,
        dDurationMs: 2500,
        segs: [{ utf8: "never gonna " }, { utf8: "give you up" }],
      },
    ],
  };
  assert.deepEqual(parseTimedtextJson3(json3), [
    { startMs: 0, endMs: 3000, text: "Hello world" },
    { startMs: 65000, endMs: 67500, text: "never gonna give you up" },
  ]);
});

test("speaker-change markers are stripped and empty events dropped", () => {
  const json3 = {
    events: [
      { tStartMs: 0, dDurationMs: 500 },
      { tStartMs: 500, dDurationMs: 500, segs: [{ utf8: "\n" }] },
      { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: ">> " }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: ">> Welcome back" }] },
    ],
  };
  assert.deepEqual(parseTimedtextJson3(json3), [
    { startMs: 2000, endMs: 3000, text: "Welcome back" },
  ]);
});

test("a body without usable events parses to null, never invented segments", () => {
  assert.equal(parseTimedtextJson3({ events: [] }), null);
  assert.equal(parseTimedtextJson3({}), null);
  assert.equal(parseTimedtextJson3(null), null);
});

// --- the reader factory: discovery, ownership, read ------------------------------
//
// The isolated-world content script cannot see the player's JS state
// (movie_player.getPlayerResponse() is MAIN-world), so the reader reads the
// watch page's embedded ytInitialPlayerResponse — the window global when a
// page world exposes it, else the <script> body. Only the frame whose
// player response describes the video its own URL names answers; everything
// else stays silent (the bridge's only-the-owning-frame rule).

const WATCH_URL = "https://www.youtube.com/watch?v=AbCdEfGh123";

const PLAYER_RESPONSE = {
  videoDetails: { videoId: "AbCdEfGh123" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          languageCode: "zh-Hans",
          baseUrl:
            "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=zh-Hans",
          isTranslatable: true,
        },
      ],
      translationLanguages: [],
    },
  },
};

const TIMEDTEXT_BODY = {
  events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "字幕正文" }] }],
};

/** A realistic watch-page script tag embedding the player response. */
function embeddedScript(playerResponse) {
  return `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};var meta = {nested: {braces: "} {"}};`;
}

function stubEnvironment({
  href = WATCH_URL,
  windowResponse = undefined,
  scripts = [],
  fetchImpl = null,
  documentStub = undefined,
} = {}) {
  const windowStub = { location: { href } };
  if (windowResponse !== undefined) {
    windowStub.ytInitialPlayerResponse = windowResponse;
  }
  const doc = documentStub || {
    querySelectorAll: (selector) =>
      selector === "script" ? scripts.map((text) => ({ text })) : [],
  };
  const env = { document: doc, window: windowStub };
  if (fetchImpl) env.fetch = fetchImpl;
  return env;
}

test("probe sees the window-global player response of its own video", () => {
  const reader = createYouTubeCaptionReader(
    stubEnvironment({ windowResponse: PLAYER_RESPONSE }),
  );
  assert.deepEqual(reader.probe(), {
    present: true,
    source: "window_player_response",
  });
});

test("probe sees the script-embedded player response as the fallback source", () => {
  const reader = createYouTubeCaptionReader(
    stubEnvironment({ scripts: [embeddedScript(PLAYER_RESPONSE)] }),
  );
  assert.deepEqual(reader.probe(), { present: true, source: "embedded_script" });
});

test("probe stays absent on a page without any player response", () => {
  const reader = createYouTubeCaptionReader(stubEnvironment({}));
  assert.deepEqual(reader.probe(), { present: false, source: null });
});

test("a player response describing another video is not the owning frame", () => {
  // The SPA staleness case: the embedded response still describes the
  // previous video. The frame stays silent — answering would risk the wrong
  // video's captions, and an honest timeout beats an invented archive.
  const stale = {
    ...PLAYER_RESPONSE,
    videoDetails: { videoId: "OtherVideo99" },
  };
  const reader = createYouTubeCaptionReader(
    stubEnvironment({ scripts: [embeddedScript(stale)] }),
  );
  assert.deepEqual(reader.probe(), { present: false, source: null });
});

test("probe does not throw on a hostile page", () => {
  const reader = createYouTubeCaptionReader(
    stubEnvironment({
      documentStub: {
        querySelectorAll: () => {
          throw new Error("cross-world proxy");
        },
      },
    }),
  );
  assert.deepEqual(reader.probe(), { present: false, source: null });
});

test("read fetches the owned track and maps json3 to source-timeline segments", async () => {
  const fetched = [];
  const reader = createYouTubeCaptionReader(
    stubEnvironment({
      windowResponse: PLAYER_RESPONSE,
      fetchImpl: async (url) => {
        fetched.push(url);
        return { ok: true, json: async () => TIMEDTEXT_BODY };
      },
    }),
  );

  const result = await reader.read();

  assert.equal(result.available, true);
  assert.deepEqual(fetched, [
    "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=zh-Hans&fmt=json3",
  ]);
  assert.deepEqual(result.segments, [
    { startMs: 1000, endMs: 3000, text: "字幕正文" },
  ]);
  assert.deepEqual(result.track, {
    language: "zh-Hans",
    asr: false,
    autoTranslated: false,
  });
});

test("read answers no_subtitle_track when the player response lists no tracks", async () => {
  const fetched = [];
  const reader = createYouTubeCaptionReader(
    stubEnvironment({
      windowResponse: {
        videoDetails: { videoId: "AbCdEfGh123" },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
      },
      fetchImpl: async (url) => {
        fetched.push(url);
        return { ok: true, json: async () => TIMEDTEXT_BODY };
      },
    }),
  );

  const result = await reader.read();

  assert.deepEqual(result, { available: false, reason: "no_subtitle_track" });
  assert.deepEqual(fetched, [], "无字幕 is observed, never fetched into being");
});

test("read answers timedtext_failed when every candidate fetch is unusable", async () => {
  const reader = createYouTubeCaptionReader(
    stubEnvironment({
      windowResponse: PLAYER_RESPONSE,
      fetchImpl: async () => ({ ok: true, json: async () => ({ events: [] }) }),
    }),
  );

  const result = await reader.read();

  assert.deepEqual(result, { available: false, reason: "timedtext_failed" });
});

test("a track naming another video is skipped even inside an owned response", async () => {
  const fetched = [];
  const staleTrack = {
    ...PLAYER_RESPONSE,
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            languageCode: "zh-Hans",
            baseUrl:
              "https://www.youtube.com/api/timedtext?v=OtherVideo99&lang=zh-Hans",
            isTranslatable: true,
          },
          {
            languageCode: "en",
            baseUrl:
              "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=en",
            isTranslatable: true,
          },
        ],
        translationLanguages: [],
      },
    },
  };
  const reader = createYouTubeCaptionReader(
    stubEnvironment({
      windowResponse: staleTrack,
      fetchImpl: async (url) => {
        fetched.push(url);
        return { ok: true, json: async () => TIMEDTEXT_BODY };
      },
    }),
  );

  const result = await reader.read();

  assert.equal(result.available, true);
  assert.deepEqual(fetched, [
    "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=en&fmt=json3",
  ]);
  assert.equal(result.track.language, "en");
});

test("read without fetch answers subtitle_fetch_failed instead of inventing", async () => {
  // In Node the global fetch IS a function (and would dial the real
  // network) — the page world's same-origin fetch is an injection seam, so
  // the no-fetch-seam path must be observable by removing the global for
  // the duration of this test. No network is ever attempted.
  const globalFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const reader = createYouTubeCaptionReader(
      stubEnvironment({ windowResponse: PLAYER_RESPONSE }),
    );
    const result = await reader.read();
    assert.deepEqual(result, { available: false, reason: "subtitle_fetch_failed" });
  } finally {
    globalThis.fetch = globalFetch;
  }
});

test("read over a studied interval carries the coverage block (2.7's input)", async () => {
  const reader = createYouTubeCaptionReader(
    stubEnvironment({
      windowResponse: PLAYER_RESPONSE,
      fetchImpl: async () => ({ ok: true, json: async () => TIMEDTEXT_BODY }),
    }),
  );

  const covered = await reader.read({
    intervalStartMs: 1000,
    intervalEndMs: 3000,
  });
  assert.deepEqual(covered.coverage, { covered: true, uncovered: [] });

  const gapped = await reader.read({
    intervalStartMs: 0,
    intervalEndMs: 10000,
  });
  assert.deepEqual(gapped.coverage, {
    covered: false,
    uncovered: [
      { startMs: 0, endMs: 1000 },
      { startMs: 3000, endMs: 10000 },
    ],
  });

  const noInterval = await reader.read();
  assert.equal(noInterval.coverage, undefined, "coverage is never guessed");
});

test("a malformed bridge answer reads as unavailable, never as captions", () => {
  assert.deepEqual(parseBridgeCaptionResponse(null), {
    available: false,
    reason: "bridge_malformed",
  });
  assert.deepEqual(parseBridgeCaptionResponse({ success: false }), {
    available: false,
    reason: "bridge_malformed",
  });
  assert.deepEqual(
    parseBridgeCaptionResponse({ success: true, available: false, reason: "timedtext_failed" }),
    { available: false, reason: "timedtext_failed" },
  );
  assert.deepEqual(parseBridgeCaptionResponse({ success: true, available: true, segments: [] }), {
    available: false,
    reason: "no_subtitle_track",
  });
  assert.deepEqual(
    parseBridgeCaptionResponse({
      success: true,
      available: true,
      segments: [{ startMs: 1, endMs: 2, text: "ok" }, { bad: true }],
    }).segments.length,
    1,
    "malformed segments are filtered, not archived",
  );
  assert.deepEqual(
    parseBridgeCaptionResponse({
      success: true,
      available: true,
      segments: [{ startMs: 1000, endMs: 2000, text: "ok" }],
      track: { language: "zh-Hans", asr: true },
      coverage: { covered: false, uncovered: [{ startMs: 0, endMs: 1000 }] },
    }),
    {
      available: true,
      segments: [{ startMs: 1000, endMs: 2000, text: "ok" }],
      track: { language: "zh-Hans", asr: true, autoTranslated: false },
      coverage: { covered: false, uncovered: [{ startMs: 0, endMs: 1000 }] },
    },
  );
});
