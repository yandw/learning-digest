/**
 * Segment scheduler: pure timing math that turns a position stream into
 * Segments ready for transcription.
 *
 * Seam: the public factory createSegmenter. The scheduler is fed either
 * wall-clock elapsed seconds (live) or media position seconds (replay).
 * It never knows which — that is the Source Platform's timestampKind.
 *
 * Also covers resume equivalence end to end: a two-"tab life" capture
 * (interrupt, persist, resume, continue) must converge to exactly the
 * same Session state as an uninterrupted one, with every Segment
 * transcribed exactly once.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createSegmenter } = require("../session-segmenter.js");
const sessionPipeline = require("../session-pipeline.js");
const sessionPersistence = require("../session-persistence.js");

test("no Segment is emitted before one full segment length elapses", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  assert.deepEqual(segmenter.recordPosition(0), []);
  assert.deepEqual(segmenter.recordPosition(60), []);
  assert.deepEqual(segmenter.recordPosition(119.9), []);
  assert.equal(segmenter.emittedUpTo, 0);
});

test("one full Segment is emitted exactly when the position reaches the segment length", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  const segments = segmenter.recordPosition(120);
  assert.deepEqual(segments, [{ index: 0, start: 0, duration: 120 }]);
  assert.equal(segmenter.emittedUpTo, 120);
});

test("a large advance emits every full Segment in order", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  assert.deepEqual(segmenter.recordPosition(0), []);
  const segments = segmenter.recordPosition(300);
  assert.deepEqual(segments, [
    { index: 0, start: 0, duration: 120 },
    { index: 1, start: 120, duration: 120 },
  ]);
  assert.equal(segmenter.emittedUpTo, 240);
});

test("positions are reported per call: a later tick emits only the newly completed Segments", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  segmenter.recordPosition(130);
  const second = segmenter.recordPosition(250);
  assert.deepEqual(second, [{ index: 1, start: 120, duration: 120 }]);
});

test("a paused stream emits nothing while the position stands still", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  assert.deepEqual(segmenter.recordPosition(300), [
    { index: 0, start: 0, duration: 120 },
    { index: 1, start: 120, duration: 120 },
  ]);
  // Paused for a long wall-clock stretch: no position advance, no Segment.
  assert.deepEqual(segmenter.recordPosition(300), []);
  assert.deepEqual(segmenter.recordPosition(301), []);
});

test("a backward seek is ignored and never re-emits Segments", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  segmenter.recordPosition(250);
  assert.deepEqual(segmenter.recordPosition(30), []);
  assert.equal(segmenter.emittedUpTo, 240);
  // Playback continues from the seek target without double-emitting.
  assert.deepEqual(segmenter.recordPosition(360), [
    { index: 2, start: 240, duration: 120 },
  ]);
});

test("flush returns the trailing partial Segment and covers it fully", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  segmenter.recordPosition(150);
  assert.deepEqual(segmenter.flush(150), { index: 1, start: 120, duration: 30 });
  assert.equal(segmenter.emittedUpTo, 150);
});

test("flush at an exact boundary has nothing trailing", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  segmenter.recordPosition(240);
  assert.equal(segmenter.flush(240), null);
});

test("flush drops an inaudible tail shorter than minSegmentSeconds", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120, minSegmentSeconds: 5 });
  segmenter.recordPosition(121);
  assert.equal(segmenter.flush(121), null);
  // A tail just above the floor is kept.
  const other = createSegmenter({ segmentLengthSeconds: 120, minSegmentSeconds: 5 });
  other.recordPosition(126);
  assert.deepEqual(other.flush(126), { index: 1, start: 120, duration: 6 });
});

test("segment length is configurable", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 30 });
  assert.deepEqual(segmenter.recordPosition(95), [
    { index: 0, start: 0, duration: 30 },
    { index: 1, start: 30, duration: 30 },
    { index: 2, start: 60, duration: 30 },
  ]);
});

test("fractional positions are floored to whole-second boundaries", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 120 });
  assert.deepEqual(segmenter.recordPosition(240.7), [
    { index: 0, start: 0, duration: 120 },
    { index: 1, start: 120, duration: 120 },
  ]);
  assert.deepEqual(segmenter.flush(245.9), { index: 2, start: 240, duration: 5 });
});

test("a resumed Segmenter continues where the Session left off", () => {
  const segmenter = createSegmenter({
    segmentLengthSeconds: 120,
    startAt: 240,
    startIndex: 2,
  });
  assert.deepEqual(segmenter.recordPosition(360), [
    { index: 2, start: 240, duration: 120 },
  ]);
});

test("resume equivalence: interrupted and straight-through Sessions converge to identical state", async () => {
  const positions = [0, 60, 130, 250, 300];
  const segmentLength = 120;
  const transcriptFor = (segment) => ({
    type: "transcribeOk",
    segmentId: `seg-${segment.index}`,
    records: [{ text: `text of ${segment.index}`, start: 0, duration: segment.duration }],
  });
  // applyEvent returns the next state (transitions never mutate), so every
  // feed reassigns the Session variable.
  const capture = (state, segment) =>
    sessionPipeline.applyEvent(state, {
      type: "segmentCaptured",
      segment: { id: `seg-${segment.index}`, ...segment },
    });
  const transcribe = (state, segment) =>
    sessionPipeline.applyEvent(state, transcriptFor(segment));

  // Straight-through life: the whole position stream in one process.
  const expected = sessionPipeline.createSession({ sessionId: "s1" });
  let expectedState = expected;
  {
    const segmenter = createSegmenter({ segmentLengthSeconds: segmentLength });
    const emitted = positions.flatMap((position) => segmenter.recordPosition(position));
    const tail = segmenter.flush(positions.at(-1));
    for (const segment of tail ? [...emitted, tail] : emitted) {
      expectedState = capture(expectedState, segment);
      expectedState = transcribe(expectedState, segment);
    }
    expectedState = sessionPipeline.applyEvent(expectedState, { type: "sessionEnd" });
  }

  // Two tab lives: interrupt after 130s (Segment 0 captured and
  // transcribed), persist, resume from the snapshot with a fresh
  // Segmenter positioned at the persisted cursor, then finish the Session.
  const storage = (() => {
    const map = new Map();
    return {
      get: async (key) => (map.has(key) ? { [key]: map.get(key) } : {}),
      set: async (entries) => {
        for (const [k, v] of Object.entries(entries)) map.set(k, v);
      },
      remove: async (key) => void map.delete(key),
    };
  })();

  let actual = sessionPipeline.createSession({ sessionId: "s1" });
  const firstLife = createSegmenter({ segmentLengthSeconds: segmentLength });
  for (const segment of positions
    .slice(0, 3)
    .flatMap((position) => firstLife.recordPosition(position))) {
    actual = capture(actual, segment);
    actual = transcribe(actual, segment);
  }
  await sessionPersistence.saveSessionSnapshot(storage, actual);

  const snapshot = await sessionPersistence.loadSessionSnapshot(storage, "s1");
  actual = sessionPipeline.resumeFromSnapshot(JSON.parse(JSON.stringify(snapshot)));
  // The second life re-delivers Segment 0's transcription result (e.g. the
  // first life's in-flight request finishing late): it must be dropped so
  // a done Segment is never re-transcribed.
  actual = transcribe(actual, { index: 0, duration: 120 });

  const resumeAt = actual.segments.reduce(
    (end, segment) => Math.max(end, segment.start + segment.duration),
    0,
  );
  const secondLife = createSegmenter({
    segmentLengthSeconds: segmentLength,
    startAt: resumeAt,
    startIndex: actual.segments.length,
  });
  const rest = positions
    .slice(3)
    .flatMap((position) => secondLife.recordPosition(position));
  const tail = secondLife.flush(positions.at(-1));
  for (const segment of tail ? [...rest, tail] : rest) {
    actual = capture(actual, segment);
    actual = transcribe(actual, segment);
  }
  actual = sessionPipeline.applyEvent(actual, { type: "sessionEnd" });

  assert.deepEqual(actual, expectedState);
  assert.equal(actual.segments.length, 3);
  assert.equal(actual.transcriptRecords.length, 3);
});
