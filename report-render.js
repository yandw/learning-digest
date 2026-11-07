/**
 * Report renderers (#30): pure string-in/string-out views over the persisted
 * report artifact (#29). Three consumers share one data source:
 *
 * - renderReportHtml    full styled document for the browser-tab report page
 * - renderReportMarkdown Markdown export for archiving/sharing
 * - renderReportCompact  HTML fragment for the narrow side panel 纪要 tab
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
   * The header meta line: kind label, platform, local date range — each
   * omitted when the artifact does not know it (a retried pass may only be
   * able to reconstruct the timestamps).
   */
  function metaLineParts(meta) {
    const parts = [];
    const kindLabel = KIND_LABELS[meta?.kind];
    if (kindLabel) parts.push(kindLabel);
    if (meta?.platformId) parts.push(String(meta.platformId));
    const range = formatDateRange(meta);
    if (range) parts.push(range);
    return parts;
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

  // --- shared section builders (full page and compact fragment) -------------

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
          `        <p class="topic-summary">${escapeHtml(topic?.summary)}</p>`,
          "      </div>",
          "    </section>",
        ].join("\n");
      })
      .join("\n");
    return [
      '  <section class="report-topics">',
      '    <h2 class="report-section-title">话题</h2>',
      '  <div class="topic-list">',
      items,
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
      '    <h2 class="report-section-title">关键原话</h2>',
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
      '    <h2 class="report-section-title">行动项</h2>',
      '  <ul class="todo-list">',
      items,
      "  </ul>",
      "  </section>",
    ].join("\n");
  }

  function bodySectionsHtml(report) {
    const sections = [
      topicsHtml(report),
      quotesHtml(report),
      todosHtml(report),
    ].filter(Boolean);
    if (sections.length === 0) {
      return '  <p class="report-empty">本会话没有可展示的内容。</p>';
    }
    return sections.join("\n");
  }

  // --- full document ---------------------------------------------------------

  // The report page styles itself with the extension's Brand Blue tokens
  // (see sidepanel.css :root), inlined here so the archived document is
  // standalone. The topic list reads as a timeline: numbered step dots on a
  // vertical line, one stop per Topic.
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
      --sage: #4f7fa8;
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
      max-width: 720px;
      margin: 0 auto;
      padding: 40px 24px 64px;
    }
    .report-header {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px 28px;
      margin-bottom: 28px;
    }
    .report-title {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.4;
    }
    .report-meta {
      color: var(--text-secondary);
      font-size: 14px;
    }
    .report-section-title {
      margin: 0 0 12px;
      font-size: 18px;
    }
    .report-topics, .report-quotes, .report-todos {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px 28px;
      margin-bottom: 20px;
    }
    .topic-list {
      margin: 0;
      padding: 0 0 0 4px;
      list-style: none;
      position: relative;
    }
    /* CSS step bar: one numbered stop per Topic, joined by a vertical line. */
    .topic-list .report-topic {
      display: flex;
      gap: 14px;
      position: relative;
      padding-bottom: 20px;
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
      top: 26px;
      bottom: 4px;
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
    .topic-content { min-width: 0; }
    .topic-title {
      margin: 2px 0 4px;
      font-size: 16px;
      line-height: 1.5;
    }
    .topic-time {
      color: var(--accent);
      font-family: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
      font-size: 13px;
    }
    .topic-summary {
      margin: 0;
      color: var(--text-secondary);
      font-size: 15px;
      white-space: pre-wrap;
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
      "  </main>",
      "</body>",
      "</html>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // --- Markdown export -------------------------------------------------------

  /**
   * The Markdown export: # title, ## per Topic with the time range in the
   * heading, timestamped quotes, todo checklist, and the meta as plain
   * list lines.
   *
   * @param {object} report - the parsed global-pass report JSON
   * @param {object|null} meta - { title?, startedAtMs, endedAtMs, kind, platformId? }
   * @returns {string}
   */
  function renderReportMarkdown(report, meta) {
    const lines = [`# ${reportTitle(meta)}`];
    for (const part of metaLineParts(meta)) {
      lines.push(`- ${part}`);
    }
    for (const topic of reportTopics(report)) {
      lines.push(
        "",
        `## [${formatTimestamp(topic?.start)}–${formatTimestamp(topic?.end)}] ${topic?.title ?? ""}`,
        "",
        String(topic?.summary ?? ""),
      );
    }
    const quotes = reportQuotes(report);
    if (quotes.length > 0) {
      lines.push("", "## 关键原话", "");
      for (const quote of quotes) {
        lines.push(
          `> [${formatTimestamp(quote?.start)}] ${quote?.text ?? ""}`,
        );
      }
    }
    const todos = reportTodos(report);
    if (todos.length > 0) {
      lines.push("", "## 行动项", "");
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
