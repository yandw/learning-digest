/**
 * Bilibili captions-path flow (Ticket 2.5, issue #68): the worker
 * orchestration behind 开始学习 on a bilibili video page, in the
 * plugin-learning-start-flow harness pattern.
 *
 * The captions path commits at start (decision D15: the path is decided
 * before ANY archive submission):
 * - captions read → server Session created (POST sessions, contract-r2
 *   §3.1) → captions archived as-read (POST captions, §3.3) → transcript
 *   polled (GET transcript, §3.5) → 全程零 ASR (no provider gate, no
 *   capture, no offscreen);
 * - captions not read → the existing capture flow takes over unchanged,
 *   with the 无字幕 probe result landed in the Session state;
 * - the archive's D15 verdicts (409 transcript_origin_conflict,
 *   session_already_finished) surface as honest conflict feedback;
 * - P11 end (explicit, media end, source switch) finishes the server
 *   Session (POST finish, §3.2) after the progress flush.
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
const XIAOE_LESSON = "https://app12345.xiaoe-tech.com/v_5f0abc123";

const FIXTURES_DIR = path.join(__dirname, "..", "contracts", "fixtures");
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

const RESOLVED_SOURCE = {
  id: "src_01JABC0002",
  resourceId: "res_01JABC0001",
  kind: "video",
  url: BILI_P2,
  platformId: "bilibili",
  platformVideoId: "BV1ab411L78c",
  episodeId: "2",
  platformScopeId: null,
  progress: { positionMs: 250000, revision: 2 },
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

/** The bridge's getBilibiliCaptions answer for a captions-available page. */
function captionsTabMessage(segments = CAPTIONS_ARCHIVE.request.body.segments) {
  return (message) => {
    if (message.action === "getBilibiliCaptions") {
      return { success: true, available: true, segments, track: { lan: "zh-CN", ai: false } };
    }
    return { success: true };
  };
}

/** One fetch seam for the whole captions flow, recorded per /v1 call. */
function v1Fetch({
  resolve = [],
  sessions = [],
  captions = [],
  transcripts = [],
  finishes = [],
} = {}) {
  const v1Calls = [];
  let resolveIndex = 0;
  let sessionsIndex = 0;
  let captionsIndex = 0;
  let transcriptsIndex = 0;
  let finishesIndex = 0;
  const next = (list, indexRef, fallbackBody) => {
    const scripted = list[indexRef.index++] ?? list[list.length - 1];
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
      return next(resolve, resolveIndex, { matched: false });
    }
    if (/^\/v1\/sources\/[^/]+\/sessions$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return next(sessions, sessionsIndex, { session: SESSION_CREATE.response.body.session });
    }
    if (/^\/v1\/sessions\/[^/]+\/captions$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return next(captions, captionsIndex, { transcript: CAPTIONS_ARCHIVE.response.body.transcript });
    }
    if (/^\/v1\/sessions\/[^/]+\/transcript$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: undefined });
      return next(transcripts, transcriptsIndex, TRANSCRIPT_FINISHED.response.body);
    }
    if (/^\/v1\/sessions\/[^/]+\/finish$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body || "{}") });
      return next(finishes, finishesIndex, { session: FINISH_GAPS.response.body.session });
    }
    if (/^\/v1\/sources\/[^/]+\/progress$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return { status: 200, ok: true, json: async () => ({ positionMs: 0, revision: 1 }) };
    }
    return { status: 200, ok: true, json: async () => ({}) };
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
    speechProvider: "groq",
    speechProviders: { groq: { apiKey: "groq-key" } },
    segmentLengthSeconds: 60,
    summaryIntervalMinutes: 30,
    ...overrides,
  };
}

const captionsFlowHelpers = ({ fetchImpl, tabMessageImpl, ...rest } = {}) =>
  loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: BILI_P2, title: "视频课 P2" }),
    fetchImpl,
    tabMessageImpl,
    ...rest,
  });

// --- the captions path: start → archive → poll --------------------------------

