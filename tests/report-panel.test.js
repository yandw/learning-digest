/**
 * Panel wiring for the 纪要 tab (#30) and the 概览 Session Digest view (#31):
 * tab switching through the existing data-tab/data-panel pattern, the tab's
 * states (generating / failed with 重试 / ready), the startup scan that
 * surfaces the latest persisted report (D7), the Overview's Topics + quotes
 * rendering from the same artifact, the timestamp jumps into the Session
 * transcript, and the open/download actions. Tested through the
 * mock-document VM seam in the spirit of tests/transcript-search.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const REPORT_A = {
  topics: [{ start: 0, end: 900, title: "课程导论", summary: "老师介绍了课程目标。" }],
  quotes: [{ start: 30, text: "学习是一场旅程。" }],
  todos: ["完成课后练习"],
};
const REPORT_B = {
  topics: [{ start: 0, end: 600, title: "较新的会话", summary: "这是最新一次的报告。" }],
  quotes: [],
  todos: [],
};
const META_A = {
  startedAtMs: new Date(2026, 10, 8, 10, 5).getTime(),
  endedAtMs: new Date(2026, 10, 8, 12, 30).getTime(),
  kind: "replay",
  platformId: "xiaoe-tech",
};

function makeElement(id = "") {
  const element = {
    id,
    tagName: "",
    dataset: {},
    style: {},
    children: [],
    listeners: {},
    textContent: "",
    innerHTML: "",
    disabled: false,
    href: "",
    download: "",
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      toggle(name, force) {
        const has = this._set.has(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next) this._set.add(name);
        else this._set.delete(name);
        return next;
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    append(...kids) {
      element.children.push(...kids);
    },
    remove() {},
    addEventListener(type, handler) {
      element.listeners[type] = handler;
    },
    click() {
      element.clicked = (element.clicked || 0) + 1;
    },
    querySelectorAll() {
      return [];
    },
    scrollIntoView(...args) {
      element.scrollIntoViewCalls = (element.scrollIntoViewCalls || 0) + 1;
      element.scrollIntoViewArgs = args;
    },
  };
  return element;
}

/**
 * Finds descendants by class name. The mock elements do not implement
 * querySelector, and textContent is a plain property (never derived from
 * children), so assertions walk children recursively instead.
 */
function findDescendants(element, className, found = []) {
  for (const child of element.children || []) {
    if (child.classList.contains(className)) found.push(child);
    findDescendants(child, className, found);
  }
  return found;
}

/**
 * Loads sidepanel.js in a mock-document sandbox and returns the report tab
 * testing helpers plus everything a test can assert on: elements, sent
 * messages, created tabs, created object URLs.
 */
function loadPanel({ stored = {} } = {}) {
  const elements = {};
  const elementById = (id) => elements[id] || (elements[id] = makeElement(id));
  const selectorResults = {
    ".tab": ["transcript", "overview", "report", "notes"].map((name) => {
      const tab = makeElement();
      tab.dataset.tab = name;
      return tab;
    }),
    ".tab-panel": ["transcript", "overview", "report", "notes"].map((name) => {
      const panel = makeElement();
      panel.dataset.panel = name;
      return panel;
    }),
  };
  const sentMessages = [];
  const createdTabs = [];
  const createdObjectUrls = [];
  const createdElements = [];
  let nextResponse = { success: true };

  class URLStub extends URL {}
  URLStub.createObjectURL = (blob) => {
    createdObjectUrls.push(blob);
    return "blob:test";
  };
  URLStub.revokeObjectURL = () => {};

  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL: URLStub,
    Blob,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    requestAnimationFrame: (fn) => fn(),
    window: {
      getSelection: () => null,
      close() {},
      alert() {},
    },
    document: {
      getElementById: elementById,
      createElement: (tag) => {
        const el = makeElement();
        el.tagName = tag;
        createdElements.push(el);
        return el;
      },
      querySelector: () => null,
      querySelectorAll: (selector) => selectorResults[selector] || [],
      addEventListener() {},
      body: makeElement("body"),
    },
    chrome: {
      runtime: {
        onMessage: listeners,
        sendMessage: (message) => {
          sentMessages.push(message);
          return Promise.resolve(
            typeof nextResponse === "function" ? nextResponse(message) : nextResponse,
          );
        },
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: {
        create: (options) => {
          createdTabs.push(options);
          return Promise.resolve({ id: 9 });
        },
        onUpdated: listeners,
        onActivated: listeners,
      },
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null) return { ...stored };
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, stored[item]]));
            }
            return { [key]: stored[key] };
          },
          set: async (values) => Object.assign(stored, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
          },
        },
      },
    },
    YTD_SETTINGS: {},
    YTD_REPORT_RENDER: require("../report-render.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);

  return {
    report: sandbox.__YTD_REPORT_TESTING__,
    transcript: sandbox.__YTD_TRANSCRIPT_TESTING__,
    overview: sandbox.__YTD_OVERVIEW_TESTING__,
    elements,
    elementById,
    selectorResults,
    createdElements,
    sentMessages,
    createdTabs,
    createdObjectUrls,
    setNextResponse: (response) => {
      nextResponse = response;
    },
  };
}

