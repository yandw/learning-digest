/**
 * Full audio -> transcription chain (ticket 2.3 acceptance, issue #66):
 * upload -> worker claim -> stub Speech Provider -> result write-back,
 * with the REAL worker client over the loopback HTTP listener (no
 * external network; the stub provider keeps it repeatable).
 *
 * NOTE (2.2 合入后补联通断言): the transcript read endpoint
 * GET /v1/sessions/{id}/transcript belongs to ticket 2.2 (issue #65) and
 * is not on the integration branch yet, so this file asserts the chain's
 * end state through the store collections the done path writes
 * (transcriptRecords / audioSegments / transcriptionTasks). When 2.2
 * lands, add the GET assertions here so the chain is observed through the
 * public seam end to end.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp } = require("./helpers/harness");
const { seedFileWith } = require("./helpers/accounts");
const { seedSession, makeAudioDir, openAccountWithId } = require("./helpers/sessions");
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
 * One app instance, two invited accounts, one active session per account.
 * Returns { harness, accounts: [{ token, accountId, sessionId }], workerClient }.
 */
async function startChainApp() {
  const harness = await startApp({
    seedFile: seedFileWith([EMAIL, OTHER_EMAIL]),
    config: { audioDir: makeAudioDir(), workerToken: WORKER_TOKEN },
  });
  const accounts = [];
  for (const [index, email] of [EMAIL, OTHER_EMAIL].entries()) {
    const { token, accountId } = await openAccountWithId(harness, email);
    const sessionId = `ses_chain_${index}`;
    seedSession(harness.store, {
      id: sessionId,
      accountId,
      sourceId: `src_chain_${index}`,
      resourceId: `res_chain_${index}`,
    });
    accounts.push({ token, accountId, sessionId });
  }
  const workerClient = createWorkerClient({
    apiBase: `http://127.0.0.1:${harness.port}`,
    token: WORKER_TOKEN,
  });
  return { harness, store: harness.store, accounts, workerClient };
}

async function upload(harness, account, segmentIndex) {
  return harness.request("POST", `/v1/sessions/${account.sessionId}/audio-segments`, {
    headers: { authorization: `Bearer ${account.token}` },
    body: SEGMENT_BODIES[segmentIndex],
  });
}

test("chain: out-of-order upload -> worker drains all segments -> transcript records on the source timeline, audio deleted (D14)", async () => {
  const { harness, store, accounts, workerClient } = await startChainApp();
  try {
    const account = accounts[0];
    // Out of order: 3, 1, 2 — the server places them by segmentIndex.
    for (const index of [3, 1, 2]) {
      const response = await upload(harness, account, index);
      assert.equal(response.status, 201);
    }

    // The worker drains three tasks (limit 1 per cycle) plus one idle poll.
    const summary = await runLoop({
      client: workerClient,
      provider: createStubProvider(),
      pollIntervalMs: 1,
      maxCycles: 4,
    });
    assert.deepEqual(summary, { cycles: 4, done: 3, failed: 0 });

    // Transcript records (2.2's read model will surface these):
    const records = store
      .list("transcriptRecords")
      .filter((r) => r.sessionId === account.sessionId)
      .sort((a, b) => a.startMs - b.startMs);
    assert.deepEqual(
      records.map((r) => ({ startMs: r.startMs, endMs: r.endMs, text: r.text, origin: r.origin })),
      [
        { startMs: 30000, endMs: 60000, text: "stub 转写文本（第 1 段）", origin: "asr" },
        { startMs: 60000, endMs: 90000, text: "stub 转写文本（第 2 段）", origin: "asr" },
        { startMs: 90000, endMs: 120000, text: "stub 转写文本（第 3 段）", origin: "asr" },
      ],
    );

    // Every task is terminal-done and every audio file is gone (D14).
    for (const task of store.list("transcriptionTasks")) {
      assert.equal(task.status, "done");
      assert.equal(fs.existsSync(task.audioFile), false, task.taskId);
    }
    for (const segment of store.list("audioSegments")) {
      assert.equal(segment.status, "done");
    }

    // The queue is drained: another claim gets the empty state.
    const drained = await workerClient.claim({ limit: 1 });
    assert.deepEqual(drained, { tasks: [] });
  } finally {
    await harness.close();
  }
});

test("chain: a failing provider writes the failed feedback and keeps the audio (D14)", async () => {
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

    const task = store.list("transcriptionTasks")[0];
    assert.equal(task.status, "failed");
    assert.deepEqual(task.result.error, {
      code: "transcription_failed",
      message: "Speech Provider 返回 429，重试后仍失败",
    });
    // D14: failed audio is retained.
    assert.ok(fs.existsSync(task.audioFile));
    assert.equal(store.get("audioSegments", `${account.sessionId}:1`).status, "failed");
    assert.equal(store.list("transcriptRecords").length, 0);
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

    const task = store.list("transcriptionTasks")[0];
    assert.equal(task.status, "done");
    assert.deepEqual(task.result, { records: [] });
    assert.equal(store.list("transcriptRecords").length, 0);
    assert.equal(fs.existsSync(task.audioFile), false);
    assert.equal(store.get("audioSegments", `${account.sessionId}:1`).status, "done");
  } finally {
    await harness.close();
  }
});

test("chain: dual-account isolation — each account's session only ever holds its own records", async () => {
  const { harness, store, accounts, workerClient } = await startChainApp();
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

    const aRecords = store.list("transcriptRecords").filter((r) => r.accountId === a.accountId);
    const bRecords = store.list("transcriptRecords").filter((r) => r.accountId === b.accountId);
    assert.equal(aRecords.length, 1);
    assert.equal(bRecords.length, 1);
    // A's record belongs to A's session/source, not B's.
    assert.equal(aRecords[0].sessionId, a.sessionId);
    assert.equal(aRecords[0].sourceId, "src_chain_0");
    assert.equal(bRecords[0].sessionId, b.sessionId);
    assert.equal(bRecords[0].sourceId, "src_chain_1");
  } finally {
    await harness.close();
  }
});
