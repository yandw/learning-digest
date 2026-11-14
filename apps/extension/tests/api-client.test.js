/**
 * Shared API client helpers (round-1 review fix): the §1 envelope readers
 * and the base-URL joining rule extracted from their per-module copies in
 * auth-gate.js / collect.js / notes.js / learning-start.js. This test pins
 * the shared behavior once; the consuming modules' own suites keep pinning
 * their outcomes (copy strings, verdicts), so a drift in either direction
 * breaks loudly.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const YTD_API_CLIENT = require("../api-client.js");

test("parseEnvelope returns the §1 envelope message when well-formed", () => {
  assert.equal(
    YTD_API_CLIENT.parseEnvelope(
      { error: { code: "validation_failed", message: "缺少必填字段 url" } },
      "回退文案",
    ),
    "缺少必填字段 url",
  );
  assert.equal(YTD_API_CLIENT.parseEnvelope({ error: { message: "" } }, "回退文案"), "回退文案", "an empty message is not a message");
  for (const broken of [null, undefined, "text", { error: null }, { error: {} }, {}]) {
    assert.equal(YTD_API_CLIENT.parseEnvelope(broken, "回退文案"), "回退文案", JSON.stringify(broken));
  }
});

test("envelopeCode returns the §1 error code or null", () => {
  assert.equal(YTD_API_CLIENT.envelopeCode({ error: { code: "unauthorized", message: "x" } }), "unauthorized");
  assert.equal(YTD_API_CLIENT.envelopeCode({ error: { code: 42, message: "x" } }), null, "a non-string code is no code");
  assert.equal(YTD_API_CLIENT.envelopeCode(null), null);
  assert.equal(YTD_API_CLIENT.envelopeCode({}), null);
});

test("buildApiUrl joins a configured base and a /v1 path", () => {
  assert.equal(YTD_API_CLIENT.buildApiUrl("https://api.example.com", "/v1/me"), "https://api.example.com/v1/me");
  assert.equal(YTD_API_CLIENT.buildApiUrl("https://api.example.com/", "/v1/me"), "https://api.example.com/v1/me", "trailing slashes drop");
  assert.equal(YTD_API_CLIENT.buildApiUrl("https://api.example.com///", "v1/me"), "https://api.example.com/v1/me", "a path without its slash still joins");
  assert.equal(YTD_API_CLIENT.buildApiUrl(" http://127.0.0.1:8787 ", "/v1/me"), "http://127.0.0.1:8787/v1/me", "whitespace trims");
});

test("buildApiUrl refuses non-http(s) or unusable bases", () => {
  for (const bad of ["", "   ", "chrome-extension://abc", "ftp://x", "not a url"]) {
    assert.equal(YTD_API_CLIENT.buildApiUrl(bad, "/v1/me"), null, JSON.stringify(bad));
  }
  assert.equal(YTD_API_CLIENT.buildApiUrl(undefined, "/v1/me"), null);
  assert.equal(YTD_API_CLIENT.buildApiUrl("https://api.example.com", ""), "https://api.example.com/", "an empty path still yields the base");
});
