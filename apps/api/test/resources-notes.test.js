/**
 * POST /v1/resources/{id}/notes and the notes in GET /v1/resources/{id}
 * (Ticket P12, issue #61; contract-v1.md §2.4, §3.3, §3.6).
 *
 * Seam: the /v1 HTTP endpoints against the P1 fixtures (same as the P4/P9
 * tests). The bilibili fixture chain runs against a live Resource + Source
 * created through POST /v1/resources with the fixture bodies — the opaque
 * fixture ids (res_01JABC0001 / src_01JABC0002) map onto the live ids.
 * Concrete contract fields are asserted verbatim from the fixtures; the
 * injected clock pins createdAt to the fixture value exactly.
 *
 * Semantics pinned here (the fixtures do not cover them):
 * - the idempotent resend is scoped to the account + clientRequestId: the
 *   first POST that carried a given clientRequestId is THE note; a resend
 *   answers 200 with the original note and never duplicates;
 * - a timestamped note's sourceId must point at a Source of the SAME
 *   resource under the SAME account (otherwise 400 validation_failed);
 *   a cross-account Resource is always the D2 404 first.
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

/** Fixture clock: the timestamped note sample's createdAt, verbatim. */
const NOTE_CLOCK_MS = Date.parse("2026-11-10T08:30:00Z");

/**
 * Create the fixture bilibili Resource + Source (the note fixtures'
 * res_01JABC0001 / src_01JABC0002) and the fixture generic webpage
 * (res_01JABC0010) through the public favoriting endpoint.
 */
async function createFixtureLibrary(app, token) {
  const video = await app.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: apiExampleById.get("api-resources-create-bilibili-p2").request.body,
  });
  assert.equal(video.status, 201);
  const webpage = await app.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: apiExampleById.get("api-resources-create-generic-webpage").request.body,
  });
  assert.equal(webpage.status, 201);
  return { videoSource: video.json.source, webpageResource: webpage.json.resource };
}

test("timestamped note create matches the fixture (201, verbatim body)", async () => {
  const example = apiExampleById.get("api-note-create-timestamped");
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => NOTE_CLOCK_MS,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { videoSource } = await createFixtureLibrary(app, token);

    // The fixture's opaque sourceId (src_01JABC0002) maps onto the live id
    // (the P9 progress-test pattern); every other field goes verbatim.
    const response = await app.request(
      "POST",
      `/v1/resources/${videoSource.resourceId}/notes`,
      {
        headers: authHeader(token),
        body: { ...example.request.body, sourceId: videoSource.id },
      },
    );
    assert.equal(response.status, example.response.status);
    const note = response.json.note;
    assert.ok(typeof note.id === "string" && note.id.length > 0);
    // Relational ids: the note belongs to the resource and the source it
    // was stamped on.
    assert.equal(note.resourceId, videoSource.resourceId);
    assert.equal(note.sourceId, videoSource.id);
    for (const key of ["positionMs", "text", "clientRequestId", "createdAt"]) {
      assert.deepEqual(note[key], example.response.body.note[key], `note.${key}`);
    }
  } finally {
    await app.close();
  }
});

test("webpage note without source/position matches the fixture (201, nulls)", async () => {
  const example = apiExampleById.get("api-note-create-webpage");
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => Date.parse("2026-11-10T08:40:00Z"),
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { webpageResource } = await createFixtureLibrary(app, token);

    const response = await app.request(
      "POST",
      `/v1/resources/${webpageResource.id}/notes`,
      { headers: authHeader(token), body: example.request.body },
    );
    assert.equal(response.status, example.response.status);
    const note = response.json.note;
    assert.ok(typeof note.id === "string" && note.id.length > 0);
    assert.equal(note.resourceId, webpageResource.id);
    assert.equal(note.sourceId, null);
    assert.equal(note.positionMs, null);
    for (const key of ["text", "clientRequestId", "createdAt"]) {
      assert.deepEqual(note[key], example.response.body.note[key], `note.${key}`);
    }
  } finally {
    await app.close();
  }
});

