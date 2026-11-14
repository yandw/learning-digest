const test = require("node:test");
const assert = require("node:assert/strict");

// P10 (issue #59): the pure learning-start layer behind the panel's course
// tab list and 开始学习 flow. Three seams:
//
// 1. buildCourseTabList — the panel-side course tab list: every open http(s)
//    tab (background tabs included), pages with a confirmable video identity
//    first, the locked target pinned while a Session records.
// 2. The learning-target state machine — decision 4 of #49: 学习进行中列表
//   锁定（焦点/标签页切换不改变记录目标），结束本次学习后恢复可选.
// 3. The progress write client — contract-v1.md §3.5 PUT /v1/sources/{id}/
//    progress with expectedRevision optimistic concurrency (decision D4):
//    throttle policy, 409 conflict retry on current.revision, 401 stop, and
//    network backoff that never loses the latest position. The expected
//    wire shapes come from contracts/fixtures (api-progress-first-write,
//    api-progress-update, error-progress-conflict, error-cross-account-
//    progress), not from the code.

const YTD_LEARNING_START = require("../learning-start.js");

// --- buildCourseTabList -------------------------------------------------------

const BILI_P2 = "https://www.bilibili.com/video/BV1ab411L78c?p=2";
const XIAOE_LESSON = "https://abc.xiaoe-tech.com/v_5f0abc123";
const ARTICLE = "https://www.example.com/articles/building-a-learning-habit";

function alwaysVideo(url) {
  // The worker injects the real checker (identity extractor + Source
  // Platform registry); tests pin the list shape with a stand-in.
  return url.includes("bilibili.com/video/") || url.includes("xiaoe-tech.com");
}

test("buildCourseTabList lists open http(s) tabs with video pages first, background tabs included", () => {
  const list = YTD_LEARNING_START.buildCourseTabList({
    tabs: [
      { id: 1, url: ARTICLE, title: "一篇文章" },
      { id: 2, url: XIAOE_LESSON, title: "小鹅通课程" },
      { id: 3, url: BILI_P2, title: "视频课 P2" },
      { id: 4, url: "chrome://extensions/", title: "扩展管理" },
    ],
    lockedTabId: null,
    isVideoPage: alwaysVideo,
  });
  assert.deepEqual(
    list.map((entry) => entry.tabId),
    [2, 3, 1],
    "video tier first, stable order preserved within tiers, non-http(s) dropped",
  );
  assert.deepEqual(
    list.map((entry) => entry.video),
    [true, true, false],
  );
  assert.equal(list[2].title, "一篇文章");
  assert.equal(list[2].url, ARTICLE);
});

test("buildCourseTabList drops tabs without an id or a usable address", () => {
  const list = YTD_LEARNING_START.buildCourseTabList({
    tabs: [
      { url: ARTICLE, title: "no id" },
      { id: null, url: BILI_P2, title: "no id either" },
      { id: 5, url: "not a url at all", title: "garbage" },
      { id: 6, url: XIAOE_LESSON, title: "keep me" },
    ],
    lockedTabId: null,
    isVideoPage: alwaysVideo,
  });
  assert.deepEqual(list.map((entry) => entry.tabId), [6]);
});

test("buildCourseTabList marks the locked target and disables every other row while a Session records", () => {
  const list = YTD_LEARNING_START.buildCourseTabList({
    tabs: [
      { id: 1, url: XIAOE_LESSON, title: "课程 A" },
      { id: 2, url: BILI_P2, title: "课程 B" },
    ],
    lockedTabId: 1,
    isVideoPage: alwaysVideo,
  });
  const target = list.find((entry) => entry.tabId === 1);
  const other = list.find((entry) => entry.tabId === 2);
  assert.equal(target.isTarget, true, "the recorded target stays visible");
  assert.equal(target.locked, false);
  assert.equal(other.locked, true, "other rows are locked out during recording");
  assert.equal(other.isTarget, false);
});

