const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadBackgroundHelpers } = require("./helpers/load-background.js");

// P7 linked logout, extension side. Two entry points share one semantic:
// an explicit 退出登录 (the panel entry) and a server-side group revocation
// surfaced by a 401 (the credentialsInvalidated path P10's progress writes
// will drive). Both stop any running capture and local Session advancement,
// keep the storage breadcrumbs, and put the panel back on the guide. The
// API-level group revocation itself is pinned in apps/api/test/auth-logout.
//test.js.

const REPLAY_URL = "https://app12345.xiaoe-tech.com/replay/l_abc123def456";
const LIVE_URL = "https://app12345.xiaoe-tech.com/live/l_abc123def456";

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aiModel: "qwen3.8-flash",
    speechProvider: "groq",
    speechProviders: { groq: { apiKey: "gsk-x" } },
    // apiBaseUrl stays unset by default: an unconfigured origin makes the
    // auth probe a no-op, so only tests that inject fetchImpl ever build a
    // request (no test reaches an external host).
    ...overrides,
  };
}

function realtimeSettings() {
  return baseSettings({
    speechProvider: "qwen",
    speechProviders: { qwen: { apiKey: "qwen-key", mode: "realtime" } },
  });
}

const STORED_CREDENTIAL = {
  token: "ext-token",
  credentialGroupId: "grp_1",
  accountId: "acc_1",
  email: "learner@example.com",
  linkedAt: 1_700_000_000_000,
};

// --- handleLogout: the panel's explicit 退出登录 -------------------------------

test("logout revokes the credential group server-side and clears the local credential", async () => {
  const seen = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ apiBaseUrl: "https://api.example.com" }),
    stored: { ytd_auth_credential: { ...STORED_CREDENTIAL } },
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init?.method, authorization: init?.headers?.Authorization });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });

  const result = await helpers.handleLogout();

  assert.equal(result.success, true);
  assert.deepEqual(seen, [
    {
      url: "https://api.example.com/v1/auth/logout",
      method: "POST",
      authorization: "Bearer ext-token",
    },
  ]);
  assert.equal(
    helpers.readStored("ytd_auth_credential"),
    undefined,
    "the dead credential leaves the storage",
  );
  const breadcrumb = helpers.readStored("ytd_last_auth_logout");
  assert.equal(breadcrumb.outcome, "loggedOut");
  assert.equal(breadcrumb.hadCredential, true);
});

test("logout still clears the local credential when the server is unreachable", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ apiBaseUrl: "https://api.example.com" }),
    stored: { ytd_auth_credential: { ...STORED_CREDENTIAL } },
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });

  const result = await helpers.handleLogout();

  assert.equal(result.success, true, "a network failure must not trap the learner");
  assert.equal(helpers.readStored("ytd_auth_credential"), undefined);
});

test("logout without a linked credential succeeds without a network call", async () => {
  let fetches = 0;
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ apiBaseUrl: "https://api.example.com" }),
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });

  const result = await helpers.handleLogout();

  assert.equal(result.success, true);
  assert.equal(fetches, 0, "nothing to revoke: no request is made");
  const breadcrumb = helpers.readStored("ytd_last_auth_logout");
  assert.equal(breadcrumb.hadCredential, false);
});

test("logout stops the running capture and skips the AI pass", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ apiBaseUrl: "https://api.example.com" }),
    sentMessages,
    stored: { ytd_auth_credential: { ...STORED_CREDENTIAL } },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  });

  const started = await helpers.handleStartLearning({ url: REPLAY_URL, tabId: 7 });
  assert.equal(started.success, true);
  const stateBefore = await helpers.handleGetSessionState();
  assert.equal(stateBefore.active, true);

  await helpers.handleLogout();

  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.equal(snapshot.status, "ended", "the running Session ends");
  assert.equal(
    helpers.readStored(`report_${started.sessionId}`),
    undefined,
    "no AI pass runs for a logged-out learner",
  );
  assert.equal(
    helpers.readStored("ytd_active_capture"),
    undefined,
    "the capture pointer is cleared",
  );
  assert.ok(
    sentMessages.some((message) => message.action === "captureStop"),
    "the offscreen recorder is told to stop",
  );
  assert.equal((await helpers.handleGetSessionState()).active, false);
});

// --- handleCredentialsInvalidated: a 401 arrived mid-Session -------------------

