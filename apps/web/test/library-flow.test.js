import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createLibraryFlow, presentListItem, presentDetail, presentNote, presentSession, presentTranscript, buildNoteJumpUrl, formatPosition, formatDateTime, progressLabel, presentSummary, presentSummariesList, presentUsage } from "../public/js/library.js";

// Pin the local timezone for the startedAt display tests below (set before
// any Date is constructed, so formatDateTime's local accessors are
// deterministic here: "…Z" instants render as their UTC clock reading).
process.env.TZ = "UTC";

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
// Round-2 contract fixtures: session lifecycle, TranscriptView shapes and
// the resource-detail sessions[] extension.
const sessionExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "session-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);
const DETAIL_WITH_SESSIONS = sessionExampleById.get("api-resource-detail-with-sessions").response.body;
// Round-3 contract fixtures: generation, the history list, the summary
// detail and the usage read (contract-r3.md §3.1-§3.4, ticket 3.3).
const summaryExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "summary-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);
const SUMMARY_LIST = summaryExampleById.get("api-summaries-list").response.body.summaries;
const SUMMARY_DETAIL = summaryExampleById.get("api-summary-detail").response.body.summary;
const USAGE = summaryExampleById.get("api-usage").response.body;

/** Fake api: script the next result of each resource method; record calls. */
function fakeApi({
  createResult,
  listResult,
  detailResult,
  detailResults,
  retitleResult,
  transcriptResult,
  transcriptResults,
  summariesListResult,
  summariesListResults,
  generateResult,
  generateResults,
  summaryDetailById,
  summaryDetailResult,
} = {}) {
  const calls = { create: [], list: 0, detail: [], retitle: [], transcript: [], summariesList: [], generate: [], summaryDetail: [] };
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
      if (detailResults && detailResults.length > 0) {
        return detailResults.shift();
      }
      return detailResult || { ok: true, status: 200, data: apiExampleById.get("api-resources-detail-with-notes").response.body };
    },
    async updateResourceTitle(id, title) {
      calls.retitle.push({ id, title });
      return retitleResult || { ok: true, status: 200, data: { resource: { id, title, kind: "webpage", createdAt: "2026-11-10T08:05:00Z" } } };
    },
    // Round-2 second pull (contract-r2 §3.5): one call per session block.
    async getSessionTranscript(sessionId) {
      calls.transcript.push(sessionId);
      if (transcriptResults && transcriptResults[sessionId]) {
        return transcriptResults[sessionId];
      }
      return transcriptResult || { ok: true, status: 200, data: sessionExampleById.get("api-session-transcript-asr-finished").response.body };
    },
    // Round-3 summary endpoints (contract-r3 §3.1-§3.3). The default list is
    // empty — most details never generated; generate/getSummary results are
    // scripted per test (or queued with the *Results arrays for sequences).
    async listSummaries(resourceId) {
      calls.summariesList.push(resourceId);
      if (summariesListResults && summariesListResults.length > 0) {
        return summariesListResults.shift();
      }
      return summariesListResult || { ok: true, status: 200, data: { summaries: [] } };
    },
    async generateSummary(resourceId) {
      calls.generate.push(resourceId);
      if (generateResults && generateResults.length > 0) {
        return generateResults.shift();
      }
      return generateResult || { ok: true, status: 201, data: summaryExampleById.get("api-summary-generate-bilibili").response.body };
    },
    async getSummary(summaryId) {
      calls.summaryDetail.push(summaryId);
      if (summaryDetailById && summaryDetailById[summaryId]) {
        return summaryDetailById[summaryId];
      }
      return summaryDetailResult || { ok: true, status: 200, data: summaryExampleById.get("api-summary-detail").response.body };
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

// --- session transcript blocks (round 2, issue #71) ----------------------------

test("formatDateTime renders the ISO instant as local YYYY-MM-DD HH:mm", () => {
  // TZ is pinned to UTC at the top of this file, so the expectations are
  // the UTC clock readings of the contract's ISO 8601 timestamps.
  assert.equal(formatDateTime("2026-11-10T10:00:00Z"), "2026-11-10 10:00");
  assert.equal(formatDateTime("2026-11-10T09:45:00Z"), "2026-11-10 09:45");
  assert.equal(formatDateTime(null), null);
  assert.equal(formatDateTime("not-a-date"), null);
});

test("presentSession maps one session block header: time, status, origin badge, summary", () => {
  const [activeAsr, finishedAsr, finishedCaptions] = DETAIL_WITH_SESSIONS.sessions;

  const active = presentSession(activeAsr);
  assert.equal(active.id, "ses_01JABC0033");
  assert.equal(active.startedAtText, "2026-11-10 10:00");
  assert.equal(active.statusLabel, "进行中");
  assert.equal(active.originLabel, "语音转写");
  assert.equal(active.summaryText, "2 段文本 · 1 段转写失败");

  const finished = presentSession(finishedAsr);
  assert.equal(finished.statusLabel, "已结束");
  assert.equal(finished.originLabel, "语音转写");
  assert.equal(finished.summaryText, "1 段文本 · 1 处已跳过 · 1 段转写失败");

  const captions = presentSession(finishedCaptions);
  assert.equal(captions.originLabel, "字幕");
  assert.equal(captions.summaryText, "2 段文本 · 1 处已跳过");
});

test("presentSession shows no origin badge and a no-transcript line for origin null", () => {
  const presented = presentSession({
    id: "ses_none",
    sourceId: "src_01JABC0002",
    status: "finished",
    startedAt: "2026-11-10T08:00:00Z",
    origin: null,
    transcript: { recordCount: 0, gapCount: 0, failedCount: 0 },
  });
  assert.equal(presented.originLabel, null, "nothing archived yet -> no badge");
  assert.equal(presented.summaryText, "本次学习未产生逐字稿");
});

test("presentTranscript merges records, gaps and failed into one startMs-ordered timeline", () => {
  const view = sessionExampleById.get("api-session-transcript-asr-finished").response.body;
  const entries = presentTranscript(view, DETAIL_WITH_SESSIONS.sources);

  assert.deepEqual(entries.map((e) => e.kind), ["record", "gap", "failed"]);
  assert.deepEqual(entries.map((e) => e.startMs), [60000, 150000, 210000]);

  const [record, gap, failed] = entries;
  assert.equal(record.stamp, "1:00");
  assert.equal(record.text, "上一节我们留了一个问题：为什么要缩放点积");
  assert.equal(record.jumpUrl, "https://www.bilibili.com/video/BV1ab411L78c?p=2&t=60", "reuses the note seek builder (bilibili t=)");
  assert.equal(gap.stamp, "2:30–3:30");
  assert.equal(gap.text, "已跳过");
  assert.equal(gap.jumpUrl, null, "a skipped range has nothing to jump to");
  assert.equal(failed.stamp, "3:30–4:00");
  assert.equal(failed.text, "转写失败");
  assert.equal(failed.detail, "Speech Provider 返回 400：音频解码失败", "the contract error message presents verbatim");
});

test("presentTranscript interleaves an active session's pending and failed with its records", () => {
  const view = sessionExampleById.get("api-session-transcript-asr-active").response.body;
  const entries = presentTranscript(view, DETAIL_WITH_SESSIONS.sources);

  assert.deepEqual(entries.map((e) => e.kind), ["record", "record", "failed", "pending"]);
  const pending = entries[3];
  assert.equal(pending.stamp, "1:30–2:00");
  assert.equal(pending.text, "转写中");
  assert.equal(pending.jumpUrl, null);
});

test("presentTranscript marks a finished session's leftover pending as queued, not transcribing", () => {
  // D15 evolution (round-2 review): finished 后 pending 随尾段 drain 渐进
  // 清空,worker 停机且无租约时可滞留——视图标注排队而非终态
  // (contract-r2 §2.5/§3.5)。
  const view = {
    sessionId: "ses_01JABC0033",
    sourceId: "src_01JABC0002",
    resourceId: "res_01JABC0009",
    sessionStatus: "finished",
    origin: "asr",
    records: [],
    gaps: [],
    pending: [{ segmentIndex: 3, startMs: 90000, endMs: 120000, status: "pending" }],
    failed: [],
  };
  const entries = presentTranscript(view, DETAIL_WITH_SESSIONS.sources);

  assert.deepEqual(entries.map((e) => e.kind), ["pending"]);
  assert.equal(entries[0].text, "转写排队中（会话已结束）");
  assert.equal(entries[0].stamp, "1:30–2:00");
});

test("presentTranscript gives caption records no jump URL on platforms without seek support", () => {
  const view = sessionExampleById.get("api-session-transcript-captions-finished").response.body;
  const xiaoeSources = [
    { id: view.sourceId, url: "https://shop.xiaoe-tech.com/v_abc", platformId: "xiaoe-tech" },
  ];
  const entries = presentTranscript(view, xiaoeSources);

  assert.deepEqual(entries.map((e) => e.kind), ["record", "record", "gap"]);
  assert.equal(entries[0].stamp, "2:18");
  assert.equal(entries[0].jumpUrl, null, "小鹅通 has no documented seek parameter -> 展示时间戳，不回跳");
  assert.equal(entries[2].stamp, "5:00–6:00");
  assert.equal(entries[2].text, "已跳过");
});

test("presentTranscript degrades to no stamp for an unusable startMs instead of throwing", () => {
  const entries = presentTranscript(
    {
      sessionId: "s",
      sourceId: null,
      resourceId: "r",
      sessionStatus: "finished",
      origin: "captions",
      records: [{ startMs: -5, endMs: 10, text: "x", origin: "captions" }],
      gaps: [],
      pending: [],
      failed: [],
    },
    [],
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stamp, null);
  assert.equal(entries[0].text, "x");
});

test("presentTranscript returns an empty timeline for a missing view", () => {
  assert.deepEqual(presentTranscript(null, []), []);
});

// --- transcript second pull (round 2 flow, issue #71) ---------------------------

test("openDetail second-pulls each session's transcript view (contract-r2 §3.6)", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    transcriptResults: {
      ses_01JABC0033: { ok: true, status: 200, data: sessionExampleById.get("api-session-transcript-asr-active").response.body },
      ses_01JABC0032: { ok: true, status: 200, data: sessionExampleById.get("api-session-transcript-asr-finished").response.body },
      ses_01JABC0031: { ok: true, status: 200, data: sessionExampleById.get("api-session-transcript-captions-finished").response.body },
    },
  });
  const flow = flowWith({ api });

  await flow.openDetail("res_01JABC0001");

  // One §3.5 read per session block, in the detail's newest-first order.
  assert.deepEqual(api.calls.transcript, ["ses_01JABC0033", "ses_01JABC0032", "ses_01JABC0031"]);
  const transcripts = flow.getState().detail.transcripts;
  assert.equal(transcripts["ses_01JABC0032"].origin, "asr");
  assert.equal(transcripts["ses_01JABC0032"].gaps.length, 1);
  assert.equal(transcripts["ses_01JABC0033"].pending.length, 1, "an active session keeps its pending segments");
  assert.equal(transcripts["ses_01JABC0031"].origin, "captions");
});

