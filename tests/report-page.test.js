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
 * produce identically. The document stub also records createElement/body
 * appends, window.print calls and scheduled timers, so the print-toolbar
 * injection and the ?print=1 auto-print are observable.
 */
function loadReportPage({ search = "", stored = {} } = {}) {
  const written = [];
  const createdElements = [];
  const printCalls = [];
  const timers = [];
  const body = {
    children: [],
    appendChild(child) {
      body.children.push(child);
      return child;
    },
  };
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
      createElement(tag) {
        const element = {
          tagName: tag,
          type: "",
          className: "",
          textContent: "",
          listeners: {},
          addEventListener(type, handler) {
            element.listeners[type] = handler;
          },
        };
        createdElements.push(element);
        return element;
      },
      body,
    },
    window: {
      print: () => printCalls.push(true),
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout() {},
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
    createdElements,
    printCalls,
    timers,
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

// --- 打印 / 存为 PDF (0.1.38) -------------------------------------------------

test("the rendered report page carries a print toolbar outside the artifact", async () => {
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

  // The written artifact stays inert: no toolbar markup inside the rendered
  // document (the class name exists only in the inlined CSS rules), which is
  // what a download or archive keeps.
  const html = page.lastDocument();
  assert.doesNotMatch(html, /<button/i);
  assert.doesNotMatch(html, /<script/i);
  // The live page gains the toolbar as a DOM element wired to window.print().
  const button = page.createdElements.find((el) => el.className === "report-print-btn");
  assert.ok(button, "the print toolbar button is injected");
  assert.equal(button.textContent, "打印 / 存为 PDF");
  assert.equal(page.printCalls.length, 0, "no dialog before the click");
  button.listeners.click();
  assert.equal(page.printCalls.length, 1);
});

test("?print=1 auto-opens the print dialog after the report renders", async () => {
  const page = loadReportPage({
    search: "?session=s_abc123&print=1",
    stored: {
      report_s_abc123: {
        sessionId: "s_abc123",
        report: REPORT,
        meta: META,
        generatedAtMs: 1,
      },
    },
  });
  // The top-level auto-run also renders against the stubs; let it settle,
  // then observe one explicit render in isolation.
  await new Promise((resolve) => setImmediate(resolve));
  page.timers.length = 0;
  page.printCalls.length = 0;

  await page.openPersistedReport();

  assert.equal(page.timers.length, 1, "one delayed print per render");
  assert.ok(page.timers[0].delay > 0, "the dialog waits until the DOM is painted");
  page.timers[0].fn();
  assert.equal(page.printCalls.length, 1);

  // Without the parameter nothing is scheduled.
  const plain = loadReportPage({
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
  await plain.openPersistedReport();
  assert.equal(plain.timers.length, 0);
  assert.equal(plain.printCalls.length, 0);
});

test("the missing-report dead end injects no print toolbar and schedules nothing", async () => {
  const page = loadReportPage({ search: "?session=s_missing&print=1", stored: {} });

  await page.openPersistedReport();

  assert.match(page.lastDocument(), /没有找到报告/);
  assert.equal(page.createdElements.length, 0);
  assert.equal(page.timers.length, 0);
  assert.equal(page.printCalls.length, 0);
});

test("the report stylesheet carries the print / PDF rules", () => {
  const html = require("../report-render.js").renderReportHtml(REPORT, META);

  assert.match(html, /@media print/);
  assert.match(html, /@page\s*\{/);
  assert.match(html, /break-inside:\s*avoid/);
  assert.match(html, /print-color-adjust:\s*exact/);
  // The injected toolbar hides itself in print output.
  assert.match(html, /\.report-print-btn\s*\{[^}]*position:\s*fixed/);
  assert.match(html, /@media print\s*\{[\s\S]*\.report-print-btn\s*\{[^}]*display:\s*none/);
});
