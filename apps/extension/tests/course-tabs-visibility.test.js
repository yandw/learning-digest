/**
 * The course tab list's empty-state visibility rule (0.2.38). The list is
 * initialization guidance: it shows only while the panel is unlocked, no
 * Session records, and no loaded content (报告产物 / 概览话题 / 逐字稿行) owns
 * the panel. It hides the moment content lands (adoptSessionReport, the D7
 * startup scan, the artifact funnel) and returns after 清除记录 wipes the
 * panel. Tested through the mock-document VM seam in the spirit of
 * tests/report-panel.test.js.
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
  quotes: [],
  todos: [],
};

function makeElement(id = "") {
  const element = {
    id,
    tagName: "",
    dataset: {},
    style: {},
    children: [],
    listeners: {},
    innerHTML: "",
    disabled: false,
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    append(...nodes) {
      element.children.push(...nodes);
    },
    remove() {},
    addEventListener(type, fn) {
      element.listeners[type] = fn;
    },
    scrollIntoView() {},
  };
  // Browser fidelity: clearing textContent wipes the subtree (the panel's
  // renderers reset lists exactly this way).
  let textContent = "";
  Object.defineProperty(element, "textContent", {
    get() {
      return textContent;
    },
    set(value) {
      textContent = value;
      if (value === "") element.children.length = 0;
    },
  });
  Object.defineProperty(element, "childElementCount", {
    get() {
      return element.children.length;
    },
  });
  return element;
}

/**
 * Loads sidepanel.js in a mock-document sandbox and returns the course +
 * session testing hooks plus the element registry.
 */
function loadPanel({ stored = {} } = {}) {
  const elements = {};
  const elementById = (id) => elements[id] || (elements[id] = makeElement(id));
  const sentMessages = [];

  const sandbox = {
    console,
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
        return el;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: makeElement("body"),
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: (message) => {
          sentMessages.push(message);
          return Promise.resolve({ success: true });
        },
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: {
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
    YTD_SETTINGS: {},
    YTD_REPORT_RENDER: require("../report-render.js"),
    YTD_SESSION_PIPELINE: require("../session-pipeline.js"),
    YTD_SESSION_TIMELINE: require("../session-timeline.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);

  return {
    course: sandbox.__YTD_COURSE_TESTING__,
    session: sandbox.__YTD_SESSION_TESTING__,
    elements,
    sentMessages,
  };
}

test("the empty unlocked panel shows the course tab list", () => {
  const { course, elements } = loadPanel();
  course.courseTargetUi.available = true;

  course.updateCourseTabsVisibility();

  assert.equal(elements.courseTabsBox.style.display, "");
  assert.equal(course.panelHasLoadedContent(), false);
});

test("an active Session hides the list even when the panel is empty", () => {
  const { course, elements } = loadPanel();
  course.courseTargetUi.available = true;
  course.sessionUi.active = true;

  course.updateCourseTabsVisibility();

  assert.equal(elements.courseTabsBox.style.display, "none");
});

test("a locked panel hides the list", () => {
  const { course, elements } = loadPanel();
  course.courseTargetUi.available = false;

  course.updateCourseTabsVisibility();

  assert.equal(elements.courseTabsBox.style.display, "none");
});

test("transcript rows count as loaded content", () => {
  const { course, elements } = loadPanel();
  course.courseTargetUi.available = true;
  // Touch the registry so the lookup-backed elements exist before the rows
  // land (panelHasLoadedContent creates them on first read).
  course.updateCourseTabsVisibility();
  elements.sessionTranscript.appendChild(makeElement());

  course.updateCourseTabsVisibility();

  assert.equal(course.panelHasLoadedContent(), true);
  assert.equal(elements.courseTabsBox.style.display, "none");
});

test("overview topics count as loaded content", () => {
  const { course, elements } = loadPanel();
  course.courseTargetUi.available = true;
  course.updateCourseTabsVisibility();
  elements.overviewTopics.appendChild(makeElement());

  course.updateCourseTabsVisibility();

  assert.equal(course.panelHasLoadedContent(), true);
  assert.equal(elements.courseTabsBox.style.display, "none");
});

test("an adopted report hides the list (the 0.2.38 screenshot case)", async () => {
  const { course, session, elements } = loadPanel();
  course.courseTargetUi.available = true;
  course.updateCourseTabsVisibility();
  assert.equal(elements.courseTabsBox.style.display, "");

  session.adoptSessionReport(REPORT, "s_1");
  assert.equal(elements.courseTabsBox.style.display, "none");

  // The artifact funnel's own re-evaluation agrees once storage resolves.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.courseTabsBox.style.display, "none");
});

test("清除记录 restores the empty state and the list returns", async () => {
  const { course, session, elements } = loadPanel();
  course.courseTargetUi.available = true;
  course.sessionUi.lastSessionId = "s_1";
  session.adoptSessionReport(REPORT, "s_1");
  assert.equal(elements.courseTabsBox.style.display, "none");
  // Let the artifact funnel's async storage read settle before the clear.
  await new Promise((resolve) => setImmediate(resolve));

  await session.clearSessionRecord();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(course.sessionUi.lastSessionId, null);
  assert.equal(course.panelHasLoadedContent(), false);
  assert.equal(elements.courseTabsBox.style.display, "");
});
