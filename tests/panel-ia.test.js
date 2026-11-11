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
    insertBefore(child, ref) {
      // DOM semantics: re-inserting an existing child moves it, not copies.
      const existing = element.children.indexOf(child);
      if (existing !== -1) element.children.splice(existing, 1);
      const at = ref ? element.children.indexOf(ref) : -1;
      if (at === -1) element.children.push(child);
      else element.children.splice(at, 0, child);
      return child;
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
function loadPanel({ stored = {}, storageGetImpl = null } = {}) {
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
  const runtimeMessageListeners = [];
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
      YTD_SOURCE_PLATFORMS: require("../source-platforms.js"),
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
        onMessage: {
          addListener: (listener) => {
            runtimeMessageListeners.push(listener);
          },
        },
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
        query: async () => [{ id: 7, url: "https://example.com/course" }],
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
      },
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (storageGetImpl) return storageGetImpl(key, stored);
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
    YTD_SESSION_PIPELINE: require("../session-pipeline.js"),
    YTD_SESSION_TIMELINE: require("../session-timeline.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return {
    report: sandbox.__YTD_REPORT_TESTING__,
    transcript: sandbox.__YTD_TRANSCRIPT_TESTING__,
    session: sandbox.__YTD_SESSION_TESTING__,
    course: sandbox.__YTD_COURSE_TESTING__,
    auth: sandbox.__YTD_AUTH_TESTING__,
    elements,
    elementById,
    selectorResults,
    createdElements,
    sentMessages,
    docListeners,
    runtimeMessageListeners,
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

test("the session view renders the transcript directly (no realtime draft box)", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");

  // Ticket 2.4 (D10): the realtime draft box (#47) is retired with the
  // local transcription path — the transcript is the only child.
  assert.doesNotMatch(html, /sessionRealtimeBox|session-realtime/);
  assert.doesNotMatch(js, /renderRealtimeDraft|realtimeDraft|realtimePartial|realtimeNotice/);
  assert.match(
    html,
    /<div id="sessionView" class="session-view" style="display: none">\s*<div class="session-transcript" id="sessionTranscript"><\/div>\s*<\/div>/,
    "the transcript is the session view's only child",
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

// --- 逐字稿 timeline ordering ----------------------------------------------

test("session transcript rows follow video time, placing a late fill before later records", () => {
  const panel = loadPanel();
  showSession(
    panel,
    activeSessionState({
      transcriptRecords: [
        { start: 0, text: "开场" },
        { start: 600, text: "十分钟处" },
      ],
    }),
  );

  // A re-watched range's fill arrives after the records that came later.
  showSession(
    panel,
    activeSessionState({
      transcriptRecords: [
        { start: 0, text: "开场" },
        { start: 600, text: "十分钟处" },
        { start: 300, text: "五分钟补转" },
      ],
    }),
  );

  const texts = panel.elements.sessionTranscript.children
    .filter((row) => row.classList.contains("session-record"))
    .map((row) => row.children[1].textContent);

  assert.deepEqual(texts, ["开场", "五分钟补转", "十分钟处"]);
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

  // Auto-create the tab bar element (the mock document only materializes
  // elements on getElementById; the real HTML always has it).
  panel.elementById("tabsNav");
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

test("panel startup waits for a stored 15-second setting before the first wait row renders", async () => {
  let releaseSettings;
  let delayFirstSettingsRead = true;
  const settingsGate = new Promise((resolve) => {
    releaseSettings = resolve;
  });
  const panel = loadPanel({
    stored: { ytd_settings: { segmentLengthSeconds: 15 } },
    storageGetImpl: (key, stored) => {
      if (key === "ytd_settings" && delayFirstSettingsRead) {
        delayFirstSettingsRead = false;
        return settingsGate.then(() => ({ ytd_settings: stored[key] }));
      }
      if (key === null) return Promise.resolve({ ...stored });
      return Promise.resolve({ [key]: stored[key] });
    },
  });
  const state = activeSessionState({ segments: [], transcriptRecords: [] });
  panel.setNextResponse((message) => {
    if (message.action === "checkConfig") return { hasAiKey: true };
    // P6: the startup gate probe — the linked learner continues into the
    // session UI this test asserts on.
    if (message.action === "checkAuth") return { authorized: true };
    if (message.action === "getSessionState") {
      return {
        active: true,
        sessionId: state.sessionId,
        kind: "replay",
        timestampKind: "video",
        capturePath: "asr",
        startedAtMs: 1_700_000_000_000,
        state,
      };
    }
    return { success: true };
  });

  const initializing = panel.docListeners.DOMContentLoaded();
  // Let the current startup reach its first Session render while the settings
  // read is still pending, reproducing the real Chrome storage race.
  await panel.flush();
  await panel.flush();
  releaseSettings();
  await initializing;
  await panel.flush();

  const transcript = panel.elementById("sessionTranscript");
  const pendingRow = findDescendants(transcript, "session-pending")[0];
  const text = findDescendants(pendingRow, "session-record-text")[0];
  assert.equal(text.textContent, "录制中，第一段逐字稿约 15 秒 后出现…");
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

test("the active status line tells when transcription started (0.1.55)", () => {
  const panel = loadPanel({ stored: {} });
  const startedAtMs = new Date(2026, 10, 9, 14, 3).getTime();
  const expected = `${String(new Date(startedAtMs).getHours()).padStart(2, "0")}:${String(
    new Date(startedAtMs).getMinutes(),
  ).padStart(2, "0")}`;

  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState(),
    timestampKind: "video",
    startedAtMs,
  });
  assert.match(
    panel.elementById("sessionStatus").textContent,
    new RegExp(`转写中 · 开始于 ${expected}`),
  );
});

test("the status line falls back to a dash without a start timestamp (0.1.55)", () => {
  const panel = loadPanel({ stored: {} });

  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState(),
    timestampKind: "video",
  });
  assert.match(
    panel.elementById("sessionStatus").textContent,
    /转写中 · 开始于 —/,
  );
});

test("an idle recognized page shows the start hint instead of a dead button (0.1.55)", () => {
  const panel = loadPanel({ stored: {} });

  // Idle on a recognized learning page: the hint points at the toolbar icon
  // (the only legal capture entry point) and the status says not started.
  panel.session.showSessionMode({ active: false, kind: "replay", state: null });
  assert.equal(panel.elementById("startLearningHint").style.display, "");
  assert.match(panel.elementById("sessionStatus").textContent, /未开始转写/);

  // A live Session hides the hint and keeps the end button instead.
  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState(),
    timestampKind: "video",
    startedAtMs: Date.now(),
  });
  assert.equal(panel.elementById("startLearningHint").style.display, "none");

  // An unrecognized page: no session bar content at all.
  panel.session.showSessionMode({ active: false, kind: "none", state: null });
  assert.equal(panel.elementById("startLearningHint").style.display, "none");
});

test("formatSessionClock renders HH:MM and a dash for garbage (0.1.55)", () => {
  const panel = loadPanel({ stored: {} });
  const at = new Date(2026, 0, 5, 9, 7).getTime();
  assert.equal(panel.session.formatSessionClock(at), "09:07");
  assert.equal(panel.session.formatSessionClock(0), "—");
  assert.equal(panel.session.formatSessionClock(NaN), "—");
  assert.equal(panel.session.formatSessionClock(undefined), "—");
});

test("the clear button retires an ended Session from the panel (0.1.55)", async () => {
  const panel = loadPanel({ stored: {} });

  // An ended Session still on screen: the clear button sits in the bar.
  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState(),
    timestampKind: "video",
    startedAtMs: Date.now(),
  });
  panel.session.showSessionMode({ active: false, kind: "replay", state: null });
  assert.equal(panel.elementById("clearSessionBtn").style.display, "");

  // A live Session never offers it.
  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState(),
    timestampKind: "video",
    startedAtMs: Date.now(),
  });
  assert.equal(panel.elementById("clearSessionBtn").style.display, "none");

  // Idle again, then clear: the request names the Session and the panel
  // wipes its rows and ids without waiting for the next poll.
  panel.session.showSessionMode({ active: false, kind: "replay", state: null });
  await panel.session.clearSessionRecord();
  assert.ok(
    panel.sentMessages.some(
      (message) =>
        message.action === "clearSessionRecord" && message.sessionId === "s_1",
    ),
    "the worker receives the delete request",
  );
  assert.equal(
    panel.elementById("clearSessionBtn").style.display,
    "none",
    "the button retires with the Session",
  );
  assert.equal(panel.elementById("sessionTranscript").textContent, "");
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

