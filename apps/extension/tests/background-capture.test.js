/**
 * Background capture-orchestration behaviors, tested through the shared
 * load-background seam: the provider-aware start gate (#9 / #21 finding 9)
 * and the resume path settling interrupted in-flight Segments (#8 / #21
 * finding 8, the #12 / US15 contract).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadBackgroundHelpers } = require("./helpers/load-background.js");
const sessionPipeline = require("../session-pipeline.js");

const REPLAY_URL = "https://app12345.xiaoe-tech.com/replay/l_abc123def456";
const LIVE_URL = "https://app12345.xiaoe-tech.com/live/l_abc123def456";

// The linked credential every archive call presents (P6): the start flow's
// resolve/create/finish all require it.
const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

// --- Retired legacy analysis path (#31) ---------------------------------------

test("the legacy analyzeTranscript action is fully removed", () => {
  const root = path.resolve(__dirname, "..");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const sidepanel = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");

  // No dead message action, handler, prompt load, or panel trigger remains.
  assert.doesNotMatch(background, /analyzeTranscript/);
  assert.doesNotMatch(background, /analysis\.md/);
  assert.doesNotMatch(
    sidepanel,
    /analyzeTranscript|isAnalysisLoading|triggerAnalysis|renderAnalysisResults/,
  );
  // The prompt file itself is retired; explain.md is a different feature.
  assert.equal(fs.existsSync(path.join(root, "prompts", "analysis.md")), false);
  assert.equal(fs.existsSync(path.join(root, "prompts", "explain.md")), true);
});

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    apiBaseUrl: "https://api.example.com",
    segmentLengthSeconds: 60,
    summaryIntervalMinutes: 30,
    ...overrides,
  };
}

test("background start forces openPanelOnActionClick off so icon clicks fire onClicked", () => {
  const calls = [];
  loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    sidePanel: {
      setPanelBehavior: (behavior) => {
        calls.push(behavior);
      },
      setOptions: () => Promise.resolve(),
      open: () => Promise.resolve(),
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].openPanelOnActionClick, false);
});

test("startLearning maps Chrome's not-invoked tabCapture error to a Chinese instruction", async () => {
  const { handleStartLearning, readLastStartFailure } = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    fetchImpl: apiFetch().fetchImpl,
    getMediaStreamId: async () => {
      throw new Error(
        "Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.",
      );
    },
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, false);
  assert.match(result.error, /点击工具栏中的 Learning Digest 图标/);
  assert.doesNotMatch(result.error, /activeTab/);
  // The failure is persisted: console and panel alert are easy to miss, the
  // storage breadcrumb makes every failed start diagnosable after the fact.
  const diag = await readLastStartFailure();
  assert.match(diag.ytd_last_start_failure.error, /not been invoked/);
  assert.equal(diag.ytd_last_start_failure.sessionId.startsWith("s_"), true);
});

// --- Toolbar icon click: the single capture entry point (invocation + start)

test("action click on a recognized learning page starts the Session", async () => {
  let streamRequested = false;
  const sentMessages = [];
  const { handleActionClicked, handleGetSessionState } = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sentMessages,
    getMediaStreamId: async () => {
      streamRequested = true;
      return "test-stream-id";
    },
  });

  await handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });

  assert.equal(streamRequested, true);
  const state = await handleGetSessionState();
  assert.equal(state.active, true);
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
  assert.equal(start.mode, "video");
});

test("action click on a live page arms the offscreen wallclock cut", async () => {
  const sentMessages = [];
  const { handleActionClicked, handleGetSessionState } = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sentMessages,
  });

  await handleActionClicked({ id: 7, url: LIVE_URL, windowId: 1 });

  const state = await handleGetSessionState();
  assert.equal(state.active, true);
  assert.equal(state.timestampKind, "wallclock");
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
  assert.equal(start.mode, "wallclock");
});

// --- Course-switch auto-end (0.1.57): a stale active Session on another
// lesson no longer shadows the icon click; it ends (without the AI pass) and
// a fresh Session starts for the new course.

const COURSE_B_URL = "https://app12345.xiaoe-tech.com/replay/l_zzz999yyy888";

test("action click on a DIFFERENT course auto-ends the stale Session and starts fresh", async () => {
  const bg = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    sentMessages: [],
  });

  // Session A active on tab 7 / REPLAY_URL; its pointer carries sourceUrl.
  await bg.handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });
  const first = await bg.handleGetSessionState();
  assert.equal(first.active, true);
  const firstSessionId = first.sessionId;
  assert.equal(bg.readStored("ytd_active_capture").sourceUrl, REPLAY_URL);

  // Icon click on course B (tab 9): A ends silently, B starts.
  await bg.handleActionClicked({ id: 9, url: COURSE_B_URL, windowId: 1 });

  assert.equal(
    bg.readStored(`ytd_session_${firstSessionId}`).status,
    "ended",
    "the stale Session ends",
  );
  assert.equal(
    bg.readStored(`report_${firstSessionId}`),
    undefined,
    "no AI pass runs for the stale lesson",
  );
  const second = await bg.handleGetSessionState();
  assert.equal(second.active, true);
  assert.notEqual(second.sessionId, firstSessionId);
  const pointer = bg.readStored("ytd_active_capture");
  assert.equal(pointer.sourceUrl, COURSE_B_URL);
  assert.equal(pointer.tabId, 9);
});

test("action click on the SAME course keeps the active Session (no restart)", async () => {
  const sentMessages = [];
  const bg = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    sentMessages,
  });

  await bg.handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });
  const first = await bg.handleGetSessionState();
  const captureStarts = sentMessages.filter(
    (message) => message.action === "captureStart",
  ).length;

  await bg.handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });

  const after = await bg.handleGetSessionState();
  assert.equal(after.sessionId, first.sessionId, "same Session survives the re-click");
  assert.equal(
    sentMessages.filter((message) => message.action === "captureStart").length,
    captureStarts,
    "no second capture starts",
  );
});

test("a pre-0.1.57 pointer without sourceUrl falls back to tab identity", async () => {
  const state = sessionPipeline.createSession({ sessionId: "s_legacy" });
  const bg = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    settings: baseSettings(),
    sentMessages: [],
    stored: {
      // The linked credential the fresh start's archive preconditions need.
      ytd_auth_credential: {
        token: "ext-token",
        credentialGroupId: "grp_1",
        email: "l@e.com",
      },
      ytd_active_capture: {
        sessionId: "s_legacy",
        tabId: 7,
        platformId: "xiaoe-tech",
        kind: "replay",
        timestampKind: "video",
        startedAtMs: Date.now() - 60_000,
        segmentLengthSeconds: 120,
      },
      ytd_session_s_legacy: JSON.parse(JSON.stringify(state)),
    },
  });

  await bg.handleActionClicked({ id: 9, url: COURSE_B_URL, windowId: 1 });

  assert.equal(
    bg.readStored("ytd_session_s_legacy").status,
    "ended",
    "the legacy Session ends on a different tab too",
  );
  const now = await bg.handleGetSessionState();
  assert.equal(now.active, true);
  assert.equal(now.sessionId !== "s_legacy", true);
});

// --- Transcription mode resolution (#45/#49): qwen realtime on any Session kind

test("positions from another tab drop with a one-time diagnostic warning (0.1.58)", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const bg = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
      settings: baseSettings(),
      stored: {
        ytd_active_capture: {
          sessionId: "s_tab",
          tabId: 7,
          platformId: "xiaoe-tech",
          kind: "replay",
          timestampKind: "video",
          startedAtMs: Date.now() - 30_000,
          segmentLengthSeconds: 120,
          sourceUrl: REPLAY_URL,
        },
        ytd_session_s_tab: JSON.parse(
          JSON.stringify(sessionPipeline.createSession({ sessionId: "s_tab" })),
        ),
      },
    });

    await bg.handleMediaPosition(mediaPositionMessage(100), { tab: { id: 9 } });
    await bg.handleMediaPosition(mediaPositionMessage(200), { tab: { id: 9 } });

    assert.equal(warnings.length, 1, "one warning per context, not one per second");
    assert.match(warnings[0], /标签页 9/);
    const after = await bg.handleGetSessionState();
    assert.equal(
      after.state.transcriptRecords.length,
      0,
      "nothing is captured from the wrong tab",
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("action click on an unrecognized page only opens the panel", async () => {
  let streamRequested = false;
  const { handleActionClicked, readLastStartFailure } = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    getMediaStreamId: async () => {
      streamRequested = true;
      return "test-stream-id";
    },
  });

  await handleActionClicked({ id: 7, url: "https://example.com/", windowId: 1 });

  assert.equal(streamRequested, false);
  const diag = await readLastStartFailure();
  assert.match(diag.ytd_last_start_failure.error, /not recognized/);
});

// Chrome only honors a getMediaStreamId call made while the click's gesture
// is still fresh; the panel open and the storage work that used to run first
// let the gesture unwind, and every real Session start died on
// "Extension has not been invoked" (observed live as orphaned active
// snapshots with zero segments). The stream fetch must come first.

test("action click issues the panel open and the streamId fetch before any await", async () => {
  const order = [];
  const { handleActionClicked } = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    getMediaStreamId: async () => {
      order.push("getMediaStreamId");
      return "test-stream-id";
    },
    sidePanel: {
      setPanelBehavior() {},
      setOptions: () => Promise.resolve(),
      open: () => {
        order.push("sidePanel.open");
        return Promise.resolve();
      },
    },
  });

  await handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });

  // Both privileged calls happen in the click's task; nothing async runs
  // between the click and either call, or the gesture/invocation expires.
  assert.deepEqual(order, ["sidePanel.open", "getMediaStreamId"]);
});

test("handleStartLearning consumes a pre-fetched streamId without fetching again", async () => {
  let fetchCount = 0;
  const sentMessages = [];
  const { handleStartLearning } = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sentMessages,
    getMediaStreamId: async () => {
      fetchCount += 1;
      return "late-id";
    },
  });

  const result = await handleStartLearning({
    url: REPLAY_URL,
    tabId: 7,
    streamId: "pre-fetched-id",
  });

  assert.equal(result.success, true);
  assert.equal(fetchCount, 0, "the fresh streamId is used, no second fetch");
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
  assert.equal(start.streamId, "pre-fetched-id");
});

test("action click start failure broadcasts the reason to the panel", async () => {
  const sentMessages = [];
  const { handleActionClicked } = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sentMessages,
    getMediaStreamId: async () => {
      throw new Error(
        "Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.",
      );
    },
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
  });

  await handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });

  const startError = sentMessages.find((message) => message.startError);
  assert.ok(startError, "the panel receives the failure reason");
  assert.match(startError.startError, /点击工具栏中的 Learning Digest 图标/);
});

// --- Resume: an in-flight Segment at worker death leaves no orphan pending

test("getSessionState after resume settles the interrupted Segment as failed with its annotation", async () => {
  let state = sessionPipeline.createSession({ sessionId: "s_resume" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-0",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 120, duration: 120 },
  });

  const { handleGetSessionState } = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    settings: baseSettings(),
    stored: {
      ytd_active_capture: {
        sessionId: "s_resume",
        tabId: 7,
        platformId: "xiaoe-tech",
        kind: "replay",
        timestampKind: "video",
        startedAtMs: Date.now() - 300_000,
        segmentLengthSeconds: 120,
      },
      ytd_session_s_resume: JSON.parse(JSON.stringify(state)),
    },
  });

  const result = await handleGetSessionState();

  assert.equal(result.active, true);
  assert.ok(
    result.state.segments.every((segment) => segment.status !== "pending"),
    "a resumed Session has no orphan pending Segments",
  );
  const marker = result.state.transcriptRecords.find(
    (record) => record.failed === true && record.start === 120,
  );
  assert.ok(marker, "the gap carries the visible [语音转录失败] annotation");
});

// --- 清除记录: the panel's clear button deletes an ended Session's snapshot
// and report artifact, and never the active one.

test("clearSessionRecord deletes the ended Session's snapshot and report artifact", async () => {
  const bg = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    settings: baseSettings(),
    stored: {
      ytd_session_s_old: {
        sessionId: "s_old",
        status: "ended",
        transcriptRecords: [{ text: "旧逐字稿", start: 0, duration: 5 }],
      },
      report_s_old: { sessionId: "s_old", report: { title: "旧纪要" } },
    },
  });

  const result = await bg.handleClearSessionRecord({ sessionId: "s_old" });

  assert.equal(result.success, true);
  assert.equal(
    bg.readStored("ytd_session_s_old"),
    undefined,
    "the snapshot is gone",
  );
  assert.equal(
    bg.readStored("report_s_old"),
    undefined,
    "the report artifact goes with it (else the D7 scan re-adopts it)",
  );
});

test("clearSessionRecord refuses the active Session and leaves storage untouched", async () => {
  const bg = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    settings: baseSettings(),
    stored: {
      ytd_active_capture: {
        sessionId: "s_live",
        tabId: 7,
        platformId: "xiaoe-tech",
        kind: "replay",
        timestampKind: "video",
        startedAtMs: Date.now(),
        segmentLengthSeconds: 120,
      },
      ytd_session_s_live: {
        sessionId: "s_live",
        status: "active",
        transcriptRecords: [{ text: "进行中", start: 0, duration: 5 }],
      },
    },
  });

  const result = await bg.handleClearSessionRecord({ sessionId: "s_live" });

  assert.equal(result.success, false);
  assert.equal(result.error, "SESSION_ACTIVE");
  assert.ok(
    bg.readStored("ytd_session_s_live"),
    "a running capture survives the click",
  );
});

test("clearSessionRecord without a sessionId is a refused no-op", async () => {
  const bg = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    settings: baseSettings(),
    stored: {},
  });

  const result = await bg.handleClearSessionRecord({});

  assert.equal(result.success, false);
  assert.match(result.error, /sessionId/);
});

// --- Topic tick flow: timer fires -> prompt -> topicsAppended -> persist + broadcast

const TOPIC_JSON = JSON.stringify([
  { start: 0, end: 900, title: "导论", text: "老师介绍了课程目标。" },
]);

// Ten 90-second records: exactly 15 minutes of coverage, at the trigger
// boundary for the default interval.
function tenCoverageRecords() {
  const records = [];
  for (let i = 0; i < 10; i++) {
    records.push({ text: `第 ${i + 1} 段`, start: i * 90, duration: 90 });
  }
  return records;
}

// A resumed Session whose Segments are all settled, so the tick flow is the
// only thing under test.
function seededCapture(sessionId, records) {
  let state = sessionPipeline.createSession({ sessionId });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-0",
    records,
  });
  return JSON.parse(JSON.stringify(state));
}

function capturePointer(sessionId) {
  return {
    sessionId,
    tabId: 7,
    platformId: "xiaoe-tech",
    kind: "replay",
    timestampKind: "video",
    startedAtMs: Date.now() - 300_000,
    segmentLengthSeconds: 120,
  };
}

function topicAiFetch(capturedRequests) {
  return async (_url, options) => {
    capturedRequests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: TOPIC_JSON } }] }),
    };
  };
}

// --- 从头开始 playback control (0.1.63) ------------------------------------

test("从头开始 forwards the rewind to the capture tab's page bridge", async () => {
  const tabMessages = [];
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    tabMessages,
  });
  await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  const result = await helpers.handleRestartFromBeginning();

  assert.equal(result.success, true);
  assert.deepEqual(tabMessages, [{ tabId: 7, action: "restartFromBeginning" }]);
});

test("从头开始 is refused on a live Session (no timeline to rewind)", async () => {
  const tabMessages = [];
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    tabMessages,
  });
  await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });

  const result = await helpers.handleRestartFromBeginning();

  assert.equal(result.success, false);
  assert.match(result.error, /直播/);
  assert.deepEqual(tabMessages, []);
});

test("从头开始 without an active Session is a refused no-op", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
  });

  const result = await helpers.handleRestartFromBeginning();

  assert.equal(result.success, false);
  assert.match(result.error, /没有进行中的转写会话/);
});

test("从头开始 maps a missing page bridge to the refresh instruction", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    tabMessageImpl: () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
  });
  await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  const result = await helpers.handleRestartFromBeginning();

  assert.equal(result.success, false);
  assert.match(result.error, /请刷新课程页后重试/);
});

test("从头开始 surfaces the bridge's own failure message", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    tabMessageImpl: () => ({ success: false, error: "页面上没有找到可控制的视频" }),
  });
  await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  const result = await helpers.handleRestartFromBeginning();

  assert.equal(result.success, false);
  assert.match(result.error, /没有找到可控制的视频/);
});

test("a summary tick sends the block prompt, appends Topics, persists and broadcasts", async () => {
  const requests = [];
  const sentMessages = [];
  let fireSummaryTick = null;
  const sessionId = "s_tick";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ summaryIntervalMinutes: 15 }),
    fetchImpl: topicAiFetch(requests),
    setIntervalImpl: (cb) => {
      fireSummaryTick = cb;
      return 0;
    },
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  // Resume arms the summary timer; the captured callback is one tick.
  await helpers.handleGetSessionState();
  assert.ok(fireSummaryTick, "resuming a Session arms the summary timer");
  await fireSummaryTick();

  // The block prompt went to the AI Provider: system contract + the new
  // Transcript records stamped as [m:ss] lines.
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /JSON/);
  assert.match(requests[0].messages[1].content, /\[0:00\] 第 1 段/);
  assert.match(requests[0].messages[1].content, /\[13:30\] 第 10 段/);

  // The parsed Topics were appended, persisted and broadcast.
  const persisted = helpers.readStored(`ytd_session_${sessionId}`);
  assert.equal(persisted.topics.length, 1);
  assert.equal(persisted.topics[0].title, "导论");
  const update = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.state?.topics?.length,
  );
  assert.ok(update, "the panel receives a sessionUpdate carrying the new Topic");
  assert.equal(update.state.topics[0].start, 0);
});

test("a tick below the trigger threshold never calls the AI Provider", async () => {
  const requests = [];
  let fireSummaryTick = null;
  const sessionId = "s_quiet";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ summaryIntervalMinutes: 15 }),
    fetchImpl: topicAiFetch(requests),
    setIntervalImpl: (cb) => {
      fireSummaryTick = cb;
      return 0;
    },
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      // Only two records: far below both the coverage and debounce bars.
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, [
        { text: "第一段", start: 0, duration: 60 },
        { text: "第二段", start: 60, duration: 60 },
      ]),
    },
  });

  await helpers.handleGetSessionState();
  await fireSummaryTick();

  assert.equal(requests.length, 0, "quiet stretches produce no AI calls");
  assert.deepEqual(helpers.readStored(`ytd_session_${sessionId}`).topics, []);
});

test("a failed tick leaves the state intact and retries on the next interval", async () => {
  const requests = [];
  const sentMessages = [];
  let fireSummaryTick = null;
  let attempts = 0;
  const sessionId = "s_retry";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ summaryIntervalMinutes: 15 }),
    fetchImpl: async (_url, options) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { message: "provider boom" } }),
        };
      }
      return topicAiFetch(requests)(_url, options);
    },
    setIntervalImpl: (cb) => {
      fireSummaryTick = cb;
      return 0;
    },
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  await helpers.handleGetSessionState();

  // First interval: the AI Provider fails; nothing may change.
  await fireSummaryTick();
  assert.deepEqual(
    helpers.readStored(`ytd_session_${sessionId}`).topics,
    [],
    "a failed tick appends nothing",
  );
  assert.equal(
    sentMessages.filter((message) => message.action === "sessionUpdate").length,
    0,
    "a failed tick broadcasts nothing",
  );

  // Next interval: the same tick retries and succeeds.
  await fireSummaryTick();
  assert.equal(requests.length, 1);
  assert.equal(helpers.readStored(`ytd_session_${sessionId}`).topics.length, 1);
});

test("malformed model output appends nothing and leaves the snapshot untouched", async () => {
  const requests = [];
  const sentMessages = [];
  let fireSummaryTick = null;
  const sessionId = "s_garbage";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ summaryIntervalMinutes: 15 }),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "这段没有可总结的话题。" } }],
        }),
      };
    },
    setIntervalImpl: (cb) => {
      fireSummaryTick = cb;
      return 0;
    },
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  await helpers.handleGetSessionState();
  await fireSummaryTick();

  assert.equal(requests.length, 1, "the tick did ask the AI Provider");
  assert.deepEqual(
    helpers.readStored(`ytd_session_${sessionId}`).topics,
    [],
    "malformed output appends nothing",
  );
  assert.equal(
    sentMessages.filter((message) => message.action === "sessionUpdate").length,
    0,
  );
});

// The tick CHECK runs on a fixed 60-second cadence; the configured interval
// is the CONTENT threshold (isTopicTickDue), so a threshold crossed
// mid-interval ticks at the next check instead of waiting for the boundary.
test("the summary check cadence is fixed and ticks once content crosses the threshold", async () => {
  const requests = [];
  const sentMessages = [];
  const checkDelays = [];
  let fireSummaryCheck = null;
  const sessionId = "s_midinterval";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ summaryIntervalMinutes: 15 }),
    fetchImpl: topicAiFetch(requests),
    setIntervalImpl: (cb, delayMs) => {
      fireSummaryCheck = cb;
      checkDelays.push(delayMs);
      return 0;
    },
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      // Six records cover 9 minutes: below both the 15-minute content
      // threshold and the 10-record debounce.
      [`ytd_session_${sessionId}`]: seededCapture(
        sessionId,
        tenCoverageRecords().slice(0, 6),
      ),
    },
  });

  // Resuming arms the summary timer: one interval, always the fixed 60-second
  // check cadence — never the configured content interval.
  await helpers.handleGetSessionState();
  assert.deepEqual(checkDelays, [60_000]);

  // Heartbeat 1: the content threshold is not met yet, so nothing happens.
  await fireSummaryCheck();
  assert.equal(requests.length, 0, "quiet stretches produce no AI calls");

  // The threshold is crossed MID-INTERVAL: the Session's transcript grows
  // past 15 minutes with 10 records. The state reference here is the one the
  // background itself reports to the panel (handleGetSessionState); in
  // production the pipeline appends records to it as Segments transcribe.
  const resumed = await helpers.handleGetSessionState();
  resumed.state.transcriptRecords = tenCoverageRecords();

  // Heartbeat 2 (the next 60-second check, not an interval boundary): the
  // content-driven decision now fires the tick.
  await fireSummaryCheck();
  assert.equal(requests.length, 1, "the next check ticks once content is due");
  assert.equal(
    helpers.readStored(`ytd_session_${sessionId}`).topics.length,
    1,
    "the tick appends the Topic",
  );
});

// --- Prompt templates load from prompts/*.md through the fetch seam (#33)

// Swallows the loud console output a broken template must produce, so the
// test output stays clean and the loudness itself becomes assertable.
function captureConsoleErrors(run) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.error = original;
    })
    .then((value) => ({ value, errors }));
}

test("a tick with a missing prompt file fails loudly and calls no AI Provider", async () => {
  const requests = [];
  let fireSummaryTick = null;
  const sessionId = "s_no_prompt";
  let topicsAfterTick;

  const { errors } = await captureConsoleErrors(async () => {
    const helpers = loadBackgroundHelpers({
      settings: baseSettings({ summaryIntervalMinutes: 15 }),
      fetchImpl: topicAiFetch(requests),
      // null simulates the file being missing (fetch gets a 404).
      promptFiles: { "topic-tick.md": null },
      setIntervalImpl: (cb) => {
        fireSummaryTick = cb;
        return 0;
      },
      stored: {
        ytd_active_capture: capturePointer(sessionId),
        [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
      },
    });
    await helpers.handleGetSessionState();
    await fireSummaryTick();
    topicsAfterTick = helpers.readStored(`ytd_session_${sessionId}`).topics;
  });

  assert.ok(
    errors.some(
      (line) => /提示词文件加载失败/.test(line) && /topic-tick\.md/.test(line),
    ),
    "the load failure is logged loudly, naming the missing file",
  );
  assert.equal(requests.length, 0, "no AI call happens without the template");
  assert.deepEqual(topicsAfterTick, [], "a failed tick appends nothing");
});

test("ending a Session with a missing report prompt broadcasts a clear error and persists nothing", async () => {
  const requests = [];
  const sentMessages = [];
  const sessionId = "s_no_report_prompt";

  const { errors, value: result } = await captureConsoleErrors(async () => {
    const helpers = loadBackgroundHelpers({
      settings: baseSettings(),
      fetchImpl: reportAiFetch(requests, REPORT_BODY),
      promptFiles: { "session-report.md": null },
      sentMessages,
      stored: {
        ytd_active_capture: capturePointer(sessionId),
        [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
      },
    });
    const outcome = await resumeAndEnd(helpers);
    return { outcome, helpers };
  });

  assert.ok(
    errors.some(
      (line) => /提示词文件加载失败/.test(line) && /session-report\.md/.test(line),
    ),
    "the load failure is logged loudly, naming the missing file",
  );
  assert.equal(requests.length, 0, "no AI call happens without the template");
  assert.match(
    result.outcome.report.error,
    /提示词文件/,
    "the panel payload names the broken prompt file",
  );
  assert.equal(
    result.helpers.readStored(`report_${sessionId}`),
    undefined,
    "a failed pass persists nothing",
  );
  const update = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.report,
  );
  assert.ok(update, "the failure still broadcasts a renderable payload");
  assert.match(update.report.error, /提示词文件/);
});

// --- Capture death: the offscreen recorder's captureEnded notice --------------
//
// Live-tested failure chain: the course tab closes mid-Session, the
// tabCapture stream goes inactive, and every later recorder start throws
// NotSupportedError inside the offscreen document. Segments came back
// [语音转录失败] while the Session zombie-ed on as "active". The recorder
// now sends one captureEnded notice when its stream dies, and the worker
// auto-ends the Session honestly from whatever Transcript exists.

test("a captureEnded notice auto-ends the active Session and broadcasts the reason", async () => {
  const requests = [];
  const sentMessages = [];
  let fireSummaryCheck = null;
  const sessionId = "s_capture_dead";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, REPORT_BODY),
    setIntervalImpl: (cb) => {
      fireSummaryCheck = cb;
      return 0;
    },
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });
  await helpers.handleGetSessionState();

  await helpers.handleCaptureEnded(
    { action: "captureEnded", reason: "capture stream is no longer active" },
    {},
  );

  // Nothing stays resumable: the Session ended and the pointer is cleared.
  assert.equal(helpers.readStored(`ytd_session_${sessionId}`).status, "ended");
  assert.equal(helpers.readStored("ytd_active_capture"), undefined);
  // The panel learns the reason immediately, then sees the ended state with
  // the digest built from the Transcript that exists.
  const notice = sentMessages.find((message) => message.captureNotice);
  assert.ok(notice, "the notice broadcast reaches the panel");
  assert.equal(
    notice.captureNotice,
    "音频采集已中断（标签页已关闭或已离开课程页），会话自动结束。",
  );
  const ended = sentMessages.find(
    (message) =>
      message.action === "sessionUpdate" && message.state?.status === "ended",
  );
  assert.ok(ended, "the end broadcast reaches the panel");
  assert.deepEqual(ended.report, REPORT_BODY);
  assert.equal(requests.length, 1, "exactly one global pass over what exists");

  // Death is final: no further ticks, and a repeated notice is a no-op.
  await fireSummaryCheck();
  assert.equal(requests.length, 1, "an ended Session never ticks again");
  const updatesBefore = sentMessages.filter(
    (message) => message.action === "sessionUpdate",
  ).length;
  await helpers.handleCaptureEnded(
    { action: "captureEnded", reason: "late duplicate" },
    {},
  );
  assert.equal(
    sentMessages.filter((message) => message.action === "sessionUpdate").length,
    updatesBefore,
    "a second captureEnded is a no-op",
  );
});

test("captureEnded on a Session with no Transcript skips the digest without crashing", async () => {
  const requests = [];
  const sentMessages = [];
  const sessionId = "s_death_no_transcript";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, REPORT_BODY),
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      // The stream died before any Segment transcribed: the Session snapshot
      // is the fresh createSession shape with zero records.
      [`ytd_session_${sessionId}`]: JSON.parse(
        JSON.stringify(sessionPipeline.createSession({ sessionId })),
      ),
    },
  });
  await helpers.handleGetSessionState();

  await helpers.handleCaptureEnded(
    { action: "captureEnded", reason: "capture stream is no longer active" },
    {},
  );

  assert.equal(helpers.readStored(`ytd_session_${sessionId}`).status, "ended");
  assert.equal(requests.length, 0, "no AI call without a Transcript");
  assert.equal(
    helpers.readStored(`report_${sessionId}`),
    undefined,
    "a skipped pass persists no artifact",
  );
  const ended = sentMessages.find(
    (message) =>
      message.action === "sessionUpdate" && message.state?.status === "ended",
  );
  assert.ok(ended, "the Session still ends broadcast-honestly");
  // Property assertion only: the skipped payload object is created inside
  // the background VM context, so a cross-realm deepEqual never matches.
  assert.equal(ended.report.skipped, "noTranscript");
});

// WS give-up (#46 reconnect, honest end since 0.1.48): after 5 backoff
// attempts fail, the offscreen client releases the realtime path and sends
// one realtimeGaveUp. The worker handles it like captureEnded — loud log,
// notice broadcast, auto-end — so the learner keeps the transcript collected
// so far and an honest end instead of a zombie Session with a dead stream.

// --- End-of-session global pass (#29): end -> one AI call -> report_<sessionId>

// Schema v2 (0.1.38): the mocked model output carries the new fields too —
// overview conclusions, per-Topic bullets and thematic categories.
const REPORT_BODY = {
  overview: ["这节课围绕三个核心概念展开。", "课后练习比听课更重要。"],
  topics: [
    {
      start: 0,
      end: 900,
      title: "导论",
      bullets: ["课程目标与学习方法。", "三个核心概念的关系。"],
      summary: "老师介绍了课程目标。",
    },
  ],
  categories: [
    { title: "学习方法", points: ["先练习再核对。", "错题要复盘。"] },
  ],
  quotes: [{ start: 30, text: "学习是一场旅程。" }],
  todos: ["完成课后练习"],
};

// A v1-shaped model output: no overview, no bullets, no categories. The
// parser must land it in storage exactly as-is so old renderers (and new
// ones) keep treating it the same.
const V1_REPORT_BODY = {
  topics: [{ start: 0, end: 900, title: "导论", summary: "老师介绍了课程目标。" }],
  quotes: [{ start: 30, text: "学习是一场旅程。" }],
  todos: ["完成课后练习"],
};

function reportAiFetch(capturedRequests, body, finishReason = "stop") {
  return async (_url, options) => {
    capturedRequests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify(body) }, finish_reason: finishReason },
        ],
      }),
    };
  };
}

// Ends the seeded capture through the real resume path, like a learner
// pressing 结束学习.
async function resumeAndEnd(helpers) {
  await helpers.handleGetSessionState();
  return helpers.handleEndLearning();
}

test("ending a Session runs exactly one global pass, persists report_<sessionId> and broadcasts it", async () => {
  const requests = [];
  const sentMessages = [];
  const sessionId = "s_report";
  const pointer = capturePointer(sessionId);
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, REPORT_BODY),
    sentMessages,
    stored: {
      ytd_active_capture: pointer,
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  const result = await resumeAndEnd(helpers);

  assert.equal(result.success, true);
  assert.equal(requests.length, 1, "exactly one global-pass AI call");
  assert.equal(requests[0].max_tokens, 8192);
  // The full Transcript went out, stamped for citation.
  assert.match(requests[0].messages[1].content, /\[0:00\] 第 1 段/);
  assert.match(requests[0].messages[1].content, /\[13:30\] 第 10 段/);

  const stored = helpers.readStored(`report_${sessionId}`);
  assert.ok(stored, "the report artifact is persisted under report_<sessionId>");
  assert.equal(stored.sessionId, sessionId);
  assert.deepEqual(stored.report, REPORT_BODY);
  // Schema v2 (0.1.38): the new fields ride through persistence untouched.
  assert.deepEqual(stored.report.overview, REPORT_BODY.overview);
  assert.deepEqual(stored.report.topics[0].bullets, REPORT_BODY.topics[0].bullets);
  assert.deepEqual(stored.report.categories, REPORT_BODY.categories);
  assert.equal(typeof stored.generatedAtMs, "number");
  // Artifact meta (#30): captured from the ending capture context. The
  // pointer carries the same startedAtMs the resumed context was built
  // from; endedAtMs is the wall-clock end.
  assert.equal(stored.meta.startedAtMs, pointer.startedAtMs);
  assert.equal(typeof stored.meta.endedAtMs, "number");
  assert.equal(stored.meta.kind, "replay");
  assert.equal(stored.meta.platformId, "xiaoe-tech");
  // The generated-at stamp joins the meta so the report header can show
  // when the pass ran (0.1.38).
  assert.equal(stored.meta.generatedAtMs, stored.generatedAtMs);
  assert.equal(
    helpers.readStored(`digest_${sessionId}`),
    undefined,
    "the legacy digest key is never written",
  );

  const update = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.report,
  );
  assert.ok(update, "the end broadcast carries the report");
  assert.deepEqual(update.report, REPORT_BODY);
  assert.equal(update.state.status, "ended");
});

test("a v1 report body without the new fields persists unchanged", async () => {
  const requests = [];
  const sentMessages = [];
  const sessionId = "s_v1_report";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, V1_REPORT_BODY),
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  const result = await resumeAndEnd(helpers);

  assert.equal(result.success, true);
  const stored = helpers.readStored(`report_${sessionId}`);
  assert.ok(stored, "the v1 artifact is persisted under report_<sessionId>");
  assert.deepEqual(stored.report, V1_REPORT_BODY);
  // Byte-identical shape: the parser grew no new keys for a v1 payload.
  assert.deepEqual(Object.keys(stored.report).sort(), ["quotes", "todos", "topics"]);
  assert.equal(stored.report.topics[0].bullets, undefined);
  assert.equal(stored.report.overview, undefined);
  assert.equal(stored.report.categories, undefined);
});

test("a truncated global pass persists nothing and broadcasts the retry error", async () => {
  const requests = [];
  const sentMessages = [];
  const sessionId = "s_truncated";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, REPORT_BODY, "length"),
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  const result = await resumeAndEnd(helpers);

  assert.equal(requests.length, 1);
  assert.equal(
    helpers.readStored(`report_${sessionId}`),
    undefined,
    "a truncated artifact is never persisted",
  );
  assert.equal(result.report.error, "报告长度受限，生成未完成，请重试。");
  const update = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.report,
  );
  assert.equal(update.report.error, "报告长度受限，生成未完成，请重试。");
});

test("regenerateReport re-runs the pass for the ended Session, persists and broadcasts again", async () => {
  const sentMessages = [];
  const sessionId = "s_retry";
  let attempts = 0;
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: async (_url, options) => {
      attempts += 1;
      if (attempts === 1) {
        // First end: the provider truncates mid-JSON.
        return {
          ok: true,
          json: async () => ({
            choices: [
              { message: { content: '{"topics": [' }, finish_reason: "length" },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify(REPORT_BODY) }, finish_reason: "stop" },
          ],
        }),
      };
    },
    sentMessages,
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  await resumeAndEnd(helpers);
  assert.equal(helpers.readStored(`report_${sessionId}`), undefined);

  const retried = await helpers.handleRegenerateReport({});

  assert.equal(retried.success, true);
  assert.equal(retried.sessionId, sessionId);
  assert.deepEqual(retried.report, REPORT_BODY);
  const stored = helpers.readStored(`report_${sessionId}`);
  assert.ok(stored, "the retried pass persists the artifact");
  assert.deepEqual(stored.report, REPORT_BODY);
  const updates = sentMessages.filter(
    (message) => message.action === "sessionUpdate" && message.report,
  );
  assert.equal(updates.length, 2, "the retried report is broadcast again");
  assert.deepEqual(updates[1].report, REPORT_BODY);
});

test("a retried pass reconstructs artifact meta from the Session id and Transcript", async () => {
  const requests = [];
  // A real-format Session id: s_<base36 start ms>_<random>.
  const startMs = new Date(2026, 9, 1, 9, 0).getTime();
  const sessionId = `s_${startMs.toString(36)}_retrymeta`;
  let attempts = 0;
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      attempts += 1;
      if (attempts === 1) {
        // First end: the provider truncates mid-JSON, nothing is persisted.
        return {
          ok: true,
          json: async () => ({
            choices: [
              { message: { content: '{"topics": [' }, finish_reason: "length" },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify(REPORT_BODY) }, finish_reason: "stop" },
          ],
        }),
      };
    },
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  await resumeAndEnd(helpers);
  assert.equal(helpers.readStored(`report_${sessionId}`), undefined);

  const retried = await helpers.handleRegenerateReport({});
  assert.equal(retried.success, true);
  const stored = helpers.readStored(`report_${sessionId}`);
  assert.ok(stored, "the retried pass persists the artifact");
  // The Session id decodes back to the wall-clock start.
  assert.equal(stored.meta.startedAtMs, startMs);
  // The Transcript covers 15 minutes; the end is estimated from its last record.
  assert.equal(stored.meta.endedAtMs, startMs + 900_000);
  // kind/platform are not stored with the snapshot: the renderers omit them.
  assert.equal(stored.meta.kind, undefined);
  assert.equal(stored.meta.platformId, undefined);
});

test("regenerateReport finds the most recent ended Session in storage after a worker restart", async () => {
  const requests = [];
  const sessionId = "s_restarted";
  let endedState = sessionPipeline.createSession({ sessionId });
  endedState = sessionPipeline.applyEvent(endedState, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  endedState = sessionPipeline.applyEvent(endedState, {
    type: "transcribeOk",
    segmentId: "seg-0",
    records: [{ text: "第一段", start: 0, duration: 60 }],
  });
  endedState = sessionPipeline.applyEvent(endedState, { type: "sessionEnd" });

  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, REPORT_BODY),
    // No pointer, no in-memory context: the worker restarted after the end.
    stored: {
      [`ytd_session_${sessionId}`]: JSON.parse(JSON.stringify(endedState)),
    },
  });

  const retried = await helpers.handleRegenerateReport({});

  assert.equal(retried.success, true);
  assert.equal(retried.sessionId, sessionId);
  assert.deepEqual(helpers.readStored(`report_${sessionId}`).report, REPORT_BODY);
});

test("regenerateReport with no ended Session anywhere reports the dead end", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, REPORT_BODY),
  });

  const retried = await helpers.handleRegenerateReport({});

  assert.equal(retried.success, false);
  assert.ok(retried.error);
  assert.equal(requests.length, 0, "no AI call without a Session to re-run");
});

// --- Page title capture (#32): the bridge's pageTitle message ----------------

test("a pageTitle message from the capture tab stores it once and a later title never overwrites", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  assert.equal(started.success, true);
  const sessionId = started.sessionId;

  await helpers.handlePageTitle(
    { action: "pageTitle", title: "第十四讲：机器学习入门" },
    { tab: { id: 7 } },
  );

  assert.equal(
    helpers.readStored(`ytd_session_${sessionId}`).title,
    "第十四讲：机器学习入门",
  );
  // The title survives a service-worker restart via the capture pointer.
  assert.equal(
    helpers.readStored("ytd_active_capture").pageTitle,
    "第十四讲：机器学习入门",
  );

  // First write wins: the pagehide re-report or an SPA rename never
  // replaces the title captured at Session start.
  await helpers.handlePageTitle(
    { action: "pageTitle", title: "页面跳转后的其他标题" },
    { tab: { id: 7 } },
  );
  assert.equal(
    helpers.readStored(`ytd_session_${sessionId}`).title,
    "第十四讲：机器学习入门",
  );
  assert.equal(
    helpers.readStored("ytd_active_capture").pageTitle,
    "第十四讲：机器学习入门",
  );
});

test("a pageTitle message from another tab is ignored", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: apiFetch().fetchImpl,
    stored: CREDENTIAL_STORE,
    settings: baseSettings(),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  await helpers.handlePageTitle(
    { action: "pageTitle", title: "别的标签页的标题" },
    { tab: { id: 8 } },
  );

  assert.equal(
    helpers.readStored(`ytd_session_${started.sessionId}`).title,
    undefined,
  );
  assert.equal(helpers.readStored("ytd_active_capture").pageTitle, undefined);
});

test("ending a Session persists the report meta with the captured title", async () => {
  const requests = [];
  const sessionId = "s_titled";
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, REPORT_BODY),
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  // Resume (worker restart), the bridge reports the title, the learner ends.
  await helpers.handleGetSessionState();
  await helpers.handlePageTitle(
    { action: "pageTitle", title: "第十四讲：机器学习入门" },
    { tab: { id: 7 } },
  );
  const ended = await helpers.handleEndLearning();

  assert.equal(ended.success, true);
  const artifact = helpers.readStored(`report_${sessionId}`);
  assert.ok(artifact, "the report artifact is persisted");
  assert.equal(artifact.meta.title, "第十四讲：机器学习入门");
});

test("a retried pass reconstructs the title from the ended snapshot", async () => {
  const requests = [];
  const startMs = new Date(2026, 9, 1, 9, 0).getTime();
  const sessionId = `s_${startMs.toString(36)}_retrytitle`;
  let attempts = 0;
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      attempts += 1;
      if (attempts === 1) {
        // First end: the provider truncates mid-JSON, nothing is persisted.
        return {
          ok: true,
          json: async () => ({
            choices: [
              { message: { content: '{"topics": [' }, finish_reason: "length" },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify(REPORT_BODY) }, finish_reason: "stop" },
          ],
        }),
      };
    },
    stored: {
      ytd_active_capture: capturePointer(sessionId),
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  await helpers.handleGetSessionState();
  await helpers.handlePageTitle(
    { action: "pageTitle", title: "第十四讲：机器学习入门" },
    { tab: { id: 7 } },
  );
  await helpers.handleEndLearning();
  assert.equal(helpers.readStored(`report_${sessionId}`), undefined);

  const retried = await helpers.handleRegenerateReport({});

  assert.equal(retried.success, true);
  const stored = helpers.readStored(`report_${sessionId}`);
  assert.ok(stored, "the retried pass persists the artifact");
  // The snapshot kept the title through the failed pass; the reconstructed
  // meta carries it so the retried report header still names the lesson.
  assert.equal(stored.meta.title, "第十四讲：机器学习入门");
});

test("a worker restart mid-session rebuilds the title from the capture pointer", async () => {
  const requests = [];
  const sessionId = "s_pointer_title";
  // The worker died between persisting the pointer (title included) and
  // saving the titleCaptured snapshot: the pointer is the only copy.
  const pointer = { ...capturePointer(sessionId), pageTitle: "第十四讲：机器学习入门" };
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    fetchImpl: reportAiFetch(requests, REPORT_BODY),
    stored: {
      ytd_active_capture: pointer,
      [`ytd_session_${sessionId}`]: seededCapture(sessionId, tenCoverageRecords()),
    },
  });

  await helpers.handleGetSessionState();
  const ended = await helpers.handleEndLearning();

  assert.equal(ended.success, true);
  const artifact = helpers.readStored(`report_${sessionId}`);
  assert.equal(
    artifact.meta.title,
    "第十四讲：机器学习入门",
    "the rebuilt context's pageTitle reaches the report meta",
  );
});

test("the settings blob is stamped with the version on the first read", async () => {
  const { handleStartLearning, readStored } = loadBackgroundHelpers({
    settings: baseSettings({ segmentLengthSeconds: 120 }),
    stored: CREDENTIAL_STORE,
    fetchImpl: apiFetch().fetchImpl,
  });

  // The start flow reads settings (and persists the migrated blob) before
  // capture — enough to assert the migration.
  const started = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  assert.equal(started.success, true);

  const blob = readStored("ytd_settings");
  assert.equal(blob.settingsVersion, 4);
  assert.equal(blob.segmentLengthSeconds, 30);
});

// --- Timeline anchoring + seek-awareness (#48) ------------------------------
//
// l_ Sessions run wallclock by URL (D6), but the page bridge already
// reports the media position every second. The worker now probes for it at
// Session start: the first valid position anchors the Session to the video
// timeline; a lapsed window stays wallclock. Anchored Sessions are
// seek-aware exactly like replay ones: forward seeks cut at the seek point
// and mark the skipped gap, re-listened failed Segments retry (Plan A), and
// nothing ever mixes the two timelines inside one Session.

// Drains the fire-and-forget dispatch chain (storage writes, the offscreen
// round trip, the transcription fetch) deterministically.
async function drain(steps = 40) {
  for (let i = 0; i < steps; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// The resolve answer for the xiaoe lesson/lab URLs (contract §3.4): every
// start flow archives against a matched Source now.
const RESOLVED_SOURCE = {
  id: "src_01JABC0002",
  resourceId: "res_01JABC0001",
  kind: "video",
  url: REPLAY_URL,
  platformId: "xiaoe-tech",
  platformVideoId: "l_abc123def456",
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
const SESSION_CREATED_BODY = {
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
};

/**
 * One fetch seam for the whole archive pipeline (ticket 2.4): every /v1
 * call is answered per path, everything else is the AI pass. Every /v1
 * call is recorded with its parsed body so the tests assert the uploads
 * directly. The transcript view ECHOES the accepted uploads keyed by
 * segmentIndex — the server's idempotent (sessionId, segmentIndex) store —
 * so a poll lands exactly the rows the Worker has produced.
 */
