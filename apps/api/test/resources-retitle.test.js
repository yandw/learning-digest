/**
 * PATCH /v1/resources/{id} — manual retitle (Ticket P5, issue #55; the
 * round-1 contract supplement documented in contract-v1.md §3.7).
 *
 * Seam: the /v1 HTTP endpoints, asserted against the P1 fixtures as the
 * shared test samples. The retitle sample (api-resource-retitle) drives
 * the response shape on top of the create-generic-webpage sample it
 * retitles; error bodies follow the shared envelope semantics (400
 * validation_failed, 404 not_found per decision D2).
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

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Favorite the create-generic-webpage sample into an account and return
 * { token, resourceId, favorite } — the retitle sample's target Resource.
 */
async function favoriteGenericWebpage(app, token) {
  const favorite = await app.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: apiExampleById.get("api-resources-create-generic-webpage").request.body,
  });
  assert.equal(favorite.status, 201);
  return favorite.json.resource;
}

test("retitle updates the display title and returns the updated resource (200)", async () => {
  const retitle = apiExampleById.get("api-resource-retitle");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const resource = await favoriteGenericWebpage(app, token);

    const response = await app.request("PATCH", `/v1/resources/${resource.id}`, {
      headers: authHeader(token),
      body: retitle.request.body,
    });

    assert.equal(response.status, 200);
    // Contract §2.1 shape; the retitle sample pins title, kind and
    // createdAt against the same shared sample ids.
    assert.equal(response.json.resource.id, resource.id);
    assert.equal(response.json.resource.title, retitle.response.body.resource.title);
    assert.equal(response.json.resource.kind, retitle.response.body.resource.kind);
    assert.equal(response.json.resource.createdAt, resource.createdAt);

    // The new title is visible on the detail read.
    const detail = await app.request("GET", `/v1/resources/${resource.id}`, {
      headers: authHeader(token),
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.resource.title, retitle.response.body.resource.title);
  } finally {
    await app.close();
  }
});

test("the title never participates in matching: refavorite after retitle returns the same resource", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const resource = await favoriteGenericWebpage(app, token);

    const retitled = await app.request("PATCH", `/v1/resources/${resource.id}`, {
      headers: authHeader(token),
      body: { title: "改名之后同样能认出这条资料" },
    });
    assert.equal(retitled.status, 200);

    const refavorite = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: apiExampleById.get("api-resources-create-generic-webpage").request.body,
    });
    assert.equal(refavorite.status, 200, "re-favorite hits the existing source");
    assert.equal(refavorite.json.resource.id, resource.id);
  } finally {
    await app.close();
  }
});

test("another account's resource is the same 404 as an unknown id (D2)", async () => {
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const resource = await favoriteGenericWebpage(app, owner);

    for (const token of [other, owner]) {
      const target = token === other ? resource.id : "res_does_not_exist";
      const response = await app.request("PATCH", `/v1/resources/${target}`, {
        headers: authHeader(token),
        body: { title: "越权或未知的标题修改" },
      });
      assert.equal(response.status, 404);
      assert.deepEqual(response.json, {
        error: { code: "not_found", message: "资源不存在或无权访问" },
      });
    }
  } finally {
    await app.close();
  }
});

test("empty, whitespace, missing and non-string titles are validation failures (400)", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const resource = await favoriteGenericWebpage(app, token);

    for (const body of [{ title: "" }, { title: "   " }, {}, { title: 42 }, { title: null }]) {
      const response = await app.request("PATCH", `/v1/resources/${resource.id}`, {
        headers: authHeader(token),
        body,
      });
      assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be a 400`);
      assert.equal(response.json.error.code, "validation_failed");
    }
  } finally {
    await app.close();
  }
});

test("the request body accepts only { title }; extra fields are rejected (400)", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const resource = await favoriteGenericWebpage(app, token);

    const response = await app.request("PATCH", `/v1/resources/${resource.id}`, {
      headers: authHeader(token),
      body: { title: "合法标题", url: "https://www.example.com/sneaky" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_failed");

    // Nothing changed.
    const detail = await app.request("GET", `/v1/resources/${resource.id}`, {
      headers: authHeader(token),
    });
    assert.equal(detail.json.resource.title, resource.title);
  } finally {
    await app.close();
  }
});

test("retitle without credentials is 401", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("PATCH", "/v1/resources/res_01JABC0010", {
      body: { title: "未登录的标题修改" },
    });
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "unauthorized");
  } finally {
    await app.close();
  }
});