// --- transcript path copy (Ticket 2.4/2.5): start toast + transcript empty state

test("the start toast keeps the Segment wait copy for the ASR path", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.setSegmentLengthForCopy(30);
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: { sessionId: "s_toast_seg", status: "active" },
    capturePath: "asr",
  });

  const toast = panel.elementById("recordingToast");
  assert.ok(toast, "the recording toast element exists");
  assert.equal(toast.textContent, "已开始录制 · 逐字稿将在约 30 秒后出现");
});

test("an absent capture path keeps the Segment wait toast", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.setSegmentLengthForCopy(30);
  panel.session.showSessionMode({
    active: true,
    kind: "live",
    state: { sessionId: "s_toast_absent", status: "active" },
  });

  const toast = panel.elementById("recordingToast");
  assert.equal(toast.textContent, "已开始录制 · 逐字稿将在约 30 秒后出现");
});

// --- the ASR path's pending rows (Ticket 2.4): local + server view ------------

test("the transcript renders the server view's pendingSegments as 转写中 rows", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState({
      segments: [
        { id: "seg-0", start: 0, duration: 30, status: "done" },
        { id: "seg-1", start: 30, duration: 30, status: "pending" },
      ],
      transcriptRecords: [{ start: 0, text: "第一段结果" }],
      // The §3.5 poll's pending: the Segment whose transcription is still
      // running server-side (its local twin settled done at upload ack).
      pendingSegments: [
        { id: "srv_2", start: 60, duration: 30, status: "pending" },
      ],
    }),
    capturePath: "asr",
  });

  const transcript = panel.elementById("sessionTranscript");
  const pendingRows = findDescendants(transcript, "session-pending");
  const texts = pendingRows.map(
    (row) => findDescendants(row, "session-record-text")[0].textContent,
  );
  assert.deepEqual(texts, ["转写中…", "转写中…"], "one spinner for the local upload and one for the server view");
  const starts = pendingRows.map((row) => row.dataset.seconds);
  assert.deepEqual(starts, ["30", "60"], "each pending sits at its own Segment start");
});

