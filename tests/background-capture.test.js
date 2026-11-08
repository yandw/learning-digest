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

// Qwen settings with an optional transcription mode (#45). When mode is
// null the credentials carry no mode key at all (the pre-0.1.43 blob shape).
function qwenSettings(mode, overrides = {}) {
  return baseSettings({
    speechProvider: "qwen",
    speechProviders: {
      qwen: mode === null ? { apiKey: "qwen-key" } : { apiKey: "qwen-key", mode },
    },
    ...overrides,
  });
}

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

// --- Transcription mode resolution (#45/#49): qwen realtime on any Session kind

test("qwen realtime mode on a wallclock Session resolves captureStart transcribeMode realtime", async () => {
  const sentMessages = [];
  const { handleStartLearning, readStored } = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    sentMessages,
  });

  const result = await handleStartLearning({ url: LIVE_URL, tabId: 7 });

  assert.equal(result.success, true);
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
  assert.equal(start.transcribeMode, "realtime");
  // The pre-existing cut-cadence field is untouched: wallclock cutting stays.
  assert.equal(start.mode, "wallclock");
  // The mode travels like kind/timestampKind: start response, capture pointer.
  assert.equal(result.transcribeMode, "realtime");
  assert.equal(readStored("ytd_active_capture").transcribeMode, "realtime");
});

test("qwen realtime mode on a replay Session resolves captureStart transcribeMode realtime", async () => {
  const sentMessages = [];
  const { handleStartLearning, readStored } = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    sentMessages,
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, true);
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
  assert.equal(start.transcribeMode, "realtime");
  // The pre-existing cut-cadence field is untouched: video cutting stays.
  assert.equal(start.mode, "video");
  assert.equal(result.transcribeMode, "realtime");
  assert.equal(readStored("ytd_active_capture").transcribeMode, "realtime");
});

// The third timestampKind (review finding): a COURSE page is video-kind
// like a replay — the branch test pins the whole video family on realtime.
const COURSE_URL =
  "https://apptdemenwi8039.pc.xiaoe-tech.com/p/t_pc/goods_pc_detail/goods_detail/term_5f4380290ac80_9unBs1";

test("qwen realtime mode on a course Session resolves captureStart transcribeMode realtime", async () => {
  const sentMessages = [];
  const { handleStartLearning, readStored } = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    sentMessages,
  });

  const result = await handleStartLearning({ url: COURSE_URL, tabId: 7 });

  assert.equal(result.success, true);
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
  assert.equal(start.transcribeMode, "realtime");
  assert.equal(start.mode, "video");
  assert.equal(result.transcribeMode, "realtime");
  assert.equal(readStored("ytd_active_capture").transcribeMode, "realtime");
});

test("qwen segment mode on a wallclock Session stays on segment transcription", async () => {
  const sentMessages = [];
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: qwenSettings("segment"),
    sentMessages,
  });

  const result = await handleStartLearning({ url: LIVE_URL, tabId: 7 });

  assert.equal(result.success, true);
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
  assert.equal(start.transcribeMode, "segment");
  assert.equal(start.mode, "wallclock");
  assert.equal(result.transcribeMode, "segment");
});

test("credentials without a mode key (pre-0.1.43 blob) stay on segment transcription", async () => {
  const sentMessages = [];
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: qwenSettings(null),
    sentMessages,
  });

  const result = await handleStartLearning({ url: LIVE_URL, tabId: 7 });

  assert.equal(result.success, true);
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.equal(start.transcribeMode, "segment");
  assert.equal(result.transcribeMode, "segment");
});

// --- Realtime capture (#46): the API key rides captureStart to offscreen ----
//
// The realtime WebSocket lives in the offscreen document and needs the Qwen
// key for its handshake; it travels in the captureStart message and is never
// persisted (the capture pointer stays key-free).