test("开始学习 on a captions page creates the server Session and archives the captions as-read", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const sentMessages = [];
  const helpers = captionsFlowHelpers({
    fetchImpl,
    tabMessageImpl: captionsTabMessage(),
    sentMessages,
    // The captions path runs with NO speech provider configured at all:
    // 全程零 ASR means the provider gate must not even be consulted.
    settings: baseSettings({ speechProvider: "none", speechProviders: {} }),
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });

  assert.equal(started.success, true, started.error || "");

  // The server Session exists (§3.1): empty body, the resolved source.
  const sessionCall = v1Calls.find((call) => call.path.endsWith("/sessions"));
  assert.ok(sessionCall, "POST /v1/sources/{id}/sessions went out");
  assert.equal(sessionCall.method, "POST");
  assert.deepEqual(sessionCall.body, {});

  // The captions archive (§3.3): the read segments, as-read, on the
  // source timeline — the fixture body verbatim.
  const captionsCall = v1Calls.find((call) => call.path.endsWith("/captions"));
  assert.ok(captionsCall, "POST /v1/sessions/{id}/captions went out");
  assert.deepEqual(captionsCall.body, CAPTIONS_ARCHIVE.request.body);

  // 全程零 ASR: no capture machinery, no audio, no provider anywhere.
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "captions");
  assert.ok(pointer.serverSessionId, "the pointer carries the server Session id");
  assert.equal(v1Calls.some((call) => call.path.includes("/progress")), false);

  // The transcript landed as Session state: the fixture's records mapped
  // to source-timeline rows, origin captions.
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.equal(snapshot.transcriptOrigin, "captions");
  assert.deepEqual(
    snapshot.transcriptRecords,
    CAPTIONS_ARCHIVE.response.body.transcript.records.map((record) => ({
      start: record.startMs / 1000,
      duration: (record.endMs - record.startMs) / 1000,
      text: record.text,
    })),
  );

  // The transcript poll (§3.5) rendered from the server view.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    v1Calls.some((call) => call.path.endsWith("/transcript")),
    "GET /v1/sessions/{id}/transcript polls the archived view",
  );

  await helpers.handleEndLearning();
});

test("the captions path skips the Speech Provider gate entirely", async () => {
  const { fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = captionsFlowHelpers({
    fetchImpl,
    tabMessageImpl: captionsTabMessage(),
    settings: baseSettings({ speechProvider: "none", speechProviders: {} }),
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });

  assert.equal(started.success, true, "零 ASR: no provider configuration is required");
  await helpers.handleEndLearning();
});

test("the captions path still locks the P10 target and feeds the progress writer", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = captionsFlowHelpers({ fetchImpl, tabMessageImpl: captionsTabMessage() });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);

  const target = helpers.readStored("ytd_learning_target");
  assert.equal(target.status, "locked", "P10 lock unchanged");
  assert.equal(target.sourceId, "src_01JABC0002");
  assert.equal(target.sessionId, started.sessionId);

  // The position stream feeds the writer exactly as on the capture path.
  await helpers.handleMediaPosition({ position: 300 }, { tab: { id: 2 } });
  await new Promise((resolve) => setImmediate(resolve));
  const progressCalls = v1Calls.filter((call) => call.path.includes("/progress"));
  assert.equal(progressCalls.length, 1, "the anchor position is a key event");
  assert.deepEqual(progressCalls[0].body, { positionMs: 300000, expectedRevision: 2 });

  await helpers.handleEndLearning();
});

// --- the D15 verdicts -----------------------------------------------------------

test("a 409 transcript_origin_conflict surfaces as honest conflict feedback", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: ORIGIN_CONFLICT.response.status, body: ORIGIN_CONFLICT.response.body }],
    // The honest server view for a session whose archive never landed:
    // origin null, four empty arrays (§2.5).
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
    ],
  });
  const sentMessages = [];
  const helpers = captionsFlowHelpers({
    fetchImpl,
    tabMessageImpl: captionsTabMessage(),
    sentMessages,
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true, "the conflict does not kill the Session");

  // 如实呈现: the panel learns the conflict verbatim (the §4 fixture's own
  // message), and the state never claims captions were archived.
  const notice = sentMessages.find((message) => message.action === "sessionUpdate" && message.captureNotice);
  assert.ok(notice, "the conflict feedback reached the panel");
  assert.equal(notice.captureNotice, ORIGIN_CONFLICT.response.body.error.message);
  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.equal(snapshot.transcriptOrigin, null, "the rejected archive locked nothing locally");
  assert.equal(snapshot.transcriptRecords.length, 0);

  await helpers.handleEndLearning();
});

