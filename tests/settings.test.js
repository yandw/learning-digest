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
  assert.equal(empty.settingsVersion, 3);
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

test("custom STT base URL, key, and model are preserved", () => {
  const normalized = settings.normalize({
    sttApiKey: "  stt-key  ",
    sttBaseUrl: "https://api.example.com/stt/v1/",
    sttModel: "  whisper-example  ",
  });

  assert.equal(normalized.sttBaseUrl, "https://api.example.com/stt/v1");
  assert.equal(normalized.sttModel, "whisper-example");
  assert.equal(normalized.sttApiKey, "stt-key");
  assert.equal(
    settings.sttTranscriptionsUrl(normalized.sttBaseUrl),
    "https://api.example.com/stt/v1/audio/transcriptions",
  );
});

test("empty or invalid STT endpoint config falls back to Groq defaults", () => {
  const empty = settings.normalize({});
  assert.equal(empty.sttBaseUrl, "https://api.groq.com/openai/v1");
  assert.equal(empty.sttModel, "whisper-large-v3-turbo");
  assert.equal(empty.sttApiKey, "");
  assert.equal(
    settings.sttTranscriptionsUrl(),
    "https://api.groq.com/openai/v1/audio/transcriptions",
  );

  const invalid = settings.normalize({
    sttBaseUrl: "not a url",
    sttModel: "   ",
  });
  assert.equal(invalid.sttBaseUrl, settings.DEFAULTS.sttBaseUrl);
  assert.equal(invalid.sttModel, settings.DEFAULTS.sttModel);
});

test("AI and STT provider fields normalize independently", () => {
  // A broken AI config (legacy "custom") must not reset or clear the STT
  // fields, and vice versa — the two providers are configured separately.
  const normalized = settings.normalize({
    provider: "custom",
    aiApiKey: "custom-secret",
    sttApiKey: "stt-secret",
    sttBaseUrl: "https://api.groq.com/openai/v1",
    sttModel: "whisper-large-v3",
  });

  assert.equal(normalized.aiApiKey, "");
  assert.equal(normalized.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(normalized.sttApiKey, "stt-secret");
  assert.equal(normalized.sttModel, "whisper-large-v3");
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

test("Speech Provider selection and per-provider credentials are preserved", () => {
  const normalized = settings.normalize({
    speechProvider: "groq",
    speechProviders: {
      groq: {
        apiKey: "  gsk-test  ",
        baseUrl: "https://api.example.com/v1/",
        model: "  whisper-custom  ",
      },
    },
  });

  assert.equal(normalized.speechProvider, "groq");
  assert.deepEqual(normalized.speechProviders.groq, {
    apiKey: "gsk-test",
    baseUrl: "https://api.example.com/v1/",
    model: "whisper-custom",
  });
});

test("Speech Provider settings default to Qwen with empty credentials", () => {
  const normalized = settings.normalize({});

  assert.equal(normalized.speechProvider, "qwen");
  assert.deepEqual(normalized.speechProviders, {});
});

test("malformed Speech Provider credentials are dropped, not passed through", () => {
  const normalized = settings.normalize({
    speechProvider: 42,
    speechProviders: {
      groq: "not-an-object",
      tencent: { apiKey: 7, secretId: "  id-1  " },
    },
  });

  assert.equal(normalized.speechProvider, "qwen");
  assert.equal(normalized.speechProviders.groq, undefined);
  assert.deepEqual(normalized.speechProviders.tencent, { secretId: "id-1" });
});

test("legacy custom AI migration does not clear Speech Provider credentials", () => {
  const normalized = settings.normalize({
    provider: "custom",
    aiApiKey: "custom-secret",
    speechProvider: "groq",
    speechProviders: { groq: { apiKey: "gsk-keep" } },
  });

  assert.equal(normalized.aiApiKey, "");
  assert.equal(normalized.speechProviders.groq.apiKey, "gsk-keep");
});

test("the Qwen transcription mode is validated into the segment/realtime enum", () => {
  // Both enum values pass through; the field is scoped to the qwen slot
  // (spec #44), the only provider that declares it.
  const realtime = settings.normalize({
    speechProviders: { qwen: { mode: "realtime" } },
  });
  assert.equal(realtime.speechProviders.qwen.mode, "realtime");

  const segment = settings.normalize({
    speechProviders: { qwen: { mode: "segment" } },
  });
  assert.equal(segment.speechProviders.qwen.mode, "segment");

  // Invalid and absent values fall back to the default segment mode.
  for (const bad of ["yolo", "", "  ", 7, null]) {
    const normalized = settings.normalize({
      speechProviders: { qwen: { mode: bad } },
    });
    assert.equal(normalized.speechProviders.qwen.mode, "segment", String(bad));
  }
  const absent = settings.normalize({
    speechProviders: { qwen: { apiKey: "sk-qwen" } },
  });
  assert.deepEqual(absent.speechProviders.qwen, {
    apiKey: "sk-qwen",
    mode: "segment",
  });

  // Other providers are untouched: no mode key is invented for them.
  const groq = settings.normalize({
    speechProviders: { groq: { apiKey: "gsk-keep" } },
  });
  assert.deepEqual(groq.speechProviders.groq, { apiKey: "gsk-keep" });
});

test("Segment length defaults to 30 seconds", () => {
  const normalized = settings.normalize({});

  assert.equal(normalized.segmentLengthSeconds, 30);
});

test("Segment length is clamped into the supported 30-600 range", () => {
  assert.equal(settings.normalize({ segmentLengthSeconds: 10 }).segmentLengthSeconds, 30);
  assert.equal(settings.normalize({ segmentLengthSeconds: 30 }).segmentLengthSeconds, 30);
  assert.equal(settings.normalize({ segmentLengthSeconds: 600 }).segmentLengthSeconds, 600);
  assert.equal(settings.normalize({ segmentLengthSeconds: 3600 }).segmentLengthSeconds, 600);
  assert.equal(settings.normalize({ segmentLengthSeconds: 180 }).segmentLengthSeconds, 180);
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
  assert.equal(normalized.settingsVersion, 3);
});

test("a stamped blob keeps a hand-tuned Segment length", () => {
  // A v2 stamp (0.1.41-0.1.50) is below the current version, but 600 was
  // never a shipped default, so the hand-tuned value passes through and the
  // blob is re-stamped to the current version.
  const normalized = settings.normalize({
    settingsVersion: 2,
    segmentLengthSeconds: 600,
  });

  assert.equal(normalized.segmentLengthSeconds, 600);
  assert.equal(normalized.settingsVersion, 3);
});

test("an unstamped blob with a hand-tuned Segment length keeps it", () => {
  const normalized = settings.normalize({ segmentLengthSeconds: 600 });

  assert.equal(normalized.segmentLengthSeconds, 600);
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

  assert.equal(normalized.settingsVersion, 3);
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
  assert.equal(normalized.settingsVersion, 3);
});

test("a v2 blob with a customized AI endpoint passes through untouched", () => {
  const normalized = settings.normalize({
    settingsVersion: 2,
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "my-model",
  });

  assert.equal(normalized.aiBaseUrl, "https://api.example.com/v1");
  assert.equal(normalized.aiModel, "my-model");
  assert.equal(normalized.settingsVersion, 3);
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
  // A user who deliberately re-picks the old provider on a v3 install keeps
  // it: only pre-v3 stamps (or unstamped blobs) are migrated.
  const normalized = settings.normalize({
    settingsVersion: 3,
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
  });

  assert.equal(normalized.aiBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(normalized.aiModel, "deepseek/deepseek-v4.1-flash-1017");
});
