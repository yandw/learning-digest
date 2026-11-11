/**
 * POST /v1/worker/tasks/claim + POST /v1/worker/tasks/:id/result — the
 * round-2 worker contract (ticket 2.3, issue #66; contract-r2.md §3.7,
 * decisions D13/D14/D15).
 *
 * Seams (pre-agreed in the ticket):
 * - the /v1 HTTP endpoints asserted against contracts/fixtures
 *   (audio-task-examples.json, error-examples.json);
 * - the worker service credential is a statically configured bearer token
 *   (config.workerToken) — implementation decision recorded in the ticket;
 *   empty config means every worker request is 401;
 * - outcome assertions read the public GET /v1/sessions/{id}/transcript
 *   view (2.2) plus the task queue this module owns; the only store reads
 *   are the audio file paths (D14 deletion is unobservable via the API by
 *   design) and the task queue's own status.
 *
 * Upload-side behavior lives in audio-segments-upload.test.js; the
 * end-to-end chain with the worker unit lives in audio-chain.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp } = require("./helpers/harness");
const { seedFileWith } = require("./helpers/accounts");
const { makeAudioDir, authHeader, openAccountWithId, createSessionFor } = require("./helpers/sessions");

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "contracts", "fixtures");
const audioExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "audio-task-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);
const errorExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "error-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);

const EMAIL = "worker-chain@example.com";
const WORKER_TOKEN = "worker-service-token-01";

const SEGMENT_BODIES = {
  1: audioExampleById.get("api-audio-segment-upload").request.body,
  2: audioExampleById.get("api-audio-segment-upload-second").request.body,
  3: audioExampleById.get("api-audio-segment-out-of-order").request.body,
};

/**
 * One app instance with a worker credential, an invited account, and an
 * active session (public flow). Returns { harness, store, token,
 * accountId, sessionId, claim, upload, getTranscript }.
 */
async function startWorkerApp() {
  const harness = await startApp({
    seedFile: seedFileWith([EMAIL]),
    config: { audioDir: makeAudioDir(), workerToken: WORKER_TOKEN },
  });
  const { token, accountId } = await openAccountWithId(harness, EMAIL);
  const { session } = await createSessionFor(harness, token, "worker");
  function claim(body) {
    return harness.request("POST", "/v1/worker/tasks/claim", {
      headers: authHeader(WORKER_TOKEN),
      body,
    });
  }
  function upload(segmentIndex) {
    return harness.request("POST", `/v1/sessions/${session.id}/audio-segments`, {
      headers: authHeader(token),
      body: SEGMENT_BODIES[segmentIndex],
    });
  }
  function getTranscript() {
    return harness.request("GET", `/v1/sessions/${session.id}/transcript`, {
      headers: authHeader(token),
    });
  }
  return {
    harness,
    store: harness.store,
    token,
    accountId,
    sessionId: session.id,
    claim,
    upload,
    getTranscript,
  };
}

test("worker claim: missing, user, and wrong worker credentials all answer the fixture 401", async () => {
  const { harness, token } = await startWorkerApp();
  try {
    const missing = await harness.request("POST", "/v1/worker/tasks/claim", { body: { limit: 1 } });
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.json, errorExampleById.get("error-worker-claim-unauthorized").response.body);

    // A valid user credential is still not a worker credential.
    const user = await harness.request("POST", "/v1/worker/tasks/claim", {
      headers: authHeader(token),
      body: { limit: 1 },
    });
    assert.equal(user.status, 401);
    assert.deepEqual(user.json, errorExampleById.get("error-worker-claim-unauthorized").response.body);

    const wrong = await harness.request("POST", "/v1/worker/tasks/claim", {
      headers: { authorization: "Bearer not-the-worker-token" },
      body: { limit: 1 },
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, errorExampleById.get("error-worker-claim-unauthorized").response.body);
  } finally {
    await harness.close();
  }
});

test("worker claim: no pending tasks answers the empty state", async () => {
  const { harness, claim } = await startWorkerApp();
  try {
    const response = await claim({ limit: 3 });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { tasks: [] });
  } finally {
    await harness.close();
  }
});

