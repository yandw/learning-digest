/**
 * Full audio -> transcription chain (ticket 2.3 acceptance, issue #66):
 * public session flow -> out-of-order upload -> worker claim -> stub
 * Speech Provider -> result write-back -> GET transcript shows the
 * archive. The worker runs through its real client over the loopback HTTP
 * listener (no external network; the stub provider keeps it repeatable).
 *
 * Before 2.2 landed this file asserted via store internals; it now
 * observes the end state through the public TranscriptView seam
 * (GET /v1/sessions/{id}/transcript) end to end.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp } = require("./helpers/harness");
const { seedFileWith } = require("./helpers/accounts");
const { makeAudioDir, authHeader, openAccountWithId, createSessionFor } = require("./helpers/sessions");
const { createWorkerClient } = require("../../worker/lib/client");
const { createStubProvider } = require("../../worker/lib/providers/stub");
const { runLoop } = require("../../worker/lib/loop");

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "contracts", "fixtures");
const audioExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "audio-task-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);

const EMAIL = "chain-a@example.com";
const OTHER_EMAIL = "chain-b@example.com";
const WORKER_TOKEN = "chain-worker-token";

const SEGMENT_BODIES = {
  1: audioExampleById.get("api-audio-segment-upload").request.body,
  2: audioExampleById.get("api-audio-segment-upload-second").request.body,
  3: audioExampleById.get("api-audio-segment-out-of-order").request.body,
};

/**
 * One app instance, two invited accounts, one active session per account
 * (public flow: favorite -> session). Returns { harness, accounts,
 * workerClient } where each account carries { token, accountId, session }.
 */
async function startChainApp() {
  const harness = await startApp({
    seedFile: seedFileWith([EMAIL, OTHER_EMAIL]),
    config: { audioDir: makeAudioDir(), workerToken: WORKER_TOKEN },
  });
  const accounts = [];
  for (const [index, email] of [EMAIL, OTHER_EMAIL].entries()) {
    const { token, accountId } = await openAccountWithId(harness, email);
    const { session } = await createSessionFor(harness, token, `chain-${index}`);
    accounts.push({ token, accountId, session });
  }
  const workerClient = createWorkerClient({
    apiBase: `http://127.0.0.1:${harness.port}`,
    token: WORKER_TOKEN,
  });
  return { harness, store: harness.store, accounts, workerClient };
}

async function upload(harness, account, segmentIndex) {
  return harness.request("POST", `/v1/sessions/${account.session.id}/audio-segments`, {
    headers: authHeader(account.token),
    body: SEGMENT_BODIES[segmentIndex],
  });
}

async function transcriptOf(harness, account) {
  const response = await harness.request(
    "GET",
    `/v1/sessions/${account.session.id}/transcript`,
    { headers: authHeader(account.token) },
  );
  assert.equal(response.status, 200);
  return response.json;
}

test("chain: out-of-order upload -> worker drains all segments -> GET transcript shows the asr archive, audio deleted (D14)", async () => {
  const { harness, store, accounts, workerClient } = await startChainApp();
  try {
    const account = accounts[0];
    // Out of order: 3, 1, 2 — the server places them by segmentIndex.
    for (const index of [3, 1, 2]) {
      const response = await upload(harness, account, index);
      assert.equal(response.status, 201);
    }

    // Mid-flight: the view shows all three segments pending.
    const midView = await transcriptOf(harness, account);
    assert.deepEqual(
      midView.pending.map((p) => p.segmentIndex),
      [1, 2, 3],
    );
    assert.equal(midView.origin, "asr");

    // The worker drains three tasks (limit 1 per cycle) plus one idle poll.
    const summary = await runLoop({
      client: workerClient,
      provider: createStubProvider(),
      pollIntervalMs: 1,
      maxCycles: 4,
    });
    assert.deepEqual(summary, { cycles: 4, done: 3, failed: 0 });

    // The public transcript view now carries the whole archive, records
    // sorted by startMs, nothing pending, nothing failed.
    const view = await transcriptOf(harness, account);
    assert.equal(view.sessionId, account.session.id);
    assert.equal(view.sourceId, account.session.sourceId);
    assert.equal(view.resourceId, account.session.resourceId);
    assert.equal(view.sessionStatus, "active");
    assert.equal(view.origin, "asr");
    assert.deepEqual(
      view.records.map((r) => ({ startMs: r.startMs, endMs: r.endMs, text: r.text, origin: r.origin })),
      [
        { startMs: 30000, endMs: 60000, text: "stub 转写文本（第 1 段）", origin: "asr" },
        { startMs: 60000, endMs: 90000, text: "stub 转写文本（第 2 段）", origin: "asr" },
        { startMs: 90000, endMs: 120000, text: "stub 转写文本（第 3 段）", origin: "asr" },
      ],
    );
    assert.deepEqual(view.pending, []);
    assert.deepEqual(view.failed, []);
    assert.deepEqual(view.gaps, []);

    // Every task is terminal-done and every audio file is gone (D14).
    for (const task of store.list("transcriptionTasks")) {
      assert.equal(task.status, "done");
      assert.equal(fs.existsSync(task.audioFile), false, task.taskId);
    }

    // The queue is drained: another claim gets the empty state.
    const drained = await workerClient.claim({ limit: 1 });
    assert.deepEqual(drained, { tasks: [] });
  } finally {
    await harness.close();
  }
});