test("a realtime captureStart carries the Qwen apiKey to offscreen", async () => {
  const sentMessages = [];
  const { handleStartLearning, readStored } = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    sentMessages,
  });

  await handleStartLearning({ url: LIVE_URL, tabId: 7 });

  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.equal(start.apiKey, "qwen-key");
  // Message-only transport: the persisted pointer never sees the key.
  assert.equal(readStored("ytd_active_capture").apiKey, undefined);
});

test("a segment captureStart carries no apiKey", async () => {
  const sentMessages = [];
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: qwenSettings("segment"),
    sentMessages,
  });

  await handleStartLearning({ url: LIVE_URL, tabId: 7 });

  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.equal(start.apiKey, undefined);
});

// --- Realtime pipeline handling (#47): utterances become Transcript records
//
// R3 replaces the 0.1.46 forwarding: realtimePartial stays a lightweight
// panel-only broadcast (the panel owns the draft display), realtimeUtterance
// feeds the pipeline as an utteranceCaptured event (record → persist →
// broadcast → Topic tick), and realtimeError surfaces loudly. The offscreen
// document sends these unsolicited, so the handlers stay fire-and-forget
// like captureChunk.

test("realtimePartial broadcasts a lightweight sessionUpdate extra without state", async () => {
  const sentMessages = [];
  const { handleStartLearning, handleRealtimePartial } = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    sentMessages,
  });
  const started = await handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.success, true);

  await handleRealtimePartial({ action: "realtimePartial", text: "正在说的话" });

  const partial = sentMessages.find((message) => message.realtimePartial);
  assert.ok(partial, "the partial reaches the panel as a sessionUpdate extra");
  assert.equal(partial.action, "sessionUpdate");
  // Property assertion: the payload is created inside the background VM
  // context, so a cross-realm deepEqual never matches.
  assert.equal(partial.realtimePartial.text, "正在说的话");
  assert.equal(partial.sessionId, started.sessionId);
  // Lightweight: partials stream at speaking pace, so the draft extra must
  // not ship the full Session state on every revision.
  assert.equal(partial.state, undefined);
});

test("a realtime utterance appends a Transcript record, persists and broadcasts", async () => {
  const sentMessages = [];
  const { handleStartLearning, handleRealtimeUtterance, readStored } =
    loadBackgroundHelpers({
      settings: qwenSettings("realtime"),
      sentMessages,
    });
  const started = await handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.success, true);

  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "一句完整的话。",
    start: 12.5,
    duration: 5.5,
  });
  // An empty draft never reaches the pipeline.
  await handleRealtimeUtterance({ action: "realtimeUtterance", text: "   " });

  const snapshot = readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.transcriptRecords, [
    { text: "一句完整的话。", start: 12.5, duration: 5.5 },
  ]);
  assert.deepEqual(snapshot.segments, [], "realtime has no Segments");
  const update = sentMessages
    .filter((message) => message.action === "sessionUpdate" && message.state)
    .pop();
  assert.ok(update, "the panel receives the grown state");
  assert.equal(update.state.transcriptRecords.length, 1);
});

test("a failed realtime utterance lands as a failure-marker record", async () => {
  const sentMessages = [];
  const { handleStartLearning, handleRealtimeUtterance, readStored } =
    loadBackgroundHelpers({
      settings: qwenSettings("realtime"),
      sentMessages,
    });
  const started = await handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.success, true);

  // The offscreen tracker places the failed utterance via its
  // speech_started/stopped pairing and marks the record failed; the
  // worker must carry the flag into the pipeline untouched.
  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "[实时转写失败]",
    start: 12.5,
    duration: 5.5,
    failed: true,
  });
  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "之后恢复的一句。",
    start: 20,
    duration: 3,
  });

  const snapshot = readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.transcriptRecords, [
    { text: "[实时转写失败]", start: 12.5, duration: 5.5, failed: true },
    { text: "之后恢复的一句。", start: 20, duration: 3 },
  ]);
  // The broadcast carries the marker too: the panel's failure styling keys
  // off the flag alone, via the normal row path.
  const update = sentMessages
    .filter((message) => message.action === "sessionUpdate" && message.state)
    .pop();
  assert.ok(update, "the panel receives the grown state");
  assert.equal(update.state.transcriptRecords[0].failed, true);
});

