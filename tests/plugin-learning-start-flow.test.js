const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

// P10 (issue #59): the background wiring behind the panel's course tab list
// and 开始学习 flow. The pure layer (tests/learning-start.test.js) pins the
// contract logic; here the worker orchestration is what's pinned, in the
// plugin-collect-flow harness pattern:
// - the course tab list with video pages first and the locked target marked;
// - choose → resolve (contract §3.4) → 开始学习 → target locked for the
//   running Session (decision 4: nothing retargets it until it ends);
// - the position stream feeding the progress writer bound to the SAME
//   capture tabId, with the end-of-Session flush PUT (contract §3.5);
// - 409 conflict retry on current.revision, 401 → auth gate + stop recording
//   (the P7 linked-logout handoff), and the worker-restart rebuild.
//
// Response shapes follow contracts/fixtures/api-examples.json
// (api-resolve-matched-episode2, api-progress-first-write/update) and
// error-examples.json (error-progress-conflict, unauthorized).

const XIAOE_LESSON = "https://app12345.xiaoe-tech.com/v_5f0abc123";
const BILI_P2 = "https://www.bilibili.com/video/BV1ab411L78c?p=2";
const ARTICLE = "https://www.example.com/articles/building-a-learning-habit";

// api-resolve-matched-episode2 shape, for the xiaoe lesson the extractor
// identifies (platformScopeId app12345 — asserted below via the request).
const RESOLVED_SOURCE = {
  id: "src_01JABC0002",
  resourceId: "res_01JABC0001",
  kind: "video",
  url: XIAOE_LESSON,
  platformId: "xiaoe-tech",
  platformVideoId: "v_5f0abc123",
  episodeId: null,
  platformScopeId: "app12345",
  progress: { positionMs: 250000, revision: 2 },
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
const COLLECT_CREATED_BODY = {
  resource: RESOLVE_MATCHED_BODY.resource,
  source: { ...RESOLVED_SOURCE, progress: null },
};

const REPORT_BODY = {
  topics: [{ start: 0, end: 900, title: "导论", summary: "老师介绍了课程目标。" }],
  quotes: [{ start: 30, text: "学习是一场旅程。" }],
  todos: ["完成课后练习"],
};

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

const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

const cutReply = (message) =>
  message.action === "captureCut"
    ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
    : { success: true };

const asrTranscribe = async () => [{ text: "转写内容", start: 0, duration: 120, language: "zh" }];

/**
 * One fetch seam for the whole flow: /v1/... calls are scripted per path
 * (resolve / progress / resources), everything else is the AI report pass.
 * Every /v1 call is recorded with its parsed body for the assertions.
 */
function v1Fetch({ resolve = [], collect = null, progress = [] } = {}) {
  const v1Calls = [];
  let resolveIndex = 0;
  let progressIndex = 0;
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
    const path = String(url).replace(/^https:\/\/api\.example\.com/, "");
    if (path === "/v1/sources/resolve") {
      v1Calls.push({ path, method: init.method, body: JSON.parse(init.body) });
      return answer(resolve[resolveIndex++] ?? resolve[resolve.length - 1], { matched: false });
    }
    if (/^\/v1\/sources\/[^/]+\/progress$/.test(path)) {
      v1Calls.push({ path, method: init.method, body: JSON.parse(init.body) });
      const scripted = progress[progressIndex++] ?? progress[progress.length - 1];
      return answer(scripted, { positionMs: 0, revision: 1 });
    }
    if (path === "/v1/resources") {
      v1Calls.push({ path, method: init.method, body: JSON.parse(init.body) });
      return answer(collect, COLLECT_CREATED_BODY);
    }
    // The end-of-Session AI pass (and anything else non-/v1).
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(REPORT_BODY) }, finish_reason: "stop" }],
      }),
    };
  };
  return { v1Calls, fetchImpl };
}

