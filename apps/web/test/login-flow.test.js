import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoginFlow } from "../public/js/login-flow.js";
import { createCredentialStore } from "../public/js/credentials.js";

// The login flow state machine (pure module): email step -> code step ->
// authenticated library shell, plus logout and session expiry back to the
// email step. It owns transitions, form validation calls and error/notice
// text; the page only binds the snapshot to the DOM. The api seam is faked
// with the exact shape createApiClient exposes (requestCode / verify /
// logout / me returning { ok, status, data }).

function mapStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function makeCredentials() {
  return createCredentialStore({ storage: mapStorage() });
}

/** Fake api: script the next result of each method; record calls. */
function fakeApi({ requestCodeResult, verifyResult, logoutResult } = {}) {
  const calls = { requestCode: [], verify: [], logout: 0 };
  return {
    calls,
    async requestCode(email) {
      calls.requestCode.push(email);
      return requestCodeResult || { ok: true, status: 200, data: { ok: true } };
    },
    async verify(email, code) {
      calls.verify.push({ email, code });
      return verifyResult || { ok: true, status: 200, data: { ok: true } };
    },
    async logout() {
      calls.logout += 1;
      return logoutResult || { ok: true, status: 200, data: { ok: true } };
    },
    async me() {
      return { ok: true, status: 200, data: { account: { id: "acc_01", email: "x@y.com" } } };
    },
  };
}

const VERIFY_SUCCESS = {
  ok: true,
  status: 201,
  data: {
    opened: true,
    account: { id: "acc_01", email: "learner@example.com", createdAt: "2026-11-11T00:00:00Z" },
    credential: { token: "tok-web-1", kind: "web", credentialGroupId: "cg_01" },
  },
};

function flowWith({ api, credentials } = {}) {
  return createLoginFlow({ api: api || fakeApi(), credentials: credentials || makeCredentials() });
}

test("the flow starts on the email step", () => {
  const flow = flowWith();
  assert.equal(flow.getState().state, "email");
  assert.equal(flow.getState().email, null);
});

test("empty email is rejected locally without calling the API", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });
  const result = await flow.submitEmail("   ");
  assert.equal(result.ok, false);
  assert.equal(result.message, "请输入邮箱");
  assert.equal(flow.getState().state, "email");
  assert.equal(api.calls.requestCode.length, 0);
});

test("malformed email is rejected with the API-aligned wording", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });
  const result = await flow.submitEmail("not-an-email");
  assert.equal(result.ok, false);
  assert.equal(result.message, "邮箱格式不正确");
  assert.equal(api.calls.requestCode.length, 0);
});

test("a valid email is normalized, sent, and moves to the code step", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });
  const result = await flow.submitEmail("  Learner@Example.COM ");
  assert.equal(result.ok, true);
  assert.deepEqual(api.calls.requestCode, ["learner@example.com"]);
  const state = flow.getState();
  assert.equal(state.state, "code");
  assert.equal(state.email, "learner@example.com");
  assert.match(state.notice, /请查收邮件/);
  assert.match(state.notice, /outbox/, "dev hint points at the API outbox file");
  assert.equal(state.error, null);
});

test("a failed request-code call shows the envelope message and stays on email", async () => {
  const api = fakeApi({
    requestCodeResult: {
      ok: false,
      status: 502,
      data: { error: { code: "upstream_unavailable", message: "学习服务暂时不可用，请稍后重试" } },
    },
  });
  const flow = flowWith({ api });
  const result = await flow.submitEmail("learner@example.com");
  assert.equal(result.ok, false);
  assert.equal(result.message, "学习服务暂时不可用，请稍后重试");
  assert.equal(flow.getState().state, "email");
  assert.equal(flow.getState().error, "学习服务暂时不可用，请稍后重试");
});

test("a non-6-digit code is rejected locally without calling verify", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });
  await flow.submitEmail("learner@example.com");
  const result = await flow.submitCode("12ab");
  assert.equal(result.ok, false);
  assert.equal(result.message, "验证码为 6 位数字");
  assert.equal(api.calls.verify.length, 0);
  assert.equal(flow.getState().state, "code");
});