test("GET detail returns the created notes (contract §3.3, real data)", async () => {
  const detailExample = apiExampleById.get("api-resources-detail-with-notes");
  const create = apiExampleById.get("api-note-create-timestamped");
  const webpage = apiExampleById.get("api-note-create-webpage");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { videoSource, webpageResource } = await createFixtureLibrary(app, token);

    await app.request("POST", `/v1/resources/${videoSource.resourceId}/notes`, {
      headers: authHeader(token),
      body: { ...create.request.body, sourceId: videoSource.id },
    });
    await app.request("POST", `/v1/resources/${webpageResource.id}/notes`, {
      headers: authHeader(token),
      body: webpage.request.body,
    });

    // The timestamped resource detail carries its note (P4's empty array
    // placeholder becomes the real read-back).
    const detail = await app.request(
      "GET",
      `/v1/resources/${videoSource.resourceId}`,
      { headers: authHeader(token) },
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.json.notes.length, 1);
    const note = detail.json.notes[0];
    assert.equal(note.sourceId, videoSource.id);
    assert.deepEqual(note.positionMs, detailExample.response.body.notes[0].positionMs);
    assert.deepEqual(note.text, detailExample.response.body.notes[0].text);
    assert.deepEqual(note.clientRequestId, detailExample.response.body.notes[0].clientRequestId);
    assert.match(note.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // The webpage resource's notes stay separate (no cross-resource leak).
    const webpageDetail = await app.request(
      "GET",
      `/v1/resources/${webpageResource.id}`,
      { headers: authHeader(token) },
    );
    assert.equal(webpageDetail.json.notes.length, 1);
    assert.equal(webpageDetail.json.notes[0].sourceId, null);
  } finally {
    await app.close();
  }
});

test("resending the same clientRequestId returns 200 and the original note, no duplicate (api-note-resend-idempotent)", async () => {
  const create = apiExampleById.get("api-note-create-timestamped");
  const resend = apiExampleById.get("api-note-resend-idempotent");
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => NOTE_CLOCK_MS,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { videoSource } = await createFixtureLibrary(app, token);
    const path = `/v1/resources/${videoSource.resourceId}/notes`;

    const first = await app.request("POST", path, {
      headers: authHeader(token),
      body: { ...create.request.body, sourceId: videoSource.id },
    });
    assert.equal(first.status, 201);

    // The resend (same clientRequestId, e.g. after a network drop) answers
    // 200 with the same note verbatim — the fixture pins 200 + same body.
    const second = await app.request("POST", path, {
      headers: authHeader(token),
      body: { ...resend.request.body, sourceId: videoSource.id },
    });
    assert.equal(second.status, resend.response.status);
    assert.equal(second.json.note.id, first.json.note.id);
    assert.deepEqual(second.json.note, first.json.note);

    // And nothing was duplicated.
    const detail = await app.request(
      "GET",
      `/v1/resources/${videoSource.resourceId}`,
      { headers: authHeader(token) },
    );
    assert.equal(detail.json.notes.length, 1);
  } finally {
    await app.close();
  }
});

test("a clientRequestId is the dedupe basis account-wide: reusing it on another resource returns the original note", async () => {
  const create = apiExampleById.get("api-note-create-webpage");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { videoSource, webpageResource } = await createFixtureLibrary(app, token);

    const first = await app.request(
      "POST",
      `/v1/resources/${webpageResource.id}/notes`,
      { headers: authHeader(token), body: create.request.body },
    );
    assert.equal(first.status, 201);

    // The same clientRequestId aimed at a different resource of the same
    // account cannot create a second note: the original comes back.
    const second = await app.request(
      "POST",
      `/v1/resources/${videoSource.resourceId}/notes`,
      { headers: authHeader(token), body: create.request.body },
    );
    assert.equal(second.status, 200);
    assert.equal(second.json.note.id, first.json.note.id);
    assert.equal(second.json.note.resourceId, webpageResource.id);

    const detail = await app.request(
      "GET",
      `/v1/resources/${videoSource.resourceId}`,
      { headers: authHeader(token) },
    );
    assert.equal(detail.json.notes.length, 0, "no note leaked onto the other resource");
  } finally {
    await app.close();
  }
});

test("empty note text is the fixture 400 (error-validation-failed-empty-note-text)", async () => {
  const example = errorExampleById.get("error-validation-failed-empty-note-text");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { videoSource } = await createFixtureLibrary(app, token);

    const response = await app.request(
      "POST",
      `/v1/resources/${videoSource.resourceId}/notes`,
      { headers: authHeader(token), body: example.request.body },
    );
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);
  } finally {
    await app.close();
  }
});

