const test = require("node:test");
const assert = require("node:assert/strict");

const sessionPipeline = require("../session-pipeline.js");
const sessionTimeline = require("../session-timeline.js");

function stateWith(records, segments = []) {
  const state = sessionPipeline.createSession({ sessionId: "s1" });
  state.transcriptRecords = records;
  state.segments = segments;
  return state;
}

test("orderedTranscriptEntries sorts by record.start, stable on ties", () => {
  const state = stateWith([
    { text: "later", start: 40, duration: 5 },
    { text: "early-a", start: 10, duration: 5 },
    { text: "early-b", start: 10, duration: 3 },
  ]);

  const entries = sessionTimeline.orderedTranscriptEntries(state);

  assert.deepEqual(
    entries.map((entry) => entry.record.text),
    ["early-a", "early-b", "later"],
  );
  // Stable order preserved the original indices for the two 10s records.
  assert.deepEqual(
    entries.map((entry) => entry.index),
    [1, 2, 0],
  );
});

test("orderedTranscriptRecords returns just the sorted records", () => {
  const state = stateWith([
    { text: "b", start: 20, duration: 5 },
    { text: "a", start: 5, duration: 5 },
  ]);

  assert.deepEqual(
    sessionTimeline.orderedTranscriptRecords(state).map((record) => record.text),
    ["a", "b"],
  );
});

test("empty and malformed states never throw", () => {
  assert.deepEqual(sessionTimeline.orderedTranscriptEntries(null), []);
  assert.deepEqual(sessionTimeline.orderedTranscriptRecords({}), []);
  const view = sessionTimeline.buildTimelineView(undefined);
  assert.deepEqual(view.covered, []);
  assert.deepEqual(view.holes, []);
  assert.deepEqual(view.failed, []);
  assert.equal(sessionTimeline.isCoveredAt(view, 12), false);
  assert.equal(sessionTimeline.nextCaptureStart(view, 12), 12);
});

test("done segments cover their range even with no words", () => {
  const state = stateWith([], [
    { id: "seg-1", start: 0, duration: 120, status: "done" },
  ]);

  const view = sessionTimeline.buildTimelineView(state);

  assert.deepEqual(view.covered, [{ start: 0, end: 120 }]);
  assert.equal(sessionTimeline.isCoveredAt(view, 60), true);
  assert.equal(sessionTimeline.isCoveredAt(view, 121), false);
});

test("gap markers become holes, not coverage", () => {
  const state = sessionPipeline.createSession({ sessionId: "s1" });
  let next = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 0, duration: 120 },
  });
  next = sessionPipeline.applyEvent(next, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "hello", start: 0, duration: 10 }],
  });
  next = sessionPipeline.applyEvent(next, {
    type: "gapSkipped",
    start: 20,
    duration: 20,
  });

  const view = sessionTimeline.buildTimelineView(next);

  assert.deepEqual(view.holes, [{ start: 20, end: 40 }]);
  // The hole is cut out of the segment's coverage.
  assert.deepEqual(view.covered, [
    { start: 0, end: 20 },
    { start: 40, end: 120 },
  ]);
  assert.equal(sessionTimeline.isCoveredAt(view, 30), false);
});

test("failed segments and failed records become failure intervals", () => {
  const state = stateWith(
    [{ text: "[语音转录失败]", start: 50, duration: 10, failed: true }],
    [{ id: "seg-1", start: 0, duration: 10, status: "failed" }],
  );

  const view = sessionTimeline.buildTimelineView(state);

  assert.deepEqual(view.failed, [
    { start: 0, end: 10 },
    { start: 50, end: 60 },
  ]);
  assert.equal(sessionTimeline.isCoveredAt(view, 5), false);
  assert.equal(sessionTimeline.isCoveredAt(view, 55), false);
});

test("failures and holes win over overlapping successes", () => {
  const state = stateWith(
    [
      { text: "stale success", start: 20, duration: 20 },
      { text: "[已跳过 20s–40s]", start: 20, duration: 20, failed: true },
    ],
    [],
  );

  const view = sessionTimeline.buildTimelineView(state);

  assert.equal(sessionTimeline.isCoveredAt(view, 30), false);
  assert.deepEqual(view.holes, [{ start: 20, end: 40 }]);
});

test("playbackWindows cover silent realtime ranges", () => {
  const view = sessionTimeline.buildTimelineView(
    sessionPipeline.createSession({ sessionId: "s1" }),
    [{ start: 10, end: 25 }],
  );

  assert.deepEqual(view.covered, [{ start: 10, end: 25 }]);
  assert.equal(sessionTimeline.isCoveredAt(view, 17), true);
});

test("playbackWindows accept duration instead of end", () => {
  const view = sessionTimeline.buildTimelineView(
    sessionPipeline.createSession({ sessionId: "s1" }),
    [{ start: 10, duration: 5 }],
  );

  assert.deepEqual(view.covered, [{ start: 10, end: 15 }]);
});

test("nextCaptureStart captures from the landing point inside a hole", () => {
  const state = sessionPipeline.createSession({ sessionId: "s1" });
  let next = sessionPipeline.applyEvent(state, {
    type: "gapSkipped",
    start: 20,
    duration: 20,
  });

  const view = sessionTimeline.buildTimelineView(next);

  // Live audio can only be captured from where playback actually is: the
  // hole keeps its [20, 30) head and the fill starts at the landing point.
  assert.equal(sessionTimeline.nextCaptureStart(view, 30), 30);
  assert.equal(sessionTimeline.nextCaptureStart(view, 35), 35);
});

test("nextCaptureStart skips covered audio to the run's end", () => {
  const view = sessionTimeline.buildTimelineView(
    stateWith([], [{ id: "seg-1", start: 0, duration: 120, status: "done" }]),
  );

  assert.equal(sessionTimeline.nextCaptureStart(view, 45), 120);
  assert.equal(sessionTimeline.nextCaptureStart(view, 120), 120);
});

test("nextCaptureStart keeps uncaptured positions as-is", () => {
  const view = sessionTimeline.buildTimelineView(
    stateWith([], [{ id: "seg-1", start: 0, duration: 10, status: "done" }]),
  );

  assert.equal(sessionTimeline.nextCaptureStart(view, 30), 30);
});

test("adjacent covered runs merge, blockers punch holes through them", () => {
  const state = stateWith(
    [],
    [
      { id: "seg-1", start: 0, duration: 60, status: "done" },
      { id: "seg-2", start: 60, duration: 60, status: "done" },
      { id: "seg-3", start: 80, duration: 10, status: "failed" },
    ],
  );

  const view = sessionTimeline.buildTimelineView(state);

  assert.deepEqual(view.covered, [
    { start: 0, end: 80 },
    { start: 90, end: 120 },
  ]);
  assert.deepEqual(view.failed, [{ start: 80, end: 90 }]);
  assert.equal(sessionTimeline.nextCaptureStart(view, 50), 80);
  // Inside the failure interval, capture resumes at the landing point.
  assert.equal(sessionTimeline.nextCaptureStart(view, 85), 85);
});

test("view entries reflect the sorted timeline, not arrival order", () => {
  const state = stateWith([
    { text: "40s", start: 40, duration: 5 },
    { text: "30s", start: 30, duration: 5 },
  ]);

  const view = sessionTimeline.buildTimelineView(state);

  assert.deepEqual(
    view.entries.map((entry) => entry.record.text),
    ["30s", "40s"],
  );
});