test("realtime utterances trigger a Topic tick once coverage crosses the threshold", async () => {
  const requests = [];
  const sentMessages = [];
  const sessionId = "s_rt_tick";
  const helpers = loadBackgroundHelpers({
    settings: qwenSettings("realtime", { summaryIntervalMinutes: 5 }),
    fetchImpl: topicAiFetch(requests),
    sentMessages,
    stored: {
      ytd_active_capture: {
        ...capturePointer(sessionId),
        kind: "live",
        timestampKind: "wallclock",
        transcribeMode: "realtime",
      },
      [`ytd_session_${sessionId}`]: JSON.parse(
        JSON.stringify(sessionPipeline.createSession({ sessionId })),
      ),
    },
  });
  await helpers.handleGetSessionState();

  // Ten 30-second utterances: 5 minutes of coverage plus the 10-record
  // debounce — the same content thresholds as segment mode, fed by records
  // that never came from a Segment.
  for (let i = 0; i < 10; i += 1) {
    await helpers.handleRealtimeUtterance({
      action: "realtimeUtterance",
      text: `第 ${i + 1} 句`,
      start: i * 30,
      duration: 30,
    });
  }

  assert.equal(requests.length, 1, "the tick fired on the content thresholds");
  assert.equal(helpers.readStored(`ytd_session_${sessionId}`).topics.length, 1);
  const update = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.state?.topics?.length,
  );
  assert.ok(update, "the tick broadcast reaches the panel");
});

test("trailing realtime events after the Session ended are dropped", async () => {
  const sentMessages = [];
  const {
    handleStartLearning,
    handleEndLearning,
    handleRealtimePartial,
    handleRealtimeUtterance,
    handleRealtimeError,
    readStored,
  } = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    sentMessages,
  });
  const started = await handleStartLearning({ url: LIVE_URL, tabId: 7 });
  const ended = await handleEndLearning();
  assert.equal(ended.success, true);
  const broadcastsBefore = sentMessages.filter(
    (message) => message.action === "sessionUpdate",
  ).length;

  await handleRealtimePartial({ action: "realtimePartial", text: "迟到的话" });
  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "迟到的整句。",
    start: 999,
    duration: 3,
  });
  await handleRealtimeError({ action: "realtimeError", message: "迟到的错误" });

  assert.equal(
    sentMessages.filter((message) => message.action === "sessionUpdate").length,
    broadcastsBefore,
    "no broadcast after the Session ended",
  );
  const snapshot = readStored(`ytd_session_${started.sessionId}`);
  assert.equal(
    snapshot.transcriptRecords.some((record) => record.text === "迟到的整句。"),
    false,
    "the trailing utterance never entered the Transcript",
  );
});

test("a realtime Session never dispatches Segments from the position stream", async () => {
  const timers = [];
  let now = 1_700_000_000_000;
  const helpers = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    setIntervalImpl: (cb, delayMs) => {
      timers.push({ cb, delayMs });
      return timers.length;
    },
    dateNow: () => now,
  });
  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.success, true);

  // Five minutes of wall-clock lesson time: the live tick feeds the
  // scheduler far past one Segment length. The realtime path has no
  // recorder (captureCut would fail), so nothing may be scheduled.
  now += 300_000;
  for (const timer of timers) {
    if (timer.delayMs === 1000) await timer.cb();
  }

  const state = await helpers.handleGetSessionState();
  assert.equal(state.transcribeMode, "realtime");
  assert.deepEqual(state.state.segments, [], "realtime has no Segments");
  assert.deepEqual(
    state.state.transcriptRecords.filter((record) => record.failed === true),
    [],
    "no [语音转录失败] markers from disabled Segment scheduling",
  );
});

