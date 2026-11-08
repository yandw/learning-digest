/**
 * Panel information architecture (0.1.37): the 逐字稿 tab renders the
 * transcript only, the 概览 tab carries the live Topic timeline plus the
 * report's quotes, and the 笔记 tab works during a Session (selection save,
 * 本会话 filter, jumpable stamps). Tested through the same mock-document VM
 * seam as tests/report-panel.test.js.
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

const escapeForMock = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function makeElement(id = "") {
  let textValue = "";
  let classSet = new Set();
  const element = {
    id,
    tagName: "",
    nodeType: 1,
    dataset: {},
    style: {},
    children: [],
    listeners: {},
    innerHTML: "",
    disabled: false,
    href: "",
    download: "",
    type: "",
    title: "",
    attributes: {},
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return element.attributes[name];
    },
    // DOM semantics the panel code relies on: setting textContent replaces
    // the children (an empty value clears them) and innerHTML mirrors the
    // escaped text, which is what escapeHtml reads back.
    set textContent(value) {
      textValue = String(value);
      element.children.length = 0;
      element.innerHTML = textValue === "" ? "" : escapeForMock(textValue);
    },
    get textContent() {
      return textValue;
    },
    set className(value) {
      classSet = new Set(String(value).split(/\s+/).filter(Boolean));
    },
    get className() {
      return Array.from(classSet).join(" ");
    },
    classList: {
      add(name) {
        classSet.add(name);
      },
      remove(name) {
        classSet.delete(name);
      },
      toggle(name, force) {
        const has = classSet.has(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next) classSet.add(name);
        else classSet.delete(name);
        return next;
      },
      contains(name) {
        return classSet.has(name);
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
    // Self-only match: the mock keeps no parent links, and every test
    // selection is anchored on the row element itself.
    closest(selector) {
      const classes = String(selector)
        .split(",")
        .map((name) => name.trim().replace(/^\./, ""));
      return classes.some((name) => element.classList.contains(name))
        ? element
        : null;
    },
    contains(node) {
      if (node === element) return true;
      return element.children.some((child) => child.contains(node));
    },
    querySelector(selector) {
      const match = /^\.([\w-]+)$/.exec(String(selector));
      if (!match) return null;
      const found = findDescendants(element, match[1])[0];
      if (found) return found;
      // The mock does not parse innerHTML, so template children do not exist
      // as elements; a stand-in keeps wiring code runnable.
      const standIn = makeElement(match[1]);
      element.children.push(standIn);
      return standIn;
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
 * querySelector beyond the stand-in above, and textContent is a plain
 * property (never derived from children), so assertions walk children
 * recursively instead.
 */
function findDescendants(element, className, found = []) {
  for (const child of element.children || []) {
    if (child.classList.contains(className)) found.push(child);
    findDescendants(child, className, found);
  }
  return found;
}

