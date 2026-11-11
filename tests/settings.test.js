const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("custom AI base URL and model are preserved", () => {
  const normalized = settings.normalize({
    provider: "unexpected",
    aiApiKey: "  example-key  ",
    aiBaseUrl: "https://api.example.com/v1/",
    aiModel: "  example-model  ",
  });

  assert.equal(normalized.provider, "deepseek");
  assert.equal(normalized.aiBaseUrl, "https://api.example.com/v1");
  assert.equal(normalized.aiModel, "example-model");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(
    settings.chatCompletionsUrl(normalized.aiBaseUrl),
    "https://api.example.com/v1/chat/completions",
  );
});

test("empty or invalid AI endpoint config falls back to the Bailian Qwen defaults", () => {
  const empty = settings.normalize({});
  assert.equal(empty.aiBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(empty.aiModel, "qwen3.8-flash");
  assert.equal(empty.settingsVersion, 4);
  assert.equal(
    settings.chatCompletionsUrl(),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );

  const invalid = settings.normalize({
    aiBaseUrl: "not a url",
    aiModel: "   ",
  });
  assert.equal(invalid.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(invalid.aiModel, settings.DEFAULTS.aiModel);

  assert.equal(settings.isValidAiBaseUrl("https://api.openai.com/v1"), true);
  assert.equal(settings.isValidAiBaseUrl("http://localhost:11434/v1"), true);
  assert.equal(settings.isValidAiBaseUrl("http://example.com"), false);
  assert.equal(settings.isValidAiBaseUrl("ftp://api.deepseek.com"), false);
  assert.equal(settings.isValidAiBaseUrl(""), false);
});

test("the v4 retirement drops the local ASR key config (ticket 2.4, D10)", () => {
  // The audio path archives through the learning service now (the Worker
  // holds the ASR credentials), so the plugin's config face carries no ASR
  // keys: the Speech Provider slots AND the legacy STT fields are gone,
  // and a stored blob's keys are dropped on the next read+persist.
  const stored = settings.normalize({
    settingsVersion: 3,
    speechProvider: "groq",
    speechProviders: { groq: { apiKey: "gsk-gone" } },
    sttApiKey: "stt-gone",
    sttBaseUrl: "https://api.groq.com/openai/v1",
    sttModel: "whisper-large-v3-turbo",
  });

  assert.equal(stored.settingsVersion, 4);
  assert.equal("speechProvider" in stored, false);
  assert.equal("speechProviders" in stored, false);
  assert.equal("sttApiKey" in stored, false);
  assert.equal("sttBaseUrl" in stored, false);
  assert.equal("sttModel" in stored, false);

  // The same for a fresh default blob: the keys never come back.
  const fresh = settings.normalize({});
  assert.equal("speechProvider" in fresh, false);
  assert.equal("speechProviders" in fresh, false);
  assert.equal("sttApiKey" in fresh, false);
  assert.equal(settings.sttTranscriptionsUrl, undefined);
});

test("legacy custom migration clears only the AI key and is idempotent", () => {
  const legacy = {
    provider: "custom",
    aiApiKey: "custom-secret",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
  };
  const first = settings.migrateLegacyCustom(legacy);

  assert.equal(first.migrated, true);
  assert.equal(first.settings.provider, "deepseek");
  assert.equal(first.settings.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(first.settings.aiModel, settings.DEFAULTS.aiModel);
  assert.equal(first.settings.aiApiKey, "");

  const second = settings.migrateLegacyCustom(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);

  const configuredDeepSeek = settings.normalize({
    ...first.settings,
    aiApiKey: "new-deepseek-key",
  });
  assert.equal(configuredDeepSeek.aiApiKey, "new-deepseek-key");
});

test("Segment length defaults to 30 seconds", () => {
  const normalized = settings.normalize({});

  assert.equal(normalized.segmentLengthSeconds, 30);
});

test("Segment length is clamped into the supported 5-60 range", () => {
  assert.equal(settings.normalize({ segmentLengthSeconds: 1 }).segmentLengthSeconds, 5);
  assert.equal(settings.normalize({ segmentLengthSeconds: 5 }).segmentLengthSeconds, 5);
  assert.equal(settings.normalize({ segmentLengthSeconds: 30 }).segmentLengthSeconds, 30);
  assert.equal(settings.normalize({ segmentLengthSeconds: 60 }).segmentLengthSeconds, 60);
  assert.equal(settings.normalize({ segmentLengthSeconds: 600 }).segmentLengthSeconds, 60);
  assert.equal(settings.normalize({ segmentLengthSeconds: 3600 }).segmentLengthSeconds, 60);
  assert.equal(settings.normalize({ segmentLengthSeconds: 45 }).segmentLengthSeconds, 45);
});

test("malformed Segment length falls back to the default", () => {
  for (const bad of ["abc", null, undefined, NaN, Infinity, {}]) {
    assert.equal(
      settings.normalize({ segmentLengthSeconds: bad }).segmentLengthSeconds,
      30,
      String(bad),
    );
  }
});

test("Topic timeline interval defaults to 15 minutes", () => {
  const normalized = settings.normalize({});

  assert.equal(normalized.summaryIntervalMinutes, 15);
});

test("Topic timeline interval is clamped into the supported 5-180 range", () => {
  assert.equal(settings.normalize({ summaryIntervalMinutes: 1 }).summaryIntervalMinutes, 5);
  assert.equal(settings.normalize({ summaryIntervalMinutes: 5 }).summaryIntervalMinutes, 5);
  assert.equal(settings.normalize({ summaryIntervalMinutes: 15 }).summaryIntervalMinutes, 15);
  assert.equal(settings.normalize({ summaryIntervalMinutes: 180 }).summaryIntervalMinutes, 180);
  assert.equal(settings.normalize({ summaryIntervalMinutes: 240 }).summaryIntervalMinutes, 180);
});

test("malformed Topic timeline interval falls back to the default", () => {
  for (const bad of ["abc", null, undefined, NaN, Infinity, {}]) {
    assert.equal(
      settings.normalize({ summaryIntervalMinutes: bad }).summaryIntervalMinutes,
      15,
      String(bad),
    );
  }
});

test("a legacy blob with the old default Segment length migrates to 30", () => {
  // 0.1.41: stored 120s blobs predate the 0.1.39 default change and the
  // field has no options UI, so the stored value is never a user choice.
  const normalized = settings.normalize({ segmentLengthSeconds: 120 });

  assert.equal(normalized.segmentLengthSeconds, 30);
  assert.equal(normalized.settingsVersion, 4);
});

test("a stamped blob keeps a hand-tuned Segment length", () => {
  // A v2 stamp (0.1.41-0.1.50) is below the current version, but 45 was
  // never a shipped default, so the hand-tuned value passes through and the
  // blob is re-stamped to the current version.
  const normalized = settings.normalize({
    settingsVersion: 2,
    segmentLengthSeconds: 45,
  });

  assert.equal(normalized.segmentLengthSeconds, 45);
  assert.equal(normalized.settingsVersion, 4);
});

test("an unstamped blob with a hand-tuned Segment length keeps it", () => {
  const normalized = settings.normalize({ segmentLengthSeconds: 45 });

  assert.equal(normalized.segmentLengthSeconds, 45);
});

test("a v2 blob at the old AI defaults migrates to the Bailian Qwen defaults", () => {
  // 0.1.51: OpenRouter + DeepSeek V4.1 Flash were the shipped defaults, so a
  // blob still pointing at both was never customized — the same "old default
  // is never a user choice" precedent as the Segment length migration.
  const normalized = settings.normalize({
    settingsVersion: 2,
    aiApiKey: "sk-kept",
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
  });

  assert.equal(normalized.settingsVersion, 4);
  assert.equal(
    normalized.aiBaseUrl,
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  assert.equal(normalized.aiModel, "qwen3.8-flash");
  assert.equal(normalized.aiApiKey, "sk-kept");
});

test("an unstamped blob at the old AI defaults migrates too", () => {
  // Pre-0.1.41 blobs may lack the version stamp entirely.
  const normalized = settings.normalize({
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
  });

  assert.equal(normalized.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(normalized.aiModel, settings.DEFAULTS.aiModel);
  assert.equal(normalized.settingsVersion, 4);
});

test("a v2 blob with a customized AI endpoint passes through untouched", () => {
  const normalized = settings.normalize({
    settingsVersion: 2,
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "my-model",
  });

  assert.equal(normalized.aiBaseUrl, "https://api.example.com/v1");
  assert.equal(normalized.aiModel, "my-model");
  assert.equal(normalized.settingsVersion, 4);
});

test("a v2 blob with only one AI field customized keeps both stored values", () => {
  // Migration fires only when BOTH fields sit at (or lack) the old defaults:
  // one customized field proves the pair was hand-configured.
  const customModel = settings.normalize({
    settingsVersion: 2,
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "my-model",
  });
  assert.equal(customModel.aiBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(customModel.aiModel, "my-model");

  const customBaseUrl = settings.normalize({
    settingsVersion: 2,
    aiBaseUrl: "https://openrouter.ai/api/v1/",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
  });
  assert.equal(customBaseUrl.aiBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(
    customBaseUrl.aiModel,
    "deepseek/deepseek-v4.1-flash-1017",
  );
});

test("a blob stamped at the current version is never AI-migrated", () => {
  // A user who deliberately re-picks the old provider on a current install
  // keeps it: only pre-v4 stamps (or unstamped blobs) are migrated. (The
  // v4 bump re-runs the AI default migration once for v3 blobs — the same
  // one-time semantics every version stamp carries.)
  const normalized = settings.normalize({
    settingsVersion: 4,
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
  });

  assert.equal(normalized.aiBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(normalized.aiModel, "deepseek/deepseek-v4.1-flash-1017");
});

// --- Learning service origins (P6): API + Web authorization page ------------

test("learning service URLs default to the local dev servers", () => {
  const normalized = settings.normalize({});
  assert.equal(normalized.apiBaseUrl, "http://127.0.0.1:8787");
  assert.equal(normalized.webAppBaseUrl, "http://127.0.0.1:8080");
});

test("custom learning service URLs are preserved and normalized", () => {
  const normalized = settings.normalize({
    apiBaseUrl: "https://api.example.com/",
    webAppBaseUrl: "  https://learn.example.com  ",
  });
  assert.equal(normalized.apiBaseUrl, "https://api.example.com");
  assert.equal(normalized.webAppBaseUrl, "https://learn.example.com");
});

test("invalid learning service URLs fall back to the dev defaults", () => {
  const normalized = settings.normalize({
    apiBaseUrl: "not a url",
    webAppBaseUrl: "https://",
  });
  assert.equal(normalized.apiBaseUrl, settings.DEFAULTS.apiBaseUrl);
  assert.equal(normalized.webAppBaseUrl, settings.DEFAULTS.webAppBaseUrl);
});

test("learning service URLs accept plain http only on loopback", () => {
  assert.equal(
    settings.normalize({ apiBaseUrl: "http://192.168.1.5:8787" }).apiBaseUrl,
    settings.DEFAULTS.apiBaseUrl,
    "a LAN http origin is rejected",
  );
  assert.equal(
    settings.normalize({ apiBaseUrl: "http://localhost:8787" }).apiBaseUrl,
    "http://localhost:8787",
    "localhost http is allowed (self-hosted dev)",
  );
});
