/**
 * POST /v1/sessions/{id}/audio-segments — round-2 audio upload (ticket 2.3,
 * issue #66; contract-r2.md §3.4, decisions D11/D14/D15).
 *
 * Seams (pre-agreed in the ticket):
 * - the /v1 HTTP endpoints asserted against contracts/fixtures as the
 *   shared samples (audio-task-examples.json, error-examples.json);
 * - Sessions come from the public flow (favorite -> session, 2.1/2.2), and
 *   the transcript STATE behind the endpoint is read back through the
 *   TranscriptView shape via lib/transcripts.js primitives where needed.
 *
 * This file covers the upload endpoint's own behavior. The worker claim /
 * result endpoints live in worker-tasks.test.js; the end-to-end chain with
 * the worker unit lives in audio-chain.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp } = require("./helpers/harness");
const { seedFileWith } = require("./helpers/accounts");
const { makeAudioDir, openAccountWithId, createSessionFor } = require("./helpers/sessions");
const { loadState } = require("../lib/transcripts");

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "contracts", "fixtures");
const audioExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "audio-task-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);
const errorExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "error-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);

const EMAIL = "audio-uploader@example.com";
const OTHER_EMAIL = "other-uploader@example.com";

/**
 * One app instance with two invited accounts, one active Session per
 * account (public flow). Returns { harness, store, token, accountId,
 * sessionId, otherToken }.
 */
async function startSessionedApp() {
  const harness = await startApp({
    seedFile: seedFileWith([EMAIL, OTHER_EMAIL]),
    config: { audioDir: makeAudioDir() },
  });
  const { token, accountId } = await openAccountWithId(harness, EMAIL);
  const { session } = await createSessionFor(harness, token, "upload");
  const { token: otherToken } = await openAccountWithId(harness, OTHER_EMAIL);
  return {
    harness,
    store: harness.store,
    token,
    accountId,
    sessionId: session.id,
    otherToken,
  };
}

/** Post one segment with the fixture body, override selected fields. */
async function postSegment(harness, token, sessionId, overrides = {}) {
  const base = audioExampleById.get("api-audio-segment-upload").request.body;
  return harness.request("POST", `/v1/sessions/${sessionId}/audio-segments`, {
    headers: { authorization: `Bearer ${token}` },
    body: { ...base, ...overrides },
  });
}

