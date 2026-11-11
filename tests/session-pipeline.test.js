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
    topics: [],
    transcriptOrigin: null,
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

// --- topicsAppended: the append-only Topic timeline (ADR 0002)

test("topicsAppended appends Topics to the timeline without rewriting earlier ones", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "topicsAppended",
    topics: [{ start: 0, end: 600, title: "导论", text: "课程开场。" }],
  });
  state = sessionPipeline.applyEvent(state, {
    type: "topicsAppended",
    topics: [
      { start: 600, end: 1200, title: "二次函数", text: "讲解了二次函数。" },
      { start: 1200, end: 1500, title: "习题课", text: "做了三道例题。", continuation: true },
    ],
  });

  assert.deepEqual(state.topics, [
    { start: 0, end: 600, title: "导论", text: "课程开场。" },
    { start: 600, end: 1200, title: "二次函数", text: "讲解了二次函数。" },
    { start: 1200, end: 1500, title: "习题课", text: "做了三道例题。", continuation: true },
  ]);
  assert.equal(state.status, "active");
});

test("an empty topicsAppended leaves the state untouched", () => {
  const before = sessionPipeline.createSession({ sessionId: "s1" });
  const after = sessionPipeline.applyEvent(before, {
    type: "topicsAppended",
    topics: [],
  });

  assert.equal(after, before);
  assert.deepEqual(after.topics, []);
});

test("topicsAppended rejects malformed payloads instead of corrupting the timeline", () => {
  const state = sessionPipeline.createSession({ sessionId: "s1" });
  assert.throws(
    () => sessionPipeline.applyEvent(state, { type: "topicsAppended", topics: "导论" }),
    /topicsAppended requires/,
  );
  assert.throws(
    () => sessionPipeline.applyEvent(state, { type: "topicsAppended", topics: [{ start: 0, end: 10 }] }),
    /topicsAppended requires/,
  );
  assert.throws(
    () =>
      sessionPipeline.applyEvent(state, {
        type: "topicsAppended",
        topics: [{ start: 100, end: 50, title: "倒置", text: "end 在 start 之前。" }],
      }),
    /topicsAppended requires/,
  );
  assert.throws(
    () => sessionPipeline.applyEvent(state, { type: "topicsAppended" }),
    /topicsAppended requires/,
  );
  assert.deepEqual(state.topics, []);
});

// --- titleCaptured: the page title for the report header (#32)

test("titleCaptured stores the page title and a later title never overwrites it", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "titleCaptured",
    title: "第十四讲：机器学习入门",
  });
  assert.equal(state.title, "第十四讲：机器学习入门");

  // First write wins: the title captured at Session start stays stable even
  // if the page renames itself later (SPA navigation, countdown suffixes).
  const renamed = sessionPipeline.applyEvent(state, {
    type: "titleCaptured",
    title: "页面跳转后的其他标题",
  });
  assert.equal(renamed, state, "the second title is a no-op on the same state");
  assert.equal(renamed.title, "第十四讲：机器学习入门");
});

test("titleCaptured rejects an empty or non-string title", () => {
  const state = sessionPipeline.createSession({ sessionId: "s1" });
  assert.throws(
    () => sessionPipeline.applyEvent(state, { type: "titleCaptured", title: "" }),
    /titleCaptured requires/,
  );
  assert.throws(
    () => sessionPipeline.applyEvent(state, { type: "titleCaptured", title: 42 }),
    /titleCaptured requires/,
  );
  assert.throws(
    () => sessionPipeline.applyEvent(state, { type: "titleCaptured" }),
    /titleCaptured requires/,
  );
  assert.equal(state.title, undefined);
});

test("a snapshot with a captured title resumes with the title intact; one without stays titleless", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "titleCaptured",
    title: "第十四讲：机器学习入门",
  });

  const resumed = sessionPipeline.resumeFromSnapshot(
    JSON.parse(JSON.stringify(state)),
  );
  assert.equal(resumed.title, "第十四讲：机器学习入门");
  // The resumed Session still accepts events, and the title still wins.
  const renamed = sessionPipeline.applyEvent(resumed, {
    type: "titleCaptured",
    title: "迟到的另一个标题",
  });
  assert.equal(renamed.title, "第十四讲：机器学习入门");

  // Snapshots from before the title capture carry no title at all.
  const bare = sessionPipeline.resumeFromSnapshot(
    JSON.parse(
      JSON.stringify(sessionPipeline.createSession({ sessionId: "s2" })),
    ),
  );
  assert.equal(bare.title, undefined);
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

