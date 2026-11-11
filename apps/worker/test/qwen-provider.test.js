/**
 * Qwen Speech Provider (ticket 2.3; port of the PoC speech-providers.js
 * qwen3-asr-flash segment call shape).
 *
 * Seam: provider.transcribe() with an injectable fetch — the HTTP boundary
 * IS the seam here (same injection point the PoC uses). Tests pin the
 * request shape (URL, headers, chat-completions body with the base64 Data
 * URI) and parse the response shape; no external network is contacted.
 * The real dashscope call stays a manual/ops exercise.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createQwenProvider } = require("../lib/providers/qwen");

const DEFAULTS = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3-asr-flash",
};

/** A fetch stub that records the request and answers with a canned body. */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    };
  };
  return { calls, impl };
}

const SEGMENT_INPUT = {
  audioBase64: "U29tZV9hdWRpb19ieXRlcw==",
  audioMimeType: "audio/webm;codecs=opus",
  segment: { segmentIndex: 1, startMs: 30000, endMs: 60000 },
};

test("qwen provider: one segment is one chat-completions call in the PoC shape", async () => {
  const { calls, impl } = stubFetch({
    choices: [{ message: { content: "注意力分数的计算，就是把查询向量和键向量做点积" } }],
  });
  const provider = createQwenProvider({ ...DEFAULTS, apiKey: "qwen-key", fetchImpl: impl });

  const records = await provider.transcribe(SEGMENT_INPUT);

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer qwen-key");
  assert.equal(init.headers["Content-Type"], "application/json");

  const requestBody = JSON.parse(init.body);
  assert.deepEqual(Object.keys(requestBody).sort(), ["asr_options", "messages", "model"]);
  assert.equal(requestBody.model, "qwen3-asr-flash");
  assert.deepEqual(requestBody.asr_options, { language: "zh", enable_itn: true });
  assert.equal(requestBody.messages.length, 1);
  assert.equal(requestBody.messages[0].role, "user");
  assert.deepEqual(requestBody.messages[0].content, [
    {
      type: "input_audio",
      input_audio: { data: "data:audio/webm;codecs=opus;base64,U29tZV9hdWRpb19ieXRlcw==" },
    },
  ]);

  // Segment-relative record spanning the whole segment (the caller folds).
  assert.deepEqual(records, [
    { startMs: 0, endMs: 30000, text: "注意力分数的计算，就是把查询向量和键向量做点积" },
  ]);
});

test("qwen provider: empty content is a silence segment (empty records)", async () => {
  const { impl } = stubFetch({ choices: [{ message: { content: "  " } }] });
  const provider = createQwenProvider({ ...DEFAULTS, apiKey: "qwen-key", fetchImpl: impl });
  const records = await provider.transcribe(SEGMENT_INPUT);
  assert.deepEqual(records, []);
});

test("qwen provider: HTTP failures surface the provider detail (poor man's providerHttpError)", async () => {
  const { impl } = stubFetch("_rate limit body", { status: 429 });
  const provider = createQwenProvider({ ...DEFAULTS, apiKey: "qwen-key", fetchImpl: impl });
  await assert.rejects(
    provider.transcribe(SEGMENT_INPUT),
    /Qwen Speech Provider request failed with HTTP 429: _rate limit body/,
  );
});

test("qwen provider: missing api key fails at construction, before any request", () => {
  const { calls, impl } = stubFetch({});
  // Factory-time throw (fail fast at worker startup, not per task).
  assert.throws(
    () => createQwenProvider({ ...DEFAULTS, apiKey: "  ", fetchImpl: impl }),
    /requires a Bailian API key/,
  );
  assert.equal(calls.length, 0);
});
