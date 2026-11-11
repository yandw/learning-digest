/**
 * Usage accounting (contract-r3.md §2.4/§3.4; decisions D18, ticket 3.2,
 * issue #74). Seam under test: GET /v1/usage (the bare account-level Usage)
 * plus the existing public write-back endpoint POST /v1/worker/tasks/{id}/
 * result — D18 pins the recording timepoint to "audio segment task first
 * done", observable through the worker flow without touching internals.
 *
 * 口径 pinned here (D18):
 * - audioSeconds accrues on FIRST done (回写首存为准 replays never re-count),
 *   per-segment duration (endMs - startMs), floor(ms / 1000) at read;
 * - transcribing/pending segments do not count, failed do not count,
 *   silent segments (done with records: []) DO count;
 * - summaryCount/summaryInputChars stay 0 until a summary lands (their
 *   accrual lives in the summaries slice).
 * - usage is account-scoped: two accounts never see each other's counts.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers/harness");
const { seedFileWith } = require("./helpers/accounts");
const { makeAudioDir, authHeader, openAccountWithId, createSessionFor } = require("./helpers/sessions");
const { createWorkerClient } = require("../../worker/lib/client");
const { createStubProvider } = require("../../worker/lib/providers/stub");
const { runOnce } = require("../../worker/lib/run-once");

const EMAIL = "usage-a@example.com";
const OTHER_EMAIL = "usage-b@example.com";
const WORKER_TOKEN = "usage-worker-token";

const SEGMENT = {
  segmentIndex: 1,
  startMs: 30000,
  durationMs: 30000,
  audioMimeType: "audio/webm;codecs=opus",
  audioBase64: "SGVsbG8gd29ybGQ=", // arbitrary non-silence bytes
};

async function startUsageApp() {
  const harness = await startApp({
    seedFile: seedFileWith([EMAIL, OTHER_EMAIL]),
    config: { audioDir: makeAudioDir(), workerToken: WORKER_TOKEN },
  });
  const accounts = [];
  for (const email of [EMAIL, OTHER_EMAIL]) {
    const { token, accountId } = await openAccountWithId(harness, email);
    const { session } = await createSessionFor(harness, token, "usage");
    accounts.push({ token, accountId, session });
  }
  const workerClient = createWorkerClient({
    apiBase: `http://127.0.0.1:${harness.port}`,
    token: WORKER_TOKEN,
  });
  return { harness, accounts, workerClient };
}

async function upload(harness, account, overrides = {}) {
  const response = await harness.request(
    "POST",
    `/v1/sessions/${account.session.id}/audio-segments`,
    {
      headers: authHeader(account.token),
      body: { ...SEGMENT, ...overrides },
    },
  );
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response;
}

async function usageOf(harness, account) {
  const response = await harness.request("GET", "/v1/usage", {
    headers: authHeader(account.token),
  });
  assert.equal(response.status, 200);
  return response.json;
}

test("usage: a done audio segment accrues its duration in seconds (D18)", async () => {
  const { harness, accounts, workerClient } = await startUsageApp();
  try {
    const account = accounts[0];
    // Before any activity: zeros, nothing recorded yet.
    assert.deepEqual(await usageOf(harness, account), {
      audioSeconds: 0,
      summaryCount: 0,
      summaryInputChars: 0,
      updatedAt: null,
    });

    await upload(harness, account);
    const claimed = await workerClient.claim({ limit: 1 });
    assert.equal(claimed.tasks.length, 1);
    // Transcribing (claimed, no result yet) does not count.
    assert.equal((await usageOf(harness, account)).audioSeconds, 0);

    const done = await workerClient.submitResult(claimed.tasks[0].taskId, {
      status: "done",
      records: [{ startMs: 30000, endMs: 60000, text: "一段话" }],
    });
    assert.equal(done.status, "done");
    const usage = await usageOf(harness, account);
    assert.equal(usage.audioSeconds, 30);
    assert.equal(usage.summaryCount, 0);
    assert.equal(usage.summaryInputChars, 0);
    assert.ok(typeof usage.updatedAt === "string" && usage.updatedAt.endsWith("Z"));
  } finally {
    await harness.close();
  }
});

test("usage: silent segments (done, no records) count; failed segments never do", async () => {
  const { harness, accounts, workerClient } = await startUsageApp();
  try {
    const account = accounts[0];
    // A failing provider: the segment reaches transcribing then failed —
    // no accrual either way (D18: 失败段不计).
    await upload(harness, account);
    await runOnce({
      client: workerClient,
      provider: {
        id: "stub",
        transcribe: async () => {
          throw new Error("provider down");
        },
      },
    });
    assert.equal((await usageOf(harness, account)).audioSeconds, 0);

    // A silent segment: done with an empty records array — still counted
    // (the audio was really transcribed, D18).
    await upload(harness, account, { segmentIndex: 2, startMs: 60000 });
    const silence = await runOnce({
      client: workerClient,
      provider: { id: "stub", transcribe: async () => [] },
    });
    assert.deepEqual(silence, { claimed: 1, done: 1, failed: 0 });
    assert.equal((await usageOf(harness, account)).audioSeconds, 30);
  } finally {
    await harness.close();
  }
});

test("usage: floor semantics — two 30.5s segments sum to 61s, not 60 (D18: ms sum / 1000 floor)", async () => {
  const { harness, accounts, workerClient } = await startUsageApp();
  try {
    const account = accounts[0];
    await upload(harness, account, {
      segmentIndex: 1,
      startMs: 0,
      durationMs: 30500,
    });
    await upload(harness, account, {
      segmentIndex: 2,
      startMs: 30500,
      durationMs: 30500,
    });
    const drained = await runLoopAll({ workerClient, provider: createStubProvider() });
    assert.deepEqual(drained, { claimed: 2, done: 2, failed: 0 });
    assert.equal((await usageOf(harness, account)).audioSeconds, 61);
  } finally {
    await harness.close();
  }
});

test("usage: a replayed done result never double-counts (首存为准)", async () => {
  const { harness, accounts, workerClient } = await startUsageApp();
  try {
    const account = accounts[0];
    await upload(harness, account);
    const claimed = await workerClient.claim({ limit: 1 });
    const task = claimed.tasks[0];
    const result = { status: "done", records: [{ startMs: 0, endMs: 30000, text: "一段话" }] };
    const first = await workerClient.submitResult(task.taskId, result);
    assert.equal(first.status, "done");
    await workerClient.submitResult(task.taskId, result);
    await workerClient.submitResult(task.taskId, { status: "failed", error: { code: "transcription_failed", message: "迟到的失败" } });
    assert.equal((await usageOf(harness, account)).audioSeconds, 30);
  } finally {
    await harness.close();
  }
});

test("usage: unauthenticated reads are 401; accounts never see each other's counts", async () => {
  const { harness, accounts, workerClient } = await startUsageApp();
  try {
    const [a, b] = accounts;
    const anonymous = await harness.request("GET", "/v1/usage");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error.code, "unauthorized");

    await upload(harness, a);
    await runLoopAll({ workerClient, provider: createStubProvider() });

    const aUsage = await usageOf(harness, a);
    assert.equal(aUsage.audioSeconds, 30);
    const bUsage = await usageOf(harness, b);
    assert.equal(bUsage.audioSeconds, 0);
    assert.equal(bUsage.summaryCount, 0);
    assert.equal(bUsage.summaryInputChars, 0);
  } finally {
    await harness.close();
  }
});

/** Drain the queue with runOnce until one idle poll comes back empty. */
async function runLoopAll({ workerClient, provider, maxCycles = 10 }) {
  let claimed = 0;
  let done = 0;
  let failed = 0;
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const summary = await runOnce({ client: workerClient, provider });
    claimed += summary.claimed;
    done += summary.done;
    failed += summary.failed;
    if (summary.claimed === 0) {
      break;
    }
  }
  return { claimed, done, failed };
}
