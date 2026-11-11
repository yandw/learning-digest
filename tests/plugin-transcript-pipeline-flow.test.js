/**
 * ASR-path flow (Ticket 2.4, issue #67): the worker orchestration behind
 * the audio-segment archive pipeline, in the plugin-bili-captions-flow
 * harness pattern.
 *
 * The flow under test (contract-r2.md, decisions D10/D11/D12/D15):
 * - 开始学习 on a no-captions platform → POST sessions (§3.1, the shared
 *   session-archive client) → 30s Segments cut by the segmenter →
 *   POST audio-segments (§3.4, the D11 upload client) → the transcript
 *   poll (§3.5) lands the Worker's rows, the 转写中 pendings and the
 *   契约文案 failure rows in the Session state;
 * - a transient upload failure replays the SAME body byte-for-byte (the
 *   (sessionId, segmentIndex) key is idempotent);
 * - the terminal verdicts stop or surface honestly: 409
 *   transcript_origin_conflict (D15) verbatim and no further uploads,
 *   401 → the P7 handleCredentialsInvalidated handoff;
 * - the P11 triggers (explicit end, media end, tab closed, capture ended)
 *   flush the tail Segment and finish the server Session (§3.2) with the
 *   seek-skipped ranges as gaps;
 * - a finished-with-nothing-pending view stands the poll down (状态单调)
 *   and the post-end drain runs on a budget.
 *
 * Request/response shapes follow contracts/fixtures/audio-task-examples.json
 * and session-examples.json / error-examples.json — the same fixtures the
 * API's tests pin.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

const XIAOE_LESSON = "https://app12345.xiaoe-tech.com/v_5f0abc123";

const FIXTURES_DIR = path.join(__dirname, "..", "contracts", "fixtures");
const fixture = (file, id) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), "utf8")).samples.find(
    (s) => s.id === id,
  );

const SESSION_CREATE = fixture("session-examples.json", "api-session-create-bilibili");
const TRANSCRIPT_ASR_ACTIVE = fixture(
  "session-examples.json",
  "api-session-transcript-asr-active",
);
const TRANSCRIPT_ASR_FINISHED = fixture(
  "session-examples.json",
  "api-session-transcript-asr-finished",
);
const FINISH_GAPS = fixture("session-examples.json", "api-session-finish-with-gaps");
const ORIGIN_CONFLICT = fixture("error-examples.json", "error-transcript-origin-conflict");
const ALREADY_FINISHED = fixture(
  "error-examples.json",
  "error-session-finish-already-finished",
);
const UPLOAD = fixture("audio-task-examples.json", "api-audio-segment-upload");

const RESOLVED_SOURCE = {
  id: "src_01JABC0002",
  resourceId: "res_01JABC0001",
  kind: "video",
  url: XIAOE_LESSON,
  platformId: "xiaoe-tech",
  platformVideoId: "v_5f0abc123",
  episodeId: null,
  platformScopeId: "app12345",
  progress: { positionMs: 0, revision: 1 },
};
const RESOLVE_MATCHED_BODY = {
  matched: true,
  resource: {
    id: "res_01JABC0001",
    title: "注意力机制详解",
    kind: "video",
    createdAt: "2026-11-10T08:00:00Z",
  },
  source: RESOLVED_SOURCE,
};

const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

const cutReply = (message) =>
  message.action === "captureCut"
    ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 30 }
    : { success: true };

/** Polls a getter until the predicate holds (the wiring runs fire-and-forget). */
async function until(getter, predicate, turns = 2000) {
  for (let i = 0; i < turns; i++) {
    const value = await getter();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

/**
 * One fetch seam for the whole ASR flow, recorded per /v1 call. Scripted
 * lists answer per call (last entry repeats); numbers become that status
 * with a generic error envelope.
 */
function v1Fetch({
  resolve = [],
  sessions = [],
  segments = [],
  transcripts = [],
  finishes = [],
} = {}) {
  const v1Calls = [];
  let resolveIndex = 0;
  let sessionsIndex = 0;
  let segmentsIndex = 0;
  let transcriptsIndex = 0;
  let finishesIndex = 0;
  const answer = (scripted, fallbackBody) => {
    if (scripted === null || scripted === undefined) {
      return { status: 200, ok: true, json: async () => fallbackBody };
    }
    if (typeof scripted === "number") {
      return {
        status: scripted,
        ok: false,
        json: async () => ({ error: { code: "boom", message: "boom" } }),
      };
    }
    return {
      status: scripted.status,
      ok: scripted.status < 400,
      json: async () => scripted.body,
    };
  };
  const fetchImpl = async (url, init) => {
    const pathName = String(url).replace(/^https:\/\/api\.example\.com/, "");
    if (pathName === "/v1/sources/resolve") {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return answer(resolve[resolveIndex++] ?? resolve[resolve.length - 1], {
        matched: false,
      });
    }
    if (/^\/v1\/sources\/[^/]+\/sessions$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return answer(sessions[sessionsIndex++] ?? sessions[sessions.length - 1], {
        session: SESSION_CREATE.response.body.session,
      });
    }
    if (/^\/v1\/sessions\/[^/]+\/audio-segments$/.test(pathName)) {
      v1Calls.push({
        path: pathName,
        method: init.method,
        rawBody: init.body,
        body: JSON.parse(init.body),
      });
      return answer(segments[segmentsIndex++] ?? segments[segments.length - 1], {
        segment: UPLOAD.response.body.segment,
      });
    }
    if (/^\/v1\/sessions\/[^/]+\/transcript$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method });
      return answer(
        transcripts[transcriptsIndex++] ?? transcripts[transcripts.length - 1],
        TRANSCRIPT_ASR_ACTIVE.response.body,
      );
    }
    if (/^\/v1\/sessions\/[^/]+\/finish$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body || "{}") });
      return answer(finishes[finishesIndex++] ?? finishes[finishes.length - 1], {
        session: FINISH_GAPS.response.body.session,
      });
    }
    if (/^\/v1\/sources\/[^/]+\/progress$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return { status: 200, ok: true, json: async () => ({ positionMs: 0, revision: 1 }) };
    }
    // The end-of-Session AI pass (and anything else non-/v1).
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ topics: [], quotes: [], todos: [] }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    };
  };
  return { v1Calls, fetchImpl };
}

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.example.com/ai",
    aiModel: "test-model",
    apiBaseUrl: "https://api.example.com",
    segmentLengthSeconds: 30,
    summaryIntervalMinutes: 30,
    ...overrides,
  };
}

