/**
 * Bilibili caption reader (Ticket 2.5, issue #68), tested through the
 * createBilibiliCaptionReader factory seam with hand-stubbed page
 * environments — the repo style (no jsdom), the same discipline as
 * tests/page-bridge.test.js. The factory is the exact code the content
 * script runs, so every stubbed behavior here is the shipped behavior.
 *
 * Contract anchors (contracts/contract-r2.md §3.3, decision D15):
 * - segments are {startMs, endMs, text} on the SOURCE video timeline;
 * - 读不到字幕时明确 available:false（不猜、不误报）—— a failed read can
 *   never produce invented segments;
 * - coverage over the studied interval feeds the later 强制转写 ticket.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createBilibiliCaptionReader,
  parseCaptionSegments,
  computeCaptionCoverage,
  parseBridgeCaptionResponse,
} = require("../bilibili-captions.js");

// --- hand-rolled stubs -------------------------------------------------------

/** The page state a bilibili video page embeds (__INITIAL_STATE__). */
function stubEnvironment({
  initialState = undefined,
  player = undefined,
  fetchImpl = null,
} = {}) {
  const windowStub = { location: { href: "https://www.bilibili.com/video/BV1ab411L78c?p=2" } };
  if (initialState !== undefined) windowStub.__INITIAL_STATE__ = initialState;
  if (player !== undefined) windowStub.player = player;
  const documentStub = { title: "第2话 隐函数 - 哔哩哔哩" };
  const env = { document: documentStub, window: windowStub };
  if (fetchImpl) env.fetch = fetchImpl;
  return env;
}

const CC_TRACK = {
  id: 1,
  lan: "zh-CN",
  ai_type: 0,
  subtitle_url: "//aisubtitle.hdslb.com/cc.json",
};

const AI_TRACK = {
  id: 2,
  lan: "ai-zh",
  ai_type: 1,
  subtitle_url: "//aisubtitle.hdslb.com/ai.json",
};

const SUBTITLE_BODY = {
  body: [
    { from: 138, to: 159, content: "这一节我们把注意力分数放到矩阵上看" },
    { from: 159, to: 181, content: "Q K V 三个矩阵各司其职" },
  ],
};

// --- probe ---------------------------------------------------------------------

test("probe sees the page-state subtitle track list", () => {
  const env = stubEnvironment({
    initialState: { videoData: { subtitle: { list: [CC_TRACK] } } },
  });
  const reader = createBilibiliCaptionReader(env);
  assert.deepEqual(reader.probe(), { present: true, source: "page_state" });
});

test("probe stays absent on a page without any subtitle source", () => {
  const reader = createBilibiliCaptionReader(stubEnvironment({}));
  assert.deepEqual(reader.probe(), { present: false, source: null });
});

test("probe sees the player-exposed detail subtitle list as a fallback", () => {
  const player = {
    getVideoDetail: () => ({ subtitle: { list: [AI_TRACK] } }),
  };
  const reader = createBilibiliCaptionReader(stubEnvironment({ player }));
  assert.deepEqual(reader.probe(), { present: true, source: "player" });
});

test("probe does not throw on a hostile page state", () => {
  const reader = createBilibiliCaptionReader(
    stubEnvironment({
      initialState: {
        get videoData() {
          throw new Error("cross-world proxy");
        },
      },
    }),
  );
  assert.deepEqual(reader.probe(), { present: false, source: null });
});

// --- read: captions available ----------------------------------------------------

test("read fetches the CC track and maps the body to source-timeline segments", async () => {
  const fetched = [];
  const env = stubEnvironment({
    initialState: { videoData: { subtitle: { list: [CC_TRACK] } } },
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => SUBTITLE_BODY };
    },
  });
  const reader = createBilibiliCaptionReader(env);

  const result = await reader.read();

  assert.equal(result.available, true);
  assert.deepEqual(fetched, ["https://aisubtitle.hdslb.com/cc.json"]);
  assert.deepEqual(result.segments, [
    { startMs: 138000, endMs: 159000, text: "这一节我们把注意力分数放到矩阵上看" },
    { startMs: 159000, endMs: 181000, text: "Q K V 三个矩阵各司其职" },
  ]);
  assert.deepEqual(result.track, { lan: "zh-CN", ai: false });
});

