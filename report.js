/**
 * FULL REPORT PAGE (#30)
 *
 * The browser-tab report: reads ?session=<sessionId>, loads the persisted
 * `report_<sessionId>` artifact from chrome.storage.local and replaces this
 * document with the pure renderer's output. MV3 forbids inline scripts, so
 * the logic lives in this external file; the rendered document carries no
 * script at all, which keeps an archived report inert.
 */

const reportRender =
  typeof YTD_REPORT_RENDER !== "undefined"
    ? YTD_REPORT_RENDER
    : require("./report-render.js");

/**
 * The session id from the page URL, or "" when it is missing.
 */
function reportSessionId() {
  return new URLSearchParams(location.search).get("session") || "";
}

function writeDocument(html) {
  document.open();
  document.write(html);
  document.close();
}

// The Brand Blue tokens the dead end styles itself with — the same values
// REPORT_STYLE inlines for every rendered report (see report-render.js), so
// the failure page reads like the report it could not open. Declared once
// here; renderMissingReport references them instead of re-inlining literals.
const MISSING_REPORT_TOKENS = {
  bg: "#f2f6fc",
  surface: "#ffffff",
  border: "#dce5f0",
  text: "#1f2733",
  textSecondary: "#5b6b80",
};

/**
 * The Chinese dead end for a report that cannot be opened: a missing session
 * id in the URL, or no persisted artifact under report_<sessionId>. Only
 * static copy is interpolated — the session id never enters the document.
 */
function renderMissingReport(reason) {
  const tokens = MISSING_REPORT_TOKENS;
  writeDocument(
    [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      "<title>学习纪要</title>",
      "<style>",
      "  body {",
      "    margin: 0;",
      `    background: ${tokens.bg};`,
      `    color: ${tokens.text};`,
      '    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
      "  }",
      "  .missing-report {",
      "    max-width: 480px;",
      "    margin: 20vh auto 0;",
      `    background: ${tokens.surface};`,
      `    border: 1px solid ${tokens.border};`,
      "    border-radius: 16px;",
      "    padding: 32px;",
      "    text-align: center;",
      "  }",
      "  .missing-report h1 { margin: 0 0 8px; font-size: 20px; }",
      `  .missing-report p { margin: 0; color: ${tokens.textSecondary}; font-size: 14px; }`,
      "</style>",
      "</head>",
      "<body>",
      '  <div class="missing-report">',
      "    <h1>没有找到报告</h1>",
      `    <p>${reason}</p>`,
      "  </div>",
      "</body>",
      "</html>",
    ].join("\n"),
  );
}

/**
 * Loads the artifact for ?session=<id> and renders it; every failure mode
 * becomes the renderable dead end above.
 */
async function openPersistedReport() {
  const sessionId = reportSessionId();
  if (!sessionId) {
    renderMissingReport("链接缺少会话标识，无法打开报告。");
    return;
  }
  const storageKey = `${reportRender.REPORT_STORAGE_KEY_PREFIX}${sessionId}`;
  let artifact = null;
  try {
    const stored = await chrome.storage.local.get(storageKey);
    artifact = stored?.[storageKey] || null;
  } catch (_error) {
    // Storage unreachable (extension reloaded); treat as missing below.
  }
  if (!artifact || !artifact.report) {
    renderMissingReport("该会话还没有生成报告，请在侧边栏的「纪要」页重试生成。");
    return;
  }
  writeDocument(
    reportRender.renderReportHtml(artifact.report, artifact.meta || null),
  );
}

// Pure helpers are exposed for the repository's Node tests. The extension
// does not read this object at runtime.
globalThis.__YTD_REPORT_PAGE_TESTING__ = {
  reportSessionId,
  openPersistedReport,
  renderMissingReport,
};

void openPersistedReport();
