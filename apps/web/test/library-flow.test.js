import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createLibraryFlow, presentListItem, presentDetail, presentNote, buildNoteJumpUrl, formatPosition, progressLabel } from "../public/js/library.js";

// The library flow (pure module, P5): paste-to-collect inside the login
// shell, the learning list, and the resource detail with retitle. It owns
// the decisions — client-side identity extraction through the shared
// contracts module, the 201-created / 200-duplicate presentation, error
// envelopes verbatim — while the page only binds snapshots to the DOM.
//
// The api seam is faked with the exact shape createApiClient exposes
// (createResource / listResources / getResourceDetail / updateResourceTitle
// returning { ok, status, data }); the identity extractor is the REAL
// contracts module, because it is a pure local function and the fixture
// samples pin its output.

const require = createRequire(import.meta.url);
const platformVideoId = require("../../../contracts/platform-video-id.js");

const FIXTURES_DIR = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "..",
  "..",
  "contracts",
  "fixtures",
);
const apiExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "api-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);

/** Fake api: script the next result of each resource method; record calls. */
function fakeApi({ createResult, listResult, detailResult, retitleResult } = {}) {
  const calls = { create: [], list: 0, detail: [], retitle: [] };
  return {
    calls,
    async createResource(body) {
      calls.create.push(body);
      return createResult || { ok: true, status: 201, data: apiExampleById.get("api-resources-create-bilibili-p2").response.body };
    },
    async listResources() {
      calls.list += 1;
      return listResult || { ok: true, status: 200, data: apiExampleById.get("api-resources-list").response.body };
    },
    async getResourceDetail(id) {
      calls.detail.push(id);
      return detailResult || { ok: true, status: 200, data: apiExampleById.get("api-resources-detail-with-notes").response.body };
    },
    async updateResourceTitle(id, title) {
      calls.retitle.push({ id, title });
      return retitleResult || { ok: true, status: 200, data: { resource: { id, title, kind: "webpage", createdAt: "2026-11-10T08:05:00Z" } } };
    },
    // login-flow methods exist on the seam but the library flow never calls them.
    async requestCode() { throw new Error("not used"); },
    async verify() { throw new Error("not used"); },
    async logout() { throw new Error("not used"); },
    async me() { throw new Error("not used"); },
  };
}

function flowWith({ api, identity } = {}) {
  return createLibraryFlow({
    api: api || fakeApi(),
    identity: identity || platformVideoId,
  });
}

// --- collection --------------------------------------------------------------

test("collect extracts the platform identity client-side and POSTs it", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });
  const request = apiExampleById.get("api-resources-create-bilibili-p2").request.body;

  const result = await flow.collect({ url: request.url, title: request.title });

  assert.equal(result.ok, true);
  assert.equal(api.calls.create.length, 1);
  // The client-built body matches the contract sample: same url, same
  // title, and the identity extracted locally from the URL (the shared
  // extractor returns the §2.5-canonical shape, which also carries
  // platformScopeId: null for the three non-xiaoe platforms).
  const body = api.calls.create[0];
  assert.equal(body.url, request.url);
  assert.equal(body.title, request.title);
  assert.deepEqual(body.identity, { ...request.identity, platformScopeId: null });
  const state = flow.getState();
  assert.match(state.notice, /已收藏/);
  assert.equal(state.error, null);
  // The list is refreshed so the new item shows up.
  assert.equal(api.calls.list, 1);
});

test("collect omits identity for plain webpages and omits an empty title", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });

  await flow.collect({ url: "  https://www.example.com/articles/building-a-learning-habit  ", title: "   " });

  const body = api.calls.create[0];
  assert.equal(body.url, "https://www.example.com/articles/building-a-learning-habit");
  assert.equal(body.identity, undefined, "no locally confirmable identity -> omitted");
  assert.equal(body.title, undefined, "blank title -> omitted, server falls back to the address");
});

test("a duplicate favorite (200) presents the same-resource notice", async () => {
  const api = fakeApi({
    createResult: {
      ok: true,
      status: 200,
      data: apiExampleById.get("api-resources-duplicate-bilibili-p2").response.body,
    },
  });
  const flow = flowWith({ api });
  const request = apiExampleById.get("api-resources-duplicate-bilibili-p2").request.body;

  const result = await flow.collect({ url: request.url, title: request.title });

  assert.equal(result.ok, true);
  assert.match(flow.getState().notice, /已收藏，返回同一条资料/);
});