/**
 * The ASR flow's sandbox. Transcript-poll timers are CAPTURED, never
 * fired: each scheduled beat lands in `timers` as {fn, delay}, and the
 * test drives beats by hand — the poll cadence, the backoff and the
 * drain budget become deterministic assertions.
 */
const asrFlowHelpers = ({ fetchImpl, timers, ...rest } = {}) =>
  loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: XIAOE_LESSON, title: "课程" }),
    fetchImpl,
    sendMessageImpl: cutReply,
    setTimeoutImpl: timers
      ? (fn, delay) => {
          timers.push({ fn, delay });
          return timers.length;
        }
      : undefined,
    ...rest,
  });

/** Starts an ASR Session on the xiaoe lesson and waits for the start beat. */
async function startAsrSession(helpers, fetchSeams) {
  const started = await helpers.handleStartLearning({ url: XIAOE_LESSON, tabId: 2 });
  assert.equal(started.success, true, started.error || "");
  return started;
}

// --- the full pipeline: start → upload → poll → rows -----------------------------

test("开始学习 on a no-captions platform creates the server Session, uploads Segments, and the poll lands the view", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: SESSION_CREATE.response.body }],
    segments: [{ status: 201, body: UPLOAD.response.body }],
    // The first (start) beat sees an empty active view; the second beat is
    // the fixture's in-progress view (a record, a pending, a failed).
    transcripts: [
      {
        status: 200,
        body: {
          sessionId: SESSION_CREATE.response.body.session.id,
          sourceId: "src_01JABC0002",
          resourceId: "res_01JABC0001",
          sessionStatus: "active",
          origin: null,
          records: [],
          gaps: [],
          pending: [],
          failed: [],
        },
      },
      { status: 200, body: TRANSCRIPT_ASR_ACTIVE.response.body },
    ],
  });
  const sentMessages = [];
  const helpers = asrFlowHelpers({ fetchImpl, timers, sentMessages });

  const started = await startAsrSession(helpers);

  // §3.1 ran before any capture machinery: the server Session exists and
  // the pointer carries it on the asr path.
  const sessionCall = v1Calls.find((call) => call.path.endsWith("/sessions"));
  assert.ok(sessionCall, "POST /v1/sources/{id}/sessions went out");
  assert.equal(sessionCall.method, "POST");
  assert.deepEqual(sessionCall.body, {});
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "asr");
  assert.equal(pointer.serverSessionId, "ses_01JABC0033");

  // The first poll beat happened at start (the render never waits a
  // cadence) and armed the recurring poll at the §3.5 cadence.
  assert.equal(
    v1Calls.filter((call) => call.path.endsWith("/transcript")).length,
    1,
    "one transcript beat at start",
  );
  assert.ok(timers.length >= 1, "the recurring poll is armed");
  assert.equal(timers[0].delay, 4000);

  // 30s of playback: the Segment uploads as the D11 contract body.
  await helpers.handleMediaPosition({ position: 30 }, { tab: { id: 2 } });
  const segmentCalls = await until(
    () => v1Calls.filter((call) => call.path.endsWith("/audio-segments")),
    (calls) => calls.length === 1,
  );
  assert.ok(segmentCalls, "the Segment upload went out");
  assert.deepEqual(segmentCalls[0].body, {
    segmentIndex: 0,
    startMs: 0,
    durationMs: 30000,
    audioMimeType: "audio/webm",
    audioBase64: "SGk=",
  });

  // Accepted locally with no records: the text arrives via the poll.
  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.equal(snapshot.segments[0].status, "done");
  assert.equal(snapshot.transcriptRecords.length, 0);

  // The next poll beat lands the Worker's view: rows + the 契约文案 failed
  // row + the 转写中 pending, all mapped to seconds, origin asr.
  await timers.shift().fn();
  const synced = await until(
    () => helpers.readStored(`ytd_session_${started.sessionId}`),
    (state) => (state.transcriptRecords || []).length > 0,
  );
  assert.ok(synced, "the poll adopted the view");
  assert.equal(synced.transcriptOrigin, "asr");
  assert.deepEqual(
    synced.transcriptRecords.map((record) => ({
      start: record.start,
      duration: record.duration,
      text: record.text,
      failed: record.failed === true,
    })),
    [
      { start: 0, duration: 30, text: "欢迎来到这一节，我们先回顾上一课留下的三个问题", failed: false },
      { start: 30, duration: 30, text: "注意力分数的计算，就是把查询向量和键向量做点积", failed: false },
      {
        start: 60,
        duration: 30,
        text: "[Speech Provider 返回 429，重试后仍失败]",
        failed: true,
      },
    ],
  );
  assert.deepEqual(
    synced.pendingSegments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
      status: segment.status,
    })),
    [{ start: 90, duration: 30, status: "pending" }],
  );

  // The panel saw the same state (the broadcast carries it).
  const update = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.state === synced,
  );
  assert.ok(update, "the adopted view was broadcast to the panel");

  await helpers.handleEndLearning();
});

