import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../public/js/api-client.js";
import { createCredentialStore, CREDENTIALS_KEY } from "../public/js/credentials.js";

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