test("a failed transcript second-pull leaves that block null without failing the detail", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    transcriptResults: {
      ses_01JABC0032: { ok: false, status: 404, data: { error: { code: "not_found", message: "学习记录不存在或无权访问" } } },
    },
  });
  const flow = flowWith({ api });

  await flow.openDetail("res_01JABC0001");

  assert.equal(flow.getState().view, "detail");
  const transcripts = flow.getState().detail.transcripts;
  assert.equal(transcripts["ses_01JABC0032"], null);
  assert.ok(transcripts["ses_01JABC0033"], "the other blocks still load");
});

test("openDetail without sessions makes no transcript calls", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });

  await flow.openDetail("res_01JABC0001");

  assert.equal(api.calls.transcript.length, 0, "round-1 details carry no sessions key");
  assert.deepEqual(flow.getState().detail.transcripts, {});
});

// --- course summary presentation (round 3, ticket 3.3, contract-r3) -----------

test("presentSummary maps the summary detail to rendered blocks and meta", () => {
  const presented = presentSummary(SUMMARY_DETAIL, DETAIL_WITH_SESSIONS.sessions, DETAIL_WITH_SESSIONS.sources);

  assert.equal(presented.id, "sum_01JABC0052");
  // The body renders through the safe markdown view models: block kinds only,
  // no HTML string anywhere.
  assert.deepEqual(presented.blocks.map((b) => b.kind), ["h1", "h2", "ul", "h2", "ul", "h2", "ul"]);
  assert.equal(presented.blocks[0].runs[0].text, "注意力机制详解 P2：自注意力 · 课程总结");
  assert.equal(presented.generatedAtText, "2026-11-10 12:30");
  assert.equal(presented.citationCount, 4);
});

