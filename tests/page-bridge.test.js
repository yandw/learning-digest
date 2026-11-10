/**
 * Page bridge behaviors (P10b, #63), tested through the YTD_PAGE_BRIDGE
 * factory seam with hand-stubbed DOM/chrome environments — the repo style
 * (no jsdom). The factory is the exact code the content script auto-starts,
 * so every stubbed behavior here is the shipped behavior:
 * - the per-second position stream (mediaPosition) with the page URL carried
 *   alongside, so a bilibili episode switch (?p=N) is detectable in-stream;
 * - the one-shot getMediaPosition answer (P12 timestamp notes);
 * - the seekMedia command (P11 resume positioning) with autoplay-policy
 *   tolerance;
 * - the pre-existing restartFromBeginning control (0.1.63, regression guard);
 * - the quiet-on-no-media rule: a frame without a player stays silent.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createPageBridge, POSITION_INTERVAL_MS } = require("../page-bridge.js");

// --- hand-rolled stubs -------------------------------------------------------

/** A video element stub: real property semantics, recorded seek/play calls. */
function stubVideo({
  width = 1280,
  height = 720,
  readyState = 4,
  currentTime = 42.5,
  duration = 600,
  paused = false,
  ended = false,
} = {}) {
  const listeners = {};
  const video = {
    readyState,
    videoWidth: width,
    videoHeight: height,
    duration,
    paused,
    ended,
    listeners,
    playCalls: 0,
    play() {
      video.playCalls += 1;
      return Promise.resolve();
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    fire(type) {
      for (const fn of listeners[type] || []) fn();
    },
  };
  Object.defineProperty(video, "currentTime", {
    get() {
      return currentTime;
    },
    set(value) {
      video.currentTimeWrites = (video.currentTimeWrites || []).concat([value]);
      currentTime = value;
    },
    configurable: true,
  });
  return video;
}

function stubEnvironment({ videos = [], location = {}, title = "测试课程" } = {}) {
  const sent = [];
  const messageListeners = [];
  const pagehideListeners = [];
  const intervals = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        sent.push(message);
        if (callback) callback();
      },
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        },
      },
    },
  };
  const windowStub = {
    location,
    addEventListener(type, fn) {
      if (type === "pagehide") pagehideListeners.push(fn);
    },
  };
  const documentStub = {
    title,
    querySelectorAll(selector) {
      return selector === "video" ? videos : [];
    },
  };
  const env = {
    document: documentStub,
    window: windowStub,
    chrome,
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    console: { debug() {}, warn() {} },
  };
  const bridge = createPageBridge(env);
  return { bridge, sent, messageListeners, pagehideListeners, intervals, windowStub, documentStub };
}

// --- position stream ----------------------------------------------------------

test("reportPosition sends the primary media's position with the page URL", () => {
  const video = stubVideo({ currentTime: 83.25, duration: 721, paused: false, ended: false });
  const { bridge, sent } = stubEnvironment({
    videos: [video],
    location: { href: "https://www.bilibili.com/video/BV1ab411L78c?p=2" },
  });

  bridge.reportPosition();

  assert.equal(sent.length, 1);
  const message = sent[0];
  assert.equal(message.action, "mediaPosition");
  assert.equal(message.position, 83.25);
  assert.equal(message.duration, 721);
  assert.equal(message.paused, false);
  assert.equal(message.ended, false);
  // P10b: the page URL rides every stream report, so a bilibili episode
  // switch (?p=N) or any in-page navigation is detectable by the consumer.
  assert.equal(message.pageUrl, "https://www.bilibili.com/video/BV1ab411L78c?p=2");
});

test("the largest visible video is the primary media", () => {
  const small = stubVideo({ width: 320, height: 180 });
  const lesson = stubVideo({ width: 1920, height: 1080, currentTime: 12.5 });
  const { bridge, sent } = stubEnvironment({ videos: [small, lesson] });

  bridge.reportPosition();

  assert.equal(sent[0].position, 12.5);
});

test("videos without decodable dimensions are ignored", () => {
  const loading = stubVideo({ readyState: 0, width: 0, height: 0 });
  const ready = stubVideo({ width: 640, height: 360, currentTime: 5 });
  const { bridge, sent } = stubEnvironment({ videos: [loading, ready] });

  bridge.reportPosition();

  assert.equal(sent[0].position, 5);
});

