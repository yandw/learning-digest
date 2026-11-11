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
// §3.1 create + §3.2 finish
// ============================================================

test("createLearningSession POSTs an empty body and returns the Session (api-session-create-bilibili)", async () => {
  const calls = [];
  const fetchImpl = jsonFetch(
    {
      status: 201,
      body: {
        session: {
          id: "ses_01JABC0033",
          sourceId: "src_01JABC0002",
          resourceId: "res_01JABC0001",
          status: "active",
          startedAt: "2026-11-10T10:00:00Z",
          finishedAt: null,
          origin: null,
        },
      },
    },
    calls,
  );
  const outcome = await pipeline.createLearningSession({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.session.id, "ses_01JABC0033");
  assert.equal(outcome.session.origin, null);
  assert.equal(outcome.session.status, "active");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/sources/src_01JABC0002/sessions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].body, "{}");
});

test("createLearningSession retries transient failures then succeeds", async () => {
  const calls = [];
  const fetchImpl = jsonFetch(
    (attempt) =>
      attempt === 1
        ? { status: 502, body: { error: { code: "bad_gateway", message: "upstream" } } }
        : { status: 201, body: { session: { id: "ses_1", sourceId: "src_1", resourceId: "res_1", status: "active", startedAt: "2026-11-10T10:00:00Z", finishedAt: null, origin: null } } },
    calls,
  );
  const outcome = await pipeline.createLearningSession({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "t",
    sourceId: "src_1",
    retryDelaysMs: [10, 20],
    setTimeoutImpl: (fn) => fn(),
  });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
});

test("createLearningSession fails honestly on exhausted retries, 401 and 404", async () => {
  const network = await pipeline.createLearningSession({
    fetchImpl: async () => {
      throw new Error("down");
    },
    apiBaseUrl: "https://api.example.com",
    token: "t",
    sourceId: "src_1",
    retryDelaysMs: [10],
    setTimeoutImpl: (fn) => fn(),
  });
  assert.equal(network.ok, false);
  assert.equal(network.kind, "network");

  const unauthorized = await pipeline.createLearningSession({
    fetchImpl: jsonFetch({ status: 401, body: { error: { code: "unauthorized", message: "凭据已失效" } } }),
    apiBaseUrl: "https://api.example.com",
    token: "t",
    sourceId: "src_1",
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.kind, "unauthorized");

  // D2: an unknown or other-account Source is a 404.
  const notFound = await pipeline.createLearningSession({
    fetchImpl: jsonFetch({ status: 404, body: { error: { code: "not_found", message: "资源不存在" } } }),
    apiBaseUrl: "https://api.example.com",
    token: "t",
    sourceId: "src_1",
  });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.kind, "notFound");
});

test("finishLearningSession POSTs gaps and reports alreadyFinished on the repeat (api-session-finish-with-gaps)", async () => {
  const calls = [];
  const sessionBody = { session: { id: "ses_01JABC0032", sourceId: "src_01JABC0002", resourceId: "res_01JABC0001", status: "finished", startedAt: "2026-11-10T09:00:00Z", finishedAt: "2026-11-10T09:45:00Z", origin: "asr" } };
  const fetchImpl = jsonFetch({ status: 200, body: sessionBody }, calls);
  const outcome = await pipeline.finishLearningSession({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sessionId: "ses_01JABC0032",
    gaps: [{ startMs: 150000, endMs: 210000 }],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.session.status, "finished");
  assert.equal(calls[0].url, "https://api.example.com/v1/sessions/ses_01JABC0032/finish");
  assert.deepEqual(JSON.parse(calls[0].body), { gaps: [{ startMs: 150000, endMs: 210000 }] });

  // The repeat close (409 session_already_finished) is a success for the
  // caller — the Session IS finished, and the contract makes the repeat a
  // 409, not a 200.
  const repeat = await pipeline.finishLearningSession({
    fetchImpl: jsonFetch({ status: 409, body: { error: { code: "session_already_finished", message: "本次学习已结束" } } }),
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sessionId: "ses_01JABC0032",
    gaps: [],
  });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.alreadyFinished, true);
});