function readyArtifact(sessionId, report = REPORT_A, meta = META_A) {
  return { sessionId, report, meta, generatedAtMs: 1 };
}

// --- Tab switching -----------------------------------------------------------

test("switchTab lights the 纪要 tab and its panel", () => {
  const { transcript, selectorResults } = loadPanel();

  transcript.switchTab("report");

  const reportTab = selectorResults[".tab"].find((tab) => tab.dataset.tab === "report");
  const reportPanel = selectorResults[".tab-panel"].find(
    (panel) => panel.dataset.panel === "report",
  );
  assert.equal(reportTab.classList.contains("active"), true);
  assert.equal(reportPanel.classList.contains("active"), true);
  const transcriptPanel = selectorResults[".tab-panel"].find(
    (panel) => panel.dataset.panel === "transcript",
  );
  assert.equal(transcriptPanel.classList.contains("active"), false);
});

// --- Ready state -------------------------------------------------------------

test("a report payload renders compact output with actions in the 纪要 tab", async () => {
  const { report, elements, sentMessages } = loadPanel({
    stored: { report_s_1: readyArtifact("s_1") },
  });

  await report.applyReportPayloadToTab(REPORT_A, "s_1");

  const body = elements.reportTabBody;
  assert.match(body.innerHTML, /class="report-compact"/);
  assert.match(body.innerHTML, /课程导论/);
  assert.match(body.innerHTML, /2026年11月8日 10:05 – 12:30/, "meta line from the artifact");
  assert.equal(elements.reportTabActions.style.display, "flex");
  assert.equal(elements.reportTabHint.style.display, "none");
  assert.equal(elements.reportTabError.style.display, "none");
  assert.deepEqual(sentMessages, [], "rendering itself sends nothing");
});

// --- Failed state ------------------------------------------------------------

test("a failed report shows the error and 重试 sends regenerateReport", async () => {
  const { report, elements, sentMessages, setNextResponse } = loadPanel();

  await report.applyReportPayloadToTab(
    { error: "报告长度受限，生成未完成，请重试。" },
    "s_1",
  );

  assert.equal(elements.reportTabError.style.display, "flex");
  assert.equal(elements.reportTabErrorText.textContent, "报告长度受限，生成未完成，请重试。");
  assert.equal(elements.reportTabActions.style.display, "none");

  setNextResponse({ success: true, sessionId: "s_1", report: REPORT_A });
  await report.retryReportFromTab();

  // Field-wise compare: objects created inside the VM sandbox have a
  // different Object prototype than this test realm.
  const retryMessage = sentMessages.find((m) => m.action === "regenerateReport");
  assert.equal(retryMessage?.action, "regenerateReport");
  assert.equal(retryMessage?.sessionId, "s_1");
  // The retried pass landed: the tab shows the report.
  assert.match(elements.reportTabBody.innerHTML, /课程导论/);
  assert.equal(elements.reportTabError.style.display, "none");
});

