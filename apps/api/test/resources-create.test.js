/**
 * POST /v1/resources — favorite (Ticket P4, issue #53).
 *
 * Seam: the /v1 HTTP endpoints, asserted against the P1 fixtures as the
 * shared test samples. api-examples.json drives the create/duplicate/generic
 * shapes; error-examples.json drives the 400/401 bodies verbatim.
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

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Assert a favorite response body against its fixture sample: concrete
 * contract fields must equal the fixture exactly, server-generated ids are
 * opaque but relational (source.resourceId links the resource).
 */
function assertFavoriteMatchesFixture(actual, example) {
  const expected = example.response.body;
  assert.equal(typeof actual.resource.id, "string");
  assert.ok(actual.resource.id.length > 0);
  assert.equal(actual.resource.title, expected.resource.title);
  assert.equal(actual.resource.kind, expected.resource.kind);
  assert.match(actual.resource.createdAt, ISO_TIMESTAMP);

  assert.equal(typeof actual.source.id, "string");
  assert.ok(actual.source.id.length > 0);
  assert.equal(actual.source.resourceId, actual.resource.id);
  for (const key of ["kind", "url", "platformId", "platformVideoId", "episodeId", "platformScopeId", "progress"]) {
    assert.deepEqual(
      actual.source[key],
      expected.source[key],
      `${example.id}: source.${key} must equal the fixture`,
    );
  }
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

test("first favorite of a bilibili episode creates resource + source (201)", async () => {
  const example = apiExampleById.get("api-resources-create-bilibili-p2");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const response = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, 201);
    assertFavoriteMatchesFixture(response.json, example);
  } finally {
    await app.close();
  }
});

test("generic webpage favorite without identity (201)", async () => {
  const example = apiExampleById.get("api-resources-create-generic-webpage");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const response = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, 201);
    assertFavoriteMatchesFixture(response.json, example);
  } finally {
    await app.close();
  }
});

test("favorite without a title falls back to the address as display title", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const response = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: { url: "https://www.example.com/no-title-page" },
    });
    assert.equal(response.status, 201);
    assert.equal(response.json.resource.title, "https://www.example.com/no-title-page");
  } finally {
    await app.close();
  }
});

test("equivalent share-link duplicate returns the same source (200) and keeps the original URL", async () => {
  const create = apiExampleById.get("api-resources-create-bilibili-p2");
  const duplicate = apiExampleById.get("api-resources-duplicate-bilibili-p2");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const first = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: create.request.body,
    });
    assert.equal(first.status, 201);

    const second = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: duplicate.request.body,
    });
    assert.equal(second.status, duplicate.response.status);
    // Same Resource + Source (decision D3), body isomorphic with creation.
    assert.equal(second.json.resource.id, first.json.resource.id);
    assert.equal(second.json.source.id, first.json.source.id);
    assert.equal(second.json.resource.title, first.json.resource.title);
    assert.equal(second.json.resource.createdAt, first.json.resource.createdAt);
    assert.equal(
      second.json.source.url,
      first.json.source.url,
      "source.url stays the first-favorited address (fixture: " +
        duplicate.response.body.source.url +
        ")",
    );
    assert.equal(second.json.source.url, create.response.body.source.url);
  } finally {
    await app.close();
  }
});

test("non-http(s) address is rejected with invalid_url (400)", async () => {
  const example = errorExampleById.get("error-invalid-url");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const response = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);
  } finally {
    await app.close();
  }
});

test("missing url field is rejected with validation_failed (400)", async () => {
  const example = errorExampleById.get("error-validation-failed-missing-url");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const response = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);
  } finally {
    await app.close();
  }
});

test("malformed or unparseable address is rejected with invalid_url (400)", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    for (const url of ["not a url", "https://", 42]) {
      const response = await app.request("POST", "/v1/resources", {
        headers: authHeader(token),
        body: { url },
      });
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, "invalid_url");
    }
    // A null url is an absent one: the authoritative missing-url sample code.
    const missing = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: { url: null },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error.code, "validation_failed");
  } finally {
    await app.close();
  }
});

test("a revoked credential cannot favorite (401)", async () => {
  const example = errorExampleById.get("error-unauthorized-expired-token");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const logout = await app.request("POST", "/v1/auth/logout", {
      headers: authHeader(token),
    });
    assert.equal(logout.status, 200);

    const response = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);
  } finally {
    await app.close();
  }
});