test("an archive network failure keeps the Session honest and finishable", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 503, body: { error: { code: "boom", message: "down" } } }],
    finishes: [{ status: 200, body: { session: FINISH_GAPS.response.body.session } }],
  });
  const sentMessages = [];
  const helpers = captionsFlowHelpers({
    fetchImpl,
    tabMessageImpl: captionsTabMessage(),
    sentMessages,
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);

  const notice = sentMessages.find((message) => message.action === "sessionUpdate" && message.captureNotice);
  assert.ok(notice, "the archive failure is surfaced, not swallowed");

  const ended = await helpers.handleEndLearning();
  assert.equal(ended.success, true);
  assert.ok(
    v1Calls.some((call) => call.path.endsWith("/finish")),
    "the server Session still finishes at the end",
  );
});

// --- start failures --------------------------------------------------------------

test("a failed Session create fails the start instead of guessing", async () => {
  const { fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 500, body: { error: { code: "boom", message: "服务暂不可用" } } }],
  });
  const helpers = captionsFlowHelpers({ fetchImpl, tabMessageImpl: captionsTabMessage() });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });

  assert.equal(started.success, false);
  // The server's own envelope message surfaces verbatim — no kinder story.
  assert.equal(started.error, "服务暂不可用");
  assert.equal(helpers.readStored("ytd_active_capture"), undefined, "nothing is left running");
});

test("an unmatched page asks for 收藏 before any captions path can run", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: { matched: false } }],
  });
  const helpers = captionsFlowHelpers({ fetchImpl, tabMessageImpl: captionsTabMessage() });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });

  assert.equal(started.success, false);
  assert.equal(started.needsFavorite, true);
  assert.equal(v1Calls.some((call) => call.path.endsWith("/sessions")), false);
  assert.equal(v1Calls.some((call) => call.path.endsWith("/captions")), false);
});

// --- P11 finish ------------------------------------------------------------------

test("ending the captions Session finishes the server Session (no gaps to report)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = captionsFlowHelpers({ fetchImpl, tabMessageImpl: captionsTabMessage() });

  await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  const ended = await helpers.handleEndLearning();

  assert.equal(ended.success, true);
  const finishCall = v1Calls.find((call) => call.path.endsWith("/finish"));
  assert.ok(finishCall, "POST /v1/sessions/{id}/finish went out");
  // The captions path tracks no explicit skipped ranges in this ticket: the
  // archive is as-read, so the finish body carries no gaps (§3.2 缺省).
  assert.deepEqual(finishCall.body, {});
  // P10 unlock: endTarget cleared the persisted lock entirely (the idle
  // state is stored as absence — nothing is held).
  assert.equal(helpers.readStored("ytd_learning_target"), undefined, "P10 unlock unchanged");
});

test("a repeat finish (409 already_finished) ends the local Session calmly", async () => {
  const alreadyFinished = errorSample("error-session-finish-already-finished");
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
    finishes: [{ status: alreadyFinished.response.status, body: alreadyFinished.response.body }],
  });
  const helpers = captionsFlowHelpers({ fetchImpl, tabMessageImpl: captionsTabMessage() });

  await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  const ended = await helpers.handleEndLearning();

  assert.equal(ended.success, true, "a 409 repeat-finish is not a local failure");
  assert.ok(v1Calls.some((call) => call.path.endsWith("/finish")));
  assert.equal(helpers.readStored("ytd_active_capture"), undefined);
});

test("media end auto-finishes the captions Session like any video Session", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = captionsFlowHelpers({ fetchImpl, tabMessageImpl: captionsTabMessage() });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);

  await helpers.handleMediaPosition({ position: 600, ended: true }, { tab: { id: 2 } });

  assert.equal(helpers.readStored("ytd_active_capture"), undefined, "the Session ended");
  assert.ok(v1Calls.some((call) => call.path.endsWith("/finish")), "the server Session finished");
});