test("a retry that fails again restores the failed state with 重试 available", async () => {
  const { report, elements, setNextResponse } = loadPanel();

  await report.applyReportPayloadToTab(
    { error: "报告长度受限，生成未完成，请重试。" },
    "s_1",
  );

  setNextResponse({ success: true, sessionId: "s_1", report: { error: "AI 服务暂时不可用。" } });
  await report.retryReportFromTab();

  assert.equal(elements.reportTabError.style.display, "flex");
  assert.equal(elements.reportTabErrorText.textContent, "AI 服务暂时不可用。");
});

test("a no-transcript pass shows the informational hint without a retry", async () => {
  const { report, elements } = loadPanel();

  await report.applyReportPayloadToTab({ skipped: "noTranscript" }, "s_1");

  assert.match(elements.reportTabHint.textContent, /未捕获到逐字稿/);
  assert.equal(elements.reportTabError.style.display, "none");
  assert.equal(elements.reportTabActions.style.display, "none");
});

// --- Generating state --------------------------------------------------------

test("an active session shows the generating hint until a report arrives", async () => {
  const { report, elements, selectorResults } = loadPanel();

  report.showSessionMode({
    active: true,
    kind: "replay",
    state: { sessionId: "s_2", status: "active", segments: [], transcriptRecords: [], topics: [] },
  });

  // Story 7: the tab bar is visible during the Session, the 纪要 tab is
  // surfaced and reads 报告生成中… until the end-time pass lands.
  assert.equal(elements.resultsState.style.display, "block");
  assert.equal(elements.tabsNav.style.display, "flex");
  const reportTab = selectorResults[".tab"].find((tab) => tab.dataset.tab === "report");
  assert.equal(reportTab.classList.contains("active"), true);
  assert.equal(
    selectorResults[".tab-panel"].find((panel) => panel.dataset.panel === "report").classList.contains("active"),
    true,
  );
  assert.match(elements.reportTabHint.textContent, /报告生成中/);
  assert.equal(elements.reportTabActions.style.display, "none");
  assert.equal(elements.reportTabBody.style.display, "none");
  // While the deliverable is generating, the tab itself is disabled with a
  // tooltip: there is nothing to open yet.
  assert.equal(reportTab.disabled, true, "the 纪要 tab is disabled while generating");
  assert.equal(reportTab.title, "报告生成中…");

  await report.applyReportPayloadToTab(REPORT_A, "s_2");
  assert.match(elements.reportTabBody.innerHTML, /课程导论/);
  assert.equal(elements.reportTabHint.style.display, "none");
  // The report arrival re-enables the tab.
  assert.equal(reportTab.disabled, false, "the report arrival enables the tab");
  assert.equal(reportTab.title, "");
});

test("a failed-with-retry report keeps the 纪要 tab enabled", async () => {
  const { report, selectorResults } = loadPanel();

  await report.applyReportPayloadToTab(
    { error: "报告长度受限，生成未完成，请重试。" },
    "s_1",
  );

  const reportTab = selectorResults[".tab"].find((tab) => tab.dataset.tab === "report");
  assert.equal(
    reportTab.disabled,
    false,
    "a retryable failure is a finished pass: the tab stays openable",
  );
  assert.equal(reportTab.title, "");
});

test("without an active Session the 纪要 tab stays enabled", async () => {
  const { report, selectorResults } = loadPanel();

  await report.adoptLatestStoredReport();

  const reportTab = selectorResults[".tab"].find((tab) => tab.dataset.tab === "report");
  assert.equal(reportTab.disabled, false);
  assert.equal(reportTab.title, "");
});

test("a repeated active-session poll never yanks the learner off their tab", async () => {
  const { report, transcript, selectorResults } = loadPanel();

  report.showSessionMode({
    active: true,
    kind: "replay",
    state: { sessionId: "s_2", status: "active", segments: [], transcriptRecords: [], topics: [] },
  });
  transcript.switchTab("transcript");
  report.showSessionMode({
    active: true,
    kind: "replay",
    state: { sessionId: "s_2", status: "active", segments: [], transcriptRecords: [], topics: [] },
  });

  const activePanel = selectorResults[".tab-panel"].find(
    (panel) => panel.classList.contains("active"),
  );
  assert.equal(activePanel.dataset.panel, "transcript");
});