test("a frame without a player stays quiet (no position messages)", () => {
  const { bridge, sent } = stubEnvironment({ videos: [] });

  bridge.reportPosition();

  assert.deepEqual(sent, []);
});

test("live streams report duration null (Infinity is not JSON)", () => {
  const live = stubVideo({ duration: Infinity, currentTime: 300 });
  const { bridge, sent } = stubEnvironment({ videos: [live] });

  bridge.reportPosition();

  assert.equal(sent[0].duration, null);
});

test("a detached media element mid-read never breaks the stream", () => {
  const broken = stubVideo();
  Object.defineProperty(broken, "currentTime", {
    get() {
      throw new Error("detached");
    },
    set() {
      throw new Error("detached");
    },
    configurable: true,
  });
  const { bridge, sent } = stubEnvironment({ videos: [broken] });

  bridge.reportPosition();

  assert.deepEqual(sent, []);
});

test("an invalidated extension context never breaks the stream", () => {
  const video = stubVideo();
  const { bridge } = stubEnvironment({ videos: [video] });
  // Simulate the invalidation the sendMessage stub already ran with.
  return new Promise((resolve) => {
    const throwingBridge = createPageBridge({
      document: { title: "t", querySelectorAll: () => [video] },
      window: { location: { href: "https://x/" }, addEventListener() {} },
      chrome: {
        runtime: {
          sendMessage() {
            throw new Error("Extension context invalidated.");
          },
          onMessage: { addListener() {} },
        },
      },
      setInterval() {
        return 0;
      },
      console: { debug() {}, warn() {} },
    });
    assert.doesNotThrow(() => throwingBridge.reportPosition());
    resolve();
  });
});

test("the stream reports again with the NEW page URL after an in-page switch", () => {
  const video = stubVideo();
  const { bridge, sent, windowStub } = stubEnvironment({
    videos: [video],
    location: { href: "https://www.bilibili.com/video/BV1ab411L78c?p=1" },
  });

  bridge.reportPosition();
  // bilibili episode switch: a soft navigation changes location without a
  // document reload, so the same bridge must surface the new URL.
  windowStub.location.href = "https://www.bilibili.com/video/BV1ab411L78c?p=2";
  bridge.reportPosition();

  assert.equal(sent[0].pageUrl, "https://www.bilibili.com/video/BV1ab411L78c?p=1");
  assert.equal(sent[1].pageUrl, "https://www.bilibili.com/video/BV1ab411L78c?p=2");
});

// --- page title ---------------------------------------------------------------

test("reportPageTitle sends the document title", () => {
  const { bridge, sent } = stubEnvironment({ title: "第2话 隐函数 - 哔哩哔哩" });

  bridge.reportPageTitle();

  assert.deepEqual(sent[0], { action: "pageTitle", title: "第2话 隐函数 - 哔哩哔哩" });
});

// --- one-shot position query (P12 notes) ---------------------------------------

test("getMediaPosition answers with the primary media position", () => {
  const video = stubVideo({ currentTime: 17.75, duration: 300, paused: true, ended: false });
  const { bridge } = stubEnvironment({ videos: [video] });
  const responses = [];

  const handled = bridge.handleMessage(
    { action: "getMediaPosition" },
    (response) => responses.push(response),
  );

  assert.equal(handled, false); // synchronous answer, like the shipped bridge
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], {
    success: true,
    position: 17.75,
    duration: 300,
    paused: true,
    ended: false,
  });
});

test("getMediaPosition stays silent in a frame without media", () => {
  const { bridge } = stubEnvironment({ videos: [] });
  const responses = [];

  const handled = bridge.handleMessage(
    { action: "getMediaPosition" },
    (response) => responses.push(response),
  );

  assert.equal(handled, false);
  assert.deepEqual(responses, []);
});

// --- seek command (P10b bridge capability; panel wiring is P11) -----------------

test("seekMedia assigns currentTime from positionMs and resumes playback", () => {
  const video = stubVideo({ currentTime: 10, duration: 600 });
  const { bridge } = stubEnvironment({ videos: [video] });
  const responses = [];

  bridge.handleMessage({ action: "seekMedia", positionMs: 92500 }, (r) => responses.push(r));

  assert.deepEqual(video.currentTimeWrites, [92.5]);
  assert.equal(video.playCalls, 1);
  assert.deepEqual(responses, [{ success: true, position: 92.5 }]);
});

