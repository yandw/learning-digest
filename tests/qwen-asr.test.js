const test = require("node:test");
const assert = require("node:assert/strict");

const speechProviders = require("../speech-providers.js");

const qwen = speechProviders.getSpeechProvider("qwen");

function makeAudio(bytes, props = {}) {
  return {
    type: "audio/webm",
    async arrayBuffer() {
      return new Uint8Array(bytes).buffer;
    },
    ...props,
  };
}

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { calls, fetchImpl };
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

test("the registry ships with the Qwen ASR Speech Provider", () => {
  assert.ok(qwen, "qwen provider is registered");
  assert.equal(qwen.id, "qwen");
  assert.equal(typeof qwen.transcribe, "function");
  const keys = qwen.credentialFields.map((field) => field.key);
  assert.deepEqual(keys, ["apiKey", "baseUrl", "model", "mode"]);
  assert.equal(
    qwen.credentialFields.find((f) => f.key === "apiKey").type,
    "password",
  );
  assert.equal(
    qwen.defaults.baseUrl,
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  assert.equal(qwen.defaults.model, "qwen3-asr-flash");
  assert.equal(typeof qwen.helpLink, "string");
});

test("the Qwen transcription mode is a radio field with the segment default (#45)", () => {
  const modeField = qwen.credentialFields.find((f) => f.key === "mode");

  assert.ok(modeField, "the mode field is declared");
  assert.equal(modeField.type, "radio");
  assert.deepEqual(
    modeField.options.map((option) => option.value),
    ["segment", "realtime"],
  );
  assert.deepEqual(
    modeField.options.map((option) => option.label),
    ["分段转写（默认）", "实时转写（直播）"],
  );
  assert.equal(qwen.defaults.mode, "segment");
});

test("listSpeechProviders exposes all three providers: Groq, Tencent, Qwen", () => {
  const ids = speechProviders.listSpeechProviders().map((p) => p.id);
  assert.deepEqual(ids, ["groq", "tencent", "qwen"]);
});

test("transcribe posts one input_audio Data URI and maps the response to one record", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    okResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "欢迎使用阿里云。",
            annotations: [
              { type: "audio_info", language: "zh", emotion: "neutral" },
            ],
          },
        },
      ],
      usage: { seconds: 7 },
    }),
  );

  const audio = makeAudio([1, 2, 3, 4], { ytdSegmentDuration: 120 });
  const records = await qwen.transcribe(
    audio,
    { apiKey: "sk-test" },
    fetchImpl,
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer sk-test",
  );

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "qwen3-asr-flash");
  assert.equal(body.asr_options.language, "zh");
  assert.equal(body.asr_options.enable_itn, true);
  const part = body.messages[0].content[0];
  assert.equal(part.type, "input_audio");
  assert.match(part.input_audio.data, /^data:audio\/webm;base64,/);

  assert.equal(records.length, 1);
  assert.equal(records[0].text, "欢迎使用阿里云。");
  assert.equal(records[0].start, 0);
  // Segment hint wins over the provider-reported duration.
  assert.equal(records[0].duration, 120);
  assert.equal(records[0].language, "zh");
});

test("duration falls back to usage.seconds when no Segment hint exists", async () => {
  const { fetchImpl } = stubFetch(() =>
    okResponse({
      choices: [{ message: { content: "第二段内容。" } }],
      usage: { seconds: 42 },
    }),
  );

  const records = await qwen.transcribe(
    makeAudio([9, 9]),
    { apiKey: "sk-test" },
    fetchImpl,
  );

  assert.equal(records[0].duration, 42);
  assert.equal(records[0].language, undefined);
});

test("custom base URL and model override the defaults", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    okResponse({ choices: [{ message: { content: "ok" } }] }),
  );

  await qwen.transcribe(
    makeAudio([1]),
    {
      apiKey: "sk-test",
      baseUrl: "https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
      model: "qwen3-asr-flash",
    },
    fetchImpl,
  );

  assert.equal(
    calls[0].url,
    "https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
});

test("empty recognition content yields no records", async () => {
  const { fetchImpl } = stubFetch(() =>
    okResponse({ choices: [{ message: { content: "  " } }] }),
  );

  const records = await qwen.transcribe(
    makeAudio([1]),
    { apiKey: "sk-test" },
    fetchImpl,
  );
  assert.deepEqual(records, []);
});

test("transcribe rejects a missing API key and HTTP errors", async () => {
  await assert.rejects(
    qwen.transcribe(makeAudio([1]), {}, async () => {
      throw new Error("must not be called");
    }),
    /requires a Bailian API key/,
  );

  const { fetchImpl } = stubFetch(() => ({ ok: false, status: 401 }));
  await assert.rejects(
    qwen.transcribe(makeAudio([1]), { apiKey: "sk-bad" }, fetchImpl),
    /HTTP 401/,
  );
});

test("a non-OK response includes the response body in the error", async () => {
  // The body is where dashscope says WHY (unsupported audio format, invalid
  // key, model access); the error must carry it or failures are blind spots.
  const { fetchImpl } = stubFetch(() => ({
    ok: false,
    status: 400,
    text: async () => '{"error":{"code":"InvalidParameter","message":"audio format not supported"}}',
  }));
  await assert.rejects(
    qwen.transcribe(makeAudio([1]), { apiKey: "sk-test" }, fetchImpl),
    /HTTP 400.*audio format not supported/s,
  );
});

test("audio whose base64 form exceeds 10 MB is rejected before the request", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    okResponse({ choices: [{ message: { content: "ok" } }] }),
  );

  // 8 MiB of raw audio encodes to ~11.6 MB of base64: over the limit.
  const big = makeAudio(new Array(8 * 1024 * 1024).fill(1));
  await assert.rejects(
    qwen.transcribe(big, { apiKey: "sk-test" }, fetchImpl),
    /10 MB encoded limit/,
  );
  assert.equal(calls.length, 0);
});
