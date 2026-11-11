/**
 * POST /v1/sessions/{id}/audio-segments — round-2 audio upload (ticket 2.3,
 * issue #66; contract-r2.md §3.4, decisions D11/D14/D15).
 *
 * Seams (pre-agreed in the ticket):
 * - the /v1 HTTP endpoints asserted against contracts/fixtures as the
 *   shared samples (audio-task-examples.json, error-examples.json);
 * - the Session records those endpoints read (seeded per contract-r2 §2.1
 *   until ticket 2.1 lands — see test/helpers/sessions.js).
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
const { seedSession, makeAudioDir, openAccountWithId } = require("./helpers/sessions");

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
 * One app instance with two invited accounts and an active Session owned
 * by the first. Returns { harness, token, accountId, sessionId }.
 */
async function startSessionedApp() {
  const harness = await startApp({
    seedFile: seedFileWith([EMAIL, OTHER_EMAIL]),
    config: { audioDir: makeAudioDir() },
  });
  const { token, accountId } = await openAccountWithId(harness, EMAIL);
  const sessionId = "ses_test_audio_01";
  seedSession(harness.store, {
    id: sessionId,
    accountId,
    sourceId: "src_test_audio",
    resourceId: "res_test_audio",
  });
  return { harness, store: harness.store, token, accountId, sessionId };
}

/** Open the second (invited) account and return its Bearer token. */
async function openOtherAccount(harness) {
  await harness.request("POST", "/v1/auth/request-code", { body: { email: OTHER_EMAIL } });
  const code = harness.mailer.sent[harness.mailer.sent.length - 1].code;
  const verified = await harness.request("POST", "/v1/auth/verify", {
    body: { email: OTHER_EMAIL, code },
  });
  return verified.json.credential.token;
}

test("audio-segment upload: first segment answers 201 with the pending segment per fixture", async () => {
  const { harness, token, sessionId } = await startSessionedApp();
  try {
    const sample = audioExampleById.get("api-audio-segment-upload");
    const response = await harness.request(
      "POST",
      `/v1/sessions/${sessionId}/audio-segments`,
      { headers: { authorization: `Bearer ${token}` }, body: sample.request.body },
    );
    assert.equal(response.status, 201);
    // The fixture segment is the whole body: exactly the five contract
    // fields, no server-side extras.
    assert.deepEqual(response.json.segment, sample.response.body.segment);
  } finally {
    await harness.close();
  }
});

/** Post one segment with the fixture body, override selected fields. */
async function postSegment(harness, token, sessionId, overrides = {}) {
  const base = audioExampleById.get("api-audio-segment-upload").request.body;
  return harness.request("POST", `/v1/sessions/${sessionId}/audio-segments`, {
    headers: { authorization: `Bearer ${token}` },
    body: { ...base, ...overrides },
  });
}

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
  const { harness, token } = await startSessionedApp();
  try {
    const unknown = await postSegment(harness, token, "ses_unknown", {});
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, errorExampleById.get("error-cross-account-session-transcript").response.body);

    // A second account cannot upload into the first account's session.
    const otherToken = await openOtherAccount(harness);
    const crossAccount = await postSegment(harness, otherToken, "ses_test_audio_01", {});
    assert.equal(crossAccount.status, 404);
    assert.deepEqual(crossAccount.json, errorExampleById.get("error-cross-account-session-transcript").response.body);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: new segment on a finished session is 409 session_already_finished", async () => {
  const { harness, store, token, accountId } = await startSessionedApp();
  try {
    const sessionId = "ses_test_finished";
    seedSession(store, {
      id: sessionId,
      accountId,
      sourceId: "src_test_audio",
      resourceId: "res_test_audio",
      status: "finished",
      finishedAt: "2026-01-01T01:00:00Z",
    });
    const response = await postSegment(harness, token, sessionId, {});
    assert.equal(response.status, 409);
    assert.deepEqual(response.json, errorExampleById.get("error-audio-segment-after-finish").response.body);
  } finally {
    await harness.close();
  }
});

test("audio-segment upload: audio into a captions-locked session is 409 transcript_origin_conflict (D15)", async () => {
  const { harness, store, token, accountId } = await startSessionedApp();
  try {
    const sessionId = "ses_test_captions";
    seedSession(store, {
      id: sessionId,
      accountId,
      sourceId: "src_test_audio",
      resourceId: "res_test_audio",
      origin: "captions",
    });
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
    const second = await harness.request(
      "POST",
      `/v1/sessions/${sessionId}/audio-segments`,
      { headers: { authorization: `Bearer ${token}` }, body: replay.request.body },
    );
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
    const third = await harness.request(
      "POST",
      `/v1/sessions/${sessionId}/audio-segments`,
      { headers: { authorization: `Bearer ${token}` }, body: outOfOrder.request.body },
    );
    const second = audioExampleById.get("api-audio-segment-upload-second");
    const secondResponse = await harness.request(
      "POST",
      `/v1/sessions/${sessionId}/audio-segments`,
      { headers: { authorization: `Bearer ${token}` }, body: second.request.body },
    );

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
    const { token, accountId } = await openAccountWithId(own, EMAIL);
    const sessionId = "ses_test_audio_file";
    seedSession(own.store, { id: sessionId, accountId, sourceId: "s", resourceId: "r" });

    const response = await postSegment(own, token, sessionId, {});
    assert.equal(response.status, 201);

    const segment = own.store.list("audioSegments")[0];
    assert.ok(!segment.audioFile.includes(process.cwd()), "audio path must not live in the repo");
    assert.ok(segment.audioFile.startsWith(audioDir));
    assert.ok(fs.existsSync(segment.audioFile));
    const bytes = fs.readFileSync(segment.audioFile);
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
    // Internal-state assertion: the transcript read model is ticket 2.2;
    // its GET /v1/sessions/{id}/transcript will surface the origin.
    assert.equal(store.get("sessions", sessionId).origin, "asr");
  } finally {
    await harness.close();
  }
});