/**
 * Loads sidepanel.js in a mock-document sandbox and returns the testing
 * helpers plus everything a test can assert on. Extends the report-panel
 * harness with recorded document listeners, a settable selection, and the
 * real settings module so the interval hint reads the stored value.
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
  const createdElements = [];
  const docListeners = {};
  const alerts = [];
  let selection = null;
  let nextResponse = { success: true };

  const sandbox = {
    console,
    Blob,
    TextDecoder,
    TextEncoder,
    AbortController,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    requestAnimationFrame: (fn) => fn(),
    window: {
      getSelection: () => selection,
      scrollY: 0,
      close() {},
      alert: (message) => {
        alerts.push(String(message));
      },
      addEventListener() {},
    },
    document: {
      getElementById: elementById,
      createElement: (tag) => {
        const el = makeElement();
        el.tagName = tag;
        createdElements.push(el);
        return el;
      },
      querySelector: (selector) => {
        // resultTabIsActive probes the active panel with this compound
        // selector; evaluate it against the recorded tab-panel elements.
        const panelMatch = /^\.tab-panel\[data-panel="([\w-]+)"\]\.active$/.exec(
          String(selector),
        );
        if (panelMatch) {
          const panel = selectorResults[".tab-panel"].find(
            (item) => item.dataset.panel === panelMatch[1],
          );
          return panel && panel.classList.contains("active") ? panel : null;
        }
        return null;
      },
      querySelectorAll: (selector) => selectorResults[selector] || [],
      addEventListener: (type, handler) => {
        docListeners[type] = handler;
      },
      body: makeElement("body"),
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: (message) => {
          sentMessages.push(message);
          return Promise.resolve(
            typeof nextResponse === "function" ? nextResponse(message) : nextResponse,
          );
        },
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: {
        create: () => Promise.resolve({ id: 9 }),
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
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
    YTD_SETTINGS: require("../settings.js"),
    YTD_REPORT_RENDER: require("../report-render.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return {
    report: sandbox.__YTD_REPORT_TESTING__,
    transcript: sandbox.__YTD_TRANSCRIPT_TESTING__,
    session: sandbox.__YTD_SESSION_TESTING__,
    elements,
    elementById,
    selectorResults,
    createdElements,
    sentMessages,
    docListeners,
    alerts,
    flush,
    setSelection: (value) => {
      selection = value;
    },
    setNextResponse: (response) => {
      nextResponse = response;
    },
  };
}

function activeSessionState(overrides = {}) {
  return {
    sessionId: "s_1",
    status: "active",
    title: "混合动力入门",
    segments: [],
    transcriptRecords: [{ start: 0, text: "开场" }, { start: 75, text: "第二段" }],
    topics: [],
    ...overrides,
  };
}

function showSession(panel, state) {
  panel.report.showSessionMode({ active: true, kind: "replay", state });
}

// --- 逐字稿 purity -----------------------------------------------------------

test("the session view renders the realtime draft box above the transcript", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");

  assert.match(
    html,
    /<div id="sessionView" class="session-view" style="display: none">\s*<div class="session-realtime" id="sessionRealtimeBox" style="display: none">\s*<span class="session-realtime-badge" id="sessionRealtimeBadge">实时转写中<\/span>\s*<span class="session-realtime-draft" id="sessionRealtimeDraft"><\/span>\s*<\/div>\s*<div class="session-transcript" id="sessionTranscript"><\/div>\s*<\/div>/,
    "the realtime draft box sits above the transcript inside the session view",
  );
  assert.doesNotMatch(html, /id="sessionSummary"|id="sessionDigest"/);
  // The card renderers and their containers are gone from the panel logic.
  assert.doesNotMatch(
    js,
    /renderSessionReport|renderReportTopics|renderReportQuotes|renderReportTodos|renderReportError|appendReportHeading/,
  );
  assert.doesNotMatch(js, /sessionSummary|sessionDigest/);
  // The no-transcript outcome is the 纪要 tab's informational hint now.
  assert.match(js, /未捕获到逐字稿，未生成学习纪要。/);
  // The 纪要 tab funnel still feeds every report arrival.
  assert.match(js, /applyReportPayloadToTab\(report, sessionId\)/);
});

// --- 概览: live Topic timeline + quotes --------------------------------------

test("the first-topic hint names the configured interval until the first tick", async () => {
  const panel = loadPanel({ stored: { ytd_settings: { summaryIntervalMinutes: 30 } } });

  showSession(panel, activeSessionState());

  // The synchronous first paint still uses the default; the stored value
  // lands a moment later and refreshes the hint.
  assert.match(panel.elements.overviewEmpty.textContent, /第一个话题段将在约/);
  await panel.flush();

  assert.match(
    panel.elements.overviewEmpty.textContent,
    /第一个话题段将在约 30 分钟后出现/,
  );
  assert.equal(panel.elements.overviewEmpty.style.display, "block");
  assert.equal(panel.elements.overviewTopicsSection.style.display, "none");
  assert.equal(panel.elements.overviewQuotesSection.style.display, "none");
});

test("live Topic ticks render into the 概览 timeline with jumpable timestamps", () => {
  const panel = loadPanel();
  showSession(panel, activeSessionState());

  showSession(
    panel,
    activeSessionState({
      topics: [
        { start: 0, end: 60, title: "导入", text: "老师介绍了课程目标。" },
        { start: 75, end: 120, title: "深入", text: "续写内容。", continuation: true },
      ],
    }),
  );

  const rows = panel.elements.overviewTopics.children;
  assert.equal(rows.length, 2);
  const times = findDescendants(panel.elements.overviewTopics, "overview-time");
  assert.equal(times[0].textContent, "[0:00–1:00]");
  assert.equal(times[1].textContent, "[1:15–2:00]");
  const names = findDescendants(panel.elements.overviewTopics, "overview-topic-name");
  assert.equal(names[0].textContent, "导入");
  assert.equal(names[1].textContent, "续 深入", "a live continuation keeps the 续 marker");
  // Live ticks carry `text`; the renderer normalizes it into the summary row.
  const summaries = findDescendants(panel.elements.overviewTopics, "overview-topic-summary");
  assert.equal(summaries[0].textContent, "老师介绍了课程目标。");
  assert.equal(summaries[1].textContent, "续写内容。");

  assert.equal(panel.elements.overviewEmpty.style.display, "none");
  assert.equal(panel.elements.overviewTopicsSection.style.display, "block");
  // Quotes only exist after the report is generated.
  assert.equal(panel.elements.overviewQuotesSection.style.display, "none");

  times[1].listeners.click();
  const target = panel.elements.sessionTranscript.children.find(
    (row) => row.dataset.seconds === "75",
  );
  assert.equal(target.scrollIntoViewCalls, 1);
  assert.equal(target.classList.contains("session-record-jump"), true);
  const transcriptPanel = panel.selectorResults[".tab-panel"].find(
    (item) => item.dataset.panel === "transcript",
  );
  assert.equal(transcriptPanel.classList.contains("active"), true);
});

test("quotes appear only when the report arrives and its Topics replace the live ones", async () => {
  const panel = loadPanel();
  showSession(
    panel,
    activeSessionState({
      topics: [{ start: 0, end: 60, title: "直播中的话题", text: "实时摘要。" }],
    }),
  );
  assert.equal(
    findDescendants(panel.elements.overviewTopics, "overview-topic-name")[0].textContent,
    "直播中的话题",
  );
  assert.equal(panel.elements.overviewQuotesSection.style.display, "none");

  await panel.report.applyReportPayloadToTab(REPORT_A, "s_1");

  const names = findDescendants(panel.elements.overviewTopics, "overview-topic-name");
  assert.equal(names[0].textContent, "课程导论", "the final report Topics replace the live ones");
  assert.equal(panel.elements.overviewQuotesSection.style.display, "block");
  assert.equal(
    findDescendants(panel.elements.overviewQuotes, "overview-quote-body")[0].textContent,
    "学习是一场旅程。",
  );

  // A late live tick for the same Session (the ended state arriving after
  // the report) must not clobber the adopted report's Overview.
  showSession(
    panel,
    activeSessionState({
      topics: [{ start: 0, end: 60, title: "迟到的实时话题", text: "不应出现。" }],
    }),
  );
  assert.equal(
    findDescendants(panel.elements.overviewTopics, "overview-topic-name")[0].textContent,
    "课程导论",
  );
  assert.equal(panel.elements.overviewQuotesSection.style.display, "block");
});

// --- 笔记 in session mode ------------------------------------------------------

test("selecting session transcript text saves a note under the session id", async () => {
  const panel = loadPanel();
  showSession(panel, activeSessionState());
  panel.session.setupExplainFeature();

  const row = panel.elements.sessionTranscript.children.find(
    (item) => item.dataset.seconds === "75",
  );
  panel.setSelection({
    toString: () => "其中某句话",
    rangeCount: 1,
    getRangeAt: () => ({
      startContainer: row,
      endContainer: row,
      getBoundingClientRect: () => ({ bottom: 10, left: 5, width: 4 }),
    }),
  });

  panel.docListeners.mouseup();

  const tooltip = panel.createdElements.find((el) => el.id === "explainTooltip");
  assert.equal(tooltip.style.display, "flex", "the toolbar shows for a session selection");
  const noteBtn = tooltip.children.find((el) =>
    el.classList.contains("selection-note-btn"),
  );
  assert.equal(noteBtn.textContent, "笔记");

  await noteBtn.listeners.click({
    preventDefault() {},
    stopPropagation() {},
    currentTarget: noteBtn,
  });

  const save = panel.sentMessages.find((message) => message.action === "saveNote");
  assert.equal(save.videoId, "s_1", "session notes save under the Session id");
  assert.equal(save.videoTitle, "混合动力入门", "the course title rides along");
  assert.equal(save.timestamp, 75);
  assert.equal(save.selectedText, "其中某句话");
  const refresh = panel.sentMessages.find((message) => message.action === "getNotes");
  assert.equal(refresh.videoId, "s_1", "the list refreshes scoped to the session");
  assert.equal(noteBtn.textContent, "已保存");
});

test("session notes render a jumpable stamp; legacy notes stay plain", () => {
  const panel = loadPanel();
  showSession(panel, activeSessionState());

  panel.session.renderNotes(
    [
      {
        id: "n_1",
        videoId: "s_1",
        timestamp: "1:15",
        timestampSeconds: 75,
        text: "会话里的笔记",
        videoTitle: "混合动力入门",
      },
      {
        id: "n_2",
        videoId: "vid_legacy",
        timestamp: "0:30",
        timestampSeconds: 30,
        text: "旧格式笔记",
        videoTitle: "旧视频",
      },
    ],
    null,
  );

  const rows = panel.elements.notesList.children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].innerHTML, /class="note-timestamp note-timestamp-jump"/);
  assert.match(rows[0].innerHTML, /data-seconds="75"/);
  assert.match(rows[0].innerHTML, /混合动力入门/, "the all-notes view shows each title");
  assert.match(rows[1].innerHTML, /class="note-timestamp"/);
  assert.doesNotMatch(rows[1].innerHTML, /note-timestamp-jump/, "legacy stamps stay plain");

  const stamp = {
    closest: (selector) => (selector === ".note-timestamp-jump" ? stamp : null),
    dataset: { seconds: "75" },
  };
  panel.session.handleNotesListClick({ target: stamp });

  const target = panel.elements.sessionTranscript.children.find(
    (item) => item.dataset.seconds === "75",
  );
  assert.equal(target.scrollIntoViewCalls, 1);
  const transcriptPanel = panel.selectorResults[".tab-panel"].find(
    (item) => item.dataset.panel === "transcript",
  );
  assert.equal(transcriptPanel.classList.contains("active"), true);
});

test("the notes empty state points at the selection toolbar", async () => {
  const panel = loadPanel();

  await panel.session.loadNotes("s_1");

  assert.equal(panel.elements.notesIntro.style.display, "block");
  assert.equal(
    panel.elements.notesIntro.textContent,
    "在逐字稿中选中文字，点击浮条上的「笔记」即可保存。",
  );
});

test("本会话 filters notes by the current session id", async () => {
  const panel = loadPanel();
  showSession(panel, activeSessionState());

  await panel.session.applyNotesFilter(false);
  let get = panel.sentMessages.find((message) => message.action === "getNotes");
  assert.equal(get.videoId, "s_1");
  assert.equal(panel.elements.notesFilterThis.classList.contains("active"), true);
  assert.equal(panel.elements.notesFilterAll.classList.contains("active"), false);

  await panel.session.applyNotesFilter(true);
  get = panel.sentMessages.filter((message) => message.action === "getNotes").pop();
  assert.equal(get.videoId, null);
  assert.equal(panel.elements.notesFilterAll.classList.contains("active"), true);
});

test("with a legacy digest loaded, 本会话 still scopes by video id", async () => {
  const panel = loadPanel({
    stored: {
      digest_vid_legacy: {
        transcript: [{ start: 0, duration: 2, text: "旧视频内容" }],
        transcriptText: "旧视频内容",
        timestamp: Date.now(),
      },
    },
  });

  await panel.session.startDigest("vid_legacy", "https://example.com");
  await panel.session.applyNotesFilter(false);

  const get = panel.sentMessages.find((message) => message.action === "getNotes");
  assert.equal(get.videoId, "vid_legacy");
});

test("the 笔记 tab is reachable during a session", () => {
  const panel = loadPanel();
  showSession(panel, activeSessionState());

  assert.equal(panel.elements.tabsNav.style.display, "flex");
  const notesTab = panel.selectorResults[".tab"].find((tab) => tab.dataset.tab === "notes");
  assert.equal(notesTab.disabled, false);
  assert.equal(notesTab.title, "");

  panel.transcript.switchTab("notes");
  const notesPanel = panel.selectorResults[".tab-panel"].find(
    (item) => item.dataset.panel === "notes",
  );
  assert.equal(notesPanel.classList.contains("active"), true);
});

test("segment wait copy follows the configured Segment length", () => {
  const panel = loadPanel({ stored: {} });

  // 0.1.39 default: 30-second Segments keep the first transcript row close.
  assert.equal(panel.session.segmentLengthLabel(), "30 秒");

  panel.session.setSegmentLengthForCopy(600);
  assert.equal(panel.session.segmentLengthLabel(), "10 分钟");

  panel.session.setSegmentLengthForCopy(45);
  assert.equal(panel.session.segmentLengthLabel(), "45 秒");
});

test("the session status line names the live timeline mode (#48)", () => {
  const panel = loadPanel({ stored: {} });

  // Wallclock (live or not-yet-anchored): the transcript counts elapsed time.
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: activeSessionState(),
    timestampKind: "wallclock",
  });
  assert.match(
    panel.elementById("sessionStatus").textContent,
    /直播计时（墙钟）/,
  );

  // Anchored by the probe: the transcript follows the video position.
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: activeSessionState(),
    timestampKind: "video",
  });
  assert.match(
    panel.elementById("sessionStatus").textContent,
    /已对齐视频时间轴/,
  );
  assert.doesNotMatch(
    panel.elementById("sessionStatus").textContent,
    /直播计时/,
  );
});

test("the Session view shows on the 逐字稿 tab only", () => {
  const panel = loadPanel({ stored: {} });

  // A fresh Session surfaces the 纪要 tab (story 7): the generating hint
  // owns the view and the transcript must not stack underneath it.
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: { sessionId: "s_view", status: "active" },
  });
  const view = panel.elementById("sessionView");
  assert.equal(view.style.display, "none", "the surfaced 纪要 tab has no transcript underneath");

  panel.transcript.switchTab("transcript");
  assert.equal(view.style.display, "", "the 逐字稿 tab shows the Session view");

  panel.transcript.switchTab("overview");
  assert.equal(view.style.display, "none", "概览 must not stack the transcript");
  panel.transcript.switchTab("report");
  assert.equal(view.style.display, "none", "纪要 must not stack the transcript");
  panel.transcript.switchTab("notes");
  assert.equal(view.style.display, "none", "笔记 must not stack the transcript");
  panel.transcript.switchTab("transcript");
  assert.equal(view.style.display, "", "switching back restores the transcript");
});

test("the end button walks the 结束学习 → 开始总结 → hidden lifecycle", async () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: { sessionId: "s_end", status: "active" },
  });
  const endBtn = panel.elementById("endLearningBtn");
  assert.equal(endBtn.textContent, "结束学习");
  assert.equal(endBtn.disabled, false);

  // Ending without a report in the response: the button flips to a disabled
  // 开始总结 while the summary pass is pending.
  panel.setNextResponse(() => ({
    state: { sessionId: "s_end", status: "ended" },
  }));
  await panel.session.endLearning();
  assert.equal(endBtn.textContent, "开始总结");
  assert.equal(endBtn.disabled, true, "开始总结 is not clickable while generating");

  // The failed pass keeps the button as an enabled retry affordance.
  panel.session.adoptSessionReport(
    { error: "报告长度受限，生成未完成，请重试。" },
    "s_end",
  );
  assert.equal(endBtn.textContent, "开始总结");
  assert.equal(endBtn.disabled, false, "开始总结 is clickable to retry");

  // A successful report hides the button entirely.
  panel.session.adoptSessionReport(
    { topics: [{ start: 0, end: 30, title: "开场", summary: "内容。" }], quotes: [], todos: [] },
    "s_end",
  );
  assert.equal(endBtn.style.display, "none");
});

test("clicking 开始总结 after a failed pass sends regenerateReport", async () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: { sessionId: "s_retry", status: "active" },
  });
  panel.session.showSessionMode({
    active: false,
    kind: "live",
    state: null,
  });
  panel.session.adoptSessionReport({ error: "生成失败" }, "s_retry");

  panel.setNextResponse(() => ({
    report: { topics: [{ start: 0, end: 30, title: "开场", summary: "内容。" }] },
  }));
  await panel.session.endLearning();

  const regenerate = panel.sentMessages.find(
    (message) => message.action === "regenerateReport",
  );
  assert.ok(regenerate, "the retry funnels through regenerateReport");
  assert.equal(regenerate.sessionId, "s_retry");
  const endBtn = panel.elementById("endLearningBtn");
  assert.equal(endBtn.style.display, "none", "a successful retry hides the button");
});

// --- 转写模式 copy (#45): start toast + transcript empty state ----------------

test("the start toast announces realtime transcription for realtime Sessions", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: { sessionId: "s_toast_rt", status: "active" },
    transcribeMode: "realtime",
  });

  const toast = panel.elementById("recordingToast");
  assert.ok(toast, "the recording toast element exists");
  assert.equal(toast.textContent, "已开始录制 · 实时转写已开启");
});

test("the start toast keeps the Segment wait copy for segment Sessions", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.setSegmentLengthForCopy(30);
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: { sessionId: "s_toast_seg", status: "active" },
    transcribeMode: "segment",
  });

  const toast = panel.elementById("recordingToast");
  assert.ok(toast, "the recording toast element exists");
  assert.equal(toast.textContent, "已开始录制 · 逐字稿将在约 30 秒后出现");
});

test("an absent transcription mode keeps the Segment wait toast", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: { sessionId: "s_toast_absent", status: "active" },
  });

  const toast = panel.elementById("recordingToast");
  assert.equal(toast.textContent, "已开始录制 · 逐字稿将在约 30 秒后出现");
});

// --- 实时转写 live box (#47): the draft above the transcript ------------------

test("the realtime draft box shows the badge and fully replaces the draft on every partial", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: activeSessionState(),
    transcribeMode: "realtime",
  });

  const box = panel.elementById("sessionRealtimeBox");
  assert.equal(box.style.display, "", "the box shows during an active realtime Session");
  // The badge label itself is static markup, asserted by the HTML test above.

  panel.session.handleSessionUpdateMessage(
    { action: "sessionUpdate", sessionId: "s_1", realtimePartial: { text: "今天我们讲" } },
    () => {},
  );
  assert.equal(
    panel.elementById("sessionRealtimeDraft").textContent,
    "今天我们讲",
  );

  panel.session.handleSessionUpdateMessage(
    {
      action: "sessionUpdate",
      sessionId: "s_1",
      realtimePartial: { text: "今天我们讲混合动力。" },
    },
    () => {},
  );
  assert.equal(
    panel.elementById("sessionRealtimeDraft").textContent,
    "今天我们讲混合动力。",
    "each partial fully replaces the draft",
  );
});

test("a finalized utterance appends a normal row and clears the draft", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: activeSessionState(),
    transcribeMode: "realtime",
  });
  panel.session.handleSessionUpdateMessage(
    { action: "sessionUpdate", sessionId: "s_1", realtimePartial: { text: "还没定稿的话" } },
    () => {},
  );

  panel.session.handleSessionUpdateMessage(
    {
      action: "sessionUpdate",
      sessionId: "s_1",
      state: activeSessionState({
        transcriptRecords: [
          { start: 0, text: "开场" },
          { start: 75, text: "第二段" },
          { start: 90, text: "定稿的一句话。", duration: 4 },
        ],
      }),
    },
    () => {},
  );

  const transcript = panel.elementById("sessionTranscript");
  const newRow = transcript.children.find((row) => row.dataset.seconds === "90");
  assert.ok(newRow, "the utterance renders as a normal record row");
  assert.equal(newRow.classList.contains("session-record-failed"), false);
  assert.equal(
    panel.elementById("sessionRealtimeDraft").textContent,
    "",
    "the draft cleared once the record landed",
  );
});

test("the realtime draft box stays hidden for segment Sessions and after the Session ends", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: {
      sessionId: "s_seg",
      status: "active",
      segments: [],
      transcriptRecords: [],
    },
    transcribeMode: "segment",
  });
  assert.equal(
    panel.elementById("sessionRealtimeBox").style.display,
    "none",
    "a segment Session has no draft box",
  );

  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: activeSessionState(),
    transcribeMode: "realtime",
  });
  assert.equal(panel.elementById("sessionRealtimeBox").style.display, "");

  panel.session.showSessionMode({ active: false, kind: "live", state: null });
  assert.equal(
    panel.elementById("sessionRealtimeBox").style.display,
    "none",
    "ending the Session hides the box",
  );
});

test("a realtime Session shows no pending rows; the draft box is the waiting affordance", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: {
      sessionId: "s_empty_rt",
      status: "active",
      segments: [],
      transcriptRecords: [],
    },
    transcribeMode: "realtime",
  });

  const transcript = panel.elementById("sessionTranscript");
  assert.equal(
    findDescendants(transcript, "session-pending").length,
    0,
    "no spinner rows in realtime mode",
  );
  assert.equal(
    panel.elementById("sessionRealtimeBox").style.display,
    "",
    "the live box replaces the Segment-wait affordance",
  );
});

test("a realtimeError notice alerts and takes the status line, like captureEnded", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: activeSessionState(),
    transcribeMode: "realtime",
  });

  panel.session.handleSessionUpdateMessage(
    {
      action: "sessionUpdate",
      sessionId: "s_1",
      realtimeNotice: { message: "实时转写连接已断开" },
    },
    () => {},
  );

  assert.deepEqual(panel.alerts, ["实时转写连接已断开"]);
  assert.equal(
    panel.elementById("sessionStatus").textContent,
    "实时转写连接已断开",
  );
});

test("the transcript empty state keeps the Segment wait copy in segment mode", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.setSegmentLengthForCopy(30);
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: {
      sessionId: "s_empty_seg",
      status: "active",
      segments: [],
      transcriptRecords: [],
    },
    transcribeMode: "segment",
  });

  const transcript = panel.elementById("sessionTranscript");
  const pendingRow = findDescendants(transcript, "session-pending")[0];
  const text = findDescendants(pendingRow, "session-record-text")[0];
  assert.equal(text.textContent, "录制中，第一段逐字稿约 30 秒 后出现…");
});
