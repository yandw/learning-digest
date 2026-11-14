const test = require("node:test");
const assert = require("node:assert/strict");

// The pure collect state machine behind the extension's 收藏当前页 entry
// (issue #58): contract §3.1 POST /v1/resources request building, response
// → outcome mapping (201 creates, 200 returns the existing favorite), §3.4
// resolve parsing, and the local collectable-URL guard. The expected values
// come from contracts/fixtures/api-examples.json, not from the code.

const YTD_COLLECT = require("../collect.js");

// --- buildCollectRequest ------------------------------------------------------

test("buildCollectRequest sends url, title and identity for a recognized video page", () => {
  const body = YTD_COLLECT.buildCollectRequest({
    url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
    title: "注意力机制详解 P2：自注意力",
    identity: {
      platformId: "bilibili",
      platformVideoId: "BV1ab411L78c",
      episodeId: "2",
      platformScopeId: null,
    },
  });
  assert.deepEqual(body, {
    url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
    title: "注意力机制详解 P2：自注意力",
    identity: {
      platformId: "bilibili",
      platformVideoId: "BV1ab411L78c",
      episodeId: "2",
      platformScopeId: null,
    },
  });
});

test("buildCollectRequest omits an empty title (the contract allows titleless favorites)", () => {
  const body = YTD_COLLECT.buildCollectRequest({
    url: "https://www.example.com/articles/building-a-learning-habit",
    title: "",
    identity: null,
  });
  assert.deepEqual(body, {
    url: "https://www.example.com/articles/building-a-learning-habit",
  });
  assert.equal("title" in body, false, "no empty title field");
  assert.equal("identity" in body, false, "no identity for a plain webpage");
});

test("buildCollectRequest drops whitespace-only titles and trims real ones", () => {
  const body = YTD_COLLECT.buildCollectRequest({
    url: "https://www.example.com/a",
    title: "   如何建立学习习惯   ",
    identity: null,
  });
  assert.equal(body.title, "如何建立学习习惯");
});

test("buildCollectRequest returns null for a non-collectable url", () => {
  assert.equal(YTD_COLLECT.buildCollectRequest({ url: "chrome://extensions" }), null);
  assert.equal(YTD_COLLECT.buildCollectRequest({ url: "not a url" }), null);
  assert.equal(YTD_COLLECT.buildCollectRequest({ url: undefined }), null);
});

test("buildCollectRequest omits a malformed identity instead of sending it", () => {
  const body = YTD_COLLECT.buildCollectRequest({
    url: "https://www.example.com/a",
    identity: { platformId: "bilibili" },
  });
  assert.equal("identity" in body, false, "identity needs platformId AND platformVideoId");
});

// --- parseCollectResponse -----------------------------------------------------

const CREATED_BODY = {
  resource: { id: "res_01JABC0001", title: "注意力机制详解 P2：自注意力", kind: "video", createdAt: "2026-11-10T08:00:00Z" },
  source: {
    id: "src_01JABC0002",
    resourceId: "res_01JABC0001",
    kind: "video",
    url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
    platformId: "bilibili",
    platformVideoId: "BV1ab411L78c",
    episodeId: "2",
    platformScopeId: null,
    progress: null,
  },
};

test("parseCollectResponse maps 201 to the created outcome with the returned resource and source", () => {
  const result = YTD_COLLECT.parseCollectResponse({ status: 201, data: CREATED_BODY });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "created");
  assert.equal(result.resource.id, "res_01JABC0001");
  assert.equal(result.source.id, "src_01JABC0002");
});

test("parseCollectResponse maps 200 to the existing outcome (duplicate favorite returns the same resource)", () => {
  const result = YTD_COLLECT.parseCollectResponse({ status: 200, data: CREATED_BODY });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "existing");
  assert.equal(result.resource.id, "res_01JABC0001");
});

test("parseCollectResponse surfaces the contract error envelope message", () => {
  const result = YTD_COLLECT.parseCollectResponse({
    status: 400,
    data: { error: { code: "invalid_url", message: "地址缺失、非法或非 http(s)" } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, "地址缺失、非法或非 http(s)");
  assert.equal(result.code, "invalid_url");
});

test("parseCollectResponse falls back to a friendly message when the body is not an envelope", () => {
  const result = YTD_COLLECT.parseCollectResponse({ status: 500, data: null });
  assert.equal(result.ok, false);
  assert.ok(result.message && result.message.length > 0, "a message exists for a malformed failure body");
});

test("parseCollectResponse rejects a 2xx body without resource and source (protocol violation)", () => {
  const result = YTD_COLLECT.parseCollectResponse({ status: 201, data: { resource: { id: "r" } } });
  assert.equal(result.ok, false);
  assert.ok(result.message && result.message.length > 0);
});

// --- parseResolveResponse -----------------------------------------------------

test("parseResolveResponse maps a hit to matched with resource and source", () => {
  const result = YTD_COLLECT.parseResolveResponse({
    status: 200,
    data: { matched: true, resource: CREATED_BODY.resource, source: { ...CREATED_BODY.source, progress: { positionMs: 250000, revision: 2 } } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.resource.id, "res_01JABC0001");
  assert.equal(result.source.progress.positionMs, 250000);
});

test("parseResolveResponse maps matched:false to a clean miss (resolve writes nothing)", () => {
  const result = YTD_COLLECT.parseResolveResponse({ status: 200, data: { matched: false } });
  assert.equal(result.ok, true);
  assert.equal(result.matched, false);
  assert.equal(result.resource, null);
});

test("parseResolveResponse treats a 401 as failure with the envelope message", () => {
  const result = YTD_COLLECT.parseResolveResponse({
    status: 401,
    data: { error: { code: "unauthorized", message: "未登录或凭据缺失" } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.matched, false);
  assert.equal(result.message, "未登录或凭据缺失");
});

// --- isCollectableUrl ---------------------------------------------------------

test("isCollectableUrl accepts http(s) pages and rejects browser pages and garbage", () => {
  assert.equal(YTD_COLLECT.isCollectableUrl("https://www.bilibili.com/video/BV1ab411L78c?p=2"), true);
  assert.equal(YTD_COLLECT.isCollectableUrl("http://127.0.0.1:8080/link.html"), true);
  assert.equal(YTD_COLLECT.isCollectableUrl("chrome://extensions"), false);
  assert.equal(YTD_COLLECT.isCollectableUrl("file:///Users/atom/notes.md"), false);
  assert.equal(YTD_COLLECT.isCollectableUrl(""), false);
  assert.equal(YTD_COLLECT.isCollectableUrl(null), false);
});