test("presentSummary maps citations with quote, stamp, jump URL and session attribution", () => {
  // After the catch-up the detail's sessions[] includes ses_34 (the fixture
  // story's fourth session, same bilibili source).
  const sessions = [
    ...DETAIL_WITH_SESSIONS.sessions,
    { id: "ses_01JABC0034", sourceId: "src_01JABC0002", status: "finished", startedAt: "2026-11-10T12:00:00Z", origin: "asr", transcript: { recordCount: 1, gapCount: 0, failedCount: 0 } },
  ];
  const presented = presentSummary(SUMMARY_DETAIL, sessions, DETAIL_WITH_SESSIONS.sources);

  const first = presented.citations[0];
  assert.equal(first.quote, "注意力分数的计算，就是把查询向量和键向量做点积");
  assert.equal(first.stamp, "0:30–1:00", "the segmentRef range on the source timeline");
  assert.equal(first.jumpUrl, "https://www.bilibili.com/video/BV1ab411L78c?p=2&t=30", "reuses the note seek builder through the session's source");
  assert.equal(first.sessionStartedAtText, "2026-11-10 10:00");
  assert.equal(first.sessionOriginLabel, "语音转写");

  // The catch-up citation (ses_34) rides the same source mapping.
  const catchUp = presented.citations.find((c) => c.quote === "最后我们补一段：注意力机制在长序列下的处理思路");
  assert.ok(catchUp, "the fixture's catch-up citation is present");
  assert.equal(catchUp.jumpUrl, "https://www.bilibili.com/video/BV1ab411L78c?p=2&t=120");
});