test("a new active session retires the previously shown report", async () => {
  const { report, elements } = loadPanel({
    stored: { report_s_1: readyArtifact("s_1") },
  });

  await report.applyReportPayloadToTab(REPORT_A, "s_1");
  assert.match(elements.reportTabBody.innerHTML, /课程导论/);

  report.showSessionMode({
    active: true,
    kind: "replay",
    state: { sessionId: "s_9", status: "active", segments: [], transcriptRecords: [], topics: [] },
  });

  assert.equal(elements.reportTabBody.innerHTML, "");
  assert.match(elements.reportTabHint.textContent, /报告生成中/);
});

// --- Startup scan (D7) -------------------------------------------------------

test("panel startup surfaces the most recently generated report", async () => {
  const { report, elements, selectorResults } = loadPanel({
    stored: {
      report_s_old: {
        sessionId: "s_old",
        report: REPORT_A,
        meta: META_A,
        generatedAtMs: 1000,
      },
      report_s_new: {
        sessionId: "s_new",
        report: REPORT_B,
        meta: null,
        generatedAtMs: 2000,
      },
      ytd_settings: { some: "setting" },
    },
  });

  await report.adoptLatestStoredReport();

  assert.match(elements.reportTabBody.innerHTML, /较新的会话/);
  assert.doesNotMatch(elements.reportTabBody.innerHTML, /课程导论/);
  assert.equal(elements.reportTabActions.style.display, "flex");
  // D7: with no active Session the report is the deliverable — the results
  // view shows the 纪要 tab instead of the welcome state.
  assert.equal(elements.resultsState.style.display, "block");
  assert.equal(elements.tabsNav.style.display, "flex");
  assert.equal(
    selectorResults[".tab-panel"].find((panel) => panel.dataset.panel === "report")
      .classList.contains("active"),
    true,
  );
});

test("the startup scan leaves the tab idle when nothing is persisted", async () => {
  const { report, elements } = loadPanel({ stored: {} });

  await report.adoptLatestStoredReport();

  assert.equal(elements.reportTabBody.innerHTML, "");
  assert.equal(elements.reportTabActions.style.display, "none");
  assert.match(elements.reportTabHint.textContent, /结束学习后/);
  assert.equal(elements.reportTabHint.style.display, "flex");
});

test("an idle render never stacks the welcome state on a surfaced report", async () => {
  const { report, elements } = loadPanel({
    stored: { report_s_1: readyArtifact("s_1") },
  });

  // The scan surfaces the report first; a slower idle render (the startup
  // race) must not put the welcome state on top of it.
  await report.adoptLatestStoredReport();
  report.showSessionMode({ active: false, kind: "none", state: null });

  assert.equal(elements.welcomeState.style.display, "none");
  assert.equal(elements.resultsState.style.display, "block");
});

// --- Overview tab (#31): the Session Digest view ------------------------------

test("the 概览 tab renders Topics and quotes from an adopted report", async () => {
  const { report, elements } = loadPanel({
    stored: { report_s_1: readyArtifact("s_1") },
  });

  await report.applyReportPayloadToTab(REPORT_A, "s_1");

  const topicRows = elements.overviewTopics.children;
  assert.equal(topicRows.length, REPORT_A.topics.length);
  const topicTimes = findDescendants(elements.overviewTopics, "overview-time");
  assert.equal(topicTimes[0].textContent, "[0:00–15:00]");
  const topicNames = findDescendants(elements.overviewTopics, "overview-topic-name");
  assert.equal(topicNames[0].textContent, "课程导论");
  const summaries = findDescendants(elements.overviewTopics, "overview-topic-summary");
  assert.equal(summaries[0].textContent, "老师介绍了课程目标。");

  const quoteRows = elements.overviewQuotes.children;
  assert.equal(quoteRows.length, REPORT_A.quotes.length);
  const quoteTimes = findDescendants(elements.overviewQuotes, "overview-time");
  assert.equal(quoteTimes[0].textContent, "[0:30]");
  const quoteTexts = findDescendants(elements.overviewQuotes, "overview-quote-body");
  assert.equal(quoteTexts[0].textContent, "学习是一场旅程。");

  assert.equal(elements.overviewEmpty.style.display, "none");
  assert.equal(elements.overviewTopicsSection.style.display, "block");
  assert.equal(elements.overviewQuotesSection.style.display, "block");
});

