/**
 * WorkerClient — the worker's HTTP seam to the API (ticket 2.3, §3.7).
 *
 * Seam: createWorkerClient with an injectable fetchImpl (same injection
 * point as the providers). Tests pin the request shapes and the non-2xx
 * error mapping; the happy paths against a REAL loopback API run in
 * apps/api/test/audio-chain.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkerClient } = require("../lib/client");

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

test("client: claim posts the worker credential and the limit", async () => {
  const { calls, impl } = stubFetch({ tasks: [] });
  const client = createWorkerClient({
    apiBase: "http://127.0.0.1:8787",
    token: "worker-secret",
    fetchImpl: impl,
  });

  const result = await client.claim({ limit: 3 });

  assert.deepEqual(result, { tasks: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/worker/tasks/claim");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer worker-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), { limit: 3 });
});

test("client: submitResult posts to the task's result endpoint", async () => {
  const { calls, impl } = stubFetch({ taskId: "tsk_1", status: "done" });
  const client = createWorkerClient({
    apiBase: "http://127.0.0.1:8787",
    token: "worker-secret",
    fetchImpl: impl,
  });

  const result = await client.submitResult("tsk_1", {
    status: "done",
    records: [{ startMs: 30000, endMs: 60000, text: "text" }],
  });

  assert.deepEqual(result, { taskId: "tsk_1", status: "done" });
  assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/worker/tasks/tsk_1/result");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer worker-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    status: "done",
    records: [{ startMs: 30000, endMs: 60000, text: "text" }],
  });
});

test("client: non-2xx answers reject with status and the API error code", async () => {
  const { impl } = stubFetch(
    JSON.stringify({ error: { code: "unauthorized", message: "Worker 凭据缺失或无效" } }),
    { status: 401 },
  );
  const client = createWorkerClient({
    apiBase: "http://127.0.0.1:8787",
    token: "wrong",
    fetchImpl: impl,
  });
  await assert.rejects(client.claim({ limit: 1 }), (error) => {
    assert.match(error.message, /401/);
    assert.match(error.message, /unauthorized/);
    return true;
  });
});
