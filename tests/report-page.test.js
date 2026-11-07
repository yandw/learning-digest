/**
 * The full report page controller (#30): report.js reads ?session=<id>,
 * loads the persisted artifact and replaces the document with the pure
 * renderer's output, with a Chinese dead end when the artifact is missing.
 * Tested through a VM seam with stubbed location/document/chrome.storage,
 * in the same spirit as tests/transcript-search.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const REPORT = {
  topics: [{ start: 0, end: 900, title: "课程导论", summary: "老师介绍了课程目标。" }],
  quotes: [{ start: 30, text: "学习是一场旅程。" }],
  todos: ["完成课后练习"],
};
const META = {
  startedAtMs: new Date(2026, 10, 8, 10, 5).getTime(),
  endedAtMs: new Date(2026, 10, 8, 12, 30).getTime(),
  kind: "replay",
  platformId: "xiaoe-tech",
};

/**
 * Loads report.js in a sandbox. The top-level auto-run also executes against
 * the stubs; assertions target the last written document, which both runs
 * produce identically.
 */
function loadReportPage({ search = "", stored = {} } = {}) {
  const written = [];
  const sandbox = {
    console,
    URLSearchParams,
    location: { search },
    document: {
      open() {
        written.push({ open: true });
      },
      write(html) {
        written.push(String(html));
      },
      close() {},
    },
    chrome: {
      storage: {
        local: {
          get: async (key) => ({ [key]: stored[key] }),
        },
      },
    },
    YTD_REPORT_RENDER: require("../report-render.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("report.js"), sandbox);
  return {
    openPersistedReport: sandbox.__YTD_REPORT_PAGE_TESTING__.openPersistedReport,
    lastDocument: () => written.filter((entry) => typeof entry === "string").at(-1) || "",
  };
}

test("the report page renders the persisted artifact into a full document", async () => {
  const page = loadReportPage({
    search: "?session=s_abc123",
    stored: {
      report_s_abc123: {
        sessionId: "s_abc123",
        report: REPORT,
        meta: META,
        generatedAtMs: 1,
      },
    },
  });

  await page.openPersistedReport();

  const html = page.lastDocument();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /课程导论/);
  assert.match(html, /学习是一场旅程。/);
  assert.match(html, /完成课后练习/);
  assert.match(html, /2026年11月8日 10:05 – 12:30/, "the meta line rides along");
});

test("the report page still renders when the artifact carries no meta", async () => {
  const page = loadReportPage({
    search: "?session=s_abc123",
    stored: {
      report_s_abc123: { sessionId: "s_abc123", report: REPORT, generatedAtMs: 1 },
    },
  });

  await page.openPersistedReport();

  const html = page.lastDocument();
  assert.match(html, /课程导论/);
  assert.doesNotMatch(html, /2026年/, "no date without meta");
});

test("the report page shows a Chinese dead end when the session id is missing", async () => {
  const page = loadReportPage({ search: "" });

  await page.openPersistedReport();

  const html = page.lastDocument();
  assert.match(html, /没有找到报告/);
  assert.match(html, /链接缺少会话标识/);
  assert.doesNotMatch(html, /课程导论/);
});

test("the report page shows a Chinese dead end when nothing is persisted", async () => {
  const page = loadReportPage({ search: "?session=s_missing", stored: {} });

  await page.openPersistedReport();

  const html = page.lastDocument();
  assert.match(html, /没有找到报告/);
  assert.match(html, /还没有生成报告/);
});

test("the missing-report dead end styles itself from the report's brand tokens", async () => {
  const page = loadReportPage({ search: "?session=s_missing", stored: {} });
  await page.openPersistedReport();
  const deadEnd = page.lastDocument();

  // Source of truth: the palette the full report inlines via REPORT_STYLE.
  const fullReport = require("../report-render.js").renderReportHtml(REPORT, META);
  const brandPalette = ["#f2f6fc", "#ffffff", "#dce5f0", "#1f2733", "#5b6b80"];
  for (const token of brandPalette) {
    assert.ok(fullReport.includes(token), `the report style carries ${token}`);
    assert.ok(deadEnd.includes(token), `the dead end reuses ${token}`);
  }
  // The tokens are declared once in report.js; renderMissingReport references
  // them instead of re-inlining the literals per CSS rule.
  assert.match(read("report.js"), /const [A-Z_]*TOKENS = \{/);
});

test("report.html wires the renderer and controller as external scripts", () => {
  const html = read("report.html");
  const js = read("report.js");

  // MV3 extension pages forbid inline scripts; both files are external and
  // the renderer loads before the controller that uses it.
  assert.match(html, /<script src="report-render\.js"><\/script>/);
  assert.match(
    html,
    /<script src="report-render\.js"><\/script>\s*<script src="report\.js">/,
  );
  assert.doesNotMatch(html, /<script(?![^>]*src=)/i, "no inline script");
  assert.match(js, /location\.search/);
  // The artifact key is built from the shared REPORT_STORAGE_KEY_PREFIX, not
  // a re-inlined literal.
  assert.match(js, /REPORT_STORAGE_KEY_PREFIX\}\$\{sessionId\}/);
  assert.match(js, /renderReportHtml/);
  assert.match(js, /没有找到报告/);
});