/** Polls a getter until the predicate holds (the wiring runs fire-and-forget). */
async function until(getter, predicate, turns = 200) {
  for (let i = 0; i < turns; i++) {
    const value = await getter();
    if (predicate(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}

// --- getCourseTabs -------------------------------------------------------------

test("getCourseTabs lists open http(s) tabs with video pages first, background tabs included", async () => {
  const { handleGetCourseTabs } = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsQuery: async () => [
      { id: 3, url: ARTICLE, title: "一篇文章" },
      { id: 9, url: "chrome://extensions/", title: "扩展管理" },
      { id: 2, url: BILI_P2, title: "视频课 P2" },
      { id: 7, url: XIAOE_LESSON, title: "小鹅通课程" },
    ],
  });
  const result = await handleGetCourseTabs();
  assert.equal(result.ok, true);
  // Stable sort: the video tier keeps the query order (bili before xiaoe).
  assert.deepEqual(result.tabs.map((entry) => entry.tabId), [2, 7, 3]);
  assert.deepEqual(result.tabs.map((entry) => entry.video), [true, true, false]);
  assert.equal(result.locked, false);
  assert.equal(result.target, null);
  for (const entry of result.tabs) {
    assert.equal(entry.locked, false, "nothing is locked before a Session starts");
  }
});

// --- chooseLearningTarget ------------------------------------------------------

test("chooseLearningTarget resolves a matched source with the shared identity and reports the resume position", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({ resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }] });
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: XIAOE_LESSON, title: "小鹅通课程" }),
    fetchImpl,
  });

  const result = await helpers.handleChooseLearningTarget({ tabId: 7 });

  assert.equal(result.ok, true);
  assert.equal(result.startable, true, "a registered Source Platform page can start a Session");
  assert.equal(result.resolve.matched, true);
  assert.equal(result.resolve.source.id, "src_01JABC0002");
  assert.equal(result.resolve.source.progress.positionMs, 250000);

  assert.equal(v1Calls.length, 1);
  assert.equal(v1Calls[0].path, "/v1/sources/resolve");
  assert.equal(v1Calls[0].method, "POST");
  // The identity comes from the shared extractor (contracts/platform-video-id.js):
  // the xiaoe shop subdomain rides along as platformScopeId.
  assert.deepEqual(v1Calls[0].body.identity, {
    platformId: "xiaoe-tech",
    platformVideoId: "v_5f0abc123",
    episodeId: null,
    platformScopeId: "app12345",
  });
  assert.equal(helpers.readStored("ytd_learning_target").status, "chosen");
});

test("chooseLearningTarget marks a bilibili video page startable (P10b #63 registered the station)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({ resolve: [{ status: 200, body: { matched: false } }] });
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: BILI_P2, title: "视频课 P2" }),
    fetchImpl,
  });

  const result = await helpers.handleChooseLearningTarget({ tabId: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.startable, true, "bilibili /video/<BV> is a registered Source Platform page");
  assert.equal(result.resolve.matched, false, "unfavorited video page: the panel prompts 先收藏");
  assert.deepEqual(v1Calls[0].body.identity, {
    platformId: "bilibili",
    platformVideoId: "BV1ab411L78c",
    episodeId: "2",
    platformScopeId: null,
  });
});

test("chooseLearningTarget marks youtube and xiaohongshu video pages startable (P10b #63)", async () => {
  for (const [url, platformId] of [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://www.xiaohongshu.com/explore/65f0abc123def4567890ab12", "xiaohongshu"],
  ]) {
    const { fetchImpl } = v1Fetch({ resolve: [{ status: 200, body: { matched: false } }] });
    const helpers = loadBackgroundHelpers({
      settings: baseSettings(),
      stored: CREDENTIAL_STORE,
      tabsGet: async (tabId) => ({ id: tabId, url, title: platformId }),
      fetchImpl,
    });

    const result = await helpers.handleChooseLearningTarget({ tabId: 5 });

    assert.equal(result.ok, true, url);
    assert.equal(result.startable, true, url);
  }
});

