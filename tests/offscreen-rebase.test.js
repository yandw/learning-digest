const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Offscreen realtime rebase (#50): browser-only code, so these tests pin the
// source-level contracts the worker's drag handling relies on: action names,
// finish-before-rebase ordering, origin propagation, and hold semantics.

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "offscreen.js"),
  "utf8",
);

test("the message router answers captureRebase and captureRealtimeResume", () => {
  assert.match(
    source,
    /message\.action === "captureRebase"[\s\S]*?rebaseRealtimeSession\(message, sendResponse\)/,
  );
  assert.match(
    source,
    /message\.action === "captureRealtimeResume"[\s\S]*?resumeRealtimeSession\(message, sendResponse\)/,
  );
});

test("rebase finishes the old connection before closing it and keeps the capture", () => {
  // session.finish goes out on the OLD socket while it is still open, and
  // the old socket closes only inside beginNewSession — never through the
  // capture-tearing finishRealtimeTeardown path.
  assert.match(
    source,
    /rebaseRealtimeSession[\s\S]*?socket\.send\(\s*JSON\.stringify\(\s*YTD_REALTIME_PROTOCOL\.buildFinish\(\)\s*\)\s*\)[\s\S]*?beginNewSession/,
    "session.finish is sent on the old connection before the swap",
  );
  assert.match(
    source,
    /function finishRealtimeTeardown[\s\S]*?shutdownCapture\(\)/,
    "the stop path still tears the capture down",
  );
  const rebaseBody = /function rebaseRealtimeSession[\s\S]*?\n  \}/.exec(source)[0];
  assert.doesNotMatch(
    rebaseBody,
    /finishRealtimeTeardown|shutdownCapture|shutdownRealtimeCapture/,
    "a rebase never tears the tab capture down",
  );
  // A superseded session's close must not trigger the reconnect machinery.
  assert.match(
    source,
    /if \(realtimeSession !== session\) return;[\s\S]*?if \(session\.stopping\)/,
  );
});

test("the new session carries the origin and hold flag, and utterance frames propagate the origin", () => {
  assert.match(
    source,
    /startRealtimeSession\(apiKey, \{ originSeconds = 0, hold = false \} = \{\}\)/,
  );
  assert.match(
    source,
    /startRealtimeSession\(apiKey, \{\s*originSeconds: Number\(message\.originSeconds\) \|\| 0,\s*hold: message\.hold === true,\s*\}\)/,
  );
  const originPropagations = source.match(/originSeconds: session\.originSeconds/g) || [];
  assert.ok(
    originPropagations.length >= 2,
    "completed and failed utterance frames both carry the session origin",
  );
});

test("a held session forwards no audio until resumed", () => {
  assert.match(
    source,
    /pumpRealtimeChunk\(session, samples\)[\s\S]*?session\.stopping \|\| session\.hold\) return;/,
  );
  assert.match(
    source,
    /socket\.onopen[\s\S]*?if \(!session\.hold\) startRealtimePump\(session\);/,
  );
  // Resume resets everything that could straddle the hold boundary.
  assert.match(
    source,
    /function resumeRealtimeSession[\s\S]*?session\.accumulator = \[\];[\s\S]*?createUtteranceTracker\(\)[\s\S]*?session\.streamBaseMs = Date\.now\(\) - session\.startedAtMs;/,
  );
});

test("captureStart forwards the persisted origin on a resumed session", () => {
  const background = fs.readFileSync(
    path.resolve(__dirname, "..", "background.js"),
    "utf8",
  );
  assert.match(
    background,
    /buildCaptureStartMessage[\s\S]*?originSeconds: Number\(context\.realtimeOriginSeconds\) \|\| 0,/,
  );
  assert.match(
    source,
    /startRealtimeSession\(message\.apiKey, \{\s*originSeconds: Number\(message\.originSeconds\) \|\| 0,\s*\}\)/,
  );
});

test("wallclock capture converts a 15-second Segment setting to a 15000ms cut cadence", async () => {
  const vm = require("node:vm");
  const intervals = [];
  let messageListener;
  const stream = {
    active: true,
    getAudioTracks: () => [{ readyState: "live" }],
    getTracks: () => [],
  };
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
  }
  const sandbox = {
    console,
    Blob,
    Date,
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    MediaRecorder: Recorder,
    AudioContext: class {
      createMediaStreamSource() {
        return { connect() {} };
      }
    },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (_callback, delayMs) => {
      intervals.push(delayMs);
      return intervals.length;
    },
    clearInterval() {},
    chrome: {
      runtime: {
        lastError: null,
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        sendMessage() {},
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);

  let response;
  messageListener(
    {
      action: "captureStart",
      streamId: "stream-1",
      segmentLengthSeconds: 15,
      mode: "wallclock",
      transcribeMode: "segment",
    },
    {},
    (value) => {
      response = value;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response?.success, true);
  assert.deepEqual(intervals, [15_000]);
});
