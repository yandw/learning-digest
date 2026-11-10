/**
 * PUT /v1/sources/{id}/progress (Ticket P9, issue #54).
 *
 * Seam: the /v1 HTTP endpoints against the P1 fixtures (same as the P4
 * tests). The progress fixture chain runs against a live Source created
 * through POST /v1/resources with the create fixture body — the fixture's
 * opaque source id (src_01JABC0002) maps onto the live id. Expected values
 * come from the fixture samples, never recomputed.
 *
 * Idempotent resend semantics (ticket #54; fixtures do not cover it, so it
 * is pinned here and in lib/progress.js): a request whose expectedRevision
 * equals the current revision AND whose positionMs equals the stored value
 * is a resend of the last successful write (e.g. after a network drop) —
 * it answers 200 with the current values and does NOT bump the revision.
 * The same expectedRevision with a different positionMs is a fresh write
 * and bumps.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp } = require("./helpers/harness");
const { seedFileWith, openAccount } = require("./helpers/accounts");

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "contracts", "fixtures");
const apiExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "api-examples.json"), "utf8"))
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
 * endpoint (the progress fixtures' src_01JABC0002 is that source).
 */
async function createFixtureSource(app, token) {
  const created = await app.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: apiExampleById.get("api-resources-create-bilibili-p2").request.body,
  });
  assert.equal(created.status, 201);
  return created.json.source;
}

test("first write: no progress counts as revision 0, write returns revision 1", async () => {
  const example = apiExampleById.get("api-progress-first-write");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const source = await createFixtureSource(app, token);

    const response = await app.request(
      "PUT",
      `/v1/sources/${source.id}/progress`,
      { headers: authHeader(token), body: example.request.body },
    );
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);
  } finally {
    await app.close();
  }
});

test("update with the read revision bumps to revision 2 (api-progress-update)", async () => {
  const firstWrite = apiExampleById.get("api-progress-first-write");
  const update = apiExampleById.get("api-progress-update");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const source = await createFixtureSource(app, token);

    const first = await app.request(
      "PUT",
      `/v1/sources/${source.id}/progress`,
      { headers: authHeader(token), body: firstWrite.request.body },
    );
    assert.deepEqual(first.json, firstWrite.response.body);

    // The fixture update carries the revision the first write returned.
    const response = await app.request(
      "PUT",
      `/v1/sources/${source.id}/progress`,
      { headers: authHeader(token), body: update.request.body },
    );
    assert.equal(response.status, update.response.status);
    assert.deepEqual(response.json, update.response.body);
  } finally {
    await app.close();
  }
});

test("stale expectedRevision is a 409 carrying the current progress (error-progress-conflict)", async () => {
  const firstWrite = apiExampleById.get("api-progress-first-write");
  const update = apiExampleById.get("api-progress-update");
  const conflict = errorExampleById.get("error-progress-conflict");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const source = await createFixtureSource(app, token);

    // Bring the chain to the fixture conflict's precondition: revision 2.
    await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: firstWrite.request.body,
    });
    await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: update.request.body,
    });

    const response = await app.request(
      "PUT",
      `/v1/sources/${source.id}/progress`,
      { headers: authHeader(token), body: conflict.request.body },
    );
    assert.equal(response.status, conflict.response.status);
    assert.deepEqual(response.json, conflict.response.body);
  } finally {
    await app.close();
  }
});

test("writing another account's source is a 404 and writes nothing (error-cross-account-progress)", async () => {
  const example = errorExampleById.get("error-cross-account-progress");
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const source = await createFixtureSource(app, owner);

    const response = await app.request(
      "PUT",
      `/v1/sources/${source.id}/progress`,
      { headers: authHeader(other), body: example.request.body },
    );
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);

    // Unknown ids are the same 404 (D2).
    const unknown = await app.request("PUT", "/v1/sources/src_missing/progress", {
      headers: authHeader(other),
      body: example.request.body,
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, example.response.body);

    // No write happened: the owner still sees no progress and the very
    // first write with expectedRevision 0 succeeds.
    const ownerList = await app.request("GET", "/v1/resources", {
      headers: authHeader(owner),
    });
    assert.equal(ownerList.json.resources[0].sources[0].progress, null);
    const ownerWrite = await app.request(
      "PUT",
      `/v1/sources/${source.id}/progress`,
      {
        headers: authHeader(owner),
        body: apiExampleById.get("api-progress-first-write").request.body,
      },
    );
    assert.equal(ownerWrite.status, 200);
    assert.equal(ownerWrite.json.revision, 1);
  } finally {
    await app.close();
  }
});