test("startLearning proceeds on all three stations with video timestamps (P10b #63)", async () => {
  for (const [url, platformId] of [
    [BILI_P2, "bilibili"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://www.xiaohongshu.com/explore/65f0abc123def4567890ab12", "xiaohongshu"],
  ]) {
    const helpers = loadBackgroundHelpers({
      settings: baseSettings(),
      stored: CREDENTIAL_STORE,
      fetchImpl: v1Fetch().fetchImpl,
      transcribeImpl: asrTranscribe,
      sendMessageImpl: cutReply,
    });

    const result = await helpers.handleStartLearning({ url, tabId: 5 });

    assert.equal(result.success, true, url);
    const pointer = helpers.readStored("ytd_active_capture");
    assert.equal(pointer.platformId, platformId, url);
    assert.equal(pointer.kind, "video", url);
    assert.equal(pointer.timestampKind, "video", url);
    await helpers.handleEndLearning();
  }
});

test("a video-kind Session auto-ends when the bridge reports media end (like replay/course)", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    fetchImpl: v1Fetch().fetchImpl,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);

  await helpers.handleMediaPosition({ position: 600, ended: true }, { tab: { id: 2 } });

  assert.equal(helpers.readStored("ytd_active_capture"), undefined, "the Session ended");
});

test("a video-kind Session does NOT auto-end on ordinary position reports", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    fetchImpl: v1Fetch().fetchImpl,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true);

  await helpers.handleMediaPosition({ position: 60, ended: false }, { tab: { id: 2 } });

  assert.notEqual(helpers.readStored("ytd_active_capture"), undefined, "still recording");
  await helpers.handleEndLearning();
});

test("chooseLearningTarget while a Session records is refused (decision 4: 记录目标锁定)", async () => {
  const { fetchImpl } = v1Fetch({ resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }] });
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    fetchImpl,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });
  await helpers.handleStartLearning({ url: XIAOE_LESSON, tabId: 7 });

  const result = await helpers.handleChooseLearningTarget({ tabId: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "locked");
  assert.equal(result.target.target.tabId, 7, "the recorded target stays the Session's tab");
});

// --- startLearningForTarget + end flush -----------------------------------------

test("startLearningForTarget locks the resolved source, and the end flush writes the latest position with the resolved revision", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    progress: [{ status: 200, body: { positionMs: 300000, revision: 3 } }],
  });
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsQuery: async () => [{ id: 7, url: XIAOE_LESSON, title: "小鹅通课程" }],
    tabsGet: async (tabId) => ({ id: tabId, url: XIAOE_LESSON, title: "小鹅通课程" }),
    fetchImpl,
    sentMessages,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });

  const chosen = await helpers.handleChooseLearningTarget({ tabId: 7 });
  assert.equal(chosen.ok, true);
  const started = await helpers.handleStartLearningForTarget({ tabId: 7 });
  assert.equal(started.success, true, chosen.error || "");

  const snapshot = helpers.readStored("ytd_learning_target");
  assert.equal(snapshot.status, "locked");
  assert.equal(snapshot.target.tabId, 7);
  assert.equal(snapshot.sourceId, "src_01JABC0002");
  assert.equal(snapshot.sessionId, started.sessionId);
  assert.equal(snapshot.expectedRevision, 2, "the resolve's revision seeds expectedRevision");
  assert.ok(
    sentMessages.some(
      (message) =>
        message.action === "learningTargetChanged" && message.target?.target?.tabId === 7,
    ),
    "the panel learns the target is locked",
  );

  const tabs = await helpers.handleGetCourseTabs();
  assert.equal(tabs.locked, true);
  const targetRow = tabs.tabs.find((entry) => entry.tabId === 7);
  assert.equal(targetRow.isTarget, true);
  assert.equal(targetRow.locked, false);

  // The position stream (the bridge, bound to the SAME capture tabId) feeds
  // the writer. The first position is a key event: the anchor write goes out
  // immediately with the resolve's expectedRevision.
  await helpers.handleMediaPosition({ position: 300 }, { tab: { id: 7 } });
  await new Promise((resolve) => setImmediate(resolve)); // the anchor cycle settles
  let progressCalls = v1Calls.filter((call) => call.path.includes("/progress"));
  assert.equal(progressCalls.length, 1, "the anchor position is a key event: written immediately");
  assert.deepEqual(progressCalls[0].body, { positionMs: 300000, expectedRevision: 2 });

  // A forward position coalesces on the throttle schedule (the stubbed worker
  // timers never fire here) — the end flush must carry it.
  await helpers.handleMediaPosition({ position: 400 }, { tab: { id: 7 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    v1Calls.filter((call) => call.path.includes("/progress")).length,
    1,
    "no write before the throttle elapses or the Session ends",
  );

  const ended = await helpers.handleEndLearning();
  assert.equal(ended.success, true);

  progressCalls = v1Calls.filter((call) => call.path.includes("/progress"));
  assert.equal(progressCalls.length, 2);
  assert.equal(progressCalls[1].path, "/v1/sources/src_01JABC0002/progress");
  assert.equal(progressCalls[1].method, "PUT");
  assert.deepEqual(progressCalls[1].body, { positionMs: 400000, expectedRevision: 3 });

  assert.equal(helpers.readStored("ytd_learning_target"), undefined, "结束本次学习后列表恢复可选");
  const tabsAfter = await helpers.handleGetCourseTabs();
  assert.equal(tabsAfter.locked, false);
  for (const entry of tabsAfter.tabs) assert.equal(entry.locked, false);
});

