const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, makeTempDir } = require("./helpers/harness");

// Slice 2: POST /v1/auth/request-code. Invited emails (loaded from the seed
// file) get a 6-digit code through the Mailer seam; uninvited emails get the
// IDENTICAL 200 response with no email (anti-enumeration). Codes are
// rate-limited: a resend cooldown, one outstanding code per email.

function seedFileWith(emails) {
  const seedFile = path.join(makeTempDir(), "invites.seed.json");
  fs.writeFileSync(seedFile, JSON.stringify(emails, null, 2));
  return seedFile;
}

function invitedApp(overrides = {}) {
  return startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    ...overrides,
  });
}

test("invited email receives a 6-digit code through the mailer seam", async () => {
  const app = await invitedApp();
  try {
    const response = await app.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true });
    assert.equal(app.mailer.sent.length, 1);
    const mail = app.mailer.sent[0];
    assert.equal(mail.to, "learner@example.com");
    assert.match(mail.code, /^\d{6}$/);
    assert.ok(mail.text.includes(mail.code), "delivery text carries the code");
  } finally {
    await app.close();
  }
});

test("uninvited email gets the identical response and no email", async () => {
  const app = await invitedApp();
  try {
    const invited = await app.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
    });
    const uninvited = await app.request("POST", "/v1/auth/request-code", {
      body: { email: "stranger@example.com" },
    });
    assert.equal(uninvited.status, 200);
    assert.deepEqual(uninvited.json, invited.json);
    assert.equal(app.mailer.sent.length, 1, "only the invited email was sent");
  } finally {
    await app.close();
  }
});

test("email is normalized before invite lookup and delivery", async () => {
  const app = await invitedApp();
  try {
    const response = await app.request("POST", "/v1/auth/request-code", {
      body: { email: "  Learner@Example.COM " },
    });
    assert.equal(response.status, 200);
    assert.equal(app.mailer.sent[0].to, "learner@example.com");
  } finally {
    await app.close();
  }
});

test("requesting again within the cooldown answers 200 but does not resend", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await invitedApp({ now: () => clock });
  try {
    await app.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
    });
    clock += 10_000; // 10s later, inside the default 60s cooldown
    const response = await app.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true });
    assert.equal(app.mailer.sent.length, 1, "no duplicate email in cooldown");
  } finally {
    await app.close();
  }
});

test("requesting after the cooldown replaces the outstanding code", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await invitedApp({ now: () => clock });
  try {
    await app.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
    });
    clock += 61_000; // cooldown passed
    await app.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
    });
    assert.equal(app.mailer.sent.length, 2);
    assert.notEqual(app.mailer.sent[0].code, app.mailer.sent[1].code);
  } finally {
    await app.close();
  }
});

test("missing email field returns 400 validation_failed", async () => {
  const app = await invitedApp();
  try {
    const response = await app.request("POST", "/v1/auth/request-code", {
      body: {},
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, {
      error: { code: "validation_failed", message: "缺少必填字段 email" },
    });
  } finally {
    await app.close();
  }
});

test("non-email-shaped address returns 400 validation_failed", async () => {
  const app = await invitedApp();
  try {
    const response = await app.request("POST", "/v1/auth/request-code", {
      body: { email: "not-an-email" },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, {
      error: { code: "validation_failed", message: "邮箱格式不正确" },
    });
  } finally {
    await app.close();
  }
});

test("malformed JSON body returns 400 validation_failed envelope", async () => {
  const app = await invitedApp();
  try {
    const response = await app.request("POST", "/v1/auth/request-code", {
      body: "{not json",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, {
      error: { code: "validation_failed", message: "请求体不是合法 JSON" },
    });
  } finally {
    await app.close();
  }
});

test("GET on request-code returns 405 method_not_allowed", async () => {
  const app = await invitedApp();
  try {
    const response = await app.request("GET", "/v1/auth/request-code");
    assert.equal(response.status, 405);
    assert.deepEqual(response.json, {
      error: { code: "method_not_allowed", message: "HTTP 方法不被允许" },
    });
  } finally {
    await app.close();
  }
});
