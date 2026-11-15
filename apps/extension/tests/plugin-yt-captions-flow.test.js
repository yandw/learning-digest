/**
 * YouTube captions-path flow (Ticket 2.6, issue #69): the worker
 * orchestration behind 开始学习 on a YouTube watch page — the
 * plugin-bili-captions-flow harness pattern (Ticket 2.5, #68), re-driven
 * over the youtube platform gate. The captions path commits at start
 * (decision D15, the same single-path-per-interval rule):
 * - captions read → server Session created (§3.1) → captions archived
 *   as-read (§3.3) → transcript polled (§3.5) → 全程零 ASR;
 * - captions not read → the capture flow takes over unchanged, with the
 *   无字幕 probe result landed in the Session state;
 * - the probe rides the getYouTubeCaptions bridge command (the youtube
 *   reader lives in youtube-captions.js), never the bilibili one.
 *
 * Request/response shapes follow contracts/fixtures/session-examples.json —
 * the same fixtures the API's tests pin.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBackgroundHelpers } = require("./helpers/load-background.js");
const YTD_YOUTUBE_CAPTIONS = require("../youtube-captions.js");

const YT_WATCH = "https://www.youtube.com/watch?v=AbCdEfGh123";
const XIAOE_LESSON = "https://app12345.xiaoe-tech.com/v_5f0abc123";

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

const RESOLVED_SOURCE = {
  id: "src_01JABC0003",
  resourceId: "res_01JABC0001",
  kind: "video",
  url: YT_WATCH,
  platformId: "youtube",
  platformVideoId: "AbCdEfGh123",
  episodeId: null,
  platformScopeId: null,
  progress: { positionMs: 120000, revision: 1 },
};
const RESOLVE_MATCHED_BODY = {
  matched: true,
  resource: {
    id: "res_01JABC0001",
    title: "注意力机制详解（YouTube）",
    kind: "video",
    createdAt: "2026-11-10T08:00:00Z",
  },
  source: RESOLVED_SOURCE,
};

const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

/** The bridge's getYouTubeCaptions answer for a captions-available page. */
function youtubeCaptionsTabMessage(segments = CAPTIONS_ARCHIVE.request.body.segments) {
  return (message) => {
    if (message.action === "getYouTubeCaptions") {
      return {
        success: true,
        available: true,
        segments,
        track: { language: "zh-Hans", asr: false, autoTranslated: false },
      };
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
    segmentLengthSeconds: 60,
    summaryIntervalMinutes: 30,
    ...overrides,
  };
}

const captionsFlowHelpers = ({ fetchImpl, tabMessageImpl, ...rest } = {}) =>
  loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: YT_WATCH, title: "YouTube 视频课" }),
    fetchImpl,
    tabMessageImpl,
    ...rest,
  });

// --- the captions path: start → archive → poll --------------------------------

test("开始学习 on a YouTube captions page archives the captions as-read (§3.3)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const sentMessages = [];
  const helpers = captionsFlowHelpers({
    fetchImpl,
    tabMessageImpl: youtubeCaptionsTabMessage(),
    sentMessages,
    settings: baseSettings(),
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });

  assert.equal(started.success, true, started.error || "");
  assert.equal(started.capturePath, "captions");

  const captionsCall = v1Calls.find((call) => call.path.endsWith("/captions"));
  assert.ok(captionsCall, "POST /v1/sessions/{id}/captions went out");
  assert.deepEqual(captionsCall.body, CAPTIONS_ARCHIVE.request.body);

  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "captions");
  assert.ok(pointer.serverSessionId, "the pointer carries the server Session id");

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

  await helpers.handleEndLearning();
});