test("seekMedia clamps past the duration to the end", () => {
  const video = stubVideo({ duration: 60 });
  const { bridge } = stubEnvironment({ videos: [video] });
  const responses = [];

  bridge.handleMessage({ action: "seekMedia", positionMs: 120000 }, (r) => responses.push(r));

  assert.deepEqual(video.currentTimeWrites, [60]);
  assert.deepEqual(responses, [{ success: true, position: 60 }]);
});

test("seekMedia without a duration seeks as asked", () => {
  const video = stubVideo({ duration: NaN });
  const { bridge } = stubEnvironment({ videos: [video] });
  const responses = [];

  bridge.handleMessage({ action: "seekMedia", positionMs: 5000 }, (r) => responses.push(r));

  assert.deepEqual(video.currentTimeWrites, [5]);
  assert.deepEqual(responses, [{ success: true, position: 5 }]);
});

test("autoplay-policy rejection does not fail the seek", () => {
  const video = stubVideo();
  video.play = () => Promise.reject(new DOMException("NotAllowedError", "play() failed"));
  const { bridge } = stubEnvironment({ videos: [video] });
  const responses = [];

  bridge.handleMessage({ action: "seekMedia", positionMs: 30000 }, (r) => responses.push(r));

  assert.deepEqual(video.currentTimeWrites, [30]);
  assert.deepEqual(responses, [{ success: true, position: 30 }]);
});

test("invalid or negative positionMs is refused without touching the media", () => {
  for (const positionMs of [-1, NaN, "abc"]) {
    const video = stubVideo();
    const { bridge } = stubEnvironment({ videos: [video] });
    const responses = [];

    bridge.handleMessage({ action: "seekMedia", positionMs }, (r) => responses.push(r));

    assert.deepEqual(video.currentTimeWrites, undefined, String(positionMs));
    assert.equal(responses[0].success, false, String(positionMs));
    assert.match(responses[0].error, /positionMs/, String(positionMs));
  }
});

test("seekMedia stays silent in a frame without media", () => {
  const { bridge } = stubEnvironment({ videos: [] });
  const responses = [];

  const handled = bridge.handleMessage(
    { action: "seekMedia", positionMs: 1000 },
    (response) => responses.push(response),
  );

  assert.equal(handled, false);
  assert.deepEqual(responses, []);
});

// --- pre-existing controls (regression guard) -----------------------------------

test("restartFromBeginning rewinds to 0 and plays (0.1.63 behavior kept)", () => {
  const video = stubVideo({ currentTime: 240 });
  const { bridge } = stubEnvironment({ videos: [video] });
  const responses = [];

  bridge.handleMessage({ action: "restartFromBeginning" }, (r) => responses.push(r));

  assert.deepEqual(video.currentTimeWrites, [0]);
  assert.equal(video.playCalls, 1);
  assert.deepEqual(responses, [{ success: true }]);
});

test("restartFromBeginning stays silent in a frame without media", () => {
  const { bridge } = stubEnvironment({ videos: [] });
  const responses = [];

  const handled = bridge.handleMessage(
    { action: "restartFromBeginning" },
    (response) => responses.push(response),
  );

  assert.equal(handled, false);
  assert.deepEqual(responses, []);
});

test("unknown actions are ignored", () => {
  const { bridge } = stubEnvironment({ videos: [stubVideo()] });
  const responses = [];

  const handled = bridge.handleMessage({ action: "nope" }, (r) => responses.push(r));

  assert.equal(handled, false);
  assert.deepEqual(responses, []);
});

// --- auto-start wiring -----------------------------------------------------------

test("start() wires the message listener, the 1s cadence and pagehide", () => {
  const video = stubVideo();
  const { bridge, messageListeners, intervals, pagehideListeners } = stubEnvironment({
    videos: [video],
  });

  bridge.start();

  assert.equal(messageListeners.length, 1);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, POSITION_INTERVAL_MS);
  assert.equal(pagehideListeners.length, 2); // position flush + title, as shipped

  // The wired listener answers through the same dispatcher the tests use.
  const responses = [];
  messageListeners[0]({ action: "getMediaPosition" }, (r) => responses.push(r));
  assert.equal(responses[0].success, true);
});

test("the factory is safe to require outside a page (no chrome, no timers)", () => {
  // Requiring this file already ran the auto-start guard in a world without
  // document/window/chrome: reaching this test proves nothing blew up and no
  // interval kept the Node process alive.
  assert.equal(typeof createPageBridge, "function");
});
