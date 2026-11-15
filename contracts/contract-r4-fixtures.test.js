/**
 * Round-4 contract fixtures validation (Ticket 6.1, issue #86).
 *
 * Seam: the same discipline as rounds 1–3 — the JSON fixtures under
 * contracts/fixtures/ are the shared samples the Web, extension and API
 * implementation tickets reference directly. Round 4 adds the site
 * capability registry (contract-r4.md, decisions D19–D20): the
 * server-side {platformId, captions, asr, enabled} rows every logged-in
 * user reads, the admin surface (Bearer + isAdmin) that flips boolean
 * subsets per row, and the account.isAdmin marker surfaced by GET /v1/me.
 *
 * Round-1/2/3 fixtures and samples are untouched; the round-4 error
 * samples are appended to error-examples.json and validated there by the
 * round-1 suite's envelope checks plus the round-4 pins below.
 *
 * The test validates structure and cross-sample consistency. It does NOT
 * re-derive seeding behavior — the three ends consume these fixtures as
 * their expected values.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CONTRACT_ROOT = __dirname;

const CONTRACT_MARKER = "learning-digest-contracts/v1";

const ACCOUNT_ID = /^acc_[0-9A-Za-z]+$/;

// The seeded platforms and their defaults (contract-r4.md §2, D20).
const SEEDED_DEFAULTS = {
  bilibili: { captions: true, asr: true, enabled: true },
  youtube: { captions: true, asr: true, enabled: true },
  xiaoe: { captions: false, asr: true, enabled: true },
  xiaohongshu: { captions: false, asr: true, enabled: true },
};

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

function loadExamples(name) {
  const fixture = loadFixture(name);
  assert.equal(
    fixture.$contract,
    CONTRACT_MARKER,
    `${name}: samples must declare the contract marker`,
  );
  assert.ok(Array.isArray(fixture.samples) && fixture.samples.length > 0, `${name}: samples[] must be non-empty`);
  return fixture;
}

function sampleById(samples, id) {
  const sample = samples.find((s) => s.id === id);
  assert.ok(sample, `required sample missing: ${id}`);
  return sample;
}

// --- structures (contract-r4.md §2) --------------------------------------------

function assertCapabilityRow(row, where) {
  assert.ok(row && typeof row === "object", `${where}: capability row must be an object`);
  assert.equal(typeof row.platformId, "string", `${where}: platformId is a string`);
  assert.ok(row.platformId.length > 0, `${where}: platformId is non-empty`);
  for (const field of ["captions", "asr", "enabled"]) {
    assert.equal(typeof row[field], "boolean", `${where}: ${field} is a boolean`);
  }
  assert.deepEqual(
    Object.keys(row).sort(),
    ["asr", "captions", "enabled", "platformId"],
    `${where}: the row carries exactly {platformId, captions, asr, enabled}`,
  );
}

function assertCapabilityTable(body, where) {
  assert.ok(body && typeof body === "object", `${where}: response body must be an object`);
  assert.ok(Array.isArray(body.capabilities), `${where}: the table carries capabilities[]`);
  for (const row of body.capabilities) {
    assertCapabilityRow(row, `${where}: capabilities[]`);
  }
}

// --- site-capability-examples.json ------------------------------------------------

test("site capability fixtures parse and declare the contract", () => {
  const fixture = loadExamples("site-capability-examples.json");
  const ids = fixture.samples.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate sample ids in site-capability-examples.json");
  for (const sample of fixture.samples) {
    assert.equal(typeof sample.description, "string", `${sample.id}: needs a description`);
    assert.ok(sample.endpoint && typeof sample.endpoint === "object", `${sample.id}: needs endpoint{}`);
    assert.ok(sample.response && typeof sample.response === "object", `${sample.id}: needs response{}`);
    assert.ok(Number.isInteger(sample.response.status), `${sample.id}: response.status is an integer`);
    assert.ok(
      sample.response.status >= 200 && sample.response.status < 300,
      `${sample.id}: site-capability-examples carry success responses`,
    );
  }
});

test("site capability fixtures conform to the round-4 structures", () => {
  const { samples } = loadExamples("site-capability-examples.json");
  for (const sample of samples) {
    const body = sample.response.body;
    if (sample.id === "api-me-admin-flag") {
      assert.equal(sample.response.status, 200, `${sample.id}: me returns 200`);
      assert.ok(body.account && typeof body.account === "object", `${sample.id}: me carries account{}`);
      assert.match(body.account.id, ACCOUNT_ID, `${sample.id}: account.id keeps the acc_ series`);
      assert.equal(typeof body.account.email, "string", `${sample.id}: account.email is a string`);
      assert.equal(typeof body.account.isAdmin, "boolean", `${sample.id}: account.isAdmin is a boolean`);
    } else {
      assert.equal(sample.response.status, 200, `${sample.id}: capability reads and updates return 200`);
      if (sample.id.startsWith("api-admin-site-capability-update")) {
        assertCapabilityRow(body.capability, `${sample.id}: capability`);
      } else {
        assertCapabilityTable(body, `${sample.id}`);
      }
    }
  }
});

// --- cross-sample consistency --------------------------------------------------------

test("the sampled table is the seeded defaults and the PUT moves only its subset", () => {
  const { samples } = loadExamples("site-capability-examples.json");

  // Both GET samples show the seeded table in seed order (no admin edit
  // yet, so both ends agree on one table).
  const table = sampleById(samples, "api-site-capabilities-list").response.body.capabilities;
  const adminTable = sampleById(samples, "api-admin-site-capabilities-list").response.body.capabilities;
  assert.deepEqual(
    table.map((row) => row.platformId),
    Object.keys(SEEDED_DEFAULTS),
    "the table lists the seeded platforms in seed order",
  );
  assert.deepEqual(table, adminTable, "the admin GET samples the same table as the user GET");
  for (const row of table) {
    assert.deepEqual(
      { captions: row.captions, asr: row.asr, enabled: row.enabled },
      SEEDED_DEFAULTS[row.platformId],
      `${row.platformId}: the sampled row matches the seed defaults`,
    );
  }

  // The PUT sample flips exactly its subset: everything unmentioned keeps
  // the seeded value (D20 subset semantics).
  const update = sampleById(samples, "api-admin-site-capability-update");
  const patch = update.request.body;
  assert.ok(patch && typeof patch === "object", "the PUT sample carries a body{");
  const patchedKeys = Object.keys(patch);
  assert.ok(patchedKeys.length > 0, "the PUT sample demonstrates a non-empty subset");
  for (const key of patchedKeys) {
    assert.equal(typeof patch[key], "boolean", `PUT body ${key} is a boolean`);
    assert.ok(key in SEEDED_DEFAULTS.bilibili, `PUT body ${key} is one of captions/asr/enabled`);
  }
  const row = update.response.body.capability;
  assert.equal(row.platformId, "bilibili", "the PUT sample targets the bilibili row");
  for (const field of ["captions", "asr", "enabled"]) {
    const expected = field in patch ? patch[field] : SEEDED_DEFAULTS.bilibili[field];
    assert.equal(row[field], expected, `${field}: ${field in patch ? "patched" : "kept from the seed"}`);
  }
  // The sampled edit actually changes something, and the unchanged table
  // stays consistent with it elsewhere.
  assert.notDeepEqual(
    { captions: row.captions, asr: row.asr, enabled: row.enabled },
    SEEDED_DEFAULTS.bilibili,
    "the PUT sample demonstrates a real change",
  );
});

// --- round-4 endpoint surface --------------------------------------------------

// The round-4 templates. contract-fixtures.test.js remains the authority for
// classifying every /v1 sample onto the surface; this list pins which
// endpoints round 4 adds and that each carries success AND failure samples.
const ROUND4_ENDPOINTS = [
  "GET /v1/site-capabilities",
  "GET /v1/admin/site-capabilities",
  "PUT /v1/admin/site-capabilities/{platformId}",
];

function endpointOf(sample) {
  const { method, path } = sample.endpoint;
  const segs = path.split("/").filter(Boolean);
  if (method === "GET" && segs.join("/") === "v1/site-capabilities") {
    return "GET /v1/site-capabilities";
  }
  if (method === "GET" && segs.join("/") === "v1/admin/site-capabilities") {
    return "GET /v1/admin/site-capabilities";
  }
  if (method === "PUT" && segs.length === 4 && segs[1] === "admin" && segs[2] === "site-capabilities") {
    return "PUT /v1/admin/site-capabilities/{platformId}";
  }
  return `${method} ${path}`;
}

test("every round-4 endpoint has a success and a failure sample", () => {
  const successTemplates = new Set(loadExamples("site-capability-examples.json").samples.map(endpointOf));
  const errorSamples = loadExamples("error-examples.json").samples;
  const failureTemplates = new Set(errorSamples.map(endpointOf));

  for (const endpoint of ROUND4_ENDPOINTS) {
    assert.ok(successTemplates.has(endpoint), `no success sample covers ${endpoint}`);
    assert.ok(failureTemplates.has(endpoint), `no failure sample covers ${endpoint}`);
  }
  // The admin marker rides on the round-1 me endpoint; its sample pins the
  // appended key.
  assert.ok(successTemplates.has("GET /v1/me"), "the me sample sits on GET /v1/me");
});

// --- round-4 error pins ------------------------------------------------------------

test("round-4 error samples pin the admin guard, isolation and validation behaviors", () => {
  const errorSamples = loadExamples("error-examples.json").samples;
  const byId = new Map(errorSamples.map((e) => [e.id, e]));

  const expected = [
    // 401: reading the table needs a credential (user and admin alike).
    ["error-site-capabilities-unauthorized", "GET /v1/site-capabilities", 401, "unauthorized"],
    // D2 on the admin surface: an authenticated non-admin gets the same
    // 404 an unknown path gets — no endpoint-existence leak (D19).
    ["error-admin-site-capabilities-not-admin", "GET /v1/admin/site-capabilities", 404, "not_found"],
    // Unknown platform: only seeded rows are administrable (D20).
    ["error-admin-site-capability-unknown-platform", "PUT /v1/admin/site-capabilities/{platformId}", 404, "not_found"],
    // 400 family: non-boolean value, field outside the subset, non-object body.
    ["error-admin-site-capability-invalid-field", "PUT /v1/admin/site-capabilities/{platformId}", 400, "validation_failed"],
    ["error-admin-site-capability-unknown-field", "PUT /v1/admin/site-capabilities/{platformId}", 400, "validation_failed"],
    ["error-admin-site-capability-body-not-object", "PUT /v1/admin/site-capabilities/{platformId}", 400, "validation_failed"],
  ];

  for (const [id, template, status, code] of expected) {
    const sample = byId.get(id);
    assert.ok(sample, `required round-4 error sample missing: ${id}`);
    assert.equal(endpointOf(sample), template, `${id}: sits on ${template}`);
    assert.equal(sample.response.status, status, `${id}: status is ${status}`);
    assert.equal(sample.response.body.error.code, code, `${id}: error.code is ${code}`);
    assert.equal(typeof sample.response.body.error.message, "string", `${id}: error.message is a string`);
  }

  // The unknown-platform sample targets a platform outside the seed; the
  // validation samples target a seeded platform.
  assert.equal(
    byId.get("error-admin-site-capability-unknown-platform").endpoint.path,
    "/v1/admin/site-capabilities/douyin",
    "unknown platform targets an unseeded platformId",
  );
  for (const id of ["error-admin-site-capability-invalid-field", "error-admin-site-capability-unknown-field", "error-admin-site-capability-body-not-object"]) {
    assert.equal(
      byId.get(id).endpoint.path,
      "/v1/admin/site-capabilities/bilibili",
      `${id}: validation samples target the seeded bilibili row`,
    );
  }
});

// --- contract documents --------------------------------------------------------------

test("contract-r4.md and decisions.md list the round-4 anchors", () => {
  function readDoc(relativePath) {
    return fs.readFileSync(path.join(CONTRACT_ROOT, relativePath), "utf8");
  }

  const r4 = readDoc("contract-r4.md");
  for (const endpoint of ROUND4_ENDPOINTS) {
    assert.ok(r4.includes(endpoint), `contract-r4.md must list ${endpoint}`);
  }
  assert.ok(r4.includes("GET /v1/me"), "contract-r4.md must reference GET /v1/me");
  for (const token of [
    "SiteCapability", "platformId", "captions", "asr", "enabled", "isAdmin",
    "validation_failed", "not_found", "unauthorized",
    "任意布尔子集", "未知 platformId", "不透露端点存在性", "只补缺失行",
    "bilibili", "youtube", "xiaoe", "xiaohongshu",
  ]) {
    assert.ok(r4.includes(token), `contract-r4.md must define ${token}`);
  }

  const decisions = readDoc("decisions.md");
  for (const d of ["D19", "D20"]) {
    assert.ok(decisions.includes(`${d} ·`), `decisions.md must record ${d}`);
  }
  for (const token of ["邀请即标记", "isAdmin", "404", "siteCapabilities", "任意布尔子集", "只补缺失行", "不创建平台"]) {
    assert.ok(decisions.includes(token), `decisions.md must cover ${token}`);
  }
});

// --- round-4 fixtures leave rounds 1–3 untouched -------------------------------------

test("rounds 1-3 fixture samples are unchanged by round 4 (append-only)", () => {
  // Round-4's only edits to existing fixture files are APPENDED error
  // samples; their ids live in the error-*site-capability* namespace and
  // the pre-existing ids stay exactly as the earlier rounds pinned them
  // (those suites keep passing — this pins the sample count they see).
  const errors = loadExamples("error-examples.json").samples;
  const round4Errors = errors.filter((e) => e.id.startsWith("error-") && (e.id.includes("site-capabilit")));
  assert.equal(round4Errors.length, 6, "round 4 appends exactly six error samples");
  const preExisting = errors.length - round4Errors.length;
  assert.equal(preExisting, 27, "rounds 1-3 keep their 27 error samples");
});