test("collect rejects an empty URL locally without calling the API", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });

  const result = await flow.collect({ url: "   ", title: "" });

  assert.equal(result.ok, false);
  assert.match(flow.getState().error, /请输入网页链接/);
  assert.equal(api.calls.create.length, 0);
  assert.equal(api.calls.list, 0);
});

test("collect presents the contract error envelope verbatim (invalid_url)", async () => {
  const api = fakeApi({
    createResult: {
      ok: false,
      status: 400,
      data: { error: { code: "invalid_url", message: "仅支持 http(s) 网页地址" } },
    },
  });
  const flow = flowWith({ api });

  const result = await flow.collect({ url: "not a url", title: "" });

  assert.equal(result.ok, false);
  assert.equal(flow.getState().error, "仅支持 http(s) 网页地址");
  assert.equal(api.calls.list, 0, "a failed collect does not refresh the list");
});

// --- list --------------------------------------------------------------------

test("load fetches the list and getState exposes the items", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });

  await flow.load();

  assert.equal(api.calls.list, 1);
  const items = flow.getState().resources;
  assert.equal(items.length, 2);
  // Newest first per contract §3.2: the webpage (08:05) before the video (08:00).
  assert.equal(items[0].resource.id, "res_01JABC0010");
  assert.equal(items[1].resource.id, "res_01JABC0001");
});

test("load presents a failed list read through the envelope", async () => {
  const api = fakeApi({
    listResult: { ok: false, status: 502, data: null },
  });
  const flow = flowWith({ api });

  await flow.load();

  assert.ok(flow.getState().error.length > 0);
});

// --- presentation ------------------------------------------------------------

test("presentListItem maps a list item to display data", () => {
  const list = apiExampleById.get("api-resources-list").response.body.resources;

  const webpage = presentListItem(list[0]);
  assert.equal(webpage.id, "res_01JABC0010");
  assert.equal(webpage.title, "如何建立学习习惯");
  assert.equal(webpage.href, "https://www.example.com/articles/building-a-learning-habit");
  assert.equal(webpage.kindLabel, "网页");
  assert.equal(webpage.platformLabel, null, "unrecognized platform shows no badge");
  assert.equal(webpage.progressText, null, "no progress -> no progress line");

  const video = presentListItem(list[1]);
  assert.equal(video.title, "注意力机制详解 P2：自注意力");
  assert.equal(video.href, "https://www.bilibili.com/video/BV1ab411L78c?p=2");
  assert.equal(video.kindLabel, "视频");
  assert.equal(video.platformLabel, "B站");
  assert.equal(video.progressText, "上次学到 4:10", "250000ms renders as mm:ss");
});

test("formatPosition renders mm:ss and h:mm:ss", () => {
  assert.equal(formatPosition(0), "0:00");
  assert.equal(formatPosition(59000), "0:59");
  assert.equal(formatPosition(250000), "4:10");
  assert.equal(formatPosition(3599000), "59:59");
  assert.equal(formatPosition(3661000), "1:01:01");
  assert.equal(formatPosition(null), null);
});

test("progressLabel keys on the revision, so a stored 0:00 still shows (round-1 review fix)", () => {
  // The has-progress judgment is revision-based: a revision-backed
  // positionMs of 0 IS progress ("上次学到 0:00"); a blob without a
  // positive revision shows no line.
  assert.equal(progressLabel({ progress: { positionMs: 0, revision: 1 } }), "上次学到 0:00");
  assert.equal(progressLabel({ progress: { positionMs: 250000, revision: 1 } }), "上次学到 4:10");
  assert.equal(progressLabel({ progress: { positionMs: 250000, revision: 3 } }), "上次学到 4:10");
  assert.equal(progressLabel({ progress: { positionMs: 250000 } }), null, "no revision is no progress");
  assert.equal(progressLabel({ progress: { positionMs: 250000, revision: 0 } }), null, "revision 0 is no progress");
  assert.equal(progressLabel({ progress: { positionMs: -1, revision: 1 } }), null, "an unusable position shows no line");
  assert.equal(progressLabel({ progress: null }), null);
  assert.equal(progressLabel({}), null);
  assert.equal(progressLabel(null), null);
});

