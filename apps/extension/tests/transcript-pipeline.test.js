const test = require("node:test");
const assert = require("node:assert/strict");

const pipeline = require("../transcript-pipeline.js");

// Ticket 2.4 (issue #67): the plugin's ASR path switches from local
// Speech Provider calls to the API archive pipeline (contract-r2.md §3.1–§3.5,
// decisions D10/D11/D12/D15). The pure module pins the contract shapes and
// the upload/poll/finish policies; the browser wiring lives in background.js
// and is pinned by tests/plugin-transcript-pipeline-flow.test.js.
//
// Request/response shapes follow contracts/fixtures/audio-task-examples.json
// (api-audio-segment-upload) and session-examples.json
// (api-session-create-bilibili, api-session-finish-with-gaps,
// api-session-transcript-asr-active/finished) plus error-examples.json.

// ============================================================
// §3.4 request body (D11)
// ============================================================

test("buildAudioSegmentBody shapes the D11 JSON body from one Segment", () => {
  // Segment times are whole seconds on the source-video timeline
  // (session-segmenter's Segment); the contract wants milliseconds.
  const body = pipeline.buildAudioSegmentBody({
    segmentIndex: 1,
    startSeconds: 30,
    durationSeconds: 30,
    audioBase64: "SGk=",
    audioMimeType: "audio/webm;codecs=opus",
  });
  assert.deepEqual(body, {
    segmentIndex: 1,
    startMs: 30000,
    durationMs: 30000,
    audioMimeType: "audio/webm;codecs=opus",
    audioBase64: "SGk=",
  });
});

test("buildAudioSegmentBody rejects the contract's validation bounds", () => {
  const base = {
    segmentIndex: 0,
    startSeconds: 0,
    durationSeconds: 30,
    audioBase64: "SGk=",
    audioMimeType: "audio/webm",
  };
  // durationMs must stay within [5000, 60000] — the segmenter's tail flush
  // already keeps ≥ 5s, so anything shorter is a bug that must not POST.
  assert.equal(
    pipeline.buildAudioSegmentBody({ ...base, durationSeconds: 4 }),
    null,
    "duration below 5000ms is refused",
  );
  assert.equal(
    pipeline.buildAudioSegmentBody({ ...base, durationSeconds: 61 }),
    null,
    "duration above 60000ms is refused",
  );
  assert.equal(
    pipeline.buildAudioSegmentBody({ ...base, audioMimeType: "video/webm" }),
    null,
    "a non-audio MIME is refused",
  );
  assert.equal(
    pipeline.buildAudioSegmentBody({ ...base, audioBase64: "" }),
    null,
    "empty audio is refused",
  );
  assert.equal(
    pipeline.buildAudioSegmentBody({ ...base, segmentIndex: -1 }),
    null,
    "a negative segmentIndex is refused",
  );
  // The 10MB encoded-audio cap (contract §3.4) is checked on the wire field.
  const oversized = pipeline.buildAudioSegmentBody({
    ...base,
    audioBase64: "A".repeat(10_000_001),
  });
  assert.equal(oversized, null, "audioBase64 above 10MB encoded is refused");
});

// ============================================================
// §3.4 upload verdicts + idempotent replay
// ============================================================

/** A Response-like stub: status + JSON body, recording every call's body. */
function jsonFetch(script, calls = []) {
  return async (url, init) => {
    calls.push({ url, init, body: init?.body });
    const entry = typeof script === "function" ? script(calls.length) : script;
    return {
      status: entry.status,
      ok: entry.status < 400,
      json: async () => entry.body,
    };
  };
}

const SESSION = "ses_01JABC0033";
const UPLOAD_URL = "https://api.example.com/v1/sessions/ses_01JABC0033/audio-segments";

function uploadOptions(fetchImpl, overrides = {}) {
  return {
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sessionId: SESSION,
    body: {
      segmentIndex: 1,
      startMs: 30000,
      durationMs: 30000,
      audioMimeType: "audio/webm;codecs=opus",
      audioBase64: "SGk=",
    },
    setTimeoutImpl: () => 0,
    ...overrides,
  };
}

test("uploadAudioSegment POSTs the D11 body and reports ok on 201/200", async () => {
  const calls = [];
  // api-audio-segment-upload: 201 with the queued Segment; a retry replay
  // (api-audio-segment-duplicate-idempotent) answers 200 with the stored one.
  for (const status of [201, 200]) {
    calls.length = 0;
    const fetchImpl = jsonFetch(
      { status, body: { segment: { segmentIndex: 1, startMs: 30000, endMs: 60000, status: "pending", audioMimeType: "audio/webm;codecs=opus" } } },
      calls,
    );
    const outcome = await pipeline.uploadAudioSegment(uploadOptions(fetchImpl));
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.segment.segmentIndex, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, UPLOAD_URL);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer ext-token");
    assert.deepEqual(JSON.parse(calls[0].body), uploadOptions(fetchImpl).body);
  }
});

test("uploadAudioSegment replays the SAME body byte-for-byte across network retries", async () => {
  const calls = [];
  let attempts = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body });
    attempts += 1;
    if (attempts <= 2) throw new Error("network down");
    return { status: 201, ok: true, json: async () => ({ segment: { segmentIndex: 1, startMs: 30000, endMs: 60000, status: "pending", audioMimeType: "audio/webm" } }) };
  };
  const sleeps = [];
  const outcome = await pipeline.uploadAudioSegment(
    uploadOptions(fetchImpl, {
      retryDelaysMs: [10, 20, 40],
      setTimeoutImpl: (fn, delay) => sleeps.push(delay) && fn(),
    }),
  );
  assert.equal(outcome.kind, "ok");
  assert.equal(calls.length, 3, "two network failures then the accepted attempt");
  assert.equal(calls[0].body, calls[1].body, "byte-level replay: the body is reused verbatim");
  assert.deepEqual(sleeps, [10, 20], "the backoff schedule drives the retries");
});

