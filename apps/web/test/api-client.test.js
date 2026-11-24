import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient } from "../public/js/api-client.js";
import { createCredentialStore, CREDENTIALS_KEY } from "../public/js/credentials.js";

// Round-2 contract fixtures (session-examples.json): the TranscriptView
// samples are the authoritative shape for the Web's transcript read-back.
const apiSessionExampleById = new Map(
  JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..", "..", "contracts", "fixtures", "session-examples.json"),
      "utf8",
    ),
  ).samples.map((s) => [s.id, s]),
);

// Round-3 contract fixtures (summary-examples.json): the authoritative
// request/response shapes for generation, the history list, the summary
// detail and the usage read (contract-r3.md §3.1-§3.4).
const apiSummaryExampleById = new Map(
  JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..", "..", "contracts", "fixtures", "summary-examples.json"),
      "utf8",
    ),
  ).samples.map((s) => [s.id, s]),
);

// Round-4 contract fixtures (site-capability-examples.json): the admin
// surface shapes for the site-capability table read and the one-row
// subset patch (contract-r4.md §3.2/§3.3), plus the me() admin flag.
const siteCapabilityExampleById = new Map(
  JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..", "..", "contracts", "fixtures", "site-capability-examples.json"),
      "utf8",
    ),
  ).samples.map((s) => [s.id, s]),
);
// The round-4 error samples live at the tail of error-examples.json (the
// capability fixture's own description pins that location).
const errorExampleById = new Map(
  JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..", "..", "contracts", "fixtures", "error-examples.json"),
      "utf8",
    ),
  ).samples.map((s) => [s.id, s]),
);

// The page's API access seam (pure module over an injectable fetch). Every
// request carries the stored credential as `Authorization: Bearer <token>`;
// a 401 on an authenticated call means the credential expired or was
// revoked by linked logout (P7 depends on this) — the client then clears
// the credential and hands control back to the caller's onUnauthorized.
// 401 on UNauthenticated calls (request-code / verify) is a form error and
// must NOT trigger the interceptor.

function mapStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function fakeFetch(responses) {
  /** @type {{ path: string, init: object }[]} */
  const calls = [];
  const impl = async (path, init) => {
    calls.push({ path, init });
    const response = responses.shift();
    if (!response) {
      throw new Error("no scripted response left");
    }
    if (response.reject) {
      throw new TypeError("fetch failed");
    }
    return {
      status: response.status,
      text: async () => (response.body === undefined ? "" : JSON.stringify(response.body)),
    };
  };
  return { impl, calls };
}

function credentialsWith(token) {
  const credentials = createCredentialStore({ storage: mapStorage() });
  credentials.set({
    token,
    email: "learner@example.com",
    accountId: "acc_01",
    credentialGroupId: "cg_01",
  });
  return credentials;
}