test("a wrong code presents the contract envelope verbatim and stays on code", async () => {
  const api = fakeApi({
    verifyResult: {
      ok: false,
      status: 401,
      data: { error: { code: "unauthorized", message: "验证码错误或已过期" } },
    },
  });
  const credentials = makeCredentials();
  const flow = flowWith({ api, credentials });
  await flow.submitEmail("learner@example.com");
  const result = await flow.submitCode("000000");
  assert.equal(result.ok, false);
  assert.equal(result.message, "验证码错误或已过期");
  assert.equal(flow.getState().state, "code");
  assert.equal(flow.getState().error, "验证码错误或已过期");
  assert.equal(credentials.get(), null, "no credential stored on failure");
});

test("a correct code stores the credential and enters the library shell", async () => {
  const api = fakeApi({ verifyResult: VERIFY_SUCCESS });
  const credentials = makeCredentials();
  const flow = flowWith({ api, credentials });
  await flow.submitEmail("learner@example.com");
  const result = await flow.submitCode("654321");
  assert.equal(result.ok, true);
  assert.equal(flow.getState().state, "authenticated");
  assert.equal(flow.getState().error, null);
  assert.deepEqual(credentials.get(), {
    token: "tok-web-1",
    email: "learner@example.com",
    accountId: "acc_01",
    credentialGroupId: "cg_01",
  });
});

test("logout revokes server-side, clears locally and returns to email", async () => {
  const api = fakeApi({ verifyResult: VERIFY_SUCCESS });
  const credentials = makeCredentials();
  const flow = flowWith({ api, credentials });
  await flow.submitEmail("learner@example.com");
  await flow.submitCode("654321");

  const result = await flow.logout();

  assert.equal(result.ok, true);
  assert.equal(api.calls.logout, 1);
  assert.equal(credentials.get(), null);
  const state = flow.getState();
  assert.equal(state.state, "email");
  assert.equal(state.email, null);
  assert.equal(state.notice, null);
  assert.equal(state.error, null);
});

test("logout still clears locally when the API call fails", async () => {
  const api = fakeApi({ verifyResult: VERIFY_SUCCESS });
  api.logout = async () => ({ ok: false, status: 0, data: { error: { code: "network_error", message: "无法连接服务器，请稍后重试" } } });
  const credentials = makeCredentials();
  const flow = flowWith({ api, credentials });
  await flow.submitEmail("learner@example.com");
  await flow.submitCode("654321");

  const result = await flow.logout();

  assert.equal(result.ok, true);
  assert.equal(credentials.get(), null);
  assert.equal(flow.getState().state, "email");
});

test("session expiry (401 interceptor) clears credentials and returns to login", () => {
  const credentials = makeCredentials();
  credentials.set({ token: "stale", email: "x@y.com", accountId: "acc_01", credentialGroupId: "cg_01" });
  const flow = flowWith({ credentials });

  flow.handleSessionExpired();

  assert.equal(credentials.get(), null);
  const state = flow.getState();
  assert.equal(state.state, "email");
  assert.equal(state.error, "登录状态已失效，请重新登录");
});

test("resume with a stored credential enters the shell; without one, the login view", async () => {
  const withToken = makeCredentials();
  withToken.set({ token: "tok-web-1", email: "learner@example.com", accountId: "acc_01", credentialGroupId: "cg_01" });
  const flowA = flowWith({ credentials: withToken });
  await flowA.resume();
  assert.equal(flowA.getState().state, "authenticated");

  const flowB = flowWith();
  await flowB.resume();
  assert.equal(flowB.getState().state, "email");
});

test("double submit is guarded while a request is in flight", async () => {
  let releaseRequestCode;
  const api = fakeApi();
  api.requestCode = (email) => {
    api.calls.requestCode.push(email);
    return new Promise((resolve) => {
      releaseRequestCode = () => resolve({ ok: true, status: 200, data: { ok: true } });
    });
  };
  const flow = flowWith({ api });

  const first = flow.submitEmail("learner@example.com");
  const second = await flow.submitEmail("other@example.com");

  assert.equal(second.ok, false);
  assert.equal(second.message, "正在处理，请稍候");
  assert.equal(api.calls.requestCode.length, 1, "second submit did not reach the API");
  releaseRequestCode();
  await first;
  assert.equal(flow.getState().state, "code");
});

test("backToEmail leaves the code step without any API call", async () => {
  const api = fakeApi();
  const flow = flowWith({ api });
  await flow.submitEmail("learner@example.com");
  flow.backToEmail();
  assert.equal(flow.getState().state, "email");
  assert.equal(flow.getState().email, null);
  assert.equal(api.calls.requestCode.length, 1, "no extra request-code call");
});
