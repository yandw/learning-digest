const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackgroundHelpers } = require("./helpers/load-background");

// P8: the background side of 收藏当前页 — the active-tab collect POST to
// /v1/resources, the read-only resolve probe to /v1/sources/resolve, and
// the storage breadcrumbs that make the outcomes debuggable. The pure
// module (collect.js) is covered by tests/collect.test.js; here the
// worker wiring around it is what's pinned, in the plugin-auth-flow
// harness pattern.

const BILI_P2_URL = "https://www.bilibili.com/video/BV1ab411L78c?p=2";

// Response body copied from contracts/fixtures/api-examples.json
// (api-resources-create-bilibili-p2) — the shared fixture is the one
// source of truth for the response shape.
const FAVORITE_BODY = {
  resource: {
    id: "res_01JABC0001",
    title: "注意力机制详解 P2：自注意力",
    kind: "video",
    createdAt: "2026-11-10T08:00:00Z",
  },
  source: {
    id: "src_01JABC0002",
    resourceId: "res_01JABC0001",
    kind: "video",
    url: BILI_P2_URL,
    platformId: "bilibili",
    platformVideoId: "BV1ab411L78c",
    episodeId: "2",
    platformScopeId: null,
    progress: null,
  },
};

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aiModel: "qwen3.8-flash",
    apiBaseUrl: "https://api.example.com",
    ...overrides,
  };
}

// --- handleCollectCurrentPage: the favorite POST ------------------------------

test("collecting the active tab POSTs url, title and the extracted identity with the stored Bearer token", async () => {
  const seen = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
    },
    tabsQuery: async () => [
      { id: 7, url: BILI_P2_URL, title: "标签页标题" },
    ],
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { status: 201, json: async () => FAVORITE_BODY };
    },
  });

  const result = await helpers.handleCollectCurrentPage();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "created");
  assert.equal(result.resource.id, "res_01JABC0001");

  assert.equal(seen.length, 1, "exactly one API call");
  assert.equal(seen[0].url, "https://api.example.com/v1/resources");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.Authorization, "Bearer ext-token");
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.url, BILI_P2_URL);
  assert.equal(body.title, "标签页标题");
  // The identity comes from the shared extractor (contracts/platform-video-id.js),
  // not a plugin-local reimplementation: bilibili p=2 means episodeId "2".
  assert.deepEqual(body.identity, {
    platformId: "bilibili",
    platformVideoId: "BV1ab411L78c",
    episodeId: "2",
    platformScopeId: null,
  });

  const breadcrumb = helpers.readStored("ytd_last_collect");
  assert.equal(breadcrumb.outcome, "created");
  assert.equal(breadcrumb.url, BILI_P2_URL);
  assert.equal(breadcrumb.resourceId, "res_01JABC0001");
});

test("a duplicate favorite returns the existing outcome (200 with the same resource)", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ytd_auth_credential: { token: "ext-token" },
    },
    tabsQuery: async () => [{ id: 7, url: BILI_P2_URL, title: "标签页标题" }],
    fetchImpl: async () => ({ status: 200, json: async () => FAVORITE_BODY }),
  });

  const result = await helpers.handleCollectCurrentPage();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "existing");
  assert.equal(result.resource.id, "res_01JABC0001", "the same resource comes back");
  const breadcrumb = helpers.readStored("ytd_last_collect");
  assert.equal(breadcrumb.outcome, "existing");
});

// --- the authorization gate on the collect path -------------------------------

test("a collect click while unlinked refuses without an API call and re-guides the panel", async () => {
  const seen = [];
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    auth: { authorized: false, reason: "unconfigured" },
    fetchImpl: async (url) => {
      seen.push(url);
      return { status: 201, json: async () => FAVORITE_BODY };
    },
  });

  const result = await helpers.handleCollectCurrentPage();
  assert.equal(result.ok, false);
  assert.match(result.message, /账号关联/);
  assert.deepEqual(seen, [], "no /v1/resources call while unlinked");
  const authState = sentMessages.find((message) => message.action === "authState");
  assert.ok(authState, "the panel is pointed back at the authorization guide");
  assert.equal(authState.reason, "unconfigured");
});

test("a 401 from the collect POST routes the panel back through the authorization guide", async () => {
  const sentMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    sentMessages,
    stored: {
      ytd_auth_credential: { token: "dead-token" },
    },
    tabsQuery: async () => [{ id: 7, url: BILI_P2_URL, title: "标签页标题" }],
    fetchImpl: async () => ({
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" },
      }),
    }),
  });

  const result = await helpers.handleCollectCurrentPage();
  assert.equal(result.ok, false);
  assert.equal(result.message, "凭据已失效，请重新登录并关联");
  const authState = sentMessages.find((message) => message.action === "authState");
  assert.ok(authState, "the gate guide is re-shown");
  assert.equal(authState.authorized, false);
  assert.equal(authState.reason, "unauthorized");
  const breadcrumb = helpers.readStored("ytd_last_collect");
  assert.equal(breadcrumb.outcome, "failed");
  assert.equal(breadcrumb.status, 401);
});

