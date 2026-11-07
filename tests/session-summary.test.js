const test = require("node:test");
const assert = require("node:assert/strict");

const summary = require("../session-summary.js");
const pipeline = require("../session-pipeline.js");

function activeSessionWithRecords(records, rollingSummary = null) {
  let state = pipeline.createSession({ sessionId: "s_test" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-0",
    records,
  });
  if (rollingSummary) {
    state = pipeline.applyEvent(state, {
      type: "summaryTick",
      summary: rollingSummary,
    });
  }
  return state;
}

test("with no Rolling Summary yet, every Transcript record is new input", () => {
  const state = activeSessionWithRecords([
    { text: "first", start: 0, duration: 60 },
    { text: "second", start: 60, duration: 60 },
  ]);

  const input = summary.assembleRollingSummaryInput(state);

  assert.equal(input.previousSummary, null);
  assert.equal(input.coveredUntil, 0);
  assert.deepEqual(
    input.newTranscript.map((record) => record.text),
    ["first", "second"],
  );
});

test("with a Rolling Summary, only Transcript at or after coveredUntil is new input", () => {
  const state = activeSessionWithRecords(
    [
      { text: "old", start: 0, duration: 60 },
      { text: "boundary", start: 120, duration: 60 },
      { text: "new", start: 180, duration: 60 },
    ],
    { text: "Summary of the first block.", coveredUntil: 120 },
  );

  const input = summary.assembleRollingSummaryInput(state);

  assert.equal(input.previousSummary, "Summary of the first block.");
  assert.equal(input.coveredUntil, 120);
  assert.deepEqual(
    input.newTranscript.map((record) => record.text),
    ["boundary", "new"],
  );
});

test("failure-marker records inside the new window stay in the summary input", () => {
  let state = pipeline.createSession({ sessionId: "s_markers" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, { type: "transcribeFailed", segmentId: "seg-0" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 120, duration: 120 },
  });
  state = pipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "after the gap", start: 120, duration: 120 }],
  });

  const input = summary.assembleRollingSummaryInput(state);

  assert.equal(input.newTranscript.length, 2);
  assert.equal(input.newTranscript[0].failed, true);
  assert.equal(input.newTranscript[1].text, "after the gap");
});

test("coveredUntilFor returns the timeline end of the summarized records", () => {
  assert.equal(summary.coveredUntilFor([]), 0);
  assert.equal(
    summary.coveredUntilFor([
      { text: "a", start: 0, duration: 60 },
      { text: "b", start: 60, duration: 90 },
    ]),
    150,
  );
});

test("a summary is due only when the interval elapsed AND new Transcript exists", () => {
  const intervalMs = 30 * 60 * 1000;

  assert.equal(
    summary.isSummaryDue({
      nowMs: intervalMs,
      lastSummaryAtMs: 0,
      intervalMinutes: 30,
      hasNewTranscript: true,
    }),
    true,
  );
  assert.equal(
    summary.isSummaryDue({
      nowMs: intervalMs - 1,
      lastSummaryAtMs: 0,
      intervalMinutes: 30,
      hasNewTranscript: true,
    }),
    false,
  );
  assert.equal(
    summary.isSummaryDue({
      nowMs: intervalMs * 3,
      lastSummaryAtMs: 0,
      intervalMinutes: 30,
      hasNewTranscript: false,
    }),
    false,
  );
});

test("isSummaryDue reports true exactly at the interval boundary", () => {
  assert.equal(
    summary.isSummaryDue({
      nowMs: 5 * 60 * 1000,
      lastSummaryAtMs: 0,
      intervalMinutes: 5,
      hasNewTranscript: true,
    }),
    true,
  );
});

test("Transcript formatting stamps records as [m:ss] lines", () => {
  const text = summary.formatTranscriptForPrompt([
    { text: "welcome", start: 0, duration: 30 },
    { text: "middle", start: 65, duration: 30 },
    { text: "late", start: 3661, duration: 30 },
  ]);

  assert.equal(text, "[0:00] welcome\n[1:05] middle\n[61:01] late");
});