test("credentialsInvalidated mid-Session stops the capture, keeps the records and breadcrumbs", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: realtimeSettings(),
    sentMessages,
    stored: { ytd_auth_credential: { ...STORED_CREDENTIAL } },
  });

  const started = await helpers.handleStartLearning({ url: LIVE_URL, tabId: 7 });
  assert.equal(started.success, true);
  // Mid-flight: one utterance has been captured when the 401 arrives
  // (P10's progress write will be the real trigger; the test simulates it).
  await helpers.handleRealtimeUtterance({ text: "老师好", start: 0, duration: 2 });
  await helpers.handleRealtimeUtterance({ text: "今天讲因果推断", start: 2, duration: 3 });

  const result = await helpers.handleCredentialsInvalidated("unauthorized");

  assert.equal(result.success, true);
  assert.equal(result.stoppedSessionId, started.sessionId);

  const snapshot = helpers.readStored(`ytd_session_${started.sessionId}`);
  assert.equal(snapshot.status, "ended", "the Session stops advancing");
  assert.ok(
    snapshot.transcriptRecords.length >= 2,
    "what was captured stays persisted (storage breadcrumbs kept)",
  );
  assert.equal(
    helpers.readStored(`report_${started.sessionId}`),
    undefined,
    "no AI pass runs for invalidated credentials",
  );
  assert.equal(helpers.readStored("ytd_active_capture"), undefined);
  assert.ok(
    helpers.readStored("ytd_last_auth_check") || helpers.readStored("ytd_last_auth_link"),
    "the auth breadcrumb trail is kept",
  );

  const authState = sentMessages.find((message) => message.action === "authState");
  assert.ok(authState, "the panel is pointed at the guide");
  assert.equal(authState.authorized, false);
  assert.equal(authState.reason, "unauthorized");
});

test("credentialsInvalidated without an active capture still notifies the panel", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
  });

  const result = await helpers.handleCredentialsInvalidated("unauthorized");

  assert.equal(result.success, true);
  assert.equal(result.stoppedSessionId, null);
  const authState = sentMessages.find((message) => message.action === "authState");
  assert.ok(authState);
  assert.equal(authState.reason, "unauthorized");
});

test("the gate check drives the invalidated path on a definitive 401 verdict", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    auth: { authorized: false, reason: "unauthorized" },
  });

  const verdict = await helpers.handleCheckAuth();

  assert.deepEqual(verdict, { authorized: false, reason: "unauthorized" });
  const authState = sentMessages.find((message) => message.action === "authState");
  assert.ok(authState, "the panel is notified through the push channel too");
  assert.equal(authState.reason, "unauthorized");
});

test("the gate check leaves everything alone on an unreachable verdict", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    auth: { authorized: false, reason: "unreachable" },
  });

  const verdict = await helpers.handleCheckAuth();

  assert.deepEqual(verdict, { authorized: false, reason: "unreachable" });
  assert.equal(
    sentMessages.find((message) => message.action === "authState"),
    undefined,
    "an unreachable API is not a logout",
  );
});

// --- Re-login + re-link chain (P6 link flow pattern) ---------------------------

test("after a logout the extension re-links and unlocks again", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings({ apiBaseUrl: "https://api.example.com" }),
    sentMessages,
    stored: { ytd_auth_credential: { ...STORED_CREDENTIAL } },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/v1/auth/logout")) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      // The re-link exchange after the learner logged into the Web again.
      assert.equal(String(url).endsWith("/v1/auth/link"), true);
      return {
        status: 201,
        json: async () => ({
          account: { id: "acc_1", email: "learner@example.com" },
          credential: {
            token: "ext-token-2",
            kind: "extension",
            credentialGroupId: "grp_2",
          },
        }),
      };
    },
  });

  await helpers.handleLogout();
  assert.equal(helpers.readStored("ytd_auth_credential"), undefined);

  // The learner logged into the Web, confirmed the link there, and the
  // extension read the one-time code from its tab (P6 flow, second round).
  const result = await helpers.handleLinkCodeCaptured(90, "link_code_fresh");
  assert.equal(result.success, true);

  const stored = helpers.readStored("ytd_auth_credential");
  assert.equal(stored.token, "ext-token-2");
  assert.equal(stored.credentialGroupId, "grp_2");
  assert.ok(
    sentMessages.some((message) => message.action === "authAuthorized"),
    "the panel is told to unlock",
  );
});

// --- Panel + worker wiring pins ------------------------------------------------

test("the panel offers 退出登录 in the authorized shell and the guide replaces it", () => {
  const root = path.resolve(__dirname, "..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const html = read("sidepanel.html");
  const panelJs = read("sidepanel.js");
  const background = read("background.js");

  // The header carries the logout entry next to the settings button.
  assert.match(html, /id="logoutBtn"[^>]*>\s*退出登录/);
  // Clicking it asks the worker to log out and lands on the guide.
  assert.match(panelJs, /getElementById\("logoutBtn"\)/);
  assert.match(panelJs, /action: "logout"/);
  // The gate view hides the logout entry along with the settings entry.
  assert.match(panelJs, /function setSettingsButtonVisible[\s\S]*?getElementById\("logoutBtn"\)/);
  // The worker registers the logout action (the group revocation lives in
  // handleLogout, behaviorally tested above).
  assert.match(background, /message\.action === "logout"/);
});