test("finishLearningSession retries transient failures and reports terminal failures", async () => {
  let attempts = 0;
  const retryOutcome = await pipeline.finishLearningSession({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("down");
      return { status: 200, ok: true, json: async () => ({ session: { id: "s", status: "finished", sourceId: "x", resourceId: "y", startedAt: "", finishedAt: "", origin: "asr" } }) };
    },
    apiBaseUrl: "https://api.example.com",
    token: "t",
    sessionId: "s",
    gaps: [],
    retryDelaysMs: [10],
    setTimeoutImpl: (fn) => fn(),
  });
  assert.equal(retryOutcome.ok, true);
  assert.equal(attempts, 2);

  const unauthorized = await pipeline.finishLearningSession({
    fetchImpl: jsonFetch({ status: 401, body: { error: { code: "unauthorized", message: "凭据已失效" } } }),
    apiBaseUrl: "https://api.example.com",
    token: "t",
    sessionId: "s",
    gaps: [],
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.kind, "unauthorized");
});

// ============================================================
// §2.5 TranscriptView parse + §3.5 poll
// ============================================================

// api-session-transcript-asr-active, verbatim from the fixtures.
const VIEW_ACTIVE = {
  sessionId: "ses_01JABC0033",
  sourceId: "src_01JABC0002",
  resourceId: "res_01JABC0001",
  sessionStatus: "active",
  origin: "asr",
  records: [
    { startMs: 0, endMs: 30000, text: "欢迎来到这一节，我们先回顾上一课留下的三个问题", origin: "asr" },
    { startMs: 30000, endMs: 60000, text: "注意力分数的计算，就是把查询向量和键向量做点积", origin: "asr" },
  ],
  gaps: [],
  pending: [{ segmentIndex: 3, startMs: 90000, endMs: 120000, status: "transcribing" }],
  failed: [
    {
      segmentIndex: 2,
      startMs: 60000,
      endMs: 90000,
      error: { code: "transcription_failed", message: "Speech Provider 返回 429，重试后仍失败" },
    },
  ],
};

test("parseTranscriptView accepts the fixture view and keeps all four arrays", () => {
  const view = pipeline.parseTranscriptView(VIEW_ACTIVE);
  assert.ok(view, "the fixture view parses");
  assert.equal(view.records.length, 2);
  assert.equal(view.pending.length, 1);
  assert.equal(view.failed.length, 1);
  assert.equal(view.failed[0].error.code, "transcription_failed");
  assert.equal(view.sessionStatus, "active");
  assert.equal(view.origin, "asr");
});

test("parseTranscriptView sorts records by startMs and drops malformed entries", () => {
  const view = pipeline.parseTranscriptView({
    ...VIEW_ACTIVE,
    records: [
      { startMs: 30000, endMs: 60000, text: "第二段", origin: "asr" },
      { startMs: 0, endMs: 30000, text: "第一段", origin: "asr" },
      { startMs: 5000, endMs: 1000, text: "倒置的时间戳", origin: "asr" },
      { startMs: 0, endMs: 1000, text: "   ", origin: "asr" },
      null,
    ],
  });
  assert.deepEqual(
    view.records.map((record) => record.text),
    ["第一段", "第二段"],
    "records sort by startMs; empty text and inverted ranges drop",
  );
  assert.deepEqual(pipeline.parseTranscriptView(view), view, "a valid view round-trips");
});

test("parseTranscriptView returns null for garbage", () => {
  assert.equal(pipeline.parseTranscriptView(null), null);
  assert.equal(pipeline.parseTranscriptView({ error: { code: "x" } }), null);
  assert.equal(pipeline.parseTranscriptView({ ...VIEW_ACTIVE, records: "nope" }), null);
});

function pollerOptions(fetchImpl, overrides = {}) {
  return {
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sessionId: SESSION,
    pollIntervalMs: 4000,
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
    onView: () => {},
    onStop: () => {},
    ...overrides,
  };
}

/** A timer-stub clock: callbacks fire only when the test fires them. */
function manualTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeoutImpl: (fn, delay) => {
      const entry = { fn, delay, fired: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimeoutImpl: (entry) => {
      if (entry) entry.fired = true;
    },
    fireNext: () => {
      const entry = scheduled.find((candidate) => !candidate.fired);
      if (entry) {
        entry.fired = true;
        entry.fn();
      }
      return entry;
    },
  };
}

test("the poller GETs the transcript, reports the view, and reschedules at the interval", async () => {
  const timers = manualTimers();
  const calls = [];
  const views = [];
  const fetchImpl = jsonFetch({ status: 200, body: VIEW_ACTIVE }, calls);
  const poller = pipeline.createTranscriptPoller(
    pollerOptions(fetchImpl, {
      ...timers,
      onView: (view) => views.push(view),
    }),
  );
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "the first poll fires immediately");
  assert.equal(calls[0].url, `https://api.example.com/v1/sessions/${SESSION}/transcript`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(views.length, 1);
  assert.equal(views[0].sessionStatus, "active");
  const next = timers.scheduled[0];
  assert.equal(next.delay, 4000, "the next poll waits the configured interval");
  poller.stop();
});

