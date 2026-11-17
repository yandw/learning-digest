/**
 * 挂载页面切换 (0.2.34): the header dropdown's data source and the
 * jump / course-switch semantics behind it. handleGetLearningPages answers a
 * PASSIVE list (the ACTIVE_CAPTURE pointer marks the mount — no
 * ensureCaptureResumed side effects); handleSwitchLearningPage jumps for
 * same-course / no-session picks and demands the panel's confirm before
 * ending a different-course Session (the 0.1.57 end-without-report trade).
 * Harness: tests/helpers/load-background.js (the plugin-learning-start-flow
 * seam pattern).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

const YT_A = "https://www.youtube.com/watch?v=AbCdEfGh123";
const YT_B = "https://www.youtube.com/watch?v=XyZaBcDe456";
const PLAIN = "https://example.com/article";

const TABS = [
  { id: 5, url: YT_A, title: "课程 A", active: false },
  { id: 7, url: YT_B, title: "课程 B", active: true },
  { id: 9, url: PLAIN, title: "一篇文章", active: false },
];

const tabsQuery = async () => TABS;
const tabsGet = async (tabId) => {
  const tab = TABS.find((entry) => entry.id === tabId);
  if (!tab) throw new Error("tab not found");
  return tab;
};

function baseSettings() {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.example.com/ai",
    aiModel: "test-model",
    apiBaseUrl: "https://api.example.com",
    segmentLengthSeconds: 60,
    summaryIntervalMinutes: 30,
  };
}

const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

const RESOLVE_MATCHED_BODY = {
  matched: true,
  resource: { id: "res_01", title: "示例课程", kind: "video", createdAt: "2026-11-10T08:00:00Z" },
  source: {
    id: "src_01",
    resourceId: "res_01",
    kind: "video",
    url: YT_A,
    platformId: "youtube",
    platformVideoId: "AbCdEfGh123",
    episodeId: null,
    platformScopeId: null,
    progress: null,
  },
};

/** One fetch seam: /v1/resolve answers matched, the Session POST 201s. */
function v1Fetch() {
  return async (url, options = {}) => {
    void options;
    const path = String(url).replace(/^https:\/\/api\.example\.com/, "");
    if (path === "/v1/sources/resolve") {
      return { status: 200, ok: true, json: async () => RESOLVE_MATCHED_BODY };
    }
    if (/^\/v1\/sources\/[^/]+\/sessions$/.test(path)) {
      return {
        status: 201,
        ok: true,
        json: async () => ({
          session: {
            id: `ses_${Math.random().toString(36).slice(2, 10)}`,
            sourceId: "src_01",
            resourceId: "res_01",
            status: "active",
            startedAt: "2026-11-17T04:00:00Z",
            finishedAt: null,
            origin: null,
          },
        }),
      };
    }
    return { status: 200, ok: true, json: async () => ({}) };
  };
}

const cutReply = (message) =>
  message.action === "captureCut"
    ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
    : { success: true };

function makeHelpers(extra = {}) {
  return loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsQuery,
    tabsGet,
    fetchImpl: v1Fetch(),
    sendMessageImpl: cutReply,
    ...extra,
  });
}

test("getLearningPages lists only supported video pages and peeks the mount passively", async () => {
  const helpers = makeHelpers();
  const result = await helpers.handleGetLearningPages();
  assert.equal(result.ok, true);
  // Element-wise, not deepEqual: the answer is built in the VM sandbox,
  // whose Array prototype differs from this realm's.
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].tabId, 5);
  assert.equal(result.pages[1].tabId, 7);
  assert.equal(result.pages[0].title, "课程 A");
  assert.equal(result.session, null, "no pointer: nothing is mounted");
  // Passive means passive: no capture machinery woke up.
  assert.equal(helpers.readStored("ytd_active_capture"), undefined);
});

test("switch with no session just jumps and activates the chosen tab", async () => {
  const helpers = makeHelpers();
  const result = await helpers.handleSwitchLearningPage({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.action, "jumped");
  assert.deepEqual(helpers.activatedTabs, [{ tabId: 7, active: true }]);
});

test("switch refuses honestly for a closed or non-video tab", async () => {
  const helpers = makeHelpers();
  const gone = await helpers.handleSwitchLearningPage({ tabId: 42 });
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, "tabNotFound");
  const plain = await helpers.handleSwitchLearningPage({ tabId: 9 });
  assert.equal(plain.ok, false);
  assert.equal(plain.reason, "notVideoPage");
});

test("a different course demands the confirm first, and leaves the Session untouched", async () => {
  const helpers = makeHelpers();
  const started = await helpers.handleStartLearning({ url: YT_A, tabId: 5 });
  assert.equal(started.success, true);

  const ask = await helpers.handleSwitchLearningPage({ tabId: 7 });
  assert.equal(ask.ok, false);
  assert.equal(ask.reason, "courseSwitchConfirm");

  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.tabId, 5, "the mount did not move before the confirm");
  assert.equal(pointer.sessionId, started.sessionId);
  assert.equal(helpers.activatedTabs.length, 0, "no jump either before the confirm");
});

test("the confirmed switch ends the old Session (course-switch, no report) and starts on the new tab", async () => {
  const helpers = makeHelpers();
  const started = await helpers.handleStartLearning({ url: YT_A, tabId: 5 });
  assert.equal(started.success, true);

  const result = await helpers.handleSwitchLearningPage({ tabId: 7, confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.action, "switched");

  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.tabId, 7, "the mount moved to the chosen tab");
  assert.notEqual(pointer.sessionId, started.sessionId, "a fresh Session owns the mount");
  assert.deepEqual(
    helpers.activatedTabs,
    [{ tabId: 7, active: true }],
    "the browser lands on the new mount",
  );
});

test("the same course in another tab jumps back to the Session's own tab", async () => {
  // Tab 11 holds the SAME video (reopened page): no course switch, no end.
  const REOPENED = { id: 11, url: YT_A, title: "课程 A（新标签页）", active: true };
  const helpers = makeHelpers({
    tabsGet: async (tabId) => {
      if (tabId === 11) return REOPENED;
      return tabsGet(tabId);
    },
  });
  const started = await helpers.handleStartLearning({ url: YT_A, tabId: 5 });
  assert.equal(started.success, true);

  const result = await helpers.handleSwitchLearningPage({ tabId: 11 });
  assert.equal(result.ok, true);
  assert.equal(result.action, "jumped");
  assert.equal(result.tabId, 5, "the jump lands on the Session's own tab");
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.sessionId, started.sessionId, "the Session never ended");
  assert.deepEqual(helpers.activatedTabs, [{ tabId: 5, active: true }]);
});
