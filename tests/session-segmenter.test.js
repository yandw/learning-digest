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
 *
 * The tests pin Segment length to 60s, the top of the supported 5-60
 * range (0.1.61), so every expectation rides the widest legal grid.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createSegmenter } = require("../session-segmenter.js");
const sessionPipeline = require("../session-pipeline.js");
const sessionPersistence = require("../session-persistence.js");

test("no Segment is emitted before one full segment length elapses", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  assert.deepEqual(segmenter.recordPosition(0), []);
  assert.deepEqual(segmenter.recordPosition(30), []);
  assert.deepEqual(segmenter.recordPosition(59.9), []);
  assert.equal(segmenter.emittedUpTo, 0);
});

test("one full Segment is emitted exactly when the position reaches the segment length", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  const segments = segmenter.recordPosition(60);
  assert.deepEqual(segments, [{ index: 0, start: 0, duration: 60 }]);
  assert.equal(segmenter.emittedUpTo, 60);
});

test("a large advance emits every full Segment in order", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  assert.deepEqual(segmenter.recordPosition(0), []);
  const segments = segmenter.recordPosition(150);
  assert.deepEqual(segments, [
    { index: 0, start: 0, duration: 60 },
    { index: 1, start: 60, duration: 60 },
  ]);
  assert.equal(segmenter.emittedUpTo, 120);
});

test("positions are reported per call: a later tick emits only the newly completed Segments", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  segmenter.recordPosition(65);
  const second = segmenter.recordPosition(125);
  assert.deepEqual(second, [{ index: 1, start: 60, duration: 60 }]);
});

test("a paused stream emits nothing while the position stands still", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  assert.deepEqual(segmenter.recordPosition(150), [
    { index: 0, start: 0, duration: 60 },
    { index: 1, start: 60, duration: 60 },
  ]);
  // Paused for a long wall-clock stretch: no position advance, no Segment.
  assert.deepEqual(segmenter.recordPosition(150), []);
  assert.deepEqual(segmenter.recordPosition(151), []);
});

test("a backward seek is ignored and never re-emits Segments", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  segmenter.recordPosition(125);
  assert.deepEqual(segmenter.recordPosition(30), []);
  assert.equal(segmenter.emittedUpTo, 120);
  // Playback continues from the seek target without double-emitting.
  assert.deepEqual(segmenter.recordPosition(180), [
    { index: 2, start: 120, duration: 60 },
  ]);
});

test("mid-video startAt seeds the cursor so the skipped head never backfills", () => {
  // #48: a Session anchored to a video already well in starts its records
  // there — the range 0 → anchor produces nothing (no D7-style empty
  // backfill of positions that were never played).
  const segmenter = createSegmenter({
    segmentLengthSeconds: 60,
    startAt: 800,
    startIndex: 0,
  });
  assert.deepEqual(segmenter.recordPosition(800), []);
  assert.deepEqual(segmenter.recordPosition(859.9), []);
  assert.deepEqual(segmenter.recordPosition(860.4), [
    { index: 0, start: 800, duration: 60 },
  ]);
  assert.equal(segmenter.emittedUpTo, 860);
  assert.deepEqual(segmenter.flush(865), { index: 1, start: 860, duration: 5 });
});

test("jumpTo seeks the cursor forward without emitting anything for the skipped range", () => {
  // #48 seek-forward: the skipped range emits no Segments (the gap is made
  // visible by the pipeline's gap marker instead), and the next Segment
  // starts at the new position with the post-seek audio.
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  assert.deepEqual(segmenter.recordPosition(30), []);
  segmenter.jumpTo(600);
  assert.equal(segmenter.emittedUpTo, 600);
  // Playback continues from the seek target.
  assert.deepEqual(segmenter.recordPosition(660), [
    { index: 0, start: 600, duration: 60 },
  ]);
  assert.deepEqual(segmenter.flush(665), { index: 1, start: 660, duration: 5 });
});

test("jumpTo never moves the cursor backwards", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  segmenter.recordPosition(150);
  segmenter.jumpTo(100);
  assert.equal(segmenter.emittedUpTo, 120);
  assert.deepEqual(segmenter.recordPosition(180), [
    { index: 2, start: 120, duration: 60 },
  ]);
});

test("flush returns the trailing partial Segment and covers it fully", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  segmenter.recordPosition(90);
  assert.deepEqual(segmenter.flush(90), { index: 1, start: 60, duration: 30 });
  assert.equal(segmenter.emittedUpTo, 90);
});

test("flush at an exact boundary has nothing trailing", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  segmenter.recordPosition(120);
  assert.equal(segmenter.flush(120), null);
});

test("flush drops an inaudible tail shorter than minSegmentSeconds", () => {
  const segmenter = createSegmenter({ segmentLengthSeconds: 60, minSegmentSeconds: 5 });
  segmenter.recordPosition(61);
  assert.equal(segmenter.flush(61), null);
  // A tail just above the floor is kept.
  const other = createSegmenter({ segmentLengthSeconds: 60, minSegmentSeconds: 5 });
  other.recordPosition(66);
  assert.deepEqual(other.flush(66), { index: 1, start: 60, duration: 6 });
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
  const segmenter = createSegmenter({ segmentLengthSeconds: 60 });
  assert.deepEqual(segmenter.recordPosition(120.7), [
    { index: 0, start: 0, duration: 60 },
    { index: 1, start: 60, duration: 60 },
  ]);
  assert.deepEqual(segmenter.flush(125.9), { index: 2, start: 120, duration: 5 });
});

test("a resumed Segmenter continues where the Session left off", () => {
  const segmenter = createSegmenter({
    segmentLengthSeconds: 60,
    startAt: 120,
    startIndex: 2,
  });
  assert.deepEqual(segmenter.recordPosition(180), [
    { index: 2, start: 120, duration: 60 },
  ]);
});

test("resume equivalence: interrupted and straight-through Sessions converge to identical state", async () => {
  const positions = [0, 30, 65, 125, 150];
  const segmentLength = 60;
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

  // Two tab lives: interrupt after the third report (Segment 0 captured and
  // transcribed), persist, resume from the snapshot with a fresh Segmenter
  // positioned at the persisted cursor, then finish the Session.
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
  actual = transcribe(actual, { index: 0, duration: 60 });

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
