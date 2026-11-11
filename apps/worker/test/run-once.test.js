/**
 * runOnce — one worker cycle (ticket 2.3): claim -> transcribe -> submit.
 *
 * Seam: runOnce({ client, provider }) with a scripted fake client — the
 * client is the worker's own HTTP seam (exercised for real against the
 * loopback API in apps/api/test/audio-chain.test.js), and the provider is
 * the Speech Provider seam. This file pins the cycle semantics: claim
 * limit 1 per cycle, timestamp folding onto the source timeline, silence
 * still done, provider failure -> transcription_failed result, serial
 * processing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { runOnce } = require("../lib/run-once");

/** Scripted claim responses; submitResult bodies are recorded. */
function fakeClient(claimPages) {
  const submissions = [];
  let page = 0;
  return {
    submissions,
    async claim() {
      const tasks = claimPages[Math.min(page, claimPages.length - 1)] || [];
      page += 1;
      return { tasks };
    },
    async submitResult(taskId, body) {
      submissions.push({ taskId, body });
      return { taskId, status: body.status };
    },
  };
}

const STUB_TRANSCRIBE = async (input) => [
  { startMs: 0, endMs: input.segment.endMs - input.segment.startMs, text: "segment text" },
];

test("runOnce: empty claim is the idle cycle", async () => {
  const client = fakeClient([[]]);
  const providerCalls = [];
  const summary = await runOnce({
    client,
    provider: { id: "stub", transcribe: async (input) => (providerCalls.push(input), []) },
  });
  assert.deepEqual(summary, { claimed: 0, done: 0, failed: 0 });
  assert.equal(providerCalls.length, 0);
  assert.equal(client.submissions.length, 0);
});

test("runOnce: transcribes the claimed segment and submits folded source-timeline records", async () => {
  const client = fakeClient([
    [
      {
        taskId: "tsk_1",
        sessionId: "ses_1",
        sourceId: "src_1",
        segmentIndex: 1,
        startMs: 30000,
        endMs: 60000,
        audioMimeType: "audio/webm;codecs=opus",
        audioBase64: "U29tZV9hdWRpb19ieXRlcw==",
      },
    ],
  ]);
  const providerInputs = [];
  const summary = await runOnce({
    client,
    provider: {
      id: "stub",
      transcribe: async (input) => {
        providerInputs.push(input);
        return [{ startMs: 0, endMs: 30000, text: "注意力分数的计算" }];
      },
    },
  });

  assert.deepEqual(summary, { claimed: 1, done: 1, failed: 0 });
  // The provider receives the claim task verbatim (segment-relative output).
  assert.deepEqual(providerInputs, [
    {
      audioBase64: "U29tZV9hdWRpb19ieXRlcw==",
      audioMimeType: "audio/webm;codecs=opus",
      segment: { segmentIndex: 1, startMs: 30000, endMs: 60000 },
    },
  ]);
  // The result carries source-timeline timestamps (worker folds).
  assert.deepEqual(client.submissions, [
    {
      taskId: "tsk_1",
      body: {
        status: "done",
        records: [{ startMs: 30000, endMs: 60000, text: "注意力分数的计算" }],
      },
    },
  ]);
});

test("runOnce: silence (empty records) is submitted as done with an empty records array", async () => {
  const client = fakeClient([
    [
      {
        taskId: "tsk_silence",
        sessionId: "ses_1",
        sourceId: "src_1",
        segmentIndex: 0,
        startMs: 0,
        endMs: 30000,
        audioMimeType: "audio/webm;codecs=opus",
        audioBase64: "",
      },
    ],
  ]);
  const summary = await runOnce({
    client,
    provider: { id: "stub", transcribe: async () => [] },
  });
  assert.deepEqual(summary, { claimed: 1, done: 1, failed: 0 });
  assert.deepEqual(client.submissions, [
    { taskId: "tsk_silence", body: { status: "done", records: [] } },
  ]);
});

test("runOnce: provider failure submits the transcription_failed feedback (contract shape)", async () => {
  const client = fakeClient([
    [
      {
        taskId: "tsk_2",
        sessionId: "ses_1",
        sourceId: "src_1",
        segmentIndex: 2,
        startMs: 60000,
        endMs: 90000,
        audioMimeType: "audio/webm;codecs=opus",
        audioBase64: "eA==",
      },
    ],
  ]);
  const summary = await runOnce({
    client,
    provider: {
      id: "qwen",
      transcribe: async () => {
        throw new Error("Qwen Speech Provider request failed with HTTP 429");
      },
    },
  });
  assert.deepEqual(summary, { claimed: 1, done: 0, failed: 1 });
  assert.deepEqual(client.submissions, [
    {
      taskId: "tsk_2",
      body: {
        status: "failed",
        error: {
          code: "transcription_failed",
          message: "Qwen Speech Provider request failed with HTTP 429",
        },
      },
    },
  ]);
});

test("runOnce: multiple claimed tasks are processed serially in claim order", async () => {
  const client = fakeClient([
    [
      { taskId: "tsk_a", sessionId: "s", sourceId: "r", segmentIndex: 1, startMs: 0, endMs: 30000, audioMimeType: "m", audioBase64: "YQ==" },
      { taskId: "tsk_b", sessionId: "s", sourceId: "r", segmentIndex: 2, startMs: 30000, endMs: 60000, audioMimeType: "m", audioBase64: "Yg==" },
    ],
  ]);
  const order = [];
  const summary = await runOnce({
    client,
    provider: {
      id: "stub",
      transcribe: async (input) => {
        order.push(input.segment.segmentIndex);
        return [{ startMs: 0, endMs: 1000, text: `text ${input.segment.segmentIndex}` }];
      },
    },
  });
  assert.deepEqual(summary, { claimed: 2, done: 2, failed: 0 });
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(
    client.submissions.map((s) => s.taskId),
    ["tsk_a", "tsk_b"],
  );
});

test("runOnce: claim failure propagates to the loop (cycle-level, not task-level)", async () => {
  const client = {
    async claim() {
      throw new Error("claim unauthorized");
    },
    async submitResult() {
      throw new Error("should not submit");
    },
  };
  await assert.rejects(
    runOnce({ client, provider: { id: "stub", transcribe: STUB_TRANSCRIBE } }),
    /claim unauthorized/,
  );
});
