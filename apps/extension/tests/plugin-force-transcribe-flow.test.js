/**
 * Forced-transcription flow (Ticket 2.7, issue #70, decisions D15): the
 * worker orchestration behind 字幕覆盖不全 → 强制转写, in the
 * plugin-bili-captions-flow harness pattern.
 *
 * The D15 shape under test (contract-r2.md §3.3/§3.5, decisions D15):
 * - a captions read that does NOT cover the studied interval starts the
 *   Session with the captions archive DEFERRED (D15's 建议: submit once,
 *   after the path is committed, before finish) — the state lands the
 *   pending decision and the panel offers 强制转写 / 按原样归档字幕;
 * - 按原样归档字幕 (or the finish-time default) submits the captions
 *   as-read — the origin locks captions, never double-written;
 * - 强制转写 BEFORE any captions POST switches the SAME Session to the asr
 *   path (capture → transcript-pipeline upload → §3.5 poll): the captions
 *   are never submitted, 同区间单一路径 holds client-side;
 * - 强制转写 AFTER the captions archived opens a NEW Session on the asr
 *   path (the contract has no un-archive: the old Session keeps its
 *   captions, the new one runs ASR — 跨 Session 可换路径);
 * - the server's 409 transcript_origin_conflict stays the backstop: a
 *   switched Session that somehow meets it surfaces the verdict verbatim
 *   and stops uploading (如实呈现).
 *
 * Request/response shapes follow contracts/fixtures/session-examples.json
 * and error-examples.json — the same fixtures the API's tests pin.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

const BILI_P2 = "https://www.bilibili.com/video/BV1ab411L78c?p=2";

// Shared API fixtures stay in the repo-root contracts/ unit; the tests here
// read across the unit boundary (three levels up from apps/extension/tests).
const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "contracts", "fixtures");
const sessionSample = (id) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "session-examples.json"), "utf8")).samples.find(
    (s) => s.id === id,
  );
const errorSample = (id) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "error-examples.json"), "utf8")).samples.find(
    (s) => s.id === id,
  );

const SESSION_CREATE = sessionSample("api-session-create-bilibili");
const CAPTIONS_ARCHIVE = sessionSample("api-session-captions-archive");
const TRANSCRIPT_FINISHED = sessionSample("api-session-transcript-captions-finished");
const FINISH_GAPS = sessionSample("api-session-finish-with-gaps");
const ORIGIN_CONFLICT = errorSample("error-transcript-origin-conflict");

const AUDIO_UPLOAD = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "audio-task-examples.json"), "utf8"),
).samples.find((s) => s.id === "api-audio-segment-upload");

const RESOLVED_SOURCE = {
  id: "src_01JABC0002",
  resourceId: "res_01JABC0001",
  kind: "video",
  url: BILI_P2,
  platformId: "bilibili",
  platformVideoId: "BV1ab411L78c",
  episodeId: "2",
  platformScopeId: null,
  progress: { positionMs: 100000, revision: 2 },
};
const RESOLVE_MATCHED_BODY = {
  matched: true,
  resource: {
    id: "res_01JABC0001",
    title: "注意力机制详解 P2：自注意力",
    kind: "video",
    createdAt: "2026-11-10T08:00:00Z",
  },
  source: RESOLVED_SOURCE,
};

const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

// The studied interval the start probe sees: playback at 100s of a 600s
// video (the P11 seek landed the learner at the saved position). The
// captions track covers 60s–300s only — the [300s, 600s] tail is bare.
const MEDIA_POSITION_ANSWER = {
  success: true,
  position: 100,
  duration: 600,
  paused: false,
  ended: false,
};
const PARTIAL_CAPTIONS_SEGMENTS = [
  { startMs: 60000, endMs: 90000, text: "这一节我们把注意力分数放到矩阵上看" },
  { startMs: 270000, endMs: 300000, text: "Q K V 三个矩阵各司其职" },
];
const PARTIAL_COVERAGE = {
  covered: false,
  uncovered: [{ startMs: 300000, endMs: 600000 }],
};

/**
 * The tab seam: the bridge answers the start probe's getMediaPosition with
 * the studied interval, and the captions command with the given reply shape.
 */
