const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, makeTempDir } = require("./helpers/harness");

// Slice 6 (HTTP seam): POST /v1/auth/logout. Round 1 revokes the PRESENTED
// credential only — the group-wide revocation primitive exists on the
// credentials module (credentials-group.test.js) and P7 wires linked
// logout behavior on top of it. Error bodies follow the contract fixtures.

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

test("round-1 logout only kills the presented credential, not its siblings", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const firstToken = await login(app);
    clock += 61_000;
    const secondToken = await login(app);

    const logout = await app.request("POST", "/v1/auth/logout", {
      headers: { Authorization: `Bearer ${firstToken}` },
    });
    assert.equal(logout.status, 200);

    const firstGone = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${firstToken}` },
    });
    assert.equal(firstGone.status, 401);

    const secondAlive = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    assert.equal(
      secondAlive.status,
      200,
      "sibling credential stays valid until P7 wires group revoke into logout",
    );
  } finally {
    await app.close();
  }
});
