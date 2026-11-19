const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackgroundHelpers } = require("./helpers/load-background");

// P6: the background side of the authorization gate — the /v1/me probe,
// the authorization-page opener, the link code exchange, and the capture
// gate. The pure module (auth-gate.js) is covered by tests/auth-gate.test.js;
// here the worker wiring around it is what's pinned.

const REPLAY_URL = "https://app12345.xiaoe-tech.com/replay/l_abc123def456";

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aiModel: "qwen3.8-flash",
    speechProvider: "groq",
    speechProviders: { groq: { apiKey: "gsk-x" } },
    ...overrides,
  };
}

/**
 * The archive pipeline's fetch seam (ticket 2.4): resolve / create /
 * transcript / finish / progress answer per path; the AI pass answers with
 * an empty report body.
 */
function archiveFlowFetch() {
  return async (url, init) => {
    const p = String(url).replace(/^https:\/\/api\.example\.com/, "");
    if (p === "/v1/sources/resolve") {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          matched: true,
          resource: { id: "res_01JABC0001", title: "注意力机制详解", kind: "video", createdAt: "2026-11-10T08:00:00Z" },
          source: {
            id: "src_01JABC0002",
            resourceId: "res_01JABC0001",
            kind: "video",
            url: REPLAY_URL,
            platformId: "xiaoe-tech",
            platformVideoId: "l_abc123def456",
            episodeId: null,
            platformScopeId: "app12345",
            progress: { positionMs: 0, revision: 1 },
          },
        }),
      };
    }
    if (/\/sessions$/.test(p)) {
      return { status: 201, ok: true, json: async () => ({ session: { id: "ses_X", status: "active", origin: null } }) };
    }
    if (/transcript$/.test(p)) {
      return { status: 200, ok: true, json: async () => ({ sessionId: "ses_X", sessionStatus: "active", origin: "asr", records: [], gaps: [], pending: [], failed: [] }) };
    }
    if (/finish$/.test(p)) {
      return { status: 200, ok: true, json: async () => ({ session: { id: "ses_X", status: "finished", origin: "asr" } }) };
    }
    if (/progress$/.test(p)) {
      return { status: 200, ok: true, json: async () => ({ positionMs: 0, revision: 1 }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }) };
  };
}


// --- checkAuthNow: the startup probe -----------------------------------------

test("checkAuthNow reports unconfigured when nothing is linked", async () => {
  const { checkAuthNow } = loadBackgroundHelpers({
    settings: baseSettings(),
    auth: { real: true },
  });

  const verdict = await checkAuthNow();
  assert.deepEqual(verdict, { authorized: false, reason: "unconfigured" });
});

test("checkAuthNow records the verdict in the storage breadcrumbs", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    auth: { authorized: false, reason: "unreachable" },
  });
  const verdict = await helpers.checkAuthNow();
  assert.deepEqual(verdict, { authorized: false, reason: "unreachable" });
  const breadcrumb = helpers.readStored("ytd_last_auth_check");
  assert.equal(breadcrumb.reason, "unreachable");
  assert.equal(breadcrumb.authorized, false);
  assert.equal(breadcrumb.hasCredential, false);
});

test("checkAuthNow presents the stored credential as a Bearer token to /v1/me", async () => {
  const seen = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ apiBaseUrl: "https://api.example.com" }),
    stored: {
      ytd_auth_credential: {
        token: "stored-token",
        credentialGroupId: "grp_1",
        email: "l@e.com",
      },
    },
    fetchImpl: async (url, init) => {
      seen.push({ url, authorization: init?.headers?.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ account: { id: "acc_1", email: "l@e.com" } }),
      };
    },
    // The REAL gate module: the sandbox fetch observes the actual probe.
    auth: { real: true },
  });

  const verdict = await helpers.checkAuthNow();
  assert.equal(verdict.authorized, true);
  assert.deepEqual(verdict.account, { id: "acc_1", email: "l@e.com" });
  // The module-load warmup probe plus this explicit call both hit /v1/me.
  assert.ok(seen.length >= 1);
  const last = seen.at(-1);
  assert.equal(last.url, "https://api.example.com/v1/me");
  assert.equal(last.authorization, "Bearer stored-token");

  const breadcrumb = helpers.readStored("ytd_last_auth_check");
  assert.equal(breadcrumb.authorized, true);
  assert.equal(breadcrumb.hasCredential, true);
});

