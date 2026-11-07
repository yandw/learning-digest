const test = require("node:test");
const assert = require("node:assert/strict");

const captions = require("../captions.js");

test("single event with single segment", () => {
  const json3 = {
    events: [
      {
        tStartMs: 0,
        dDurationMs: 3000,
        segs: [{ utf8: "Hello world" }],
      },
    ],
  };
  const result = captions.parseTimedtextJson3(json3, "en");
  assert.equal(result.transcript.length, 1);
  assert.deepEqual(result.transcript[0], {
    text: "Hello world",
    start: 0,
    duration: 3,
    language: "en",
  });
  assert.equal(result.transcriptTextPlain, "Hello world");
  assert.equal(result.transcriptTextTimestamped, "[0:00] Hello world");
});

test("multiple segments in one event are joined", () => {
  const result = captions.parseTimedtextJson3(
    {
      events: [
        {
          tStartMs: 65000,
          dDurationMs: 2500,
          segs: [{ utf8: "never gonna " }, { utf8: "give you up" }],
        },
      ],
    },
    "en",
  );
  assert.equal(result.transcript[0].text, "never gonna give you up");
  assert.equal(result.transcript[0].start, 65);
  assert.equal(result.transcriptTextTimestamped, "[1:05] never gonna give you up");
});

test("speaker change markers are removed", () => {
  const result = captions.parseTimedtextJson3(
    { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: ">> Welcome back" }] }] },
    "en",
  );
  assert.equal(result.transcript[0].text, "Welcome back");
});

test("newline-only and segment-less events are skipped", () => {
  const result = captions.parseTimedtextJson3(
    {
      events: [
        { tStartMs: 0, dDurationMs: 500 },
        { tStartMs: 500, dDurationMs: 500, segs: [{ utf8: "\n" }] },
        { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: ">> " }] },
        { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: "kept" }] },
      ],
    },
    "en",
  );
  assert.equal(result.transcript.length, 1);
  assert.equal(result.transcript[0].text, "kept");
});

test("missing events yields an empty transcript", () => {
  assert.deepEqual(captions.parseTimedtextJson3({}, "en").transcript, []);
  assert.deepEqual(captions.parseTimedtextJson3(null, "en").transcript, []);
});