test("chain: a failing provider writes the failed feedback into the view and keeps the audio (D14)", async () => {
  const { harness, store, accounts, workerClient } = await startChainApp();
  try {
    const account = accounts[0];
    await upload(harness, account, 1);

    const summary = await runLoop({
      client: workerClient,
      provider: {
        id: "stub",
        transcribe: async () => {
          throw new Error("Speech Provider 返回 429，重试后仍失败");
        },
      },
      pollIntervalMs: 1,
      maxCycles: 2,
    });
    assert.deepEqual(summary, { cycles: 2, done: 0, failed: 1 });

    const view = await transcriptOf(harness, account);
    assert.deepEqual(view.failed, [
      {
        segmentIndex: 1,
        startMs: 30000,
        endMs: 60000,
        error: {
          code: "transcription_failed",
          message: "Speech Provider 返回 429，重试后仍失败",
        },
      },
    ]);
    assert.deepEqual(view.records, []);
    assert.deepEqual(view.pending, []);

    // D14: failed audio is retained.
    const task = store.list("transcriptionTasks")[0];
    assert.equal(task.status, "failed");
    assert.ok(fs.existsSync(task.audioFile));
  } finally {
    await harness.close();
  }
});

test("chain: a silence segment (provider finds no text) flows through as done with no records and deletes the audio", async () => {
  const { harness, store, accounts, workerClient } = await startChainApp();
  try {
    const account = accounts[0];
    // Normal audio upload; the provider just finds no speech in it
    // (contract-r2 §3.7: records: [] written back is still done).
    const response = await upload(harness, account, 1);
    assert.equal(response.status, 201);

    const summary = await runLoop({
      client: workerClient,
      provider: { id: "stub", transcribe: async () => [] },
      pollIntervalMs: 1,
      maxCycles: 2,
    });
    assert.deepEqual(summary, { cycles: 2, done: 1, failed: 0 });

    const view = await transcriptOf(harness, account);
    assert.deepEqual(view.records, []);
    assert.deepEqual(view.pending, []);
    assert.deepEqual(view.failed, []);

    const task = store.list("transcriptionTasks")[0];
    assert.equal(task.status, "done");
    assert.equal(fs.existsSync(task.audioFile), false);
  } finally {
    await harness.close();
  }
});

test("chain: dual-account isolation — each account's transcript view only ever shows its own session", async () => {
  const { harness, accounts, workerClient } = await startChainApp();
  try {
    const [a, b] = accounts;
    await upload(harness, a, 1);
    await upload(harness, b, 2);

    const summary = await runLoop({
      client: workerClient,
      provider: createStubProvider(),
      pollIntervalMs: 1,
      maxCycles: 3,
    });
    assert.deepEqual(summary, { cycles: 3, done: 2, failed: 0 });

    const aView = await transcriptOf(harness, a);
    const bView = await transcriptOf(harness, b);
    // A's view belongs to A's session/source, not B's.
    assert.equal(aView.sessionId, a.session.id);
    assert.equal(aView.sourceId, a.session.sourceId);
    assert.deepEqual(
      aView.records.map((r) => ({ startMs: r.startMs, text: r.text })),
      [{ startMs: 30000, text: "stub 转写文本（第 1 段）" }],
    );
    assert.equal(bView.sessionId, b.session.id);
    assert.equal(bView.sourceId, b.session.sourceId);
    assert.deepEqual(
      bView.records.map((r) => ({ startMs: r.startMs, text: r.text })),
      [{ startMs: 60000, text: "stub 转写文本（第 2 段）" }],
    );
  } finally {
    await harness.close();
  }
});
