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
  // Panel addition (contract-r4.md §6, ticket #89): the rolling-summary
  // tick and the overview read.
  if (method === "POST" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "rolling-summary") {
    return "POST /v1/sessions/{id}/rolling-summary";
  }
  if (method === "GET" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "overview") {
    return "GET /v1/sessions/{id}/overview";
  }
  if (method === "GET" && segs.join("/") === "v1/usage") return "GET /v1/usage";
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
  // The panel addition (ticket #89) appends its own error-* namespace the
  // same way; rounds 1-3 still keep their 27 samples untouched.
  const errors = loadExamples("error-examples.json").samples;
  const round4Errors = errors.filter((e) => e.id.startsWith("error-") && (e.id.includes("site-capabilit")));
  assert.equal(round4Errors.length, 6, "round 4 appends exactly six error samples");
  const panelErrors = errors.filter(
    (e) => e.id.includes("rolling-summary") || e.id.includes("overview"),
  );
  assert.equal(panelErrors.length, 7, "the panel round appends exactly seven error samples");
  const preExisting = errors.length - round4Errors.length - panelErrors.length;
  assert.equal(preExisting, 27, "rounds 1-3 keep their 27 error samples");
});

// --- panel addition: rolling summary + overview (ticket #89) -----------------

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const PANEL_ENDPOINTS = [
  "POST /v1/sessions/{id}/rolling-summary",
  "GET /v1/sessions/{id}/overview",
];

function assertTopic(topic, where) {
  assert.ok(topic && typeof topic === "object", `${where}: topic must be an object`);
  const keys = Object.keys(topic).sort();
  const base = JSON.stringify(["endMs", "index", "startMs", "text", "title"]);
  const withContinuation = JSON.stringify(["continuation", "endMs", "index", "startMs", "text", "title"]);
  assert.ok(
    JSON.stringify(keys) === base || JSON.stringify(keys) === withContinuation,
    `${where}: a topic carries exactly {index, startMs, endMs, title, text[, continuation]}`,
  );
  assert.ok(Number.isInteger(topic.index) && topic.index >= 1, `${where}: index is a 1-based integer`);
  assert.ok(Number.isInteger(topic.startMs) && topic.startMs >= 0, `${where}: startMs is a non-negative integer`);
  assert.ok(Number.isInteger(topic.endMs) && topic.endMs >= topic.startMs, `${where}: endMs >= startMs (source-timeline ms)`);
  for (const field of ["title", "text"]) {
    assert.equal(typeof topic[field], "string", `${where}: ${field} is a string`);
    assert.ok(topic[field].length > 0, `${where}: ${field} is non-empty`);
  }
  if ("continuation" in topic) {
    assert.equal(topic.continuation, true, `${where}: continuation survives only as true`);
  }
}

function assertOverviewBody(body, where) {
  assert.ok(body && typeof body === "object", `${where}: response body must be an object`);
  const overview = body.overview;
  assert.ok(overview && typeof overview === "object", `${where}: carries overview{}`);
  assert.deepEqual(
    Object.keys(overview).sort(),
    ["generatedAt", "generation", "lastCoveredMs", "sessionId", "topics"],
    `${where}: the overview carries exactly {sessionId, topics, lastCoveredMs, generation, generatedAt}`,
  );
  assert.equal(typeof overview.sessionId, "string", `${where}: sessionId is a string`);
  assert.ok(Array.isArray(overview.topics) && overview.topics.length > 0, `${where}: topics is a non-empty array`);
  overview.topics.forEach((topic, index) => {
    assertTopic(topic, `${where}: topics[${index}]`);
    // The numbering is 1..N in timeline order and continues across ticks.
    assert.equal(topic.index, index + 1, `${where}: topics are numbered 1..N in timeline order`);
  });
  // The coverage cursor is the last Topic's end (the next tick starts here).
  assert.equal(
    overview.lastCoveredMs,
    Math.max(...overview.topics.map((topic) => topic.endMs)),
    `${where}: lastCoveredMs is the last Topic's end`,
  );
  const generation = overview.generation;
  assert.ok(generation && typeof generation === "object", `${where}: carries generation{}`);
  assert.deepEqual(
    Object.keys(generation).sort(),
    ["inputChars", "model", "provider"],
    `${where}: generation mirrors the contract-r3 §2.3 shape`,
  );
  assert.equal(typeof generation.provider, "string", `${where}: generation.provider is a string`);
  assert.equal(typeof generation.model, "string", `${where}: generation.model is a string`);
  assert.ok(Number.isInteger(generation.inputChars) && generation.inputChars >= 0, `${where}: generation.inputChars is a non-negative integer`);
  assert.match(overview.generatedAt, ISO_TIMESTAMP, `${where}: generatedAt is ISO 8601 UTC`);
}

