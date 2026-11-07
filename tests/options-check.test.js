const test = require("node:test");
const assert = require("node:assert/strict");

const options = require("../options.js");

const AI_CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "example-model",
};

function fakeFetch(status) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status };
  };
  return { fetchImpl, calls };
}

test("checkAiConnection posts a minimal completion to baseUrl + /chat/completions", async () => {
  const { fetchImpl, calls } = fakeFetch(200);
  const result = await options.checkAiConnection(fetchImpl, AI_CONFIG);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(JSON.parse(calls[0].init.body).model, "example-model");
});

test("checkAiConnection classifies failure statuses", async () => {
  for (const [status, reason] of [
    [401, "aiKeyRejected"],
    [403, "aiKeyRejected"],
    [404, "aiNotFound"],
    [500, "aiHttpError"],
  ]) {
    const { fetchImpl } = fakeFetch(status);
    const result = await options.checkAiConnection(fetchImpl, AI_CONFIG);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    if (reason === "aiHttpError") assert.equal(result.status, 500);
  }

  const networkError = await options.checkAiConnection(
    async () => {
      throw new TypeError("fetch failed");
    },
    AI_CONFIG,
  );
  assert.deepEqual(networkError, { ok: false, reason: "aiUnreachable" });
});