function partialCoverageTabMessage({ position = true, coverage = PARTIAL_COVERAGE } = {}) {
  return (message) => {
    if (message.action === "getMediaPosition") {
      return position ? MEDIA_POSITION_ANSWER : { success: true };
    }
    if (message.action === "getBilibiliCaptions") {
      const reply = {
        success: true,
        available: true,
        segments: PARTIAL_CAPTIONS_SEGMENTS,
        track: { lan: "zh-CN", ai: false },
      };
      if (coverage) reply.coverage = coverage;
      return reply;
    }
    return { success: true };
  };
}

/** One fetch seam for the whole flow, recorded per /v1 call. */
function v1Fetch({
  resolve = [],
  sessions = [],
  captions = [],
  segments = [],
  transcripts = [],
  finishes = [],
} = {}) {
  const v1Calls = [];
  let resolveIndex = 0;
  let sessionsIndex = 0;
  let captionsIndex = 0;
  let segmentsIndex = 0;
  let transcriptsIndex = 0;
  let finishesIndex = 0;
  const answer = (scripted, fallbackBody) => {
    if (scripted === null || scripted === undefined) {
      return { status: 200, ok: true, json: async () => fallbackBody };
    }
    if (typeof scripted === "number") {
      return { status: scripted, ok: false, json: async () => ({ error: { code: "boom" } }) };
    }
    return { status: scripted.status, ok: scripted.status < 400, json: async () => scripted.body };
  };
  const fetchImpl = async (url, init) => {
    const pathName = String(url).replace(/^https:\/\/api\.example\.com/, "");
    if (pathName === "/v1/sources/resolve") {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return answer(resolve[resolveIndex++] ?? resolve[resolve.length - 1], { matched: false });
    }
    if (/^\/v1\/sources\/[^/]+\/sessions$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return answer(
        sessions[sessionsIndex++] ?? sessions[sessions.length - 1],
        { session: SESSION_CREATE.response.body.session },
      );
    }
    if (/^\/v1\/sessions\/[^/]+\/captions$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return answer(
        captions[captionsIndex++] ?? captions[captions.length - 1],
        { transcript: CAPTIONS_ARCHIVE.response.body.transcript },
      );
    }
    if (/^\/v1\/sessions\/[^/]+\/audio-segments$/.test(pathName)) {
      v1Calls.push({
        path: pathName,
        method: init.method,
        rawBody: init.body,
        body: JSON.parse(init.body),
      });
      return answer(
        segments[segmentsIndex++] ?? segments[segments.length - 1],
        { segment: AUDIO_UPLOAD.response.body.segment },
      );
    }
    if (/^\/v1\/sessions\/[^/]+\/transcript$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: undefined });
      return answer(
        transcripts[transcriptsIndex++] ?? transcripts[transcripts.length - 1],
        TRANSCRIPT_FINISHED.response.body,
      );
    }
    if (/^\/v1\/sessions\/[^/]+\/finish$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body || "{}") });
      return answer(
        finishes[finishesIndex++] ?? finishes[finishes.length - 1],
        { session: FINISH_GAPS.response.body.session },
      );
    }
    if (/^\/v1\/sources\/[^/]+\/progress$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return { status: 200, ok: true, json: async () => ({ positionMs: 0, revision: 1 }) };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: JSON.stringify({ topics: [], quotes: [], todos: [] }) },
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
    segmentLengthSeconds: 60,
    summaryIntervalMinutes: 30,
    ...overrides,
  };
}

const cutReply = (message) =>
  message.action === "captureCut"
    ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
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

function flowHelpers({ fetchImpl, timers, tabMessageImpl, sentMessages, ...rest } = {}) {
  return loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: BILI_P2, title: "视频课 P2" }),
    fetchImpl,
    tabMessageImpl,
    sentMessages,
    sendMessageImpl: cutReply,
    setTimeoutImpl: timers
      ? (fn, delay) => {
          timers.push({ fn, delay });
          return timers.length;
        }
      : undefined,
    ...rest,
  });
}

// --- the pending-coverage start: the archive is deferred, the decision lands ---