test("a transient upload failure replays the same body byte-for-byte and the stored replay settles the Segment", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    // 503 then the idempotent replay (200, the stored Segment).
    segments: [
      { status: 503, body: { error: { code: "boom", message: "down" } } },
      { status: 200, body: UPLOAD.response.body },
    ],
  });
  const helpers = asrFlowHelpers({ fetchImpl, timers });

  await startAsrSession(helpers);
  await helpers.handleMediaPosition({ position: 30 }, { tab: { id: 2 } });

  const calls = await until(
    () => v1Calls.filter((call) => call.path.endsWith("/audio-segments")),
    (calls) => calls.length === 2,
  );
  assert.ok(calls, "the upload retried after the transient failure");
  assert.equal(calls[0].rawBody, calls[1].rawBody, "byte-for-byte replay");
  assert.deepEqual(calls[1].body, {
    segmentIndex: 0,
    startMs: 0,
    durationMs: 30000,
    audioMimeType: "audio/webm",
    audioBase64: "SGk=",
  });

  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = await until(
    () => helpers.readStored(`ytd_session_${pointer.sessionId}`),
    (state) => state.segments[0]?.status === "done",
  );
  assert.ok(snapshot, "the replay accepted the Segment exactly once");

  await helpers.handleEndLearning();
});

// --- the terminal verdicts -------------------------------------------------------