// --- Seek-gap marker + failed-Segment retry (#48) --------------------------

test("gapSkipped appends one visible gap marker record for the skipped range", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 60,
    duration: 540,
  });

  assert.deepEqual(state.transcriptRecords, [
    { text: "[已跳过 1:00–10:00]", start: 60, duration: 540, failed: true },
  ]);
  // The gap is annotation only: no Segment is invented for audio that was
  // never recorded.
  assert.deepEqual(state.segments, []);
});

test("consecutive gapSkipped ranges merge into ONE marker (0.1.61)", () => {
  // Ten 30s blocks skipped by several small drags (20:00 -> 20:30 -> 21:00)
  // stay a single hole with a single "[已跳过 ...]" row.
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 1200,
    duration: 30,
  });
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 1230,
    duration: 30,
  });
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 1260,
    duration: 60,
  });
  assert.deepEqual(state.transcriptRecords, [
    { text: "[已跳过 20:00–22:00]", start: 1200, duration: 120, failed: true },
  ]);

  // An overlapping repeat drag extends the marker instead of appending.
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 1300,
    duration: 20,
  });
  assert.deepEqual(state.transcriptRecords, [
    { text: "[已跳过 20:00–22:00]", start: 1200, duration: 120, failed: true },
  ]);

  // A hole separated by covered audio stays its own marker.
  state = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "中间的内容",
    start: 1320,
    duration: 60,
  });
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 1380,
    duration: 60,
  });
  assert.deepEqual(
    state.transcriptRecords
      .filter((record) => record.failed === true)
      .map((record) => ({ text: record.text, start: record.start })),
    [
      { text: "[已跳过 20:00–22:00]", start: 1200 },
      { text: "[已跳过 23:00–24:00]", start: 1380 },
    ],
  );
});

test("gapSkipped rejects malformed ranges instead of corrupting the Transcript", () => {
  const state = sessionPipeline.createSession({ sessionId: "s1" });
  for (const bad of [
    { start: -5, duration: 10 },
    { start: 0, duration: 0 },
    { start: 0, duration: -10 },
    { start: Number.NaN, duration: 10 },
  ]) {
    assert.throws(
      () => sessionPipeline.applyEvent(state, { type: "gapSkipped", ...bad }),
      /gapSkipped requires/,
    );
  }
  assert.deepEqual(state.transcriptRecords, []);
});

// --- gapFilled: the hole-fill marker shrink (#48) ---------------------------

// A hole [60, 600] with one first-pass record before it, the shared fixture
// of the gapFilled tests below.
function holeState() {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "开头",
    start: 0,
    duration: 60,
  });
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 60,
    duration: 540,
  });
  return state;
}

test("gapFilled shrinks the marker to the remaining head when the fill starts past it", () => {
  const before = holeState();
  // Playback entered the hole at 5:00 and filled through 7:00: the unfilled
  // remainder is the head [1:00, 5:00], exactly the issue's marker shape.
  const state = sessionPipeline.applyEvent(before, {
    type: "gapFilled",
    filledStart: 300,
    filledEnd: 420,
  });

  assert.deepEqual(state.transcriptRecords, [
    { text: "开头", start: 0, duration: 60 },
    { text: "[已跳过 1:00–5:00]", start: 60, duration: 240, failed: true },
  ]);
  // Transitions never mutate their input (the snapshot contract).
  assert.deepEqual(before.transcriptRecords, [
    { text: "开头", start: 0, duration: 60 },
    { text: "[已跳过 1:00–10:00]", start: 60, duration: 540, failed: true },
  ]);
});

test("gapFilled keeps shrinking the head marker as later fills of the pass land", () => {
  let state = holeState();
  state = sessionPipeline.applyEvent(state, {
    type: "gapFilled",
    filledStart: 300,
    filledEnd: 420,
  });
  // The next fill starts exactly at the shrunk marker's end: the head
  // remainder is unchanged, and the marker never covers fill records.
  state = sessionPipeline.applyEvent(state, {
    type: "gapFilled",
    filledStart: 300,
    filledEnd: 540,
  });
  assert.deepEqual(state.transcriptRecords, [
    { text: "开头", start: 0, duration: 60 },
    { text: "[已跳过 1:00–5:00]", start: 60, duration: 240, failed: true },
  ]);
});