test("the YouTube probe rides getYouTubeCaptions, never the bilibili command", async () => {
  const tabMessages = [];
  const { fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = captionsFlowHelpers({
    fetchImpl,
    tabMessageImpl: youtubeCaptionsTabMessage(),
    tabMessages,
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });
  assert.equal(started.success, true);

  assert.ok(
    tabMessages.some((message) => message.action === "getYouTubeCaptions"),
    "the captions probe is the youtube-page command",
  );
  assert.deepEqual(
    tabMessages.filter((message) => message.action === "getBilibiliCaptions"),
    [],
    "the bilibili command never fires on a YouTube page",
  );

  await helpers.handleEndLearning();
});

// --- the D15 verdicts -----------------------------------------------------------

test("a 409 transcript_origin_conflict surfaces verbatim on the YouTube path too", async () => {
  const { fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: ORIGIN_CONFLICT.response.status, body: ORIGIN_CONFLICT.response.body }],
    transcripts: [
      {
        status: 200,
        body: {
          sessionId: SESSION_CREATE.response.body.session.id,
          sourceId: "src_01JABC0003",
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
    tabMessageImpl: youtubeCaptionsTabMessage(),
    sentMessages,
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });
  assert.equal(started.success, true, "the conflict does not kill the Session");

  const notice = sentMessages.find((message) => message.action === "sessionUpdate" && message.captureNotice);
  assert.ok(notice, "the conflict feedback reached the panel");
  assert.equal(notice.captureNotice, ORIGIN_CONFLICT.response.body.error.message);
  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.equal(snapshot.transcriptOrigin, null, "the rejected archive locked nothing locally");

  await helpers.handleEndLearning();
});

// --- the fall-through: no captions → the capture flow, honestly -----------------

test("without captions the capture flow takes over as the ASR archive path", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    // The ASR Session's own poll: nothing produced yet.
    transcripts: [
      {
        status: 200,
        body: {
          sessionId: SESSION_CREATE.response.body.session.id,
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
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: YT_WATCH, title: "YouTube 视频课" }),
    fetchImpl,
    tabMessageImpl: (message) =>
      message.action === "getYouTubeCaptions"
        ? { success: true, available: false, reason: "no_subtitle_track" }
        : { success: true },
    sendMessageImpl: (message) =>
      message.action === "captureCut"
        ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
        : { success: true },
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });

  assert.equal(started.success, true, started.error || "");
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "asr", "the capture flow is the ASR path");
  assert.ok(pointer.serverSessionId, "the ASR path archives against its server Session");
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/captions")),
    false,
    "no captions were archived (none were read)",
  );

  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.deepEqual(snapshot.captionsProbe, { available: false, reason: "no_subtitle_track" });
  assert.equal(snapshot.transcriptOrigin, null);

  await helpers.handleEndLearning();
});

test("a watch page holding only auto-generated captions starts the ASR path without a timedtext request (issue #85)", async () => {
  // The full 5.3 chain over the shipped reader: the stubbed watch page's
  // player response lists exactly one en/asr track (the ticket's real-page
  // shape), the bridge runs the REAL reader, and the page-world fetch
  // recorder must stay empty — the PO-token-gated timedtext fetch is never
  // attempted. The session falls straight to the ASR path with the honest
  // probe reason in the durable state.
  const timedtextRequests = [];
  const onlyAsrPage = {
    window: {
      location: { href: YT_WATCH },
      ytInitialPlayerResponse: {
        videoDetails: { videoId: "AbCdEfGh123" },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: "en",
                kind: "asr",
                baseUrl:
                  "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=en",
              },
            ],
            translationLanguages: [],
          },
        },
      },
    },
    document: { querySelectorAll: () => [] },
    fetch: async (url) => {
      timedtextRequests.push(url);
      return { ok: true, json: async () => ({ events: [] }) };
    },
  };
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    transcripts: [
      {
        status: 200,
        body: {
          sessionId: SESSION_CREATE.response.body.session.id,
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
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: YT_WATCH, title: "YouTube 视频课" }),
    fetchImpl,
    // The page-bridge contract (page-bridge.js handleCaptionsRequest): the
    // owning frame probes, reads, and answers { success: true, ...result }.
    tabMessageImpl: (message) => {
      if (message.action === "getYouTubeCaptions") {
        const reader =
          YTD_YOUTUBE_CAPTIONS.createYouTubeCaptionReader(onlyAsrPage);
        return reader.read().then((result) => ({ success: true, ...result }));
      }
      return { success: true };
    },
    sendMessageImpl: (message) =>
      message.action === "captureCut"
        ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
        : { success: true },
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });

  assert.equal(started.success, true, started.error || "");
  assert.equal(started.capturePath, "asr", "the session goes straight to ASR");
  assert.deepEqual(
    timedtextRequests,
    [],
    "no timedtext request is sent for an only-auto-generated track list",
  );
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/captions")),
    false,
    "no captions archive is attempted",
  );

  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.deepEqual(snapshot.captionsProbe, {
    available: false,
    reason: "only_auto_generated_captions",
  });

  await helpers.handleEndLearning();
});

test("a xiaoe page never probes for captions (capture flow starts as before)", async () => {
  const { fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: { ...RESOLVE_MATCHED_BODY, source: { ...RESOLVED_SOURCE, url: XIAOE_LESSON, platformId: "xiaoe-tech" } } }],
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
    tabMessages.filter((message) => message.action === "getYouTubeCaptions"),
    [],
    "the captions probe is a YouTube-page command",
  );
  await helpers.handleEndLearning();
});

// --- the panel view --------------------------------------------------------------

test("a reopened panel sees the YouTube captions Session presented as captions", async () => {
  const { fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = captionsFlowHelpers({ fetchImpl, tabMessageImpl: youtubeCaptionsTabMessage() });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });
  assert.equal(started.success, true);
  assert.equal(started.capturePath, "captions");

  const state = await helpers.handleGetSessionState();
  assert.equal(state.active, true);
  assert.equal(state.capturePath, "captions");
  assert.equal(state.state.transcriptOrigin, "captions");

  await helpers.handleEndLearning();
});