function apiFetch({
  resolve = [{ status: 200, body: RESOLVE_MATCHED_BODY }],
  sessions = [],
  segments = [],
  finishes = [],
  transcripts = null,
} = {}) {
  const v1Calls = [];
  let resolveIndex = 0;
  let sessionsIndex = 0;
  let segmentsIndex = 0;
  let transcriptsIndex = 0;
  let finishesIndex = 0;
  const uploads = new Map();
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
  const echoView = () => ({
    sessionId: "ses_01JABC0033",
    sourceId: "src_01JABC0002",
    resourceId: "res_01JABC0001",
    sessionStatus: "active",
    origin: "asr",
    records: [...uploads.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([segmentIndex, upload]) => ({
        startMs: upload.startMs,
        endMs: upload.startMs + upload.durationMs,
        text: "转写内容",
        origin: "asr",
        segmentIndex,
      })),
    gaps: [],
    pending: [],
    failed: [],
  });
  const fetchImpl = async (url, init) => {
    const pathName = String(url).replace(/^https:\/\/api\.example\.com/, "");
    if (pathName === "/v1/sources/resolve") {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return answer(resolve[resolveIndex++] ?? resolve[resolve.length - 1], { matched: false });
    }
    if (/^\/v1\/sources\/[^/]+\/sessions$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return answer(sessions[sessionsIndex++] ?? sessions[sessions.length - 1], SESSION_CREATED_BODY.body);
    }
    if (/^\/v1\/sessions\/[^/]+\/audio-segments$/.test(pathName)) {
      const body = JSON.parse(init.body);
            const scripted = segments[segmentsIndex] ?? segments[segments.length - 1];
      segmentsIndex += 1;
      const status = scripted === undefined ? 201 : scripted.status ?? scripted;
      if (status < 400) {
        // Only accepted uploads occupy the server's idempotent store.
        uploads.set(body.segmentIndex, {
          startMs: body.startMs,
          durationMs: body.durationMs,
        });
      }
      // The response Segment echoes the request (the contract's own shape),
      // so a scripted status alone decides the verdict.
      return {
        status,
        ok: status < 400,
        json: async () => ({
          segment: {
            segmentIndex: body.segmentIndex,
            startMs: body.startMs,
            endMs: body.startMs + body.durationMs,
            status: "pending",
            audioMimeType: body.audioMimeType,
          },
        }),
      };
    }
if (/^\/v1\/sessions\/[^/]+\/transcript$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method });
      if (transcripts) {
        return answer(transcripts[transcriptsIndex++] ?? transcripts[transcripts.length - 1], echoView());
      }
      return { status: 200, ok: true, json: async () => echoView() };
    }
    if (/^\/v1\/sessions\/[^/]+\/finish$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body || "{}") });
      return answer(finishes[finishesIndex++] ?? finishes[finishes.length - 1], {
        session: { id: "ses_01JABC0033", status: "finished", origin: "asr" },
      });
    }
    if (/^\/v1\/sources\/[^/]+\/progress$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return { status: 200, ok: true, json: async () => ({ positionMs: 0, revision: 1 }) };
    }
    // The AI Provider passes (Topic ticks, the end-of-Session report).
    return {
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify({ topics: [], quotes: [], todos: [] }) }, finish_reason: "stop" },
        ],
      }),
    };
  };
  return { v1Calls, fetchImpl };
}