test("gapFilled advances the marker's tail while the fill consumes it from the head", () => {
  let state = holeState();
  // Playback entered the hole at its very start (1:00): the head is gone,
  // so the marker's start moves to the fill frontier after each fill.
  state = sessionPipeline.applyEvent(state, {
    type: "gapFilled",
    filledStart: 60,
    filledEnd: 180,
  });
  assert.deepEqual(state.transcriptRecords, [
    { text: "开头", start: 0, duration: 60 },
    { text: "[已跳过 3:00–10:00]", start: 180, duration: 420, failed: true },
  ]);
  state = sessionPipeline.applyEvent(state, {
    type: "gapFilled",
    filledStart: 60,
    filledEnd: 300,
  });
  assert.deepEqual(state.transcriptRecords, [
    { text: "开头", start: 0, duration: 60 },
    { text: "[已跳过 5:00–10:00]", start: 300, duration: 300, failed: true },
  ]);
});

test("gapFilled removes the marker once the fill covers the whole hole", () => {
  let state = holeState();
  // Filled from the head through the hole's end: no marker survives.
  state = sessionPipeline.applyEvent(state, {
    type: "gapFilled",
    filledStart: 60,
    filledEnd: 600,
  });
  assert.deepEqual(state.transcriptRecords, [
    { text: "开头", start: 0, duration: 60 },
  ]);

  // A one-fill hole (entry at the head, fill reaching the end) is removed
  // by its single event.
  let short = sessionPipeline.createSession({ sessionId: "s1" });
  short = sessionPipeline.applyEvent(short, {
    type: "gapSkipped",
    start: 60,
    duration: 120,
  });
  short = sessionPipeline.applyEvent(short, {
    type: "gapFilled",
    filledStart: 60,
    filledEnd: 180,
  });
  assert.deepEqual(short.transcriptRecords, []);
});

test("gapFilled picks the covering marker when several holes are on the timeline", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  // 0.1.61: adjacent gap ranges MERGE into one marker, so these two holes
  // keep a covered stretch between them (540..600) to stay distinct holes.
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 60,
    duration: 480,
  });
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 600,
    duration: 600,
  });
  // The fill of the second hole must shrink the second marker, not the
  // first (whose range ends well before the fill's start).
  state = sessionPipeline.applyEvent(state, {
    type: "gapFilled",
    filledStart: 600,
    filledEnd: 720,
  });
  assert.deepEqual(state.transcriptRecords, [
    { text: "[已跳过 1:00–9:00]", start: 60, duration: 480, failed: true },
    { text: "[已跳过 12:00–20:00]", start: 720, duration: 480, failed: true },
  ]);
});

test("gapFilled rejects malformed ranges and a missing covering marker", () => {
  const state = holeState();
  for (const bad of [
    { filledStart: -5, filledEnd: 10 },
    { filledStart: 100, filledEnd: 100 },
    { filledStart: 100, filledEnd: 90 },
    { filledStart: Number.NaN, filledEnd: 200 },
  ]) {
    assert.throws(
      () => sessionPipeline.applyEvent(state, { type: "gapFilled", ...bad }),
      /gapFilled requires/,
    );
  }
  // No marker covers [2000, 2100] — the background only emits gapFilled for
  // a range derived from a live marker, so a miss is corruption.
  assert.throws(
    () =>
      sessionPipeline.applyEvent(state, {
        type: "gapFilled",
        filledStart: 2000,
        filledEnd: 2100,
      }),
    /covering gapSkipped marker/,
  );
  assert.deepEqual(state.transcriptRecords, [
    { text: "开头", start: 0, duration: 60 },
    { text: "[已跳过 1:00–10:00]", start: 60, duration: 540, failed: true },
  ]);
});

// --- utteranceCaptured: realtime utterances are plain Transcript records (#47)

test("utteranceCaptured appends one Transcript record without creating a Segment", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "大家好，我们开始上课。",
    start: 12.5,
    duration: 5.5,
  });

  assert.deepEqual(state.transcriptRecords, [
    { text: "大家好，我们开始上课。", start: 12.5, duration: 5.5 },
  ]);
  // Realtime has no Segments: the record goes straight into the timeline.
  assert.deepEqual(state.segments, []);
  assert.equal(state.status, "active");
});

test("utteranceCaptured with failed:true appends a failure-marker record", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "[实时转写失败]",
    start: 30,
    duration: 4,
    failed: true,
  });

  // Same shape as the segment path's failureChunkRecord records: the
  // failed flag alone drives the panel's failure styling and the
  // allSegmentsFailed "no real transcript" check.
  assert.deepEqual(state.transcriptRecords, [
    { text: "[实时转写失败]", start: 30, duration: 4, failed: true },
  ]);
  assert.deepEqual(state.segments, []);

  // Without the flag the record stays plain (the normal utterance path).
  state = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "一句正常的话。",
    start: 40,
    duration: 5,
  });
  assert.deepEqual(state.transcriptRecords[1], {
    text: "一句正常的话。",
    start: 40,
    duration: 5,
  });
});

