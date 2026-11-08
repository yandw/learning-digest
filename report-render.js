/**
 * Report renderers (#30): pure string-in/string-out views over the persisted
 * report artifact (#29). Three consumers share one data source:
 *
 * - renderReportHtml    full styled document for the browser-tab report page
 * - renderReportMarkdown Markdown export for archiving/sharing
 * - renderReportCompact  HTML fragment for the narrow side panel 纪要 tab
 *
 * The artifact shape is the global pass schema: v1 {topics (+summary),
 * quotes, todos} plus the optional v2 fields (0.1.38) — overview
 * conclusions, per-Topic bullets and thematic categories. Renderers treat
 * the v2 fields as absent on v1 artifacts and omit every empty section, so
 * old persisted reports render unchanged. The full document is a flat
 * colored-card template: 核心要点 card, 话题时间轴 step bar, 主题归纳 grid,
 * 金句 blockquotes, 待办 checklist and a footer.
 *
 * Everything is escaped and self-contained: no images, no Mermaid, no
 * external assets, and no script in the output (MV3 extension pages forbid
 * inline scripts, and an archived report must be inert). Browser-free so it
 * can be unit-tested in Node and loaded as a plain script by the panel and
 * the report page.
 */
var YTD_REPORT_RENDER = (() => {
  // Session kind labels mirror sidepanel.js SESSION_KIND_LABELS.
  const KIND_LABELS = { live: "直播", replay: "回放", course: "课程" };
  const DEFAULT_TITLE = "学习纪要";

  /**
   * The storage key the Session Digest artifact is persisted under:
   * `report_<sessionId>`. Built in three contexts (background persistence,
   * panel lookup, report page), so the format lives here as the one constant
   * they all read — the persisted format must stay byte-identical.
   */
  const REPORT_STORAGE_KEY_PREFIX = "report_";

  /**
   * The [m:ss] timestamp formatter, mirroring speech-transcription.js so
   * report citations read exactly like the transcript prompt's stamps
   * (minutes may exceed 59 for hour-plus Sessions).
   */
  function formatTimestamp(startSeconds) {
    const total = Math.max(0, Math.floor(Number(startSeconds) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /** Local wall-clock label like 「2026年11月8日 10:05」. */
  function formatMetaDate(ms) {
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return null;
    return (
      `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ` +
      `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    );
  }

  /** Start–end range; the end collapses to a time when it is the same day. */
  function formatDateRange(meta) {
    const start = formatMetaDate(meta?.startedAtMs);
    if (!start) return null;
    const endMs = Number(meta?.endedAtMs);
    if (!meta?.endedAtMs || Number.isNaN(new Date(endMs).getTime())) return start;
    const endDate = new Date(endMs);
    const startDate = new Date(Number(meta.startedAtMs));
    const sameDay =
      endDate.getFullYear() === startDate.getFullYear() &&
      endDate.getMonth() === startDate.getMonth() &&
      endDate.getDate() === startDate.getDate();
    const end = sameDay
      ? `${pad2(endDate.getHours())}:${pad2(endDate.getMinutes())}`
      : formatMetaDate(endMs);
    return `${start} – ${end}`;
  }

  /**
   * The header meta line: kind label, platform, local date range, Session
   * duration and the generated-at stamp — each omitted when the artifact
   * does not know it (a retried pass may only be able to reconstruct the
   * timestamps; generatedAtMs rides on the persisted meta).
   */
  function metaLineParts(meta) {
    const parts = [];
    const kindLabel = KIND_LABELS[meta?.kind];
    if (kindLabel) parts.push(kindLabel);
    if (meta?.platformId) parts.push(String(meta.platformId));
    const range = formatDateRange(meta);
    if (range) parts.push(range);
    const duration = formatDuration(meta);
    if (duration) parts.push(`时长 ${duration}`);
    const generatedAt = formatMetaDate(meta?.generatedAtMs);
    if (generatedAt) parts.push(`生成于 ${generatedAt}`);
    return parts;
  }

  /** 时长 label like 「2 小时 25 分」 or 「45 分钟」, or null when unknown. */
  function formatDuration(meta) {
    const start = Number(meta?.startedAtMs);
    const end = Number(meta?.endedAtMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const minutes = Math.round((end - start) / 60000);
    if (minutes <= 0) return null;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `${rest} 分钟`;
    if (rest === 0) return `${hours} 小时`;
    return `${hours} 小时 ${rest} 分`;
  }

  function reportTitle(meta) {
    const title = typeof meta?.title === "string" ? meta.title.trim() : "";
    return title || DEFAULT_TITLE;
  }

  function reportTopics(report) {
    return Array.isArray(report?.topics) ? report.topics : [];
  }

  function reportQuotes(report) {
    return Array.isArray(report?.quotes) ? report.quotes : [];
  }

  function reportTodos(report) {
    return Array.isArray(report?.todos) ? report.todos : [];
  }

  /** Schema v2: the 核心要点 conclusions (absent on v1 artifacts). */
  function reportOverview(report) {
    return Array.isArray(report?.overview) ? report.overview : [];
  }

  /** Schema v2: the 主题归纳 category cards (absent on v1 artifacts). */
  function reportCategories(report) {
    return Array.isArray(report?.categories) ? report.categories : [];
  }

  /** Schema v2: a Topic's short bullet points (absent on v1 artifacts). */
  function topicBullets(topic) {
    return Array.isArray(topic?.bullets) ? topic.bullets : [];
  }

  // --- shared section builders (full page and compact fragment) -------------

  function overviewHtml(report) {
    const overview = reportOverview(report);
    if (overview.length === 0) return "";
    const items = overview.map((line) => `    <li>${escapeHtml(line)}</li>`).join("\n");
    return [
      '  <section class="report-overview">',
      '    <h2 class="report-section-title">核心要点</h2>',
      '  <ul class="overview-card">',
      items,
      "  </ul>",
      "  </section>",
    ].join("\n");
  }

  /** The Topic body: bullets as a list when present, else the v1 summary. */
  function topicBodyHtml(topic) {
    const bullets = topicBullets(topic);
    if (bullets.length > 0) {
      const items = bullets.map((bullet) => `        <li>${escapeHtml(bullet)}</li>`).join("\n");
      return ['      <ul class="topic-bullets">', items, "      </ul>"].join("\n");
    }
    return `      <p class="topic-summary">${escapeHtml(topic?.summary)}</p>`;
  }

  function topicsHtml(report) {
    const topics = reportTopics(report);
    if (topics.length === 0) return "";
    const items = topics
      .map((topic, index) => {
        const range = `[${formatTimestamp(topic?.start)}–${formatTimestamp(topic?.end)}]`;
        return [
          '    <section class="report-topic">',
          `      <div class="topic-step" aria-hidden="true"><span class="topic-step-dot">${index + 1}</span></div>`,
          '      <div class="topic-content">',
          `        <h3 class="topic-title"><span class="topic-time">${escapeHtml(range)}</span> ${escapeHtml(topic?.title)}</h3>`,
          topicBodyHtml(topic),
          "      </div>",
          "    </section>",
        ].join("\n");
      })
      .join("\n");
    return [
      '  <section class="report-topics">',
      '    <h2 class="report-section-title">话题时间轴</h2>',
      '  <div class="topic-list">',
      items,
      "  </div>",
      "  </section>",
    ].join("\n");
  }

  // The category palette cycles through four flat tints (see --cat-* in
  // REPORT_STYLE); card N gets palette class cat-(N % 4).
  const CATEGORY_PALETTE_COUNT = 4;

  function categoriesHtml(report) {
    const categories = reportCategories(report);
    if (categories.length === 0) return "";
    const cards = categories
      .map((category, index) => {
        const points = (Array.isArray(category?.points) ? category.points : [])
          .map((point) => `        <li>${escapeHtml(point)}</li>`)
          .join("\n");
        return [
          `    <div class="category-card cat-${index % CATEGORY_PALETTE_COUNT}">`,
          `      <div class="category-chip">${escapeHtml(category?.title)}</div>`,
          '      <ul class="category-points">',
          points,
          "      </ul>",
          "    </div>",
        ].join("\n");
      })
      .join("\n");
    return [
      '  <section class="report-categories">',
      '    <h2 class="report-section-title">主题归纳</h2>',
      '  <div class="category-grid">',
      cards,
      "  </div>",
      "  </section>",
    ].join("\n");
  }

  function quotesHtml(report) {
    const quotes = reportQuotes(report);
    if (quotes.length === 0) return "";
    const items = quotes
      .map(
        (quote) =>
          `    <blockquote class="quote-item"><span class="quote-time">[${escapeHtml(
            formatTimestamp(quote?.start),
          )}]</span> ${escapeHtml(quote?.text)}</blockquote>`,
      )
      .join("\n");
    return [
      '  <section class="report-quotes">',
      '    <h2 class="report-section-title">金句</h2>',
      items,
      "  </section>",
    ].join("\n");
  }

  function todosHtml(report) {
    const todos = reportTodos(report);
    if (todos.length === 0) return "";
    const items = todos
      .map(
        (todo) =>
          `    <li class="todo-item"><label><input type="checkbox" disabled> <span class="todo-text">${escapeHtml(
            todo,
          )}</span></label></li>`,
      )
      .join("\n");
    return [
      '  <section class="report-todos">',
      '    <h2 class="report-section-title">待办</h2>',
      '  <ul class="todo-list">',
      items,
      "  </ul>",
      "  </section>",
    ].join("\n");
  }

  function bodySectionsHtml(report) {
    const sections = [
      overviewHtml(report),
      topicsHtml(report),
      categoriesHtml(report),
      quotesHtml(report),
      todosHtml(report),
    ].filter(Boolean);
    if (sections.length === 0) {
      return '  <p class="report-empty">本会话没有可展示的内容。</p>';
    }
    return sections.join("\n");
  }

  /** The one-line footer every report surface ends with. */
  function reportFooterHtml() {
    return '  <footer class="report-footer">由 Learning Digest 生成</footer>';
  }

  // --- full document ---------------------------------------------------------

  // The report page styles itself with the extension's Brand Blue tokens
  // (see sidepanel.css :root), inlined here so the archived document is
  // standalone. Flat colored-card design: solid tints and borders only — no
  // gradients, minimal shadows. The topic list reads as a timeline (numbered
  // step chips on a vertical line, one flat card per Topic) and the category
  // grid cycles a fixed four-color palette declared as custom properties.
  // The compact fragment in sidepanel.css mirrors --accent-deep and the
  // --cat-* palette for the narrow panel column.
  const REPORT_STYLE = `
    :root {
      --bg: #f2f6fc;
      --surface: #ffffff;
      --border: #dce5f0;
      --text: #1f2733;
      --text-secondary: #5b6b80;
      --text-muted: #93a1b3;
      --accent: #1b72e8;
      --accent-dim: rgba(27, 114, 232, 0.1);
      --accent-deep: #16406b;
      --sage: #4f7fa8;
      --cat-blue-bg: #e8f1fc;
      --cat-blue-border: #1b72e8;
      --cat-green-bg: #e9f5ef;
      --cat-green-border: #3e8e6d;
      --cat-amber-bg: #fdf3e3;
      --cat-amber-border: #d9a441;
      --cat-purple-bg: #f1edf9;
      --cat-purple-border: #7a5fb8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.7;
    }
    .report {
      max-width: 760px;
      margin: 0 auto;
      padding: 40px 24px 64px;
    }
    .report-header {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 26px 30px;
      margin-bottom: 20px;
    }
    .report-title {
      margin: 0 0 8px;
      font-size: 26px;
      line-height: 1.35;
    }
    .report-meta {
      color: var(--text-secondary);
      font-size: 14px;
    }
    .report-section-title {
      margin: 0 0 10px;
      font-size: 17px;
    }
    .report-overview, .report-topics, .report-categories, .report-quotes, .report-todos {
      margin-bottom: 20px;
    }
    /* 核心要点: one deep-blue solid card with light text. */
    .overview-card {
      margin: 0;
      padding: 18px 22px;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--accent-deep);
      color: #eef5ff;
      border-radius: 14px;
      font-size: 15px;
    }
    .overview-card li { padding-left: 18px; position: relative; }
    .overview-card li::before {
      content: "";
      position: absolute;
      left: 2px;
      top: 0.72em;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #7db4f5;
    }
    /* 话题时间轴: one numbered step chip per Topic on a vertical line, each
       Topic rendered as a flat card with an accent left border. */
    .topic-list {
      margin: 0;
      padding: 0;
      list-style: none;
      position: relative;
    }
    .topic-list .report-topic {
      display: flex;
      gap: 12px;
      position: relative;
      padding-bottom: 12px;
    }
    .topic-list .report-topic:last-child { padding-bottom: 0; }
    .topic-step {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
      width: 28px;
    }
    .topic-step::after {
      content: "";
      position: absolute;
      top: 30px;
      bottom: -4px;
      left: 50%;
      width: 2px;
      transform: translateX(-50%);
      background: var(--border);
    }
    .topic-list .report-topic:last-child .topic-step::after { display: none; }
    .topic-step-dot {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: var(--accent);
      color: #ffffff;
      font-size: 13px;
      line-height: 26px;
      text-align: center;
      flex: 0 0 auto;
      z-index: 1;
    }
    .topic-content {
      flex: 1;
      min-width: 0;
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      border-radius: 12px;
      padding: 12px 18px;
    }
    .topic-title {
      margin: 0 0 6px;
      font-size: 15.5px;
      line-height: 1.5;
    }
    .topic-time {
      display: inline-block;
      color: var(--accent);
      background: var(--accent-dim);
      border-radius: 999px;
      padding: 0 8px;
      font-family: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
      font-size: 12px;
      white-space: nowrap;
    }
    .topic-bullets {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: var(--text-secondary);
      font-size: 14.5px;
    }
    .topic-bullets li { padding-left: 16px; position: relative; }
    .topic-bullets li::before {
      content: "";
      position: absolute;
      left: 2px;
      top: 0.7em;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0.55;
    }
    .topic-summary {
      margin: 0;
      color: var(--text-secondary);
      font-size: 14.5px;
      white-space: pre-wrap;
    }
    /* 主题归纳: a responsive grid of flat tinted cards cycling the palette. */
    .category-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
    }
    .category-card { --cat-bg: var(--cat-blue-bg); --cat-border: var(--cat-blue-border); }
    .category-card.cat-0 { --cat-bg: var(--cat-blue-bg); --cat-border: var(--cat-blue-border); }
    .category-card.cat-1 { --cat-bg: var(--cat-green-bg); --cat-border: var(--cat-green-border); }
    .category-card.cat-2 { --cat-bg: var(--cat-amber-bg); --cat-border: var(--cat-amber-border); }
    .category-card.cat-3 { --cat-bg: var(--cat-purple-bg); --cat-border: var(--cat-purple-border); }
    .category-card {
      background: var(--cat-bg);
      border: 1px solid var(--cat-border);
      border-radius: 12px;
      padding: 12px 16px;
    }
    .category-chip {
      display: inline-block;
      background: var(--cat-border);
      color: #ffffff;
      font-size: 12px;
      font-weight: 600;
      border-radius: 999px;
      padding: 1px 10px;
      margin-bottom: 8px;
    }
    .category-points {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 14px;
    }
    .category-points li { padding-left: 14px; position: relative; }
    .category-points li::before {
      content: "";
      position: absolute;
      left: 1px;
      top: 0.7em;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--cat-border);
    }
    .quote-item {
      margin: 0 0 12px;
      padding: 10px 16px;
      border-left: 4px solid var(--accent);
      background: var(--accent-dim);
      border-radius: 8px;
      color: var(--text);
    }
    .quote-item:last-child { margin-bottom: 0; }
    .quote-time {
      color: var(--accent);
      font-family: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
      font-size: 13px;
    }
    .todo-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .todo-item { padding: 4px 0; }
    .todo-item label { display: flex; align-items: baseline; gap: 10px; cursor: default; }
    .todo-item input[type="checkbox"] { accent-color: var(--accent); }
    .todo-text { color: var(--text); }
    .report-empty {
      margin: 0;
      color: var(--text-muted);
      font-size: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px 28px;
    }
    .report-footer {
      margin-top: 28px;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
    }
    /* The print toolbar lives only on the live report page (report.js injects
       it); an archived or downloaded report renders without it. */
    .report-print-btn {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 10;
      background: var(--accent);
      color: #ffffff;
      border: none;
      border-radius: 999px;
      padding: 10px 18px;
      font-family: inherit;
      font-size: 14px;
      cursor: pointer;
    }
    /* 打印 / 存为 PDF: white background, sane margins, cards never split
       across pages, and the flat tints survive via print-color-adjust. */
    @page { margin: 14mm; }
    @media print {
      body { background: #ffffff; }
      .report { max-width: none; padding: 0; }
      .report-print-btn { display: none !important; }
      .report-header, .overview-card, .topic-content, .category-card,
      .quote-item, .report-topic, .report-empty {
        break-inside: avoid;
      }
      * {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
    }
  `;

  /**
   * The full report document: header (title + meta line), one section per
   * Topic on a CSS step-bar timeline, timestamped quotes and a todo
   * checklist. No script, no images, no external assets.
   *
   * @param {object} report - the parsed global-pass report JSON
   * @param {object|null} meta - { title?, startedAtMs, endedAtMs, kind, platformId? }
   * @returns {string} a complete HTML document
   */
  function renderReportHtml(report, meta) {
    const title = reportTitle(meta);
    const parts = metaLineParts(meta);
    const metaLine = parts.length
      ? `  <div class="report-meta">${parts.map(escapeHtml).join(" · ")}</div>`
      : "";
    return [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<title>${escapeHtml(title)}</title>`,
      `<style>${REPORT_STYLE}</style>`,
      "</head>",
      "<body>",
      '  <main class="report">',
      '    <header class="report-header">',
      `      <h1 class="report-title">${escapeHtml(title)}</h1>`,
      metaLine,
      "    </header>",
      bodySectionsHtml(report),
      reportFooterHtml(),
      "  </main>",
      "</body>",
      "</html>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // --- Markdown export -------------------------------------------------------

  /**
   * The Markdown export: # title, ## 核心要点 conclusions, ## per Topic with
   * the time range in the heading (bullets when present, else the summary),
   * ## 主题归纳 with ### subheads, timestamped quotes, todo checklist, and
   * the meta as plain list lines. Sections with no data are omitted.
   *
   * @param {object} report - the parsed global-pass report JSON
   * @param {object|null} meta - { title?, startedAtMs, endedAtMs, kind, platformId?, generatedAtMs? }
   * @returns {string}
   */
  function renderReportMarkdown(report, meta) {
    const lines = [`# ${reportTitle(meta)}`];
    for (const part of metaLineParts(meta)) {
      lines.push(`- ${part}`);
    }
    const overview = reportOverview(report);
    if (overview.length > 0) {
      lines.push("", "## 核心要点", "");
      for (const line of overview) {
        lines.push(`- ${line}`);
      }
    }
    for (const topic of reportTopics(report)) {
      lines.push(
        "",
        `## [${formatTimestamp(topic?.start)}–${formatTimestamp(topic?.end)}] ${topic?.title ?? ""}`,
        "",
      );
      const bullets = topicBullets(topic);
      if (bullets.length > 0) {
        for (const bullet of bullets) {
          lines.push(`- ${bullet}`);
        }
      } else {
        lines.push(String(topic?.summary ?? ""));
      }
    }
    const categories = reportCategories(report);
    if (categories.length > 0) {
      lines.push("", "## 主题归纳");
      for (const category of categories) {
        lines.push("", `### ${category?.title ?? ""}`, "");
        const points = Array.isArray(category?.points) ? category.points : [];
        for (const point of points) {
          lines.push(`- ${point}`);
        }
      }
    }
    const quotes = reportQuotes(report);
    if (quotes.length > 0) {
      lines.push("", "## 金句", "");
      for (const quote of quotes) {
        lines.push(
          `> [${formatTimestamp(quote?.start)}] ${quote?.text ?? ""}`,
        );
      }
    }
    const todos = reportTodos(report);
    if (todos.length > 0) {
      lines.push("", "## 待办", "");
      for (const todo of todos) {
        lines.push(`- [ ] ${todo}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  // --- compact panel fragment -------------------------------------------------

  /**
   * The compact fragment for the side panel 纪要 tab: the same structure and
   * class names as the full document, wrapped in .report-compact so the
   * panel stylesheet can restyle it for the narrow column. No <html>, no
   * <style> — the fragment inherits the panel's stylesheet.
   *
   * @param {object} report - the parsed global-pass report JSON
   * @param {object|null} meta - { title?, startedAtMs, endedAtMs, kind, platformId? }
   * @returns {string} an HTML fragment
   */
  function renderReportCompact(report, meta) {
    const title = reportTitle(meta);
    const parts = metaLineParts(meta);
    const metaLine = parts.length
      ? `    <div class="report-meta">${parts.map(escapeHtml).join(" · ")}</div>`
      : "";
    return [
      '<div class="report-compact">',
      "  <div class=\"report-header\">",
      `    <h2 class="report-title">${escapeHtml(title)}</h2>`,
      metaLine,
      "  </div>",
      bodySectionsHtml(report),
      reportFooterHtml(),
      "</div>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return {
    formatTimestamp,
    REPORT_STORAGE_KEY_PREFIX,
    renderReportHtml,
    renderReportMarkdown,
    renderReportCompact,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_REPORT_RENDER;
}
