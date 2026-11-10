/**
 * Session lifecycle endpoints (Ticket 2.2, issue #65; contract-r2.md §3.1–3.2).
 *
 * Seam: the /v1 HTTP endpoints against the round-2 fixtures — the same
 * discipline as the P2/P4/P9/P12 tests. The fixture session ids
 * (ses_01JABC0031/0032/0033) map onto live ids; expected values come from
 * the fixture samples, never recomputed.
 *
 * Ticket-note divergence (documented decision): the ticket text says a
 * repeated finish "answers 200 with the original state", but the contract
 * (contract-r2.md §1 idempotency rule + §3.2) and the fixtures
 * (error-session-finish-already-finished) pin 409 session_already_finished.
 * The contract samples are the authoritative expected values, so finish is
 * a state transition: repeated finish is 409, and "idempotent" holds in the
 * state sense (the session stays finished, nothing changes).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp } = require("./helpers/harness");
const { seedFileWith, openAccount } = require("./helpers/accounts");

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "contracts", "fixtures");
const sessionExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "session-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);
const errorExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "error-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Create the fixture bilibili Source through the public favoriting
 * endpoint (the round-2 session fixtures' src_01JABC0002 is that source).
 */
async function createFixtureSource(app, token) {
  const created = await app.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: { url: "https://www.bilibili.com/video/BV1ab411L78c?p=2" },
  });
  assert.equal(created.status, 201);
  return created.json;
}

test("POST /v1/sources/{id}/sessions creates an active session (api-session-create-bilibili)", async () => {
  const example = sessionExampleById.get("api-session-create-bilibili");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);

    // The fixture session starts at 10:00:00Z.
    clock.ms = Date.parse("2026-11-10T10:00:00Z");
    const response = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, {
      session: {
        ...example.response.body.session,
        id: response.json.session.id,
        sourceId: source.id,
        resourceId: resource.id,
      },
    });
    assert.match(response.json.session.id, /^ses_/);
  } finally {
    await app.close();
  }
});

test("session creation requires credentials (error-session-create-unauthorized)", async () => {
  const example = errorExampleById.get("error-session-create-unauthorized");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("POST", "/v1/sources/src_01JABC0002/sessions", {
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);
  } finally {
    await app.close();
  }
});

test("a session on another account's source is a 404 and creates nothing (error-session-create-cross-account-source)", async () => {
  const example = errorExampleById.get("error-session-create-cross-account-source");
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const { source } = await createFixtureSource(app, owner);

    // Cross-account: the fixture 404 body verbatim.
    const cross = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(other),
      body: example.request.body,
    });
    assert.equal(cross.status, example.response.status);
    assert.deepEqual(cross.json, example.response.body);

    // Unknown ids are the same 404 (D2).
    const unknown = await app.request("POST", "/v1/sources/src_missing/sessions", {
      headers: authHeader(other),
      body: example.request.body,
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, example.response.body);

    // The rejected attempts left no trace in the owner's flow: their own
    // create on the same source still succeeds with a fresh session.
    const ownerCreate = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(owner),
      body: example.request.body,
    });
    assert.equal(ownerCreate.status, 201);
    assert.equal(ownerCreate.json.session.sourceId, source.id);
  } finally {
    await app.close();
  }
});

test("POST /v1/sessions/{id}/finish reports gaps and finishes (api-session-finish-with-gaps)", async () => {
  const example = sessionExampleById.get("api-session-finish-with-gaps");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);

    // The fixture session runs 09:00 -> 09:45.
    clock.ms = Date.parse("2026-11-10T09:00:00Z");
    const created = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(token),
      body: {},
    });
    assert.equal(created.status, 201);
    const sessionId = created.json.session.id;

    clock.ms = Date.parse("2026-11-10T09:45:00Z");
    const response = await app.request("POST", `/v1/sessions/${sessionId}/finish`, {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    // The fixture session (ses_0032) carries origin "asr" from its audio
    // history; this slice's session has had no transcript submission yet,
    // so origin is still null. The full asr chain including origin "asr"
    // is reproduced verbatim in session-transcripts.test.js through the
    // round-2 write seam (ticket 2.3's interface points).
    assert.deepEqual(response.json, {
      session: {
        ...example.response.body.session,
        id: sessionId,
        sourceId: source.id,
        resourceId: resource.id,
        origin: null,
      },
    });
  } finally {
    await app.close();
  }
});

