/**
 * Session helpers for the round-2 audio/task tests (ticket 2.3, #66).
 * Since tickets 2.1/2.2 landed, sessions are created through the PUBLIC
 * flow only (favorite a source -> POST /v1/sources/{id}/sessions) — no
 * store poking, mirroring test/session-transcripts.test.js.
 */
const assert = require("node:assert/strict");
const { makeTempDir } = require("./harness");
const { openAccount } = require("./accounts");

/** Default temp audio directory for one test app instance. */
function makeAudioDir() {
  return makeTempDir("ld-api-audio");
}

function authHeader(token) {
  return { authorization: `Bearer ${token}` };
}

/**
 * Favorite a small fixture source and start a Session on it. Returns
 * { resource, source, session }.
 */
async function createSessionFor(harness, token, label = "audio-chain") {
  const created = await harness.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: {
      url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
      title: `注意力机制详解 P2：自注意力（${label}）`,
    },
  });
  assert.strictEqual(created.status, 201);
  const session = await harness.request(
    "POST",
    `/v1/sources/${created.json.source.id}/sessions`,
    { headers: authHeader(token), body: {} },
  );
  assert.strictEqual(session.status, 201);
  return {
    resource: created.json.resource,
    source: created.json.source,
    session: session.json.session,
  };
}

/**
 * Open an account through the public auth flow and resolve its account id
 * via GET /v1/me (no store poking for accounts). Requires the harness to
 * have been started with seedFileWith([email]) so the flow succeeds.
 */
async function openAccountWithId(harness, email) {
  const token = await openAccount(harness, email);
  const me = await harness.request("GET", "/v1/me", {
    headers: authHeader(token),
  });
  return { token, accountId: me.json.account.id };
}

module.exports = { makeAudioDir, authHeader, createSessionFor, openAccountWithId };