// --- the PO-token retry (Ticket 5.7, issue #96) ----------------------------------
//
// YouTube gates every timedtext body on the PO Token its player puts only
// on its own requests (2026-11-15 real-page measurement: HTTP 200, empty
// body — manual tracks included). The worker's retry after a direct
// timedtext_failed read (upstream :860 flow, adapted to this repo's
// transport split — the fetch lives page-side, so the re-read rides the
// bridge): inject capturePlayerCaptionRequest into the watch tab's MAIN
// world, take the player-issued request URL, re-read through the bridge
// with the authorization merge, and archive the captions on success.

const PLAYER_REQUEST_URL =
  "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=en&pot=token&potc=1&c=WEB&cver=2.1";

/** A watch page whose timedtext only answers WITH the player's pot. */
function gatePage(tabMessageCalls) {
  const authorizedUrl =
    "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=zh-Hans&potc=1&pot=token&c=WEB&cver=2.1&fmt=json3";
  return (message) => {
    if (message.action === "getYouTubeCaptions") {
      return { success: true, available: false, reason: "timedtext_failed" };
    }
    if (message.action === "getYouTubeCaptionsAuthorized") {
      tabMessageCalls.push(message);
      // The shipped page-bridge contract: the authorized read carries the
      // player-issued request as the reader's authorizeUrl option.
      const reader = YTD_YOUTUBE_CAPTIONS.createYouTubeCaptionReader({
        window: {
          location: { href: YT_WATCH },
          ytInitialPlayerResponse: {
            videoDetails: { videoId: "AbCdEfGh123" },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    languageCode: "zh-Hans",
                    baseUrl: "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=zh-Hans",
                    isTranslatable: true,
                  },
                ],
                translationLanguages: [],
              },
            },
          },
        },
        document: { querySelectorAll: () => [] },
        fetch: async (url) =>
          url === authorizedUrl
            ? { ok: true, json: async () => ({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "字幕正文" }] }] }) }
            : { ok: true, json: async () => ({ events: [] }) },
      });
      return reader
        .read({
          authorizeUrl: (url) =>
            YTD_YOUTUBE_CAPTIONS.withPlayerCaptionAuthorization(url, message.playerRequestUrl),
        })
        .then((result) => ({ success: true, ...result }));
    }
    return { success: true };
  };
}

const ASR_FALLBACK_V1 = {
  resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
  transcripts: [
    {
      status: 200,
      body: {
        sessionId: SESSION_CREATE.response.body.session.id,
        sessionStatus: "active",
        origin: null,
        records: [],
        gaps: [],
        pending: [],
        failed: [],
      },
    },
  ],
};

const cutChunkSendMessage = (message) =>
  message.action === "captureCut"
    ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
    : { success: true };

test("a gate-emptied direct read retries through the MAIN-world capture and archives as captions", async () => {
  const tabMessageCalls = [];
  const scriptCalls = [];
  const { v1Calls, fetchImpl } = v1Fetch({
    ...ASR_FALLBACK_V1,
    sessions: [{ status: 201, body: { session: SESSION_CREATE.response.body.session } }],
    captions: [{ status: 201, body: CAPTIONS_ARCHIVE.response.body }],
  });
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: YT_WATCH, title: "YouTube 视频课" }),
    fetchImpl,
    tabMessageImpl: gatePage(tabMessageCalls),
    executeScriptImpl: async (injection) => {
      scriptCalls.push(injection);
      return [{ result: PLAYER_REQUEST_URL }];
    },
    sendMessageImpl: cutChunkSendMessage,
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });

  assert.equal(started.success, true, started.error || "");
  assert.equal(started.capturePath, "captions", "the authorized read wins the captions path");

  assert.equal(scriptCalls.length, 1, "one MAIN-world capture injection");
  assert.equal(scriptCalls[0].world, "MAIN");
  // Spread first: the injection args array was built inside the worker's
  // vm realm, so deepStrictEqual would compare array prototypes across
  // realms.
  assert.deepEqual([...scriptCalls[0].args], ["AbCdEfGh123", 8000]);
  assert.equal(typeof scriptCalls[0].func, "function");

  const authorized = tabMessageCalls.find((m) => m.action === "getYouTubeCaptionsAuthorized");
  assert.ok(authorized, "the authorized re-read rode the bridge");
  assert.equal(authorized.playerRequestUrl, PLAYER_REQUEST_URL);

  const captionsCall = v1Calls.find((call) => call.path.endsWith("/captions"));
  assert.ok(captionsCall, "the captured captions were archived");
  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.equal(snapshot.transcriptOrigin, "captions");

  await helpers.handleEndLearning();
});

