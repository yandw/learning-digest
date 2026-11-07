const test = require("node:test");
const assert = require("node:assert/strict");

const speechProviders = require("../speech-providers.js");

test("the registry ships with the Groq Speech Provider", () => {
  const groq = speechProviders.getSpeechProvider("groq");

  assert.equal(groq.id, "groq");
  assert.equal(typeof groq.transcribe, "function");
  assert.ok(groq.credentialFields.some((field) => field.key === "apiKey"));
  assert.ok(groq.credentialFields.some((field) => field.key === "baseUrl"));
  assert.ok(groq.credentialFields.some((field) => field.key === "model"));
});

test("listSpeechProviders exposes every registered Speech Provider", () => {
  const ids = speechProviders.listSpeechProviders().map((p) => p.id);

  assert.ok(ids.includes("groq"));
});

test("transcribeSegment dispatches to the provider matching the id", async () => {
  speechProviders.registerSpeechProvider({
    id: "fake-provider",
    label: "Fake",
    credentialFields: [],
    transcribe: async (segmentAudio, credentials) => [
      {
        text: "fake transcript",
        start: 0,
        duration: 1,
        language: credentials.language,
      },
    ],
  });

  const records = await speechProviders.transcribeSegment(
    "fake-provider",
    "audio-bytes",
    { language: "zh" },
  );

  assert.deepEqual(records, [
    { text: "fake transcript", start: 0, duration: 1, language: "zh" },
  ]);
});

test("transcribeSegment rejects an unknown Speech Provider id", async () => {
  await assert.rejects(
    speechProviders.transcribeSegment("no-such-provider", "audio", {}),
    /Unknown Speech Provider: no-such-provider/,
  );
});

test("missingProviderCredentials requires Groq's apiKey only", () => {
  assert.deepEqual(
    speechProviders.missingProviderCredentials("groq", { apiKey: "" }),
    ["apiKey"],
  );
  assert.deepEqual(
    speechProviders.missingProviderCredentials("groq", { apiKey: "k", baseUrl: "" }),
    [],
  );
});

test("missingProviderCredentials requires both halves of Tencent's key pair", () => {
  assert.deepEqual(
    speechProviders.missingProviderCredentials("tencent", {}),
    ["secretId", "secretKey"],
  );
  assert.deepEqual(
    speechProviders.missingProviderCredentials("tencent", {
      secretId: "id",
      secretKey: "  ",
    }),
    ["secretKey"],
  );
  assert.deepEqual(
    speechProviders.missingProviderCredentials("tencent", {
      secretId: "id",
      secretKey: "key",
    }),
    [],
  );
});

test("missingProviderCredentials requires Aliyun's AccessKey pair and AppKey", () => {
  assert.deepEqual(
    speechProviders.missingProviderCredentials("aliyun", { accessKeyId: "id" }),
    ["accessKeySecret", "appKey"],
  );
  assert.deepEqual(
    speechProviders.missingProviderCredentials("aliyun", {
      accessKeyId: "id",
      accessKeySecret: "secret",
      appKey: "app",
    }),
    [],
  );
});

test("missingProviderCredentials rejects an unknown Speech Provider id", () => {
  assert.throws(
    () => speechProviders.missingProviderCredentials("no-such-provider", {}),
    /Unknown Speech Provider: no-such-provider/,
  );
});

const GROQ_VERBOSE_JSON = {
  language: "zh",
  segments: [
    { start: 0, end: 2.5, text: "大家好" },
    { start: 2.5, end: 5, text: "我们开始上课" },
  ],
};

function mockFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

const okVerboseJson = (json) => ({
  ok: true,
  status: 200,
  json: async () => json,
});

test("Groq transcribe posts multipart to baseUrl + /audio/transcriptions", async () => {
  const segmentAudio = new Blob([Uint8Array.from([1, 2, 3])], {
    type: "audio/webm",
  });
  const { fetchImpl, calls } = mockFetch(okVerboseJson(GROQ_VERBOSE_JSON));

  await speechProviders
    .getSpeechProvider("groq")
    .transcribe(
      segmentAudio,
      { apiKey: "gsk-test", baseUrl: "https://api.example.com/v1", model: "whisper-test" },
      fetchImpl,
    );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.example.com/v1/audio/transcriptions",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer gsk-test");

  const body = calls[0].init.body;
  assert.equal(body.get("model"), "whisper-test");
  assert.equal(body.get("response_format"), "verbose_json");
  const file = body.get("file");
  assert.ok(file instanceof Blob);
  assert.equal(file.type, "audio/webm");
});

test("Groq transcribe falls back to the Groq defaults for missing credentials", async () => {
  const { fetchImpl, calls } = mockFetch(okVerboseJson(GROQ_VERBOSE_JSON));

  await speechProviders
    .getSpeechProvider("groq")
    .transcribe(new Blob([]), { apiKey: "gsk-test" }, fetchImpl);

  assert.equal(
    calls[0].url,
    "https://api.groq.com/openai/v1/audio/transcriptions",
  );
  assert.equal(calls[0].init.body.get("model"), "whisper-large-v3-turbo");
});

test("Groq transcribe parses verbose_json segments into Transcript records", async () => {
  const { fetchImpl } = mockFetch(okVerboseJson(GROQ_VERBOSE_JSON));

  const records = await speechProviders
    .getSpeechProvider("groq")
    .transcribe(
      new Blob([]),
      { apiKey: "gsk-test", baseUrl: "https://api.example.com/v1", model: "m" },
      fetchImpl,
    );

  assert.deepEqual(records, [
    { text: "大家好", start: 0, duration: 2, language: "zh" },
    { text: "我们开始上课", start: 2, duration: 2, language: "zh" },
  ]);
});

test("Groq transcribe omits language when the response reports none", async () => {
  const { fetchImpl } = mockFetch(
    okVerboseJson({ segments: [{ start: 0, end: 1, text: "hello" }] }),
  );

  const records = await speechProviders
    .getSpeechProvider("groq")
    .transcribe(new Blob([]), { apiKey: "gsk-test" }, fetchImpl);

  assert.deepEqual(records, [{ text: "hello", start: 0, duration: 1 }]);
});

test("Groq transcribe returns an empty record list for empty or missing segments", async () => {
  for (const json of [{ segments: [] }, {}, { segments: "not-an-array" }]) {
    const { fetchImpl } = mockFetch(okVerboseJson(json));
    const records = await speechProviders
      .getSpeechProvider("groq")
      .transcribe(new Blob([]), { apiKey: "gsk-test" }, fetchImpl);
    assert.deepEqual(records, []);
  }
});

test("Groq transcribe rejects on a non-OK response", async () => {
  const { fetchImpl } = mockFetch({ ok: false, status: 401 });

  await assert.rejects(
    speechProviders
      .getSpeechProvider("groq")
      .transcribe(new Blob([]), { apiKey: "bad-key" }, fetchImpl),
    /HTTP 401/,
  );
});

test("Groq transcribe rejects without an API key", async () => {
  await assert.rejects(
    speechProviders.getSpeechProvider("groq").transcribe(new Blob([]), {}, async () => {
      throw new Error("must not fetch without a key");
    }),
    /requires an API key/,
  );
});
