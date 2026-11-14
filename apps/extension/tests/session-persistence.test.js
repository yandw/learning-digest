const test = require("node:test");
const assert = require("node:assert/strict");

const sessionPipeline = require("../session-pipeline.js");
const sessionPersistence = require("../session-persistence.js");

/** Minimal in-memory stand-in for chrome.storage.local. */
function fakeStorage() {
  const data = new Map();
  return {
    async get(key) {
      return Object.fromEntries(
        [key].flat().filter((k) => data.has(k)).map((k) => [k, data.get(k)]),
      );
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    },
    async remove(key) {
      for (const k of [key].flat()) data.delete(k);
    },
    _data: data,
  };
}

test("session snapshots persist per Session and round-trip through storage", async () => {
  const storage = fakeStorage();
  const state = sessionPipeline.createSession({ sessionId: "s1" });

  await sessionPersistence.saveSessionSnapshot(storage, state);
  const loaded = await sessionPersistence.loadSessionSnapshot(storage, "s1");

  assert.deepEqual(loaded, state);
});

test("snapshots are stored under a per-session key", async () => {
  const storage = fakeStorage();
  const s1 = sessionPipeline.createSession({ sessionId: "s1" });
  const s2 = sessionPipeline.createSession({ sessionId: "s2" });

  await sessionPersistence.saveSessionSnapshot(storage, s1);
  await sessionPersistence.saveSessionSnapshot(storage, s2);

  assert.equal(
    storage._data.has(sessionPersistence.sessionStorageKey("s1")),
    true,
  );
  assert.equal(
    storage._data.has(sessionPersistence.sessionStorageKey("s2")),
    true,
  );
  // Sessions don't clobber each other.
  assert.notEqual(
    sessionPersistence.sessionStorageKey("s1"),
    sessionPersistence.sessionStorageKey("s2"),
  );
});

test("an interrupted Session resumes from storage with done Segments never re-transcribed", async () => {
  const storage = fakeStorage();

  // First "tab life": capture two Segments, one transcribed, one still
  // pending when the tab dies.
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
  await sessionPersistence.saveSessionSnapshot(storage, state);

  // Second "tab life": load the snapshot and continue. The browser layer
  // only re-submits Segments still pending; the done Segment's result event
  // replays harmlessly and changes nothing.
  let resumed = sessionPipeline.resumeFromSnapshot(
    await sessionPersistence.loadSessionSnapshot(storage, "s1"),
  );
  resumed = sessionPipeline.applyEvent(resumed, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "重复计费", start: 0, duration: 5 }],
  });
  resumed = sessionPipeline.applyEvent(resumed, {
    type: "transcribeOk",
    segmentId: "seg-2",
    records: [{ text: "第二段", start: 120, duration: 5 }],
  });
  resumed = sessionPipeline.applyEvent(resumed, { type: "sessionEnd" });
  await sessionPersistence.saveSessionSnapshot(storage, resumed);

  const final = await sessionPersistence.loadSessionSnapshot(storage, "s1");
  assert.equal(final.status, "ended");
  assert.deepEqual(
    final.segments.map((segment) => segment.status),
    ["done", "done"],
  );
  // Exactly one Transcript record per Segment: no re-transcription.
  assert.deepEqual(final.transcriptRecords, [
    { text: "第一段", start: 0, duration: 5 },
    { text: "第二段", start: 120, duration: 5 },
  ]);
});

test("loadSessionSnapshot returns null for an unknown Session", async () => {
  const storage = fakeStorage();
  assert.equal(await sessionPersistence.loadSessionSnapshot(storage, "nope"), null);
});

test("deleteSessionSnapshot removes only that Session's state", async () => {
  const storage = fakeStorage();
  await sessionPersistence.saveSessionSnapshot(
    storage,
    sessionPipeline.createSession({ sessionId: "s1" }),
  );
  await sessionPersistence.saveSessionSnapshot(
    storage,
    sessionPipeline.createSession({ sessionId: "s2" }),
  );

  await sessionPersistence.deleteSessionSnapshot(storage, "s1");

  assert.equal(await sessionPersistence.loadSessionSnapshot(storage, "s1"), null);
  assert.notEqual(await sessionPersistence.loadSessionSnapshot(storage, "s2"), null);
});