test("presentSummary degrades a citation whose session is not among the detail's sessions", () => {
  const summary = {
    ...SUMMARY_DETAIL,
    citations: SUMMARY_DETAIL.citations.map((c) => ({ ...c, segmentRef: { ...c.segmentRef, sessionId: "ses_missing" } })),
  };
  const presented = presentSummary(summary, DETAIL_WITH_SESSIONS.sessions, DETAIL_WITH_SESSIONS.sources);

  assert.equal(presented.citations.length, 4);
  for (const citation of presented.citations) {
    assert.equal(citation.jumpUrl, null, "no source mapping -> no jump, stamp only");
    assert.equal(citation.sessionStartedAtText, null);
    assert.equal(citation.sessionOriginLabel, null);
  }
});

test("presentSummary gives no jump URL on platforms without seek support", () => {
  const sessions = [{ id: "ses_xe", sourceId: "src_xe", status: "finished", startedAt: "2026-11-10T08:00:00Z", origin: "captions", transcript: { recordCount: 1, gapCount: 0, failedCount: 0 } }];
  const sources = [{ id: "src_xe", url: "https://shop.xiaoe-tech.com/v_abc", platformId: "xiaoe-tech" }];
  const summary = { ...SUMMARY_DETAIL, citations: [{ quote: "小鹅通的引用", segmentRef: { sessionId: "ses_xe", startMs: 65000, endMs: 90000 } }] };

  const presented = presentSummary(summary, sessions, sources);
  assert.equal(presented.citations[0].stamp, "1:05–1:30");
  assert.equal(presented.citations[0].jumpUrl, null, "小鹅通 has no documented seek parameter -> 展示时间戳，不回跳");
  assert.equal(presented.citations[0].sessionStartedAtText, "2026-11-10 08:00");
  assert.equal(presented.citations[0].sessionOriginLabel, "字幕");
});