test("the startup scan also feeds the 概览 tab", async () => {
  const { report, elements } = loadPanel({
    stored: { report_s_1: readyArtifact("s_1") },
  });

  await report.adoptLatestStoredReport();

  assert.equal(elements.overviewTopics.children.length, 1);
  assert.equal(findDescendants(elements.overviewTopics, "overview-topic-name")[0].textContent, "课程导论");
  assert.equal(elements.overviewEmpty.style.display, "none");
});

test("the 概览 tab shows guidance until a report exists", async () => {
  const { report, elements } = loadPanel();

  await report.adoptLatestStoredReport();

  assert.match(elements.overviewEmpty.textContent, /结束一次学习会话后/);
  assert.equal(elements.overviewEmpty.style.display, "block");
  assert.equal(elements.overviewTopicsSection.style.display, "none");
  assert.equal(elements.overviewQuotesSection.style.display, "none");
});

test("an active session with no report yet keeps the 概览 guidance", () => {
  const { report, elements } = loadPanel();

  report.showSessionMode({
    active: true,
    kind: "replay",
    state: { sessionId: "s_2", status: "active", segments: [], transcriptRecords: [], topics: [] },
  });

  assert.equal(elements.overviewEmpty.style.display, "block");
  assert.equal(elements.overviewTopicsSection.style.display, "none");
});

test("a new active session retires the 概览 report back to guidance", async () => {
  const { report, elements } = loadPanel({
    stored: { report_s_1: readyArtifact("s_1") },
  });

  await report.applyReportPayloadToTab(REPORT_A, "s_1");
  assert.equal(elements.overviewEmpty.style.display, "none");

  report.showSessionMode({
    active: true,
    kind: "replay",
    state: { sessionId: "s_9", status: "active", segments: [], transcriptRecords: [], topics: [] },
  });

  assert.equal(elements.overviewEmpty.style.display, "block");
  assert.equal(elements.overviewTopicsSection.style.display, "none");
});

// --- Timestamp jumps (#31) -----------------------------------------------------

const JUMP_REPORT = {
  topics: [{ start: 75, end: 200, title: "第二段话题", summary: "跳转目标。" }],
  quotes: [{ start: 130, text: "落在 120 秒那条记录上。" }],
  todos: [],
};

function showSessionWithRecords(panel, records) {
  panel.report.showSessionMode({
    active: true,
    kind: "replay",
    state: { sessionId: "s_2", status: "active", segments: [], transcriptRecords: records, topics: [] },
  });
}

test("clicking a Topic time range switches to 逐字稿 and jumps to the matching record", async () => {
  const panel = loadPanel();
  showSessionWithRecords(panel, [
    { start: 0, text: "开场" },
    { start: 75, text: "第二段" },
    { start: 120, text: "第三段" },
  ]);

  await panel.report.applyReportPayloadToTab(JUMP_REPORT, "s_2");
  const topicTime = findDescendants(panel.elements.overviewTopics, "overview-time")[0];
  assert.equal(topicTime.textContent, "[1:15–3:20]");

  topicTime.listeners.click();

  const transcriptTab = panel.selectorResults[".tab"].find((tab) => tab.dataset.tab === "transcript");
  const transcriptPanel = panel.selectorResults[".tab-panel"].find(
    (item) => item.dataset.panel === "transcript",
  );
  assert.equal(transcriptTab.classList.contains("active"), true);
  assert.equal(transcriptPanel.classList.contains("active"), true);

  const target = panel.elements.sessionTranscript.children.find(
    (row) => row.dataset.seconds === "75",
  );
  assert.equal(target.scrollIntoViewCalls, 1);
  // Field-wise compare: the options object was created inside the VM sandbox.
  assert.equal(target.scrollIntoViewArgs?.length, 1);
  assert.equal(target.scrollIntoViewArgs[0]?.behavior, "smooth");
  assert.equal(target.scrollIntoViewArgs[0]?.block, "center");
  assert.equal(target.classList.contains("session-record-jump"), true);
});