test("realtime events with no active capture are dropped without broadcasting", async () => {
  const sentMessages = [];
  const { handleRealtimePartial, handleRealtimeUtterance, handleRealtimeError } =
    loadBackgroundHelpers({
      settings: qwenSettings("realtime"),
      sentMessages,
    });

  await handleRealtimePartial({ action: "realtimePartial", text: "孤儿事件" });
  await handleRealtimeUtterance({ action: "realtimeUtterance", text: "孤儿事件" });
  await handleRealtimeError({ action: "realtimeError", message: "孤儿事件" });

  assert.equal(
    sentMessages.filter(
      (message) => message.realtimePartial || message.realtimeUtterance || message.realtimeNotice,
    ).length,
    0,
    "no sessionUpdate is broadcast without an active capture",
  );
});

test("a resumed realtime Session keeps its transcribeMode from the capture pointer", async () => {
  const sentMessages = [];
  const { handleGetSessionState, readStored } = loadBackgroundHelpers({
    // Settings say segment; the Session's persisted start decision wins.
    settings: qwenSettings("segment"),
    // The offscreen document died with the browser: the restart path re-sends
    // captureStart, which must carry the persisted transcription mode too.
    offscreenDocument: false,
    sentMessages,
    stored: {
      ytd_active_capture: {
        sessionId: "s_rt",
        tabId: 7,
        platformId: "xiaoe-tech",
        kind: "live",
        timestampKind: "wallclock",
        startedAtMs: Date.now() - 300_000,
        segmentLengthSeconds: 120,
        transcribeMode: "realtime",
      },
      ytd_session_s_rt: JSON.parse(
        JSON.stringify(sessionPipeline.createSession({ sessionId: "s_rt" })),
      ),
    },
  });

  const state = await handleGetSessionState();

  assert.equal(state.active, true);
  assert.equal(state.transcribeMode, "realtime");
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "the restarted capture receives captureStart");
  assert.equal(start.transcribeMode, "realtime");
  assert.equal(start.mode, "wallclock");
  // The restart payload is the fresh start's payload, built by the same
  // builder: the Qwen key rides along for the WS handshake exactly like on
  // a fresh start (message-only, the pointer stays key-free).
  assert.equal(start.apiKey, "qwen-key");
  assert.equal(readStored("ytd_active_capture").apiKey, undefined);
});

// --- Realtime video-kind stamping (#49): utterances land at video positions
//
// A replay/course realtime Session keeps its video timeline: the offscreen
// stream time means nothing on a seekable video, so each finalized utterance
// stamps at the last bridged video position minus its duration. The bridged
// position travels the normal mediaPosition message.

test("a realtime utterance on a replay Session stamps at the bridged position minus its duration", async () => {
  const { handleStartLearning, handleMediaPosition, handleRealtimeUtterance, readStored } =
    loadBackgroundHelpers({
      // Pinned segment length: the bridge ticks below the seek threshold so
      // the position stream stays a plain playback feed (no seek handling).
      settings: qwenSettings("realtime", { settingsVersion: 3 }),
    });
  const started = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  assert.equal(started.transcribeMode, "realtime");

  // The bridge reports the video position every second; the utterance
  // finalized just after the 60s mark, so its start is that position minus
  // the utterance's own duration. Stream time (12.5) is discarded.
  await handleMediaPosition(mediaPositionMessage(0), { tab: { id: 7 } });
  await handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "对齐到视频位置的一句。",
    start: 12.5,
    duration: 5.5,
  });

  const snapshot = readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.transcriptRecords, [
    { text: "对齐到视频位置的一句。", start: 54.5, duration: 5.5 },
  ]);
});

test("a video-kind realtime utterance whose speech began before 0:00 clamps to 0", async () => {
  const { handleStartLearning, handleMediaPosition, handleRealtimeUtterance, readStored } =
    loadBackgroundHelpers({
      settings: qwenSettings("realtime", { settingsVersion: 3 }),
    });
  const started = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  await handleMediaPosition(mediaPositionMessage(3), { tab: { id: 7 } });
  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "开头的一句。",
    start: 1,
    duration: 5.5,
  });

  const snapshot = readStored(`ytd_session_${started.sessionId}`);
  assert.equal(snapshot.transcriptRecords[0].start, 0);
});