test("a 409 transcript_origin_conflict from the upload surfaces verbatim and stops further uploads", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    segments: [
      { status: ORIGIN_CONFLICT.response.status, body: ORIGIN_CONFLICT.response.body },
    ],
  });
  const sentMessages = [];
  const helpers = asrFlowHelpers({ fetchImpl, timers, sentMessages });

  await startAsrSession(helpers);
  await helpers.handleMediaPosition({ position: 30 }, { tab: { id: 2 } });

  const calls = await until(
    () => v1Calls.filter((call) => call.path.endsWith("/audio-segments")),
    (calls) => calls.length === 1,
  );
  assert.ok(calls, "the upload attempt went out");

  // 如实呈现: the panel learns the conflict through the server's own message.
  const notice = await until(
    () =>
      sentMessages.find(
        (message) => message.action === "sessionUpdate" && message.captureNotice,
      ),
    (message) => message,
  );
  assert.ok(notice, "the conflict reached the panel");
  assert.equal(notice.captureNotice, ORIGIN_CONFLICT.response.body.error.message);

  // The Segment keeps its honest local failure marker.
  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.equal(snapshot.segments[0].status, "failed");
  assert.ok(
    snapshot.transcriptRecords.some((record) => record.failed === true),
    "the failed Segment shows its failure row",
  );

  // The pipeline stands down: the next Segment dispatch uploads nothing.
  // (90 is the seek that regrids the cursor; 120 emits the next Segment.)
  await helpers.handleMediaPosition({ position: 90 }, { tab: { id: 2 } });
  await helpers.handleMediaPosition({ position: 120 }, { tab: { id: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    v1Calls.filter((call) => call.path.endsWith("/audio-segments")).length,
    1,
    "no further audio uploads after the origin conflict",
  );

  await helpers.handleEndLearning();
});

test("a 401 upload routes the P7 credentials-invalidated handoff", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    segments: [
      {
        status: 401,
        body: { error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" } },
      },
    ],
  });
  const sentMessages = [];
  const helpers = asrFlowHelpers({ fetchImpl, timers, sentMessages });

  await startAsrSession(helpers);
  await helpers.handleMediaPosition({ position: 30 }, { tab: { id: 2 } });

  // P7: the capture stops (the pointer clears, the local Session ends) and
  // the panel is pushed back to the guide. until resolves undefined when
  // the pointer is gone (the predicate holds on the first read).
  const stopped = await until(
    () => helpers.readStored("ytd_active_capture"),
    (pointer) => !pointer,
  );
  assert.equal(stopped, undefined, "the capture pointer cleared");
  const authState = sentMessages.find(
    (message) => message.action === "authState" && message.authorized === false,
  );
  assert.ok(authState, "the panel re-gates");
  assert.equal(authState.reason, "unauthorized");

  // The end path still closed the server Session (its finish meets the
  // same dead credential — the P7 handoff already ran, and the repeated
  // invalidation is a calm no-op).
  assert.ok(
    v1Calls.some((call) => call.path.endsWith("/finish")),
    "the server Session was finished on the way out",
  );
});

// --- the P11 收尾: flush + finish (§3.2) ------------------------------------------

/**
 * Drives one Session to the end through the given P11 trigger, with a
 * seek-skipped range [30s, 210s) and a partial tail Segment [210s, 225s)
 * that only the end flush can cut. Returns the recorded v1 calls.
 */
async function driveToEnd(trigger) {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    segments: [{ status: 201, body: UPLOAD.response.body }],
    transcripts: [
      {
        status: 200,
        body: {
          sessionId: SESSION_CREATE.response.body.session.id,
          sourceId: "src_01JABC0002",
          resourceId: "res_01JABC0001",
          sessionStatus: "active",
          origin: "asr",
          records: [],
          gaps: [],
          pending: [],
          failed: [],
        },
      },
    ],
  });
  const helpers = asrFlowHelpers({ fetchImpl, timers });
  await startAsrSession(helpers);

  // 30s watched → Segment 0 uploads. Then a drag to 3:30 marks the
  // seek-skipped range, and playback crawls (never a >3s hop) to 3:45 —
  // inside the uncompleted Segment, so only the end flush can cut it.
  await helpers.handleMediaPosition({ position: 30 }, { tab: { id: 2 } });
  await until(
    () => v1Calls.filter((call) => call.path.endsWith("/audio-segments")),
    (calls) => calls.length === 1,
  );
  await helpers.handleMediaPosition({ position: 210 }, { tab: { id: 2 } });
  for (const position of [212, 215, 218, 221, 224, 225]) {
    await helpers.handleMediaPosition({ position }, { tab: { id: 2 } });
  }

  if (trigger === "explicit") {
    await helpers.handleEndLearning();
  } else if (trigger === "mediaEnded") {
    await helpers.handleMediaPosition({ position: 225, ended: true }, { tab: { id: 2 } });
  } else if (trigger === "tabClosed") {
    await helpers.handleTabRemoved(2);
  } else if (trigger === "captureEnded") {
    await helpers.handleCaptureEnded({}, { tab: { id: 2 } });
  }

  // The finish went out; wait for it (the tail flush runs first). The
  // count can jump past one while a trigger's floating work settles, so
  // the predicate is "at least one".
  const finished = await until(
    () => v1Calls.filter((call) => call.path.endsWith("/finish")),
    (calls) => calls.length >= 1,
  );
  assert.ok(finished, "POST finish went out");
  return { v1Calls, helpers };
}

