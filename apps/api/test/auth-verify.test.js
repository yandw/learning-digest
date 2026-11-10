const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, makeTempDir } = require("./helpers/harness");

// Slice 3: POST /v1/auth/verify. A correct code opens the account on first
// use (201) and issues a Web credential; later logins repeat the same flow
// (200, opened: false) and join the account's ACTIVE credential group —
// decision 3: Web and extension credentials live and die as one group.

function seedFileWith(emails) {
  const seedFile = path.join(makeTempDir(), "invites.seed.json");
  fs.writeFileSync(seedFile, JSON.stringify(emails, null, 2));
  return seedFile;
}

async function requestCode(app, email) {
  const response = await app.request("POST", "/v1/auth/request-code", {
    body: { email },
  });
  assert.equal(response.status, 200);
  return app.mailer.sent[app.mailer.sent.length - 1].code;
}

test("correct code opens the account and issues a web credential", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const code = await requestCode(app, "learner@example.com");
    const response = await app.request("POST", "/v1/auth/verify", {
      body: { email: "learner@example.com", code },
    });
    assert.equal(response.status, 201);
    assert.equal(response.json.opened, true);
    assert.equal(response.json.account.email, "learner@example.com");
    assert.ok(response.json.account.id.length > 0);
    assert.match(response.json.account.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(response.json.credential.token.length >= 32);
    assert.equal(response.json.credential.kind, "web");
    assert.ok(response.json.credential.credentialGroupId.length > 0);
  } finally {
    await app.close();
  }
});

test("second login with a fresh code does not re-open the account", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const firstCode = await requestCode(app, "learner@example.com");
    const first = await app.request("POST", "/v1/auth/verify", {
      body: { email: "learner@example.com", code: firstCode },
    });
    assert.equal(first.status, 201);

    clock += 61_000; // pass the resend cooldown
    const secondCode = await requestCode(app, "learner@example.com");
    const second = await app.request("POST", "/v1/auth/verify", {
      body: { email: "learner@example.com", code: secondCode },
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.opened, false);
    assert.equal(second.json.account.id, first.json.account.id);
    assert.notEqual(second.json.credential.token, first.json.credential.token);
  } finally {
    await app.close();
  }
});

test("repeat login joins the same credential group as the first login", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const firstCode = await requestCode(app, "learner@example.com");
    const first = await app.request("POST", "/v1/auth/verify", {
      body: { email: "learner@example.com", code: firstCode },
    });

    clock += 61_000;
    const secondCode = await requestCode(app, "learner@example.com");
    const second = await app.request("POST", "/v1/auth/verify", {
      body: { email: "learner@example.com", code: secondCode },
    });

    assert.equal(
      second.json.credential.credentialGroupId,
      first.json.credential.credentialGroupId,
      "logins join the account's active group (decision 3)",
    );
  } finally {
    await app.close();
  }
});

test("missing code field returns 400 validation_failed", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("POST", "/v1/auth/verify", {
      body: { email: "learner@example.com" },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, {
      error: { code: "validation_failed", message: "缺少必填字段 code" },
    });
  } finally {
    await app.close();
  }
});

test("missing email field on verify returns 400 validation_failed", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("POST", "/v1/auth/verify", {
      body: { code: "123456" },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, {
      error: { code: "validation_failed", message: "缺少必填字段 email" },
    });
  } finally {
    await app.close();
  }
});