test("authenticated requests carry Authorization: Bearer <token>", async () => {
  const fetcher = fakeFetch([{ status: 200, body: { ok: true } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.request("GET", "/v1/me");

  assert.equal(fetcher.calls[0].path, "/v1/me");
  assert.equal(fetcher.calls[0].init.method, "GET");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(result, { ok: true, status: 200, data: { ok: true } });
});

test("requests without a stored credential send no Authorization header", async () => {
  const fetcher = fakeFetch([{ status: 200, body: { ok: true } }]);
  const api = createApiClient({
    fetchImpl: fetcher.impl,
    credentials: createCredentialStore({ storage: mapStorage() }),
  });

  await api.request("GET", "/v1/me");

  assert.equal(fetcher.calls[0].init.headers.Authorization, undefined);
});

test("JSON bodies are serialized with a content-type header", async () => {
  const fetcher = fakeFetch([{ status: 200, body: { ok: true } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  await api.request("POST", "/v1/auth/request-code", {
    body: { email: "learner@example.com" },
    auth: false,
  });

  assert.equal(fetcher.calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(fetcher.calls[0].init.body, JSON.stringify({ email: "learner@example.com" }));
});

test("auth:false calls (login step) never send the stored token", async () => {
  const fetcher = fakeFetch([
    { status: 200, body: { ok: true } },
    { status: 200, body: { ok: true } },
  ]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  await api.requestCode("learner@example.com");
  await api.verify("learner@example.com", "654321");

  assert.equal(fetcher.calls[0].path, "/v1/auth/request-code");
  assert.equal(fetcher.calls[0].init.headers.Authorization, undefined);
  assert.equal(fetcher.calls[1].path, "/v1/auth/verify");
  assert.equal(fetcher.calls[1].init.headers.Authorization, undefined);
});

test("401 on an authenticated call clears the credential and fires onUnauthorized", async () => {
  const envelope = { error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" } };
  const fetcher = fakeFetch([{ status: 401, body: envelope }]);
  const storage = mapStorage();
  const credentials = createCredentialStore({ storage });
  credentials.set({ token: "stale", email: "x@y.com" });
  let unauthorizedCount = 0;
  const api = createApiClient({
    fetchImpl: fetcher.impl,
    credentials,
    onUnauthorized: () => {
      unauthorizedCount += 1;
    },
  });

  const result = await api.request("GET", "/v1/me");

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.deepEqual(result.data, envelope);
  assert.equal(storage.getItem(CREDENTIALS_KEY), null, "credential cleared");
  assert.equal(unauthorizedCount, 1);
});

test("401 on a login-step call keeps the credential and stays local", async () => {
  const envelope = { error: { code: "unauthorized", message: "验证码错误或已过期" } };
  const fetcher = fakeFetch([{ status: 401, body: envelope }]);
  const storage = mapStorage();
  const credentials = createCredentialStore({ storage });
  credentials.set({ token: "tok-1", email: "x@y.com" });
  let unauthorizedCount = 0;
  const api = createApiClient({
    fetchImpl: fetcher.impl,
    credentials,
    onUnauthorized: () => {
      unauthorizedCount += 1;
    },
  });

  const result = await api.verify("learner@example.com", "000000");

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.deepEqual(result.data, envelope);
  assert.notEqual(storage.getItem(CREDENTIALS_KEY), null, "credential untouched");
  assert.equal(unauthorizedCount, 0, "no session-expiry signal");
});

test("logout presents the Bearer credential on POST /v1/auth/logout", async () => {
  const fetcher = fakeFetch([{ status: 200, body: { ok: true } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.logout();

  assert.equal(fetcher.calls[0].path, "/v1/auth/logout");
  assert.equal(fetcher.calls[0].init.method, "POST");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.equal(result.ok, true);
});

test("network failure answers a presentable error instead of throwing", async () => {
  const fetcher = fakeFetch([{ reject: true }]);
  const api = createApiClient({
    fetchImpl: fetcher.impl,
    credentials: createCredentialStore({ storage: mapStorage() }),
  });

  const result = await api.request("GET", "/v1/me");

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.data.error.message, "无法连接服务器，请稍后重试");
});

test("non-JSON upstream bodies read as null data without throwing", async () => {
  const impl = async () => ({ status: 502, text: async () => "<html>bad gateway</html>" });
  const api = createApiClient({
    fetchImpl: impl,
    credentials: createCredentialStore({ storage: mapStorage() }),
  });

  const result = await api.request("GET", "/v1/resources");

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.data, null);
});

test("me() hits GET /v1/me with the stored credential", async () => {
  const fetcher = fakeFetch([{ status: 200, body: { account: { id: "acc_01", email: "learner@example.com" } } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.me();

  assert.equal(fetcher.calls[0].path, "/v1/me");
  assert.equal(result.ok, true);
  assert.equal(result.data.account.email, "learner@example.com");
});

// --- resource endpoints (P5: collection, list, detail, retitle) -------------

test("createResource() POSTs /v1/resources with the favorite body", async () => {
  const fetcher = fakeFetch([
    { status: 201, body: { resource: { id: "res_1" }, source: { id: "src_1" } } },
  ]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });
  const body = {
    url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
    title: "注意力机制详解 P2",
    identity: { platformId: "bilibili", platformVideoId: "BV1ab411L78c", episodeId: "2", platformScopeId: null },
  };

  const result = await api.createResource(body);

  assert.equal(fetcher.calls[0].path, "/v1/resources");
  assert.equal(fetcher.calls[0].init.method, "POST");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(fetcher.calls[0].init.body), body);
  assert.equal(result.status, 201);
});

test("listResources() GETs /v1/resources with the stored credential", async () => {
  const fetcher = fakeFetch([{ status: 200, body: { resources: [] } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.listResources();

  assert.equal(fetcher.calls[0].path, "/v1/resources");
  assert.equal(fetcher.calls[0].init.method, "GET");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(result.data, { resources: [] });
});

test("getResourceDetail() GETs /v1/resources/{id} with the id in the path", async () => {
  const fetcher = fakeFetch([
    { status: 200, body: { resource: { id: "res_1" }, sources: [], notes: [] } },
  ]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.getResourceDetail("res_1");

  assert.equal(fetcher.calls[0].path, "/v1/resources/res_1");
  assert.equal(fetcher.calls[0].init.method, "GET");
  assert.equal(result.ok, true);
});

test("getResourceDetail() encodes unsafe id characters", async () => {
  const fetcher = fakeFetch([{ status: 404, body: { error: { code: "not_found", message: "x" } } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  await api.getResourceDetail("res/../../etc");

  assert.equal(fetcher.calls[0].path, `/v1/resources/${encodeURIComponent("res/../../etc")}`);
});

test("updateResourceTitle() PATCHes /v1/resources/{id} with { title }", async () => {
  const fetcher = fakeFetch([{ status: 200, body: { resource: { id: "res_1", title: "新标题" } } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.updateResourceTitle("res_1", "新标题");

  assert.equal(fetcher.calls[0].path, "/v1/resources/res_1");
  assert.equal(fetcher.calls[0].init.method, "PATCH");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(fetcher.calls[0].init.body), { title: "新标题" });
  assert.equal(result.status, 200);
});

// --- session transcript (round 2, contract-r2 §3.5: Web 回查的二次拉取) -------

test("getSessionTranscript() GETs /v1/sessions/{id}/transcript with the stored credential", async () => {
  const view = apiSessionExampleById.get("api-session-transcript-captions-finished").response.body;
  const fetcher = fakeFetch([{ status: 200, body: view }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.getSessionTranscript("ses_01JABC0031");

  assert.equal(fetcher.calls[0].path, "/v1/sessions/ses_01JABC0031/transcript");
  assert.equal(fetcher.calls[0].init.method, "GET");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.equal(result.ok, true);
  assert.equal(result.data.origin, "captions");
  assert.deepEqual(result.data.records, view.records);
});

test("getSessionTranscript() encodes unsafe id characters", async () => {
  const fetcher = fakeFetch([{ status: 404, body: { error: { code: "not_found", message: "x" } } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  await api.getSessionTranscript("ses/../../etc");

  assert.equal(fetcher.calls[0].path, `/v1/sessions/${encodeURIComponent("ses/../../etc")}/transcript`);
});

// --- course summary + usage endpoints (round 3, contract-r3 §3.1-§3.4, #75) ----

test("generateSummary() POSTs /v1/resources/{id}/summaries with the contract's empty body", async () => {
  const generated = apiSummaryExampleById.get("api-summary-generate-bilibili").response.body;
  const fetcher = fakeFetch([{ status: 201, body: generated }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.generateSummary("res_01JABC0001");

  assert.equal(fetcher.calls[0].path, "/v1/resources/res_01JABC0001/summaries");
  assert.equal(fetcher.calls[0].init.method, "POST");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(fetcher.calls[0].init.body), {}, "the contract request body is an empty object");
  assert.equal(result.status, 201);
  assert.equal(result.data.summary.id, "sum_01JABC0051");
});

test("generateSummary() encodes unsafe id characters", async () => {
  const fetcher = fakeFetch([{ status: 404, body: { error: { code: "not_found", message: "x" } } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  await api.generateSummary("res/../../etc");

  assert.equal(fetcher.calls[0].path, `/v1/resources/${encodeURIComponent("res/../../etc")}/summaries`);
});

test("listSummaries() GETs /v1/resources/{id}/summaries with the stored credential", async () => {
  const list = apiSummaryExampleById.get("api-summaries-list").response.body;
  const fetcher = fakeFetch([{ status: 200, body: list }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.listSummaries("res_01JABC0001");

  assert.equal(fetcher.calls[0].path, "/v1/resources/res_01JABC0001/summaries");
  assert.equal(fetcher.calls[0].init.method, "GET");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.equal(result.data.summaries.length, 2);
  assert.equal(result.data.summaries[0].citationCount, 4);
});

test("getSummary() GETs /v1/summaries/{id} with the id in the path", async () => {
  const detail = apiSummaryExampleById.get("api-summary-detail").response.body;
  const fetcher = fakeFetch([{ status: 200, body: detail }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.getSummary("sum_01JABC0052");

  assert.equal(fetcher.calls[0].path, "/v1/summaries/sum_01JABC0052");
  assert.equal(fetcher.calls[0].init.method, "GET");
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.citations.length, 4);
});

test("getSummary() encodes unsafe id characters", async () => {
  const fetcher = fakeFetch([{ status: 404, body: { error: { code: "not_found", message: "x" } } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  await api.getSummary("sum/../../etc");

  assert.equal(fetcher.calls[0].path, `/v1/summaries/${encodeURIComponent("sum/../../etc")}`);
});

test("getUsage() GETs /v1/usage with the stored credential", async () => {
  const usage = apiSummaryExampleById.get("api-usage").response.body;
  const fetcher = fakeFetch([{ status: 200, body: usage }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.getUsage();

  assert.equal(fetcher.calls[0].path, "/v1/usage");
  assert.equal(fetcher.calls[0].init.method, "GET");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.equal(result.data.audioSeconds, 120);
  assert.equal(result.data.summaryCount, 2);
  assert.equal(result.data.summaryInputChars, 4140);
});

// Round-4 admin surface (contract-r4 §3.2/§3.3, ticket 6.2 / issue #87):
// the site-capability table read and the one-row subset patch. A 404 here
// is the D2 non-admin answer ("接口不存在或无权访问") — NOT a 401, so it must
// leave the credential and the login shell alone; the admin flow presents
// it as the denied view.

test("getAdminSiteCapabilities() GETs /v1/admin/site-capabilities with the stored credential", async () => {
  const list = siteCapabilityExampleById.get("api-admin-site-capabilities-list").response.body;
  const fetcher = fakeFetch([{ status: 200, body: list }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.getAdminSiteCapabilities();

  assert.equal(fetcher.calls[0].path, "/v1/admin/site-capabilities");
  assert.equal(fetcher.calls[0].init.method, "GET");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.equal(result.ok, true);
  assert.equal(result.data.capabilities.length, 5);
  assert.deepEqual(result.data.capabilities[0], {
    platformId: "bilibili",
    captions: true,
    asr: true,
    enabled: true,
  });
});

test("updateAdminSiteCapability() PUTs the subset patch to the encoded platform path", async () => {
  const update = siteCapabilityExampleById.get("api-admin-site-capability-update");
  const fetcher = fakeFetch([{ status: 200, body: update.response.body }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  const result = await api.updateAdminSiteCapability("bilibili", update.request.body);

  assert.equal(fetcher.calls[0].path, "/v1/admin/site-capabilities/bilibili");
  assert.equal(fetcher.calls[0].init.method, "PUT");
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(fetcher.calls[0].init.body), { captions: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.capability.captions, false);
});

test("updateAdminSiteCapability() encodes unsafe platformId characters", async () => {
  const fetcher = fakeFetch([{ status: 404, body: { error: { code: "not_found", message: "x" } } }]);
  const api = createApiClient({ fetchImpl: fetcher.impl, credentials: credentialsWith("tok-1") });

  await api.updateAdminSiteCapability("plat/../../etc", { enabled: false });

  assert.equal(fetcher.calls[0].path, `/v1/admin/site-capabilities/${encodeURIComponent("plat/../../etc")}`);
});

test("admin 404 (non-admin) presents the envelope verbatim without touching the credential", async () => {
  const notAdmin = errorExampleById.get("error-admin-site-capabilities-not-admin");
  const fetcher = fakeFetch([{ status: 404, body: notAdmin.response.body }]);
  let unauthorizedCalls = 0;
  const credentials = credentialsWith("tok-1");
  const api = createApiClient({
    fetchImpl: fetcher.impl,
    credentials,
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
  });

  const result = await api.getAdminSiteCapabilities();

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.data.error.code, "not_found");
  assert.equal(result.data.error.message, "接口不存在或无权访问");
  assert.equal(unauthorizedCalls, 0);
  assert.equal(credentials.get()?.token, "tok-1");
});