test("字幕覆盖不全的开始推迟字幕归档，并在状态里落待选择", async () => {
  const tabMessages = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
  });
  const helpers = flowHelpers({
    fetchImpl,
    tabMessageImpl: partialCoverageTabMessage(),
    tabMessages,
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true, started.error || "");

  // The start probed the studied interval first: the captions command
  // carries [position, duration] so the page reader computes coverage over
  // 本次学习起止 (the interval the learner actually resumes into).
  const captionsMessage = tabMessages.find((message) => message.action === "getBilibiliCaptions");
  assert.ok(captionsMessage, "the captions command went out");
  assert.equal(captionsMessage.intervalStartMs, 100000);
  assert.equal(captionsMessage.intervalEndMs, 600000);

  // D15: the archive is deferred — no captions POST until the learner
  // chooses. The server Session exists (§3.1) on the captions path.
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/captions")),
    false,
    "the captions archive waits for the learner's decision",
  );
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "captions");
  assert.ok(pointer.serverSessionId);

  // The pending decision is durable Session state: what the reader saw
  // (covered range + uncovered ranges) and the deferred segments themselves.
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.deepEqual(snapshot.captionsCoverage, {
    covered: false,
    coveredRange: { startMs: 60000, endMs: 300000 },
    uncovered: [{ startMs: 300000, endMs: 600000 }],
    segments: PARTIAL_CAPTIONS_SEGMENTS,
  });
  assert.equal(snapshot.transcriptOrigin, null);

  await helpers.handleEndLearning();
});

test("按原样归档字幕提交推迟的字幕，origin 锁 captions", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
    transcripts: [
      {
        status: 200,
        body: {
          sessionId: SESSION_CREATE.response.body.session.id,
          sourceId: "src_01JABC0002",
          resourceId: "res_01JABC0001",
          sessionStatus: "active",
          origin: "captions",
          records: [],
          gaps: [],
          pending: [],
          failed: [],
        },
      },
    ],
  });
  const helpers = flowHelpers({
    fetchImpl,
    tabMessageImpl: partialCoverageTabMessage(),
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);

  const archived = await helpers.handleArchiveCaptionsNow();
  assert.equal(archived.success, true, archived.error || "");

  // The deferred segments went out as-read (§3.3 按原样归档), and the poll
  // re-synced the server view: origin captions, locked once.
  const captionsCall = v1Calls.find((call) => call.path.endsWith("/captions"));
  assert.ok(captionsCall, "POST /v1/sessions/{id}/captions went out");
  assert.deepEqual(captionsCall.body, {
    segments: PARTIAL_CAPTIONS_SEGMENTS,
  });
  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.equal(snapshot.transcriptOrigin, "captions");

  // A second archive request is a no-op: the origin is locked, the path is
  // committed (首存为准 — the server would answer 200 anyway).
  const callsBefore = v1Calls.filter((call) => call.path.endsWith("/captions")).length;
  const again = await helpers.handleArchiveCaptionsNow();
  assert.equal(again.success, true);
  assert.equal(
    v1Calls.filter((call) => call.path.endsWith("/captions")).length,
    callsBefore,
    "the committed path does not re-submit",
  );

  await helpers.handleEndLearning();
});

// --- the same-Session switch: 强制转写 before any captions POST -----------------

