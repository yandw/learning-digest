/**
 * Background capture-orchestration behaviors, tested through the shared
 * load-background seam: the provider-aware start gate (#9 / #21 finding 9)
 * and the resume path settling interrupted in-flight Segments (#8 / #21
 * finding 8, the #12 / US15 contract).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackgroundHelpers } = require("./helpers/load-background.js");
const sessionPipeline = require("../session-pipeline.js");

const REPLAY_URL = "https://app12345.xiaoe-tech.com/replay/l_abc123def456";

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    speechProvider: "groq",
    speechProviders: { groq: { apiKey: "groq-key" } },
    segmentLengthSeconds: 120,
    summaryIntervalMinutes: 30,
    ...overrides,
  };
}

// --- Start gate: validate against the SELECTED provider's credential fields

test("startLearning gate names the missing field for Groq", async () => {
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: baseSettings({
      speechProviders: { groq: { apiKey: "" } },
    }),
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, false);
  assert.match(result.error, /apiKey/);
});

test("startLearning gate names the missing field for Tencent", async () => {
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: baseSettings({
      speechProvider: "tencent",
      speechProviders: { tencent: { secretId: "id-only", secretKey: "" } },
    }),
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, false);
  assert.match(result.error, /secretKey/);
});

test("background start forces openPanelOnActionClick off so icon clicks fire onClicked", () => {
  const calls = [];
  loadBackgroundHelpers({
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

test("startLearning gate names the missing field for Qwen", async () => {
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: baseSettings({
      speechProvider: "qwen",
      speechProviders: {
        qwen: { apiKey: "" },
      },
    }),
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, false);
  assert.match(result.error, /apiKey/);
});

test("startLearning proceeds to capture when the selected provider's credentials are complete", async () => {
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: baseSettings({
      speechProvider: "tencent",
      speechProviders: {
        tencent: { secretId: "id", secretKey: "key" },
      },
    }),
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, true);
  assert.equal(result.sessionId.startsWith("s_"), true);
});

test("startLearning maps Chrome's not-invoked tabCapture error to a Chinese instruction", async () => {
  const { handleStartLearning, readLastStartFailure } = loadBackgroundHelpers({
    settings: baseSettings(),
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
    settings: baseSettings(),
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
  const LIVE_URL = "https://app12345.xiaoe-tech.com/live/l_abc123def456";
  const { handleActionClicked, handleGetSessionState } = loadBackgroundHelpers({
    settings: baseSettings(),
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

test("action click on an unrecognized page only opens the panel", async () => {
  let streamRequested = false;
  const { handleActionClicked, readLastStartFailure } = loadBackgroundHelpers({
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
    settings: baseSettings(),
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
    settings: baseSettings({
      speechProviders: { groq: { apiKey: "" } },
    }),
    sentMessages,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
  });

  await handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });

  const startError = sentMessages.find((message) => message.startError);
  assert.ok(startError, "the panel receives the failure reason");
  assert.match(startError.startError, /apiKey/);
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
