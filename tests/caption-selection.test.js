const test = require("node:test");
const assert = require("node:assert/strict");

const captions = require("../captions.js");

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
    [
      native("en-US"),
      native("ja"),
      native("zh-Hant"),
      native("zh-Hans"),
      native("fr"),
    ],
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
    [
      native("ja"),
      native("en"),
      native("zh-Hant"),
      native("zh-Hans"),
    ],
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
  const picked = captions.selectCaptionCandidates(
    [native("ja")],
    translations("zh-Hans"),
  );

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