test("worker claim: claims one pending task with inline base64 audio and moves it to transcribing", async () => {
  const { harness, claim, upload, getTranscript, sessionId } = await startWorkerApp();
  try {
    await upload(1);

    const response = await claim({ limit: 1 });
    assert.equal(response.status, 200);

    const task = response.json.tasks[0];
    // Exactly the eight contract fields (contract-r2 §3.7 Task shape).
    assert.deepEqual(
      Object.keys(task).sort(),
      ["audioBase64", "audioMimeType", "endMs", "segmentIndex", "sessionId", "sourceId", "startMs", "taskId"].sort(),
    );
    assert.equal(task.segmentIndex, 1);
    assert.equal(task.startMs, 30000);
    assert.equal(task.endMs, 60000);
    assert.equal(task.audioMimeType, "audio/webm;codecs=opus");
    assert.equal(task.audioBase64, SEGMENT_BODIES[1].audioBase64);
    assert.equal(task.sessionId, sessionId);
    assert.ok(task.sourceId.length > 0);
    assert.ok(task.taskId.length > 0);

    // Claim is a transition: the claimed task is no longer pending, and the
    // transcript view projects it as "transcribing" in pending[] (§2.5).
    const again = await claim({ limit: 1 });
    assert.deepEqual(again.json, { tasks: [] });

    const view = (await getTranscript()).json;
    assert.deepEqual(view.pending, [
      { segmentIndex: 1, startMs: 30000, endMs: 60000, status: "transcribing" },
    ]);
    assert.deepEqual(view.failed, []);
    assert.deepEqual(view.records, []);
  } finally {
    await harness.close();
  }
});

test("worker claim: claims in segmentIndex ascending order (fixtures claim 1, 2, 3)", async () => {
  const { harness, claim, upload } = await startWorkerApp();
  try {
    // Upload out of order: 3, then 1, then 2.
    await upload(3);
    await upload(1);
    await upload(2);

    const response = await claim({ limit: 3 });
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.json.tasks.map((task) => task.segmentIndex),
      [1, 2, 3],
    );
    // Each task carries its own audio.
    assert.equal(response.json.tasks[0].audioBase64, SEGMENT_BODIES[1].audioBase64);
    assert.equal(response.json.tasks[1].audioBase64, SEGMENT_BODIES[2].audioBase64);
    assert.equal(response.json.tasks[2].audioBase64, SEGMENT_BODIES[3].audioBase64);
  } finally {
    await harness.close();
  }
});

test("worker claim: limit defaults to 1, must be a positive integer, and caps at 10", async () => {
  const { harness, claim, upload, token, sessionId } = await startWorkerApp();
  try {
    await upload(1);
    await upload(2);

    // Default (no body): limit 1.
    const defaultClaim = await claim(undefined);
    assert.equal(defaultClaim.status, 200);
    assert.equal(defaultClaim.json.tasks.length, 1);
    assert.equal(defaultClaim.json.tasks[0].segmentIndex, 1);

    // Non-positive / non-integer limits are 400.
    for (const badLimit of [0, -1, 1.5, "3"]) {
      const bad = await claim({ limit: badLimit });
      assert.equal(bad.status, 400, `limit ${JSON.stringify(badLimit)}`);
      assert.equal(bad.json.error.code, "validation_failed", `limit ${JSON.stringify(badLimit)}`);
    }

    // Server cap: 11 pending tasks, limit 99 -> at most 10.
    for (let index = 3; index <= 11; index += 1) {
      const response = await harness.request("POST", `/v1/sessions/${sessionId}/audio-segments`, {
        headers: authHeader(token),
        body: {
          segmentIndex: index,
          startMs: (index - 1) * 30000,
          durationMs: 30000,
          audioMimeType: "audio/webm;codecs=opus",
          audioBase64: `c2VnbWVudF8=${index}`.replace("=", "") + "=",
        },
      });
      assert.equal(response.status, 201, `upload segment ${index}`);
    }
    const capped = await claim({ limit: 99 });
    assert.equal(capped.status, 200);
    assert.equal(capped.json.tasks.length, 10);
  } finally {
    await harness.close();
  }
});

// --- result endpoint ---

/**
 * Upload segment `index`, claim it, and return the claimed task so a test
 * can write a result against the real taskId.
 */
async function claimOne(harness, claim, upload, index) {
  await upload(index);
  const response = await claim({ limit: 1 });
  return response.json.tasks[0];
}

function submitResult(harness, taskId, body) {
  return harness.request("POST", `/v1/worker/tasks/${taskId}/result`, {
    headers: authHeader(WORKER_TOKEN),
    body,
  });
}

