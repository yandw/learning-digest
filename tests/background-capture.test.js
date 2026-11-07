/**
 * Background capture-orchestration behaviors, tested through the shared
 * load-background seam: the provider-aware start gate (#9 / #21 finding 9)
 * and the resume path settling interrupted in-flight Segments (#8 / #21
 * finding 8, the #12 / US15 contract).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackgroundHelpers } = require("./helpers/load-background.js");
const sessionPipeline = require("../session-pipeline.js");

const REPLAY_URL = "https://app12345.xiaoe-tech.com/replay/l_abc123def456";

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    speechProvider: "groq",
    speechProviders: { groq: { apiKey: "groq-key" } },
    segmentLengthSeconds: 120,
    summaryIntervalMinutes: 30,
    ...overrides,
  };
}

// --- Start gate: validate against the SELECTED provider's credential fields

test("startLearning gate names the missing field for Groq", async () => {
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: baseSettings({
      speechProviders: { groq: { apiKey: "" } },
    }),
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, false);
  assert.match(result.error, /apiKey/);
});

test("startLearning gate names the missing field for Tencent", async () => {
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: baseSettings({
      speechProvider: "tencent",
      speechProviders: { tencent: { secretId: "id-only", secretKey: "" } },
    }),
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, false);
  assert.match(result.error, /secretKey/);
});

test("startLearning gate names every missing field for Aliyun", async () => {
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: baseSettings({
      speechProvider: "aliyun",
      speechProviders: {
        aliyun: { accessKeyId: "id", accessKeySecret: "", appKey: "" },
      },
    }),
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, false);
  assert.match(result.error, /accessKeySecret/);
  assert.match(result.error, /appKey/);
});

test("startLearning proceeds to capture when the selected provider's credentials are complete", async () => {
  const { handleStartLearning } = loadBackgroundHelpers({
    settings: baseSettings({
      speechProvider: "tencent",
      speechProviders: {
        tencent: { secretId: "id", secretKey: "key" },
      },
    }),
  });

  const result = await handleStartLearning({ url: REPLAY_URL, tabId: 7 });

  assert.equal(result.success, true);
  assert.equal(result.sessionId.startsWith("s_"), true);
});

// --- Resume: an in-flight Segment at worker death leaves no orphan pending

test("getSessionState after resume settles the interrupted Segment as failed with its annotation", async () => {
  let state = sessionPipeline.createSession({ sessionId: "s_resume" });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = sessionPipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-0",
    records: [{ text: "第一段", start: 0, duration: 5 }],
  });
  state = sessionPipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 120, duration: 120 },
  });

  const { handleGetSessionState } = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: {
      ytd_active_capture: {
        sessionId: "s_resume",
        tabId: 7,
        platformId: "xiaoe-tech",
        kind: "replay",
        timestampKind: "video",
        startedAtMs: Date.now() - 300_000,
        segmentLengthSeconds: 120,
      },
      ytd_session_s_resume: JSON.parse(JSON.stringify(state)),
    },
  });

  const result = await handleGetSessionState();

  assert.equal(result.active, true);
  assert.ok(
    result.state.segments.every((segment) => segment.status !== "pending"),
    "a resumed Session has no orphan pending Segments",
  );
  const marker = result.state.transcriptRecords.find(
    (record) => record.failed === true && record.start === 120,
  );
  assert.ok(marker, "the gap carries the visible [语音转录失败] annotation");
});