test("a server pending at a range the local Segment still covers does not double-spin", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState({
      segments: [{ id: "seg-0", start: 0, duration: 30, status: "pending" }],
      transcriptRecords: [],
      pendingSegments: [
        { id: "srv_0", start: 0, duration: 30, status: "pending" },
      ],
    }),
    capturePath: "asr",
  });

  const transcript = panel.elementById("sessionTranscript");
  const pendingRows = findDescendants(transcript, "session-pending");
  assert.equal(pendingRows.length, 1, "the same start spins once");
});

test("the ASR path keeps its pending rows after the first results land", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState({
      segments: [{ id: "seg-0", start: 0, duration: 30, status: "done" }],
      transcriptRecords: [{ start: 0, text: "第一段结果" }],
      pendingSegments: [
        { id: "srv_1", start: 30, duration: 30, status: "pending" },
      ],
    }),
    capturePath: "asr",
  });

  const transcript = panel.elementById("sessionTranscript");
  const rows = transcript.children.filter((row) =>
    row.classList?.contains("session-record"),
  );
  assert.ok(rows.length >= 1, "the landed record renders");
  const pending = findDescendants(transcript, "session-pending");
  assert.equal(pending.length, 1, "the server's transcribing Segment still spins");
});

test("a captureNotice alerts and takes the status line through the same surface", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState(),
    capturePath: "asr",
  });

  panel.session.handleSessionUpdateMessage(
    {
      action: "sessionUpdate",
      sessionId: "s_1",
      captureNotice: "音频采集已中断（标签页已关闭或已离开课程页），会话自动结束。",
    },
    () => {},
  );

  assert.deepEqual(panel.alerts, [
    "音频采集已中断（标签页已关闭或已离开课程页），会话自动结束。",
  ]);
  assert.equal(
    panel.elementById("sessionStatus").textContent,
    "音频采集已中断（标签页已关闭或已离开课程页），会话自动结束。",
  );
});

