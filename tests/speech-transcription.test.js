const test = require("node:test");
const assert = require("node:assert/strict");

const speechTranscription = require("../speech-transcription.js");

test("alignChunkSegments adds the chunk offset to each segment's start", () => {
  const verboseJson = {
    segments: [
      { start: 0, end: 2.5, text: "Hello there" },
      { start: 2.5, end: 5, text: "and welcome" },
    ],
  };
  const records = speechTranscription.alignChunkSegments(verboseJson, 600);
  assert.deepEqual(records, [
    { text: "Hello there", start: 600, duration: 2 },
    { text: "and welcome", start: 602, duration: 2 },
  ]);
});

test("alignChunkSegments includes language when provided", () => {
  const records = speechTranscription.alignChunkSegments(
    { segments: [{ start: 0, end: 1, text: "Bonjour" }] },
    0,
    "fr",
  );
  assert.equal(records[0].language, "fr");
});

test("alignChunkSegments skips blank-text segments", () => {
  const records = speechTranscription.alignChunkSegments(
    {
      segments: [
        { start: 0, end: 1, text: "  " },
        { start: 1, end: 2, text: "kept" },
      ],
    },
    0,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].text, "kept");
});

test("alignChunkSegments yields an empty list for missing/malformed input", () => {
  assert.deepEqual(speechTranscription.alignChunkSegments({}, 0), []);
  assert.deepEqual(speechTranscription.alignChunkSegments(null, 0), []);
  assert.deepEqual(
    speechTranscription.alignChunkSegments({ segments: "not-an-array" }, 0),
    [],
  );
});

test("failedChunkRecord marks the chunk's time range as failed", () => {
  const record = speechTranscription.failedChunkRecord(600, 600);
  assert.deepEqual(record, {
    text: "[语音转录失败]",
    start: 600,
    duration: 600,
    failed: true,
  });
});

test("stitchChunks joins successful chunks into plain and timestamped text", () => {
  const chunk1 = speechTranscription.alignChunkSegments(
    { segments: [{ start: 0, end: 3, text: "First chunk" }] },
    0,
  );
  const chunk2 = speechTranscription.alignChunkSegments(
    { segments: [{ start: 0, end: 3, text: "Second chunk" }] },
    600,
  );
  const result = speechTranscription.stitchChunks([chunk1, chunk2]);

  assert.equal(result.transcript.length, 2);
  assert.equal(result.transcriptTextPlain, "First chunk Second chunk");
  assert.equal(
    result.transcriptTextTimestamped,
    "[0:00] First chunk\n[10:00] Second chunk",
  );
  assert.equal(result.hasFailures, false);
});

test("stitchChunks annotates a failed chunk's gap and keeps the rest", () => {
  const chunk1 = speechTranscription.alignChunkSegments(
    { segments: [{ start: 0, end: 3, text: "First chunk" }] },
    0,
  );
  const chunk2 = [speechTranscription.failedChunkRecord(600, 600)];
  const chunk3 = speechTranscription.alignChunkSegments(
    { segments: [{ start: 0, end: 3, text: "Third chunk" }] },
    1200,
  );
  const result = speechTranscription.stitchChunks([chunk1, chunk2, chunk3]);

  assert.equal(result.hasFailures, true);
  // The failure marker contributes no text to the plain transcript.
  assert.equal(result.transcriptTextPlain, "First chunk Third chunk");
  assert.equal(
    result.transcriptTextTimestamped,
    "[0:00] First chunk\n[10:00-20:00] 语音转录失败\n[20:00] Third chunk",
  );
  // The failure marker is still present in the structured transcript array,
  // so callers can locate and render the gap precisely.
  assert.equal(result.transcript[1].failed, true);
});

test("stitchChunks tolerates empty or missing chunk lists", () => {
  const result = speechTranscription.stitchChunks([[], null, undefined]);
  assert.deepEqual(result.transcript, []);
  assert.equal(result.transcriptTextPlain, "");
  assert.equal(result.transcriptTextTimestamped, "");
  assert.equal(result.hasFailures, false);
});

test("allChunksFailed is true only when every chunk is entirely failure records", () => {
  const failed = [speechTranscription.failedChunkRecord(0, 600)];
  const succeeded = speechTranscription.alignChunkSegments(
    { segments: [{ start: 0, end: 1, text: "ok" }] },
    600,
  );

  assert.equal(speechTranscription.allChunksFailed([failed, failed]), true);
  assert.equal(speechTranscription.allChunksFailed([failed, succeeded]), false);
  assert.equal(speechTranscription.allChunksFailed([succeeded]), false);
});

test("allChunksFailed treats an empty or missing chunk list as a total failure", () => {
  assert.equal(speechTranscription.allChunksFailed([]), true);
  assert.equal(speechTranscription.allChunksFailed(null), true);
  // A chunk that produced no records at all (e.g. silent audio) isn't a
  // failure by itself, but it can't count as evidence of success either;
  // treat "no records anywhere" the same as "all failed" so callers don't
  // return a transcript with nothing in it without surfacing an error.
  assert.equal(speechTranscription.allChunksFailed([[]]), true);
});
