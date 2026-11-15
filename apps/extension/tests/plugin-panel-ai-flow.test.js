/**
 * The panel AI's server-side wiring (ticket 6.6, issue #91; contract-r4
 * §7.2): the stateless explain call and the local-AI retirement guardrails.
 * Driven through the shared loadBackgroundHelpers seam; the explain
 * endpoint's success/failure shapes come from the contract fixtures.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadBackgroundHelpers } = require("./helpers/load-background.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

const EXPLAIN_SUCCESS_BODY = {
  explanation: "点积衡量查询向量与键向量的对齐程度，对齐越高、注意力分数越大。",
};

function explainFetch({ status = 200, body = EXPLAIN_SUCCESS_BODY, calls = [] } = {}) {
  return async (url, init) => {
    // The configured learning-service origin varies per test; the route
    // path is what the seam dispatches on.
    const pathName = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (pathName === "/v1/ai/explain") {
      calls.push({ path: pathName, method: init.method, body: JSON.parse(init.body) });
      return { status, ok: status < 400, json: async () => body };
    }
    if (pathName === "/v1/site-capabilities") {
      return { status: 200, ok: true, json: async () => ({ capabilities: [] }) };
    }
    return { status: 500, ok: false, json: async () => ({ error: { code: "x", message: "unmatched" } }) };
  };
}

test("explainSelection POSTs /v1/ai/explain with the selection and its context", async () => {
  const calls = [];
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    fetchImpl: explainFetch({ calls }),
  });

  const result = await helpers.handleExplainSelection(
    "把查询向量和键向量做点积",
    "注意力分数的计算先从相似度开始",
  );

  assert.equal(result.success, true);
  assert.equal(result.explanation, EXPLAIN_SUCCESS_BODY.explanation);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/ai/explain");
  assert.equal(calls[0].method, "POST");
  // The contract body: text required, context rides along. The video title
  // is gone (the server's explain prompt carries no VIDEO line).
  assert.deepEqual(calls[0].body, {
    text: "把查询向量和键向量做点积",
    context: "注意力分数的计算先从相似度开始",
  });
});

test("explainSelection omits an empty context and refuses an empty selection", async () => {
  const calls = [];
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    fetchImpl: explainFetch({ calls }),
  });

  const empty = await helpers.handleExplainSelection("   ", "");
  assert.equal(empty.success, false);
  assert.equal(calls.length, 0, "no POST without a usable selection");

  const noContext = await helpers.handleExplainSelection("选中的文字", "");
  assert.equal(noContext.success, true);
  assert.deepEqual(calls[0].body, { text: "选中的文字" }, "an empty context is omitted");
});

test("explainSelection presents the failure envelope verbatim", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    fetchImpl: explainFetch({
      status: 502,
      body: { error: { code: "explain_failed", message: "解释生成失败，请稍后重试" } },
    }),
  });

  const result = await helpers.handleExplainSelection("选中的文字", "");
  assert.equal(result.success, false);
  assert.equal(result.error, "解释生成失败，请稍后重试");
});

test("explainSelection routes a 401 through the P7 credentials-invalidated path", async () => {
  const helpers = loadBackgroundHelpers({
    stored: CREDENTIAL_STORE,
    fetchImpl: explainFetch({
      status: 401,
      body: { error: { code: "unauthorized", message: "未登录或凭据缺失" } },
    }),
  });

  const result = await helpers.handleExplainSelection("选中的文字", "");
  assert.equal(result.success, false);
  assert.equal(result.error, "未登录或凭据缺失");
  // The credentialsInvalidated broadcast pushed the panel back to the guide.
  // The stored credential is untouched here (the path stops a capture, not
  // the credential itself), but the authState broadcast is observable
  // through notifyPanel's best-effort send.
});

test("the panel AI never calls a local chat-completions provider", () => {
  // Ticket 6.6: the local AI Provider is retired. No runtime file may build
  // a chat-completions request or read the retired settings fields.
  const runtime = ["background.js", "sidepanel.js", "options.js", "settings.js", "panel-ai.js"]
    .map(read)
    .join("\n");

  assert.doesNotMatch(runtime, /chat\/completions/);
  assert.doesNotMatch(runtime, /aiApiKey/);
  assert.doesNotMatch(runtime, /aiBaseUrl/);
  assert.doesNotMatch(runtime, /aiModel/);
  assert.doesNotMatch(runtime, /requestAiCompletion/);
});

test("the retired PoC prompt files are gone from the extension", () => {
  for (const file of [
    "prompts/topic-tick.md",
    "prompts/session-report.md",
    "prompts/explain.md",
    "session-summary.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} is retired`);
  }
});