test("audio-segment upload: first segment answers 201 with the pending segment per fixture", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    const sample = audioExampleById.get("api-audio-segment-upload");
    const response = await postSegment(harness, token, sessionId, {});
    assert.equal(response.status, 201);
    // The fixture segment is the whole body: exactly the five contract
    // fields, no server-side extras.
    assert.deepEqual(response.json.segment, sample.response.body.segment);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: invalid segmentIndex answers the fixture 400 body", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    const response = await postSegment(harness, token, sessionId, { segmentIndex: -1 });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, errorExampleById.get("error-audio-segment-invalid-index").response.body);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: audio above the 10MB encoded cap answers the fixture 400 body", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    // Just over the 10MB encoded limit (contract-r2 §3.4).
    const oversized = "A".repeat(10 * 1024 * 1024 + 1);
    const response = await postSegment(harness, token, sessionId, { audioBase64: oversized });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, errorExampleById.get("error-audio-segment-too-large").response.body);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: out-of-range durationMs, startMs, mime type and base64 are 400", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    const cases = [
      { durationMs: 4999 }, // below the [5000, 60000] window
      { durationMs: 60001 }, // above the window
      { startMs: -1 },
      { audioMimeType: "text/plain" },
      { audioBase64: "not base64!!!" },
    ];
    for (const overrides of cases) {
      const response = await postSegment(harness, token, sessionId, overrides);
      assert.equal(response.status, 400, `case ${JSON.stringify(overrides)}`);
      assert.equal(response.json.error.code, "validation_failed", `case ${JSON.stringify(overrides)}`);
    }
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: unknown and cross-account sessions are the same 404 (D2)", async () => {
  const { harness, token, otherToken, sessionId } = await startSessionedApp();
  try {
    const unknown = await postSegment(harness, token, "ses_unknown", {});
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, errorExampleById.get("error-cross-account-session-transcript").response.body);

    // The second account cannot upload into the first account's session.
    const crossAccount = await postSegment(harness, otherToken, sessionId, {});
    assert.equal(crossAccount.status, 404);
    assert.deepEqual(crossAccount.json, errorExampleById.get("error-cross-account-session-transcript").response.body);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: new segment on a finished session is 409 session_already_finished", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    const finished = await harness.request("POST", `/v1/sessions/${sessionId}/finish`, {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    assert.equal(finished.status, 200);

    const response = await postSegment(harness, token, sessionId, {});
    assert.equal(response.status, 409);
    assert.deepEqual(response.json, errorExampleById.get("error-audio-segment-after-finish").response.body);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: audio into a captions-locked session is 409 transcript_origin_conflict (D15)", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    // Lock the other direction first (captions direct archive, 2.2).
    const captions = await harness.request("POST", `/v1/sessions/${sessionId}/captions`, {
      headers: { authorization: `Bearer ${token}` },
      body: { segments: [{ startMs: 0, endMs: 1000, text: "字幕文本" }] },
    });
    assert.equal(captions.status, 201);

    const response = await postSegment(harness, token, sessionId, {});
    assert.equal(response.status, 409);
    assert.deepEqual(response.json, {
      error: {
        code: "transcript_origin_conflict",
        message: "本次学习已按字幕归档，同一区间只采用一种方式",
      },
    });
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: byte-level replay answers 200 with the stored segment, no second task", async () => {
  const { harness, store, token, sessionId } = await startSessionedApp();
  try {
    const first = await postSegment(harness, token, sessionId, {});
    assert.equal(first.status, 201);

    const replay = audioExampleById.get("api-audio-segment-duplicate-idempotent");
    const second = await postSegment(harness, token, sessionId, {});
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.segment, replay.response.body.segment);

    // First store wins: exactly one task enqueued for the segment.
    assert.equal(store.count("transcriptionTasks"), 1);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: replay with different bytes still answers the FIRST stored segment", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    await postSegment(harness, token, sessionId, {});
    const second = await postSegment(harness, token, sessionId, {
      audioBase64: "U29tZV9kaWZmZXJlbnRfYnl0ZXM=",
      durationMs: 30000,
    });
    // Same (sessionId, segmentIndex): first store wins, body is not compared.
    assert.equal(second.status, 200);
    assert.equal(second.json.segment.segmentIndex, 1);
    assert.deepEqual(second.json.segment, audioExampleById.get("api-audio-segment-upload").response.body.segment);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: out-of-order segments are accepted and placed by segmentIndex", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    // Segment 1 first (fixture upload), then 3 before 2, then 2.
    const first = await postSegment(harness, token, sessionId, {});
    const outOfOrder = audioExampleById.get("api-audio-segment-out-of-order");
    const third = await postSegment(harness, token, sessionId, outOfOrder.request.body);
    const second = audioExampleById.get("api-audio-segment-upload-second");
    const secondResponse = await postSegment(harness, token, sessionId, second.request.body);

    assert.equal(first.status, 201);
    assert.equal(third.status, 201);
    assert.deepEqual(third.json.segment, outOfOrder.response.body.segment);
    assert.equal(secondResponse.status, 201);
    assert.deepEqual(secondResponse.json.segment, second.response.body.segment);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: audio bytes land in the temp audio dir (path outside the repo)", async () => {
  const audioDir = makeAudioDir();
  const own = await startApp({
    seedFile: seedFileWith([EMAIL]),
    config: { audioDir },
  });
  try {
    const { token } = await openAccountWithId(own, EMAIL);
    const { session } = await createSessionFor(own, token, "audio-file");

    const response = await postSegment(own, token, session.id, {});
    assert.equal(response.status, 201);

    const task = own.store.list("transcriptionTasks")[0];
    assert.ok(!task.audioFile.includes(process.cwd()), "audio path must not live in the repo");
    assert.ok(task.audioFile.startsWith(audioDir));
    assert.ok(fs.existsSync(task.audioFile));
    const bytes = fs.readFileSync(task.audioFile);
    assert.equal(
      bytes.toString("base64"),
      audioExampleById.get("api-audio-segment-upload").request.body.audioBase64,
    );
  } finally {
    await own.close();
  }
});

test("audio-segment upload: first audio segment locks the session origin to asr (D15)", async () => {
  const { harness, store, token, sessionId } = await startSessionedApp();
  try {
    await postSegment(harness, token, sessionId, {});
    // The transcript state's projection is 2.2's; read it through the
    // shared serializer's source (lib/transcripts.loadState).
    assert.equal(store.get("sessions", sessionId).origin, "asr");
    const state = loadState(store, sessionId);
    assert.deepEqual(
      Object.keys(state.segments),
      ["1"],
    );
    assert.equal(state.segments["1"].status, "pending");
    assert.equal(state.segments["1"].startMs, 30000);
    assert.equal(state.segments["1"].endMs, 60000);
    assert.equal(state.segments["1"].audioMimeType, "audio/webm;codecs=opus");
  } finally {
    await harness.close();
  }
});
