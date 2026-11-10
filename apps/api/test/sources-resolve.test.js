/**
 * POST /v1/sources/resolve (Ticket P4, issue #53).
 *
 * Seam: the /v1 HTTP endpoints against the P1 fixtures. Resolve is
 * read-only (contract §3.4): matched/unmatched shapes per api-examples,
 * the 401 shape per error-examples, and "no data is created" asserted by
 * re-reading the account list after resolving.
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

/** Favorite the two fixture create samples; returns the response bodies. */
async function createFixtureFavorites(app, token) {
  const created = [];
  for (const id of ["api-resources-create-bilibili-p2", "api-resources-create-generic-webpage"]) {
    const example = apiExampleById.get(id);
    const response = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, 201);
    created.push(response.json);
  }
  return { bilibili: created[0], generic: created[1] };
}

test("resolve with a declared identity hits the existing source (matched true)", async () => {
  const create = apiExampleById.get("api-resources-create-bilibili-p2");
  const example = apiExampleById.get("api-resolve-matched-episode2");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { bilibili } = await createFixtureFavorites(app, token);
    app.store.set("progress", bilibili.source.id, { positionMs: 250000, revision: 2 });

    const response = await app.request("POST", "/v1/sources/resolve", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.equal(response.json.matched, true);
    assert.equal(response.json.resource.id, bilibili.resource.id);
    assert.equal(response.json.source.id, bilibili.source.id);
    assert.equal(response.json.source.url, create.response.body.source.url);
    assert.deepEqual(
      response.json.source.progress,
      example.response.body.source.progress,
      "resolve carries the latest progress (fixture chain end state)",
    );
    assert.deepEqual(response.json.source, {
      ...bilibili.source,
      progress: { positionMs: 250000, revision: 2 },
    });
  } finally {
    await app.close();
  }
});

test("resolve without identity falls back to the server-side extractor", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { bilibili } = await createFixtureFavorites(app, token);

    // Same episode through the recognizable share link, no identity sent.
    const response = await app.request("POST", "/v1/sources/resolve", {
      headers: authHeader(token),
      body: { url: "https://b23.tv/BV1ab411L78c?p=2&share_session_id=s-9" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.matched, true);
    assert.equal(response.json.source.id, bilibili.source.id);
    assert.equal(response.json.resource.id, bilibili.resource.id);
  } finally {
    await app.close();
  }
});

test("resolve of an unknown page is matched false and creates nothing", async () => {
  const example = apiExampleById.get("api-resolve-unmatched-generic");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { bilibili, generic } = await createFixtureFavorites(app, token);

    const response = await app.request("POST", "/v1/sources/resolve", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);

    // Read-only: the account still holds exactly the two favorites.
    const list = await app.request("GET", "/v1/resources", { headers: authHeader(token) });
    assert.deepEqual(
      list.json.resources.map((item) => item.resource.id).sort(),
      [bilibili.resource.id, generic.resource.id].sort(),
    );
  } finally {
    await app.close();
  }
});

test("resolve does not create on a miss for a recognized platform either", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { bilibili, generic } = await createFixtureFavorites(app, token);

    const response = await app.request("POST", "/v1/sources/resolve", {
      headers: authHeader(token),
      body: { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { matched: false });

    const list = await app.request("GET", "/v1/resources", { headers: authHeader(token) });
    assert.deepEqual(
      list.json.resources.map((item) => item.resource.id).sort(),
      [bilibili.resource.id, generic.resource.id].sort(),
      "resolve must not write, even for a recognizable platform URL",
    );
  } finally {
    await app.close();
  }
});

test("resolve stays account-scoped: another account's favorite is unmatched", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const resolveExample = apiExampleById.get("api-resolve-matched-episode2");
    await createFixtureFavorites(app, owner);

    const response = await app.request("POST", "/v1/sources/resolve", {
      headers: authHeader(other),
      body: resolveExample.request.body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { matched: false }, "no cross-account resolution");
  } finally {
    await app.close();
  }
});

test("resolve with a revoked credential is 401 and leaks nothing", async () => {
  const example = errorExampleById.get("error-unauthorized-resolve");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const logout = await app.request("POST", "/v1/auth/logout", {
      headers: authHeader(token),
    });
    assert.equal(logout.status, 200);

    const response = await app.request("POST", "/v1/sources/resolve", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);
  } finally {
    await app.close();
  }
});