// --- learning-target state machine -------------------------------------------

const TARGET_A = { tabId: 1, url: XIAOE_LESSON, title: "课程 A" };
const TARGET_B = { tabId: 2, url: BILI_P2, title: "课程 B" };

test("target lifecycle: choose, lock, end restores the list to selectable", () => {
  let state = YTD_LEARNING_START.createTargetState();
  assert.equal(YTD_LEARNING_START.isLocked(state), false);

  const chosen = YTD_LEARNING_START.chooseTarget(state, TARGET_A);
  assert.equal(chosen.ok, true);
  state = chosen.state;

  const locked = YTD_LEARNING_START.lockTarget(state, {
    ...TARGET_A,
    sessionId: "s_1",
    sourceId: "src_1",
    expectedRevision: 0,
  });
  assert.equal(locked.ok, true);
  state = locked.state;
  assert.equal(YTD_LEARNING_START.isLocked(state), true);
  assert.equal(YTD_LEARNING_START.targetInfo(state).sourceId, "src_1");
  assert.equal(YTD_LEARNING_START.targetInfo(state).sessionId, "s_1");

  const ended = YTD_LEARNING_START.endTarget(state);
  assert.equal(YTD_LEARNING_START.isLocked(ended), false, "列表恢复可选");
  assert.equal(YTD_LEARNING_START.targetInfo(ended), null);
});

test("a locked target ignores attempts to switch it (decision 4: 焦点切换不改变记录目标)", () => {
  let state = YTD_LEARNING_START.lockTarget(YTD_LEARNING_START.createTargetState(), {
    ...TARGET_A,
    sessionId: "s_1",
    sourceId: "src_1",
  }).state;

  const switched = YTD_LEARNING_START.chooseTarget(state, TARGET_B);
  assert.equal(switched.ok, false, "choosing another tab while recording is refused");
  assert.equal(YTD_LEARNING_START.targetInfo(state).target.tabId, 1);
  const relocked = YTD_LEARNING_START.lockTarget(state, { ...TARGET_B, sessionId: "s_2" });
  assert.equal(relocked.ok, false, "a second lock while recording is refused");
  assert.equal(YTD_LEARNING_START.targetInfo(state).target.tabId, 1);
});