test("未归档字幕的强制转写：同一 Session 整段切 ASR，从不提交字幕", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    segments: [{ status: 201, body: AUDIO_UPLOAD.response.body }],
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
      {
        status: 200,
        body: {
          sessionId: SESSION_CREATE.response.body.session.id,
          sourceId: "src_01JABC0002",
          resourceId: "res_01JABC0001",
          sessionStatus: "active",
          origin: "asr",
          records: [{ startMs: 100000, endMs: 160000, text: "语音转写的第一段" }],
          gaps: [],
          pending: [],
          failed: [],
        },
      },
    ],
  });
  const sentMessages = [];
  const helpers = flowHelpers({
    fetchImpl,
    timers,
    tabMessageImpl: partialCoverageTabMessage(),
    sentMessages,
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);
  const pointerBefore = helpers.readStored("ytd_active_capture");

  // Playback during the pending window: the switch point is the studied
  // interval's current position (100s), and ASR covers from there.
  await helpers.handleMediaPosition({ position: 100 }, { tab: { id: 2 } });

  const switched = await helpers.handleForceTranscribe();
  assert.equal(switched.success, true, switched.error || "");
  assert.equal(switched.capturePath, "asr");
  assert.equal(
    switched.sessionId,
    pointerBefore.sessionId,
    "the SAME local Session continues on the asr path",
  );

  // 同区间单一路径, client side: the captions were never submitted.
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/captions")),
    false,
    "no captions POST before or after the switch",
  );

  // The pointer carries the switched path on the SAME server Session (§3.4
  // uploads go against the Session the captions path created).
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "asr");
  assert.equal(pointer.serverSessionId, pointerBefore.serverSessionId);

  // The capture machinery is live: 60s of playback past the switch point
  // cuts and uploads exactly one Segment against the same server Session
  // (§3.4), covering [switch point, now].
  await helpers.handleMediaPosition({ position: 160 }, { tab: { id: 2 } });
  const segmentCalls = await until(
    () => v1Calls.filter((call) => call.path.endsWith("/audio-segments")),
    (calls) => calls.length === 1,
  );
  assert.ok(segmentCalls, "the switched Session uploads audio Segments");
  assert.equal(segmentCalls[0].body.segmentIndex, 0);
  assert.equal(segmentCalls[0].body.startMs, 100000, "the Segment covers from the switch point");
  assert.equal(segmentCalls[0].body.durationMs, 60000);

  // The §3.5 poll runs the asr cadence and stamps the origin when the view
  // syncs (the switch itself submitted nothing — D15: 首次提交锁定 origin).
  // (timers[0] is the captions read's own race timeout — the poll beat is
  // the 4s entry.)
  const pollBeat = timers.find((timer) => timer.delay === 4000);
  assert.ok(pollBeat, "the asr poll is armed at the §3.5 cadence");
  await pollBeat.fn();
  const snapshot = await until(
    () => helpers.readStored(`ytd_session_${pointer.sessionId}`),
    (state) => state.transcriptOrigin === "asr",
  );
  assert.ok(snapshot, "the poll stamped origin asr");
  assert.equal(snapshot.capturePath, "asr");
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => record.text),
    ["语音转写的第一段"],
  );

  await helpers.handleEndLearning();
});

test("the switched Session keeps the progress writer and locks P10 as before", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
  });
  const helpers = flowHelpers({
    fetchImpl,
    tabMessageImpl: partialCoverageTabMessage(),
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);
  await helpers.handleMediaPosition({ position: 100 }, { tab: { id: 2 } });
  await helpers.handleForceTranscribe();

  const target = helpers.readStored("ytd_learning_target");
  assert.equal(target.status, "locked", "the P10 lock survives the switch");
  assert.equal(target.sessionId, started.sessionId);

  await helpers.handleMediaPosition({ position: 160 }, { tab: { id: 2 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    v1Calls.some((call) => call.path.includes("/progress")),
    "the position stream still feeds the progress writer",
  );

  await helpers.handleEndLearning();
});

test("the finish-time default archives the deferred captions (用户不选 → 按原样归档)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = flowHelpers({
    fetchImpl,
    tabMessageImpl: partialCoverageTabMessage(),
  });

  await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  const ended = await helpers.handleEndLearning();
  assert.equal(ended.success, true);

  // The never-answered decision resolves at finish: the captions POST (with
  // the deferred as-read segments) lands BEFORE the finish, so the origin
  // locks captions and the server Session closes on a non-empty archive.
  const captionsIndex = v1Calls.findIndex((call) => call.path.endsWith("/captions"));
  const finishIndex = v1Calls.findIndex((call) => call.path.endsWith("/finish"));
  assert.ok(captionsIndex >= 0, "the default archive ran at finish");
  assert.ok(finishIndex > captionsIndex, "the archive lands before the finish");
  assert.deepEqual(v1Calls[captionsIndex].body, { segments: PARTIAL_CAPTIONS_SEGMENTS });
});

// --- the archived branch: 强制转写 after the captions locked --------------------

