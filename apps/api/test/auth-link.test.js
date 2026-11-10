const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, makeTempDir } = require("./helpers/harness");

// P6: extension account linking (decision 3 of #49). The Web confirmation
// page creates a one-time link code bound to its credential group; the
// extension exchanges it for a live extension credential IN THE SAME GROUP
// (the P7 linked-logout premise). CORS lets the extension's service worker
// call these endpoints without host_permissions.

function seedFileWith(emails) {
  const seedFile = path.join(makeTempDir(), "invites.seed.json");
  fs.writeFileSync(seedFile, JSON.stringify(emails, null, 2));
  return seedFile;
}

async function loginWebUser(app, email) {
  const codeResponse = await app.request("POST", "/v1/auth/request-code", {
    body: { email },
  });
  assert.equal(codeResponse.status, 200);
  const code = app.mailer.sent[app.mailer.sent.length - 1].code;
  const verify = await app.request("POST", "/v1/auth/verify", {
    body: { email, code },
  });
  assert.equal(verify.status, 201);
  return verify.json.credential;
}

test("link flow issues an extension credential into the web session's group", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
  });
  try {
    const web = await loginWebUser(app, "learner@example.com");

    const created = await app.request("POST", "/v1/auth/link-requests", {
      body: {},
      headers: { Authorization: `Bearer ${web.token}` },
    });
    assert.equal(created.status, 201);
    assert.ok(created.json.linkCode.length >= 32, "the link code carries real entropy");
    assert.match(created.json.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

    const linked = await app.request("POST", "/v1/auth/link", {
      body: { code: created.json.linkCode },
    });
    assert.equal(linked.status, 201);
    assert.equal(linked.json.account.email, "learner@example.com");
    assert.equal(linked.json.credential.kind, "extension");
    assert.ok(linked.json.credential.token.length >= 32);
    assert.equal(
      linked.json.credential.credentialGroupId,
      web.credentialGroupId,
      "the extension credential joins the confirming web session's group",
    );

    // The new credential is live and resolves to the same account.
    const me = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${linked.json.credential.token}` },
    });
    assert.equal(me.status, 200);
    assert.equal(me.json.account.email, "learner@example.com");
  } finally {
    await app.close();
  }
});

test("a link code is single use", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
  });
  try {
    const web = await loginWebUser(app, "learner@example.com");
    const created = await app.request("POST", "/v1/auth/link-requests", {
      body: {},
      headers: { Authorization: `Bearer ${web.token}` },
    });

    const first = await app.request("POST", "/v1/auth/link", {
      body: { code: created.json.linkCode },
    });
    assert.equal(first.status, 201);

    const replay = await app.request("POST", "/v1/auth/link", {
      body: { code: created.json.linkCode },
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error.code, "unauthorized");
  } finally {
    await app.close();
  }
});

test("an expired link code fails the exchange", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const web = await loginWebUser(app, "learner@example.com");
    const created = await app.request("POST", "/v1/auth/link-requests", {
      body: {},
      headers: { Authorization: `Bearer ${web.token}` },
    });

    clock += 10 * 60 * 1000 + 1; // past the 10-minute link code TTL
    const linked = await app.request("POST", "/v1/auth/link", {
      body: { code: created.json.linkCode },
    });
    assert.equal(linked.status, 401);
    assert.equal(linked.json.error.code, "unauthorized");
  } finally {
    await app.close();
  }
});

test("a group revoked between link-requests and link fails the exchange", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
  });
  try {
    const web = await loginWebUser(app, "learner@example.com");
    const created = await app.request("POST", "/v1/auth/link-requests", {
      body: {},
      headers: { Authorization: `Bearer ${web.token}` },
    });

    // The Web session logs out before the extension exchanges the code:
    // round-1 logout revokes only the web credential, so also revoke the
    // group through the store to simulate the P7 linked exit.
    const group = app.store
      .list("credentialGroups")
      .find((entry) => entry.id === web.credentialGroupId);
    group.revokedAt = Date.now();
    app.store.set("credentialGroups", group.id, group);

    const linked = await app.request("POST", "/v1/auth/link", {
      body: { code: created.json.linkCode },
    });
    assert.equal(linked.status, 401, "no credential is issued into a dead group");
    assert.equal(linked.json.error.code, "unauthorized");
    assert.equal(
      app.store.list("credentials").filter((c) => c.kind === "extension").length,
      0,
    );
  } finally {
    await app.close();
  }
});

test("missing or unknown code fields answer the contract envelopes", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
  });
  try {
    const missing = await app.request("POST", "/v1/auth/link", { body: {} });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.json, {
      error: { code: "validation_failed", message: "缺少必填字段 code" },
    });

    const unknown = await app.request("POST", "/v1/auth/link", {
      body: { code: "no-such-code" },
    });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.error.code, "unauthorized");
  } finally {
    await app.close();
  }
});

test("link-requests requires a Bearer credential", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
  });
  try {
    const anonymous = await app.request("POST", "/v1/auth/link-requests", {
      body: {},
    });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.json, {
      error: { code: "unauthorized", message: "未登录或凭据缺失" },
    });

    const stale = await app.request("POST", "/v1/auth/link-requests", {
      body: {},
      headers: { Authorization: "Bearer not-a-token" },
    });
    assert.equal(stale.status, 401);
    assert.deepEqual(stale.json, {
      error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" },
    });
  } finally {
    await app.close();
  }
});

test("CORS: preflight is answered and /v1 responses echo the origin", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
  });
  try {
    const preflight = await app.request("OPTIONS", "/v1/auth/link", {
      headers: {
        Origin: "chrome-extension://abcdefg",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "chrome-extension://abcdefg",
      "the requesting origin is echoed",
    );
    assert.match(
      preflight.headers.get("access-control-allow-headers"),
      /Authorization/i,
    );
    assert.match(preflight.headers.get("access-control-allow-headers"), /Content-Type/i);

    const anonymous = await app.request("POST", "/v1/auth/link", {
      body: {},
      headers: { Origin: "chrome-extension://abcdefg" },
    });
    assert.equal(anonymous.status, 400);
    assert.equal(
      anonymous.headers.get("access-control-allow-origin"),
      "chrome-extension://abcdefg",
      "actual responses carry the echoed origin too",
    );

    const unknownPath = await app.request("GET", "/v1/no-such-endpoint", {
      headers: { Origin: "chrome-extension://abcdefg" },
    });
    assert.equal(unknownPath.status, 404);
    assert.equal(
      unknownPath.headers.get("access-control-allow-origin"),
      "chrome-extension://abcdefg",
      "CORS headers land before routing, so errors are readable from the extension",
    );
  } finally {
    await app.close();
  }
});