test("lockTarget from a chosen target requires the same tab; the icon-click path locks straight from idle", () => {
  const state = YTD_LEARNING_START.chooseTarget(YTD_LEARNING_START.createTargetState(), TARGET_A).state;
  const mismatch = YTD_LEARNING_START.lockTarget(state, {
    ...TARGET_B,
    sessionId: "s_1",
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "targetMismatch");

  const fromIdle = YTD_LEARNING_START.lockTarget(YTD_LEARNING_START.createTargetState(), {
    ...TARGET_A,
    sessionId: "s_1",
  });
  assert.equal(fromIdle.ok, true, "toolbar-icon starts have no prior choice step");
  assert.equal(fromIdle.state.target.tabId, 1);
});

test("target snapshots round-trip through storage and garbage parses to null", () => {
  const locked = YTD_LEARNING_START.lockTarget(YTD_LEARNING_START.createTargetState(), {
    tabId: 7,
    url: XIAOE_LESSON,
    title: "课程",
    sessionId: "s_9",
    sourceId: "src_9",
    expectedRevision: 3,
  }).state;
  const snapshot = YTD_LEARNING_START.serializeTarget(locked);
  assert.equal(snapshot.status, "locked");
  const restored = YTD_LEARNING_START.parseTarget(snapshot);
  assert.deepEqual(YTD_LEARNING_START.targetInfo(restored), YTD_LEARNING_START.targetInfo(locked));

  const idle = YTD_LEARNING_START.createTargetState();
  assert.equal(YTD_LEARNING_START.serializeTarget(idle), null);
  for (const garbage of [null, undefined, "x", 42, {}, { status: "weird" }]) {
    assert.equal(YTD_LEARNING_START.parseTarget(garbage), null, String(JSON.stringify(garbage)));
  }
});

test("target fields are sanitized: a bad tabId or url never enters the state", () => {
  const bad = YTD_LEARNING_START.chooseTarget(YTD_LEARNING_START.createTargetState(), {
    tabId: "7",
    url: "chrome://extensions/",
    title: 12,
  });
  assert.equal(bad.ok, false);
  const good = YTD_LEARNING_START.chooseTarget(YTD_LEARNING_START.createTargetState(), {
    tabId: 7,
    url: XIAOE_LESSON,
    title: "  课程 A  ",
  });
  assert.equal(good.ok, true);
  assert.equal(good.state.target.title, "课程 A");
});

// --- progress write client -----------------------------------------------------
// Wire shapes copied from contracts/fixtures (the shared sample set).

const FIRST_WRITE_BODY = { positionMs: 125000, revision: 1 };
const UPDATE_BODY = { positionMs: 250000, revision: 2 };
const CONFLICT_BODY = {
  error: {
    code: "progress_revision_conflict",
    message: "进度已被其他端更新，请以 current 为准重试",
  },
  current: { positionMs: 250000, revision: 2 },
};
const UNAUTHORIZED_BODY = {
  error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" },
};
const NOT_FOUND_BODY = {
  error: { code: "not_found", message: "来源不存在或无权访问" },
};

function response(status, body) {
  return { status, json: async () => body };
}

/** A manual clock: controllable now(), inspectable timers. */
function makeClock() {
  let now = 1_000_000;
  let seq = 0;
  let timers = [];
  return {
    dateNow: () => now,
    setTimeoutImpl: (fn, delay) => {
      const id = ++seq;
      timers.push({ id, fn, at: now + (delay || 0) });
      return id;
    },
    clearTimeoutImpl: (id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    async advance(ms) {
      // Simulate real time: timers fire in order, each at its own fire time,
      // so a backoff sleep scheduled by a fired timer starts from THAT
      // moment (2s + 8s of backoff needs a 10s advance, not 18s). Fired
      // timers' continuations only run on a yielded turn — setImmediate
      // drains them before the next timer is picked.
      const target = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at);
        if (due.length === 0) break;
        const next = due[0];
        timers = timers.filter((timer) => timer.id !== next.id);
        now = Math.max(now, next.at);
        next.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
    },
    pendingTimers: () => timers.length,
  };
}

function recordingFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const entry = { url, init, body: JSON.parse(init.body) };
    calls.push(entry);
    const answer = script[calls.length - 1] || script[script.length - 1];
    if (typeof answer === "number") throw new Error(`network down (call ${calls.length})`);
    return answer(entry);
  };
  return { calls, fetchImpl };
}

function makeWriter(overrides = {}) {
  const clock = overrides.clock || makeClock();
  const base = {
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    expectedRevision: 0,
    throttleMs: 10_000,
    networkRetryDelaysMs: [2_000, 8_000, 30_000],
    maxConflictRetries: 3,
  };
  const writer = YTD_LEARNING_START.createProgressWriter({
    ...base,
    ...clock,
    ...overrides,
  });
  return { writer, clock };
}

test("parseProgressResponse maps the contract fixtures to verdicts", () => {
  assert.deepEqual(
    YTD_LEARNING_START.parseProgressResponse({ status: 200, data: FIRST_WRITE_BODY }),
    { kind: "ok", positionMs: 125000, revision: 1 },
  );
  assert.deepEqual(
    YTD_LEARNING_START.parseProgressResponse({ status: 409, data: CONFLICT_BODY }),
    { kind: "conflict", currentRevision: 2, currentPositionMs: 250000 },
  );
  assert.deepEqual(
    YTD_LEARNING_START.parseProgressResponse({ status: 409, data: { error: { code: "progress_revision_conflict" } } }),
    { kind: "conflict", currentRevision: null, currentPositionMs: null },
    "a conflict without current still counts as a conflict",
  );
  assert.deepEqual(
    YTD_LEARNING_START.parseProgressResponse({ status: 401, data: UNAUTHORIZED_BODY }),
    { kind: "unauthorized" },
  );
  assert.deepEqual(
    YTD_LEARNING_START.parseProgressResponse({ status: 404, data: NOT_FOUND_BODY }),
    { kind: "notFound" },
  );
  assert.equal(YTD_LEARNING_START.parseProgressResponse({ status: 503, data: null }).kind, "transient");
});