test("the poller backs off exponentially while the network is down", async () => {
  const timers = manualTimers();
  const fetchImpl = async () => {
    throw new Error("down");
  };
  const poller = pipeline.createTranscriptPoller(
    pollerOptions(fetchImpl, { ...timers, pollIntervalMs: 4000 }),
  );
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.scheduled[0].delay, 8000, "first failure doubles the interval");
  await timers.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.scheduled[1].delay, 16000, "second failure doubles again");
  await timers.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.scheduled[2].delay, 30000, "the backoff caps at maxBackoffMs");
  await timers.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.scheduled[3].delay, 30000, "the cap holds");
  poller.stop();
});

test("the poller stops with the terminal view (finished and pending drained)", async () => {
  const timers = manualTimers();
  const stops = [];
  // api-session-transcript-asr-finished: terminal.
  const view = pipeline.parseTranscriptView({
    sessionId: "ses_01JABC0032",
    sourceId: "src_01JABC0002",
    resourceId: "res_01JABC0001",
    sessionStatus: "finished",
    origin: "asr",
    records: [{ startMs: 60000, endMs: 90000, text: "上一节我们留了一个问题：为什么要缩放点积", origin: "asr" }],
    gaps: [{ startMs: 150000, endMs: 210000, reason: "skipped" }],
    pending: [],
    failed: [
      { segmentIndex: 1, startMs: 210000, endMs: 240000, error: { code: "transcription_failed", message: "Speech Provider 返回 400：音频解码失败" } },
    ],
  });
  const fetchImpl = jsonFetch({ status: 200, body: view });
  const poller = pipeline.createTranscriptPoller(
    pollerOptions(fetchImpl, { ...timers, onStop: (info) => stops.push(info) }),
  );
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops.length, 1, "the terminal view stops the poller");
  assert.equal(stops[0].reason, "terminal");
  assert.equal(poller.running(), false);
  assert.equal(timers.scheduled.length, 0, "no further polls are scheduled");
});

test("the poller keeps polling briefly past finish until the tail results land", async () => {
  const timers = manualTimers();
  const stops = [];
  const poll = () => ({
    status: 200,
    ok: true,
    json: async () => ({
      ...VIEW_ACTIVE,
      sessionStatus: "finished",
      pending: [{ segmentIndex: 3, startMs: 90000, endMs: 120000, status: "transcribing" }],
    }),
  });
  const fetchImpl = async () => poll();
  const poller = pipeline.createTranscriptPoller(
    pollerOptions(fetchImpl, { ...timers, onStop: (info) => stops.push(info) }),
  );
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops.length, 0, "finished with pending keeps polling");
  // Drain to the bound: each fire schedules one more poll until the cap.
  for (let i = 0; i < pipeline.MAX_POST_FINISH_POLLS - 1; i += 1) {
    await timers.fireNext();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(stops.length, 0);
  await timers.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops.length, 1, "the bound stops the poller even with pending left");
  assert.equal(stops[0].reason, "terminal");
});

test("the poller reports 401 through onStop and never polls again", async () => {
  const timers = manualTimers();
  const stops = [];
  const fetchImpl = jsonFetch({ status: 401, body: { error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" } } });
  const poller = pipeline.createTranscriptPoller(
    pollerOptions(fetchImpl, { ...timers, onStop: (info) => stops.push(info) }),
  );
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops, [{ reason: "unauthorized", message: "凭据已失效，请重新登录并关联" }]);
  assert.equal(poller.running(), false);
  assert.equal(timers.scheduled.length, 0);
});

test("the poller reports 404 (D2 cross-account) through onStop", async () => {
  const timers = manualTimers();
  const stops = [];
  const fetchImpl = jsonFetch({ status: 404, body: { error: { code: "not_found", message: "资源不存在" } } });
  const poller = pipeline.createTranscriptPoller(
    pollerOptions(fetchImpl, { ...timers, onStop: (info) => stops.push(info) }),
  );
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reason, "notFound");
});

test("a malformed 200 body is a transient miss, not a stop", async () => {
  const timers = manualTimers();
  const stops = [];
  const views = [];
  const fetchImpl = jsonFetch({ status: 200, body: { unexpected: true } });
  const poller = pipeline.createTranscriptPoller(
    pollerOptions(fetchImpl, { ...timers, onView: (view) => views.push(view), onStop: (info) => stops.push(info) }),
  );
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(views.length, 0);
  assert.equal(stops.length, 0);
  assert.equal(timers.scheduled[0].delay, 8000, "the malformed body backs off like a network miss");
  poller.stop();
});

test("stop() cancels the scheduled poll and a stopped poller never fetches again", async () => {
  const timers = manualTimers();
  const calls = [];
  const fetchImpl = jsonFetch({ status: 200, body: VIEW_ACTIVE }, calls);
  const poller = pipeline.createTranscriptPoller(pollerOptions(fetchImpl, { ...timers }));
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  poller.stop();
  assert.equal(poller.running(), false);
  timers.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "the cancelled timer never fired another poll");
});