test("an unavailable capture keeps the direct failure and falls back to ASR", async () => {
  const tabMessageCalls = [];
  let scriptCalls = 0;
  const { v1Calls, fetchImpl } = v1Fetch(ASR_FALLBACK_V1);
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: YT_WATCH, title: "YouTube 视频课" }),
    fetchImpl,
    tabMessageImpl: gatePage(tabMessageCalls),
    executeScriptImpl: async () => {
      scriptCalls += 1;
      throw new Error("cannot inject into tab");
    },
    sendMessageImpl: cutChunkSendMessage,
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });

  assert.equal(started.success, true, started.error || "");
  assert.equal(scriptCalls, 1, "the capture was attempted once");
  assert.equal(started.capturePath, "asr", "the ASR pipeline takes over unchanged");
  assert.deepEqual(
    tabMessageCalls.filter((m) => m.action === "getYouTubeCaptionsAuthorized"),
    [],
    "no authorized re-read without a captured request",
  );
  assert.equal(v1Calls.some((call) => call.path.endsWith("/captions")), false);

  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.deepEqual(
    snapshot.captionsProbe,
    { available: false, reason: "timedtext_failed" },
    "the direct failure's reason is preserved in the durable state",
  );
  // r5-7 review fix: the injection failure is observable — the page-scope
  // breadcrumb channel carries the capture_unavailable verdict with the
  // failing URL.
  const breadcrumb = helpers.readStored("ytd_last_page_scope");
  assert.ok(breadcrumb, "the injection failure leaves a storage breadcrumb");
  assert.equal(breadcrumb.outcome, "capture_unavailable");
  assert.equal(breadcrumb.url, YT_WATCH);
  assert.equal(breadcrumb.detail, "cannot inject into tab");

  await helpers.handleEndLearning();
});

test("a capture that yields no player request keeps the direct failure", async () => {
  const tabMessageCalls = [];
  const { fetchImpl } = v1Fetch(ASR_FALLBACK_V1);
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: YT_WATCH, title: "YouTube 视频课" }),
    fetchImpl,
    tabMessageImpl: gatePage(tabMessageCalls),
    executeScriptImpl: async () => [{ result: null }],
    sendMessageImpl: cutChunkSendMessage,
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });

  assert.equal(started.success, true, started.error || "");
  assert.equal(started.capturePath, "asr");
  assert.deepEqual(
    tabMessageCalls.filter((m) => m.action === "getYouTubeCaptionsAuthorized"),
    [],
  );
  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.deepEqual(snapshot.captionsProbe, { available: false, reason: "timedtext_failed" });

  await helpers.handleEndLearning();
});

test("an authorized re-read that still comes back empty keeps the direct failure", async () => {
  const { fetchImpl } = v1Fetch(ASR_FALLBACK_V1);
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: YT_WATCH, title: "YouTube 视频课" }),
    fetchImpl,
    // The player request was captured but the gate still empties the body.
    tabMessageImpl: (message) => {
      if (message.action === "getYouTubeCaptions") {
        return { success: true, available: false, reason: "timedtext_failed" };
      }
      if (message.action === "getYouTubeCaptionsAuthorized") {
        return { success: true, available: false, reason: "timedtext_failed" };
      }
      return { success: true };
    },
    executeScriptImpl: async () => [{ result: PLAYER_REQUEST_URL }],
    sendMessageImpl: cutChunkSendMessage,
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });

  assert.equal(started.success, true, started.error || "");
  assert.equal(started.capturePath, "asr");
  const pointer = helpers.readStored("ytd_active_capture");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.deepEqual(snapshot.captionsProbe, { available: false, reason: "timedtext_failed" });

  await helpers.handleEndLearning();
});

test("verdicts that are not the timedtext gate never trigger the MAIN-world capture", async () => {
  const scriptCalls = [];
  const { fetchImpl } = v1Fetch(ASR_FALLBACK_V1);
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: YT_WATCH, title: "YouTube 视频课" }),
    fetchImpl,
    tabMessageImpl: (message) =>
      message.action === "getYouTubeCaptions"
        ? { success: true, available: false, reason: "no_subtitle_track" }
        : { success: true },
    executeScriptImpl: async (injection) => {
      scriptCalls.push(injection);
      return [{ result: PLAYER_REQUEST_URL }];
    },
    sendMessageImpl: cutChunkSendMessage,
  });

  const started = await helpers.handleStartLearning({ url: YT_WATCH, tabId: 3 });

  assert.equal(started.success, true, started.error || "");
  assert.equal(started.capturePath, "asr");
  assert.deepEqual(scriptCalls, [], "no capture without a fetch-failure-class reason");

  await helpers.handleEndLearning();
});