// --- handleOpenAuthPage ------------------------------------------------------

test("openAuthPage opens the configured confirmation page in a tracked tab", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ webAppBaseUrl: "http://127.0.0.1:8080" }),
  });

  const result = await helpers.handleOpenAuthPage();
  assert.equal(result.success, true);
  assert.deepEqual(helpers.createdTabs, [
    { id: 90, url: "http://127.0.0.1:8080/link.html" },
  ]);

  const breadcrumb = helpers.readStored("ytd_last_auth_link_opened");
  assert.equal(breadcrumb.url, "http://127.0.0.1:8080/link.html");
});

test("openAuthPage collapses a trailing slash on the configured origin", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ webAppBaseUrl: "http://127.0.0.1:8080/" }),
  });

  const result = await helpers.handleOpenAuthPage();
  assert.equal(result.success, true);
  assert.deepEqual(helpers.createdTabs, [
    { id: 90, url: "http://127.0.0.1:8080/link.html" },
  ]);
});

test("openResourceDetail opens the configured Web detail deep link without credentials", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ webAppBaseUrl: "http://127.0.0.1:8080/" }),
  });

  const result = await helpers.handleOpenResourceDetail({ resourceId: "res_01 JABC" });
  assert.equal(result.success, true);
  assert.deepEqual(helpers.createdTabs, [
    { id: 90, url: "http://127.0.0.1:8080/?resource=res_01%20JABC" },
  ]);
  assert.equal(helpers.createdTabs[0].url.includes("token"), false);
});

// --- handleLinkCodeCaptured: exchange + store --------------------------------

test("the captured link code is exchanged and the credential stored", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:8787/v1/auth/link");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { code: "link_code_9" });
      return {
        status: 201,
        json: async () => ({
          account: { id: "acc_1", email: "learner@example.com" },
          credential: {
            token: "ext-token",
            kind: "extension",
            credentialGroupId: "grp_1",
          },
        }),
      };
    },
  });

  const result = await helpers.handleLinkCodeCaptured(90, "link_code_9");
  assert.equal(result.success, true);

  const stored = helpers.readStored("ytd_auth_credential");
  assert.equal(stored.token, "ext-token");
  assert.equal(stored.credentialGroupId, "grp_1");
  assert.equal(stored.email, "learner@example.com");

  // The panel is told the link finished, and the tab is closed.
  assert.ok(
    sentMessages.some((message) => message.action === "authAuthorized"),
    "the panel receives authAuthorized",
  );
  assert.deepEqual(helpers.removedTabIds, [90]);

  const breadcrumb = helpers.readStored("ytd_last_auth_link");
  assert.equal(breadcrumb.outcome, "linked");
  assert.equal(breadcrumb.email, "learner@example.com");
});

test("a failed exchange stays unlinked and reports to the panel", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    fetchImpl: async () => ({
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "关联码无效或已过期，请在网页上重新发起关联" },
      }),
    }),
  });

  const result = await helpers.handleLinkCodeCaptured(90, "stale-code");
  assert.equal(result.success, false);
  assert.match(result.error, /关联码无效或已过期/);
  assert.equal(helpers.readStored("ytd_auth_credential"), undefined);

  const authState = sentMessages.find((message) => message.action === "authState");
  assert.ok(authState, "the panel is told the exchange failed");
  assert.equal(authState.authorized, false);
  assert.equal(authState.reason, "linkFailed");
  assert.match(authState.message, /关联码无效或已过期/);

  const breadcrumb = helpers.readStored("ytd_last_auth_link");
  assert.equal(breadcrumb.outcome, "exchangeFailed");
});