test("worker result: done lands the asr records in the transcript view and deletes the audio file (D14)", async () => {
  const { harness, store, claim, upload, getTranscript } = await startWorkerApp();
  try {
    const task = await claimOne(harness, claim, upload, 1);

    // The audio file observation point: D14 deletion is unobservable
    // through the API by design, so tests read the temp file system.
    const stored = store.get("transcriptionTasks", task.taskId);
    assert.ok(fs.existsSync(stored.audioFile));

    const done = audioExampleById.get("worker-task-result-done");
    const response = await submitResult(harness, task.taskId, {
      status: "done",
      records: [
        {
          startMs: 30000,
          endMs: 60000,
          text: "注意力分数的计算，就是把查询向量和键向量做点积",
        },
      ],
    });
    assert.equal(response.status, 200);
    // Same shape as the fixture; the taskId is server-generated (opaque).
    assert.deepEqual(response.json, { taskId: task.taskId, status: done.response.body.status });

    // The public transcript view (2.2) now carries the record; nothing is
    // pending or failed.
    const view = (await getTranscript()).json;
    assert.deepEqual(
      view.records.map((r) => ({ startMs: r.startMs, endMs: r.endMs, text: r.text, origin: r.origin })),
      [
        {
          startMs: 30000,
          endMs: 60000,
          text: "注意力分数的计算，就是把查询向量和键向量做点积",
          origin: "asr",
        },
      ],
    );
    assert.deepEqual(view.pending, []);
    assert.deepEqual(view.failed, []);

    // D14: done deletes the audio immediately; the task is terminal.
    assert.equal(fs.existsSync(stored.audioFile), false);
    assert.equal(store.get("transcriptionTasks", task.taskId).status, "done");
  } finally {
    await harness.close();
  }
});