test("a realtime wallclock Session anchors via the probe and stamps at video positions", async () => {
  const { handleStartLearning, handleGetSessionState, handleMediaPosition, handleRealtimeUtterance, readStored } =
    loadBackgroundHelpers({
      settings: qwenSettings("realtime", { settingsVersion: 3 }),
    });
  const started = await handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.timestampKind, "wallclock");

  // The #48 probe still applies to realtime Sessions: the first bridged
  // position anchors the live Session to the video timeline, and utterances
  // finalize at video positions from then on.
  await handleMediaPosition(mediaPositionMessage(800), { tab: { id: 7 } });
  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "对齐后的一句。",
    start: 30,
    duration: 4,
  });

  assert.equal((await handleGetSessionState()).timestampKind, "video");
  const snapshot = readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.transcriptRecords, [
    { text: "对齐后的一句。", start: 800, duration: 4 },
  ]);
});

test("a seek during realtime replay marks the skipped range and keeps stamping at video positions", async () => {
  const { handleStartLearning, handleMediaPosition, handleRealtimeUtterance, readStored } =
    loadBackgroundHelpers({
      settings: qwenSettings("realtime", { settingsVersion: 3 }),
    });
  const started = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  // One minute played (stamped from the bridged positions), then the
  // learner drags the bar to 10:00. There is no recorder to cut a pre-seek
  // tail from, so the seek only marks the skipped range.
  await handleMediaPosition(mediaPositionMessage(0), { tab: { id: 7 } });
  await handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "跳转前的一句。",
    start: 5,
    duration: 4,
  });
  await handleMediaPosition(mediaPositionMessage(600), { tab: { id: 7 } });
  await handleMediaPosition(mediaPositionMessage(610), { tab: { id: 7 } });
  await handleRealtimeUtterance({
    action: "realtimeUtterance",
    text: "跳转后的一句。",
    start: 25,
    duration: 4,
  });

  const snapshot = readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.transcriptRecords, [
    { text: "跳转前的一句。", start: 56, duration: 4 },
    { text: "[已跳过 1:00–10:00]", start: 60, duration: 540, failed: true },
    { text: "跳转后的一句。", start: 606, duration: 4 },
  ]);
  assert.deepEqual(snapshot.segments, [], "realtime has no Segments");
  // The jumped cursor travels the pointer, so a worker restart resumes
  // past the skipped range.
  assert.equal(readStored("ytd_active_capture").cursorSeconds, 600);
});

test("media end auto-ends a realtime replay Session like any replay Session", async () => {
  const { handleStartLearning, handleGetSessionState, handleMediaPosition, readStored } =
    loadBackgroundHelpers({
      settings: qwenSettings("realtime", { settingsVersion: 3 }),
      fetchImpl: noNetworkFetch,
    });
  const started = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  assert.equal(started.transcribeMode, "realtime");

  await handleMediaPosition(mediaPositionMessage(600, { ended: true }), { tab: { id: 7 } });

  const state = await handleGetSessionState();
  assert.equal(state.active, false);
  assert.equal(readStored(`ytd_session_${started.sessionId}`).status, "ended");
  // The ended Session is no longer resumable: the capture pointer is gone.
  assert.equal(readStored("ytd_active_capture"), undefined);
});