test("buildProgressRequest sends the §3.5 body and rejects garbage positions", () => {
  assert.deepEqual(YTD_LEARNING_START.buildProgressRequest(125_000.4, 0), {
    positionMs: 125000,
    expectedRevision: 0,
  });
  assert.deepEqual(YTD_LEARNING_START.buildProgressRequest(-5, 2), {
    positionMs: 0,
    expectedRevision: 2,
  });
  assert.equal(YTD_LEARNING_START.buildProgressRequest(Number.NaN, 0), null);
  assert.equal(YTD_LEARNING_START.buildProgressRequest(1000, -1), null);
});

test("the first reported position is a key event: written immediately with expectedRevision from resolve", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => response(200, FIRST_WRITE_BODY),
  ]);
  const { writer } = makeWriter({ fetchImpl });
  writer.reportPosition(125_000.6);
  await writer.flush();

  assert.equal(calls.length, 1, "the learning-start anchor write happens without waiting for the throttle");
  assert.equal(calls[0].url, "https://api.example.com/v1/sources/src_01JABC0002/progress");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.headers.Authorization, "Bearer ext-token");
  assert.deepEqual(calls[0].body, { positionMs: 125001, expectedRevision: 0 });
  assert.equal(writer.snapshot().expectedRevision, 1, "the response revision becomes the next expectedRevision");
  writer.stop();
});

test("later positions coalesce: one throttled PUT carrying the latest position", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => response(200, FIRST_WRITE_BODY),
    () => response(200, UPDATE_BODY),
  ]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000);
  await writer.flush(); // key-event anchor write
  writer.reportPosition(200_000);
  writer.reportPosition(250_000);
  assert.equal(calls.length, 1, "no second write before the throttle elapses");
  clock.advance(10_000);
  await writer.flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { positionMs: 250000, expectedRevision: 1 });
  writer.stop();
});

test("a backward drag (回拖合法, D4) is written immediately with the dragged-back position", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => response(200, FIRST_WRITE_BODY),
    () => response(200, { positionMs: 60_000, revision: 2 }),
  ]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000);
  await writer.flush();
  writer.reportPosition(60_000);
  await writer.flush();
  assert.equal(calls.length, 2, "backward drag does not wait for the throttle");
  assert.deepEqual(calls[1].body, { positionMs: 60000, expectedRevision: 1 });
  writer.stop();
});

test("a pause is a key event (P11 决策 4): the exact paused position writes immediately, the writer stays live", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => response(200, FIRST_WRITE_BODY),
    () => response(200, { positionMs: 180_000, revision: 2 }),
  ]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000);
  await writer.flush(); // anchor write
  writer.reportPosition(170_000);
  assert.equal(calls.length, 1, "no write before the pause");
  writer.reportPause(180_000);
  await tick();
  assert.equal(calls.length, 2, "the paused position does not wait for the throttle");
  assert.deepEqual(calls[1].body, { positionMs: 180000, expectedRevision: 1 });
  assert.equal(writer.snapshot().stopped, false, "pausing keeps the Session's writer alive");
  // Playback resumes into the same writer: the next position coalesces as usual.
  writer.reportPosition(190_000);
  assert.equal(calls.length, 2, "resume does not write ahead of the throttle schedule");
  clock.advance(10_000);
  await writer.flush();
  assert.equal(calls.length, 3, "the resumed position lands on the throttled schedule");
  assert.deepEqual(calls[2].body, { positionMs: 190000, expectedRevision: 2 });
  writer.stop();
});