test("utteranceCaptured is a no-op on empty text or non-finite timing", () => {
  const state = sessionPipeline.createSession({ sessionId: "s1" });

  // The events arrive unsolicited from the ASR server, so a malformed one
  // is ignored — never an error that could crash the Session.
  const empty = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "   ",
    start: 0,
    duration: 1,
  });
  assert.equal(empty, state, "a whitespace-only utterance is ignored");

  const noText = sessionPipeline.applyEvent(state, { type: "utteranceCaptured" });
  assert.equal(noText, state, "a missing text is ignored");

  const badStart = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "大家好",
    start: Number.NaN,
    duration: 1,
  });
  assert.equal(badStart, state, "a non-finite start is ignored");

  const badDuration = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "大家好",
    start: 0,
    duration: "五秒",
  });
  assert.equal(badDuration, state, "a non-finite duration is ignored");

  assert.deepEqual(state.transcriptRecords, []);
});

test("utterance records ride a snapshot round-trip like segment records", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "第一句。",
    start: 0,
    duration: 3.2,
  });
  state = sessionPipeline.applyEvent(state, {
    type: "utteranceCaptured",
    text: "第二句。",
    start: 5,
    duration: 4.4,
  });

  const resumed = sessionPipeline.resumeFromSnapshot(
    JSON.parse(JSON.stringify(state)),
  );

  // The records live in the same transcriptRecords field, so resume carries
  // them for free and the Session keeps feeding events from there.
  assert.deepEqual(resumed.transcriptRecords, [
    { text: "第一句。", start: 0, duration: 3.2 },
    { text: "第二句。", start: 5, duration: 4.4 },
  ]);
});

test("transcribeOk on a failed Segment replaces its marker with the retry records exactly once", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, { type: "transcribeFailed", segmentId: "seg-1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-2", start: 120, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-2",
    records: [{ text: "第二段", start: 120, duration: 5 }],
  });

  // Plan A (#48): re-listening over the failed range retries exactly that
  // Segment; the re-watched records take the marker's place in the timeline.
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "重听第一段", start: 0, duration: 120 }],
  });

  assert.equal(state.segments[0].status, "done");
  assert.deepEqual(state.transcriptRecords, [
    { text: "重听第一段", start: 0, duration: 120 },
    { text: "第二段", start: 120, duration: 5 },
  ]);

  // A second result for the same Segment settles nothing further: the
  // replacement happens exactly once, no duplicate rows.
  const after = state;
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "重复", start: 0, duration: 120 }],
  });
  assert.equal(state, after);
});

test("a failed retry leaves the original marker in place", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, { type: "transcribeFailed", segmentId: "seg-1" });

  // The re-watched audio failed to transcribe too: settleSegment drops the
  // late failure, and the visible [语音转录失败] marker stays.
  state = sessionPipeline.applyEvent(state, { type: "transcribeFailed", segmentId: "seg-1" });
  assert.equal(state.segments[0].status, "failed");
  assert.deepEqual(state.transcriptRecords, [
    speechTranscription.failedChunkRecord(0, 120),
  ]);
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
    type: "topicsAppended",
    topics: [{ start: 0, end: 120, title: "导论", text: "第一段的总结。" }],
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
  resumed = sessionPipeline.applyEvent(resumed, {
    type: "topicsAppended",
    topics: [
      { start: 120, end: 240, title: "第二章", text: "第二段的总结。", continuation: true },
    ],
  });

  assert.equal(resumed.segments[0].status, "done");
  // Appending continues from the persisted timeline: nothing rewritten.
  assert.deepEqual(resumed.topics, [
    { start: 0, end: 120, title: "导论", text: "第一段的总结。" },
    { start: 120, end: 240, title: "第二章", text: "第二段的总结。", continuation: true },
  ]);
  assert.deepEqual(resumed.transcriptRecords, [
    { text: "第一段", start: 0, duration: 5 },
    { text: "第二段", start: 120, duration: 5 },
  ]);
});