test("presentSummary handles a summary with no citations and degrades on null", () => {
  const empty = { ...SUMMARY_DETAIL, citations: [] };
  const presented = presentSummary(empty, DETAIL_WITH_SESSIONS.sessions, DETAIL_WITH_SESSIONS.sources);
  assert.deepEqual(presented.citations, []);
  assert.equal(presented.citationCount, 0);

  assert.equal(presentSummary(null, [], []), null);
});

// --- history list presentation (contract-r3 §3.2: 历次倒序可回查) ---------------

test("presentSummariesList numbers generations newest-first with time and citationCount", () => {
  // The import line already carries presentSummariesList; the fixture list
  // is the contract's two-generation story (newest first).
  const presented = presentSummariesList(SUMMARY_LIST);
  assert.deepEqual(
    presented.map((item) => [item.id, item.ordinal, item.generatedAtText, item.citationCount]),
    [
      ["sum_01JABC0052", 2, "2026-11-10 12:30", 4],
      ["sum_01JABC0051", 1, "2026-11-10 10:20", 3],
    ],
  );
});

test("presentSummariesList handles an empty history and tolerates junk input", () => {
  assert.deepEqual(presentSummariesList([]), []);
  assert.deepEqual(presentSummariesList(null), []);
});

// --- usage presentation (round 3, contract-r3 §2.4/§3.4, D18 只记录不计费) -------

test("presentUsage renders the account usage line on the contract fixture's口径", () => {
  const presented = presentUsage(USAGE);
  // audioSeconds 120 -> the same mm:ss rendering as everywhere else on the
  // page; no price, no billing wording (D18).
  assert.match(presented.text, /转写 2:00/);
  assert.match(presented.text, /总结 2 次/);
  assert.match(presented.text, /输入 4140 字符/);
  assert.match(presented.text, /更新于 2026-11-10 12:30/);
  assert.doesNotMatch(presented.text, /价|费用|配额/);
});

test("presentUsage reports 从未产生用量 when updatedAt is null", () => {
  assert.equal(
    presentUsage({ audioSeconds: 0, summaryCount: 0, summaryInputChars: 0, updatedAt: null }).text,
    "从未产生用量",
  );
  assert.equal(presentUsage(null).text, "从未产生用量");
  assert.equal(presentUsage(undefined).text, "从未产生用量");
});

test("presentUsage renders hours-long totals and zero readings without crashing", () => {
  const presented = presentUsage({ audioSeconds: 3661, summaryCount: 0, summaryInputChars: 0, updatedAt: "2026-11-10T08:00:00Z" });
  assert.match(presented.text, /转写 1:01:01/);
  assert.match(presented.text, /总结 0 次/);
  assert.match(presented.text, /输入 0 字符/);
});

// --- summaries flow state machine (round 3, ticket 3.3) -------------------------
// The generation is synchronous and can take tens of seconds — the flow
// keeps an explicit generating state (button disabled + 进行时文案 on the page,
// no fake timeout), debounces re-entry, and refreshes the history + focuses
// the new generation on 201. Errors present the contract envelope verbatim.

test("openDetail also loads the summaries history and focuses the newest generation", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    summariesListResult: { ok: true, status: 200, data: { summaries: SUMMARY_LIST } },
    summaryDetailById: {
      sum_01JABC0052: { ok: true, status: 200, data: { summary: SUMMARY_DETAIL } },
    },
  });
  const flow = flowWith({ api });

  await flow.openDetail("res_01JABC0001");

  assert.deepEqual(api.calls.summariesList, ["res_01JABC0001"]);
  assert.deepEqual(api.calls.summaryDetail, ["sum_01JABC0052"], "only the newest summary's full form is pulled; older ones load on switch");
  const state = flow.getState();
  assert.equal(state.summaries.length, 2);
  assert.equal(state.activeSummaryId, "sum_01JABC0052");
  assert.equal(state.summaryDetails["sum_01JABC0052"].id, "sum_01JABC0052");
  assert.equal(state.summariesError, null);
  assert.equal(state.generating, false);
});