test("clicking a quote timestamp jumps to the nearest record at or before it", async () => {
  const panel = loadPanel();
  showSessionWithRecords(panel, [
    { start: 0, text: "开场" },
    { start: 75, text: "第二段" },
    { start: 120, text: "第三段" },
  ]);

  await panel.report.applyReportPayloadToTab(JUMP_REPORT, "s_2");
  const quoteTime = findDescendants(panel.elements.overviewQuotes, "overview-time")[0];
  assert.equal(quoteTime.textContent, "[2:10]");

  quoteTime.listeners.click();

  const target = panel.elements.sessionTranscript.children.find(
    (row) => row.dataset.seconds === "120",
  );
  assert.equal(target.scrollIntoViewCalls, 1, "the 120s record is the nearest at or before 130s");
  const earlier = panel.elements.sessionTranscript.children.find(
    (row) => row.dataset.seconds === "75",
  );
  assert.equal(earlier.scrollIntoViewCalls || 0, 0);
});

test("the jump picks the nearest record at or before the timestamp", () => {
  const panel = loadPanel();
  const container = panel.elementById("sessionTranscript");
  for (const start of [0, 75, 120]) {
    const row = makeElement();
    row.dataset.seconds = String(start);
    container.appendChild(row);
  }

  assert.equal(panel.overview.findSessionRecordForSeconds(container, 0)?.dataset.seconds, "0");
  assert.equal(panel.overview.findSessionRecordForSeconds(container, 75)?.dataset.seconds, "75");
  assert.equal(panel.overview.findSessionRecordForSeconds(container, 130)?.dataset.seconds, "120");
  assert.equal(panel.overview.findSessionRecordForSeconds(container, 1000)?.dataset.seconds, "120");
  assert.equal(panel.overview.findSessionRecordForSeconds(container, -1), null);
  assert.equal(
    panel.overview.findSessionRecordForSeconds(panel.elementById("overviewQuotes"), 10),
    null,
  );
});

test("a timestamp click with no transcript records still switches tabs without scrolling", async () => {
  const panel = loadPanel();
  await panel.report.applyReportPayloadToTab(JUMP_REPORT, "s_2");

  const quoteTime = findDescendants(panel.elements.overviewQuotes, "overview-time")[0];
  quoteTime.listeners.click();

  const transcriptPanel = panel.selectorResults[".tab-panel"].find(
    (item) => item.dataset.panel === "transcript",
  );
  assert.equal(transcriptPanel.classList.contains("active"), true);
  assert.equal(panel.elements.sessionTranscript.children.length, 0);
});

// --- Static wiring -------------------------------------------------------------

test("the 概览 tab is wired in sidepanel.html and sidepanel.js", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  const css = read("sidepanel.css");

  assert.match(html, /<div class="tab-panel" data-panel="overview">/);
  assert.match(html, /id="overviewEmpty"/);
  assert.match(html, /id="overviewTopicsSection"/);
  assert.match(html, /id="overviewTopics"/);
  assert.match(html, /id="overviewQuotesSection"/);
  assert.match(html, /id="overviewQuotes"/);
  assert.doesNotMatch(html, /chapterList|quotesList/);
  // The legacy analysis machinery is gone from the panel.
  assert.doesNotMatch(
    js,
    /analyzeTranscript|isAnalysisLoading|triggerAnalysis|renderAnalysisResults|chapterList|quotesList/,
  );
  // The Overview lists render on the report-funnel re-render.
  assert.match(js, /function renderOverviewTab\(/);
  assert.match(js, /renderOverviewTab\(\);/);
  // The timeline styling and the jump highlight exist.
  assert.match(css, /\.overview-topic-step::after\s*\{/);
  assert.match(css, /\.session-record-jump\s*\{/);
});

// --- Open + download actions --------------------------------------------------

test("open sends the shown session to the report page in a new tab", async () => {
  const { report, elements, createdTabs } = loadPanel({
    stored: { report_s_1: readyArtifact("s_1") },
  });
  await report.applyReportPayloadToTab(REPORT_A, "s_1");
  assert.equal(elements.reportTabActions.style.display, "flex");

  report.openReportInTab();

  assert.equal(createdTabs.length, 1);
  assert.match(createdTabs[0].url, /^chrome-extension:\/\/test\/report\.html\?session=s_1$/);
});

test("downloads use Blob object URLs and session-named files", async () => {
  const { report, createdObjectUrls, createdElements } = loadPanel({
    stored: { report_s_1: readyArtifact("s_1") },
  });
  await report.applyReportPayloadToTab(REPORT_A, "s_1");

  report.downloadReportFile("html");
  report.downloadReportFile("markdown");

  assert.equal(createdObjectUrls.length, 2, "one Blob per download");
  const anchors = createdElements.filter((el) => el.tagName === "a");
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].download, "learning-digest-report-s_1.html");
  assert.equal(anchors[1].download, "learning-digest-report-s_1.md");
  assert.equal(anchors[0].clicked, 1);
  assert.equal(anchors[1].clicked, 1);
});

