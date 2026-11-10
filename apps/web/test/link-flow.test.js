import { test } from "node:test";
import assert from "node:assert/strict";
import { createLinkFlow } from "../public/js/link-flow.js";
import { createCredentialStore, CREDENTIALS_KEY } from "../public/js/credentials.js";

// P6: the link confirmation page's state machine. The login half is the P3
// login-flow machine (covered by login-flow.test.js); here the focus is the
// entry credential check, the login -> confirm mapping, and the one-shot
// confirm/issue transition, including the 401-mid-flight restart.

function makeStorage(initialCredential) {
  const map = new Map();
  if (initialCredential) {
    map.set(CREDENTIALS_KEY, JSON.stringify(initialCredential));
  }
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Fake api seam: scriptable per-call results with a call log. */
function makeApi({ meResult, linkResult } = {}) {
  const calls = [];
  const resolve = (value) => () =>
    typeof value === "function" ? value() : value;
  return {
    calls,
    requestCode: async (email) => {
      calls.push(["requestCode", email]);
      return { ok: true, status: 200, data: {} };
    },
    verify: async (email, code) => {
      calls.push(["verify", email, code]);
      return {
        ok: true,
        status: 201,
        data: {
          account: { id: "acc_1", email },
          credential: { token: "fresh-token", kind: "web", credentialGroupId: "grp_1" },
        },
      };
    },
    me: async () => {
      calls.push(["me"]);
      return resolve(meResult)();
    },
    logout: async () => {
      calls.push(["logout"]);
      return { ok: true, status: 200, data: { ok: true } };
    },
    createLinkRequest: async () => {
      calls.push(["createLinkRequest"]);
      return resolve(linkResult)();
    },
  };
}

function makePage({ storedCredential, meResult, linkResult } = {}) {
  const storage = makeStorage(storedCredential);
  const credentials = createCredentialStore({ storage });
  const api = makeApi({ meResult, linkResult });
  const flow = createLinkFlow({ api, credentials });
  return { flow, api, credentials, calls: api.calls, storage };
}

test("no stored credential lands on the login half", async () => {
  const page = makePage();
  const state = await page.flow.start();
  assert.equal(state.state, "login-email");
  assert.equal(state.error, null);
});

test("a live stored credential lands on confirm", async () => {
  const page = makePage({
    storedCredential: { token: "web-token" },
    meResult: { ok: true, status: 200, data: { account: { id: "acc_1", email: "l@e.com" } } },
  });
  const state = await page.flow.start();
  assert.equal(state.state, "confirm");
  assert.deepEqual(page.calls[0], ["me"]);
});

test("an expired stored credential (401) restarts on login without error copy", async () => {
  const page = makePage({
    storedCredential: { token: "dead-token" },
    meResult: {
      ok: false,
      status: 401,
      data: { error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" } },
    },
  });
  const state = await page.flow.start();
  assert.equal(state.state, "login-email");
  assert.equal(state.error, null, "the interceptor owns the 401 story; no double copy");
});

test("a server outage at entry shows copy and still offers login", async () => {
  const page = makePage({
    storedCredential: { token: "web-token" },
    meResult: {
      ok: false,
      status: 502,
      data: { error: { code: "upstream_unavailable", message: "学习服务暂时不可用，请稍后重试" } },
    },
  });
  const state = await page.flow.start();
  assert.equal(state.state, "login-email");
  assert.match(state.error, /学习服务暂时不可用/);
});

test("login steps map into confirm; confirm issues a link code", async () => {
  const page = makePage({
    linkResult: {
      ok: true,
      status: 201,
      data: { linkCode: "link_code_123", expiresAt: "2026-11-11T00:10:00.000Z" },
    },
  });
  await page.flow.start(); // no credential -> login-email

  await page.flow.submitEmail("learner@example.com");
  assert.equal(page.flow.getState().state, "login-code");

  await page.flow.submitCode("123456");
  assert.equal(page.flow.getState().state, "confirm");
  const credential = page.credentials.get();
  assert.equal(credential.token, "fresh-token", "the login stored the fresh credential");

  const issued = await page.flow.confirmLink();
  assert.deepEqual(issued, { ok: true, linkCode: "link_code_123" });
  assert.equal(page.flow.getState().state, "issued");
  assert.deepEqual(page.calls.at(-1), ["createLinkRequest"]);
});

test("a failed confirm surfaces the envelope message and returns to confirm", async () => {
  const page = makePage({
    storedCredential: { token: "web-token" },
    meResult: { ok: true, status: 200, data: { account: { id: "acc_1" } } },
    linkResult: {
      ok: false,
      status: 500,
      data: { error: { code: "internal_error", message: "服务内部错误" } },
    },
  });
  await page.flow.start();
  const result = await page.flow.confirmLink();
  assert.equal(result.ok, false);
  assert.match(result.message, /服务内部错误/);
  assert.equal(page.flow.getState().state, "confirm");
});

test("a 401 during confirm restarts the flow on the login half", async () => {
  const page = makePage({
    storedCredential: { token: "web-token" },
    meResult: { ok: true, status: 200, data: { account: { id: "acc_1" } } },
    linkResult: {
      ok: false,
      status: 401,
      data: { error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" } },
    },
  });
  await page.flow.start();
  const result = await page.flow.confirmLink();
  assert.equal(result.ok, false);
  assert.equal(page.flow.getState().state, "login-email");
});

test("confirmLink outside confirm is refused without an API call", async () => {
  const page = makePage();
  const result = await page.flow.confirmLink();
  assert.equal(result.ok, false);
  assert.deepEqual(page.calls, []);
});

test("backToEmail from the code step returns to the email form", async () => {
  const page = makePage();
  await page.flow.start();
  await page.flow.submitEmail("learner@example.com");
  page.flow.backToEmail();
  assert.equal(page.flow.getState().state, "login-email");
});