// The offscreen recorder's captureCut answer: one chunk as a data URL.
function cutReply() {
  return (message) =>
    message.action === "captureCut"
      ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
      : { success: true };
}

function mediaPositionMessage(position, extra = {}) {
  return {
    action: "mediaPosition",
    position,
    duration: 9000,
    paused: false,
    ended: false,
    ...extra,
  };
}

// The bridge reports once a second, and the drag fallback threshold is 3s:
// any multi-second jump inside ONE message reads as a drag. playTo feeds the
// per-second stream a real player produces, from `from` (exclusive — the
// position already reported) up to `to` (inclusive), draining after each
// report like the tests do for hand-written messages.
async function playTo(handleMediaPosition, from, to, extra = {}) {
  for (let position = Math.floor(from) + 1; position <= Math.floor(to); position += 1) {
    await handleMediaPosition(mediaPositionMessage(position, extra), { tab: { id: 7 } });
    await drain();
  }
}

// The settings migration forces a stored 120 (the legacy default) back
// to 30 unless the blob is stamped with the current version, so these tests
// pin the version to keep the round Segment numbers in their assertions.
function pinnedSettings(overrides = {}) {
  return { ...baseSettings(overrides), settingsVersion: 3 };
}

test("a wallclock l_ Session anchors to the video timeline on the first bridged position", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    sentMessages,
  });

  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.success, true);
  assert.equal(started.timestampKind, "wallclock");

  // The bridge reports the video parked at 13:20 within the probe window.
  // Any bridged position anchors — paused included (keep-it-simple rule).
  await helpers.handleMediaPosition(mediaPositionMessage(800, { paused: true }), {
    tab: { id: 7 },
  });
  await drain();

  assert.equal((await helpers.handleGetSessionState()).timestampKind, "video");
  // The anchored mode is persisted in the pointer with the segmenter cursor.
  // 0.1.60: the anchor snaps UP to the next Segment-length boundary (60s
  // grid), so 13:20 lands on 14:00.
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.timestampKind, "video");
  assert.equal(pointer.cursorSeconds, 840);

  // The skipped head (0 → 840) produces nothing: the first Segment starts
  // at the snapped anchor position with the post-anchor audio.
  await playTo(helpers.handleMediaPosition, 840, 960);
  await helpers.handleMediaPosition(mediaPositionMessage(960.4), { tab: { id: 7 } });
  await drain();
  // The Workers' rows land via the §3.5 poll (the upload carries no text).
  await helpers.pollTranscriptForTest();
  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 840, duration: 60 },
      { start: 900, duration: 60 },
    ],
  );
  assert.equal(snapshot.transcriptRecords[0].start, 840);
  // The anchor broadcast tells the panel the timeline flipped immediately.
  const update = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.timestampKind,
  );
  assert.equal(update.timestampKind, "video");
});

