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
