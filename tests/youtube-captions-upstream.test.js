/**
 * Migrated upstream tests (Ticket 2.6, issue #69): the caption-track
 * selection, json3 parsing, fetch fallthrough and player-authorization
 * cases from the youtube-digest repo (~/Workspace/youtube-digest, frozen
 * per ADR 0001). Source files, and what changed in the migration:
 * - tests/caption-selection.test.js — verbatim behavior; the reader module
 *   here is YTD_YOUTUBE_CAPTIONS (repo factory form) instead of YTD_CAPTIONS.
 * - tests/caption-parsing.test.js — the transcript entries are the contract
 *   shape {startMs, endMs, text} on the source timeline (json3's native
 *   milliseconds) instead of the upstream {text, start, duration, language}
 *   display shape; the transcriptTextPlain/Timestamped display joins are
 *   not part of this repo's contract and are not produced.
 * - tests/caption-fetch.test.js — same fallthrough discipline; the result's
 *   ok flag reads available, and the NO_SUITABLE_CAPTION verdict reads as
 *   the honest available:false (无字幕).
 * - the withPlayerCaptionAuthorization cases migrate unchanged (the pure
 *   PO-token merge stays as a seam; its MAIN-world capture caller is not
 *   ported — see youtube-captions.js header).
 *
 * All page dependencies are stubbed (hand-rolled fetch doubles — no
 * network, no jsdom), matching the repo's node:test style.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const captions = require("../youtube-captions.js");

// --- selection (from caption-selection.test.js) --------------------------------

const native = (languageCode, extra = {}) => ({
  languageCode,
  baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}`,
  isTranslatable: true,
  ...extra,
});
const auto = (languageCode, extra = {}) =>
  native(languageCode, { kind: "asr", ...extra });
const translations = (...languageCodes) =>
  languageCodes.map((languageCode) => ({
    languageCode,
    languageName: { simpleText: languageCode },
  }));

test("direct candidates follow Simplified Chinese, Traditional Chinese, then English", () => {
  const picked = captions.selectCaptionCandidates(
    [native("en-US"), native("ja"), native("zh-Hant"), native("zh-Hans"), native("fr")],
    [],
  );

  assert.deepEqual(
    picked.map((track) => track.languageCode),
    ["zh-Hans", "zh-Hant", "en-US"],
  );
});

test("zh-CN is a direct Simplified Chinese candidate rather than a translation source", () => {
  const picked = captions.selectCaptionCandidates(
    [native("zh-CN")],
    translations("zh-Hans"),
  );

  assert.equal(picked.length, 1);
  assert.equal(picked[0].languageCode, "zh-CN");
  assert.equal(picked[0].isAutoTranslated, undefined);
  assert.equal(picked[0].baseUrl.includes("tlang"), false);
});

test("a native track precedes an auto-generated track in the same language", () => {
  const picked = captions.selectCaptionCandidates(
    [auto("zh-Hans"), native("zh-Hans")],
    [],
  );

  assert.deepEqual(
    picked.map((track) => track.kind || "native"),
    ["native", "asr"],
  );
});

test("automatic Chinese and English translations occupy their priority groups", () => {
  const picked = captions.selectCaptionCandidates(
    [native("ja"), native("en"), native("zh-Hant"), native("zh-Hans")],
    translations("en", "zh-Hant", "zh-Hans"),
  );

  assert.deepEqual(
    picked.map(
      (track) =>
        `${track.isAutoTranslated ? "translated" : "direct"}:${track.languageCode}`,
    ),
    [
      "direct:zh-Hans",
      "direct:zh-Hant",
      "translated:zh-Hans",
      "translated:zh-Hans",
      "translated:zh-Hans",
      "translated:zh-Hant",
      "translated:zh-Hant",
      "translated:zh-Hant",
      "direct:en",
      "translated:en",
      "translated:en",
      "translated:en",
    ],
  );
});

test("an automatic translation adds tlang and retains its source language", () => {
  const picked = captions.selectCaptionCandidates([native("ja")], translations("zh-Hans"));

  assert.equal(picked.length, 1);
  assert.equal(
    picked[0].baseUrl,
    "https://www.youtube.com/api/timedtext?lang=ja&tlang=zh-Hans",
  );
  assert.equal(picked[0].languageCode, "zh-Hans");
  assert.equal(picked[0].sourceLanguageCode, "ja");
  assert.equal(picked[0].isAutoTranslated, true);
});

test("unsupported languages and unavailable translations produce no candidates", () => {
  assert.deepEqual(captions.selectCaptionCandidates([native("ja")], []), []);
  assert.deepEqual(
    captions.selectCaptionCandidates(
      [native("ja", { isTranslatable: false })],
      translations("zh-Hans", "en"),
    ),
    [],
  );
  assert.deepEqual(captions.selectCaptionCandidates(undefined, undefined), []);
});

// --- fetch fallthrough (from caption-fetch.test.js) -----------------------------
//
// The migrated verdicts speak the repo's contract vocabulary: available /
// reason instead of the upstream success / error, and the honest
// available:false stands in for NO_SUITABLE_CAPTION (无字幕 — 不猜、不误报).

const track = (languageCode, extra = {}) => ({
  languageCode,
  baseUrl: `https://www.youtube.com/api/timedtext?v=test&lang=${languageCode}`,
  isTranslatable: true,
  ...extra,
});
const json3WithText = (text) => ({
  events: [
    {
      tStartMs: 0,
      dDurationMs: 1000,
      segs: [{ utf8: text }],
    },
  ],
});
const okJson = (json3) => ({ ok: true, json: async () => json3 });

test("an empty higher-priority caption falls through to the next language", async () => {
  const requested = [];
  const routes = {
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hans&fmt=json3":
      okJson({ events: [] }),
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hant&fmt=json3":
      okJson(json3WithText("繁體中文")),
  };
  const result = await captions.fetchCaptionTranscript(
    [track("zh-Hans"), track("zh-Hant")],
    [],
    async (url) => {
      requested.push(url);
      return routes[url];
    },
  );

  assert.equal(result.available, true);
  assert.deepEqual(result.track, { language: "zh-Hant", asr: false, autoTranslated: false });
  assert.deepEqual(result.segments, [
    { startMs: 0, endMs: 1000, text: "繁體中文" },
  ]);
  assert.deepEqual(requested, [
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hans&fmt=json3",
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hant&fmt=json3",
  ]);
});

test("empty, malformed, and failed captions fall through to automatic Chinese", async () => {
  const requested = [];
  const autoChineseUrl =
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hant&tlang=zh-Hans&fmt=json3";
  const result = await captions.fetchCaptionTranscript(
    [track("zh-Hans"), track("zh-Hant"), track("ja")],
    translations("zh-Hans"),
    async (url) => {
      requested.push(url);
      if (url === autoChineseUrl) return okJson(json3WithText("自动翻译中文"));
      if (url.includes("lang=zh-Hant&")) return { ok: false };
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      };
    },
  );

  assert.equal(result.available, true);
  assert.equal(result.track.language, "zh-Hans");
  assert.equal(result.track.autoTranslated, true);
  assert.deepEqual(result.segments, [
    { startMs: 0, endMs: 1000, text: "自动翻译中文" },
  ]);
  assert.deepEqual(requested, [
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hans&fmt=json3",
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hant&fmt=json3",
    autoChineseUrl,
  ]);
});

test("no suitable candidates returns 无字幕 without fetching", async () => {
  let fetchCount = 0;
  const result = await captions.fetchCaptionTranscript(
    [track("ja", { isTranslatable: false })],
    [],
    async () => {
      fetchCount += 1;
      return okJson(json3WithText("unexpected"));
    },
  );

  assert.deepEqual(result, { available: false, reason: "no_subtitle_track" });
  assert.equal(fetchCount, 0);
});

test("all empty or failed candidates answer honestly 无字幕", async () => {
  const result = await captions.fetchCaptionTranscript(
    [track("zh-Hans"), track("en")],
    [],
    async () => okJson({ events: [] }),
  );

  assert.deepEqual(result, { available: false, reason: "timedtext_failed" });
});

test("a caption URL without a query string uses a question mark for json3", async () => {
  let requestedUrl;
  const result = await captions.fetchCaptionTranscript(
    [track("en", { baseUrl: "https://www.youtube.com/api/timedtext" })],
    [],
    async (url) => {
      requestedUrl = url;
      return okJson(json3WithText("English"));
    },
  );

  assert.equal(result.available, true);
  assert.equal(requestedUrl, "https://www.youtube.com/api/timedtext?fmt=json3");
});

test("player authorization is merged without replacing candidate language parameters", () => {
  const candidate =
    "https://www.youtube.com/api/timedtext?v=video&lang=ja&signature=candidate&tlang=zh-Hans";
  const playerRequest =
    "https://www.youtube.com/api/timedtext?v=video&lang=en&potc=1&pot=token&c=WEB&cver=1.2&cplayer=UNIPLAYER&xorb=2&fmt=json3";

  const merged = new URL(
    captions.withPlayerCaptionAuthorization(candidate, playerRequest),
  );
  assert.equal(merged.searchParams.get("v"), "video");
  assert.equal(merged.searchParams.get("lang"), "ja");
  assert.equal(merged.searchParams.get("signature"), "candidate");
  assert.equal(merged.searchParams.get("tlang"), "zh-Hans");
  assert.equal(merged.searchParams.get("potc"), "1");
  assert.equal(merged.searchParams.get("pot"), "token");
  assert.equal(merged.searchParams.get("c"), "WEB");
  assert.equal(merged.searchParams.get("cver"), "1.2");
  assert.equal(merged.searchParams.get("cplayer"), "UNIPLAYER");
  assert.equal(merged.searchParams.get("xorb"), "2");
  assert.equal(merged.searchParams.get("fmt"), null);
});

test("caption fetching can apply player authorization to its request URL", async () => {
  let requestedUrl;
  const playerRequest =
    "https://www.youtube.com/api/timedtext?v=test&lang=en&pot=token&potc=1&c=WEB";
  const result = await captions.fetchCaptionTranscript(
    [track("en")],
    [],
    async (url) => {
      requestedUrl = url;
      return okJson(json3WithText("Authorized English"));
    },
    (url) => captions.withPlayerCaptionAuthorization(url, playerRequest),
  );

  assert.equal(result.available, true);
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.searchParams.get("pot"), "token");
  assert.equal(parsed.searchParams.get("potc"), "1");
  assert.equal(parsed.searchParams.get("c"), "WEB");
  assert.equal(parsed.searchParams.get("fmt"), "json3");
});