test("the D15 origin conflict's server message surfaces verbatim through captureNotice", () => {
  const panel = loadPanel({ stored: {} });
  panel.session.showSessionMode({
    active: true,
    kind: "replay",
    state: activeSessionState(),
    capturePath: "asr",
  });

  panel.session.handleSessionUpdateMessage(
    {
      action: "sessionUpdate",
      sessionId: "s_1",
      captureNotice: "本次学习已按字幕归档，同一区间只采用一种方式",
    },
    () => {},
  );

  assert.deepEqual(panel.alerts, ["本次学习已按字幕归档，同一区间只采用一种方式"]);
});

test("the transcript empty state keeps the Segment wait copy on the ASR path", () => {
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
    capturePath: "asr",
  });

  const transcript = panel.elementById("sessionTranscript");
  const pendingRow = findDescendants(transcript, "session-pending")[0];
  const text = findDescendants(pendingRow, "session-record-text")[0];
  assert.equal(text.textContent, "录制中，第一段逐字稿约 30 秒 后出现…");
});

// --- Authorization gate (P6): 未授权时只有引导，授权后一切照旧 -----------------

function makeAuthPanel(responses) {
  const panel = loadPanel({ stored: {} });
  panel.setNextResponse((message) => {
    if (responses[message.action]) return responses[message.action];
    if (message.action === "checkConfig") return { hasAiKey: true };
    return { success: true };
  });
  return panel;
}

test("an unlinked learner sees only the authorization guide at startup", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: false, reason: "unconfigured" },
  });

  await panel.docListeners.DOMContentLoaded();
  await panel.flush();

  const display = (id) => panel.elementById(id).style.display;
  assert.equal(display("authGateState"), "flex", "the guide is the visible view");
  assert.equal(display("welcomeState"), "none");
  assert.equal(display("resultsState"), "none");
  assert.equal(display("tabsNav"), "none", "no feature tabs before linking");
  assert.equal(
    panel.elementById("settingsBtn").style.display,
    "none",
    "the settings entry is hidden too",
  );
  // The probe was asked, and the failure named in the copy.
  assert.match(panel.elementById("authGateStatus").textContent, /关联/);
  assert.ok(panel.sentMessages.some((message) => message.action === "checkAuth"));
});

test("an unreachable learning service says so instead of blaming the link", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: false, reason: "unreachable" },
  });

  await panel.docListeners.DOMContentLoaded();
  await panel.flush();

  assert.equal(panel.elementById("authGateState").style.display, "flex");
  assert.match(
    panel.elementById("authGateStatus").textContent,
    /连不上学习服务/,
  );
});

test("a linked learner skips the gate and lands on the welcome state", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: true, reason: null },
  });

  await panel.docListeners.DOMContentLoaded();
  await panel.flush();

  const display = (id) => panel.elementById(id).style.display;
  assert.equal(display("authGateState"), "none");
  assert.equal(display("welcomeState"), "flex");
  assert.notEqual(
    panel.elementById("settingsBtn").style.display,
    "none",
    "the settings entry is back",
  );
});

test("authState pushes the panel back into the guide with the failure copy", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: true, reason: null },
  });
  await panel.docListeners.DOMContentLoaded();
  await panel.flush();
  assert.equal(panel.elementById("authGateState").style.display, "none");

  // Drive the runtime message listener the way the background does.
  const messageListener = panel.runtimeMessageListeners[0];
  assert.ok(messageListener, "the panel registered a runtime message listener");
  const response = messageListener(
    {
      action: "authState",
      authorized: false,
      reason: "linkFailed",
      message: "关联码无效或已过期，请在网页上重新发起关联",
    },
    {},
    () => {},
  );
  await panel.flush();

  assert.equal(panel.elementById("authGateState").style.display, "flex");
  assert.match(
    panel.elementById("authGateStatus").textContent,
    /关联码无效或已过期/,
  );
  assert.equal(response, false);
});

