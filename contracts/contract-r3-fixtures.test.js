/**
 * Round-3 contract fixtures validation (Ticket 3.1, issue #73).
 *
 * Seam: the same discipline as contract-fixtures.test.js and
 * contract-r2-fixtures.test.js — the JSON fixtures under contracts/fixtures/
 * are the shared samples the Web, extension and API implementation tickets
 * reference directly. Round 3 adds the course-summary and usage surface
 * (contract-r3.md, decisions D16–D18): user-initiated summary generation
 * (always a new record, synchronous, failure leaves no dirty data), the
 * history list, the summary detail with citation anchors back into the
 * archived transcripts, and the account-level usage aggregate.
 *
 * Round-1/2 fixtures and samples are untouched; the round-3 error samples
 * are appended to error-examples.json and validated there by the round-1
 * suite's envelope checks plus the round-3 pins below.
 *
 * The test validates structure and cross-sample consistency. It does NOT
 * re-derive generation behavior — the three ends consume these fixtures as
 * their expected values.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CONTRACT_ROOT = __dirname;

const CONTRACT_MARKER = "learning-digest-contracts/v1";

// Shared id prefixes. Like rounds 1–2, prefixes are fixture-reading aids,
// not implementation requirements.
const SUMMARY_ID = /^sum_[0-9A-Za-z]+$/;
const SESSION_ID = /^ses_[0-9A-Za-z]+$/;
const RESOURCE_ID = /^res_[0-9A-Za-z]+$/;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// The shared story's resource (B 站 P2, res_01JABC0001) and its sessions.
const STORY_RESOURCE = "res_01JABC0001";
const CATCH_UP_SESSION = "ses_01JABC0034";

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

function assertIsoTimestamp(value, where) {
  assert.equal(typeof value, "string", `${where}: timestamps are ISO 8601 strings`);
  assert.match(value, ISO_TIMESTAMP, `${where}: timestamp ${value} must be ISO 8601 UTC`);
}

function assertIntAtLeast(value, min, where, label) {
  assert.ok(Number.isInteger(value) && value >= min, `${where}: ${label} must be an integer >= ${min}`);
}

// --- structures (contract-r3.md §2) --------------------------------------------

function assertGeneration(gen, where) {
  assert.ok(gen && typeof gen === "object", `${where}: generation metadata must be an object`);
  assert.equal(typeof gen.provider, "string", `${where}: generation.provider is a string`);
  assert.ok(gen.provider.length > 0, `${where}: generation.provider is non-empty`);
  assert.equal(typeof gen.model, "string", `${where}: generation.model is a string`);
  assert.ok(gen.model.length > 0, `${where}: generation.model is non-empty`);
  assertIntAtLeast(gen.inputChars, 0, where, "generation.inputChars");
}

function assertCitation(citation, where) {
  assert.ok(citation && typeof citation === "object", `${where}: citation must be an object`);
  assert.equal(typeof citation.quote, "string", `${where}: citation.quote is a string`);
  assert.ok(citation.quote.length > 0, `${where}: citation.quote is non-empty`);
  const ref = citation.segmentRef;
  assert.ok(ref && typeof ref === "object", `${where}: citation.segmentRef must be an object`);
  assert.match(ref.sessionId, SESSION_ID, `${where}: segmentRef.sessionId uses the ses_ prefix`);
  assertIntAtLeast(ref.startMs, 0, where, "segmentRef.startMs");
  assert.ok(
    Number.isInteger(ref.endMs) && ref.endMs > ref.startMs,
    `${where}: segmentRef.endMs must be an integer > startMs`,
  );
}

function assertSummary(summary, where) {
  assert.ok(summary && typeof summary === "object", `${where}: summary must be an object`);
  assert.match(summary.id, SUMMARY_ID, `${where}: fixture summary ids use the sum_ prefix`);
  assert.match(summary.resourceId, RESOURCE_ID, `${where}: summary.resourceId uses the res_ prefix`);
  assert.equal(typeof summary.content, "string", `${where}: summary.content is a string`);
  assert.ok(summary.content.length > 0, `${where}: summary.content is non-empty Markdown`);
  assert.ok(Array.isArray(summary.citations), `${where}: summary.citations is an array`);
  for (const citation of summary.citations) {
    assertCitation(citation, `${where}: citations[]`);
  }
  assertGeneration(summary.generation, `${where}: generation`);
  assertIsoTimestamp(summary.generatedAt, `${where}: summary.generatedAt`);
}

function assertSummaryListItem(item, where) {
  assert.ok(item && typeof item === "object", `${where}: list item must be an object`);
  assert.match(item.id, SUMMARY_ID, `${where}: list item id uses the sum_ prefix`);
  assert.match(item.resourceId, RESOURCE_ID, `${where}: list item resourceId uses the res_ prefix`);
  assertIsoTimestamp(item.generatedAt, `${where}: list item generatedAt`);
  assertGeneration(item.generation, `${where}: list item generation`);
  assertIntAtLeast(item.citationCount, 0, where, "citationCount");
}

function assertUsage(usage, where) {
  assert.ok(usage && typeof usage === "object", `${where}: usage must be an object`);
  for (const key of ["audioSeconds", "summaryCount", "summaryInputChars"]) {
    assertIntAtLeast(usage[key], 0, where, key);
  }
  assertIsoTimestamp(usage.updatedAt, `${where}: usage.updatedAt`);
}

// --- summary-examples.json -------------------------------------------------------

test("summary fixtures parse and declare the contract", () => {
  const fixture = loadExamples("summary-examples.json");
  const ids = fixture.samples.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate sample ids in summary-examples.json");
  for (const sample of fixture.samples) {
    assert.equal(typeof sample.description, "string", `${sample.id}: needs a description`);
    assert.ok(sample.endpoint && typeof sample.endpoint === "object", `${sample.id}: needs endpoint{}`);
    assert.ok(sample.response && typeof sample.response === "object", `${sample.id}: needs response{}`);
    assert.ok(Number.isInteger(sample.response.status), `${sample.id}: response.status is an integer`);
    assert.ok(sample.response.status >= 200 && sample.response.status < 300, `${sample.id}: summary-examples carry success responses`);
  }
});

test("summary fixtures conform to the round-3 structures", () => {
  const { samples } = loadExamples("summary-examples.json");
  for (const sample of samples) {
    const body = sample.response.body;
    assert.ok(body && typeof body === "object", `${sample.id}: response.body must be an object`);

    if (sample.id.startsWith("api-summary-generate")) {
      assert.equal(sample.response.status, 201, `${sample.id}: generation always creates a new record (201)`);
      assertSummary(body.summary, `${sample.id}: summary`);
      assert.deepEqual(sample.request?.body, {}, `${sample.id}: the generation request body is the empty object`);
    } else if (sample.id === "api-summary-detail") {
      assert.equal(sample.response.status, 200, `${sample.id}: detail returns 200`);
      assertSummary(body.summary, `${sample.id}: summary`);
    } else if (sample.id.startsWith("api-summaries-list")) {
      assert.equal(sample.response.status, 200, `${sample.id}: list returns 200`);
      assert.ok(Array.isArray(body.summaries), `${sample.id}: list carries summaries[]`);
      for (const item of body.summaries) {
        assertSummaryListItem(item, `${sample.id}: summaries[]`);
      }
    } else if (sample.id === "api-usage") {
      assert.equal(sample.response.status, 200, `${sample.id}: usage returns 200`);
      assertUsage(body, `${sample.id}`);
    } else if (sample.id.startsWith("api-session-transcript-catch-up")) {
      // The catch-up anchor: a round-2 endpoint sampled for the round-3 story.
      assert.equal(body.sessionId, CATCH_UP_SESSION, `${sample.id}: anchors the catch-up session`);
      assert.equal(body.sessionStatus, "finished", `${sample.id}: the catch-up session is archived`);
      assert.equal(body.origin, "asr", `${sample.id}: the catch-up session is an asr session`);
      assert.ok(Array.isArray(body.records) && body.records.length > 0, `${sample.id}: carries the new material`);
    }
  }
});

// --- the shared round-3 story ------------------------------------------------------
//
// summary-examples.json continues rounds 1–2 on res_01JABC0001: the first
// generation reads the archived material of ses_31/32/33 (pinned by the r2
// poll samples), the catch-up session ses_34 adds one record, the second
// generation covers it. Citations must resolve against real archived
// records so the Web can use them as lookup anchors (contract-r3.md §2.2).

function sampleById(samples, id) {
  const sample = samples.find((s) => s.id === id);
  assert.ok(sample, `required sample missing: ${id}`);
  return sample;
}

// The archived-record pool of the shared story, per session, from the poll
// samples pinned by rounds 2 and 3.
function transcriptPool() {
  const polls = [
    ["api-session-transcript-captions-finished", "session-examples.json"],
    ["api-session-transcript-asr-finished", "session-examples.json"],
    ["api-session-transcript-asr-active", "session-examples.json"],
    ["api-session-transcript-catch-up-finished", "summary-examples.json"],
  ];
  const pool = new Map();
  for (const [id, file] of polls) {
    const view = sampleById(loadExamples(file).samples, id).response.body;
    pool.set(view.sessionId, view.records);
  }
  return pool;
}

// Every citation resolves to a real archived record in the pool, its quote
// is a verbatim excerpt of that record's text, and citations are ordered by
// source-timeline startMs. Returns the set of cited sessions.
function assertCitationsResolve(citations, pool, where) {
  let lastStartMs = -1;
  const citedSessions = new Set();
  for (const citation of citations) {
    const ref = citation.segmentRef;
    const records = pool.get(ref.sessionId);
    assert.ok(records, `${where}: citation sessionId ${ref.sessionId} is one of the resource's sessions`);
    const record = records.find((r) => r.startMs === ref.startMs && r.endMs === ref.endMs);
    assert.ok(record, `${where}: segmentRef ${ref.sessionId} ${ref.startMs}-${ref.endMs} matches an archived record`);
    assert.ok(
      record.text.includes(citation.quote),
      `${where}: quote "${citation.quote}" is a verbatim excerpt of the referenced record`,
    );
    assert.ok(
      ref.startMs >= lastStartMs,
      `${where}: citations are ordered by source-timeline startMs ascending`,
    );
    lastStartMs = ref.startMs;
    citedSessions.add(ref.sessionId);
  }
  return citedSessions;
}

test("summaries cite real archived records and the regeneration covers new material", () => {
  const summarySamples = loadExamples("summary-examples.json").samples;
  const pool = transcriptPool();
  const poolBeforeCatchUp = new Map([...pool].filter(([sessionId]) => sessionId !== CATCH_UP_SESSION));

  const gen1 = sampleById(summarySamples, "api-summary-generate-bilibili").response.body.summary;
  const gen2 = sampleById(summarySamples, "api-summary-generate-after-catch-up").response.body.summary;

  const sessions1 = assertCitationsResolve(gen1.citations, poolBeforeCatchUp, "first generation");
  assert.ok(sessions1.size >= 2, "the first generation cites material from multiple sessions (spec #49)");
  assert.ok(!sessions1.has(CATCH_UP_SESSION), "the first generation predates the catch-up session");

  const sessions2 = assertCitationsResolve(gen2.citations, pool, "second generation");
  assert.ok(sessions2.size >= 2, "the regeneration still spans multiple sessions");
  assert.ok(sessions2.has(CATCH_UP_SESSION), "the regeneration covers the catch-up session's new material (user story 29)");

  assert.equal(gen1.resourceId, gen2.resourceId, "both generations target the same resource");
  assert.notEqual(gen1.id, gen2.id, "each generation is its own record (no first-store-wins, §1 exception)");
  assert.ok(gen2.generatedAt > gen1.generatedAt, "the regeneration happens after the first");
  assert.ok(
    gen2.generation.inputChars > gen1.generation.inputChars,
    "input scale grows with the accumulated material",
  );
});

test("generation targets and timestamps agree with the shared story", () => {
  const summarySamples = loadExamples("summary-examples.json").samples;
  for (const id of ["api-summary-generate-bilibili", "api-summary-generate-after-catch-up"]) {
    const sample = sampleById(summarySamples, id);
    assert.equal(sample.endpoint.path, `/v1/resources/${STORY_RESOURCE}/summaries`, `${id}: targets the story resource`);
    assert.equal(sample.response.body.summary.resourceId, STORY_RESOURCE, `${id}: the summary belongs to that resource`);
    assert.equal(sample.response.body.summary.generation.provider, "qwen", `${id}: fixtures record the default provider`);
  }
  // Generation 1 happens while ses_01JABC0033 is still active (未学完可生成):
  // its generatedAt must fall between that session's start and the catch-up
  // generation.
  const sessionSamples = loadExamples("session-examples.json").samples;
  const active = sampleById(sessionSamples, "api-session-create-bilibili").response.body.session;
  const gen1 = sampleById(summarySamples, "api-summary-generate-bilibili").response.body.summary;
  const gen2 = sampleById(summarySamples, "api-summary-generate-after-catch-up").response.body.summary;
  assert.ok(gen1.generatedAt > active.startedAt, "the first generation happens during the active session");
  assert.ok(gen2.generatedAt > gen1.generatedAt, "the regeneration is later");
});

test("the list and the detail reflect the two generations", () => {
  const summarySamples = loadExamples("summary-examples.json").samples;
  const gen1 = sampleById(summarySamples, "api-summary-generate-bilibili").response.body.summary;
  const gen2 = sampleById(summarySamples, "api-summary-generate-after-catch-up").response.body.summary;

  // Detail: the bare read of a generated summary returns the identical body.
  const detail = sampleById(summarySamples, "api-summary-detail");
  assert.equal(detail.endpoint.path, `/v1/summaries/${gen2.id}`, "the detail sample reads the regenerated summary");
  assert.deepEqual(
    detail.response.body.summary,
    gen2,
    "the detail view is the stored summary, unchanged from the generation response",
  );

  // List: newest first, projections match the generations.
  const list = sampleById(summarySamples, "api-summaries-list").response.body.summaries;
  assert.deepEqual(
    list.map((s) => s.id),
    [gen2.id, gen1.id],
    "the list orders generations by generatedAt descending",
  );
  for (const [item, gen] of [[list[0], gen2], [list[1], gen1]]) {
    assert.equal(item.resourceId, gen.resourceId, `${item.id}: list item resourceId matches`);
    assert.equal(item.generatedAt, gen.generatedAt, `${item.id}: list item generatedAt matches`);
    assert.deepEqual(item.generation, gen.generation, `${item.id}: list item generation metadata matches`);
    assert.equal(item.citationCount, gen.citations.length, `${item.id}: citationCount matches the citations`);
  }

  // Another resource counts independently: the plain webpage has none.
  const empty = sampleById(summarySamples, "api-summaries-list-empty");
  assert.equal(empty.endpoint.path, "/v1/resources/res_01JABC0010/summaries", "the empty list reads the other resource");
  assert.deepEqual(empty.response.body.summaries, [], "the other resource's list is empty, not an error");
});

test("usage aggregates the story's successful generations and done audio", () => {
  const summarySamples = loadExamples("summary-examples.json").samples;
  const gen1 = sampleById(summarySamples, "api-summary-generate-bilibili").response.body.summary;
  const gen2 = sampleById(summarySamples, "api-summary-generate-after-catch-up").response.body.summary;
  const usage = sampleById(summarySamples, "api-usage").response.body;

  // audioSeconds counts only done audio segments at the sample's moment:
  // ses_32 segment (60000–90000), ses_33 segments 0 and 1 (0–30000,
  // 30000–60000), ses_34 segment (120000–150000). Not counted: ses_33
  // segment 2 (failed), segment 3 (still transcribing), ses_32 segment 1
  // (failed), and the captions-path session (no audio). D18 口径.
  const doneRangesMs = [
    [60000, 90000],
    [0, 30000],
    [30000, 60000],
    [120000, 150000],
  ];
  const totalMs = doneRangesMs.reduce((sum, [startMs, endMs]) => sum + (endMs - startMs), 0);
  assert.equal(usage.audioSeconds, Math.floor(totalMs / 1000), "audioSeconds is the done-segment total floored to seconds");

  // Summary counters: only persisted generations count (failure leaves no
  // dirty data, D16/D18).
  const generationSamples = summarySamples.filter((s) => s.id.startsWith("api-summary-generate"));
  assert.equal(usage.summaryCount, generationSamples.length, "summaryCount equals the story's persisted generations");
  assert.equal(
    usage.summaryInputChars,
    gen1.generation.inputChars + gen2.generation.inputChars,
    "summaryInputChars sums the generations' inputChars",
  );
  assert.equal(usage.updatedAt, gen2.generatedAt, "updatedAt is the last counting write (the second generation)");
});

// --- round-3 endpoint surface --------------------------------------------------

// The round-3 templates. contract-fixtures.test.js remains the authority for
// classifying every /v1 sample onto the surface; this list pins which
// endpoints round 3 adds and that each carries success AND failure samples.
const ROUND3_ENDPOINTS = [
  "POST /v1/resources/{id}/summaries",
  "GET /v1/resources/{id}/summaries",
  "GET /v1/summaries/{id}",
  "GET /v1/usage",
];

function endpointOf(sample) {
  const { method, path } = sample.endpoint;
  const segs = path.split("/").filter(Boolean);
  if (method === "POST" && segs.length === 4 && segs[1] === "resources" && segs[3] === "summaries") {
    return "POST /v1/resources/{id}/summaries";
  }
  if (method === "GET" && segs.length === 4 && segs[1] === "resources" && segs[3] === "summaries") {
    return "GET /v1/resources/{id}/summaries";
  }
  if (method === "GET" && segs.length === 3 && segs[1] === "summaries") {
    return "GET /v1/summaries/{id}";
  }
  if (method === "GET" && segs.join("/") === "v1/usage") {
    return "GET /v1/usage";
  }
  return `${method} ${path}`;
}

test("every round-3 endpoint has a success and a failure sample", () => {
  const successTemplates = new Set(loadExamples("summary-examples.json").samples.map(endpointOf));
  const errorSamples = loadExamples("error-examples.json").samples;
  const failureTemplates = new Set(errorSamples.map(endpointOf));

  for (const endpoint of ROUND3_ENDPOINTS) {
    assert.ok(successTemplates.has(endpoint), `no success sample covers ${endpoint}`);
    assert.ok(failureTemplates.has(endpoint), `no failure sample covers ${endpoint}`);
  }
});

// --- round-3 error pins ------------------------------------------------------------

test("round-3 error samples pin the generation, isolation and usage failure behaviors", () => {
  const errorSamples = loadExamples("error-examples.json").samples;
  const byId = new Map(errorSamples.map((e) => [e.id, e]));

  const expected = [
    // 401 semantics carry over (D2 family): generation and usage both need a
    // user credential.
    ["error-summary-generate-unauthorized", "POST /v1/resources/{id}/summaries", 401, "unauthorized"],
    ["error-usage-unauthorized", "GET /v1/usage", 401, "unauthorized"],
    // 404 isolation: another account's resource/summary is not_found.
    ["error-summary-generate-cross-account", "POST /v1/resources/{id}/summaries", 404, "not_found"],
    ["error-summaries-list-cross-account", "GET /v1/resources/{id}/summaries", 404, "not_found"],
    ["error-cross-account-summary", "GET /v1/summaries/{id}", 404, "not_found"],
    // No summarizable text: 409, the AI Provider is never called.
    ["error-summary-generate-no-transcript", "POST /v1/resources/{id}/summaries", 409, "no_transcript_to_summarize"],
    // Generation failure feedback form (D16): 502, no dirty data.
    ["error-summary-generate-failed", "POST /v1/resources/{id}/summaries", 502, "summary_generation_failed"],
  ];

  for (const [id, template, status, code] of expected) {
    const sample = byId.get(id);
    assert.ok(sample, `required round-3 error sample missing: ${id}`);
    assert.equal(endpointOf(sample), template, `${id}: sits on ${template}`);
    assert.equal(sample.response.status, status, `${id}: status is ${status}`);
    assert.equal(sample.response.body.error.code, code, `${id}: error.code is ${code}`);
  }

  // The no-transcript sample targets the plain webpage resource (never a
  // session); the failure form targets the story resource.
  assert.match(
    byId.get("error-summary-generate-no-transcript").endpoint.path,
    /res_01JABC0010/,
    "no-transcript targets the resource without transcripts",
  );
  assert.match(
    byId.get("error-summary-generate-failed").endpoint.path,
    /res_01JABC0001/,
    "generation failure targets the story resource",
  );
  // Cross-account ids stay in the 01JZZZZ series, like rounds 1–2.
  for (const id of ["error-summary-generate-cross-account", "error-summaries-list-cross-account"]) {
    assert.match(byId.get(id).endpoint.path, /res_01JZZZZ/, `${id}: uses the other-account series`);
  }
  assert.match(byId.get("error-cross-account-summary").endpoint.path, /sum_01JZZZZ/, "cross-account summary uses the other-account series");
  // Generation request bodies are the empty object — no client-side input
  // shaping (D17).
  for (const id of ["error-summary-generate-unauthorized", "error-summary-generate-cross-account", "error-summary-generate-no-transcript", "error-summary-generate-failed"]) {
    assert.deepEqual(byId.get(id).request?.body, {}, `${id}: the generation request body is the empty object`);
  }
});

// --- contract documents --------------------------------------------------------------

test("contract-r3.md, decisions.md and the prompt template list the round-3 anchors", () => {
  function readDoc(relativePath) {
    return fs.readFileSync(path.join(CONTRACT_ROOT, relativePath), "utf8");
  }

  const r3 = readDoc("contract-r3.md");
  for (const endpoint of ROUND3_ENDPOINTS) {
    assert.ok(r3.includes(endpoint), `contract-r3.md must list ${endpoint}`);
  }
  for (const token of [
    "Course Summary", "Citation", "segmentRef", "generation", "generatedAt",
    "inputChars", "citationCount", "audioSeconds", "summaryCount", "summaryInputChars",
    "no_transcript_to_summarize", "summary_generation_failed",
    "provider", "model", "Markdown", "不落脏数据", "幂等", "ADR 0002",
  ]) {
    assert.ok(r3.includes(token), `contract-r3.md must define ${token}`);
  }
  // The doc states the input scope and the record-per-generation rule.
  for (const token of ["未学完", "每次被接受的请求创建一条新记录", "来源时间轴"]) {
    assert.ok(r3.includes(token), `contract-r3.md must state ${token}`);
  }

  const decisions = readDoc("decisions.md");
  for (const d of ["D16", "D17", "D18"]) {
    assert.ok(decisions.includes(`${d} ·`), `decisions.md must record ${d}`);
  }
  for (const token of ["stub", "qwen", "AI Provider", "Speech Provider", "Worker", "prompts/course-summary.md", "只记录不计费", "落库"]) {
    assert.ok(decisions.includes(token), `decisions.md must cover ${token}`);
  }

  const prompt = fs.readFileSync(path.join(CONTRACT_ROOT, "..", "prompts", "course-summary.md"), "utf8");
  for (const token of [
    "Course Summary", "citations", "sessionId", "startMs", "endMs",
    "{resourceTitle}", "{transcriptLines}", "{gapLines}", "{noteLines}",
  ]) {
    assert.ok(prompt.includes(token), `prompts/course-summary.md must cover ${token}`);
  }
});