test("a resumed realtime replay Session baselines seek detection at the last record's end", async () => {
  const helpers = loadBackgroundHelpers({
    settings: qwenSettings("realtime", { settingsVersion: 2 }),
    stored: {
      ytd_active_capture: {
        sessionId: "s_rt_resume",
        tabId: 7,
        platformId: "xiaoe-tech",
        kind: "replay",
        timestampKind: "video",
        startedAtMs: Date.now() - 600_000,
        segmentLengthSeconds: 120,
        transcribeMode: "realtime",
        cursorSeconds: 0,
      },
      ytd_session_s_rt_resume: {
        ...JSON.parse(
          JSON.stringify(sessionPipeline.createSession({ sessionId: "s_rt_resume" })),
        ),
        transcriptRecords: [{ text: "重启前的一句。", start: 96, duration: 4 }],
      },
    },
  });

  // The worker died mid-playback and the video meanwhile reached 10:00.
  // The first report must not read as a seek from 0 — the head was already
  // transcribed (records are video-stamped) — so the marker covers only the
  // genuinely untranscribed restart hole, from the last record's end.
  await helpers.handleMediaPosition(mediaPositionMessage(600), { tab: { id: 7 } });

  const snapshot = helpers.readStored("ytd_session_s_rt_resume");
  const markers = snapshot.transcriptRecords.filter(
    (record) => record.failed === true,
  );
  assert.deepEqual(
    markers.map((record) => ({
      text: record.text,
      start: record.start,
      duration: record.duration,
    })),
    [{ text: "[已跳过 1:40–10:00]", start: 100, duration: 500 }],
  );
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

function seededRealtimeCapture(sessionId) {
  let state = sessionPipeline.createSession({ sessionId });
  for (let i = 0; i < 4; i += 1) {
    state = sessionPipeline.applyEvent(state, {
      type: "utteranceCaptured",
      text: `第 ${i + 1} 句`,
      start: i * 30,
      duration: 30,
    });
  }
  return JSON.parse(JSON.stringify(state));
}

test("a realtimeGaveUp notice auto-ends the Session and broadcasts the reason", async () => {
  const requests = [];
  const sentMessages = [];
  const sessionId = "s_rt_gave_up";
  const helpers = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    fetchImpl: reportAiFetch(requests, REPORT_BODY),
    sentMessages,
    stored: {
      ytd_active_capture: {
        ...capturePointer(sessionId),
        kind: "live",
        timestampKind: "wallclock",
        transcribeMode: "realtime",
      },
      [`ytd_session_${sessionId}`]: seededRealtimeCapture(sessionId),
    },
  });
  await helpers.handleGetSessionState();

  await helpers.handleRealtimeGaveUp({ action: "realtimeGaveUp" });

  // Nothing stays resumable: the Session ended and the pointer is cleared.
  assert.equal(helpers.readStored(`ytd_session_${sessionId}`).status, "ended");
  assert.equal(helpers.readStored("ytd_active_capture"), undefined);
  // The panel learns the reason immediately, then sees the ended state with
  // the digest built from the transcript collected so far.
  const notice = sentMessages.find((message) => message.realtimeNotice);
  assert.ok(notice, "the notice broadcast reaches the panel");
  assert.equal(notice.realtimeNotice.message, "实时转写连接失败，会话自动结束。");
  const ended = sentMessages.find(
    (message) =>
      message.action === "sessionUpdate" && message.state?.status === "ended",
  );
  assert.ok(ended, "the end broadcast reaches the panel");
  assert.deepEqual(ended.report, REPORT_BODY);
  assert.equal(requests.length, 1, "exactly one global pass over what exists");

  // Death is final: a repeated notice finds the ended context, a no-op.
  const updatesBefore = sentMessages.filter(
    (message) => message.action === "sessionUpdate",
  ).length;
  await helpers.handleRealtimeGaveUp({ action: "realtimeGaveUp" });
  assert.equal(
    sentMessages.filter((message) => message.action === "sessionUpdate").length,
    updatesBefore,
    "a second realtimeGaveUp is a no-op",
  );
});