// --- detail ------------------------------------------------------------------

test("openDetail fetches the resource detail and switches the view", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });
  await flow.load();

  await flow.openDetail("res_01JABC0001");

  assert.deepEqual(api.calls.detail, ["res_01JABC0001"]);
  const state = flow.getState();
  assert.equal(state.view, "detail");
  assert.equal(state.detail.resource.id, "res_01JABC0001");
  assert.equal(state.detail.sources.length, 1);
  assert.equal(state.detail.notes.length, 1);
});

test("a failed detail read stays on the list and shows the envelope", async () => {
  const api = fakeApi({
    detailResult: {
      ok: false,
      status: 404,
      data: { error: { code: "not_found", message: "资源不存在或无权访问" } },
    },
  });
  const flow = flowWith({ api });
  await flow.load();

  await flow.openDetail("res_missing");

  assert.equal(flow.getState().view, "list");
  assert.equal(flow.getState().error, "资源不存在或无权访问");
});

test("presentDetail maps the detail to display data", () => {
  const detail = apiExampleById.get("api-resources-detail-with-notes").response.body;
  const presented = presentDetail(detail);

  assert.equal(presented.id, "res_01JABC0001");
  assert.equal(presented.title, "注意力机制详解 P2：自注意力");
  assert.equal(presented.sources.length, 1);
  assert.equal(presented.sources[0].url, "https://www.bilibili.com/video/BV1ab411L78c?p=2");
  assert.equal(presented.sources[0].kindLabel, "视频");
  assert.equal(presented.sources[0].platformLabel, "B站");
  assert.equal(presented.sources[0].progressText, "上次学到 4:10");
  assert.equal(presented.notesCount, 1);
});

// --- notes read-back (P12, issue #61) ------------------------------------------

const FIXTURE_NOTE = apiExampleById.get("api-resources-detail-with-notes").response.body.notes[0];

test("presentNote maps a timestamped note: text plus the mm:ss stamp", () => {
  const presented = presentNote(FIXTURE_NOTE);
  assert.equal(presented.id, "note_01JABC0021");
  assert.equal(presented.text, "3:20 起的例子值得回看");
  // 200000ms -> 3:20, same formatting as the progress line.
  assert.equal(presented.stamp, "3:20");
  assert.equal(presented.sourceId, "src_01JABC0002");
  assert.equal(presented.positionMs, 200000);
});

test("presentNote leaves the stamp null for a plain webpage note", () => {
  const note = apiExampleById.get("api-note-create-webpage").response.body.note;
  const presented = presentNote(note);
  assert.equal(presented.stamp, null);
  assert.equal(presented.sourceId, null);
  assert.equal(presented.text, "这篇的复利概念可以整理进学习计划");
});

test("presentNote tolerates a broken positionMs (no stamp, no crash)", () => {
  assert.equal(presentNote({ id: "n", text: "x", sourceId: null, positionMs: "200000" }).stamp, null);
  assert.equal(presentNote({ id: "n", text: "x", sourceId: null, positionMs: -5 }).stamp, null);
});

test("buildNoteJumpUrl adds the platform seek parameter for bilibili (best effort)", () => {
  const sources = apiExampleById.get("api-resources-detail-with-notes").response.body.sources;
  const url = buildNoteJumpUrl(FIXTURE_NOTE, sources);
  // The p=2 episode param is kept; t carries the note's seconds.
  assert.equal(url, "https://www.bilibili.com/video/BV1ab411L78c?p=2&t=200");
});

test("buildNoteJumpUrl adds the youtube seek parameter as seconds-with-s", () => {
  const note = { id: "n1", sourceId: "src_yt", positionMs: 65000, text: "x" };
  const sources = [
    { id: "src_yt", url: "https://www.youtube.com/watch?v=abc123", platformId: "youtube" },
  ];
  assert.equal(buildNoteJumpUrl(note, sources), "https://www.youtube.com/watch?v=abc123&t=65s");
});

