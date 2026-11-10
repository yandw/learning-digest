/**
 * GET /v1/resources and GET /v1/resources/{id} (Ticket P4, issue #53).
 *
 * Seam: the /v1 HTTP endpoints against the P1 fixtures. The list example
 * shows the state after the fixture progress chain (api-progress-update:
 * positionMs 250000, revision 2) — the progress write endpoint belongs to
 * P9, so that chain's end state is seeded through the store seam as
 * fixture setup; every assertion still goes through HTTP. Notes stay an
 * empty array in this round (P12 fills them, ticket #53 scope).
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

// The fixture create examples pin 08:00:00Z (bilibili) and 08:05:00Z
// (generic); the injected clock reproduces exactly those strings.
const FIXTURE_CREATE_TIMES = {
  bilibili: "2026-11-10T08:00:00Z",
  generic: "2026-11-10T08:05:00Z",
};

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Favorite the fixture create samples with the clock pinned to the fixture
 * timestamps. Returns { bilibili, generic } response bodies.
 */
async function replayCreateSamples(app, token, clock) {
  const bilibiliExample = apiExampleById.get("api-resources-create-bilibili-p2");
  const genericExample = apiExampleById.get("api-resources-create-generic-webpage");

  clock.ms = Date.parse(FIXTURE_CREATE_TIMES.bilibili);
  const bilibili = await app.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: bilibiliExample.request.body,
  });
  assert.equal(bilibili.status, 201);

  clock.ms = Date.parse(FIXTURE_CREATE_TIMES.generic);
  const generic = await app.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: genericExample.request.body,
  });
  assert.equal(generic.status, 201);
  return { bilibili: bilibili.json, generic: generic.json };
}

test("list returns the account's favorites newest first with per-source progress", async () => {
  const example = apiExampleById.get("api-resources-list");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { bilibili, generic } = await replayCreateSamples(app, token, clock);

    // The fixture chain end state (api-progress-update) on the bilibili
    // source; the write endpoint itself is P9.
    app.store.set("progress", bilibili.source.id, { positionMs: 250000, revision: 2 });

    const response = await app.request("GET", "/v1/resources", {
      headers: authHeader(token),
    });
    assert.equal(response.status, 200);
    const items = response.json.resources;
    assert.equal(items.length, 2);

    // Newest first: generic (08:05) before bilibili (08:00) — fixture order.
    const [genericItem, bilibiliItem] = items;
    assert.deepEqual(genericItem.resource, {
      id: generic.resource.id,
      title: generic.resource.title,
      kind: "webpage",
      createdAt: FIXTURE_CREATE_TIMES.generic,
    });
    assert.deepEqual(genericItem.sources, [generic.source]);

    assert.deepEqual(bilibiliItem.resource, {
      id: bilibili.resource.id,
      title: bilibili.resource.title,
      kind: "video",
      createdAt: FIXTURE_CREATE_TIMES.bilibili,
    });
    assert.deepEqual(bilibiliItem.sources, [
      { ...bilibili.source, progress: { positionMs: 250000, revision: 2 } },
    ]);

    // The fixture list body, with opaque ids mapped onto the live ones.
    const fixtureGeneric = example.response.body.resources[0];
    const fixtureBilibili = example.response.body.resources[1];
    assert.deepEqual(
      {
        createdAt: bilibiliItem.resource.createdAt,
        sourceUrl: bilibiliItem.sources[0].url,
        progress: bilibiliItem.sources[0].progress,
        identity: {
          platformId: bilibiliItem.sources[0].platformId,
          platformVideoId: bilibiliItem.sources[0].platformVideoId,
          episodeId: bilibiliItem.sources[0].episodeId,
          platformScopeId: bilibiliItem.sources[0].platformScopeId,
        },
      },
      {
        createdAt: fixtureBilibili.resource.createdAt,
        sourceUrl: fixtureBilibili.sources[0].url,
        progress: fixtureBilibili.sources[0].progress,
        identity: {
          platformId: fixtureBilibili.sources[0].platformId,
          platformVideoId: fixtureBilibili.sources[0].platformVideoId,
          episodeId: fixtureBilibili.sources[0].episodeId,
          platformScopeId: fixtureBilibili.sources[0].platformScopeId,
        },
      },
      "list mirrors the fixture sample with live ids",
    );
    assert.equal(genericItem.resource.createdAt, fixtureGeneric.resource.createdAt);
  } finally {
    await app.close();
  }
});

test("detail returns resource, sources with progress and no notes yet", async () => {
  const example = apiExampleById.get("api-resources-detail-with-notes");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { bilibili } = await replayCreateSamples(app, token, clock);
    app.store.set("progress", bilibili.source.id, { positionMs: 250000, revision: 2 });

    const response = await app.request(
      "GET",
      `/v1/resources/${bilibili.resource.id}`,
      { headers: authHeader(token) },
    );
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json.resource, bilibili.resource);
    assert.equal(response.json.resource.createdAt, FIXTURE_CREATE_TIMES.bilibili);
    assert.deepEqual(response.json.sources, [
      { ...bilibili.source, progress: { positionMs: 250000, revision: 2 } },
    ]);
    assert.deepEqual(
      response.json.sources[0].progress,
      example.response.body.sources[0].progress,
      "detail progress equals the fixture chain end state",
    );
    // Round 1: the notes endpoint belongs to P12; detail carries [].
    assert.deepEqual(response.json.notes, []);
  } finally {
    await app.close();
  }
});

test("another account's resource id is a 404, indistinguishable from unknown (D2)", async () => {
  const example = errorExampleById.get("error-cross-account-resource");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
    now: () => clock.ms,
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const { bilibili } = await replayCreateSamples(app, owner, clock);

    for (const id of [bilibili.resource.id, "res_does-not-exist"]) {
      const response = await app.request("GET", `/v1/resources/${id}`, {
        headers: authHeader(other),
      });
      assert.equal(response.status, example.response.status);
      assert.deepEqual(response.json, example.response.body);
    }
  } finally {
    await app.close();
  }
});

test("each account's list only shows its own favorites", async () => {
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
    now: () => clock.ms,
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const { bilibili, generic } = await replayCreateSamples(app, owner, clock);

    const otherList = await app.request("GET", "/v1/resources", {
      headers: authHeader(other),
    });
    assert.equal(otherList.status, 200);
    assert.deepEqual(otherList.json, { resources: [] }, "no cross-account leakage");

    const ownerList = await app.request("GET", "/v1/resources", {
      headers: authHeader(owner),
    });
    assert.equal(ownerList.status, 200);
    assert.deepEqual(
      ownerList.json.resources.map((item) => item.resource.id).sort(),
      [bilibili.resource.id, generic.resource.id].sort(),
    );
    assert.ok(
      ownerList.json.resources.every((item) => item.sources.every((s) => s.resourceId === item.resource.id)),
    );
  } finally {
    await app.close();
  }
});

test("list requires credentials (401)", async () => {
  const example = errorExampleById.get("error-unauthorized-missing-token");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const response = await app.request("GET", "/v1/resources");
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);
  } finally {
    await app.close();
  }
});
