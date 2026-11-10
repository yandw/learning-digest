/**
 * Contract fixtures validation (Ticket P1, issue #50).
 *
 * Seam: the JSON fixtures under contracts/fixtures/ are the shared test
 * samples that the Web, extension and API implementation tickets reference
 * directly. This test is the contract conformance check: every fixture
 * parses, carries the contract marker, and every sample's fields conform
 * to the structures and matching rules defined in contract-v1.md and
 * platform-video-id-rules.md.
 *
 * The test validates structure and cross-sample consistency. It does NOT
 * re-derive URL matching (that behavior belongs to the three ends, which
 * consume these fixtures as their expected values).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

const CONTRACT_MARKER = "learning-digest-contracts/v1";
const PLATFORMS = new Set(["xiaoe-tech", "bilibili", "youtube", "xiaohongshu"]);
const MATCH_STRATEGIES = new Set(["platform-identity", "url-exact"]);
const AUTH_STATES = new Set(["none", "expired", "valid"]);

// Formats from platform-video-id-rules.md. xiaoe tokens carry the
// resource prefix; term_ pages are containers and never a video identity.
const VIDEO_ID_FORMATS = {
  "xiaoe-tech": /^(p|v|a|i|l)_[a-z0-9]{4,}$/i,
  "bilibili": /^BV[0-9A-Za-z]{10}$/,
  "youtube": /^[0-9A-Za-z_-]{11}$/,
  "xiaohongshu": /^[0-9a-f]{24}$/,
};

function loadFixture(name) {
  const file = path.join(FIXTURES_DIR, name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requireHeader(sample, file) {
  assert.equal(
    sample.$contract,
    CONTRACT_MARKER,
    `${file}: samples must declare the contract marker`,
  );
  assert.ok(Array.isArray(sample.samples) && sample.samples.length > 0, `${file}: samples[] must be non-empty`);
}

function sampleIds(samples, file) {
  return samples.map((s) => {
    assert.equal(typeof s.id, "string", `${file}: every sample needs a string id`);
    return s.id;
  });
}

// --- source-matching.json ---------------------------------------------------

test("source-matching fixtures parse and declare the contract", () => {
  const fixture = loadFixture("source-matching.json");
  requireHeader(fixture, "source-matching.json");
});

test("source-matching samples conform to the matching contract", () => {
  const { samples } = loadFixture("source-matching.json");
  for (const s of samples) {
    assert.equal(typeof s.id, "string", `sample ${JSON.stringify(s)} needs an id`);
    assert.match(s.id, /^match-[a-z0-9-]+$/, `${s.id}: ids look like match-<slug>`);
    assert.equal(typeof s.description, "string", `${s.id}: needs a description`);
    assert.doesNotThrow(() => new URL(s.url), `${s.id}: url must parse`);
    assert.match(s.url, /^https?:\/\//, `${s.id}: url must be http(s)`);

    const expect = s.expect;
    assert.ok(expect && typeof expect === "object", `${s.id}: needs expect{}`);
    assert.ok(
      MATCH_STRATEGIES.has(expect.matchStrategy),
      `${s.id}: matchStrategy must be one of ${[...MATCH_STRATEGIES].join(", ")}`,
    );

    if (expect.matchStrategy === "platform-identity") {
      assert.ok(PLATFORMS.has(expect.platformId), `${s.id}: unknown platformId ${expect.platformId}`);
      assert.match(
        expect.platformVideoId,
        VIDEO_ID_FORMATS[expect.platformId],
        `${s.id}: platformVideoId ${expect.platformVideoId} does not match ${expect.platformId} format`,
      );
      if (expect.platformId === "bilibili") {
        assert.match(expect.episodeId, /^\d+$/, `${s.id}: bilibili episodeId is the p value as digits`);
      }
      if (expect.platformScopeId !== undefined) {
        assert.equal(expect.platformId, "xiaoe-tech", `${s.id}: platformScopeId is xiaoe-tech only`);
        assert.match(expect.platformScopeId, /^[a-z0-9]+$/i, `${s.id}: platformScopeId is the shop subdomain`);
      }
      assert.equal(expect.normalizedUrl, undefined, `${s.id}: platform-identity does not use normalizedUrl`);
    } else {
      assert.equal(expect.platformId, undefined, `${s.id}: url-exact has no platformId`);
      assert.equal(expect.platformVideoId, undefined, `${s.id}: url-exact has no platformVideoId`);
      assert.equal(typeof expect.normalizedUrl, "string", `${s.id}: url-exact carries the normalizedUrl`);
      assert.doesNotThrow(() => new URL(expect.normalizedUrl), `${s.id}: normalizedUrl must parse`);
    }
  }
});

test("source-matching sample ids are unique", () => {
  const { samples } = loadFixture("source-matching.json");
  const ids = sampleIds(samples, "source-matching.json");
  assert.equal(new Set(ids).size, ids.length, "duplicate sample ids");
});

// The identity a sample matches on. For url-exact it is the normalized
// URL; for platform-identity it is the documented identity tuple, with
// bilibili's omitted p defaulting to "1".
function identityOf(sample) {
  const expect = sample.expect;
  if (expect.matchStrategy === "url-exact") {
    return { url: expect.normalizedUrl };
  }
  const identity = {
    platformId: expect.platformId,
    platformScopeId: expect.platformScopeId ?? null,
    platformVideoId: expect.platformVideoId,
    episodeId: expect.platformId === "bilibili" ? expect.episodeId : null,
  };
  return identity;
}

test("source-matching cross-sample source relations are consistent", () => {
  const { samples } = loadFixture("source-matching.json");
  const byId = new Map(samples.map((s) => [s.id, s]));

  for (const s of samples) {
    for (const field of ["matchesSameSourceAs", "differsFromSourceOf"]) {
      const ref = s.expect[field];
      if (ref === undefined) continue;
      assert.ok(byId.has(ref), `${s.id}: ${field} points at unknown sample ${ref}`);
      const a = identityOf(s);
      const b = identityOf(byId.get(ref));
      if (field === "matchesSameSourceAs") {
        assert.deepEqual(a, b, `${s.id} claims same Source as ${ref} but identities differ`);
      } else {
        assert.notDeepEqual(a, b, `${s.id} claims a different Source from ${ref} but identities match`);
      }
    }
  }

  // Acceptance-critical relations from the spec must be present.
  const ids = new Set(byId.keys());
  for (const required of [
    "match-bilibili-multi-episode-p2",
    "match-bilibili-multi-episode-p3",
    "match-bilibili-episode2-share-link",
    "match-same-title-video-a",
    "match-same-title-video-b",
  ]) {
    assert.ok(ids.has(required), `required sample missing: ${required}`);
  }
});

// --- api-examples.json ------------------------------------------------------

const RESOURCE_KINDS = new Set(["webpage", "video", "audio", "live"]);
const SOURCE_KINDS = new Set(["webpage", "video", "audio", "live", "replay"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SIX_ENDPOINTS = [
  "POST /v1/resources",
  "GET /v1/resources",
  "GET /v1/resources/{id}",
  "POST /v1/sources/resolve",
  "PUT /v1/sources/{id}/progress",
  "POST /v1/resources/{id}/notes",
];

// Classifies a concrete example endpoint onto the /v1 contract surface.
// Concrete ids in path segments collapse into {id}; anything that does
// not match one of the six templates is a contract error.
function endpointTemplate(method, pathname) {
  const segs = pathname.split("/").filter(Boolean);
  const joined = segs.join("/");
  if (method === "POST" && joined === "v1/resources") return "POST /v1/resources";
  if (method === "GET" && joined === "v1/resources") return "GET /v1/resources";
  if (method === "GET" && segs.length === 3 && segs[0] === "v1" && segs[1] === "resources") {
    return "GET /v1/resources/{id}";
  }
  if (method === "POST" && joined === "v1/sources/resolve") return "POST /v1/sources/resolve";
  if (method === "PUT" && segs.length === 4 && segs[1] === "sources" && segs[3] === "progress") {
    return "PUT /v1/sources/{id}/progress";
  }
  if (method === "POST" && segs.length === 4 && segs[1] === "resources" && segs[3] === "notes") {
    return "POST /v1/resources/{id}/notes";
  }
  return null;
}

function assertIsoTimestamp(value, where) {
  assert.equal(typeof value, "string", `${where}: timestamps are ISO 8601 strings`);
  assert.match(value, ISO_TIMESTAMP, `${where}: timestamp ${value} must be ISO 8601 UTC`);
}

function assertResourceId(value, where) {
  assert.match(value, /^res_[0-9A-Za-z]+$/, `${where}: fixture resource ids use the res_ prefix`);
}

function assertSourceId(value, where) {
  assert.match(value, /^src_[0-9A-Za-z]+$/, `${where}: fixture source ids use the src_ prefix`);
}

function assertProgress(progress, where) {
  assert.ok(progress && typeof progress === "object", `${where}: progress must be an object`);
  assert.ok(Number.isInteger(progress.positionMs) && progress.positionMs >= 0, `${where}: positionMs is a non-negative integer`);
  assert.ok(Number.isInteger(progress.revision) && progress.revision >= 1, `${where}: revision is a positive integer`);
}

function assertResource(resource, where) {
  assert.ok(resource && typeof resource === "object", `${where}: resource must be an object`);
  assertResourceId(resource.id, where);
  assert.equal(typeof resource.title, "string", `${where}: resource.title is a string`);
  assert.ok(RESOURCE_KINDS.has(resource.kind), `${where}: resource.kind ${resource.kind} must be one of ${[...RESOURCE_KINDS].join(", ")}`);
  assertIsoTimestamp(resource.createdAt, where);
}

function assertSource(source, where) {
  assert.ok(source && typeof source === "object", `${where}: source must be an object`);
  assertSourceId(source.id, where);
  assert.equal(typeof source.resourceId, "string", `${where}: source.resourceId is a string`);
  assertResourceId(source.resourceId, `${where}: source.resourceId`);
  assert.ok(SOURCE_KINDS.has(source.kind), `${where}: source.kind ${source.kind} must be one of ${[...SOURCE_KINDS].join(", ")}`);
  assert.doesNotThrow(() => new URL(source.url), `${where}: source.url must parse`);

  // Identity fields: both platformId and platformVideoId are set together,
  // or both null. platformScopeId is xiaoe-tech only. episodeId only makes
  // sense with a platform identity.
  const hasPlatform = source.platformId !== null && source.platformId !== undefined;
  const hasVideoId = source.platformVideoId !== null && source.platformVideoId !== undefined;
  assert.equal(hasPlatform, hasVideoId, `${where}: platformId and platformVideoId are set together`);
  if (hasPlatform) {
    assert.ok(PLATFORMS.has(source.platformId), `${where}: unknown platformId ${source.platformId}`);
    assert.match(source.platformVideoId, VIDEO_ID_FORMATS[source.platformId], `${where}: platformVideoId format`);
    if (source.platformId === "bilibili") {
      assert.match(source.episodeId, /^\d+$/, `${where}: bilibili episodeId is the p value as digits`);
    }
    if (source.platformScopeId !== undefined && source.platformScopeId !== null) {
      assert.equal(source.platformId, "xiaoe-tech", `${where}: platformScopeId is xiaoe-tech only`);
    }
  }

  if (source.progress !== undefined && source.progress !== null) {
    assertProgress(source.progress, `${where}: source.progress`);
  }
}

function assertNote(note, where) {
  assert.ok(note && typeof note === "object", `${where}: note must be an object`);
  assert.match(note.id, /^note_[0-9A-Za-z]+$/, `${where}: fixture note ids use the note_ prefix`);
  assertResourceId(note.resourceId, `${where}: note.resourceId`);
  assert.equal(typeof note.text, "string", `${where}: note.text is a string`);
  assert.ok(note.text.length > 0, `${where}: note.text is non-empty`);
  assert.equal(typeof note.clientRequestId, "string", `${where}: note.clientRequestId is a string`);
  assertIsoTimestamp(note.createdAt, where);
  const hasPosition = note.positionMs !== null && note.positionMs !== undefined;
  const hasSource = note.sourceId !== null && note.sourceId !== undefined;
  assert.equal(hasPosition, hasSource, `${where}: note.positionMs requires note.sourceId and vice versa`);
  if (hasSource) {
    assertSourceId(note.sourceId, `${where}: note.sourceId`);
    assert.ok(Number.isInteger(note.positionMs) && note.positionMs >= 0, `${where}: note.positionMs is a non-negative integer`);
  }
}

function loadExamples(file) {
  const fixture = loadFixture(file);
  requireHeader(fixture, file);
  for (const example of fixture.samples) {
    assert.equal(typeof example.id, "string", `${file}: example needs an id`);
    assert.equal(typeof example.description, "string", `${example.id}: needs a description`);
    assert.ok(example.endpoint && typeof example.endpoint === "object", `${example.id}: needs endpoint{}`);
    const template = endpointTemplate(example.endpoint.method, example.endpoint.path);
    assert.ok(template, `${example.id}: ${example.endpoint.method} ${example.endpoint.path} is not on the /v1 contract surface`);
    example._template = template;
    assert.ok(example.response && typeof example.response === "object", `${example.id}: needs response{}`);
    assert.ok(Number.isInteger(example.response.status), `${example.id}: response.status is an integer`);
    assert.ok(example.response.body && typeof example.response.body === "object", `${example.id}: response.body must be an object`);
  }
  return fixture;
}

test("api-examples parse, sit on the /v1 surface, and cover all six endpoints", () => {
  const fixture = loadExamples("api-examples.json");
  const templates = new Set(fixture.samples.map((e) => e._template));
  for (const endpoint of SIX_ENDPOINTS) {
    assert.ok(templates.has(endpoint), `api-examples.json: no example covers ${endpoint}`);
  }
});

test("api-examples response bodies conform to the contract structures", () => {
  const fixture = loadExamples("api-examples.json");
  for (const example of fixture.samples) {
    const { response } = example;
    assert.ok(
      (response.status >= 200 && response.status < 300),
      `${example.id}: api-examples only carry success responses (errors live in error-examples.json)`,
    );

    if (example._template === "POST /v1/resources") {
      assert.ok(response.status === 201 || response.status === 200, `${example.id}: create returns 201, duplicate returns 200`);
      assertResource(response.body.resource, `${example.id}`);
      assertSource(response.body.source, `${example.id}`);
      assert.equal(response.body.source.resourceId, response.body.resource.id, `${example.id}: source.resourceId links to the resource`);
    } else if (example._template === "GET /v1/resources") {
      assert.equal(response.status, 200, `${example.id}: list returns 200`);
      assert.ok(Array.isArray(response.body.resources) && response.body.resources.length > 0, `${example.id}: resources[] non-empty`);
      for (const item of response.body.resources) {
        assertResource(item.resource, `${example.id}`);
        assert.ok(Array.isArray(item.sources) && item.sources.length > 0, `${example.id}: list items carry their sources`);
        for (const source of item.sources) {
          assertSource(source, `${example.id}`);
          assert.equal(source.resourceId, item.resource.id, `${example.id}: list source belongs to its resource`);
        }
      }
    } else if (example._template === "GET /v1/resources/{id}") {
      assert.equal(response.status, 200, `${example.id}: detail returns 200`);
      assertResource(response.body.resource, `${example.id}`);
      assert.ok(Array.isArray(response.body.sources), `${example.id}: detail carries sources[]`);
      for (const source of response.body.sources) {
        assertSource(source, `${example.id}`);
      }
      assert.ok(Array.isArray(response.body.notes), `${example.id}: detail carries notes[]`);
      for (const note of response.body.notes) {
        assertNote(note, `${example.id}`);
        assert.equal(note.resourceId, response.body.resource.id, `${example.id}: detail note belongs to the resource`);
      }
    } else if (example._template === "POST /v1/sources/resolve") {
      assert.equal(response.status, 200, `${example.id}: resolve returns 200 whether or not it matches`);
      if (response.body.matched === true) {
        assertResource(response.body.resource, `${example.id}`);
        assertSource(response.body.source, `${example.id}`);
        assert.equal(response.body.source.resourceId, response.body.resource.id, `${example.id}: resolve source links to resource`);
      } else {
        assert.equal(response.body.matched, false, `${example.id}: matched is a boolean`);
        assert.equal(response.body.resource, undefined, `${example.id}: unmatched resolve carries no resource`);
        assert.equal(response.body.source, undefined, `${example.id}: unmatched resolve carries no source`);
      }
    } else if (example._template === "PUT /v1/sources/{id}/progress") {
      assert.equal(response.status, 200, `${example.id}: progress write returns 200`);
      assertProgress(response.body, `${example.id}`);
    } else if (example._template === "POST /v1/resources/{id}/notes") {
      assert.ok(response.status === 201 || response.status === 200, `${example.id}: note create returns 201, resend returns 200`);
      assertNote(response.body.note, `${example.id}`);
    }
  }
});

test("api-examples keep idempotency and revision invariants", () => {
  const { samples } = loadExamples("api-examples.json");
  const byId = new Map(samples.map((e) => [e.id, e]));

  // Duplicate favorite returns the same resource + source as the create.
  const create = byId.get("api-resources-create-bilibili-p2");
  const duplicate = byId.get("api-resources-duplicate-bilibili-p2");
  assert.ok(create && duplicate, "duplicate-favorite pair must exist");
  assert.equal(duplicate.response.status, 200, "duplicate favorite returns 200");
  assert.equal(
    duplicate.response.body.resource.id,
    create.response.body.resource.id,
    "duplicate favorite returns the same resource",
  );
  assert.equal(
    duplicate.response.body.source.id,
    create.response.body.source.id,
    "duplicate favorite returns the same source",
  );
  assert.equal(
    duplicate.response.body.source.url,
    create.response.body.source.url,
    "the stored original URL stays the first-favorited address",
  );

  // Note resend with the same clientRequestId returns the same note.
  const noteCreate = byId.get("api-note-create-timestamped");
  const noteResend = byId.get("api-note-resend-idempotent");
  assert.ok(noteCreate && noteResend, "note idempotency pair must exist");
  assert.equal(noteResend.response.status, 200, "note resend returns 200");
  assert.deepEqual(
    noteResend.response.body.note,
    noteCreate.response.body.note,
    "note resend returns the identical note",
  );
  assert.equal(
    noteResend.request.body.clientRequestId,
    noteCreate.request.body.clientRequestId,
    "note resend reuses the clientRequestId",
  );

  // Revision chain: first write rev 1, update rev 2, matching the detail
  // and resolve examples that read the same source afterwards.
  const first = byId.get("api-progress-first-write");
  const update = byId.get("api-progress-update");
  assert.ok(first && update, "progress chain must exist");
  assert.equal(first.response.body.revision, 1, "first progress write is revision 1");
  assert.equal(update.response.body.revision, 2, "second progress write is revision 2");
  assert.equal(first.request.body.expectedRevision, 0, "first write expects revision 0 (no progress yet)");

  const detail = byId.get("api-resources-detail-with-notes");
  assert.ok(detail, "detail example must exist");
  const detailSource = detail.response.body.sources.find((s) => s.id === create.response.body.source.id);
  assert.ok(detailSource, "detail example shows the created source");
  assert.deepEqual(
    detailSource.progress,
    { positionMs: update.response.body.positionMs, revision: update.response.body.revision },
    "detail shows the latest progress written by the chain",
  );
});

// --- error-examples.json ----------------------------------------------------

// status ↔ error.code mapping from contract-v1.md.
const ERROR_CODE_BY_STATUS = {
  400: new Set(["invalid_url", "validation_failed"]),
  401: new Set(["unauthorized"]),
  404: new Set(["not_found"]),
  409: new Set(["progress_revision_conflict"]),
};

test("error-examples parse, sit on the /v1 surface, and use the error envelope", () => {
  const fixture = loadExamples("error-examples.json");
  for (const example of fixture.samples) {
    const { response } = example;
    assert.ok(
      ERROR_CODE_BY_STATUS[response.status] !== undefined,
      `${example.id}: error examples use statuses ${Object.keys(ERROR_CODE_BY_STATUS).join(", ")}`,
    );
    const error = response.body.error;
    assert.ok(error && typeof error === "object", `${example.id}: error responses carry an error envelope`);
    assert.equal(typeof error.code, "string", `${example.id}: error.code is a string`);
    assert.equal(typeof error.message, "string", `${example.id}: error.message is a string`);
    assert.ok(
      ERROR_CODE_BY_STATUS[response.status].has(error.code),
      `${example.id}: status ${response.status} does not pair with code ${error.code}`,
    );

    if (example.auth !== undefined) {
      assert.ok(AUTH_STATES.has(example.auth), `${example.id}: auth must be one of ${[...AUTH_STATES].join(", ")}`);
    }
  }
});

test("error-examples pin the four acceptance error behaviors", () => {
  const fixture = loadExamples("error-examples.json");
  const byId = new Map(fixture.samples.map((e) => [e.id, e]));

  // 401: no credential and expired/revoked credential both -> unauthorized.
  const noAuth = byId.get("error-unauthorized-missing-token");
  const expired = byId.get("error-unauthorized-expired-token");
  assert.ok(noAuth && expired, "both 401 samples must exist");
  assert.equal(noAuth.response.status, 401);
  assert.equal(expired.response.status, 401);
  assert.equal(noAuth.response.body.error.code, "unauthorized");
  assert.equal(expired.response.body.error.code, "unauthorized");

  // Cross-account isolation: another account's data is 404, not 403.
  const crossResource = byId.get("error-cross-account-resource");
  const crossProgress = byId.get("error-cross-account-progress");
  assert.ok(crossResource && crossProgress, "cross-account samples must exist");
  assert.equal(crossResource.response.status, 404, "cross-account reads are 404");
  assert.equal(crossProgress.response.status, 404, "cross-account progress writes are 404");

  // Stale progress write: 409 plus the current version.
  const conflict = byId.get("error-progress-conflict");
  assert.ok(conflict, "progress conflict sample must exist");
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.response.body.error.code, "progress_revision_conflict");
  assertProgress(conflict.response.body.current, `${conflict.id}: current`);

  // Conflict chain: expectedRevision is behind, current matches the latest
  // successful write in api-examples.json.
  const apiSamples = loadExamples("api-examples.json");
  const update = apiSamples.samples.find((e) => e.id === "api-progress-update");
  assert.deepEqual(
    conflict.response.body.current,
    { positionMs: update.response.body.positionMs, revision: update.response.body.revision },
    "the conflict current block matches the latest successful write",
  );
  assert.equal(conflict.request.body.expectedRevision, 1, "the stale write expected revision 1");
});

// --- contract documents -----------------------------------------------------

// The three contract documents are deliverables referenced by the
// implementation tickets. The presence checks guard against fixtures
// drifting away from the documents: endpoint, platform and decision
// anchors must stay listed in the docs.
const CONTRACT_ROOT = __dirname;

function readDoc(name) {
  return fs.readFileSync(path.join(CONTRACT_ROOT, name), "utf8");
}

test("contract documents exist and list the contract anchors", () => {
  const contract = readDoc("contract-v1.md");
  for (const endpoint of SIX_ENDPOINTS) {
    assert.ok(contract.includes(endpoint), `contract-v1.md must list ${endpoint}`);
  }
  for (const structure of ["Resource", "Source", "positionMs", "revision", "Note", "clientRequestId"]) {
    assert.ok(contract.includes(structure), `contract-v1.md must define ${structure}`);
  }

  const rules = readDoc("platform-video-id-rules.md");
  for (const platform of PLATFORMS) {
    assert.ok(rules.includes(platform), `platform-video-id-rules.md must cover ${platform}`);
  }
  for (const token of ["p_", "v_", "a_", "i_", "l_", "term_", "BV", "v=", "note id"]) {
    assert.ok(rules.includes(token), `platform-video-id-rules.md must cover ${token}`);
  }

  const decisions = readDoc("decisions.md");
  assert.ok(decisions.includes("Session"), "decisions.md must record the Session deferral");
});

test("every /v1 endpoint has at least one failure sample", () => {
  const fixture = loadExamples("error-examples.json");
  const templates = new Set(fixture.samples.map((e) => e._template));
  for (const endpoint of SIX_ENDPOINTS) {
    assert.ok(templates.has(endpoint), `error-examples.json: no failure sample covers ${endpoint}`);
  }
});
