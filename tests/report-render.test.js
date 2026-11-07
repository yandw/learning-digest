/**
 * The pure report renderers (#30): string-in/string-out HTML (full document
 * and compact panel fragment) and Markdown, built from the persisted
 * `report_<sessionId>` artifact shape (#29). Tests assert on document
 * structure, not styling internals.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const renderer = require("../report-render.js");

// The same shape session-summary.js parseGlobalPass produces and
// produceSessionReport persists.
const REPORT = {
  topics: [
    { start: 0, end: 900, title: "课程导论", summary: "老师介绍了课程目标与学习方法。" },
    { start: 900, end: 1800, title: "核心概念", summary: "讲解了三个核心概念及其关系。" },
  ],
  quotes: [{ start: 1234, text: "学习是一场旅程。" }],
  todos: ["完成课后练习", "预习下一章"],
};

// Local-time construction keeps the formatted meta line deterministic.
const STARTED_AT = new Date(2026, 10, 8, 10, 5).getTime();
const ENDED_AT = new Date(2026, 10, 8, 12, 30).getTime();
const META = {
  title: "第十四讲：机器学习入门",
  startedAtMs: STARTED_AT,
  endedAtMs: ENDED_AT,
  kind: "replay",
  platformId: "xiaoe-tech",
};

// --- Full HTML document ------------------------------------------------------

test("full HTML report has a styled header with title and meta line", () => {
  const html = renderer.renderReportHtml(REPORT, META);

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<style>/, "the document carries its own stylesheet");
  assert.match(html, /第十四讲：机器学习入门/);
  // Meta line: kind label, platform and the local date range.
  assert.match(html, /回放/);
  assert.match(html, /xiaoe-tech/);
  assert.match(html, /2026年11月8日 10:05 – 12:30/);
});

test("full HTML report renders one section per Topic with time range and step bar", () => {
  const html = renderer.renderReportHtml(REPORT, META);

  const sections = html.match(/<section class="report-topic"/g) || [];
  assert.equal(sections.length, 2, "one section per Topic");
  assert.match(html, /<span class="topic-time">\[0:00–15:00\]<\/span> 课程导论/);
  assert.match(html, /老师介绍了课程目标与学习方法。/);
  assert.match(html, /<span class="topic-time">\[15:00–30:00\]<\/span> 核心概念/);
  // The topic list reads as a timeline via CSS step-bar markup.
  assert.match(html, /class="topic-step"/);
  assert.match(html, /topic-step-dot/);
});

test("full HTML report renders timestamped quotes and a todo checklist", () => {
  const html = renderer.renderReportHtml(REPORT, META);

  assert.match(html, /<section class="report-quotes">/);
  assert.match(html, /<blockquote class="quote-item">/);
  assert.match(html, /\[20:34\]/);
  assert.match(html, /学习是一场旅程。/);
  assert.match(html, /<section class="report-todos">/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /完成课后练习/);
  assert.match(html, /预习下一章/);
});

test("full HTML report is self-contained: no inline script, no images, no external assets", () => {
  const html = renderer.renderReportHtml(REPORT, META);

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, "no inline event handlers");
});

test("full HTML report escapes report content", () => {
  const html = renderer.renderReportHtml(
    {
      topics: [{ start: 0, end: 60, title: "<标题>", summary: "正文 & <附注>" }],
      quotes: [{ start: 0, text: '"引号"与<tag>' }],
      todos: ["待办 <b>加粗</b>"],
    },
    META,
  );

  assert.doesNotMatch(html, /<标题>/);
  assert.doesNotMatch(html, /<tag>/);
  assert.match(html, /&lt;标题&gt;/);
  assert.match(html, /正文 &amp; &lt;附注&gt;/);
  assert.doesNotMatch(html, /<b>加粗<\/b>/);
});

test("full HTML report omits empty sections and still renders for a bare report", () => {
  const html = renderer.renderReportHtml({ topics: [], quotes: [], todos: [] }, META);

  assert.doesNotMatch(html, /<section class="report-quotes">/);
  assert.doesNotMatch(html, /<section class="report-todos">/);
  assert.match(
    html,
    /<header class="report-header">/,
    "the header survives an empty report",
  );
});

test("full HTML report falls back to a default title and omits absent meta fields", () => {
  const html = renderer.renderReportHtml(REPORT, null);

  assert.match(html, /学习纪要/, "the fallback document title");
  assert.doesNotMatch(html, /回放/, "no kind label without meta");
  assert.doesNotMatch(html, /2026年/, "no date without meta");
  // A meta without title keeps the fallback; one with a title uses it.
  const titled = renderer.renderReportHtml(REPORT, { startedAtMs: STARTED_AT });
  assert.match(titled, /学习纪要/);
});

test("full HTML report formats hour-plus timestamps as h:mm:ss", () => {
  const html = renderer.renderReportHtml(
    {
      topics: [{ start: 0, end: 5400, title: "长话题", summary: "跨越一小时。" }],
      quotes: [{ start: 3661, text: "一小时后的话。" }],
      todos: [],
    },
    META,
  );

  assert.match(html, /\[0:00–90:00\]/);
  assert.match(html, /\[61:01\]/);
});

// --- Markdown export ---------------------------------------------------------

test("Markdown export uses topic headings with time ranges and checklist todos", () => {
  const md = renderer.renderReportMarkdown(REPORT, META);

  assert.match(md, /^# 第十四讲：机器学习入门$/m);
  assert.match(md, /^## \[0:00–15:00\] 课程导论$/m);
  assert.match(md, /^老师介绍了课程目标与学习方法。$/m);
  assert.match(md, /^## \[15:00–30:00\] 核心概念$/m);
  assert.match(md, /^> \[20:34\] 学习是一场旅程。$/m);
  assert.match(md, /^- \[ \] 完成课后练习$/m);
  assert.match(md, /^- \[ \] 预习下一章$/m);
});

test("Markdown export writes meta as plain lines and tolerates missing meta", () => {
  const md = renderer.renderReportMarkdown(REPORT, META);
  assert.match(md, /^- 回放$/m);
  assert.match(md, /^- 2026年11月8日 10:05 – 12:30$/m);
  assert.match(md, /^- xiaoe-tech$/m);

  const bare = renderer.renderReportMarkdown(REPORT, null);
  assert.match(bare, /^# 学习纪要$/m);
  assert.doesNotMatch(bare, /^- 回放$/m);
});

test("Markdown export omits empty sections", () => {
  const md = renderer.renderReportMarkdown(
    { topics: [{ start: 0, end: 60, title: "唯一话题", summary: "只有话题。" }], quotes: [], todos: [] },
    META,
  );

  assert.doesNotMatch(md, /关键原话/);
  assert.doesNotMatch(md, /行动项/);
  assert.match(md, /^## \[0:00–1:00\] 唯一话题$/m);
});

// --- Compact panel fragment --------------------------------------------------

test("compact fragment keeps the report structure without document boilerplate", () => {
  const fragment = renderer.renderReportCompact(REPORT, META);

  assert.doesNotMatch(fragment, /<html/i);
  assert.doesNotMatch(fragment, /<style/i);
  assert.doesNotMatch(fragment, /<!doctype/i);
  assert.match(fragment, /^<div class="report-compact">/);
  assert.match(fragment, /第十四讲：机器学习入门/);
  assert.match(fragment, /2026年11月8日 10:05 – 12:30/);
  assert.match(fragment, /<section class="report-topic"/);
  assert.match(fragment, /<span class="topic-time">\[0:00–15:00\]<\/span> 课程导论/);
  assert.match(fragment, /class="topic-step"/);
  assert.match(fragment, /<blockquote class="quote-item">/);
  assert.match(fragment, /type="checkbox"/);
  assert.doesNotMatch(fragment, /<script/i);
});

test("compact fragment renders gracefully without meta or content", () => {
  const bare = renderer.renderReportCompact({ topics: [], quotes: [], todos: [] }, null);

  assert.match(bare, /^<div class="report-compact">/);
  assert.match(bare, /学习纪要/);
  assert.doesNotMatch(bare, /2026年/);
});

// The captured page title (#32) leads the header in every renderer; when the
// bridge stayed silent the default title keeps the same prominent position.

test("the captured course title is the leading header line in all three renderers", () => {
  const html = renderer.renderReportHtml(REPORT, META);
  assert.match(html, /<title>第十四讲：机器学习入门<\/title>/);
  assert.match(html, /<h1 class="report-title">第十四讲：机器学习入门<\/h1>/);
  assert.match(renderer.renderReportMarkdown(REPORT, META), /^# 第十四讲：机器学习入门$/m);
  assert.match(
    renderer.renderReportCompact(REPORT, META),
    /<h2 class="report-title">第十四讲：机器学习入门<\/h2>/,
  );

  const untitled = { startedAtMs: STARTED_AT, endedAtMs: ENDED_AT, kind: "replay", platformId: "xiaoe-tech" };
  const bareHtml = renderer.renderReportHtml(REPORT, untitled);
  assert.match(bareHtml, /<h1 class="report-title">学习纪要<\/h1>/);
  assert.doesNotMatch(bareHtml, /第十四讲/);
});

// --- Shared storage-key prefix ----------------------------------------------

// The persisted artifact key `report_<sessionId>` is built in three contexts
// (background persistence, panel lookup, report page). They all read the one
// constant from this module, so the on-disk format stays byte-identical.
test("the module exports the report storage-key prefix the artifact is persisted under", () => {
  assert.equal(renderer.REPORT_STORAGE_KEY_PREFIX, "report_");
  // The keys the report-page and panel tests seed storage with are exactly
  // prefix + sessionId.
  assert.equal(`${renderer.REPORT_STORAGE_KEY_PREFIX}s_abc123`, "report_s_abc123");
});