test("reportPause as the first position still writes immediately, and a stopped writer ignores it", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => response(200, FIRST_WRITE_BODY),
  ]);
  const { writer } = makeWriter({ fetchImpl });
  writer.reportPause(30_000);
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { positionMs: 30000, expectedRevision: 0 });
  writer.stop();
  writer.reportPause(40_000);
  await tick();
  assert.equal(calls.length, 1, "nothing writes after stop");
});

test("409 conflict: the retry adopts current.revision and writes the LATEST position, not current.positionMs", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => response(200, FIRST_WRITE_BODY),
    () => response(409, CONFLICT_BODY),
    () => response(200, { positionMs: 400_000, revision: 3 }),
  ]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000);
  await writer.flush();
  writer.reportPosition(400_000);
  await writer.flush();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].body, { positionMs: 400000, expectedRevision: 1 }, "stale expectedRevision from the local copy");
  assert.deepEqual(calls[2].body, { positionMs: 400000, expectedRevision: 2 }, "retry carries current.revision and keeps our position");
  assert.equal(writer.snapshot().expectedRevision, 3);
  assert.equal(writer.snapshot().pendingPositionMs, null);
  writer.stop();
});

test("401 stops the writer, fires the auth hook, and nothing writes afterwards", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => response(401, UNAUTHORIZED_BODY),
  ]);
  let unauthorized = 0;
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    onUnauthorized: () => {
      unauthorized += 1;
    },
    ...clock,
  });
  writer.reportPosition(100_000);
  await writer.flush();
  assert.equal(unauthorized, 1);
  assert.equal(writer.snapshot().stopped, true);
  writer.reportPosition(120_000);
  await writer.flush();
  clock.advance(120_000);
  await writer.flush();
  assert.equal(calls.length, 1, "a stopped writer never touches the API again");
  writer.stop();
});

test("404 (other account's source) stops the writer permanently", async () => {
  const { calls, fetchImpl } = recordingFetch([() => response(404, NOT_FOUND_BODY)]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_other",
    ...clock,
  });
  writer.reportPosition(50_000);
  await writer.flush();
  assert.equal(writer.snapshot().stopped, true);
  writer.reportPosition(60_000);
  await writer.flush();
  assert.equal(calls.length, 1);
  writer.stop();
});