// --- the fall-through: no captions → the capture flow, honestly -----------------

test("without captions the capture flow takes over as the ASR archive path", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    // The ASR Session's own poll: nothing produced yet (the stub file's
    // captions-finished default would stamp a captions origin on it).
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
    ],
  });
  const tabMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: BILI_P2, title: "视频课 P2" }),
    fetchImpl,
    // The bridge answered: the page exposes a subtitle source but the read
    // found nothing usable (the 无字幕 page shape).
    tabMessageImpl: (message) =>
      message.action === "getBilibiliCaptions"
        ? { success: true, available: false, reason: "no_subtitle_track" }
        : { success: true },
    tabMessages,
    sendMessageImpl: (message) =>
      message.action === "captureCut"
        ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
        : { success: true },
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });

  assert.equal(started.success, true);
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "asr", "the capture flow is the ASR path");
  // Ticket 2.4: the ASR path archives against its own server Session
  // (§3.1 ran before any capture machinery).
  assert.ok(pointer.serverSessionId, "the pointer carries the server Session id");
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/sessions")),
    true,
    "POST sessions ran before capture",
  );
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/captions")),
    false,
    "no captions were archived (none were read)",
  );

  // The 无字幕 state landed in the Session state, honestly.
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.deepEqual(snapshot.captionsProbe, { available: false, reason: "no_subtitle_track" });
  assert.equal(snapshot.transcriptOrigin, null);

  await helpers.handleEndLearning();
});

test("the 无字幕 fallback needs no ASR key config at all (D10)", async () => {
  // Settings carry no Speech Provider fields anymore (v4 normalize drops
  // them): the start still proceeds — the Worker holds the ASR credentials
  // server-side, the plugin uploads audio and polls.
  const storedSettings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.example.com/ai",
    aiModel: "test-model",
    apiBaseUrl: "https://api.example.com",
    segmentLengthSeconds: 60,
    summaryIntervalMinutes: 30,
  };
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
  });
  const helpers = loadBackgroundHelpers({
    settings: storedSettings,
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: BILI_P2, title: "视频课 P2" }),
    fetchImpl,
    tabMessageImpl: (message) =>
      message.action === "getBilibiliCaptions"
        ? { success: true, available: false, reason: "no_subtitle_track" }
        : { success: true },
    sendMessageImpl: (message) =>
      message.action === "captureCut"
        ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
        : { success: true },
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });

  assert.equal(started.success, true, started.error || "");
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "asr");
  assert.ok(pointer.serverSessionId);
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/sessions")),
    true,
  );

  await helpers.handleEndLearning();
});

test("a non-bilibili page never probes for captions (xiaoe starts as before)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
  });
  const tabMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: XIAOE_LESSON, title: "小鹅通课程" }),
    fetchImpl,
    tabMessages,
    transcribeImpl: async () => [{ text: "转写内容", start: 0, duration: 120, language: "zh" }],
    sendMessageImpl: (message) =>
      message.action === "captureCut"
        ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
        : { success: true },
  });

  const started = await helpers.handleStartLearning({ url: XIAOE_LESSON, tabId: 7 });
  assert.equal(started.success, true);
  assert.deepEqual(
    tabMessages.filter((message) => message.action === "getBilibiliCaptions"),
    [],
    "the captions probe is a bilibili-page command",
  );
  await helpers.handleEndLearning();
});

test("a reopened panel sees the captions Session presented as captions", async () => {
  const { fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = captionsFlowHelpers({ fetchImpl, tabMessageImpl: captionsTabMessage() });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);
  assert.equal(started.capturePath, "captions");

  // The panel reopen path (getSessionState) presents the same shape.
  const state = await helpers.handleGetSessionState();
  assert.equal(state.active, true);
  assert.equal(state.capturePath, "captions");
  assert.equal(state.state.transcriptOrigin, "captions");

  await helpers.handleEndLearning();
});