test("uploadAudioSegment gives up after the retry budget and reports network", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const outcome = await pipeline.uploadAudioSegment(
    uploadOptions(fetchImpl, { retryDelaysMs: [10, 20], setTimeoutImpl: (fn) => fn() }),
  );
  assert.equal(outcome.kind, "network");
  assert.ok(outcome.message, "the failure carries the reason for the loud log");
});

test("uploadAudioSegment treats 5xx as transient and retries within the budget", async () => {
  const calls = [];
  const fetchImpl = jsonFetch(
    (attempt) =>
      attempt < 3
        ? { status: 503, body: { error: { code: "service_unavailable", message: "稍后再试" } } }
        : { status: 201, body: { segment: { segmentIndex: 1, startMs: 30000, endMs: 60000, status: "pending", audioMimeType: "audio/webm" } } },
    calls,
  );
  const outcome = await pipeline.uploadAudioSegment(
    uploadOptions(fetchImpl, { retryDelaysMs: [10, 20], setTimeoutImpl: (fn) => fn() }),
  );
  assert.equal(outcome.kind, "ok");
  assert.equal(calls.length, 3);
});

test("uploadAudioSegment stops on 409 transcript_origin_conflict and reports it", async () => {
  const calls = [];
  // error-transcript-origin-conflict: the Session is captions-locked (D15).
  const fetchImpl = jsonFetch(
    { status: 409, body: { error: { code: "transcript_origin_conflict", message: "本次学习已按字幕归档，同一区间只采用一种方式" } } },
    calls,
  );
  const outcome = await pipeline.uploadAudioSegment(uploadOptions(fetchImpl));
  assert.equal(outcome.kind, "originConflict");
  assert.equal(outcome.code, "transcript_origin_conflict");
  assert.equal(outcome.message, "本次学习已按字幕归档，同一区间只采用一种方式");
  assert.equal(calls.length, 1, "a terminal verdict never retries");
});

test("uploadAudioSegment stops on 409 session_already_finished", async () => {
  // error-audio-segment-after-finish: the Session was closed; even a late
  // byte-level replay is a stop signal, not a resend.
  const fetchImpl = jsonFetch(
    { status: 409, body: { error: { code: "session_already_finished", message: "本次学习已结束，不再接收音频" } } },
  );
  const outcome = await pipeline.uploadAudioSegment(uploadOptions(fetchImpl));
  assert.equal(outcome.kind, "finished");
  assert.equal(outcome.code, "session_already_finished");
});

test("uploadAudioSegment reports unauthorized and notFound without retrying", async () => {
  const unauthorized = await pipeline.uploadAudioSegment(
    uploadOptions(jsonFetch({ status: 401, body: { error: { code: "unauthorized", message: "凭据已失效" } } })),
  );
  assert.equal(unauthorized.kind, "unauthorized");

  const notFound = await pipeline.uploadAudioSegment(
    uploadOptions(jsonFetch({ status: 404, body: { error: { code: "not_found", message: "资源不存在" } } })),
  );
  assert.equal(notFound.kind, "notFound");
});

test("uploadAudioSegment reports invalid on a 400 validation failure", async () => {
  const fetchImpl = jsonFetch(
    { status: 400, body: { error: { code: "validation_failed", message: "durationMs 必须在 5000 到 60000 毫秒之间" } } },
  );
  const outcome = await pipeline.uploadAudioSegment(uploadOptions(fetchImpl));
  assert.equal(outcome.kind, "invalid");
  assert.equal(outcome.message, "durationMs 必须在 5000 到 60000 毫秒之间");
});

test("uploadAudioSegment refuses a malformed body client-side without any fetch", async () => {
  const calls = [];
  const fetchImpl = jsonFetch({ status: 201, body: { segment: {} } }, calls);
  const outcome = await pipeline.uploadAudioSegment(
    uploadOptions(fetchImpl, { body: { segmentIndex: -1 } }),
  );
  assert.equal(outcome.kind, "invalid");
  assert.equal(calls.length, 0, "a body outside the contract never reaches the wire");
});

// ============================================================
// §3.2 finish gaps (the P11 收尾's body material)
// ============================================================

test("buildFinishGaps converts the local seek-skipped markers to contract ranges", () => {
  const gaps = pipeline.buildFinishGaps([
    { start: 150, duration: 60, failed: true, text: "[已跳过 2:30–3:30]" },
    { start: 0, duration: 5 },
    // Unusable entries drop instead of 400ing the whole finish.
    { start: 10, duration: 0 },
    { start: -5, duration: 10 },
    { start: 20 },
    null,
  ]);
  assert.deepEqual(gaps, [
    { startMs: 150000, endMs: 210000 },
    { startMs: 0, endMs: 5000 },
  ]);
});

test("buildFinishGaps tolerates non-array input", () => {
  assert.deepEqual(pipeline.buildFinishGaps(null), []);
  assert.deepEqual(pipeline.buildFinishGaps(undefined), []);
  assert.deepEqual(pipeline.buildFinishGaps("nope"), []);
});