test("a wallclock Session with no bridged position in the probe window stays wallclock", async () => {
  let now = 1_700_000_000_000;
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    dateNow: () => now,
  });

  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.timestampKind, "wallclock");

  // The window lapses before any position arrives; a true live stream
  // (infinite duration) is ignored afterwards and the Session keeps today's
  // wallclock behavior.
  now += 11_000;
  await helpers.handleMediaPosition(mediaPositionMessage(800, { duration: null }), {
    tab: { id: 7 },
  });
  await drain();

  assert.equal((await helpers.handleGetSessionState()).timestampKind, "wallclock");
  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.segments, []);
  assert.deepEqual(snapshot.transcriptRecords, []);

  // The timeline never switches mid-Session: later positions change nothing.
  now += 1_000;
  await helpers.handleMediaPosition(mediaPositionMessage(900, { duration: null }), {
    tab: { id: 7 },
  });
  await drain();
  assert.equal((await helpers.handleGetSessionState()).timestampKind, "wallclock");
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.segments, []);
});

test("a live URL converts to replay when a finite-duration recording reports inside the probe window (0.1.66)", async () => {
  let now = 1_700_000_000_000;
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings({ segmentLengthSeconds: 15 }),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    dateNow: () => now,
  });

  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.kind, "live");
  now += 1_000;
  await helpers.handleMediaPosition(mediaPositionMessage(2, { duration: 9272 }), {
    tab: { id: 7 },
  });
  await drain();

  const state = await helpers.handleGetSessionState();
  assert.equal(state.kind, "replay", "finite duration must not stay mislabeled as 直播");
  assert.equal(state.timestampKind, "video");
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.kind, "replay");
  assert.equal(pointer.timestampKind, "video");
  assert.equal(pointer.cursorSeconds, 15);
  assert.equal((await helpers.handleRestartFromBeginning()).success, true);
});

