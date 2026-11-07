const test = require("node:test");
const assert = require("node:assert/strict");

const captions = require("../captions.js");

const track = (languageCode, extra = {}) => ({
  languageCode,
  baseUrl: `https://www.youtube.com/api/timedtext?v=test&lang=${languageCode}`,
  isTranslatable: true,
  ...extra,
});
const translations = (...languageCodes) =>
  languageCodes.map((languageCode) => ({
    languageCode,
    languageName: { simpleText: languageCode },
  }));
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

  assert.equal(result.success, true);
  assert.equal(result.language, "zh-Hant");
  assert.equal(result.transcriptText, "繁體中文");
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

  assert.equal(result.success, true);
  assert.equal(result.language, "zh-Hans");
  assert.equal(result.transcriptText, "自动翻译中文");
  assert.deepEqual(requested, [
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hans&fmt=json3",
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hant&fmt=json3",
    autoChineseUrl,
  ]);
});

test("no suitable candidates returns a readable error without fetching", async () => {
  let fetchCount = 0;
  const result = await captions.fetchCaptionTranscript(
    [track("ja", { isTranslatable: false })],
    [],
    async () => {
      fetchCount += 1;
      return okJson(json3WithText("unexpected"));
    },
  );

  assert.deepEqual(result, {
    success: false,
    error: "NO_SUITABLE_CAPTION",
    message: "抓取不到合适的字幕",
  });
  assert.equal(fetchCount, 0);
});

test("all empty or failed candidates return the same readable error", async () => {
  const result = await captions.fetchCaptionTranscript(
    [track("zh-Hans"), track("en")],
    [],
    async () => okJson({ events: [] }),
  );

  assert.deepEqual(result, {
    success: false,
    error: "NO_SUITABLE_CAPTION",
    message: "抓取不到合适的字幕",
  });
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

  assert.equal(result.success, true);
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

  assert.equal(result.success, true);
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.searchParams.get("pot"), "token");
  assert.equal(parsed.searchParams.get("potc"), "1");
  assert.equal(parsed.searchParams.get("c"), "WEB");
  assert.equal(parsed.searchParams.get("fmt"), "json3");
});
