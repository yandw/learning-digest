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

  assert.doesNotMatch(md, /金句/);
  assert.doesNotMatch(md, /待办/);
  assert.doesNotMatch(md, /核心要点/);
  assert.doesNotMatch(md, /主题归纳/);
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

// --- Schema v2 (0.1.38): overview card, topic bullets and category cards ----

// A full v2 artifact: every new field populated, five categories so the
// palette cycle wraps, one Topic with bullets and one with the v1 summary.
const V2_REPORT = {
  overview: ["结论一。", "结论二。", "结论三。"],
  topics: [
    {
      start: 0,
      end: 900,
      title: "课程导论",
      bullets: ["要点一", "要点二"],
      summary: "老师介绍了课程目标。",
    },
    { start: 900, end: 1800, title: "核心概念", summary: "讲解了三个核心概念及其关系。" },
  ],
  categories: [
    { title: "学习方法", points: ["先练习再核对", "错题要复盘"] },
    { title: "核心概念", points: ["概念甲", "概念乙"] },
    { title: "延伸方向", points: ["阅读清单"] },
    { title: "常见误区", points: ["误区一"] },
    { title: "第五类", points: ["另一个点"] },
  ],
  quotes: [{ start: 1234, text: "学习是一场旅程。" }],
  todos: ["完成课后练习"],
};

test("full HTML report renders the 核心要点 overview as one bullet card", () => {
  const html = renderer.renderReportHtml(V2_REPORT, META);

  assert.match(html, /<section class="report-overview">/);
  assert.match(html, /<h2 class="report-section-title">核心要点<\/h2>/);
  const overviewCard = html.match(/<ul class="overview-card">[\s\S]*?<\/ul>/)?.[0] || "";
  assert.equal((overviewCard.match(/<li>/g) || []).length, 3, "one bullet per conclusion");
  assert.match(overviewCard, /<li>结论二。<\/li>/);
});

test("full HTML report renders Topic bullets as a list and falls back to the summary", () => {
  const html = renderer.renderReportHtml(V2_REPORT, META);

  assert.match(html, /<ul class="topic-bullets">/);
  assert.match(html, /<li>要点一<\/li>/);
  assert.match(html, /<li>要点二<\/li>/);
  // The v1 summary stays the fallback for a Topic without bullets.
  assert.match(html, /<p class="topic-summary">讲解了三个核心概念及其关系。<\/p>/);
});

test("full HTML report renders category cards on a cycling flat palette", () => {
  const html = renderer.renderReportHtml(V2_REPORT, META);

  assert.match(html, /<section class="report-categories">/);
  assert.match(html, /<h2 class="report-section-title">主题归纳<\/h2>/);
  assert.match(html, /class="category-grid"/);
  const cards = html.match(/<div class="category-card cat-\d">/g) || [];
  assert.equal(cards.length, 5, "one card per category");
  // The palette cycles: the fifth card wraps back to the first color.
  assert.match(
    html,
    /<div class="category-card cat-0">\s*<div class="category-chip">第五类<\/div>/,
  );
  assert.match(html, /<div class="category-chip">学习方法<\/div>/);
  assert.match(html, /<li>错题要复盘<\/li>/);
  // The palette itself is defined as CSS custom properties.
  assert.match(html, /--cat-blue-bg/);
  assert.match(html, /--cat-amber-border/);
  assert.match(html, /--cat-purple-bg/);
});

test("full HTML report escapes overview and category content", () => {
  const html = renderer.renderReportHtml(
    {
      overview: ["要点 <b>加粗</b>"],
      topics: [{ start: 0, end: 60, title: "话题", bullets: ["要点 & <附注>"] }],
      categories: [{ title: "<主题>", points: ["点 & <注>"] }],
      quotes: [],
      todos: [],
    },
    META,
  );

  assert.doesNotMatch(html, /<b>加粗<\/b>/);
  assert.match(html, /要点 &lt;b&gt;加粗&lt;\/b&gt;/);
  assert.match(html, /要点 &amp; &lt;附注&gt;/);
  assert.doesNotMatch(html, /<主题>/);
  assert.match(html, /&lt;主题&gt;/);
  assert.match(html, /点 &amp; &lt;注&gt;/);
});