test("a live Session converts to replay when a finite-duration recording reports after the probe lapsed (0.1.64)", async () => {
  let now = 1_700_000_000_000;
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    dateNow: () => now,
  });

  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.timestampKind, "wallclock");

  // The probe lapsed with no position. Then the page (a live REPLAY with a
  // 2:34:32 recording) starts reporting: convert to replay + video timeline.
  now += 11_000;
  await helpers.handleMediaPosition(mediaPositionMessage(66, { duration: 9272 }), {
    tab: { id: 7 },
  });
  await drain();

  const state = await helpers.handleGetSessionState();
  assert.equal(state.kind, "replay");
  assert.equal(state.timestampKind, "video");
  // The pointer carries the flip across a worker restart; the anchor snapped
  // UP to the 60s grid.
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.kind, "replay");
  assert.equal(pointer.timestampKind, "video");
  assert.equal(pointer.cursorSeconds, 120);

  // Without pressing 从头开始, Segments cut on the video grid from the
  // detected anchor, not the wall clock. The explicit rewind path has its
  // own 15-second regression immediately below.
  await playTo(helpers.handleMediaPosition, 120, 180);
  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [{ start: 120, duration: 60 }],
  );
});

test("a late-detected live replay rewinds an empty Session and transcribes from 0:00", async () => {
  let now = 1_700_000_000_000;
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings({ segmentLengthSeconds: 15 }),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    dateNow: () => now,
  });

  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  now += 11_000;
  // The recording is found at 0:02, so the mid-video anchor snaps to 0:15.
  await helpers.handleMediaPosition(mediaPositionMessage(2, { duration: 9272 }), {
    tab: { id: 7 },
  });
  await drain();
  assert.equal(helpers.readStored("ytd_active_capture").cursorSeconds, 15);

  const rewind = await helpers.handleRestartFromBeginning();
  assert.equal(rewind.success, true);
  await helpers.handleMediaPosition(mediaPositionMessage(0, { duration: 9272 }), {
    tab: { id: 7 },
  });
  await playTo(helpers.handleMediaPosition, 0, 15, { duration: 9272 });
  await helpers.pollTranscriptForTest();

  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
      status: segment.status,
    })),
    [{ start: 0, duration: 15, status: "done" }],
    "从头开始 must reopen the never-captured prefix instead of waiting beyond the old anchor",
  );
  assert.equal(snapshot.transcriptRecords[0].start, 0);
});