test("openDetail with an empty summaries history pulls no summary detail", async () => {
  const api = fakeApi({ detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS } });
  const flow = flowWith({ api });

  await flow.openDetail("res_01JABC0001");

  assert.deepEqual(flow.getState().summaries, []);
  assert.equal(flow.getState().activeSummaryId, null);
  assert.deepEqual(api.calls.summaryDetail, []);
});

test("a failed summaries list read shows the envelope without failing the detail", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    summariesListResult: { ok: false, status: 500, data: { error: { code: "internal_error", message: "服务器开小差了" } } },
  });
  const flow = flowWith({ api });

  await flow.openDetail("res_01JABC0001");

  assert.equal(flow.getState().view, "detail");
  assert.equal(flow.getState().summariesError, "服务器开小差了");
});

test("generateSummary POSTs once, refreshes the history and focuses the new generation", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    summariesListResults: [
      { ok: true, status: 200, data: { summaries: [SUMMARY_LIST[1]] } },
      { ok: true, status: 200, data: { summaries: SUMMARY_LIST } },
    ],
    summaryDetailById: {
      sum_01JABC0051: { ok: true, status: 200, data: { summary: summaryExampleById.get("api-summary-generate-bilibili").response.body.summary } },
      sum_01JABC0052: { ok: true, status: 200, data: { summary: SUMMARY_DETAIL } },
    },
    generateResult: { ok: true, status: 201, data: summaryExampleById.get("api-summary-generate-after-catch-up").response.body },
  });
  const flow = flowWith({ api });
  await flow.openDetail("res_01JABC0001");
  assert.equal(flow.getState().activeSummaryId, "sum_01JABC0051");

  const result = await flow.generateSummary();

  assert.equal(result.ok, true);
  assert.deepEqual(api.calls.generate, ["res_01JABC0001"]);
  assert.equal(api.calls.summariesList.length, 2, "the history is refreshed after 201");
  const state = flow.getState();
  assert.equal(state.activeSummaryId, "sum_01JABC0052", "the new generation is on display");
  assert.equal(api.calls.summaryDetail[api.calls.summaryDetail.length - 1], "sum_01JABC0052");
  assert.equal(state.generating, false);
  assert.equal(state.summariesError, null);
});

test("generateSummary ignores a second click while a generation is in flight", async () => {
  let releaseGenerate;
  const pendingGenerate = new Promise((resolve) => { releaseGenerate = resolve; });
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    generateResults: [pendingGenerate],
  });
  const flow = flowWith({ api });
  await flow.openDetail("res_01JABC0001");

  const first = flow.generateSummary();
  assert.equal(flow.getState().generating, true, "the generating state is observable mid-flight");

  const second = await flow.generateSummary();
  assert.equal(second.ok, false);
  assert.deepEqual(api.calls.generate, ["res_01JABC0001"], "the re-entry never reached the API");

  releaseGenerate({ ok: true, status: 201, data: summaryExampleById.get("api-summary-generate-bilibili").response.body });
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(flow.getState().generating, false);
});

test("generateSummary presents the 409 no_transcript_to_summarize envelope verbatim", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    generateResult: {
      ok: false,
      status: 409,
      data: { error: { code: "no_transcript_to_summarize", message: "这门资料还没有可总结的逐字稿，先学习并归档后再生成" } },
    },
  });
  const flow = flowWith({ api });
  await flow.openDetail("res_01JABC0001");

  const result = await flow.generateSummary();

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(flow.getState().summariesError, "这门资料还没有可总结的逐字稿，先学习并归档后再生成");
  assert.equal(flow.getState().generating, false);
  assert.equal(api.calls.summariesList.length, 1, "a failed generation does not refresh the history");
});

test("generateSummary presents the 502 summary_generation_failed envelope verbatim", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    generateResult: {
      ok: false,
      status: 502,
      data: { error: { code: "summary_generation_failed", message: "总结生成失败，请稍后重试；本次尝试不产生总结记录" } },
    },
  });
  const flow = flowWith({ api });
  await flow.openDetail("res_01JABC0001");

  const result = await flow.generateSummary();

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(flow.getState().summariesError, "总结生成失败，请稍后重试；本次尝试不产生总结记录");
});