test("resending the last write is idempotent: 200 with current values, no revision bump", async () => {
  const firstWrite = apiExampleById.get("api-progress-first-write");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const source = await createFixtureSource(app, token);

    const first = await app.request(
      "PUT",
      `/v1/sources/${source.id}/progress`,
      { headers: authHeader(token), body: firstWrite.request.body },
    );
    assert.deepEqual(first.json, firstWrite.response.body);

    // A resend: the client re-submits the same positionMs together with the
    // revision it holds from the last acknowledged response. Identical
    // position at the current revision = duplicate of the last write.
    const resend = await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: { positionMs: firstWrite.request.body.positionMs, expectedRevision: 1 },
    });
    assert.equal(resend.status, 200);
    assert.deepEqual(resend.json, firstWrite.response.body, "same result, same revision");

    // A resend that still carries a stale revision is NOT treated as a
    // duplicate: it is the ordinary 409 + current path (D4), which keeps
    // the outcome consistent because the earlier write did land.

    // The resend did not consume a version: the next fresh write still
    // lands on revision 2.
    const next = await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: { positionMs: 126000, expectedRevision: 1 },
    });
    assert.deepEqual(next.json, { positionMs: 126000, revision: 2 });
  } finally {
    await app.close();
  }
});

test("same revision but a different position is a fresh write and bumps", async () => {
  const firstWrite = apiExampleById.get("api-progress-first-write");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const source = await createFixtureSource(app, token);

    await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: firstWrite.request.body,
    });

    const response = await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: { positionMs: 130000, expectedRevision: 1 },
    });
    assert.deepEqual(response.json, { positionMs: 130000, revision: 2 });
  } finally {
    await app.close();
  }
});

test("rewinding the position is a legal write (D4: no server-side clamping)", async () => {
  const firstWrite = apiExampleById.get("api-progress-first-write");
  const update = apiExampleById.get("api-progress-update");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const source = await createFixtureSource(app, token);

    await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: firstWrite.request.body,
    });
    await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: update.request.body,
    });

    // Dragged back to an earlier position: saved as the last actually
    // played position, still a normal versioned write.
    const rewind = await app.request("PUT", `/v1/sources/${source.id}/progress`, {
      headers: authHeader(token),
      body: { positionMs: 100000, expectedRevision: 2 },
    });
    assert.equal(rewind.status, 200);
    assert.deepEqual(rewind.json, { positionMs: 100000, revision: 3 });
  } finally {
    await app.close();
  }
});

test("invalid fields are validation_failed 400s", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const source = await createFixtureSource(app, token);
    const put = (body) =>
      app.request("PUT", `/v1/sources/${source.id}/progress`, {
        headers: authHeader(token),
        body,
      });

    const cases = [
      ["missing positionMs", { expectedRevision: 0 }],
      ["missing expectedRevision", { positionMs: 1000 }],
      ["empty body", undefined],
      ["non-integer positionMs", { positionMs: 12.5, expectedRevision: 0 }],
      ["string positionMs", { positionMs: "1000", expectedRevision: 0 }],
      ["negative positionMs", { positionMs: -1, expectedRevision: 0 }],
      ["negative expectedRevision", { positionMs: 1000, expectedRevision: -1 }],
      ["string expectedRevision", { positionMs: 1000, expectedRevision: "0" }],
      ["fractional expectedRevision", { positionMs: 1000, expectedRevision: 1.5 }],
    ];
    for (const [label, body] of cases) {
      const response = await put(body);
      assert.equal(response.status, 400, label);
      assert.equal(response.json.error.code, "validation_failed", label);
    }

    // A rejected write must not touch the store: the next valid write is
    // still the first (expectedRevision 0).
    const after = await put({ positionMs: 1000, expectedRevision: 0 });
    assert.deepEqual(after.json, { positionMs: 1000, revision: 1 });
  } finally {
    await app.close();
  }
});

test("progress writes require credentials (401)", async () => {
  const missing = errorExampleById.get("error-unauthorized-missing-token");
  const expired = errorExampleById.get("error-unauthorized-expired-token");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const noHeader = await app.request("PUT", "/v1/sources/src_x/progress", {
      body: { positionMs: 1000, expectedRevision: 0 },
    });
    assert.equal(noHeader.status, missing.response.status);
    assert.deepEqual(noHeader.json, missing.response.body);

    const badToken = await app.request("PUT", "/v1/sources/src_x/progress", {
      headers: authHeader("not-a-token"),
      body: { positionMs: 1000, expectedRevision: 0 },
    });
    assert.equal(badToken.status, expired.response.status);
    assert.deepEqual(badToken.json, expired.response.body);
  } finally {
    await app.close();
  }
});