// --- pendingLinkTabs 的会话持久化（1.1 验收缺陷候选修复）---------------------
//
// 真实流程里学习者在 Web 确认页上花掉数分钟（邮箱验证码往返），MV3 worker
// 在该窗口内被空闲回收；内存 Set 死掉后，成功跳转 link.html?link= 的
// onUpdated 事件被新 worker 忽略，关联永不完成。修复：集合镜像进
// chrome.storage.session，事件先等恢复再判归属。

/** 轮询直到 exchange 落库（监听器是 fire-and-forget 的）。 */
async function waitFor(predicate, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

test("the pending link tab survives a worker restart and the exchange still fires", async () => {
  // 第一段 worker 生命周期：注册关联标签页并持久化。
  const sessionBacking = {};
  const first = loadBackgroundHelpers({
    settings: baseSettings({ webAppBaseUrl: "http://127.0.0.1:8080" }),
    sessionStored: sessionBacking,
  });
  const opened = await first.handleOpenAuthPage();
  assert.equal(opened.success, true);
  assert.deepEqual([...sessionBacking.ytd_pending_link_tabs], [opened.tabId]);

  // MV3 空闲回收：新 worker 实例——内存为空，只有 session 存储延续。
  const sentMessages = [];
  const second = loadBackgroundHelpers({
    settings: baseSettings({ webAppBaseUrl: "http://127.0.0.1:8080" }),
    sessionStored: sessionBacking,
    sentMessages,
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:8787/v1/auth/link");
      assert.deepEqual(JSON.parse(init.body), { code: "link_code_restart" });
      return {
        status: 201,
        json: async () => ({
          account: { id: "acc_1", email: "learner@example.com" },
          credential: {
            token: "ext-token",
            kind: "extension",
            credentialGroupId: "grp_1",
          },
        }),
      };
    },
  });

  // 成功跳转（LinkApp 的 history.replaceState）触发 onUpdated。
  second.fireTabUpdated(
    opened.tabId,
    { url: "http://127.0.0.1:8080/link.html?link=link_code_restart" },
    { id: opened.tabId, url: "http://127.0.0.1:8080/link.html?link=link_code_restart" },
  );

  const stored = await waitFor(() => second.readStored("ytd_auth_credential"));
  assert.ok(stored, "the exchange ran despite the worker restart");
  assert.equal(second.readStored("ytd_auth_credential").email, "learner@example.com");
  assert.equal(
    second.readStored("ytd_last_auth_link").outcome,
    "linked",
  );
  assert.ok(
    sentMessages.some((message) => message.action === "authAuthorized"),
    "the panel is told the link finished and returns to the course view",
  );
  // 消费后集合清理（内存 + session 镜像），标签页被关闭。
  assert.deepEqual([...second.sessionBacking.ytd_pending_link_tabs], []);
  assert.deepEqual(second.removedTabIds, [opened.tabId]);
});

test("a pending tab removed by the user is dropped from the session mirror", async () => {
  const sessionBacking = {};
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ webAppBaseUrl: "http://127.0.0.1:8080" }),
    sessionStored: sessionBacking,
  });
  const opened = await helpers.handleOpenAuthPage();
  assert.deepEqual([...sessionBacking.ytd_pending_link_tabs], [opened.tabId]);

  helpers.fireTabRemoved(opened.tabId);
  assert.ok(await waitFor(() => !sessionBacking.ytd_pending_link_tabs.includes(opened.tabId)));
  // 内存集合同样不再持有：迟到的成功地址不会触发交换。
  helpers.fireTabUpdated(
    opened.tabId,
    { url: "http://127.0.0.1:8080/link.html?link=late_code" },
    { id: opened.tabId, url: "http://127.0.0.1:8080/link.html?link=late_code" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(helpers.readStored("ytd_auth_credential"), undefined);
});

// --- the capture gate --------------------------------------------------------

test("startLearning is blocked while unlinked, with the guide message", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    auth: { authorized: false, reason: "unconfigured" },
  });

  const result = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  assert.equal(result.success, false);
  assert.match(result.error, /账号关联/);

  const authState = sentMessages.find((message) => message.action === "authState");
  assert.ok(authState, "the panel is pointed back at the guide");
  assert.equal(authState.reason, "unconfigured");
});

