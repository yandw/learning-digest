const test = require("node:test");
const assert = require("node:assert/strict");

const sessionPipeline = require("../session-pipeline.js");
const speechTranscription = require("../speech-transcription.js");

test("createSession starts an active Session with empty state", () => {
  const state = sessionPipeline.createSession({ sessionId: "s1" });
  assert.deepEqual(state, {
    sessionId: "s1",
    status: "active",
    segments: [],
    transcriptRecords: [],
    rollingSummary: null,
  });
});

test("segmentCaptured appends a pending Segment", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });

  assert.equal(state.segments.length, 1);
  assert.deepEqual(state.segments[0], {
    id: "seg-1",
    start: 0,
    duration: 120,
    status: "pending",
  });
  assert.equal(state.status, "active");
});

test("transcribeOk marks the Segment done and appends its Transcript records", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "大家好", start: 0, duration: 5, language: "zh" }],
  });

  assert.equal(state.segments[0].status, "done");
  assert.deepEqual(state.transcriptRecords, [
    { text: "大家好", start: 0, duration: 5, language: "zh" },
  ]);
});

test("transcribeFailed marks the Segment failed and annotates the Transcript without touching neighbours", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-2", start: 120, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeFailed",
    segmentId: "seg-2",
  });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-3", start: 240, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-3",
    records: [{ text: "第三段", start: 240, duration: 5 }],
  });

  // The failed Segment is annotated in the Transcript with the same marker
  // vocabulary as speech-transcription.js, covering its time range.
  assert.equal(state.segments[1].status, "failed");
  assert.deepEqual(state.transcriptRecords, [
    { text: "第一段", start: 0, duration: 5 },
    speechTranscription.failedChunkRecord(120, 120),
    { text: "第三段", start: 240, duration: 5 },
  ]);
  // Neighbouring Segments are untouched: still done, records intact.
  assert.equal(state.segments[0].status, "done");
  assert.equal(state.segments[2].status, "done");
});

test("summaryTick keeps only the latest Rolling Summary", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "summaryTick",
    summary: { text: "前三十分钟讲了导论。", coveredUntil: 1800 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "summaryTick",
    summary: { text: "前六十分钟讲了导论和第一章。", coveredUntil: 3600 },
  });

  assert.deepEqual(state.rollingSummary, {
    text: "前六十分钟讲了导论和第一章。",
    coveredUntil: 3600,
  });
});

test("sessionEnd ends the Session and preserves everything captured", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });
  state = sessionPipeline.applyEvent(state, { type: "sessionEnd" });

  assert.equal(state.status, "ended");
  assert.equal(state.segments.length, 1);
  assert.equal(state.transcriptRecords.length, 1);
});

test("a Segment already marked done is never re-transcribed after resume", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });

  // Resuming must not re-submit finished Segments: a duplicate capture is
  // ignored, and a late transcribeOk/transcribeFailed for a done Segment
  // changes nothing.
  const before = state;
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  assert.deepEqual(state, before);

  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "重复计费", start: 0, duration: 5 }],
  });
  assert.deepEqual(state, before);

  state = sessionPipeline.applyEvent(state, {
    type: "transcribeFailed",
    segmentId: "seg-1",
  });
  assert.deepEqual(state, before);
});

test("snapshot round-trips through JSON and resume continues from it", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });
  state = sessionPipeline.applyEvent(state, {
    type: "summaryTick",
    summary: { text: "导论。", coveredUntil: 120 },
  });

  // Serialize as chrome.storage.local would (JSON-plain), then resume.
  const snapshot = JSON.parse(JSON.stringify(state));
  let resumed = sessionPipeline.resumeFromSnapshot(snapshot);
  resumed = sessionPipeline.applyEvent(resumed, {
    type: "segmentCaptured",
    segment: { id: "seg-2", start: 120, duration: 120 },
  });
  resumed = sessionPipeline.applyEvent(resumed, {
    type: "transcribeOk",
    segmentId: "seg-2",
    records: [{ text: "第二段", start: 120, duration: 5 }],
  });

  assert.equal(resumed.segments[0].status, "done");
  assert.deepEqual(resumed.rollingSummary, { text: "导论。", coveredUntil: 120 });
  assert.deepEqual(resumed.transcriptRecords, [
    { text: "第一段", start: 0, duration: 5 },
    { text: "第二段", start: 120, duration: 5 },
  ]);
});