test("showSummary switches the focused generation and reuses cached details", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    summariesListResult: { ok: true, status: 200, data: { summaries: SUMMARY_LIST } },
    summaryDetailById: {
      sum_01JABC0052: { ok: true, status: 200, data: { summary: SUMMARY_DETAIL } },
      sum_01JABC0051: { ok: true, status: 200, data: { summary: summaryExampleById.get("api-summary-generate-bilibili").response.body.summary } },
    },
  });
  const flow = flowWith({ api });
  await flow.openDetail("res_01JABC0001");

  await flow.showSummary("sum_01JABC0051");

  assert.equal(flow.getState().activeSummaryId, "sum_01JABC0051");
  assert.deepEqual(api.calls.summaryDetail, ["sum_01JABC0052", "sum_01JABC0051"], "the older generation's full form is pulled on first switch");
  assert.equal(flow.getState().summaryDetails["sum_01JABC0051"].id, "sum_01JABC0051");

  await flow.showSummary("sum_01JABC0052");

  assert.equal(flow.getState().activeSummaryId, "sum_01JABC0052");
  assert.equal(api.calls.summaryDetail.length, 2, "switching back reuses the cache");
});

test("a failed summary detail pull marks that entry null without breaking the flow", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    summariesListResult: { ok: true, status: 200, data: { summaries: SUMMARY_LIST } },
    summaryDetailById: {
      sum_01JABC0052: { ok: false, status: 404, data: { error: { code: "not_found", message: "总结不存在或无权访问" } } },
    },
  });
  const flow = flowWith({ api });

  await flow.openDetail("res_01JABC0001");

  assert.equal(flow.getState().view, "detail");
  assert.equal(flow.getState().summaryDetails["sum_01JABC0052"], null);
});

test("a generation landing after navigating away does not touch the other resource's view", async () => {
  let releaseGenerate;
  const pendingGenerate = new Promise((resolve) => { releaseGenerate = resolve; });
  const api = fakeApi({
    detailResults: [
      { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
      // A different resource (the plain webpage from the list fixture): no
      // sessions, no summaries.
      { ok: true, status: 200, data: { resource: apiExampleById.get("api-resources-list").response.body.resources[0].resource, sources: apiExampleById.get("api-resources-list").response.body.resources[0].sources, notes: [] } },
    ],
    generateResults: [pendingGenerate],
  });
  const flow = flowWith({ api });
  await flow.openDetail("res_01JABC0001");

  const pending = flow.generateSummary();
  // The user backs out and opens another resource while the POST is in flight.
  flow.backToList();
  await flow.openDetail("res_01JABC0010");

  releaseGenerate({ ok: true, status: 201, data: summaryExampleById.get("api-summary-generate-bilibili").response.body });
  const result = await pending;

  assert.equal(result.ok, true);
  assert.deepEqual(api.calls.summariesList, ["res_01JABC0001", "res_01JABC0010"], "the late history refresh never happens for the old resource");
  assert.deepEqual(flow.getState().summaries, [], "the open resource's view stays its own");
  assert.equal(flow.getState().activeSummaryId, null);
  assert.equal(flow.getState().generating, false);
});

test("reset clears the summaries state for the next session", async () => {
  const api = fakeApi({
    detailResult: { ok: true, status: 200, data: DETAIL_WITH_SESSIONS },
    summariesListResult: { ok: true, status: 200, data: { summaries: SUMMARY_LIST } },
    summaryDetailById: { sum_01JABC0052: { ok: true, status: 200, data: { summary: SUMMARY_DETAIL } } },
  });
  const flow = flowWith({ api });
  await flow.openDetail("res_01JABC0001");

  flow.reset();

  const state = flow.getState();
  assert.deepEqual(state.summaries, []);
  assert.equal(state.activeSummaryId, null);
  assert.deepEqual(state.summaryDetails, {});
  assert.equal(state.summariesError, null);
  assert.equal(state.generating, false);
});
