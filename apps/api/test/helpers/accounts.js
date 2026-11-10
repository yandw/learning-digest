/**
 * Account helpers for protected-endpoint tests: seed invited emails and
 * open accounts through the public auth flow (request-code -> verify) to
 * obtain Bearer tokens. Only public endpoints are used — no store poking.
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { makeTempDir } = require("./harness");

/** Write an invite seed file (the app's seedFile seam) for the emails. */
function seedFileWith(emails) {
  const seedFile = path.join(makeTempDir(), "invites.seed.json");
  fs.writeFileSync(seedFile, JSON.stringify(emails, null, 2));
  return seedFile;
}

/** Open (or log into) an account and return its Bearer token. */
async function openAccount(app, email) {
  const requested = await app.request("POST", "/v1/auth/request-code", {
    body: { email },
  });
  assert.equal(requested.status, 200);
  const code = app.mailer.sent[app.mailer.sent.length - 1].code;
  const verified = await app.request("POST", "/v1/auth/verify", {
    body: { email, code },
  });
  assert.ok(verified.status === 201 || verified.status === 200);
  return verified.json.credential.token;
}

module.exports = { seedFileWith, openAccount };