test("a realtimeGaveUp notice with no active capture is a no-op", async () => {
  const sentMessages = [];
  const { handleRealtimeGaveUp } = loadBackgroundHelpers({
    settings: qwenSettings("realtime"),
    sentMessages,
  });

  await handleRealtimeGaveUp({ action: "realtimeGaveUp" });

  assert.equal(
    sentMessages.filter((message) => message.action === "sessionUpdate").length,
    0,
    "no broadcast without an active capture",
  );
});

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
    settings: baseSettings({
      speechProviders: { groq: { apiKey: "" } },
      segmentLengthSeconds: 120,
    }),
  });

  // The start gate reads settings (and persists the migrated blob) before
  // it fails on the missing credential — enough to assert the migration.
  await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  const blob = readStored("ytd_settings");
  assert.equal(blob.settingsVersion, 3);
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

// A transcription stub on the Speech Provider seam: the first `failFirst`
// calls reject so a first-pass Segment can be forced failed while later
// ones succeed. Records are provider-relative (start 0), like the real
// providers; the capture layer stamps them onto the Segment's range.
function asrTranscribe({ failFirst = 0, text = "转写内容", durations = [] } = {}) {
  let attempts = 0;
  return async (_segmentAudio, _credentials) => {
    attempts += 1;
    if (attempts <= failFirst) {
      throw new Error("provider boom");
    }
    const duration = durations.length > 0 ? durations.shift() : 120;
    return [{ text, start: 0, duration, language: "zh" }];
  };
}

// A catch-all fetch stub: nothing in these flows may reach the network.
const noNetworkFetch = async () => ({ ok: false, status: 599, text: async () => "" });

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

// The settings migration forces a stored 120 (the legacy default) back
// to 30 unless the blob is stamped with the current version, so these tests
// pin the version to keep the round Segment numbers in their assertions.
function pinnedSettings(overrides = {}) {
  return { ...baseSettings(overrides), settingsVersion: 3 };
}

test("a wallclock l_ Session anchors to the video timeline on the first bridged position", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: pinnedSettings(),
    fetchImpl: noNetworkFetch,
    sendMessageImpl: cutReply(),
    transcribeImpl: asrTranscribe(),
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
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.timestampKind, "video");
  assert.equal(pointer.cursorSeconds, 800);

  // The skipped head (0 → 800) produces nothing: the first Segment starts
  // at the anchor position with the post-anchor audio.
  await helpers.handleMediaPosition(mediaPositionMessage(920.4), { tab: { id: 7 } });
  await drain();
  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [{ start: 800, duration: 120 }],
  );
  assert.equal(snapshot.transcriptRecords[0].start, 800);
  // The anchor broadcast tells the panel the timeline flipped immediately.
  const update = sentMessages.find(
    (message) => message.action === "sessionUpdate" && message.timestampKind,
  );
  assert.equal(update.timestampKind, "video");
});

test("a wallclock Session with no bridged position in the probe window stays wallclock", async () => {
  let now = 1_700_000_000_000;
  const helpers = loadBackgroundHelpers({
    settings: pinnedSettings(),
    fetchImpl: noNetworkFetch,
    sendMessageImpl: cutReply(),
    transcribeImpl: asrTranscribe(),
    dateNow: () => now,
  });

  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.timestampKind, "wallclock");

  // The window lapses before any position arrives; the later report is
  // ignored and the Session keeps today's wallclock behavior.
  now += 11_000;
  await helpers.handleMediaPosition(mediaPositionMessage(800), { tab: { id: 7 } });
  await drain();

  assert.equal((await helpers.handleGetSessionState()).timestampKind, "wallclock");
  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.segments, []);
  assert.deepEqual(snapshot.transcriptRecords, []);

  // The timeline never switches mid-Session: later positions change nothing.
  now += 1_000;
  await helpers.handleMediaPosition(mediaPositionMessage(900), { tab: { id: 7 } });
  await drain();
  assert.equal((await helpers.handleGetSessionState()).timestampKind, "wallclock");
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(snapshot.segments, []);
});

