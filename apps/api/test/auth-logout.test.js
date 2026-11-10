const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, makeTempDir } = require("./helpers/harness");

// Slice 6 (HTTP seam): POST /v1/auth/logout. Round 1 revoked the PRESENTED
// credential only; P7 (linked logout, decision 3 of #49) takes the endpoint
// over: logout now revokes the presented credential's WHOLE credential
// group, so the Web session and the extension credential die together
// (contract §1: 401 = expired OR linked-revoked). Error bodies follow the
// contract fixtures.

const MISSING_TOKEN_BODY = {
  error: { code: "unauthorized", message: "未登录或凭据缺失" },
};
const EXPIRED_TOKEN_BODY = {
  error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" },
};

function seedFileWith(emails) {
  const seedFile = path.join(makeTempDir(), "invites.seed.json");
  fs.writeFileSync(seedFile, JSON.stringify(emails, null, 2));
  return seedFile;
}

async function login(app, email = "learner@example.com") {
  await app.request("POST", "/v1/auth/request-code", { body: { email } });
  const code = app.mailer.sent[app.mailer.sent.length - 1].code;
  const verify = await app.request("POST", "/v1/auth/verify", {
    body: { email, code },
  });
  assert.ok([200, 201].includes(verify.status), "verify opens (201) or logs in (200)");
  return verify.json.credential.token;
}

/**
 * P6 link flow through the HTTP seam: a logged-in Web session creates a
 * one-time link code bound to its credential group; the extension (no
 * Bearer yet) exchanges it for a live extension credential in that group.
 */
async function linkExtension(app, webToken) {
  const created = await app.request("POST", "/v1/auth/link-requests", {
    body: {},
    headers: { Authorization: `Bearer ${webToken}` },
  });
  assert.equal(created.status, 201);
  const linked = await app.request("POST", "/v1/auth/link", {
    body: { code: created.json.linkCode },
  });
  assert.equal(linked.status, 201);
  return linked.json.credential.token;
}

test("logout invalidates the presented credential", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const token = await login(app);
    const logout = await app.request("POST", "/v1/auth/logout", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(logout.json, { ok: true });
    const after = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(after.status, 401);
    assert.deepEqual(after.json, EXPIRED_TOKEN_BODY);
  } finally {
    await app.close();
  }
});

test("logout without a credential returns the missing-token 401 body", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("POST", "/v1/auth/logout", { body: {} });
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, MISSING_TOKEN_BODY);
  } finally {
    await app.close();
  }
});

test("logout with an unknown token returns the expired-token 401 body", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("POST", "/v1/auth/logout", {
      headers: { Authorization: "Bearer garbage" },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, EXPIRED_TOKEN_BODY);
  } finally {
    await app.close();
  }
});

// P7 takeover: the round-1 behavior ("only the presented credential dies")
// is replaced by group-wide revocation — Web and extension credentials
// share one group (P6 pins the issue side), so one logout logs both out.
test("logout from the web revokes the whole credential group, extension included", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const webToken = await login(app);
    clock += 61_000;
    const extensionToken = await linkExtension(app, webToken);

    const logout = await app.request("POST", "/v1/auth/logout", {
      headers: { Authorization: `Bearer ${webToken}` },
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(logout.json, { ok: true });

    for (const [label, token] of [["web", webToken], ["extension", extensionToken]]) {
      const after = await app.request("GET", "/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(after.status, 401, `the ${label} credential dies with the group`);
      assert.deepEqual(after.json, EXPIRED_TOKEN_BODY);
    }
  } finally {
    await app.close();
  }
});

test("logout from the extension kills the web session too", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const webToken = await login(app);
    clock += 61_000;
    const extensionToken = await linkExtension(app, webToken);

    const logout = await app.request("POST", "/v1/auth/logout", {
      headers: { Authorization: `Bearer ${extensionToken}` },
    });
    assert.equal(logout.status, 200);

    const webGone = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${webToken}` },
    });
    assert.equal(webGone.status, 401, "the web session dies with the group");
    const extensionGone = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${extensionToken}` },
    });
    assert.equal(extensionGone.status, 401);
  } finally {
    await app.close();
  }
});

test("repeated logout with an already-revoked credential stays 200 (idempotent)", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const token = await login(app);
    const first = await app.request("POST", "/v1/auth/logout", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(first.status, 200);

    const repeat = await app.request("POST", "/v1/auth/logout", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(repeat.status, 200, "a repeat logout is a 200 no-op, not a 401");
    assert.deepEqual(repeat.json, { ok: true });
  } finally {
    await app.close();
  }
});

test("re-login after a group logout issues a fresh group and re-linking works", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const firstWebToken = await login(app);
    clock += 61_000;
    const firstExtensionToken = await linkExtension(app, firstWebToken);
    clock += 61_000;
    await app.request("POST", "/v1/auth/logout", {
      headers: { Authorization: `Bearer ${firstWebToken}` },
    });

    // The learner returns: Web login first (fresh active group), then the
    // extension re-links into that group.
    clock += 61_000;
    const secondWebToken = await login(app);
    clock += 61_000;
    const secondExtensionToken = await linkExtension(app, secondWebToken);

    const me = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${secondWebToken}` },
    });
    assert.equal(me.status, 200);
    const extensionMe = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${secondExtensionToken}` },
    });
    assert.equal(extensionMe.status, 200, "the re-linked extension credential is live");

    // Old credentials from the revoked group stay dead.
    for (const token of [firstWebToken, firstExtensionToken]) {
      const stale = await app.request("GET", "/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(stale.status, 401);
    }
  } finally {
    await app.close();
  }
});
