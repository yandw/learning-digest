import { test } from "node:test";
import assert from "node:assert/strict";
import { startUpstream } from "./helpers/upstream.js";
import { startWebApp, makeEmptyPublicDir } from "./helpers/web.js";

// Seam: the web server's /v1 reverse proxy. The page talks only to its own
// origin; the server forwards /v1/* to the API upstream and passes the
// response through verbatim — status and error envelope included — so the
// browser never needs CORS and never sees a mangled contract error.

test("forwards /v1 requests to the upstream with method, path, body and auth header", async () => {
  const upstream = await startUpstream();
  const web = await startWebApp({
    upstream: upstream.url,
    publicDir: makeEmptyPublicDir(),
  });
  try {
    const response = await web.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
      headers: { Authorization: "Bearer stored-token" },
    });

    assert.equal(response.status, 200);
    const echo = response.json.echo;
    assert.equal(echo.method, "POST");
    assert.equal(echo.path, "/v1/auth/request-code");
    assert.equal(echo.authorization, "Bearer stored-token");
    assert.equal(echo.contentType, "application/json");
    assert.deepEqual(JSON.parse(echo.body), { email: "learner@example.com" });
    assert.equal(upstream.requests.length, 1);
  } finally {
    await web.close();
    await upstream.close();
  }
});

test("passes upstream error responses through verbatim (status + envelope)", async () => {
  const contractEnvelope = {
    error: { code: "unauthorized", message: "验证码错误或已过期" },
  };
  const upstream = await startUpstream({
    respond: () => ({
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(contractEnvelope),
    }),
  });
  const web = await startWebApp({
    upstream: upstream.url,
    publicDir: makeEmptyPublicDir(),
  });
  try {
    const response = await web.request("POST", "/v1/auth/verify", {
      body: { email: "learner@example.com", code: "000000" },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, contractEnvelope);
  } finally {
    await web.close();
    await upstream.close();
  }
});

test("preserves query strings on forwarded /v1 paths", async () => {
  const upstream = await startUpstream();
  const web = await startWebApp({
    upstream: upstream.url,
    publicDir: makeEmptyPublicDir(),
  });
  try {
    await web.request("GET", "/v1/resources?limit=5&sort=recent");
    assert.equal(upstream.requests[0].path, "/v1/resources?limit=5&sort=recent");
  } finally {
    await web.close();
    await upstream.close();
  }
});

test("unknown /v1 paths stay transparent: the upstream 404 envelope is returned", async () => {
  const upstreamEnvelope = {
    error: { code: "not_found", message: "未知接口路径" },
  };
  const upstream = await startUpstream({
    respond: () => ({
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(upstreamEnvelope),
    }),
  });
  const web = await startWebApp({
    upstream: upstream.url,
    publicDir: makeEmptyPublicDir(),
  });
  try {
    const response = await web.request("GET", "/v1/nonexistent");
    assert.equal(response.status, 404);
    assert.deepEqual(response.json, upstreamEnvelope);
  } finally {
    await web.close();
    await upstream.close();
  }
});

test("forwards PATCH with a JSON body (the §3.7 retitle path)", async () => {
  const upstream = await startUpstream();
  const web = await startWebApp({
    upstream: upstream.url,
    publicDir: makeEmptyPublicDir(),
  });
  try {
    const response = await web.request("PATCH", "/v1/resources/res_01JABC0010", {
      body: { title: "手动补的标题" },
      headers: { Authorization: "Bearer stored-token" },
    });

    assert.equal(response.status, 200);
    const echo = response.json.echo;
    assert.equal(echo.method, "PATCH");
    assert.equal(echo.path, "/v1/resources/res_01JABC0010");
    assert.equal(echo.authorization, "Bearer stored-token");
    assert.deepEqual(JSON.parse(echo.body), { title: "手动补的标题" });
  } finally {
    await web.close();
    await upstream.close();
  }
});

test("unreachable upstream answers 502 with an error envelope", async () => {
  const web = await startWebApp({
    // Port 9 on loopback: nothing listens there during tests.
    upstream: "http://127.0.0.1:9",
    publicDir: makeEmptyPublicDir(),
  });
  try {
    const response = await web.request("GET", "/v1/resources");
    assert.equal(response.status, 502);
    assert.deepEqual(response.json, {
      error: { code: "upstream_unavailable", message: "学习服务暂时不可用，请稍后重试" },
    });
  } finally {
    await web.close();
  }
});