test("each P11 trigger flushes the tail Segment and finishes with the seek-skipped gaps", async () => {
  for (const trigger of ["explicit", "mediaEnded", "tabClosed", "captureEnded"]) {
    const { v1Calls } = await driveToEnd(trigger);

    // The finish body carries the seek-skipped range in contract units.
    const finishCall = v1Calls.find((call) => call.path.endsWith("/finish"));
    assert.deepEqual(
      finishCall.body,
      { gaps: [{ startMs: 30000, endMs: 210000 }] },
      `[${trigger}] the finish reports the seek-skipped range`,
    );

    // The flushed tail is the 15s partial past the gap, uploaded BEFORE
    // the finish (a Segment arriving after finish would meet 409
    // session_already_finished).
    const segmentCalls = v1Calls.filter((call) =>
      call.path.endsWith("/audio-segments"),
    );
    assert.equal(segmentCalls.length, 2, `[${trigger}] Segment 0 + the flushed tail`);
    assert.deepEqual(
      segmentCalls[1].body,
      {
        segmentIndex: 1,
        startMs: 210000,
        durationMs: 15000,
        audioMimeType: "audio/webm",
        audioBase64: "SGk=",
      },
      `[${trigger}] the tail Segment is the partial past the gap`,
    );
    const finishIndex = v1Calls.findIndex((call) => call.path.endsWith("/finish"));
    const tailIndex = v1Calls.findIndex(
      (call) => call.path.endsWith("/audio-segments") && call.body.segmentIndex === 1,
    );
    assert.ok(tailIndex < finishIndex, `[${trigger}] the tail uploaded before the finish`);
  }
});

test("a finish 409 session_already_finished stays calm — the Session still ends", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    finishes: [
      { status: ALREADY_FINISHED.response.status, body: ALREADY_FINISHED.response.body },
    ],
  });
  const helpers = asrFlowHelpers({ fetchImpl, timers });

  await startAsrSession(helpers);
  const ended = await helpers.handleEndLearning();
  assert.equal(ended.success, true, "the repeat finish is not a local failure");
  assert.equal(
    v1Calls.filter((call) => call.path.endsWith("/finish")).length,
    1,
  );
});

// --- the §3.5 poll schedule: backoff, drain budget, stand-down --------------------

test("the poll backs off after a failed beat and stands down on the terminal view", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    // The start beat misses (500 → backoff); so does the first fired beat;
    // the second fired beat answers the fixture's finished view (nothing
    // pending → terminal stand-down).
    transcripts: [
      { status: 500, body: { error: { code: "boom", message: "down" } } },
      { status: 500, body: { error: { code: "boom", message: "down" } } },
      { status: 200, body: TRANSCRIPT_ASR_FINISHED.response.body },
    ],
  });
  const helpers = asrFlowHelpers({ fetchImpl, timers });
  await startAsrSession(helpers);

  // The start beat missed (500): the armed retry doubles the wait.
  assert.equal(timers[0].delay, 4000);
  await timers.shift().fn();
  assert.equal(timers.length, 1, "the chain re-armed after the miss");
  assert.equal(timers[0].delay, 8000, "one miss doubles the wait");

  // The terminal view (finished, nothing pending) stands the chain down:
  // no further beats are scheduled, even with the drain budget.
  await timers.shift().fn();
  assert.equal(
    timers.length,
    0,
    "no poll is scheduled after the terminal view",
  );
  const beats = v1Calls.filter((call) => call.path.endsWith("/transcript")).length;
  assert.equal(beats, 3, "start beat + the two fired beats");

  await helpers.handleEndLearning();
});

// --- the orphan close --------------------------------------------------------------

test("a failed capture start closes the orphan server Session it created", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
  });
  const helpers = asrFlowHelpers({
    fetchImpl,
    timers,
    getMediaStreamId: async () => {
      throw new Error("Extension has not been invoked");
    },
  });

  const started = await helpers.handleStartLearning({ url: XIAOE_LESSON, tabId: 2 });
  assert.equal(started.success, false);
  assert.match(started.error, /工具栏/);

  const finishCall = await until(
    () => v1Calls.find((call) => call.path.endsWith("/finish")),
    (call) => call,
  );
  assert.ok(finishCall, "the orphan server Session was finished");
  assert.deepEqual(finishCall.body, {}, "no gaps: nothing was skipped yet");
  assert.equal(helpers.readStored("ytd_active_capture"), undefined);
});