test("end flush hitting 409 adopts current.revision and still writes the latest position", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    progress: [
      { status: 409, body: { error: { code: "progress_revision_conflict" }, current: { positionMs: 250000, revision: 5 } } },
      { status: 200, body: { positionMs: 300000, revision: 6 } },
    ],
  });
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: XIAOE_LESSON, title: "小鹅通课程" }),
    fetchImpl,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });
  await helpers.handleChooseLearningTarget({ tabId: 7 });
  const started = await helpers.handleStartLearningForTarget({ tabId: 7 });
  assert.equal(started.success, true);
  await helpers.handleMediaPosition({ position: 300 }, { tab: { id: 7 } });

  await helpers.handleEndLearning();

  const progressCalls = v1Calls.filter((call) => call.path.includes("/progress"));
  assert.equal(progressCalls.length, 2);
  assert.deepEqual(progressCalls[0].body, { positionMs: 300000, expectedRevision: 2 }, "stale expectedRevision from the resolve");
  assert.deepEqual(progressCalls[1].body, { positionMs: 300000, expectedRevision: 5 }, "the retry carries current.revision and OUR latest position");
  assert.equal(helpers.readStored("ytd_learning_target"), undefined);
});

// --- favorite-first flow ---------------------------------------------------------

test("an unmatched chosen target: start asks to favorite first, one-click collect, then start proceeds", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [
      { status: 200, body: { matched: false } },
      { status: 200, body: { matched: false } },
      { status: 200, body: RESOLVE_MATCHED_BODY },
    ],
    collect: { status: 201, body: COLLECT_CREATED_BODY },
  });
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: XIAOE_LESSON, title: "小鹅通课程" }),
    fetchImpl,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });

  await helpers.handleChooseLearningTarget({ tabId: 7 });

  const refused = await helpers.handleStartLearningForTarget({ tabId: 7 });
  assert.equal(refused.success, false);
  assert.equal(refused.needsFavorite, true, "未收藏的视频页开始学习时提示先收藏");
  const state = await helpers.handleGetSessionState();
  assert.equal(state.active, false, "no capture started without a resolved source");

  const collected = await helpers.handleCollectLearningTarget({ tabId: 7 });
  assert.equal(collected.ok, true);
  assert.equal(collected.outcome, "created");
  const collectCalls = v1Calls.filter((call) => call.path === "/v1/resources");
  assert.equal(collectCalls.length, 1);
  assert.equal(collectCalls[0].method, "POST");
  assert.equal(collectCalls[0].body.url, XIAOE_LESSON);

  const started = await helpers.handleStartLearningForTarget({ tabId: 7 });
  assert.equal(started.success, true);
  assert.equal(helpers.readStored("ytd_learning_target").sourceId, "src_01JABC0002");
});