// ============================================================
// §2.5 → transcript-tab rows (the panel's render input)
// ============================================================

test("buildTranscriptRows merges records, gaps, pending and failed into one ordered list", () => {
  const view = pipeline.parseTranscriptView({
    sessionId: "ses_1",
    sourceId: "s",
    resourceId: "r",
    sessionStatus: "active",
    origin: "asr",
    records: [
      { startMs: 0, endMs: 30000, text: "第一段", origin: "asr" },
      { startMs: 60000, endMs: 90000, text: "第三段", origin: "asr" },
    ],
    gaps: [{ startMs: 120000, endMs: 150000, reason: "skipped" }],
    pending: [{ segmentIndex: 4, startMs: 150000, endMs: 180000, status: "transcribing" }],
    failed: [
      { segmentIndex: 3, startMs: 90000, endMs: 120000, error: { code: "transcription_failed", message: "Speech Provider 返回 429，重试后仍失败" } },
    ],
  });
  const rows = pipeline.buildTranscriptRows(view, []);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.startMs, row.text]),
    [
      ["record", 0, "第一段"],
      ["record", 60000, "第三段"],
      // The failed segment carries the server's message (契约文案), not a
      // local guess.
      ["failed", 90000, "转写失败：Speech Provider 返回 429，重试后仍失败"],
      // The skipped range renders with the PoC's gap-marker vocabulary.
      ["gap", 120000, "[已跳过 2:00–2:30]"],
      ["pending", 150000, "转写中…"],
    ],
  );
});

test("buildTranscriptRows adds local upload-outstanding segments as pending rows", () => {
  const view = pipeline.parseTranscriptView({
    sessionId: "ses_1",
    sourceId: "s",
    resourceId: "r",
    sessionStatus: "active",
    origin: "asr",
    records: [{ startMs: 0, endMs: 30000, text: "第一段", origin: "asr" }],
    gaps: [],
    // The server already knows segment 2 (60s–90s) is transcribing.
    pending: [{ segmentIndex: 2, startMs: 60000, endMs: 90000, status: "pending" }],
    failed: [],
  });
  // Local segments still uploading: 30s–60s (in flight) and 90s–120s
  // (the Segment captured before the upload chain reached it).
  const rows = pipeline.buildTranscriptRows(view, [
    { start: 30, duration: 30 },
    { start: 90, duration: 30 },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.startMs, row.text]),
    [
      ["record", 0, "第一段"],
      ["pending", 30000, "转写中…"],
      ["pending", 60000, "转写中…"],
      ["pending", 90000, "转写中…"],
    ],
  );
});

test("buildTranscriptRows drops local pending rows the server already knows about", () => {
  const view = pipeline.parseTranscriptView({
    sessionId: "ses_1",
    sourceId: "s",
    resourceId: "r",
    sessionStatus: "active",
    origin: "asr",
    records: [],
    gaps: [],
    pending: [{ segmentIndex: 0, startMs: 0, endMs: 30000, status: "transcribing" }],
    failed: [],
  });
  const rows = pipeline.buildTranscriptRows(view, [{ start: 0, duration: 30 }]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["pending"],
    "the same startMs renders once — the server's row wins",
  );
});

test("buildTranscriptRows renders an empty view as no rows", () => {
  const view = pipeline.parseTranscriptView({
    sessionId: "ses_1",
    sourceId: "s",
    resourceId: "r",
    sessionStatus: "active",
    origin: null,
    records: [],
    gaps: [],
    pending: [],
    failed: [],
  });
  assert.deepEqual(pipeline.buildTranscriptRows(view, []), []);
  // A malformed view yields no rows rather than a crash — the panel renders
  // its empty state.
  assert.deepEqual(pipeline.buildTranscriptRows(null, []), []);
});
