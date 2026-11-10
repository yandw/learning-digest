const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers/harness");

// Slice 1: the app skeleton speaks the shared contract's error envelope on
// every non-2xx response ({ error: { code, message } }), and unknown paths
// fail closed with 404 not_found. Wrong-method and malformed-body cases are
// covered once the routes that own them exist (auth slices).

test("unknown /v1 path returns 404 with the contract error envelope", async () => {
  const app = await startApp();
  try {
    const response = await app.request("GET", "/v1/does-not-exist");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(response.json, {
      error: { code: "not_found", message: "未知接口路径" },
    });
  } finally {
    await app.close();
  }
});

test("path outside /v1 is also a 404 with the same envelope", async () => {
  const app = await startApp();
  try {
    const response = await app.request("GET", "/healthz");
    assert.equal(response.status, 404);
    assert.deepEqual(response.json, {
      error: { code: "not_found", message: "未知接口路径" },
    });
  } finally {
    await app.close();
  }
});