test("a true live stream (infinite duration) stays wallclock after the probe lapsed", async () => {
  let now = 1_700_000_000_000;
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    dateNow: () => now,
  });
  await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  now += 11_000;
  await helpers.handleMediaPosition(mediaPositionMessage(66, { duration: null }), {
    tab: { id: 7 },
  });
  await drain();

  const state = await helpers.handleGetSessionState();
  assert.equal(state.kind, "live");
  assert.equal(state.timestampKind, "wallclock");
});

test("the first bridged position arms the drag baseline instead of marking a gap", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  // The learner opens the lesson mid-video: the very first report is 1:00.
  // It arms the drag-detection baseline (never itself a drag): no false gap
  // marker for the head. The head's coverage stays the pre-existing
  // simplification (the segmenter starts at 0), unchanged by this rule.
  await helpers.handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await drain();
  // Stop short of the second 60s boundary: exactly one Segment exists.
  await playTo(helpers.handleMediaPosition, 60, 110);
  await helpers.pollTranscriptForTest();

  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
    })),
    [{ text: "转写内容", start: 0 }],
  );
  assert.equal(
    snapshot.transcriptRecords.filter((record) => record.failed === true).length,
    0,
    "no gap marker for the Session's opening position",
  );
});

test("seek-forward cuts the pre-seek tail, jumps the cursor and marks the skipped gap", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    // The tail cut holds 60s of pre-seek audio; the post-seek Segment 120s.
    sentMessages,
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  // One minute played, then the learner drags the bar to 10:00.
  await playTo(helpers.handleMediaPosition, 0, 60);
  await helpers.handleMediaPosition(mediaPositionMessage(600), { tab: { id: 7 } });
  await drain();
  await helpers.pollTranscriptForTest();

  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  // (a) The pre-seek audio landed as a tail record with pre-seek timestamps.
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [{ start: 0, duration: 60 }],
  );
  // (c) One visible gap marker covers the skipped range — and nothing else
  // was emitted for it.
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      duration: record.duration,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 0, duration: 60, failed: false },
      { text: "[已跳过 1:00–10:00]", start: 60, duration: 540, failed: true },
    ],
  );
  // The seek point was cut on demand.
  assert.ok(sentMessages.some((message) => message.action === "captureCut"));

  // (d) The next Segment starts at the new position with post-seek audio;
  // the jumped cursor survived in the pointer.
  assert.equal(helpers.readStored("ytd_active_capture").cursorSeconds, 600);
  await playTo(helpers.handleMediaPosition, 600, 720);
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 0, duration: 60 },
      { start: 600, duration: 60 },
      { start: 660, duration: 60 },
    ],
  );
});

