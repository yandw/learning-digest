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

test("empty or invalid AI endpoint config falls back to DeepSeek defaults", () => {
  const empty = settings.normalize({});
  assert.equal(empty.aiBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(empty.aiModel, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(
    settings.chatCompletionsUrl(),
    "https://openrouter.ai/api/v1/chat/completions",
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