// --- error branches ------------------------------------------------------------

test("a non-collectable active tab fails locally without touching the API", async () => {
  const seen = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ytd_auth_credential: { token: "ext-token" },
    },
    tabsQuery: async () => [{ id: 7, url: "chrome://newtab", title: "新标签页" }],
    fetchImpl: async (url) => {
      seen.push(url);
      return { status: 201, json: async () => FAVORITE_BODY };
    },
  });

  const result = await helpers.handleCollectCurrentPage();
  assert.equal(result.ok, false);
  assert.match(result.message, /没有可收藏的网页地址/);
  assert.deepEqual(seen, [], "no API call for chrome:// pages");
});

test("a network failure reports a retryable message and stays breadcrumb-traced", async () => {
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ytd_auth_credential: { token: "ext-token" },
    },
    tabsQuery: async () => [{ id: 7, url: BILI_P2_URL, title: "标签页标题" }],
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });

  const result = await helpers.handleCollectCurrentPage();
  assert.equal(result.ok, false);
  assert.match(result.message, /无法连接学习服务/);
  const breadcrumb = helpers.readStored("ytd_last_collect");
  assert.equal(breadcrumb.outcome, "unreachable");
});

// --- title precedence ----------------------------------------------------------

test("the page bridge's real title wins over the tab title", async () => {
  const seen = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ytd_auth_credential: { token: "ext-token" },
    },
    tabsQuery: async () => [
      {
        id: 7,
        url: "https://app12345.xiaoe-tech.com/replay/l_abc123def456",
        title: "小鹅通 - 直播回放",
      },
    ],
    fetchImpl: async (url, init) => {
      seen.push(JSON.parse(init.body));
      return { status: 201, json: async () => FAVORITE_BODY };
    },
  });

  // The bridge reported the real lesson title on that tab (no Session needed).
  await helpers.handlePageTitle(
    { action: "pageTitle", title: "混合动力入门第 3 讲" },
    { tab: { id: 7 } },
  );

  await helpers.handleCollectCurrentPage();
  assert.equal(seen[0].title, "混合动力入门第 3 讲", "bridge title preferred over tab.title");
  // The xiaoe replay page extracts a platform identity from the URL alone.
  assert.deepEqual(seen[0].identity, {
    platformId: "xiaoe-tech",
    platformVideoId: "l_abc123def456",
    episodeId: null,
    platformScopeId: "app12345",
  });
});

// --- handleResolveCurrentSource: the read-only probe ---------------------------

test("resolve on a page with identity asks /v1/sources/resolve and reports a hit", async () => {
  const seen = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ytd_auth_credential: { token: "ext-token" },
    },
    tabsQuery: async () => [{ id: 7, url: BILI_P2_URL, title: "标签页标题" }],
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return {
        status: 200,
        json: async () => ({
          matched: true,
          resource: FAVORITE_BODY.resource,
          source: { ...FAVORITE_BODY.source, progress: { positionMs: 250000, revision: 2 } },
        }),
      };
    },
  });

  const result = await helpers.handleResolveCurrentSource();
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.resource.id, "res_01JABC0001");
  assert.equal(seen[0].url, "https://api.example.com/v1/sources/resolve");
  assert.equal(seen[0].init.headers.Authorization, "Bearer ext-token");
  const breadcrumb = helpers.readStored("ytd_last_collect_resolve");
  assert.equal(breadcrumb.matched, true);
});

test("resolve on a plain webpage answers a local miss without calling the API", async () => {
  const seen = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ytd_auth_credential: { token: "ext-token" },
    },
    tabsQuery: async () => [
      { id: 7, url: "https://www.example.com/articles/habit", title: "文章" },
    ],
    fetchImpl: async (url) => {
      seen.push(url);
      return { status: 200, json: async () => ({ matched: false }) };
    },
  });

  const result = await helpers.handleResolveCurrentSource();
  assert.equal(result.ok, true);
  assert.equal(result.matched, false);
  assert.equal(result.identityPresent, false, "no confirmable identity on a plain page");
  assert.deepEqual(seen, [], "no API call without identity: panel opens stay quiet");
});

test("resolve with an unconfirmed identity present still skips the API when nothing is linked", async () => {
  const seen = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    tabsQuery: async () => [{ id: 7, url: BILI_P2_URL, title: "标签页标题" }],
    fetchImpl: async (url) => {
      seen.push(url);
      return { status: 200, json: async () => ({ matched: false }) };
    },
  });

  const result = await helpers.handleResolveCurrentSource();
  assert.equal(result.ok, true);
  assert.equal(result.matched, false);
  assert.deepEqual(seen, [], "no credential, no probe");
});