test("seek-forward cuts the pre-seek tail, jumps the cursor and marks the skipped gap", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: pinnedSettings(),
    fetchImpl: noNetworkFetch,
    sendMessageImpl: cutReply(),
    // The tail cut holds 60s of pre-seek audio; the post-seek Segment 120s.
    transcribeImpl: asrTranscribe({ durations: [60] }),
    sentMessages,
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  // One minute played, then the learner drags the bar to 10:00.
  await helpers.handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(600), { tab: { id: 7 } });
  await drain();

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
  await helpers.handleMediaPosition(mediaPositionMessage(720), { tab: { id: 7 } });
  await drain();
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 0, duration: 60 },
      { start: 600, duration: 120 },
    ],
  );
});

test("re-listening a failed Segment retries it once and replaces the marker with no duplicates", async () => {
  const helpers = loadBackgroundHelpers({
    settings: pinnedSettings(),
    // First pass: seg-0 fails, seg-1 transcribes; the re-listen retry of
    // seg-0 then succeeds.
    fetchImpl: noNetworkFetch,
    sendMessageImpl: cutReply(),
    transcribeImpl: asrTranscribe({ failFirst: 1 }),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  // First pass: two Segments, the first failed with its visible marker. The
  // bridge ticks once a second, so the feeds stay within the seek threshold.
  await helpers.handleMediaPosition(mediaPositionMessage(0), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(130), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(250), { tab: { id: 7 } });
  await drain();
  let snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => segment.status),
    ["failed", "done"],
  );
  const marker = snapshot.transcriptRecords.find((record) => record.failed === true);
  assert.equal(marker.text, "[语音转录失败]");

  // Seek back to 0:00 and re-listen through the failed range.
  await helpers.handleMediaPosition(mediaPositionMessage(0), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(60), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(130), { tab: { id: 7 } });
  await drain();

  // The retry landed under the failed Segment's own id: its marker is
  // replaced in place, the timeline stays single-copy and monotonic.
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => segment.status),
    ["done", "done"],
  );
  assert.deepEqual(
    snapshot.transcriptRecords.map((record) => ({
      text: record.text,
      start: record.start,
      failed: record.failed === true,
    })),
    [
      { text: "转写内容", start: 0, failed: false },
      { text: "转写内容", start: 120, failed: false },
    ],
  );

  // Plan A: covered ranges are never re-emitted, and new content resumes
  // once playback passes the old cursor frontier.
  await helpers.handleMediaPosition(mediaPositionMessage(240), { tab: { id: 7 } });
  await drain();
  await helpers.handleMediaPosition(mediaPositionMessage(360), { tab: { id: 7 } });
  await drain();
  snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.equal(snapshot.segments.length, 3);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [
      { start: 0, duration: 120 },
      { start: 120, duration: 120 },
      { start: 240, duration: 120 },
    ],
  );
  assert.equal(snapshot.transcriptRecords.length, 3);
  assert.equal(snapshot.transcriptRecords.filter((record) => record.failed).length, 0);
});

test("a worker restart keeps the anchored video timeline and its cursor", async () => {
  const sentMessages = [];
  const first = loadBackgroundHelpers({
    settings: pinnedSettings(),
    fetchImpl: noNetworkFetch,
    sendMessageImpl: cutReply(),
    transcribeImpl: asrTranscribe(),
    sentMessages,
  });
  const started = await first.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  await first.handleMediaPosition(mediaPositionMessage(800), { tab: { id: 7 } });
  await drain();

  // The worker restarts: the pointer (timestampKind video, cursor 800) and
  // the snapshot rebuild the context. No re-probe, no wallclock re-arm.
  const second = loadBackgroundHelpers({
    settings: pinnedSettings(),
    fetchImpl: noNetworkFetch,
    sendMessageImpl: cutReply(),
    transcribeImpl: asrTranscribe(),
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

  // Positions continue on the video timeline from the persisted cursor.
  await second.handleMediaPosition(mediaPositionMessage(920.4), { tab: { id: 7 } });
  await drain();
  const snapshot = second.readStored(`ytd_session_${started.sessionId}`);
  assert.deepEqual(
    snapshot.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
    })),
    [{ start: 800, duration: 120 }],
  );
});
