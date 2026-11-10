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
    settings: baseSettings(),
    sentMessages,
  });

  const result = await helpers.handleStartLearning({
    url: REPLAY_URL,
    tabId: 7,
    streamId: "pre-fetched-id",
  });
  assert.equal(result.success, true);
  const start = sentMessages.find((message) => message.action === "captureStart");
  assert.ok(start, "captureStart reached the offscreen recorder");
});