// The backward-compatibility acceptance criterion: an artifact persisted
// before schema v2 renders with every v1 section and none of the new ones.
// This is the pinned golden v1 case.
test("a v1 artifact without the new fields renders exactly the v1 structure", () => {
  const html = renderer.renderReportHtml(REPORT, META);

  assert.doesNotMatch(html, /<section class="report-overview">/);
  assert.doesNotMatch(html, /<section class="report-categories">/);
  assert.doesNotMatch(html, /<ul class="topic-bullets">/);
  assert.doesNotMatch(html, /class="category-card/);
  assert.match(html, /<span class="topic-time">\[0:00–15:00\]<\/span> 课程导论/);
  assert.match(html, /<p class="topic-summary">老师介绍了课程目标与学习方法。<\/p>/);
  assert.match(html, /<blockquote class="quote-item">/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /由 Learning Digest 生成/);
});

test("the compact fragment mirrors the overview card, bullets and category grid", () => {
  const fragment = renderer.renderReportCompact(V2_REPORT, META);

  assert.match(fragment, /<section class="report-overview">/);
  assert.match(fragment, /<ul class="overview-card">/);
  assert.match(fragment, /<li>结论一。<\/li>/);
  assert.match(fragment, /<ul class="topic-bullets">/);
  assert.match(fragment, /<section class="report-categories">/);
  assert.match(fragment, /<div class="category-grid">/);
  assert.match(fragment, /category-card cat-0/);
  assert.doesNotMatch(fragment, /<html/i);
  assert.doesNotMatch(fragment, /<style/i);
});

test("full HTML report and compact fragment end with the Learning Digest footer", () => {
  const footer = /<footer class="report-footer">由 Learning Digest 生成<\/footer>/;
  assert.match(renderer.renderReportHtml(REPORT, META), footer);
  assert.match(renderer.renderReportCompact(REPORT, META), footer);
});

test("the hero meta line carries the duration and the generated-at stamp", () => {
  const meta = { ...META, generatedAtMs: new Date(2026, 10, 8, 12, 31).getTime() };
  const html = renderer.renderReportHtml(REPORT, meta);

  assert.match(html, /2026年11月8日 10:05 – 12:30/);
  assert.match(html, /时长 2 小时 25 分/);
  assert.match(html, /生成于 2026年11月8日 12:31/);

  // Each part is omitted when the artifact does not know it.
  const withoutGeneratedAt = renderer.renderReportHtml(REPORT, {
    startedAtMs: STARTED_AT,
    endedAtMs: ENDED_AT,
  });
  assert.match(withoutGeneratedAt, /时长 2 小时 25 分/);
  assert.doesNotMatch(withoutGeneratedAt, /生成于/);
  const bare = renderer.renderReportHtml(REPORT, null);
  assert.doesNotMatch(bare, /时长/);
  assert.doesNotMatch(bare, /生成于/);
});

test("Markdown export gains 核心要点 and 主题归纳 sections", () => {
  const md = renderer.renderReportMarkdown(V2_REPORT, META);

  assert.match(md, /^## 核心要点$/m);
  assert.match(md, /^- 结论一。$/m);
  assert.match(md, /^- 结论三。$/m);
  assert.match(md, /^## 主题归纳$/m);
  assert.match(md, /^### 学习方法$/m);
  assert.match(md, /^- 先练习再核对$/m);
  assert.match(md, /^- 错题要复盘$/m);
  assert.match(md, /^### 延伸方向$/m);
});

test("Markdown export writes Topic bullets when present and the summary otherwise", () => {
  const md = renderer.renderReportMarkdown(V2_REPORT, META);

  assert.match(md, /^## \[0:00–15:00\] 课程导论$/m);
  assert.match(md, /^- 要点一$/m);
  assert.match(md, /^- 要点二$/m);
  assert.doesNotMatch(md, /^老师介绍了课程目标。$/m);
  assert.match(md, /^## \[15:00–30:00\] 核心概念$/m);
  assert.match(md, /^讲解了三个核心概念及其关系。$/m);
});