test("authAuthorized re-runs the gate and unlocks the panel", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: false, reason: "unconfigured" },
  });
  await panel.docListeners.DOMContentLoaded();
  await panel.flush();
  assert.equal(panel.elementById("authGateState").style.display, "flex");

  // The link flow finished: from now on the background reports authorized.
  panel.setNextResponse((message) => {
    if (message.action === "checkConfig") return { hasAiKey: true };
    if (message.action === "checkAuth") return { authorized: true, reason: null };
    return { success: true };
  });
  const messageListener = panel.runtimeMessageListeners[0];
  messageListener({ action: "authAuthorized", email: "l@e.com" }, {}, () => {});
  await panel.flush();

  const display = (id) => panel.elementById(id).style.display;
  assert.equal(display("authGateState"), "none", "the gate lifted");
  assert.equal(display("welcomeState"), "flex", "the normal startup took over");
  assert.notEqual(display("settingsBtn"), "none");
});

// --- Collect current page (P8, #58): the welcome-state entry -----------------

test("the collect entry lives inside the welcome state, so the authorization gate hides it", () => {
  const html = read("sidepanel.html");
  const welcomeBlock = html.match(
    /<div id="welcomeState"[\s\S]*?<div id="authGateState"/,
  );
  assert.ok(welcomeBlock, "the welcome state block is locatable");
  assert.match(welcomeBlock[0], /id="collectPageBtn"/, "the collect button is in the welcome view");
  assert.match(welcomeBlock[0], /id="collectStatus"/, "the collect status line is in the welcome view");
  assert.doesNotMatch(
    html.match(/<div id="authGateState"[\s\S]*?<div id="loadingState"/)[0],
    /collectPageBtn/,
    "the gate view carries no collect entry",
  );
});

test("collecting the current page reports 已收藏 when the API creates the favorite", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: true, reason: null },
    resolveCurrentSource: { ok: true, matched: false, identityPresent: false },
    collectCurrentPage: {
      ok: true,
      outcome: "created",
      resource: { id: "res_1", title: "注意力机制详解 P2：自注意力" },
      source: { id: "src_1" },
    },
  });
  await panel.docListeners.DOMContentLoaded();
  await panel.flush();

  panel.elementById("collectPageBtn").listeners.click();
  await panel.flush();

  const status = panel.elementById("collectStatus");
  assert.equal(status.textContent, "已收藏");
  assert.notEqual(status.style.display, "none", "the outcome is visible");
  assert.equal(
    panel.elementById("collectPageBtn").disabled,
    false,
    "the button is re-enabled after the round trip",
  );
  assert.ok(
    panel.sentMessages.some((message) => message.action === "collectCurrentPage"),
    "the collect message went to the background",
  );
});

test("a duplicate favorite reports that the existing resource was returned", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: true, reason: null },
    resolveCurrentSource: { ok: true, matched: false, identityPresent: false },
    collectCurrentPage: {
      ok: true,
      outcome: "existing",
      resource: { id: "res_1", title: "注意力机制详解 P2：自注意力" },
      source: { id: "src_1" },
    },
  });
  await panel.docListeners.DOMContentLoaded();
  await panel.flush();

  panel.elementById("collectPageBtn").listeners.click();
  await panel.flush();

  assert.equal(panel.elementById("collectStatus").textContent, "已在库中，返回同一条资料");
});

test("a failed collect shows the API's envelope message", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: true, reason: null },
    resolveCurrentSource: { ok: true, matched: false, identityPresent: false },
    collectCurrentPage: {
      ok: false,
      message: "地址缺失、非法或非 http(s)",
    },
  });
  await panel.docListeners.DOMContentLoaded();
  await panel.flush();

  panel.elementById("collectPageBtn").listeners.click();
  await panel.flush();

  assert.equal(panel.elementById("collectStatus").textContent, "地址缺失、非法或非 http(s)");
});