/** One turn of the event loop: lets the writer's queued cycle run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("network failure: the throttled retry resends the SAME revision+position (idempotent resend) and the position lands", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => {
      throw new Error("offline");
    },
    () => {
      throw new Error("offline");
    },
    () => {
      throw new Error("offline");
    },
    () => {
      throw new Error("offline");
    },
    () => response(200, FIRST_WRITE_BODY),
  ]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    // Zero-length backoff waits keep the throttled retry microtask-driven;
    // what is pinned here is the resend behavior, not the delay values.
    networkRetryDelaysMs: [0, 0],
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000);
  await writer.flush(); // the anchor + flush cycles each fail on the network and defer
  assert.equal(calls.length, 2, "throttle-bypassing cycles never wait on the network");
  assert.equal(writer.snapshot().pendingPositionMs, 125000, "the latest position is never dropped");
  assert.equal(writer.snapshot().stopped, false, "a network outage is not an auth loss");
  await clock.advance(10_000); // the throttle schedule retries with backoff
  await tick();
  assert.equal(calls.length, 5, "one attempt + two backoff retries on the throttled cycle");
  for (const call of calls) {
    assert.deepEqual(call.body, { positionMs: 125000, expectedRevision: 0 }, "every retry is the exact resend the API treats as idempotent");
  }
  assert.equal(writer.snapshot().pendingPositionMs, null);
  writer.stop();
});

test("exhausted network budget defers: the pending position survives and the next flush sends it", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => {
      throw new Error("offline");
    },
    () => {
      throw new Error("offline");
    },
    () => {
      throw new Error("offline");
    },
    () => {
      throw new Error("offline");
    },
    () => {
      throw new Error("offline");
    },
    () => response(200, FIRST_WRITE_BODY),
  ]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    networkRetryDelaysMs: [0, 0],
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000);
  await writer.flush(); // the anchor + flush cycles each fail and defer
  await clock.advance(10_000); // the throttled retry burns its whole budget
  await tick();
  assert.equal(calls.length, 5, "two bypass attempts + one attempt + two backoff retries, then defer");
  assert.equal(writer.snapshot().pendingPositionMs, 125000, "the latest position is never dropped");
  assert.equal(writer.snapshot().stopped, false, "a network outage is not an auth loss");
  await writer.flush(); // the deferred position is still the newest one
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[5].body, { positionMs: 125000, expectedRevision: 0 });
  assert.equal(writer.snapshot().pendingPositionMs, null);
  writer.stop();
});

test("conflicts that never settle defer too: the adopted revision is kept for the next attempt", async () => {
  const conflict = (revision) => () =>
    response(409, {
      error: { code: "progress_revision_conflict" },
      current: { positionMs: revision * 10, revision },
    });
  const { calls, fetchImpl } = recordingFetch([
    conflict(5),
    conflict(6),
    conflict(7),
    conflict(8), // the immediate cycle exhausts its conflict budget here
    conflict(8),
    conflict(8),
    conflict(8),
    conflict(8), // the flush cycle exhausts its budget too, still deferred
    () => response(200, { positionMs: 125000, revision: 9 }), // the next flush lands
  ]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    maxConflictRetries: 3,
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000);
  await writer.flush();
  assert.equal(calls.length, 8, "two cycles of initial attempt + 3 conflict retries");
  assert.equal(writer.snapshot().expectedRevision, 8, "the last current.revision is adopted even when deferring");
  assert.equal(writer.snapshot().pendingPositionMs, 125000);
  await writer.flush();
  assert.deepEqual(calls[8].body, { positionMs: 125000, expectedRevision: 8 });
  assert.equal(writer.snapshot().expectedRevision, 9);
  assert.equal(writer.snapshot().pendingPositionMs, null);
  writer.stop();
});

test("a newer position reported mid-flight coalesces into exactly one follow-up write", async () => {
  const { calls, fetchImpl } = recordingFetch([
    () => response(200, FIRST_WRITE_BODY),
    () => response(200, { positionMs: 300_000, revision: 2 }),
  ]);
  const clock = makeClock();
  let releaseFirst;
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000);
  const settled = writer.flush();
  await settled;
  assert.equal(calls.length, 1);
  writer.reportPosition(200_000);
  writer.reportPosition(300_000);
  clock.advance(10_000);
  await writer.flush();
  assert.equal(calls.length, 2, "the intermediate position is skipped, the latest is written once");
  assert.deepEqual(calls[1].body, { positionMs: 300000, expectedRevision: 1 });
  writer.stop();
});

test("stop() cancels the scheduled write and the writer goes quiet", async () => {
  const { calls, fetchImpl } = recordingFetch([() => response(200, FIRST_WRITE_BODY)]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    throttleMs: 10_000,
    ...clock,
  });
  writer.reportPosition(125_000); // key event: immediate cycle (idle fetch resolves fine)
  await writer.flush();
  writer.reportPosition(130_000); // schedules the debounce timer
  assert.equal(clock.pendingTimers(), 1, "a debounce timer is scheduled");
  writer.stop();
  assert.equal(clock.pendingTimers(), 0, "stop clears the timer");
  clock.advance(60_000);
  await writer.flush();
  assert.equal(calls.length, 1, "nothing writes after stop");
});

test("flush with nothing pending never calls the API", async () => {
  const { calls, fetchImpl } = recordingFetch([]);
  const clock = makeClock();
  const writer = YTD_LEARNING_START.createProgressWriter({
    fetchImpl,
    apiBaseUrl: "https://api.example.com",
    token: "ext-token",
    sourceId: "src_01JABC0002",
    ...clock,
  });
  await writer.flush();
  assert.equal(calls.length, 0);
  writer.stop();
});

// --- didLearningSourceSwitch (P11, #60: 同一标签页换视频/分集的收尾检测) ------
//
// The extractor is injected (the same seam buildCourseTabList uses for
// isVideoPage): the worker passes contracts/platform-video-id.js's
// extractVideoIdentity, tests pin behavior with the same shapes it returns
// ({ platformId, platformVideoId, episodeId, platformScopeId }).

const identityOf = (url) => require("../contracts/platform-video-id.js").extractVideoIdentity(url);

test("a bilibili episode switch (?p=1 → ?p=2) is a different source", () => {
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.bilibili.com/video/BV1ab411L78c?p=1",
      "https://www.bilibili.com/video/BV1ab411L78c?p=2",
      identityOf,
    ),
    true,
  );
});

test("bilibili player URL churn (?t= seek replaceState, absent-p vs p=1) stays the same source", () => {
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.bilibili.com/video/BV1ab411L78c?p=1",
      "https://www.bilibili.com/video/BV1ab411L78c?p=1&t=512",
      identityOf,
    ),
    false,
    "the ?t= replaceState must not end a Session",
  );
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.bilibili.com/video/BV1ab411L78c",
      "https://www.bilibili.com/video/BV1ab411L78c?p=1",
      identityOf,
    ),
    false,
    "absent p and p=1 are one Source (the extractor normalizes both to 1)",
  );
});

test("a different video, a different platform, and a different xiaoe shop are all switches", () => {
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.bilibili.com/video/BV1ab411L78c?p=1",
      "https://www.bilibili.com/video/BV9cd411M01e?p=1",
      identityOf,
    ),
    true,
  );
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.bilibili.com/video/BV1ab411L78c?p=1",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      identityOf,
    ),
    true,
  );
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://app12345.xiaoe-tech.com/v_5f0abc123",
      "https://app99999.xiaoe-tech.com/v_5f0abc123",
      identityOf,
    ),
    true,
    "the shop subdomain is part of the identity (D7)",
  );
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://app12345.xiaoe-tech.com/v_5f0abc123",
      "https://app12345.xiaoe-tech.com/v_9f9def456",
      identityOf,
    ),
    true,
  );
});

test("youtube and xiaohongshu player URL churn stays the same source", () => {
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s",
      identityOf,
    ),
    false,
  );
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.xiaohongshu.com/explore/65f0abc123def4567890ab12?xsec_token=abc",
      "https://www.xiaohongshu.com/explore/65f0abc123def4567890ab12",
      identityOf,
    ),
    false,
  );
});

test("no confirmable identity on either side means no confirmed switch", () => {
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.bilibili.com/video/BV1ab411L78c?p=1",
      "https://www.bilibili.com/",
      identityOf,
    ),
    false,
    "leaving to a non-video page is not a confirmed different video/episode",
  );
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://app12345.xiaoe-tech.com/term_5f0abc123",
      "https://app12345.xiaoe-tech.com/v_9f9def456",
      identityOf,
    ),
    false,
    "an identity-less session URL cannot confirm a switch",
  );
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.bilibili.com/video/BV1ab411L78c?p=1",
      "not a url",
      identityOf,
    ),
    false,
  );
  assert.equal(YTD_LEARNING_START.didLearningSourceSwitch(null, null, identityOf), false);
  assert.equal(
    YTD_LEARNING_START.didLearningSourceSwitch(
      "https://www.bilibili.com/video/BV1ab411L78c?p=1",
      "https://www.bilibili.com/video/BV9cd411M01e?p=1",
    ),
    false,
    "a missing extractor degrades to no-switch, never a false finish",
  );
});