test("已归档字幕的强制转写：按契约开新 Session 重走（旧 Session 保留字幕）", async () => {
  const timers = [];
  const SECOND_SESSION = {
    ...SESSION_CREATE.response.body.session,
    id: "ses_01JABC0099",
  };
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [
      { status: 201, body: { session: SESSION_CREATE.response.body.session } },
      { status: 201, body: { session: SECOND_SESSION } },
    ],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
    segments: [{ status: 201, body: AUDIO_UPLOAD.response.body }],
    transcripts: [
      {
        status: 200,
        body: {
          sessionId: SESSION_CREATE.response.body.session.id,
          sourceId: "src_01JABC0002",
          resourceId: "res_01JABC0001",
          sessionStatus: "active",
          origin: "captions",
          records: [{ startMs: 60000, endMs: 90000, text: "字幕已归档" }],
          gaps: [],
          pending: [],
          failed: [],
        },
      },
    ],
  });
  const helpers = flowHelpers({
    fetchImpl,
    timers,
    // Full-coverage captions (no coverage block): the start archives at
    // once, exactly as 2.5 shipped.
    tabMessageImpl: partialCoverageTabMessage({ coverage: null }),
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);
  assert.equal(started.capturePath, "captions");
  const pointerBefore = helpers.readStored("ytd_active_capture");
  assert.equal(helpers.readStored(`ytd_session_${pointerBefore.sessionId}`).transcriptOrigin, "captions");

  const forced = await helpers.handleForceTranscribe();
  assert.equal(forced.success, true, forced.error || "");
  assert.equal(forced.capturePath, "asr");
  assert.notEqual(
    forced.sessionId,
    pointerBefore.sessionId,
    "the switch is a NEW local Session (the contract has no un-archive)",
  );

  // The old server Session was finished, not un-archived (跨 Session 可换路径:
  // the old Session keeps its captions; the new one runs ASR).
  const finishCalls = v1Calls.filter((call) => call.path.endsWith("/finish"));
  assert.equal(finishCalls.length, 1, "the old server Session finished exactly once");
  const captionsCalls = v1Calls.filter((call) => call.path.endsWith("/captions"));
  assert.equal(captionsCalls.length, 1, "the new Session never re-submits captions");
  assert.equal(
    captionsCalls[0].path.includes(SESSION_CREATE.response.body.session.id),
    true,
    "the captions POST belonged to the OLD server Session",
  );

  // The new Session runs the ASR path end to end: §3.1 create → §3.4 upload
  // → §3.5 poll, against ITS server Session.
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "asr");
  assert.equal(pointer.serverSessionId, SECOND_SESSION.id);
  await helpers.handleMediaPosition({ position: 160 }, { tab: { id: 2 } });
  const segmentCalls = await until(
    () => v1Calls.filter((call) => call.path.endsWith("/audio-segments")),
    (calls) => calls.some((call) => call.path.includes(SECOND_SESSION.id)),
  );
  assert.ok(segmentCalls, "the new Session uploads audio against its own server Session");

  await helpers.handleEndLearning();
});

// --- the server-side backstop: 409 transcript_origin_conflict -------------------

test("the server's origin lock stays the backstop: a switched Session's 409 surfaces verbatim", async () => {
  const timers = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    segments: [
      { status: ORIGIN_CONFLICT.response.status, body: ORIGIN_CONFLICT.response.body },
    ],
  });
  const sentMessages = [];
  const helpers = flowHelpers({
    fetchImpl,
    timers,
    tabMessageImpl: partialCoverageTabMessage(),
    sentMessages,
  });

  await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  await helpers.handleMediaPosition({ position: 100 }, { tab: { id: 2 } });
  const switched = await helpers.handleForceTranscribe();
  assert.equal(switched.success, true);

  // 60s past the switch point: one Segment upload attempt meets the lock.
  await helpers.handleMediaPosition({ position: 160 }, { tab: { id: 2 } });
  await until(
    () => sentMessages,
    (messages) => messages.some((message) => message.action === "sessionUpdate" && message.captureNotice),
  );

  // 如实呈现: the panel learns the conflict through the server's own message
  // — the client-side timing missed, the server lock held, the verdict is
  // never softened.
  const notice = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.captureNotice,
  );
  assert.equal(notice.captureNotice, ORIGIN_CONFLICT.response.body.error.message);

  // The pipeline stands down: no further uploads on this Session.
  await helpers.handleMediaPosition({ position: 90 }, { tab: { id: 2 } });
  await helpers.handleMediaPosition({ position: 220 }, { tab: { id: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    v1Calls.filter((call) => call.path.endsWith("/audio-segments")).length,
    1,
    "no further audio uploads after the origin conflict",
  );

  await helpers.handleEndLearning();
});
