/**
 * AI Provider seam unit tests (contract-r3.md §2.3; decisions D16/D17,
 * ticket 3.2, issue #74). Seam under test: lib/ai-providers.js — the
 * interface the summary generation calls ({ id, model, generate({ system,
 * user }) }), never the HTTP route.
 *
 * Testing Decisions: a replacement AI Provider makes tests repeatable. The
 * stub must be deterministic (same input -> same output) and cite real
 * input material so the citation reconciliation can hold. The qwen
 * provider is tested for REQUEST SHAPE through an injected fetch (Bailian
 * compatible-mode chat/completions; no external network) — real calls
 * stay out of the test suite (D16: 真实调用留实测).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStubProvider, createQwenProvider, selectAiProvider } = require("../lib/ai-providers");

const SYSTEM = "系统提示：只输出一个 JSON 对象。";
const USER = [
  "资料标题：注意力机制详解 P2：自注意力",
  "",
  "已归档逐字稿（按来源时间轴排序）：",
  "[ses_a 0–30000] 欢迎来到这一节",
  "[ses_b 30000–60000] 注意力分数的计算",
  "[ses_a 138000–159000] 矩阵视角",
  "",
  "已跳过范围：",
  "[ses_b 150000–210000] 已跳过，该范围未取得文本",
  "",
  "学习者笔记：",
  "[src_x 200000] 3:20 起的例子值得回看",
].join("\n");

test("stub provider: deterministic — same input, byte-identical output", async () => {
  const provider = createStubProvider();
  const first = await provider.generate({ system: SYSTEM, user: USER });
  const second = await provider.generate({ system: SYSTEM, user: USER });
  assert.deepEqual(second, first);
});

test("stub provider: exposes id + model, produces markdown content that names the resource", async () => {
  const provider = createStubProvider();
  assert.equal(provider.id, "stub");
  assert.ok(provider.model && typeof provider.model === "string");
  const generated = await provider.generate({ system: SYSTEM, user: USER });
  assert.equal(typeof generated.content, "string");
  assert.ok(generated.content.includes("注意力机制详解 P2：自注意力"));
  assert.ok(generated.content.includes("##"));
});

test("stub provider: citations quote the transcript lines verbatim, one (latest) per session", async () => {
  const provider = createStubProvider();
  const generated = await provider.generate({ system: SYSTEM, user: USER });
  assert.ok(Array.isArray(generated.citations));
  // One citation per distinct session — that session's latest record on
  // the shared timeline, quote verbatim, sorted by startMs.
  assert.deepEqual(
    generated.citations.map((c) => [c.sessionId, c.startMs, c.endMs, c.quote]),
    [
      ["ses_b", 30000, 60000, "注意力分数的计算"],
      ["ses_a", 138000, 159000, "矩阵视角"],
    ],
  );
});

test("stub provider: model override is honored", async () => {
  const provider = createStubProvider({ model: "stub-custom" });
  assert.equal(provider.model, "stub-custom");
});

test("qwen provider: requires an API key at construction (fails closed)", () => {
  assert.throws(() => createQwenProvider(), /API key/);
  assert.throws(() => createQwenProvider({ apiKey: "   " }), /API key/);
});

test("qwen provider: default model is configurable and defaults to qwen3.8-flash", () => {
  assert.equal(createQwenProvider({ apiKey: "k" }).model, "qwen3.8-flash");
  assert.equal(createQwenProvider({ apiKey: "k", model: "qwen-plus" }).model, "qwen-plus");
});

test("qwen provider: posts Bailian compatible-mode chat/completions with system+user and parses the JSON payload", async () => {
  const calls = [];
  const payload = {
    content: "# 总结",
    citations: [{ quote: "原文", sessionId: "ses_a", startMs: 0, endMs: 30000 }],
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
      text: async () => "",
    };
  };
  const provider = createQwenProvider({ apiKey: "ld-key", fetchImpl });
  const generated = await provider.generate({ system: SYSTEM, user: USER });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer ld-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "qwen3.8-flash");
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ["system", "user"],
  );
  assert.equal(body.messages[0].content, SYSTEM);
  assert.equal(body.messages[1].content, USER);
  assert.deepEqual(generated, payload);
});

test("qwen provider: baseUrl and model overrides hit the configured endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"content":"c","citations":[]}' } }] }),
      text: async () => "",
    };
  };
  const provider = createQwenProvider({ apiKey: "k", baseUrl: "https://proxy.example/v1/", model: "qwen-plus", fetchImpl });
  await provider.generate({ system: "s", user: "u" });
  assert.equal(calls[0].url, "https://proxy.example/v1/chat/completions");
  assert.equal(JSON.parse(calls[0].init.body).model, "qwen-plus");
});

test("qwen provider: fenced markdown JSON output is parsed; bare text with an embedded object too", async () => {
  const makeFetch = (content) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  });
  const fenced = await createQwenProvider({ apiKey: "k", fetchImpl: makeFetch("```json\n{\"content\":\"c\",\"citations\":[]}\n```") })
    .generate({ system: "s", user: "u" });
  assert.deepEqual(fenced, { content: "c", citations: [] });

  const chatty = await createQwenProvider({
    apiKey: "k",
    fetchImpl: makeFetch('前言 {"content":"正","citations":[{"quote":"q","sessionId":"s","startMs":1,"endMs":2}]} 后记'),
  }).generate({ system: "s", user: "u" });
  assert.equal(chatty.content, "正");
  assert.equal(chatty.citations.length, 1);

  // Missing citations key defaults to [] (content-only responses stay usable).
  const noCitations = await createQwenProvider({ apiKey: "k", fetchImpl: makeFetch('{"content":"c"}') })
    .generate({ system: "s", user: "u" });
  assert.deepEqual(noCitations, { content: "c", citations: [] });
});

test("qwen provider: HTTP failure and unparseable payloads both throw (the route turns them into 502)", async () => {
  const failingFetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
    text: async () => "rate limited",
  });
  await assert.rejects(
    createQwenProvider({ apiKey: "k", fetchImpl: failingFetch }).generate({ system: "s", user: "u" }),
    /HTTP 429/,
  );

  const garbageFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "完全不是 JSON" } }] }),
    text: async () => "",
  });
  await assert.rejects(
    createQwenProvider({ apiKey: "k", fetchImpl: garbageFetch }).generate({ system: "s", user: "u" }),
    /unparseable/,
  );
});

test("selectAiProvider: defaults to stub; qwen only with a key; unknown names fail loudly", () => {
  assert.equal(selectAiProvider({}).id, "stub");
  assert.equal(selectAiProvider({ aiProviderName: "stub" }).id, "stub");
  assert.equal(selectAiProvider({ aiProviderName: "qwen", aiApiKey: "ld-key" }).id, "qwen");
  // A qwen selection without a key fails closed at startup, not per request.
  assert.throws(() => selectAiProvider({ aiProviderName: "qwen" }), /API key/);
  assert.throws(() => selectAiProvider({ aiProviderName: "bogus" }), /bogus/);
  // The model override flows through to the constructed provider.
  assert.equal(selectAiProvider({ aiModel: "stub-x" }).model, "stub-x");
  assert.equal(selectAiProvider({ aiProviderName: "qwen", aiApiKey: "k", aiModel: "qwen-plus" }).model, "qwen-plus");
});
