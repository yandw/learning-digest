import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionRevalidator } from "../public/js/session-revalidate.js";
import { createApiClient } from "../public/js/api-client.js";
import { createCredentialStore } from "../public/js/credentials.js";

// P7 linked logout, pull side: there is no push channel to an already-open
// page, so an extension-side logout surfaces when the page next becomes
// visible or focused and the revalidator silently probes GET /v1/me. The
// 401 itself is handled by the api client's shared interceptor (clears the
// credential, fires onUnauthorized); these tests compose the real client
// and credential store so that wiring is exercised end to end.

function mapStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/**
 * Scripted fetch for the real api client: each response is
 * { status, body } or { reject: true } for a network failure.
 */
function fakeFetch(responses) {
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

function makeHarness({ responses, isAuthenticated = () => true, minIntervalMs = 30_000 } = {}) {
  const fetcher = fakeFetch(responses);
  const credentials = createCredentialStore({ storage: mapStorage() });
  credentials.set({
    token: "tok-1",
    email: "learner@example.com",
    accountId: "acc_01",
    credentialGroupId: "cg_01",
  });
  let clock = 1_000_000;
  const unauthorizedEvents = [];
  const api = createApiClient({
    fetchImpl: fetcher.impl,
    credentials,
    onUnauthorized: () => unauthorizedEvents.push(true),
  });
  const revalidator = createSessionRevalidator({
    api,
    isAuthenticated,
    onInvalidated: () => {},
    minIntervalMs,
    now: () => clock,
  });
  return {
    revalidator,
    credentials,
    unauthorizedEvents,
    calls: fetcher.calls,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("a linked-logout 401 on the visibility probe clears credentials and signals invalidation", async () => {
  const harness = makeHarness({ responses: [{ status: 401, body: { error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" } } }] });

  const result = await harness.revalidator.onPageVisible(true);

  assert.deepEqual(result, { probed: true, invalidated: true });
  assert.equal(harness.calls[0].path, "/v1/me", "the probe is a silent GET /v1/me");
  assert.equal(
    harness.credentials.get(),
    null,
    "the interceptor cleared the dead credential",
  );
  assert.equal(harness.unauthorizedEvents.length, 1, "the page is told to return to login");
});

test("a 200 probe changes nothing", async () => {
  const harness = makeHarness({ responses: [{ status: 200, body: { account: { id: "acc_01", email: "learner@example.com" } } }] });

  const result = await harness.revalidator.onPageVisible(true);

  assert.deepEqual(result, { probed: true, invalidated: false });
  assert.ok(harness.credentials.get(), "the credential stays");
  assert.equal(harness.unauthorizedEvents.length, 0);
});

test("a network failure on the probe does not log the learner out", async () => {
  const harness = makeHarness({ responses: [{ reject: true }] });

  const result = await harness.revalidator.onPageVisible(true);

  assert.deepEqual(result, { probed: true, invalidated: false });
  assert.ok(harness.credentials.get(), "an unreachable server is not a logout");
  assert.equal(harness.unauthorizedEvents.length, 0);
});

test("a logged-out page never probes", async () => {
  const harness = makeHarness({ responses: [], isAuthenticated: () => false });

  const result = await harness.revalidator.onPageVisible(true);

  assert.deepEqual(result, { probed: false });
  assert.equal(harness.calls.length, 0);
});

test("a hidden page is not probed", async () => {
  const harness = makeHarness({ responses: [] });

  const result = await harness.revalidator.onPageVisible(false);

  assert.deepEqual(result, { probed: false });
  assert.equal(harness.calls.length, 0);
});

test("the cooldown caps repeated visibility triggers within the window", async () => {
  const harness = makeHarness({
    responses: [
      { status: 200, body: { account: { id: "acc_01", email: "learner@example.com" } } },
      { status: 401, body: { error: { code: "unauthorized", message: "凭据已失效" } } },
    ],
    minIntervalMs: 30_000,
  });

  const first = await harness.revalidator.onPageVisible(true);
  assert.deepEqual(first, { probed: true, invalidated: false });

  // Tab away and back within the cooldown: no second probe.
  harness.advance(1_000);
  const throttled = await harness.revalidator.onPageVisible(true);
  assert.deepEqual(throttled, { probed: false });
  assert.equal(harness.calls.length, 1);

  // Past the cooldown the probe runs again (and the scripted 401 lands).
  harness.advance(30_000);
  const second = await harness.revalidator.onPageVisible(true);
  assert.deepEqual(second, { probed: true, invalidated: true });
});

test("a probe already in flight blocks a second concurrent trigger", async () => {
  let releaseProbe;
  const api = {
    me: () =>
      new Promise((resolve) => {
        releaseProbe = () => resolve({ ok: true, status: 200, data: { account: { id: "acc_01" } } });
      }),
  };
  const revalidator = createSessionRevalidator({
    api,
    isAuthenticated: () => true,
    onInvalidated: () => {},
    minIntervalMs: 0,
    now: () => 1_000,
  });

  const first = revalidator.onPageVisible(true);
  const second = await revalidator.onPageVisible(true);
  assert.deepEqual(second, { probed: false }, "no second probe while one is in flight");
  releaseProbe();
  assert.deepEqual(await first, { probed: true, invalidated: false });
});
