const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, makeTempDir } = require("./helpers/harness");

// Slice 4: verify failure modes. Wrong, expired and replayed codes are all
// rejected with ONE fixed 401 envelope (anti-enumeration: uninvited emails
// verifying get the same body). Five failed attempts kill the code.

const INVALID_CODE_BODY = {
  error: { code: "unauthorized", message: "验证码错误或已过期" },
};
const TOO_MANY_ATTEMPTS_BODY = {
  error: { code: "unauthorized", message: "验证码尝试次数过多，请重新获取" },
};

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

async function verify(app, email, code) {
  return app.request("POST", "/v1/auth/verify", { body: { email, code } });
}

test("wrong code returns the fixed 401 envelope", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const code = await requestCode(app, "learner@example.com");
    const wrong = code === "000000" ? "000001" : "000000";
    const response = await verify(app, "learner@example.com", wrong);
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, INVALID_CODE_BODY);
  } finally {
    await app.close();
  }
});

test("uninvited email verifying gets the same envelope as a wrong code", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const wrongCode = await verify(app, "learner@example.com", "000000");
    const uninvited = await verify(app, "stranger@example.com", "123456");
    assert.equal(uninvited.status, 401);
    assert.deepEqual(uninvited.json, INVALID_CODE_BODY);
    assert.deepEqual(uninvited.json, wrongCode.json);
  } finally {
    await app.close();
  }
});

test("expired code is rejected with the same envelope", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
    config: { codeTtlMs: 5000 },
  });
  try {
    const code = await requestCode(app, "learner@example.com");
    clock += 6000; // past the 5s TTL
    const response = await verify(app, "learner@example.com", code);
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, INVALID_CODE_BODY);
  } finally {
    await app.close();
  }
});

test("replayed code (already consumed by a login) is rejected", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const code = await requestCode(app, "learner@example.com");
    const first = await verify(app, "learner@example.com", code);
    assert.equal(first.status, 201);
    const replay = await verify(app, "learner@example.com", code);
    assert.equal(replay.status, 401);
    assert.deepEqual(replay.json, INVALID_CODE_BODY);
  } finally {
    await app.close();
  }
});

test("one wrong attempt does not consume the code", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const code = await requestCode(app, "learner@example.com");
    const wrong = code === "000000" ? "000001" : "000000";
    await verify(app, "learner@example.com", wrong);
    const correct = await verify(app, "learner@example.com", code);
    assert.equal(correct.status, 201);
    assert.equal(correct.json.opened, true);
  } finally {
    await app.close();
  }
});

test("after five wrong attempts even the correct code is dead", async () => {
  const base = 1_700_000_000_000;
  let clock = base;
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock,
  });
  try {
    const code = await requestCode(app, "learner@example.com");
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i += 1) {
      const attempt = await verify(app, "learner@example.com", wrong);
      assert.equal(attempt.status, 401);
      clock += 1000; // stay inside the TTL but past any resend cooldown
    }
    const sixth = await verify(app, "learner@example.com", code);
    assert.equal(sixth.status, 401);
    assert.deepEqual(sixth.json, TOO_MANY_ATTEMPTS_BODY);
  } finally {
    await app.close();
  }
});