test("a Session run straight through equals one interrupted and resumed from a snapshot", () => {
  const events = [
    { type: "segmentCaptured", segment: { id: "seg-1", start: 0, duration: 120 } },
    { type: "transcribeOk", segmentId: "seg-1", records: [{ text: "第一段", start: 0, duration: 5 }] },
    { type: "segmentCaptured", segment: { id: "seg-2", start: 120, duration: 120 } },
    { type: "transcribeFailed", segmentId: "seg-2" },
    { type: "segmentCaptured", segment: { id: "seg-3", start: 240, duration: 120 } },
    { type: "transcribeOk", segmentId: "seg-3", records: [{ text: "第三段", start: 240, duration: 5 }] },
    { type: "summaryTick", summary: { text: "导论与第一章。", coveredUntil: 360 } },
    { type: "sessionEnd" },
  ];

  let straight = sessionPipeline.createSession({ sessionId: "s1" });
  for (const event of events) straight = sessionPipeline.applyEvent(straight, event);

  // Same events, but snapshotted after the failure and resumed mid-stream.
  let interrupted = sessionPipeline.createSession({ sessionId: "s1" });
  for (const event of events.slice(0, 4)) {
    interrupted = sessionPipeline.applyEvent(interrupted, event);
  }
  interrupted = sessionPipeline.resumeFromSnapshot(
    JSON.parse(JSON.stringify(interrupted)),
  );
  for (const event of events.slice(4)) {
    interrupted = sessionPipeline.applyEvent(interrupted, event);
  }

  assert.deepEqual(interrupted, straight);
});

test("allSegmentsFailed is true only when every Segment failed, and means no Transcript", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  assert.equal(sessionPipeline.allSegmentsFailed(state), false);

  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeFailed",
    segmentId: "seg-1",
  });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-2", start: 120, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeFailed",
    segmentId: "seg-2",
  });

  assert.equal(sessionPipeline.allSegmentsFailed(state), true);
  // The session is treated as having no Transcript: every record is a
  // failure marker, so there is no usable text.
  assert.equal(
    state.transcriptRecords.every((record) => record.failed),
    true,
  );

  // One successful Segment anywhere is enough to make the Transcript real;
  // failed Segments stay annotated alongside it.
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-3", start: 240, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-3",
    records: [{ text: "第三段", start: 240, duration: 5 }],
  });
  assert.equal(sessionPipeline.allSegmentsFailed(state), false);
});

test("assembleSessionDigestInput combines the latest Rolling Summary with the uncovered Transcript tail", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });
  state = sessionPipeline.applyEvent(state, {
    type: "summaryTick",
    summary: { text: "导论。", coveredUntil: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-2", start: 120, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-2",
    records: [{ text: "第二段", start: 120, duration: 5 }],
  });

  const input = sessionPipeline.assembleSessionDigestInput(state);
  assert.deepEqual(input.rollingSummary, { text: "导论。", coveredUntil: 120 });
  assert.deepEqual(input.uncoveredTranscript, [
    { text: "第二段", start: 120, duration: 5 },
  ]);
});

test("applyEvent rejects unknown event types and unknown Segments", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  assert.throws(
    () => sessionPipeline.applyEvent(state, { type: "nonsense" }),
    /Unknown event type/,
  );
  assert.throws(
    () =>
      sessionPipeline.applyEvent(state, {
        type: "transcribeOk",
        segmentId: "missing",
        records: [],
      }),
    /Unknown Segment/,
  );
});

test("settleInterruptedSegments fails orphan pending Segments left by an interrupted worker", () => {
  // A Segment captured but never transcribed when the service worker died
  // mid-flight: resume must settle it as failed (the [语音转录失败] marker
  // record) instead of leaving a pending hole the new segmenter cursor
  // already skipped past.
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-0",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 120, duration: 120 },
  });

  const snapshot = JSON.parse(JSON.stringify(state));
  const resumed = sessionPipeline.resumeFromSnapshot(snapshot);
  const settled = sessionPipeline.settleInterruptedSegments(resumed);

  assert.ok(
    settled.segments.every((segment) => segment.status !== "pending"),
    "a resumed Session has no orphan pending Segments",
  );
  const failed = settled.segments.find((segment) => segment.id === "seg-1");
  assert.equal(failed.status, "failed");
  const marker = settled.transcriptRecords.find(
    (record) => record.failed === true && record.start === 120,
  );
  assert.ok(marker, "the gap carries the visible failure annotation");
  assert.equal(marker.text, "[语音转录失败]");
  assert.equal(marker.duration, 120);
  // The done Segment is untouched: resume never re-settles finished work.
  assert.equal(settled.segments.find((s) => s.id === "seg-0").status, "done");
  assert.equal(settled.transcriptRecords.length, 2);
});

test("settleInterruptedSegments is a no-op when nothing is pending", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-0",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });

  const settled = sessionPipeline.settleInterruptedSegments(state);
  assert.equal(settled, state);
  assert.equal(settled.transcriptRecords.length, 1);
});