test("read prefers the CC track over the AI track", async () => {
  const env = stubEnvironment({
    initialState: { videoData: { subtitle: { list: [AI_TRACK, CC_TRACK] } } },
    fetchImpl: async () => ({ ok: true, json: async () => SUBTITLE_BODY }),
  });
  const reader = createBilibiliCaptionReader(env);

  const result = await reader.read();

  assert.equal(result.available, true);
  assert.deepEqual(result.track, { lan: "zh-CN", ai: false });
});

test("read falls back to the AI track when no CC track exists", async () => {
  const env = stubEnvironment({
    initialState: { videoData: { subtitle: { list: [AI_TRACK] } } },
    fetchImpl: async () => ({ ok: true, json: async () => SUBTITLE_BODY }),
  });
  const reader = createBilibiliCaptionReader(env);

  const result = await reader.read();

  assert.equal(result.available, true);
  assert.deepEqual(result.track, { lan: "ai-zh", ai: true });
});

// --- read: no captions (明确无字幕，不猜) -----------------------------------------

test("read on an empty track list answers available:false no_subtitle_track", async () => {
  const env = stubEnvironment({
    initialState: { videoData: { subtitle: { list: [] } } },
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  const reader = createBilibiliCaptionReader(env);

  const result = await reader.read();

  assert.deepEqual(result, { available: false, reason: "no_subtitle_track" });
});

test("read without any subtitle source answers available:false no_subtitle_track", async () => {
  const reader = createBilibiliCaptionReader(stubEnvironment({}));
  const result = await reader.read();
  assert.deepEqual(result, { available: false, reason: "no_subtitle_track" });
});

test("read never reports captions when the subtitle fetch fails", async () => {
  const env = stubEnvironment({
    initialState: { videoData: { subtitle: { list: [CC_TRACK] } } },
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  const reader = createBilibiliCaptionReader(env);

  const result = await reader.read();

  assert.deepEqual(result, { available: false, reason: "subtitle_fetch_failed" });
});

test("read never reports captions when the subtitle body is not usable", async () => {
  for (const payload of [
    { body: [] },
    { body: [{ from: 10, to: 20, content: "   " }] },
    { nope: true },
    "not json shaped",
  ]) {
    const env = stubEnvironment({
      initialState: { videoData: { subtitle: { list: [CC_TRACK] } } },
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    });
    const reader = createBilibiliCaptionReader(env);
    const result = await reader.read();
    assert.deepEqual(result, { available: false, reason: "no_subtitle_track" }, JSON.stringify(payload));
  }
});

test("read tolerates a missing fetch implementation (no captions invented)", async () => {
  const env = stubEnvironment({
    initialState: { videoData: { subtitle: { list: [CC_TRACK] } } },
  });
  const reader = createBilibiliCaptionReader(env);
  const result = await reader.read();
  assert.deepEqual(result, { available: false, reason: "subtitle_fetch_failed" });
});

test("read tolerates a hostile environment without throwing", async () => {
  const reader = createBilibiliCaptionReader({
    document: null,
    window: null,
    fetch: () => {
      throw new Error("boom");
    },
  });
  const result = await reader.read();
  assert.equal(result.available, false);
});

// --- coverage over the studied interval ------------------------------------------

test("read computes coverage over the studied interval when given one", async () => {
  const env = stubEnvironment({
    initialState: { videoData: { subtitle: { list: [CC_TRACK] } } },
    fetchImpl: async () => ({ ok: true, json: async () => SUBTITLE_BODY }),
  });
  const reader = createBilibiliCaptionReader(env);

  // The fixture session covers 138000-181000; studying 120000-200000 leaves
  // the head and the tail uncovered.
  const result = await reader.read({ intervalStartMs: 120000, intervalEndMs: 200000 });

  assert.equal(result.available, true);
  assert.deepEqual(result.coverage, {
    covered: false,
    uncovered: [
      { startMs: 120000, endMs: 138000 },
      { startMs: 181000, endMs: 200000 },
    ],
  });
});

test("coverage over a fully captioned interval is covered:true with no ranges", async () => {
  const coverage = computeCaptionCoverage(SUBTITLE_BODY_SEGS(), 138000, 181000);
  assert.deepEqual(coverage, { covered: true, uncovered: [] });
});

test("coverage reports the caption-hole ranges without inventing text", async () => {
  // The contract fixture's caption hole: the track itself has none between
  // 181000 and 300000 (api-session-transcript-captions-finished).
  const segments = [
    { startMs: 138000, endMs: 159000, text: "一" },
    { startMs: 159000, endMs: 181000, text: "二" },
    { startMs: 300000, endMs: 330000, text: "三" },
  ];
  const coverage = computeCaptionCoverage(segments, 0, 360000);
  assert.deepEqual(coverage, {
    covered: false,
    uncovered: [
      { startMs: 0, endMs: 138000 },
      { startMs: 181000, endMs: 300000 },
      { startMs: 330000, endMs: 360000 },
    ],
  });
});

test("coverage is null without a well-formed interval", () => {
  const segments = [{ startMs: 0, endMs: 1000, text: "x" }];
  assert.equal(computeCaptionCoverage(segments), null);
  assert.equal(computeCaptionCoverage(segments, -5, 1000), null);
  assert.equal(computeCaptionCoverage(segments, 2000, 1000), null);
  assert.equal(computeCaptionCoverage([{ startMs: 0, endMs: 1000 }], 0, 1000), null);
});

// --- the pure body parser ----------------------------------------------------------

function SUBTITLE_BODY_SEGS() {
  return parseCaptionSegments(SUBTITLE_BODY);
}

test("parseCaptionSegments maps from/to seconds to integer milliseconds", () => {
  assert.deepEqual(parseCaptionSegments(SUBTITLE_BODY), [
    { startMs: 138000, endMs: 159000, text: "这一节我们把注意力分数放到矩阵上看" },
    { startMs: 159000, endMs: 181000, text: "Q K V 三个矩阵各司其职" },
  ]);
});

test("parseCaptionSegments drops empty-text entries and keeps zero-length ones", () => {
  const body = {
    body: [
      { from: 0, to: 5, content: "" },
      { from: 5, to: 5, content: "零长段合法" },
      { from: 10, to: 12, content: "  有空白  " },
    ],
  };
  assert.deepEqual(parseCaptionSegments(body), [
    { startMs: 5000, endMs: 5000, text: "零长段合法" },
    { startMs: 10000, endMs: 12000, text: "有空白" },
  ]);
});

test("parseCaptionSegments sorts by startMs and returns null on garbage", () => {
  const body = {
    body: [
      { from: 20, to: 30, content: "后" },
      { from: 0, to: 10, content: "前" },
    ],
  };
  assert.deepEqual(
    parseCaptionSegments(body).map((s) => s.text),
    ["前", "后"],
  );
  assert.equal(parseCaptionSegments(null), null);
  assert.equal(parseCaptionSegments({ body: "x" }), null);
  assert.equal(parseCaptionSegments({ body: [{ from: "a", to: 5, content: "x" }] }), null);
});

// --- the bridge answer parser (background side) ------------------------------------

test("parseBridgeCaptionResponse normalizes a well-formed available answer", () => {
  const parsed = parseBridgeCaptionResponse({
    success: true,
    available: true,
    segments: [{ startMs: 1000, endMs: 2000, text: "你好" }],
    track: { lan: "zh-CN", ai: false },
  });
  assert.deepEqual(parsed, {
    available: true,
    segments: [{ startMs: 1000, endMs: 2000, text: "你好" }],
    track: { lan: "zh-CN", ai: false },
  });
});

test("parseBridgeCaptionResponse keeps an explicit unavailable reason", () => {
  const parsed = parseBridgeCaptionResponse({
    success: true,
    available: false,
    reason: "no_subtitle_track",
  });
  assert.deepEqual(parsed, { available: false, reason: "no_subtitle_track" });
});

test("parseBridgeCaptionResponse answers unavailable on anything malformed", () => {
  for (const payload of [
    null,
    undefined,
    { success: false },
    { success: true },
    { success: true, available: true, segments: "nope" },
    { success: true, available: true, segments: [{ text: "no times" }] },
    "garbage",
  ]) {
    const parsed = parseBridgeCaptionResponse(payload);
    assert.equal(parsed.available, false, JSON.stringify(payload));
    assert.equal(typeof parsed.reason, "string", JSON.stringify(payload));
  }
});

test("parseBridgeCaptionResponse passes a well-formed coverage block through", () => {
  const coverage = { covered: false, uncovered: [{ startMs: 0, endMs: 1000 }] };
  const parsed = parseBridgeCaptionResponse({
    success: true,
    available: true,
    segments: [{ startMs: 1000, endMs: 2000, text: "你好" }],
    coverage,
  });
  assert.deepEqual(parsed.coverage, coverage);
  const bad = parseBridgeCaptionResponse({
    success: true,
    available: true,
    segments: [{ startMs: 1000, endMs: 2000, text: "你好" }],
    coverage: { covered: "yes" },
  });
  assert.equal(bad.coverage, undefined);
});
