const test = require("node:test");
const assert = require("node:assert/strict");

const speechTranscription = require("../speech-transcription.js");

// Ticket 2.4 (D10): the local transcription plumbing is retired; what
// remains is the failure-marker shape the Session state machine lands for
// a failed Segment/utterance, the all-failed check, and the shared
// [m:ss] formatter the analysis layer reads.

test("failedSegmentRecord marks the Segment's time range as failed", () => {
  const record = speechTranscription.failedSegmentRecord(600, 600);
  assert.deepEqual(record, {
    text: "[语音转录失败]",
    start: 600,
    duration: 600,
    failed: true,
  });
});

test("allSegmentsFailed is true only when every Segment is entirely failure records", () => {
  const failed = [speechTranscription.failedSegmentRecord(0, 600)];
  const succeeded = [{ text: "ok", start: 600, duration: 1 }];

  assert.equal(speechTranscription.allSegmentsFailed([failed, failed]), true);
  assert.equal(speechTranscription.allSegmentsFailed([failed, succeeded]), false);
  assert.equal(speechTranscription.allSegmentsFailed([succeeded]), false);
});

test("allSegmentsFailed treats an empty or missing Segment list as a total failure", () => {
  assert.equal(speechTranscription.allSegmentsFailed([]), true);
  assert.equal(speechTranscription.allSegmentsFailed(null), true);
  // A Segment that produced no records at all (e.g. silent audio) isn't a
  // failure by itself, but it can't count as evidence of success either;
  // treat "no records anywhere" the same as "all failed" so callers don't
  // return a transcript with nothing in it without surfacing an error.
  assert.equal(speechTranscription.allSegmentsFailed([[]]), true);
});

test("formatTimestamp renders whole seconds as [m:ss]", () => {
  assert.equal(speechTranscription.formatTimestamp(0), "0:00");
  assert.equal(speechTranscription.formatTimestamp(65), "1:05");
  assert.equal(speechTranscription.formatTimestamp(3600), "60:00");
  assert.equal(speechTranscription.formatTimestamp(5.9), "0:05");
  assert.equal(speechTranscription.formatTimestamp(-3), "0:00");
  assert.equal(speechTranscription.formatTimestamp("x"), "0:00");
});

test("the retired transcription helpers are gone (ticket 2.4, D10)", () => {
  for (const retired of [
    "alignChunkSegments",
    "stitchChunks",
    "loadNodeCrypto",
    "bytesToBase64",
    "normalizeRegion",
    "detectCloudAudioFormat",
  ]) {
    assert.equal(speechTranscription[retired], undefined, retired);
  }
});