test("unlocking on a recognized video page says when the source is already in the library", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: true, reason: null },
    resolveCurrentSource: {
      ok: true,
      matched: true,
      resource: { id: "res_1", title: "注意力机制详解 P2：自注意力" },
      source: { id: "src_1", progress: { positionMs: 250000, revision: 2 } },
    },
  });
  await panel.docListeners.DOMContentLoaded();
  await panel.flush();

  assert.ok(
    panel.sentMessages.some((message) => message.action === "resolveCurrentSource"),
    "the resolve probe fires when the collect entry unlocks",
  );
  assert.equal(
    panel.elementById("collectStatus").textContent,
    "该来源已在你的学习库：注意力机制详解 P2：自注意力",
  );
});

test("a resolve miss keeps the collect entry quiet", async () => {
  const panel = makeAuthPanel({
    checkAuth: { authorized: true, reason: null },
    resolveCurrentSource: { ok: true, matched: false, identityPresent: true },
  });
  await panel.docListeners.DOMContentLoaded();
  await panel.flush();

  assert.ok(panel.sentMessages.some((message) => message.action === "resolveCurrentSource"));
  assert.equal(panel.elementById("collectStatus").style.display, "none", "nothing announced on a miss");
});

// --- Course-target resume: positionMs=0 IS progress (round-1 review fix) ----
//
// The P11 定位选项 and the 上次学到 line previously keyed on position > 0,
// which hid a revision-backed 0 position behind "从头开始". The judgment is
// now revision-based (hasResumableProgress), so a Source whose latest
// position is exactly 0:00 still shows its history and offers 继续学习.

test("formatResumePosition renders 0:00 at zero and stays empty for unusable values", () => {
  const { course } = loadPanel();
  assert.equal(course.formatResumePosition(0), "0:00");
  assert.equal(course.formatResumePosition(250000), "4:10");
  assert.equal(course.formatResumePosition(3661000), "1:01:01");
  assert.equal(course.formatResumePosition(null), "");
  assert.equal(course.formatResumePosition(-1000), "");
  assert.equal(course.formatResumePosition("250000"), "");
});

test("hasResumableProgress keys on the revision, not the position", () => {
  const { course } = loadPanel();
  assert.equal(course.hasResumableProgress({ positionMs: 0, revision: 1 }), true, "0 IS progress when a revision backs it");
  assert.equal(course.hasResumableProgress({ positionMs: 250000, revision: 1 }), true);
  assert.equal(course.hasResumableProgress({ positionMs: 250000, revision: 0 }), false, "revision 0 is no progress");
  assert.equal(course.hasResumableProgress({ positionMs: 250000 }), false, "no revision is no progress");
  assert.equal(course.hasResumableProgress({ positionMs: "250000", revision: 1 }), false, "an unusable position is no progress");
  assert.equal(course.hasResumableProgress(null), false);
});

test("describeCourseTargetResolution shows 上次学到 0:00 for a revision-backed zero", () => {
  const { course } = loadPanel();
  const resolution = (progress) =>
    course.describeCourseTargetResolution({
      startable: true,
      resolve: {
        matched: true,
        resource: { id: "res_1", title: "注意力机制详解" },
        source: { id: "src_1", url: "https://www.example.com/", progress },
      },
    });

  assert.match(
    resolution({ positionMs: 0, revision: 1 }),
    /上次学到 0:00/,
    "a stored 0 keeps the resume line",
  );
  assert.match(resolution({ positionMs: 250000, revision: 2 }), /上次学到 4:10/);
  assert.match(resolution(null), /从头开始/, "no progress points at the start");
  assert.match(
    resolution({ positionMs: 0 }),
    /从头开始/,
    "a position without a revision is no progress",
  );
});

// --- captions-path transcript states (Ticket 2.5, #68) ---------------------------
//
// The 逐字稿 tab distinguishes the three states: 字幕 (the archived captions
// full text, rendered from the server TranscriptView rows), 转写中 (the
// existing pending spinner rows), and 无字幕 (the honest empty state with
// the 可转写 hint — the 强制转写 entry point's semantics).

function captionsSessionState(overrides = {}) {
  return activeSessionState({
    transcriptOrigin: "captions",
    transcriptRecords: [
      { start: 138, duration: 21, text: "这一节我们把注意力分数放到矩阵上看" },
      { start: 159, duration: 22, text: "Q K V 三个矩阵各司其职" },
    ],
    ...overrides,
  });
}