// --- Static wiring ------------------------------------------------------------

test("the report UI copy names the deliverable 学习纪要 everywhere", () => {
  // The deliverable is a course-content summary: the wording is 学习纪要 in
  // every user-facing string (end-time card, welcome line, settings blurb,
  // store description), never 会话总结/会话纪要, and no meeting vocabulary
  // anywhere in UI copy or the report prompt.
  const uiFiles = ["sidepanel.html", "sidepanel.js", "options.js", "manifest.json"];
  for (const file of uiFiles) {
    assert.doesNotMatch(read(file), /会话总结|会话纪要/, `${file} still says 会话总结/会话纪要`);
    assert.doesNotMatch(read(file), /会议/, `${file} contains meeting vocabulary`);
  }
  for (const file of ["prompts/session-report.md", "prompts/topic-tick.md"]) {
    // The guard line itself lists the banned words; exclude it, then require
    // the body to be free of meeting vocabulary.
    const body = read(file)
      .split("\n")
      .filter((line) => !line.includes("「会议」") && !line.includes("不是会议纪要"))
      .join("\n");
    assert.doesNotMatch(body, /与会|议程|决议|会议/, `${file} contains meeting vocabulary outside its guard line`);
    assert.match(read(file), /不是会议纪要/, `${file} does not frame the deliverable against meeting minutes`);
  }
  assert.match(read("prompts/session-report.md"), /学习纪要/);
});

test("the 纪要 tab is wired in sidepanel.html and sidepanel.js", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");

  assert.match(html, /<button class="tab" data-tab="report">纪要<\/button>/);
  assert.match(html, /<div class="tab-panel" data-panel="report">/);
  assert.match(html, /id="reportTabHint"/);
  assert.match(html, /id="reportTabActions"/);
  assert.match(html, /id="reportOpenBtn"[\s\S]*?在新标签页打开/);
  assert.match(html, /id="reportDownloadHtmlBtn"[\s\S]*?下载 HTML/);
  assert.match(html, /id="reportDownloadMdBtn"[\s\S]*?下载 Markdown/);
  assert.match(html, /id="reportRetryBtn"[\s\S]*?重试/);
  // The renderer loads before the panel script that uses it.
  assert.match(
    html,
    /<script src="report-render\.js"><\/script>\s*<script src="sidepanel\.js">/,
  );
  // The actions are bound in the panel's event setup.
  assert.match(
    js,
    /getElementById\("reportOpenBtn"\)\s*\??\.\s*addEventListener\("click", openReportInTab\)/,
  );
  assert.match(
    js,
    /getElementById\("reportRetryBtn"\)\s*\??\.\s*addEventListener\("click", retryReportFromTab\)/,
  );
  assert.match(js, /setupReportTab\(\)/);
  assert.match(js, /void adoptLatestStoredReport\(\)/);
  // The tab hook feeds every report arrival into the 纪要 tab.
  assert.match(js, /applyReportPayloadToTab\(report, sessionId\)/);
});