test("Rolling Summary prompt folds the previous summary and the new Transcript", () => {
  const messages = summary.buildRollingSummaryMessages({
    previousSummary: "Earlier we covered algebra basics.",
    newTranscriptText: "[30:00] Now we move to quadratic equations",
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /Earlier we covered algebra basics\./);
  assert.match(messages[1].content, /\[30:00\] Now we move to quadratic equations/);
});

test("first Rolling Summary tick states there is no previous summary", () => {
  const messages = summary.buildRollingSummaryMessages({
    previousSummary: null,
    newTranscriptText: "[0:00] Course opening",
  });

  assert.match(messages[1].content, /no previous summary/i);
  assert.doesNotMatch(messages[1].content, /Previous rolling summary:/);
});

test("Session Digest prompt merges the Rolling Summary with the uncovered tail", () => {
  const messages = summary.buildSessionDigestMessages({
    rollingSummaryText: "Summary of the first two hours.",
    uncoveredTranscriptText: "[120:00] Final wrap-up and Q&A",
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[1].content, /Summary of the first two hours\./);
  assert.match(messages[1].content, /\[120:00\] Final wrap-up and Q&A/);
});

test("Session Digest without a Rolling Summary covers the full Transcript", () => {
  const messages = summary.buildSessionDigestMessages({
    rollingSummaryText: null,
    uncoveredTranscriptText: "[0:00] The whole lesson",
  });

  assert.match(messages[1].content, /no rolling summary/i);
  assert.doesNotMatch(messages[1].content, /Rolling summary so far:/);
});


// Background glue for the Session Digest, exercised through the same VM seam
// translation.test.js uses for requestAiCompletion, with fetch mocked at the
// boundary and the real state machine + assembly module injected.
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

function endedSession({ records, rollingSummary = null }) {
  let state = pipeline.createSession({ sessionId: "s_digest" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, { type: "transcribeOk", segmentId: "seg-0", records });
  if (rollingSummary) {
    state = pipeline.applyEvent(state, {
      type: "summaryTick",
      summary: rollingSummary,
    });
  }
  return pipeline.applyEvent(state, { type: "sessionEnd" });
}

function mockedAiFetch(capturedRequests, content = "DIGEST-TEXT") {
  return async (_url, options) => {
    capturedRequests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
}

test("background Session Digest calls the AI Provider with the assembled tail", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({ fetchImpl: mockedAiFetch(requests) });
  const state = endedSession({
    records: [
      { text: "covered part", start: 0, duration: 60 },
      { text: "uncovered part", start: 60, duration: 60 },
    ],
    rollingSummary: { text: "Summary so far.", coveredUntil: 60 },
  });

  const digest = await helpers.generateSessionDigest(state);

  assert.equal(digest.text, "DIGEST-TEXT");
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[1].content, /Summary so far\./);
  assert.match(requests[0].messages[1].content, /\[1:00\] uncovered part/);
  assert.doesNotMatch(requests[0].messages[1].content, /\[0:00\] covered part/);
});

test("background Session Digest reuses the Rolling Summary when nothing is uncovered", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({ fetchImpl: mockedAiFetch(requests) });
  const state = endedSession({
    records: [{ text: "only part", start: 0, duration: 60 }],
    rollingSummary: { text: "Already complete.", coveredUntil: 60 },
  });

  const digest = await helpers.generateSessionDigest(state);

  assert.equal(digest.text, "Already complete.");
  assert.equal(requests.length, 0);
});

test("background Session Digest is skipped when the Session has no Transcript", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({ fetchImpl: mockedAiFetch(requests) });
  let state = pipeline.createSession({ sessionId: "s_empty" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, { type: "transcribeFailed", segmentId: "seg-0" });
  state = pipeline.applyEvent(state, { type: "sessionEnd" });

  const digest = await helpers.generateSessionDigest(state);

  assert.equal(digest.text, null);
  assert.equal(digest.skipped, "noTranscript");
  assert.equal(requests.length, 0);
});