test("a captions Session's status line says 字幕 instead of 转写中", () => {
  const panel = loadPanel({ stored: {} });

  panel.session.showSessionMode({
    active: true,
    kind: "video",
    state: captionsSessionState(),
    timestampKind: "video",
  });

  const status = panel.elementById("sessionStatus").textContent;
  assert.match(status, /字幕/);
  assert.doesNotMatch(status, /转写中/, "the captions path runs no ASR to wait for");

  // The archived captions render as the full text (timestamped rows).
  const transcript = panel.elementById("sessionTranscript");
  const texts = findDescendants(transcript, "session-record-text").map((row) => row.textContent);
  assert.deepEqual(texts, [
    "这一节我们把注意力分数放到矩阵上看",
    "Q K V 三个矩阵各司其职",
  ]);
});

test("the 无字幕 probe renders the explicit empty state with the 可转写 hint", () => {
  const panel = loadPanel({ stored: {} });

  panel.session.showSessionMode({
    active: true,
    kind: "video",
    state: activeSessionState({
      transcriptOrigin: null,
      captionsProbe: { available: false, reason: "no_subtitle_track" },
      transcriptRecords: [],
    }),
    timestampKind: "video",
  });

  const transcript = panel.elementById("sessionTranscript");
  const texts = findDescendants(transcript, "session-record-text").map((row) => row.textContent);
  const notice = texts.join(" ");
  assert.match(notice, /未读取到可用字幕/);
  assert.match(notice, /可转写/, "the forced-transcription entry keeps its semantic hint");
  // 不误报: no caption row can exist when nothing was archived.
  assert.equal(findDescendants(transcript, "session-captions-empty").length, 1);
});

test("the 无字幕 empty state disappears once transcript records arrive", () => {
  const panel = loadPanel({ stored: {} });

  panel.session.showSessionMode({
    active: true,
    kind: "video",
    state: activeSessionState({
      captionsProbe: { available: false, reason: "no_subtitle_track" },
      transcriptRecords: [{ start: 0, duration: 30, text: "语音转写的第一段" }],
    }),
    timestampKind: "video",
  });

  const transcript = panel.elementById("sessionTranscript");
  const texts = findDescendants(transcript, "session-record-text").map((row) => row.textContent);
  assert.deepEqual(texts, ["语音转写的第一段"]);
  assert.equal(
    findDescendants(transcript, "session-captions-empty").length,
    0,
    "records on screen retire the empty state",
  );
});

test("the captions state resets with the Session (a new Session starts clean)", () => {
  const panel = loadPanel({ stored: {} });

  panel.session.showSessionMode({
    active: true,
    kind: "video",
    state: captionsSessionState({ sessionId: "s_old" }),
    timestampKind: "video",
  });
  // A NEW Session (id changed) without captions state: no stale 字幕 status.
  panel.session.showSessionMode({
    active: true,
    kind: "video",
    state: activeSessionState({ sessionId: "s_new" }),
    timestampKind: "video",
  });

  const status = panel.elementById("sessionStatus").textContent;
  assert.match(status, /转写中/, "the new Session is back on the capture path's wording");
});

test("the captions start toast does not claim 录制 (no audio is captured)", () => {
  const panel = loadPanel({ stored: {} });

  panel.session.showSessionMode({
    active: true,
    kind: "video",
    state: captionsSessionState(),
    timestampKind: "video",
    capturePath: "captions",
  });
  // The one-shot-per-Session toast keys off the same funnel.
  panel.session.setSegmentLengthForCopy("30");
  const toast = panel.elementById("recordingToast") || panel.createdElements.find((el) => el.id === "recordingToast");
  // showSessionMode triggers the toast for a fresh Session id; assert via
  // the created element the panel appended.
  const appended = (panel.createdElements || []).find((el) => el.id === "recordingToast");
  assert.ok(appended || toast, "the toast element exists");
  const target = appended || toast;
  assert.match(target.textContent, /已开始学习 · 字幕全文归档中/);
});