test("an unauthorized click skips the streamId fetch and starts no capture", async () => {
  let streamIdFetches = 0;
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    auth: { authorized: false, reason: "unconfigured" },
    getMediaStreamId: async () => {
      streamIdFetches += 1;
      return "should-not-be-fetched";
    },
  });

  // Warm the click-path cache the way the worker-start probe does.
  await helpers.checkAuthNow();
  await helpers.handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });

  assert.equal(streamIdFetches, 0, "no capture plumbing runs while unlinked");
  assert.ok(
    !sentMessages.some((message) => message.action === "captureStart"),
    "no capture starts",
  );
  const attempt = helpers.readStored("ytd_last_start_failure");
  assert.match(attempt.error, /not authorized/);
});

test("a linked worker still starts capture exactly as before (PoC regression)", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ apiBaseUrl: "https://api.example.com" }),
    // Ticket 2.4: the start archives through the API pipeline first (the
    // linked credential drives resolve/create), so the flow needs the /v1
    // seam and the credential in storage.
    stored: {
      ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
    },
    fetchImpl: archiveFlowFetch(),
    sentMessages,
  });

  const result = await helpers.handleStartLearning({
    url: REPLAY_URL,
    tabId: 7,
    streamId: "pre-fetched-id",
  });
  assert.equal(result.success, true, result.error || "");
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
});

// --- the unrecognized-page click (ticket 5.4, #93) ---------------------------
//
// Clicking the toolbar icon on a page outside the learning scope is a normal
// act, not an extension error: nothing lands on the chrome://extensions
// error list, the verdict stays a storage breadcrumb, the panel still opens
// and is told to show the neutral scope notice.

const UNRECOGNIZED_URL = "https://example.com/notes/article";

test("an unrecognized page click stays off the error list: breadcrumb + panel notice only", async () => {
  const consoleErrors = [];
  const consoleImpl = {
    log() {},
    info() {},
    debug() {},
    warn() {},
    error: (...args) => consoleErrors.push(args),
  };
  let panelOpens = 0;
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    consoleImpl,
    sidePanel: {
      setPanelBehavior() {},
      setOptions: () => Promise.resolve(),
      open: () => {
        panelOpens += 1;
        return Promise.resolve();
      },
    },
  });

  await helpers.handleActionClicked({ id: 7, url: UNRECOGNIZED_URL, windowId: 1 });

  assert.equal(panelOpens, 1, "the panel still opens on an unrecognized page");
  assert.deepEqual(consoleErrors, [], "nothing lands on the extension error list");
  assert.equal(
    helpers.readStored("ytd_last_start_failure"),
    undefined,
    "the unrecognized verdict is not recorded as a start failure",
  );
  const breadcrumb = helpers.readStored("ytd_last_page_scope");
  assert.ok(breadcrumb, "the unrecognized verdict keeps a storage breadcrumb");
  assert.equal(breadcrumb.outcome, "unrecognized");
  assert.equal(breadcrumb.url, UNRECOGNIZED_URL);
  const notice = sentMessages.find((message) => message.action === "panelNotice");
  assert.ok(notice, "the panel is told to show the neutral scope notice");
  assert.equal(notice.kind, "unrecognizedPage");
});

test("a recognized page click emits no scope notice and no page-scope breadcrumb", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ apiBaseUrl: "https://api.example.com" }),
    stored: {
      ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
    },
    fetchImpl: archiveFlowFetch(),
    sentMessages,
  });

  await helpers.handleActionClicked({ id: 7, url: REPLAY_URL, windowId: 1 });

  assert.ok(
    !sentMessages.some((message) => message.action === "panelNotice"),
    "recognized pages keep the icon-click flow silent about scope",
  );
  assert.equal(helpers.readStored("ytd_last_page_scope"), undefined);
  assert.ok(
    sentMessages.some((message) => message.action === "captureStart"),
    "the recognized-page start flow is unchanged",
  );
});
