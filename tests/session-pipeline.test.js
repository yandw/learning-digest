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