test("finish without gaps defaults to no gaps and stamps finishedAt server-side", async () => {
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { source } = await createFixtureSource(app, token);
    const created = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(token),
      body: {},
    });
    const sessionId = created.json.session.id;

    clock.ms = Date.parse("2026-11-10T09:45:00Z");
    // Both an empty object body and a missing body mean "no gaps".
    const emptyBody = await app.request("POST", `/v1/sessions/${sessionId}/finish`, {
      headers: authHeader(token),
      body: {},
    });
    assert.equal(emptyBody.status, 200);
    assert.deepEqual(emptyBody.json.session.finishedAt, "2026-11-10T09:45:00Z");

    const second = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(token),
      body: {},
    });
    const noBody = await app.request("POST", `/v1/sessions/${second.json.session.id}/finish`, {
      headers: authHeader(token),
    });
    assert.equal(noBody.status, 200);
    assert.equal(noBody.json.session.status, "finished");
  } finally {
    await app.close();
  }
});

test("repeated finish is 409 session_already_finished (error-session-finish-already-finished)", async () => {
  const example = errorExampleById.get("error-session-finish-already-finished");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { source } = await createFixtureSource(app, token);
    const created = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(token),
      body: {},
    });
    const sessionId = created.json.session.id;

    const first = await app.request("POST", `/v1/sessions/${sessionId}/finish`, {
      headers: authHeader(token),
      body: {},
    });
    assert.equal(first.status, 200);

    // The fixture 409 body verbatim on the repeat.
    const repeat = await app.request("POST", `/v1/sessions/${sessionId}/finish`, {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(repeat.status, example.response.status);
    assert.deepEqual(repeat.json, example.response.body);
  } finally {
    await app.close();
  }
});

test("finishing another account's session is a 404 (D2)", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const { source } = await createFixtureSource(app, owner);
    const created = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(owner),
      body: {},
    });
    const sessionId = created.json.session.id;

    const cross = await app.request("POST", `/v1/sessions/${sessionId}/finish`, {
      headers: authHeader(other),
      body: {},
    });
    assert.equal(cross.status, 404);
    assert.equal(cross.json.error.code, "not_found");

    const unknown = await app.request("POST", "/v1/sessions/ses_missing/finish", {
      headers: authHeader(other),
      body: {},
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, cross.json, "unknown and cross-account are the same 404");
  } finally {
    await app.close();
  }
});

test("invalid gap ranges are validation_failed 400s", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { source } = await createFixtureSource(app, token);
    const created = await app.request("POST", `/v1/sources/${source.id}/sessions`, {
      headers: authHeader(token),
      body: {},
    });
    const sessionId = created.json.session.id;
    const finish = (body) =>
      app.request("POST", `/v1/sessions/${sessionId}/finish`, {
        headers: authHeader(token),
        body,
      });

    const cases = [
      ["gaps not an array", { gaps: { startMs: 1, endMs: 2 } }],
      ["gap item not an object", { gaps: [150000] }],
      ["missing startMs", { gaps: [{ endMs: 210000 }] }],
      ["missing endMs", { gaps: [{ startMs: 150000 }] }],
      ["inverted range", { gaps: [{ startMs: 210000, endMs: 150000 }] }],
      ["empty range (endMs must be > startMs)", { gaps: [{ startMs: 150000, endMs: 150000 }] }],
      ["negative startMs", { gaps: [{ startMs: -1, endMs: 150000 }] }],
      ["fractional endMs", { gaps: [{ startMs: 150000, endMs: 1.5 }] }],
    ];
    for (const [label, body] of cases) {
      const response = await finish(body);
      assert.equal(response.status, 400, label);
      assert.equal(response.json.error.code, "validation_failed", label);
    }

    // A rejected finish must not finish the session.
    const stillActive = await app.request("POST", `/v1/sessions/${sessionId}/finish`, {
      headers: authHeader(token),
      body: {},
    });
    assert.equal(stillActive.status, 200);
  } finally {
    await app.close();
  }
});
