/**
 * Matching semantics end-to-end (Ticket P4, issue #53).
 *
 * Seam: the /v1 HTTP endpoints. The source-matching.json samples are
 * favorited into one account WITHOUT a declared identity, so the
 * server-side fallback extraction drives every decision — the fixture
 * same-source/different-source relations must hold through the API
 * exactly as the contracts test holds them through the module. A second
 * pass re-resolves every sample with client-supplied identity (what the
 * plugin does) and must land on the same Sources. Dual-account
 * concurrency closes the isolation story (decision 1 rule 4, D2, D8).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp } = require("./helpers/harness");
const { seedFileWith, openAccount } = require("./helpers/accounts");
const { extractVideoIdentity } = require("../../../contracts/platform-video-id");

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "contracts", "fixtures");
const { samples } = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "source-matching.json"), "utf8"),
);
const sampleById = new Map(samples.map((s) => [s.id, s]));
const apiExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "api-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

test("fixture matching relations hold end-to-end, driven by server-side extraction", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const sourceIds = new Map();
    const resourceIds = new Map();
    const originalUrls = new Map();

    for (const sample of samples) {
      const response = await app.request("POST", "/v1/resources", {
        headers: authHeader(token),
        // No identity: the server must extract/normalize on its own.
        body: { url: sample.url, title: sample.title },
      });
      // A sample re-favoriting an earlier one (matchesSameSourceAs) gets
      // 200 with the same Resource + Source; every other sample is new.
      const same = sample.expect.matchesSameSourceAs;
      const expectDuplicate = same !== undefined && sourceIds.has(same);
      assert.equal(
        response.status,
        expectDuplicate ? 200 : 201,
        `${sample.id}: ${expectDuplicate ? "duplicate favorite (200)" : "first favorite (201)"}`,
      );
      if (expectDuplicate) {
        assert.equal(response.json.source.id, sourceIds.get(same));
      }
      sourceIds.set(sample.id, response.json.source.id);
      resourceIds.set(sample.id, response.json.resource.id);
      // source.url is the first-favorited address, preserved on duplicates.
      originalUrls.set(sample.id, response.json.source.url);
    }

    for (const sample of samples) {
      const same = sample.expect.matchesSameSourceAs;
      if (same !== undefined) {
        assert.equal(
          sourceIds.get(sample.id),
          sourceIds.get(same),
          `${sample.id} must share the Source of ${same}`,
        );
        assert.equal(
          originalUrls.get(sample.id),
          originalUrls.get(same),
          `${sample.id}: duplicate favorite keeps the first-favorited URL`,
        );
      }
      const diff = sample.expect.differsFromSourceOf;
      if (diff !== undefined) {
        assert.notEqual(
          sourceIds.get(sample.id),
          sourceIds.get(diff),
          `${sample.id} must be an independent Source from ${diff}`,
        );
        assert.notEqual(resourceIds.get(sample.id), resourceIds.get(diff));
      }
    }

    // Same-title different-video acceptance: equal titles, separate data.
    const a = sampleById.get("match-same-title-video-a");
    const b = sampleById.get("match-same-title-video-b");
    assert.equal(a.title, b.title);
    assert.notEqual(sourceIds.get(a.id), sourceIds.get(b.id));

    // B 站多分集：p2/p3 same BV, separate Sources with separate identities.
    const p2 = sampleById.get("match-bilibili-multi-episode-p2");
    const p3 = sampleById.get("match-bilibili-multi-episode-p3");
    assert.notEqual(sourceIds.get(p2.id), sourceIds.get(p3.id));
  } finally {
    await app.close();
  }
});

test("client-supplied identity resolves to the same sources as server extraction", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const sourceIds = new Map();
    for (const sample of samples) {
      const response = await app.request("POST", "/v1/resources", {
        headers: authHeader(token),
        body: { url: sample.url, title: sample.title },
      });
      assert.ok(response.status === 201 || response.status === 200);
      sourceIds.set(sample.id, response.json.source.id);
    }

    for (const sample of samples) {
      const identity = extractVideoIdentity(sample.url);
      const body = identity ? { url: sample.url, identity } : { url: sample.url };
      const response = await app.request("POST", "/v1/sources/resolve", {
        headers: authHeader(token),
        body,
      });
      assert.equal(response.status, 200);
      assert.equal(response.json.matched, true, `${sample.id}: resolve finds its own Source`);
      assert.equal(
        response.json.source.id,
        sourceIds.get(sample.id),
        `${sample.id}: identity resolve lands on the same Source`,
      );
    }
  } finally {
    await app.close();
  }
});

test("two accounts favoriting the same URL concurrently each get their own Source", async () => {
  const example = apiExampleById.get("api-resources-create-bilibili-p2");
  const app = await startApp({
    seedFile: seedFileWith(["a@example.com", "b@example.com"]),
  });
  try {
    const a = await openAccount(app, "a@example.com");
    const b = await openAccount(app, "b@example.com");

    const [first, second] = await Promise.all([
      app.request("POST", "/v1/resources", { headers: authHeader(a), body: example.request.body }),
      app.request("POST", "/v1/resources", { headers: authHeader(b), body: example.request.body }),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.json.resource.id, second.json.resource.id);
    assert.notEqual(first.json.source.id, second.json.source.id);
    assert.equal(first.json.source.url, second.json.source.url);
    assert.deepEqual(
      {
        platformId: second.json.source.platformId,
        platformVideoId: second.json.source.platformVideoId,
        episodeId: second.json.source.episodeId,
        platformScopeId: second.json.source.platformScopeId,
      },
      {
        platformId: first.json.source.platformId,
        platformVideoId: first.json.source.platformVideoId,
        episodeId: first.json.source.episodeId,
        platformScopeId: first.json.source.platformScopeId,
      },
    );

    // Each account sees exactly one favorite — its own.
    for (const [token, own] of [[a, first.json], [b, second.json]]) {
      const list = await app.request("GET", "/v1/resources", { headers: authHeader(token) });
      assert.equal(list.status, 200);
      assert.equal(list.json.resources.length, 1);
      assert.equal(list.json.resources[0].resource.id, own.resource.id);
      assert.equal(list.json.resources[0].sources[0].id, own.source.id);
    }

    // Re-favoriting inside one account still deduplicates (200).
    const repeat = await app.request("POST", "/v1/resources", {
      headers: authHeader(a),
      body: example.request.body,
    });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.json.source.id, first.json.source.id);
  } finally {
    await app.close();
  }
});

test("a declared uppercase-hex xiaohongshu identity validates (formats come from the shared module)", async () => {
  // The §1 format judgment is contracts/platform-video-id.js's
  // platformVideoIdFormats — case-insensitive like the extractors and the
  // recognition adapter, so an uppercase-hex note identity is not a 400.
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const response = await app.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: {
        url: "https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab23",
        identity: {
          platformId: "xiaohongshu",
          platformVideoId: "66A1B2C3000000001E01AB23",
        },
      },
    });
    assert.equal(response.status, 201);
    assert.equal(response.json.source.platformVideoId, "66A1B2C3000000001E01AB23");
  } finally {
    await app.close();
  }
});

test("malformed identity declarations are rejected with validation_failed (400)", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const cases = [
      { identity: "not-an-object" },
      { identity: { platformId: "vimeo", platformVideoId: "12345" } },
      { identity: { platformId: "bilibili", platformVideoId: "BV123" } },
      { identity: { platformId: "youtube", platformVideoId: "dQw4w9WgXcQ", platformScopeId: "shop" } },
      { identity: { platformId: "xiaoe-tech", platformVideoId: "v_66a1b2c3d4e5" } },
      { identity: { platformId: "youtube", platformVideoId: "dQw4w9WgXcQ", episodeId: "2" } },
    ];
    for (const body of cases) {
      const response = await app.request("POST", "/v1/resources", {
        headers: authHeader(token),
        body: { url: "https://www.example.com/whatever", ...body },
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.json.error.code, "validation_failed");
    }

    // Nothing was created by the rejected requests.
    const list = await app.request("GET", "/v1/resources", { headers: authHeader(token) });
    assert.deepEqual(list.json, { resources: [] });
  } finally {
    await app.close();
  }
});