test("worker result: silence (records: []) is still done, writes no records, deletes audio", async () => {
  const { harness, store, claim, upload, getTranscript } = await startWorkerApp();
  try {
    const task = await claimOne(harness, claim, upload, 2);
    const stored = store.get("transcriptionTasks", task.taskId);

    const response = await submitResult(harness, task.taskId, { status: "done", records: [] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { taskId: task.taskId, status: "done" });

    const view = (await getTranscript()).json;
    assert.deepEqual(view.records, []);
    assert.deepEqual(view.pending, []);
    assert.deepEqual(view.failed, []);
    assert.equal(fs.existsSync(stored.audioFile), false);
    assert.equal(store.get("transcriptionTasks", task.taskId).status, "done");
  } finally {
    await harness.close();
  }
});

test("worker result: failed keeps the audio file and surfaces the error in the transcript view (D14)", async () => {
  const { harness, store, claim, upload, getTranscript } = await startWorkerApp();
  try {
    const task = await claimOne(harness, claim, upload, 3);
    const stored = store.get("transcriptionTasks", task.taskId);

    const failed = audioExampleById.get("worker-task-result-failed");
    const response = await submitResult(harness, task.taskId, {
      status: "failed",
      error: { code: "transcription_failed", message: "Speech Provider 返回 429，重试后仍失败" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { taskId: task.taskId, status: failed.response.body.status });

    // The public view's failed[] carries the error verbatim; no records.
    const view = (await getTranscript()).json;
    assert.deepEqual(view.failed, [
      {
        segmentIndex: 3,
        startMs: 90000,
        endMs: 120000,
        error: {
          code: "transcription_failed",
          message: "Speech Provider 返回 429，重试后仍失败",
        },
      },
    ]);
    assert.deepEqual(view.records, []);

    // D14: failed audio is retained for session-end + grace cleanup.
    assert.ok(fs.existsSync(stored.audioFile));
    assert.equal(store.get("transcriptionTasks", task.taskId).status, "failed");
  } finally {
    await harness.close();
  }
});

test("worker result: unknown task answers the fixture 404; result needs the worker credential", async () => {
  const { harness, token } = await startWorkerApp();
  try {
    const unknown = await submitResult(harness, "tsk_unknown_task", {
      status: "failed",
      error: { code: "transcription_failed", message: "x" },
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, errorExampleById.get("error-worker-result-unknown-task").response.body);

    // Missing/wrong/user credentials are the same 401 as claim.
    const missing = await harness.request("POST", "/v1/worker/tasks/tsk_x/result", {
      body: { status: "done", records: [] },
    });
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.json, errorExampleById.get("error-worker-claim-unauthorized").response.body);

    const user = await harness.request("POST", "/v1/worker/tasks/tsk_x/result", {
      headers: authHeader(token),
      body: { status: "done", records: [] },
    });
    assert.equal(user.status, 401);
    assert.deepEqual(user.json, errorExampleById.get("error-worker-claim-unauthorized").response.body);
  } finally {
    await harness.close();
  }
});

test("worker result: resends replay the first stored result and never re-apply (首存为准)", async () => {
  const { harness, store, claim, upload, getTranscript } = await startWorkerApp();
  try {
    const task = await claimOne(harness, claim, upload, 1);
    const first = await submitResult(harness, task.taskId, {
      status: "done",
      records: [{ startMs: 30000, endMs: 60000, text: "首存文本" }],
    });
    assert.equal(first.status, 200);

    // Same taskId, different body: still a 200 replay of the first result,
    // and the view keeps exactly one record.
    const resend = await submitResult(harness, task.taskId, {
      status: "done",
      records: [{ startMs: 0, endMs: 1, text: "重发不应入库" }],
    });
    assert.equal(resend.status, 200);
    assert.deepEqual(resend.json, { taskId: task.taskId, status: "done" });
    const view = (await getTranscript()).json;
    assert.deepEqual(
      view.records.map((r) => r.text),
      ["首存文本"],
    );
  } finally {
    await harness.close();
  }
});

test("worker result: terminal states never roll back (done -> failed attempt replays done)", async () => {
  const { harness, store, claim, upload, getTranscript } = await startWorkerApp();
  try {
    const task = await claimOne(harness, claim, upload, 1);
    await submitResult(harness, task.taskId, {
      status: "done",
      records: [{ startMs: 30000, endMs: 60000, text: "终态文本" }],
    });

    const lateFailed = await submitResult(harness, task.taskId, {
      status: "failed",
      error: { code: "transcription_failed", message: "迟到的失败不应改写终态" },
    });
    assert.equal(lateFailed.status, 200);
    assert.deepEqual(lateFailed.json, { taskId: task.taskId, status: "done" });
    assert.equal(store.get("transcriptionTasks", task.taskId).status, "done");
    let view = (await getTranscript()).json;
    assert.deepEqual(
      view.records.map((r) => r.text),
      ["终态文本"],
    );
    assert.deepEqual(view.failed, []);

    // And a failed task cannot become done afterwards.
    const failedTask = await claimOne(harness, claim, upload, 2);
    await submitResult(harness, failedTask.taskId, {
      status: "failed",
      error: { code: "transcription_failed", message: "先失败" },
    });
    const lateDone = await submitResult(harness, failedTask.taskId, {
      status: "done",
      records: [{ startMs: 0, endMs: 1, text: "迟到的成功" }],
    });
    assert.deepEqual(lateDone.json, { taskId: failedTask.taskId, status: "failed" });
    assert.equal(store.get("transcriptionTasks", failedTask.taskId).status, "failed");
    view = (await getTranscript()).json;
    assert.deepEqual(
      view.records.map((r) => r.text),
      ["终态文本"],
    );
    assert.equal(view.failed.length, 1);
  } finally {
    await harness.close();
  }
});

test("worker result: a result against a not-yet-claimed (pending) task is rejected", async () => {
  const { harness, store, upload, getTranscript } = await startWorkerApp();
  try {
    await upload(1);
    const task = store.list("transcriptionTasks")[0];
    assert.equal(task.status, "pending");

    const response = await submitResult(harness, task.taskId, {
      status: "done",
      records: [{ startMs: 0, endMs: 1, text: "未领取就回写" }],
    });
    // Discretion (pinned here): the state machine is pending ->
    // transcribing -> done|failed; writing a result skips no steps.
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_failed");
    assert.equal(store.get("transcriptionTasks", task.taskId).status, "pending");
    const view = (await getTranscript()).json;
    assert.deepEqual(view.records, []);
    assert.deepEqual(view.failed, []);
  } finally {
    await harness.close();
  }
});

test("worker result: malformed bodies are 400 validation_failed", async () => {
  const { harness, store, claim, upload } = await startWorkerApp();
  try {
    const task = await claimOne(harness, claim, upload, 1);
    const cases = [
      { status: "unknown" },
      { status: "done" }, // records missing
      { status: "done", records: "not-an-array" },
      { status: "done", records: [{ startMs: 0, endMs: 1 }] }, // text missing
      { status: "done", records: [{ startMs: -1, endMs: 1, text: "x" }] },
      { status: "done", records: [{ startMs: 5, endMs: 1, text: "x" }] }, // end < start
      { status: "failed" }, // error missing
      { status: "failed", error: { code: "other_code", message: "x" } },
      { status: "failed", error: { code: "transcription_failed" } }, // message missing
    ];
    for (const [i, body] of cases.entries()) {
      const response = await submitResult(harness, task.taskId, body);
      assert.equal(response.status, 400, `case ${i} ${JSON.stringify(body)}`);
      assert.equal(response.json.error.code, "validation_failed", `case ${i}`);
    }
    // The task survives malformed resends still transcribing.
    assert.equal(store.get("transcriptionTasks", task.taskId).status, "transcribing");
  } finally {
    await harness.close();
  }
});