test("a forward-drag landing snaps up to the Segment grid before resuming (0.1.60)", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    // The tail cut holds 60s of pre-seek audio; the resumed Segments 60s.
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  // One minute played, then the learner drags the bar to 10:47 — NOT on the
  // 60s grid. The landing snaps UP to 11:00: the marker covers up to 11:00,
  // the cursor jumps there, and transcription resumes on the boundary.
  await playTo(helpers.handleMediaPosition, 0, 60);
  await helpers.handleMediaPosition(mediaPositionMessage(647), { tab: { id: 7 } });
  await drain();
  await helpers.pollTranscriptForTest();

  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      duration: record.duration,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 0, duration: 60, failed: false },
      { text: "[已跳过 1:00–11:00]", start: 60, duration: 600, failed: true },
    ],
  );
  assert.equal(helpers.readStored("ytd_active_capture").cursorSeconds, 660);

  await playTo(helpers.handleMediaPosition, 647, 840);
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 0, duration: 60 },
      { start: 660, duration: 60 },
      { start: 720, duration: 60 },
      { start: 780, duration: 60 },
    ],
  );
});

test("a forward drag discards the in-flight partial Segment (0.1.62)", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    sentMessages,
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  // 45s played with a 60s grid: NOTHING has been submitted yet — the first
  // Segment is still in flight. Dragging to 5:00 must NOT transcribe those
  // 45 seconds: they fold into the skipped marker as one hole [0:00, 5:00].
  await playTo(helpers.handleMediaPosition, 0, 45);
  await helpers.handleMediaPosition(mediaPositionMessage(300), { tab: { id: 7 } });
  await drain();

  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      duration: record.duration,
      failed: record.failed === true,
    })),
    [{ text: "[已跳过 0:00–5:00]", start: 0, duration: 300, failed: true }],
  );
  assert.equal(
    snapshot.transcriptRecords.filter((record) => record.text === "转写内容").length,
    0,
    "the in-flight partial is discarded, never transcribed",
  );
  // The partial audio was cut and dropped at the recorder, not flushed.
  assert.ok(sentMessages.some((message) => message.action === "captureCut"));

  // Resuming lands full grid cells only: [5:00, 6:00].
  await playTo(helpers.handleMediaPosition, 300, 360);
  await helpers.pollTranscriptForTest();
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [{ start: 300, duration: 60 }],
  );
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      failed: record.failed === true,
    })),
    [
      { text: "[已跳过 0:00–5:00]", start: 0, failed: true },
      { text: "转写内容", start: 300, failed: false },
    ],
  );
});

test("re-listening a failed Segment retries it once and replaces the marker with no duplicates", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    // First pass: seg-0's upload is refused (a terminal 400 — the segment
    // fails locally with its marker), seg-1 archives; the re-listen retry
    // of seg-0 then uploads under its own free index and is accepted.
    fetchImpl: apiFetch({
      // The scripted list repeats its last entry, so the refused first
      // upload must be followed by explicit 201s for every later Segment.
      segments: [
        { status: 400, body: { error: { code: "validation_failed", message: "boom" } } },
        { status: 201, body: { segment: {} } },
        { status: 201, body: { segment: {} } },
        { status: 201, body: { segment: {} } },
        { status: 201, body: { segment: {} } },
        { status: 201, body: { segment: {} } },
        { status: 201, body: { segment: {} } },
        { status: 201, body: { segment: {} } },
      ],
    }).fetchImpl,
    sendMessageImpl: cutReply(),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  // First pass: two Segments, the first failed with its visible marker. The
  // bridge ticks once a second, so the feeds stay under the drag threshold.
  await helpers.handleMediaPosition(mediaPositionMessage(0), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 0, 60);
  await playTo(helpers.handleMediaPosition, 60, 130);
  await playTo(helpers.handleMediaPosition, 130, 250);
  await helpers.pollTranscriptForTest();
  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => segment.status),
    ["failed", "done", "done", "done"],
  );
  const marker = snapshot.transcriptRecords.find((record) => record.failed === true);
  assert.equal(marker.text, "[语音转录失败]");

  // Seek back to 0:00 and re-listen through the failed range.
  await helpers.handleMediaPosition(mediaPositionMessage(0), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 0, 60);
  await playTo(helpers.handleMediaPosition, 60, 130);

  await helpers.pollTranscriptForTest();
  // The retry landed under the failed Segment's own id: its marker is
  // replaced in place, the timeline stays single-copy and monotonic.
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => segment.status),
    ["done", "done", "done", "done"],
  );
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 0, failed: false },
      { text: "转写内容", start: 60, failed: false },
      { text: "转写内容", start: 120, failed: false },
      { text: "转写内容", start: 180, failed: false },
    ],
  );

  // Plan A: covered ranges are never re-emitted, and new content resumes
  // once playback passes the old cursor frontier.
  await playTo(helpers.handleMediaPosition, 130, 240);
  await playTo(helpers.handleMediaPosition, 240, 360);
  await helpers.pollTranscriptForTest();
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.equal(snapshot.segments.length, 6);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 0, duration: 60 },
      { start: 60, duration: 60 },
      { start: 120, duration: 60 },
      { start: 180, duration: 60 },
      { start: 240, duration: 60 },
      { start: 300, duration: 60 },
    ],
  );
  assert.equal(snapshot.transcriptRecords.length, 6);
  assert.equal(snapshot.transcriptRecords.filter((record) => record.failed).length, 0);
});

// --- Hole-fill: re-watching a skipped range transcribes it (#48 defect) ----