test("panel fixtures parse and declare the contract", () => {
  const fixture = loadExamples("session-overview-examples.json");
  const ids = fixture.samples.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate sample ids in session-overview-examples.json");
  for (const sample of fixture.samples) {
    assert.equal(typeof sample.description, "string", `${sample.id}: needs a description`);
    assert.ok(sample.endpoint && typeof sample.endpoint === "object", `${sample.id}: needs endpoint{}`);
    assert.ok(sample.response && typeof sample.response === "object", `${sample.id}: needs response{}`);
    assert.ok(Number.isInteger(sample.response.status), `${sample.id}: response.status is an integer`);
    assert.ok(
      sample.response.status >= 200 && sample.response.status < 300,
      `${sample.id}: session-overview-examples carry success responses`,
    );
  }
});

test("panel fixtures conform to the SessionOverview and Usage structures", () => {
  const { samples } = loadExamples("session-overview-examples.json");
  for (const sample of samples) {
    if (sample.id === "api-usage-with-rolling-summary") {
      const usage = sample.response.body;
      assert.equal(sample.response.status, 200, `${sample.id}: usage returns 200`);
      assert.deepEqual(
        Object.keys(usage).sort(),
        ["audioSeconds", "rollingSummaryCount", "rollingSummaryInputChars", "summaryCount", "summaryInputChars", "updatedAt"],
        `${sample.id}: the Usage extends the r3 keys with the rolling pair (contract-r4 §6.3)`,
      );
      for (const key of ["audioSeconds", "summaryCount", "summaryInputChars", "rollingSummaryCount", "rollingSummaryInputChars"]) {
        assert.ok(Number.isInteger(usage[key]) && usage[key] >= 0, `${sample.id}: ${key} is a non-negative integer`);
      }
      assert.ok(usage.rollingSummaryCount >= 1, `${sample.id}: the sample demonstrates landed ticks`);
      assert.match(usage.updatedAt, ISO_TIMESTAMP, `${sample.id}: updatedAt is ISO 8601 UTC`);
    } else {
      assertOverviewBody(sample.response.body, sample.id);
    }
  }
});

test("the sampled timeline is append-only across the tick samples", () => {
  const byId = new Map(loadExamples("session-overview-examples.json").samples.map((s) => [s.id, s]));
  const first = byId.get("api-rolling-summary-generate").response.body.overview;
  const appended = byId.get("api-rolling-summary-append").response.body.overview;
  const replay = byId.get("api-rolling-summary-replay").response.body.overview;
  const read = byId.get("api-session-overview").response.body.overview;

  // ADR 0002: the append keeps the earlier Topics untouched and continues
  // the numbering; the first new Topic continues the previous batch.
  assert.deepEqual(
    appended.topics.slice(0, first.topics.length),
    first.topics,
    "the append keeps the earlier Topics byte-identical",
  );
  assert.equal(
    appended.topics[first.topics.length].continuation,
    true,
    "the first appended Topic carries the continuation flag",
  );
  assert.ok(appended.lastCoveredMs > first.lastCoveredMs, "the cursor advanced with the append");

  // The replay and the GET serve the stored overview unchanged (the
  // replay re-lands nothing — same generatedAt, same topics).
  assert.deepEqual(replay, appended, "the replay returns the current overview as-is");
  assert.deepEqual(read, appended, "GET /overview serves the same stored document");
});