test("an old snapshot without Topics resumes with an empty timeline", () => {
  // Snapshots persisted before the Topic timeline carry rollingSummary
  // instead of topics; resume must ignore the retired field and start the
  // timeline empty.
  const oldSnapshot = {
    sessionId: "s_old",
    status: "active",
    segments: [{ id: "seg-1", start: 0, duration: 120, status: "done" }],
    transcriptRecords: [{ text: "第一段", start: 0, duration: 5 }],
    rollingSummary: { text: "旧的滚动摘要。", coveredUntil: 120 },
  };

  const resumed = sessionPipeline.resumeFromSnapshot(
    JSON.parse(JSON.stringify(oldSnapshot)),
  );

  assert.deepEqual(resumed.topics, []);
  assert.equal(resumed.rollingSummary, undefined);
  // And the resumed state accepts new Topics right away.
  const appended = sessionPipeline.applyEvent(resumed, {
    type: "topicsAppended",
    topics: [{ start: 0, end: 120, title: "导论", text: "新时间轴的第一段。" }],
  });
  assert.deepEqual(appended.topics, [
    { start: 0, end: 120, title: "导论", text: "新时间轴的第一段。" },
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
    { type: "topicsAppended", topics: [{ start: 0, end: 360, title: "导论与第一章", text: "总结了前三段。" }] },
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

// --- transcriptViewUpdated (ticket 2.4, issue #67) ------------------------------
//
// The ASR path's view sync: the polled server TranscriptView lands as
// MAPPED rows (session-archive.js's view→row mappers run in the background
// before the event) — text rows plus failed segments' 契约文案 failure rows,
// and the transcribing Segments as pending rows. The replacement keeps the
// plugin-local failed:true annotations (seek-gap markers, upload-failure
// markers) the server view cannot see.

test("transcriptViewUpdated lands mapped rows and pending segments on the state", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "transcriptViewUpdated",
    origin: "asr",
    records: [
      { start: 30, duration: 30, text: "第二段" },
      { start: 0, duration: 30, text: "第一段" },
      { start: 60, duration: 30, failed: true, text: "[Speech Provider 返回 429，重试后仍失败]" },
    ],
    pendingSegments: [
      { id: "srv_2", start: 90, duration: 30, status: "pending" },
    ],
  });
  assert.equal(state.transcriptOrigin, "asr");
  assert.deepEqual(
    state.transcriptRecords.map((record) => record.text),
    ["第一段", "第二段", "[Speech Provider 返回 429，重试后仍失败]"],
    "rows sort by start; the failed row rides the server message verbatim",
  );
  assert.deepEqual(state.pendingSegments, [
    { id: "srv_2", start: 90, duration: 30, status: "pending" },
  ]);
});

test("transcriptViewUpdated replaces server rows but keeps local seek-gap markers", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 120,
    duration: 30,
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcriptViewUpdated",
    origin: "asr",
    records: [{ start: 0, duration: 30, text: "第一段" }],
    pendingSegments: [],
  });
  assert.deepEqual(
    state.transcriptRecords.map((record) => record.text),
    ["第一段", "[已跳过 2:00–2:30]"],
    "the server view replaces rows; the local #48 marker rides through",
  );

  // A later poll replaces again without duplicating the marker.
  state = sessionPipeline.applyEvent(state, {
    type: "transcriptViewUpdated",
    origin: "asr",
    records: [
      { start: 0, duration: 30, text: "第一段" },
      { start: 30, duration: 30, text: "第二段" },
    ],
    pendingSegments: [],
  });
  assert.deepEqual(
    state.transcriptRecords.map((record) => record.text),
    ["第一段", "第二段", "[已跳过 2:00–2:30]"],
  );
});

test("a transcriptViewUpdated without the mapped arrays is rejected", () => {
  const state = sessionPipeline.createSession({ sessionId: "s1" });
  assert.throws(() =>
    sessionPipeline.applyEvent(state, { type: "transcriptViewUpdated" }),
  );
  assert.throws(() =>
    sessionPipeline.applyEvent(state, {
      type: "transcriptViewUpdated",
      records: "nope",
      pendingSegments: [],
    }),
  );
});

test("pendingSegments survive a resume until the next poll corrects them", () => {
  let state = sessionPipeline.createSession({ sessionId: "s1" });
  state = sessionPipeline.applyEvent(state, {
    type: "transcriptViewUpdated",
    origin: "asr",
    records: [],
    pendingSegments: [{ id: "srv_0", start: 0, duration: 30, status: "pending" }],
  });
  const resumed = sessionPipeline.resumeFromSnapshot(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(resumed.pendingSegments, [
    { id: "srv_0", start: 0, duration: 30, status: "pending" },
  ]);
  // Snapshots from before the pipeline carried none — resume stays clean.
  const legacy = sessionPipeline.resumeFromSnapshot({
    sessionId: "s1",
    status: "active",
    segments: [],
    transcriptRecords: [],
    topics: [],
  });
  assert.equal(legacy.pendingSegments, undefined);
});