test("buildNoteJumpUrl returns null when there is no platform seek support (只展示时间戳)", () => {
  const note = { id: "n1", sourceId: "src_xe", positionMs: 65000, text: "x" };
  const sources = [
    {
      id: "src_xe",
      url: "https://shop.xiaoe-tech.com/v_abc",
      platformId: "xiaoe-tech",
    },
    { id: "src_none", url: "https://www.example.com/a", platformId: null },
  ];
  assert.equal(buildNoteJumpUrl(note, sources), null);
});

test("buildNoteJumpUrl returns null for a plain webpage note or an unknown source", () => {
  const sources = apiExampleById.get("api-resources-detail-with-notes").response.body.sources;
  assert.equal(buildNoteJumpUrl({ id: "n", sourceId: null, positionMs: 1000, text: "x" }, sources), null);
  assert.equal(buildNoteJumpUrl({ id: "n", sourceId: "src_missing", positionMs: 1000, text: "x" }, sources), null);
  assert.equal(buildNoteJumpUrl(null, sources), null);
});

test("buildNoteJumpUrl returns null for a source url it cannot parse", () => {
  const note = { id: "n1", sourceId: "src_broken", positionMs: 1000, text: "x" };
  const sources = [{ id: "src_broken", url: "::not a url::", platformId: "bilibili" }];
  assert.equal(buildNoteJumpUrl(note, sources), null);
});

test("presentDetail maps the notes through presentNote", () => {
  const detail = apiExampleById.get("api-resources-detail-with-notes").response.body;
  const presented = presentDetail(detail);
  assert.equal(presented.notes.length, 1);
  assert.deepEqual(presented.notes[0], presentNote(FIXTURE_NOTE));
});

test("backToList returns to the list view", async () => {
  const flow = flowWith();
  await flow.openDetail("res_01JABC0001");
  flow.backToList();
  assert.equal(flow.getState().view, "list");
  assert.equal(flow.getState().detail, null);
});

// --- retitle -----------------------------------------------------------------

test("retitle PATCHes the new title and updates the open detail", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });
  await flow.openDetail("res_01JABC0001");

  const result = await flow.retitle("res_01JABC0001", "  手动补的标题  ");

  assert.equal(result.ok, true);
  assert.deepEqual(api.calls.retitle, [{ id: "res_01JABC0001", title: "手动补的标题" }]);
  assert.equal(flow.getState().detail.resource.title, "手动补的标题");
  assert.match(flow.getState().notice, /标题已更新/);
  // The list is refreshed so returning shows the new title.
  assert.equal(api.calls.list, 1);
});

test("retitle rejects an empty title locally without calling the API", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });

  const result = await flow.retitle("res_01JABC0001", "   ");

  assert.equal(result.ok, false);
  assert.match(flow.getState().error, /标题不能为空/);
  assert.equal(api.calls.retitle.length, 0);
});

test("retitle presents the validation envelope verbatim", async () => {
  const api = fakeApi({
    retitleResult: {
      ok: false,
      status: 400,
      data: { error: { code: "validation_failed", message: "title 不能为空" } },
    },
  });
  const flow = flowWith({ api });

  const result = await flow.retitle("res_01JABC0001", "x");

  assert.equal(result.ok, false);
  assert.equal(flow.getState().error, "title 不能为空");
});

test("retitle accepts a server 404 for a cross-account or unknown resource", async () => {
  const api = fakeApi({
    retitleResult: {
      ok: false,
      status: 404,
      data: { error: { code: "not_found", message: "资源不存在或无权访问" } },
    },
  });
  const flow = flowWith({ api });

  const result = await flow.retitle("res_other_account", "新标题");

  assert.equal(result.ok, false);
  assert.equal(flow.getState().error, "资源不存在或无权访问");
});

// --- reset -------------------------------------------------------------------

test("reset clears the list, detail and messages for the next session", async () => {
  const flow = flowWith();
  await flow.collect({ url: "https://www.bilibili.com/video/BV1ab411L78c?p=2", title: "x" });
  await flow.openDetail("res_01JABC0001");

  flow.reset();

  const state = flow.getState();
  assert.deepEqual(state.resources, []);
  assert.equal(state.detail, null);
  assert.equal(state.view, "list");
  assert.equal(state.notice, null);
  assert.equal(state.error, null);
});