// --- 401 mid-recording ------------------------------------------------------------

test("a 401 on the mid-recording immediate write stops recording and routes the panel back to the authorization guide", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }],
    progress: [{ status: 401, body: { error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" } } }],
  });
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    fetchImpl,
    sentMessages,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });
  const started = await helpers.handleStartLearning({ url: XIAOE_LESSON, tabId: 7 });
  assert.equal(started.success, true);
  await until(
    () => helpers.readStored("ytd_learning_target"),
    (snapshot) => snapshot && snapshot.status === "locked",
  );

  // The first position is a key event: the immediate write hits the 401.
  await helpers.handleMediaPosition({ position: 300 }, { tab: { id: 7 } });

  const ended = await until(
    () => helpers.handleGetSessionState(),
    (state) => state.active === false,
    );
  assert.ok(ended, "the Session stopped recording on the auth loss");
  assert.ok(
    sentMessages.some(
      (message) => message.action === "authState" && message.authorized === false,
    ),
    "the panel is routed back through the authorization gate",
  );
  assert.equal(helpers.readStored("ytd_learning_target"), undefined, "the target is released");

  const progressCalls = v1Calls.filter((call) => call.path.includes("/progress"));
  const progressCountBefore = progressCalls.length;
  await helpers.handleMediaPosition({ position: 100 }, { tab: { id: 7 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    v1Calls.filter((call) => call.path.includes("/progress")).length,
    progressCountBefore,
    "a stopped writer never touches the API again",
  );
});

// --- worker restart ----------------------------------------------------------------

test("a worker restart rebuilds the progress writer from the persisted target (revision survives)", async () => {
  const first = v1Fetch({ resolve: [{ status: 200, body: RESOLVE_MATCHED_BODY }] });
  const helpers1 = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({ id: tabId, url: XIAOE_LESSON, title: "小鹅通课程" }),
    fetchImpl: first.fetchImpl,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });
  await helpers1.handleChooseLearningTarget({ tabId: 7 });
  const started = await helpers1.handleStartLearningForTarget({ tabId: 7 });
  assert.equal(started.success, true);
  await helpers1.handleMediaPosition({ position: 300 }, { tab: { id: 7 } });

  const second = v1Fetch({ progress: [{ status: 200, body: { positionMs: 100000, revision: 3 } }] });
  const helpers2 = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ...CREDENTIAL_STORE,
      ytd_learning_target: helpers1.readStored("ytd_learning_target"),
      ytd_active_capture: helpers1.readStored("ytd_active_capture"),
      [`ytd_session_${started.sessionId}`]: helpers1.readStored(`ytd_session_${started.sessionId}`),
    },
    fetchImpl: second.fetchImpl,
    transcribeImpl: asrTranscribe,
    sendMessageImpl: cutReply,
  });

  const resumed = await helpers2.handleGetSessionState();
  assert.equal(resumed.active, true, "the capture context rebuilds from the pointer");

  // The rebuilt writer takes the FIRST reported position as its anchor write,
  // carrying the persisted expectedRevision (2) — the revision survived the
  // restart, so no conflict is manufactured.
  await helpers2.handleMediaPosition({ position: 100 }, { tab: { id: 7 } });
  const progressCalls = await until(
    () => second.v1Calls.filter((call) => call.path.includes("/progress")),
    (calls) => calls.length >= 1,
  );
  assert.ok(progressCalls, "the rebuilt writer wrote the anchor position");
  assert.equal(progressCalls[0].path, "/v1/sources/src_01JABC0002/progress");
  assert.deepEqual(progressCalls[0].body, { positionMs: 100000, expectedRevision: 2 });
});