test("an anchored l_ Session re-watching its skipped hole fills it and removes the fully filled marker", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
  });

  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  // The probe anchors at 2:00; dragging to 5:00 cuts no tail (the anchor
  // consumed the probe audio) and marks the hole [2:00, 5:00].
  await helpers.handleMediaPosition(mediaPositionMessage(120), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(300), { tab: { id: 7 } });
  await drain();
  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => record.text),
    ["[已跳过 2:00–5:00]"],
  );

  // Dragging back into the hole at its start arms the first fill window.
  await helpers.handleMediaPosition(mediaPositionMessage(120), { tab: { id: 7 } });
  await drain();
  // Crossing the first boundary dispatches fill Segment [2:00, 3:00] with the
  // re-watched hole audio, stamped at the in-hole position; the marker
  // shrinks to the unfilled tail.
  await playTo(helpers.handleMediaPosition, 120, 180);
  await helpers.pollTranscriptForTest();
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      id: segment.id,
      start: segment.start,
      duration: segment.duration,
    })),
    [{ id: "seg-fill-120", start: 120, duration: 60 }],
  );
  // The view sync keeps the timeline video-time ordered: the fill's row
  // (start 2:00) sorts before the shrunken marker (start 3:00).
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 120, failed: false },
      { text: "[已跳过 3:00–5:00]", start: 180, failed: true },
    ],
  );

  // The remaining fills complete the hole: the marker is gone entirely, and
  // crossing the old cursor frontier resumes the normal Segment flow.
  await playTo(helpers.handleMediaPosition, 180, 300);
  await playTo(helpers.handleMediaPosition, 300, 420);
  await helpers.pollTranscriptForTest();
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 120, duration: 60 },
      { start: 180, duration: 60 },
      { start: 240, duration: 60 },
      { start: 300, duration: 60 },
      { start: 360, duration: 60 },
    ],
  );
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 120, failed: false },
      { text: "转写内容", start: 180, failed: false },
      { text: "转写内容", start: 240, failed: false },
      { text: "转写内容", start: 300, failed: false },
      { text: "转写内容", start: 360, failed: false },
    ],
  );
});

test("re-watching into a hole from its middle fills it and leaves the remaining head as the shrunken marker", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  // One minute played, then the drag to 10:00 marks the hole [1:00, 10:00].
  await helpers.handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(600), { tab: { id: 7 } });
  await drain();

  // 0.1.60: dragging back INTO the hole (5:00) lands ON the 60s grid, so the
  // fill pass starts right there — one 60s fill per boundary until the hole
  // is covered, then the normal Segment flow resumes past the old cursor.
  await helpers.handleMediaPosition(mediaPositionMessage(300), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 300, 420);
  await playTo(helpers.handleMediaPosition, 420, 540);
  await playTo(helpers.handleMediaPosition, 540, 600);
  await playTo(helpers.handleMediaPosition, 600, 720);
  await helpers.pollTranscriptForTest();

  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 0, duration: 60 },
      { start: 300, duration: 60 },
      { start: 360, duration: 60 },
      { start: 420, duration: 60 },
      { start: 480, duration: 60 },
      { start: 540, duration: 60 },
      { start: 600, duration: 60 },
      { start: 660, duration: 60 },
    ],
  );
  // The unfilled head [1:00, 5:00) remains visible as the shrunken marker;
  // the fill records are plain transcript rows, never duplicates.
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 0, failed: false },
      { text: "[已跳过 1:00–5:00]", start: 60, failed: true },
      { text: "转写内容", start: 300, failed: false },
      { text: "转写内容", start: 360, failed: false },
      { text: "转写内容", start: 420, failed: false },
      { text: "转写内容", start: 480, failed: false },
      { text: "转写内容", start: 540, failed: false },
      { text: "转写内容", start: 600, failed: false },
      { text: "转写内容", start: 660, failed: false },
    ],
  );

  // Re-watching the now-COVERED range produces nothing (Plan A unchanged).
  await helpers.handleMediaPosition(mediaPositionMessage(350), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 350, 400);
  const reread = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(reread.segments, snapshot.segments);
  assert.deepEqual(reread.transcriptRecords, snapshot.transcriptRecords);
});

test("seeking out of a hole mid-fill stops filling and re-entering the unfilled head refills it", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  await helpers.handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(600), { tab: { id: 7 } });
  await drain();

  // Enter the hole at 5:00 (on the 60s grid): the fill window is [5:00, 6:00],
  // then drag out of the hole to 0:30 mid-window (at 5:50, before 6:00).
  await helpers.handleMediaPosition(mediaPositionMessage(300), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 300, 350);
  await helpers.handleMediaPosition(mediaPositionMessage(30), { tab: { id: 7 } });
  await drain();
  await helpers.pollTranscriptForTest();
  // Filling stopped: the marker keeps its full range intact and no further
  // records land for the abandoned window.
  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      duration: record.duration,
    })),
    [
      { text: "转写内容", start: 0, duration: 60 },
      { text: "[已跳过 1:00–10:00]", start: 60, duration: 540 },
    ],
  );

  // Re-entering the unfilled head at 3:20 snaps the entry to 4:00 and fills
  // [4:00, 5:00], shrinking the marker's head to [1:00, 4:00).
  await helpers.handleMediaPosition(mediaPositionMessage(200), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 200, 300);
  await helpers.pollTranscriptForTest();
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 0, duration: 60 },
      { start: 240, duration: 60 },
    ],
  );
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 0, failed: false },
      { text: "[已跳过 1:00–4:00]", start: 60, failed: true },
      { text: "转写内容", start: 240, failed: false },
    ],
  );
});

test("a failed hole-fill keeps the skipped marker intact for a later retry", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    // The pre-seek tail uploads (201); the in-hole fill's upload is then
    // refused (a terminal 400) — its Segment fails locally and stays
    // retryable.
    fetchImpl: apiFetch({
      segments: [
        { status: 201, body: { segment: {} } },
        { status: 400, body: { error: { code: "validation_failed", message: "boom" } } },
      ],
    }).fetchImpl,
    sendMessageImpl: cutReply(),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  await helpers.handleMediaPosition(mediaPositionMessage(0), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 0, 60);
  await helpers.handleMediaPosition(mediaPositionMessage(600), { tab: { id: 7 } });
  await drain();

  // Re-watch from 5:00 (on the 60s grid): the [5:00, 6:00] fill's
  // transcription fails. Playback stops AT the failed window's boundary so
  // no successor window arms within this pass.
  await helpers.handleMediaPosition(mediaPositionMessage(300), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 300, 360);
  await helpers.pollTranscriptForTest();

  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  // The hole marker keeps its FULL range — a failed fill never shrinks it.
  const gap = snapshot.transcriptRecords.find(
    (record) => record.failed === true && record.text.startsWith("[已跳过 "),
  );
  assert.deepEqual(
    { text: gap.text, start: gap.start, duration: gap.duration },
    { text: "[已跳过 1:00–10:00]", start: 60, duration: 540 },
  );
  // The failed fill leaves its own failure marker (retryable), and no fill
  // record pretends the range was transcribed.
  const fillFailure = snapshot.transcriptRecords.find(
    (record) => record.failed === true && record.text === "[语音转录失败]",
  );
  assert.ok(fillFailure, "the failed fill shows a failure marker");
  assert.equal(
    snapshot.transcriptRecords.filter((record) => record.text === "转写内容").length,
    1,
    "only the pre-seek tail has text",
  );
});

test("a drag deep through a hole skips the unwatched window's fill and resumes at the new position", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  await helpers.handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(720), { tab: { id: 7 } });
  await drain();

  // Arm the fill at 5:00 (on-grid, window [5:00, 6:00]), then drag deep past
  // the window's boundary within one tick: the seek cut discards the pending
  // fill, and the pass re-arms with its entry snapped to 10:00 so the resume
  // lands on the grid.
  await helpers.handleMediaPosition(mediaPositionMessage(300), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 300, 350);
  await helpers.handleMediaPosition(mediaPositionMessage(580), { tab: { id: 7 } });
  await drain();
  await playTo(helpers.handleMediaPosition, 580, 600);
  await playTo(helpers.handleMediaPosition, 600, 720);
  await helpers.pollTranscriptForTest();

  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 0, duration: 60 },
      { start: 600, duration: 60 },
      { start: 660, duration: 60 },
    ],
  );
  // The marker shrinks to the head before the resumed fill's entry point.
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 0, failed: false },
      { text: "[已跳过 1:00–10:00]", start: 60, failed: true },
      { text: "转写内容", start: 600, failed: false },
      { text: "转写内容", start: 660, failed: false },
    ],
  );
});

test("a worker restart keeps the anchored video timeline and its cursor", async () => {
  const sentMessages = [];
  const first = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    sentMessages,
  });
  const started = await first.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  await first.handleMediaPosition(mediaPositionMessage(800), { tab: { id: 7 } });
  await drain();

  // The worker restarts: the pointer (timestampKind video, cursor 800) and
  // the snapshot rebuild the context. No re-probe, no wallclock re-arm.
  const second = loadBackgroundHelpers({
    settings: pinnedSettings(),
    fetchImpl: apiFetch().fetchImpl,
    sendMessageImpl: cutReply(),
    sentMessages,
    offscreenDocument: false,
    stored: {
      ytd_active_capture: first.readStored("ytd_active_capture"),
      [`ytd_session_${started.sessionId}`]: first.readStored(
        `ytd_session_${started.sessionId}`,
      ),
    },
  });

  const state = await second.handleGetSessionState();
  assert.equal(state.active, true);
  assert.equal(state.timestampKind, "video");
  // The restarted capture is armed as a video-mode capture: no wallclock cut.
  const restartStart = sentMessages
    .filter((message) => message.action === "captureStart")
    .pop();
  assert.equal(restartStart.mode, "video");

  // Positions continue on the video timeline from the persisted cursor
  // (0.1.60: the snapped anchor grid point).
  await playTo(second.handleMediaPosition, 840, 960);
  await second.handleMediaPosition(mediaPositionMessage(960.4), { tab: { id: 7 } });
  await drain();
  const snapshot = second.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 840, duration: 60 },
      { start: 900, duration: 60 },
    ],
  );
});
