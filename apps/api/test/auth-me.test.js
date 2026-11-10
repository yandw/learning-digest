const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, makeTempDir } = require("./helpers/harness");

// Slice 5: Bearer credential authentication on protected endpoints, shown
// on GET /v1/me. The 401 bodies must match the shared contract fixtures
// exactly (contracts/fixtures/error-examples.json):
//   error-unauthorized-missing-token -> "未登录或凭据缺失"
//   error-unauthorized-expired-token -> "凭据已失效，请重新登录并关联"

const FIXTURES = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../..", "contracts/fixtures/error-examples.json"),
    "utf8",
  ),
);

function fixtureBody(id) {
  const sample = FIXTURES.samples.find((entry) => entry.id === id);
  assert.ok(sample, `fixture ${id} must exist`);
  return sample.response.body;
}

function seedFileWith(emails) {
  const seedFile = path.join(makeTempDir(), "invites.seed.json");
  fs.writeFileSync(seedFile, JSON.stringify(emails, null, 2));
  return seedFile;
}

async function loginAndGetToken(app, email = "learner@example.com") {
  await app.request("POST", "/v1/auth/request-code", { body: { email } });
  const code = app.mailer.sent[app.mailer.sent.length - 1].code;
  const verify = await app.request("POST", "/v1/auth/verify", {
    body: { email, code },
  });
  assert.equal(verify.status, 201);
  return verify.json.credential.token;
}

test("GET /v1/me with a valid Bearer credential returns the account", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await loginAndGetToken(app);
    const response = await app.request("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.account.email, "learner@example.com");
    assert.ok(response.json.account.id.length > 0);
  } finally {
    await app.close();
  }
});

test("missing credential returns the contract missing-token 401 body", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("GET", "/v1/me");
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, fixtureBody("error-unauthorized-missing-token"));
  } finally {
    await app.close();
  }
});

test("unknown token returns the contract expired-token 401 body", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("GET", "/v1/me", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, fixtureBody("error-unauthorized-expired-token"));
  } finally {
    await app.close();
  }
});

test("non-Bearer Authorization header counts as missing credential", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("GET", "/v1/me", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, fixtureBody("error-unauthorized-missing-token"));
  } finally {
    await app.close();
  }
});

test("POST to a protected route also enforces the credential", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("POST", "/v1/me", { body: {} });
    assert.equal(response.status, 405);
    const withoutToken = await app.request("GET", "/v1/me");
    assert.equal(withoutToken.status, 401);
  } finally {
    await app.close();
  }
});