test("request validation: missing clientRequestId, pairing and positionMs are 400s", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { videoSource } = await createFixtureLibrary(app, token);
    const post = (body) =>
      app.request("POST", `/v1/resources/${videoSource.resourceId}/notes`, {
        headers: authHeader(token),
        body,
      });

    const cases = [
      ["missing clientRequestId", { text: "hello" }],
      ["empty clientRequestId", { clientRequestId: "", text: "hello" }],
      ["missing text", { clientRequestId: "r1" }],
      ["whitespace text", { clientRequestId: "r1", text: "   " }],
      ["non-string text", { clientRequestId: "r1", text: 42 }],
      ["sourceId without positionMs", { clientRequestId: "r1", text: "hello", sourceId: videoSource.id }],
      ["positionMs without sourceId", { clientRequestId: "r1", text: "hello", positionMs: 1000 }],
      ["negative positionMs", { clientRequestId: "r1", text: "hello", sourceId: videoSource.id, positionMs: -1 }],
      ["fractional positionMs", { clientRequestId: "r1", text: "hello", sourceId: videoSource.id, positionMs: 1.5 }],
      ["string positionMs", { clientRequestId: "r1", text: "hello", sourceId: videoSource.id, positionMs: "1000" }],
      ["empty sourceId", { clientRequestId: "r1", text: "hello", sourceId: "", positionMs: 1000 }],
    ];
    for (const [label, body] of cases) {
      const response = await post(body);
      assert.equal(response.status, 400, label);
      assert.equal(response.json.error.code, "validation_failed", label);
    }

    // A rejected write leaves no note behind.
    const detail = await app.request(
      "GET",
      `/v1/resources/${videoSource.resourceId}`,
      { headers: authHeader(token) },
    );
    assert.equal(detail.json.notes.length, 0);
  } finally {
    await app.close();
  }
});

test("a sourceId from another resource of the same account is a 400 (the pointer must stay in-resource)", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { videoSource, webpageResource } = await createFixtureLibrary(app, token);

    const response = await app.request(
      "POST",
      `/v1/resources/${webpageResource.id}/notes`,
      {
        headers: authHeader(token),
        body: { clientRequestId: "r-x", text: "stamped", sourceId: videoSource.id, positionMs: 1000 },
      },
    );
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_failed");

    // A sourceId that exists nowhere is the same validation failure (the
    // resource itself is valid, so D2's 404 does not apply).
    const unknown = await app.request(
      "POST",
      `/v1/resources/${webpageResource.id}/notes`,
      {
        headers: authHeader(token),
        body: { clientRequestId: "r-y", text: "stamped", sourceId: "src_missing", positionMs: 1000 },
      },
    );
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error.code, "validation_failed");
  } finally {
    await app.close();
  }
});

test("writing to another account's resource is the fixture 404 (error-cross-account-note-create)", async () => {
  const example = errorExampleById.get("error-cross-account-note-create");
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const { videoSource } = await createFixtureLibrary(app, owner);

    // The fixture path /v1/resources/res_01JZZZZ9999/notes exercises the
    // unknown-id 404; the live cross-account id exercises the isolation one.
    const fixturePath = await app.request("POST", example.endpoint.path, {
      headers: authHeader(other),
      body: example.request.body,
    });
    assert.equal(fixturePath.status, example.response.status);
    assert.deepEqual(fixturePath.json, example.response.body);

    const crossAccount = await app.request(
      "POST",
      `/v1/resources/${videoSource.resourceId}/notes`,
      { headers: authHeader(other), body: example.request.body },
    );
    assert.equal(crossAccount.status, 404);
    assert.deepEqual(crossAccount.json, example.response.body);

    // D2 404 wins over the source-pointer validation: a cross-account write
    // with a bogus sourceId is still the 404.
    const withBogusSource = await app.request(
      "POST",
      `/v1/resources/${videoSource.resourceId}/notes`,
      {
        headers: authHeader(other),
        body: { ...example.request.body, sourceId: "src_missing", positionMs: 1000 },
      },
    );
    assert.equal(withBogusSource.status, 404);

    // Nothing was written anywhere.
    const ownerDetail = await app.request(
      "GET",
      `/v1/resources/${videoSource.resourceId}`,
      { headers: authHeader(owner) },
    );
    assert.equal(ownerDetail.json.notes.length, 0);
  } finally {
    await app.close();
  }
});

test("notes endpoints require credentials (401)", async () => {
  const missing = errorExampleById.get("error-unauthorized-missing-token");
  const expired = errorExampleById.get("error-unauthorized-expired-token");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const noHeader = await app.request("POST", "/v1/resources/res_x/notes", {
      body: { clientRequestId: "r1", text: "hello" },
    });
    assert.equal(noHeader.status, missing.response.status);
    assert.deepEqual(noHeader.json, missing.response.body);

    const badToken = await app.request("POST", "/v1/resources/res_x/notes", {
      headers: authHeader("not-a-token"),
      body: { clientRequestId: "r1", text: "hello" },
    });
    assert.equal(badToken.status, expired.response.status);
    assert.deepEqual(badToken.json, expired.response.body);
  } finally {
    await app.close();
  }
});