test("every panel endpoint has a success and a failure sample", () => {
  const successTemplates = new Set(loadExamples("session-overview-examples.json").samples.map(endpointOf));
  const errorSamples = loadExamples("error-examples.json").samples;
  const failureTemplates = new Set(errorSamples.map(endpointOf));

  for (const endpoint of PANEL_ENDPOINTS) {
    assert.ok(successTemplates.has(endpoint), `no success sample covers ${endpoint}`);
    assert.ok(failureTemplates.has(endpoint), `no failure sample covers ${endpoint}`);
  }
  // The usage extension rides on the round-3 usage endpoint; its sample
  // pins the appended keys.
  assert.ok(successTemplates.has("GET /v1/usage"), "the usage-extension sample sits on GET /v1/usage");
});

test("panel error samples pin the tick and overview failure behaviors", () => {
  const errorSamples = loadExamples("error-examples.json").samples;
  const byId = new Map(errorSamples.map((e) => [e.id, e]));

  const expected = [
    // 401: both endpoints need a credential.
    ["error-rolling-summary-unauthorized", "POST /v1/sessions/{id}/rolling-summary", 401, "unauthorized"],
    ["error-overview-unauthorized", "GET /v1/sessions/{id}/overview", 401, "unauthorized"],
    // D2 isolation: another account's session is the same 404.
    ["error-rolling-summary-cross-account", "POST /v1/sessions/{id}/rolling-summary", 404, "not_found"],
    ["error-overview-cross-account", "GET /v1/sessions/{id}/overview", 404, "not_found"],
    // No archived records: the tick refuses before any AI call.
    ["error-rolling-summary-no-transcript", "POST /v1/sessions/{id}/rolling-summary", 409, "no_session_transcript_to_summarize"],
    // Provider failure: 502, nothing landed.
    ["error-rolling-summary-failed", "POST /v1/sessions/{id}/rolling-summary", 502, "rolling_summary_failed"],
    // A session that never generated an overview.
    ["error-overview-not-generated", "GET /v1/sessions/{id}/overview", 404, "overview_not_generated"],
  ];

  for (const [id, template, status, code] of expected) {
    const sample = byId.get(id);
    assert.ok(sample, `required panel error sample missing: ${id}`);
    assert.equal(endpointOf(sample), template, `${id}: sits on ${template}`);
    assert.equal(sample.response.status, status, `${id}: status is ${status}`);
    assert.equal(sample.response.body.error.code, code, `${id}: error.code is ${code}`);
    assert.equal(typeof sample.response.body.error.message, "string", `${id}: error.message is a string`);
  }

  // The no-transcript sample targets the story's never-archived session;
  // the failure sample targets the story's resource-bearing session.
  assert.equal(
    byId.get("error-rolling-summary-no-transcript").endpoint.path,
    "/v1/sessions/ses_01JABC0035/rolling-summary",
    "the no-transcript sample targets a session without archived records",
  );
});

test("contract-r4.md §6 and decisions.md record the panel anchors", () => {
  function readDoc(relativePath) {
    return fs.readFileSync(path.join(CONTRACT_ROOT, relativePath), "utf8");
  }

  const r4 = readDoc("contract-r4.md");
  for (const endpoint of PANEL_ENDPOINTS) {
    assert.ok(r4.includes(endpoint), `contract-r4.md must list ${endpoint}`);
  }
  for (const token of [
    "SessionOverview", "lastCoveredMs", "sessionInsights", "continuation",
    "rollingSummaryCount", "rollingSummaryInputChars",
    "no_session_transcript_to_summarize", "rolling_summary_failed", "overview_not_generated",
    "topic-tick.md", "append-only", "幂等回放", "防抖", "inputChars",
  ]) {
    assert.ok(r4.includes(token), `contract-r4.md must define ${token}`);
  }

  const decisions = readDoc("decisions.md");
  assert.ok(decisions.includes("D21 ·"), "decisions.md must record D21");
  for (const token of ["幂等", "append-only", "rollingSummaryCount", "sessionInsights"]) {
    assert.ok(decisions.includes(token), `decisions.md must cover ${token}`);
  }
});
