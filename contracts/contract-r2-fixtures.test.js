/**
 * Round-2 contract fixtures validation (Ticket 2.1, issue #64).
 *
 * Seam: the same discipline as contract-fixtures.test.js — the JSON fixtures
 * under contracts/fixtures/ are the shared samples the Web, extension and
 * API/Worker implementation tickets reference directly. Round 2 adds the
 * Session / Transcript / audio-task surface (contract-r2.md, decisions
 * D9–D15): session lifecycle endpoints, captions direct archive, ~30s audio
 * segment upload, the API→Worker pull contract, transcript polling, and the
 * GET /v1/resources/{id} extension.
 *
 * Round-1 fixtures and samples are untouched; the round-2 error samples are
 * appended to error-examples.json and validated there by the round-1 suite's
 * envelope checks plus the round-2 pins below.
 *
 * The test validates structure and cross-sample consistency. It does NOT
 * re-derive transcription behavior — the three ends consume these fixtures
 * as their expected values.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CONTRACT_ROOT = __dirname;

const CONTRACT_MARKER = "learning-digest-contracts/v1";

// Shared id prefixes. Like round 1, prefixes are fixture-reading aids, not
// implementation requirements.
const SESSION_ID = /^ses_[0-9A-Za-z]+$/;
const TASK_ID = /^tsk_[0-9A-Za-z]+$/;

const SESSION_STATUSES = new Set(["active", "finished"]);
const TRANSCRIPT_ORIGINS = new Set(["captions", "asr"]);
const TASK_STATUSES = new Set(["pending", "transcribing", "done", "failed"]);
const INFLIGHT_STATUSES = new Set(["pending", "transcribing"]);
const GAP_REASONS = new Set(["skipped"]);

// ~30s is the target audio segment; the segmenter's documented bounds are
// the acceptance range (session-segmenter.js: 5–60s, default 30).
const SEGMENT_DURATION_MS = { min: 5000, max: 60000 };
// The audio upload cap in encoded form, aligned with the Qwen Speech
// Provider's documented 10 MB input limit (apps/worker, the server-side
// transcription path since ticket 2.4).
const MAX_ENCODED_AUDIO_BYTES = 10 * 1024 * 1024;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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

function assertMsRange(startMs, endMs, where) {
  assertIntAtLeast(startMs, 0, where, "startMs");
  assert.ok(Number.isInteger(endMs) && endMs >= startMs, `${where}: endMs must be an integer >= startMs`);
}

// --- structures (contract-r2.md §2) ------------------------------------------

function assertSession(session, where) {
  assert.ok(session && typeof session === "object", `${where}: session must be an object`);
  assert.match(session.id, SESSION_ID, `${where}: fixture session ids use the ses_ prefix`);
  assert.match(session.sourceId, /^src_[0-9A-Za-z]+$/, `${where}: session.sourceId uses the src_ prefix`);
  assert.match(session.resourceId, /^res_[0-9A-Za-z]+$/, `${where}: session.resourceId uses the res_ prefix`);
  assert.ok(
    SESSION_STATUSES.has(session.status),
    `${where}: session.status must be active or finished`,
  );
  assertIsoTimestamp(session.startedAt, `${where}: session.startedAt`);
  if (session.status === "finished") {
    assertIsoTimestamp(session.finishedAt, `${where}: finished sessions carry finishedAt`);
  } else {
    assert.equal(session.finishedAt, null, `${where}: active sessions carry finishedAt null`);
  }
  assert.ok(
    session.origin === null || TRANSCRIPT_ORIGINS.has(session.origin),
    `${where}: session.origin must be captions, asr or null`,
  );
}

function assertTranscriptRecord(record, where) {
  assert.ok(record && typeof record === "object", `${where}: record must be an object`);
  assertMsRange(record.startMs, record.endMs, where);
  assert.equal(typeof record.text, "string", `${where}: record.text is a string`);
  assert.ok(record.text.length > 0, `${where}: record.text is non-empty`);
  assert.ok(
    TRANSCRIPT_ORIGINS.has(record.origin),
    `${where}: record.origin must be captions or asr`,
  );
}

function assertGap(gap, where) {
  assert.ok(gap && typeof gap === "object", `${where}: gap must be an object`);
  assertMsRange(gap.startMs, gap.endMs, where);
  assert.ok(gap.endMs > gap.startMs, `${where}: a gap covers a non-empty range`);
  assert.ok(GAP_REASONS.has(gap.reason), `${where}: gap.reason must be one of ${[...GAP_REASONS].join(", ")}`);
}

function assertSegmentRef(segment, where) {
  // The shared projection of an AudioSegment: its index and source-timeline
  // range. Used by pending[], failed[] and worker task payloads.
  assertIntAtLeast(segment.segmentIndex, 0, where, "segmentIndex");
  assertMsRange(segment.startMs, segment.endMs, where);
  assert.ok(segment.endMs > segment.startMs, `${where}: a segment covers a non-empty range`);
}

function assertAudioSegment(segment, where) {
  assert.ok(segment && typeof segment === "object", `${where}: segment must be an object`);
  assertSegmentRef(segment, where);
  assert.ok(
    TASK_STATUSES.has(segment.status),
    `${where}: segment.status must be one of ${[...TASK_STATUSES].join(", ")}`,
  );
  assert.equal(typeof segment.audioMimeType, "string", `${where}: segment.audioMimeType is a string`);
  assert.match(segment.audioMimeType, /^audio\//, `${where}: audioMimeType is an audio/* MIME type`);
}

function assertErrorDetail(error, where) {
  assert.ok(error && typeof error === "object", `${where}: error detail must be an object`);
  assert.equal(typeof error.code, "string", `${where}: error.code is a string`);
  assert.equal(typeof error.message, "string", `${where}: error.message is a string`);
}

function assertTranscriptView(view, where) {
  assert.ok(view && typeof view === "object", `${where}: transcript view must be an object`);
  assert.match(view.sessionId, SESSION_ID, `${where}: view.sessionId uses the ses_ prefix`);
  assert.match(view.sourceId, /^src_[0-9A-Za-z]+$/, `${where}: view.sourceId uses the src_ prefix`);
  assert.match(view.resourceId, /^res_[0-9A-Za-z]+$/, `${where}: view.resourceId uses the res_ prefix`);
  assert.ok(
    SESSION_STATUSES.has(view.sessionStatus),
    `${where}: view.sessionStatus must be active or finished`,
  );
  assert.ok(
    view.origin === null || TRANSCRIPT_ORIGINS.has(view.origin),
    `${where}: view.origin must be captions, asr or null`,
  );

  // The four arrays are always present (possibly empty) so client code can
  // iterate uniformly regardless of path or progress.
  for (const key of ["records", "gaps", "pending", "failed"]) {
    assert.ok(Array.isArray(view[key]), `${where}: view.${key} is always an array`);
  }
  for (const record of view.records) {
    assertTranscriptRecord(record, `${where}: records[]`);
    assert.equal(
      record.origin,
      view.origin,
      `${where}: record origin matches the session's locked origin`,
    );
  }
  for (const gap of view.gaps) assertGap(gap, `${where}: gaps[]`);
  for (const inflight of view.pending) {
    assertSegmentRef(inflight, `${where}: pending[]`);
    assert.ok(
      INFLIGHT_STATUSES.has(inflight.status),
      `${where}: pending[] status must be pending or transcribing`,
    );
  }
  for (const failure of view.failed) {
    assertSegmentRef(failure, `${where}: failed[]`);
    assertErrorDetail(failure.error, `${where}: failed[] entry`);
  }
}

function assertUploadRequest(body, where) {
  assert.ok(body && typeof body === "object", `${where}: upload body must be an object`);
  assertIntAtLeast(body.segmentIndex, 0, where, "segmentIndex");
  assertIntAtLeast(body.startMs, 0, where, "startMs");
  assert.ok(
    Number.isInteger(body.durationMs) &&
      body.durationMs >= SEGMENT_DURATION_MS.min &&
      body.durationMs <= SEGMENT_DURATION_MS.max,
    `${where}: durationMs must be within [${SEGMENT_DURATION_MS.min}, ${SEGMENT_DURATION_MS.max}] (≈30s target)`,
  );
  assert.equal(typeof body.audioMimeType, "string", `${where}: audioMimeType is a string`);
  assert.match(body.audioMimeType, /^audio\//, `${where}: audioMimeType is an audio/* MIME type`);
  assert.equal(typeof body.audioBase64, "string", `${where}: audioBase64 is a string`);
  assert.ok(body.audioBase64.length > 0, `${where}: audioBase64 is non-empty`);
}

// --- session-examples.json ----------------------------------------------------

test("session fixtures parse and declare the contract", () => {
  const fixture = loadExamples("session-examples.json");
  const ids = fixture.samples.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate sample ids in session-examples.json");
  for (const sample of fixture.samples) {
    assert.equal(typeof sample.description, "string", `${sample.id}: needs a description`);
    assert.ok(sample.endpoint && typeof sample.endpoint === "object", `${sample.id}: needs endpoint{}`);
    assert.ok(sample.response && typeof sample.response === "object", `${sample.id}: needs response{}`);
    assert.ok(Number.isInteger(sample.response.status), `${sample.id}: response.status is an integer`);
  }
});

test("session fixtures conform to the round-2 structures", () => {
  const { samples } = loadExamples("session-examples.json");
  for (const sample of samples) {
    const { response } = sample;
    assert.ok(response.status >= 200 && response.status < 300, `${sample.id}: session-examples carry success responses`);

    const body = response.body;
    assert.ok(body && typeof body === "object", `${sample.id}: response.body must be an object`);

    if (sample.id.startsWith("api-session-create") || sample.id.startsWith("api-session-finish")) {
      // Create/finish style: { session }.
      assertSession(body.session, `${sample.id}: session`);
    }
    if (sample.id.startsWith("api-session-captions")) {
      // Archive style: { transcript } (create 201, idempotent resend 200).
      assert.ok(response.status === 201 || response.status === 200, `${sample.id}: archive returns 201, resend returns 200`);
    }
    if (body.transcript !== undefined) {
      assertTranscriptView(body.transcript, `${sample.id}: transcript`);
    }
    if (sample.id.startsWith("api-session-transcript")) {
      // Polling returns the bare TranscriptView.
      assertTranscriptView(body, `${sample.id}`);
    }
    if (sample.id.startsWith("api-resource-detail")) {
      // Round-2 detail extension: the round-1 keys stay, sessions[] is added.
      for (const key of ["resource", "sources", "notes", "sessions"]) {
        assert.ok(Array.isArray(body[key]) || (body[key] && typeof body[key] === "object"), `${sample.id}: detail carries ${key}`);
      }
      assert.ok(Array.isArray(body.sessions) && body.sessions.length > 0, `${sample.id}: detail carries sessions[]`);
      for (const entry of body.sessions) {
        assertSession(entry, `${sample.id}: sessions[]`);
        const summary = entry.transcript;
        assert.ok(summary && typeof summary === "object", `${sample.id}: session entries carry a transcript summary`);
        for (const key of ["recordCount", "gapCount", "failedCount"]) {
          assertIntAtLeast(summary[key], 0, `${sample.id}: session ${entry.id}`, key);
        }
      }
      const startedAtList = body.sessions.map((s) => s.startedAt);
      const sorted = [...startedAtList].sort().reverse();
      assert.deepEqual(startedAtList, sorted, `${sample.id}: sessions are ordered by startedAt descending`);
    }
  }
});

// --- audio-task-examples.json ---------------------------------------------------

test("audio task fixtures parse and declare the contract", () => {
  const fixture = loadExamples("audio-task-examples.json");
  const ids = fixture.samples.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate sample ids in audio-task-examples.json");
  for (const sample of fixture.samples) {
    assert.equal(typeof sample.description, "string", `${sample.id}: needs a description`);
    assert.ok(sample.response && typeof sample.response === "object", `${sample.id}: needs response{}`);
  }
});

test("audio upload fixtures conform to the segment upload contract", () => {
  const { samples } = loadExamples("audio-task-examples.json");
  for (const sample of samples) {
    if (!sample.id.startsWith("api-audio-segment")) continue;
    assert.ok(sample.request?.body, `${sample.id}: upload samples carry a request body`);
    assertUploadRequest(sample.request.body, `${sample.id}: request`);
    const segment = sample.response.body.segment;
    assertAudioSegment(segment, `${sample.id}: segment`);
    const { segmentIndex, startMs, durationMs, audioMimeType } = sample.request.body;
    assert.equal(segment.segmentIndex, segmentIndex, `${sample.id}: response echoes segmentIndex`);
    assert.equal(segment.startMs, startMs, `${sample.id}: response echoes startMs`);
    assert.equal(segment.endMs, startMs + durationMs, `${sample.id}: endMs = startMs + durationMs`);
    assert.equal(segment.audioMimeType, audioMimeType, `${sample.id}: response echoes audioMimeType`);
    assert.equal(segment.status, "pending", `${sample.id}: a fresh upload is pending until a worker claims it`);
    assert.ok(
      sample.response.status === 201 || sample.response.status === 200,
      `${sample.id}: upload returns 201, idempotent replay returns 200`,
    );
  }
});

test("worker fixtures conform to the pull contract", () => {
  const { samples } = loadExamples("audio-task-examples.json");
  for (const sample of samples) {
    const body = sample.response.body;
    if (sample.id.startsWith("worker-task-claim")) {
      assert.ok(Array.isArray(body.tasks) && body.tasks.length > 0, `${sample.id}: claim returns tasks[]`);
      for (const task of body.tasks) {
        assert.match(task.taskId, TASK_ID, `${sample.id}: fixture task ids use the tsk_ prefix`);
        assert.match(task.sessionId, SESSION_ID, `${sample.id}: task.sessionId uses the ses_ prefix`);
        assertSegmentRef(task, `${sample.id}: task`);
        assert.equal(typeof task.audioMimeType, "string", `${sample.id}: task carries audioMimeType`);
        assert.match(task.audioMimeType, /^audio\//, `${sample.id}: task audioMimeType is audio/*`);
        assert.equal(typeof task.audioBase64, "string", `${sample.id}: claim hands over the audio inline`);
        assert.ok(task.audioBase64.length > 0, `${sample.id}: task audioBase64 is non-empty`);
      }
    } else if (sample.id.startsWith("worker-task-result")) {
      assert.match(body.taskId, TASK_ID, `${sample.id}: result echoes taskId`);
      assert.ok(body.status === "done" || body.status === "failed", `${sample.id}: result status is done or failed`);
      const request = sample.request?.body ?? {};
      assert.equal(request.status, body.status, `${sample.id}: response mirrors the submitted status`);
      if (request.status === "done") {
        assert.ok(Array.isArray(request.records), `${sample.id}: done results carry records[]`);
        for (const record of request.records) {
          assertTranscriptRecord({ ...record, origin: "asr" }, `${sample.id}: result records[]`);
        }
      } else {
        assertErrorDetail(request.error, `${sample.id}: failed result carries an error detail`);
      }
    }
  }
});

// --- round-2 endpoint surface -------------------------------------------------

// The round-2 templates. contract-fixtures.test.js remains the authority for
// classifying every /v1 sample onto the surface; this list pins which
// endpoints round 2 adds and that each carries success AND failure samples.
const ROUND2_ENDPOINTS = [
  "POST /v1/sources/{id}/sessions",
  "POST /v1/sessions/{id}/finish",
  "POST /v1/sessions/{id}/captions",
  "POST /v1/sessions/{id}/audio-segments",
  "GET /v1/sessions/{id}/transcript",
  "POST /v1/worker/tasks/claim",
  "POST /v1/worker/tasks/{id}/result",
];

function endpointOf(sample) {
  const { method, path } = sample.endpoint;
  const segs = path.split("/").filter(Boolean);
  if (method === "POST" && segs.join("/") === "v1/worker/tasks/claim") {
    return "POST /v1/worker/tasks/claim";
  }
  if (method === "POST" && segs[1] === "worker" && segs[2] === "tasks" && segs[4] === "result") {
    return "POST /v1/worker/tasks/{id}/result";
  }
  if (method === "POST" && segs[1] === "sources" && segs[3] === "sessions") {
    return "POST /v1/sources/{id}/sessions";
  }
  if (method === "POST" && segs[1] === "sessions" && segs.length === 4) {
    return `POST /v1/sessions/{id}/${segs[3]}`;
  }
  if (method === "GET" && segs[1] === "sessions" && segs[3] === "transcript") {
    return "GET /v1/sessions/{id}/transcript";
  }
  if (method === "GET" && segs[1] === "resources") {
    return "GET /v1/resources/{id}";
  }
  return `${method} ${path}`;
}

test("every round-2 endpoint has a success and a failure sample", () => {
  const sessionSamples = loadExamples("session-examples.json").samples;
  const audioSamples = loadExamples("audio-task-examples.json").samples;
  const errorSamples = loadExamples("error-examples.json").samples;

  const successTemplates = new Set(
    [...sessionSamples, ...audioSamples].map(endpointOf),
  );
  const failureTemplates = new Set(errorSamples.map(endpointOf));

  for (const endpoint of ROUND2_ENDPOINTS) {
    assert.ok(successTemplates.has(endpoint), `no success sample covers ${endpoint}`);
    assert.ok(failureTemplates.has(endpoint), `no failure sample covers ${endpoint}`);
  }
  // The detail extension reuses the round-1 endpoint; the round-2 sample
  // must exist so the sessions[] shape is pinned on the shared surface.
  assert.ok(successTemplates.has("GET /v1/resources/{id}"), "no round-2 detail extension sample");
});

// --- the shared round-2 story ---------------------------------------------------
//
// session-examples.json and audio-task-examples.json tell one timeline on
// src_01JABC0002: sessions 31 (captions, finished), 32 (asr, finished),
// 33 (asr, active). The samples must stay mutually consistent so the three
// ends can replay them as a chain.

function sampleById(samples, id) {
  const sample = samples.find((s) => s.id === id);
  assert.ok(sample, `required sample missing: ${id}`);
  return sample;
}

test("audio uploads, worker tasks and the polling view tell one timeline", () => {
  const sessionSamples = loadExamples("session-examples.json").samples;
  const audioSamples = loadExamples("audio-task-examples.json").samples;

  const uploads = audioSamples.filter((s) => s.id.startsWith("api-audio-segment"));
  for (const upload of uploads) {
    assert.equal(
      upload.endpoint.path,
      "/v1/sessions/ses_01JABC0033/audio-segments",
      `${upload.id}: uploads target the active asr session ses_01JABC0033`,
    );
  }

  // Claim returns exactly the uploaded segments, in segmentIndex order, with
  // the stored audio (the first upload's bytes for segmentIndex 1).
  const claim = sampleById(audioSamples, "worker-task-claim");
  const uploadByIndex = new Map(uploads.map((s) => [s.request.body.segmentIndex, s]));
  const claimedIndexes = claim.response.body.tasks.map((t) => t.segmentIndex);
  assert.deepEqual(
    [...uploadByIndex.keys()].sort((a, b) => a - b),
    claimedIndexes,
    "claim covers exactly the uploaded segments in index order",
  );
  for (const task of claim.response.body.tasks) {
    const upload = uploadByIndex.get(task.segmentIndex);
    assert.equal(task.startMs, upload.request.body.startMs, `task ${task.taskId}: startMs matches the upload`);
    assert.equal(
      task.endMs,
      upload.request.body.startMs + upload.request.body.durationMs,
      `task ${task.taskId}: endMs matches the upload range`,
    );
    assert.equal(task.audioMimeType, upload.request.body.audioMimeType, `task ${task.taskId}: mimeType matches`);
    assert.equal(task.sessionId, "ses_01JABC0033", `task ${task.taskId}: belongs to the session`);
    assert.equal(task.audioBase64, upload.request.body.audioBase64, `task ${task.taskId}: audio is the stored upload`);
  }

  // The poll of ses_01JABC0033 reflects the worker results: segment 1 done
  // (its text is in records), segment 2 failed (same error detail), segment
  // 3 still transcribing (claimed, no result yet).
  const resultDone = sampleById(audioSamples, "worker-task-result-done");
  const resultFailed = sampleById(audioSamples, "worker-task-result-failed");
  const poll = sampleById(sessionSamples, "api-session-transcript-asr-active");
  const view = poll.response.body;

  const seg1Record = view.records.find((r) => r.startMs === 30000 && r.endMs === 60000);
  assert.ok(seg1Record, "the poll shows segment 1 as a record");
  assert.deepEqual(
    { startMs: seg1Record.startMs, endMs: seg1Record.endMs, text: seg1Record.text },
    resultDone.request.body.records[0],
    "segment 1's record text comes from the worker's done result",
  );
  assert.equal(view.failed.length, 1, "the poll shows exactly one failed segment");
  assert.equal(view.failed[0].segmentIndex, 2, "the failed segment is segment 2");
  assert.deepEqual(
    view.failed[0].error,
    resultFailed.request.body.error,
    "the failed segment surfaces the worker's error detail",
  );
  assert.deepEqual(
    view.pending.map((p) => ({ segmentIndex: p.segmentIndex, status: p.status })),
    [{ segmentIndex: 3, status: "transcribing" }],
    "segment 3 is claimed and still transcribing",
  );
  // The create sample starts the very session the uploads target.
  const create = sampleById(sessionSamples, "api-session-create-bilibili");
  assert.equal(create.response.body.session.id, "ses_01JABC0033", "the create sample opens ses_01JABC0033");
  assert.equal(create.endpoint.path, "/v1/sources/src_01JABC0002/sessions", "create targets src_01JABC0002");
});

test("caption archive, finish gaps and the finished polls agree", () => {
  const sessionSamples = loadExamples("session-examples.json").samples;

  // Captions archive content == the captions session's polled records.
  const archive = sampleById(sessionSamples, "api-session-captions-archive");
  const resend = sampleById(sessionSamples, "api-session-captions-resend-idempotent");
  const captionsPoll = sampleById(sessionSamples, "api-session-transcript-captions-finished");
  assert.deepEqual(
    archive.response.body.transcript.records.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    archive.request.body.segments,
    "the archived transcript mirrors the submitted caption segments",
  );
  assert.deepEqual(
    resend.response.body.transcript,
    archive.response.body.transcript,
    "the caption resend returns the stored archive unchanged",
  );
  const captionsView = captionsPoll.response.body;
  assert.equal(captionsView.origin, "captions", "the captions session is origin-locked to captions");
  assert.deepEqual(
    captionsView.records.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    archive.request.body.segments,
    "the finished captions poll carries the archived captions verbatim",
  );
  // 字幕不全按原样归档: the caption-less range 181000–300000 appears in NO
  // gap; the only gap is the explicitly skipped one.
  assert.deepEqual(
    captionsView.gaps,
    [{ startMs: 300000, endMs: 360000, reason: "skipped" }],
    "only the explicit skip is a gap; caption gaps stay unmarked",
  );

  // Finish gaps == the finished asr poll's gaps.
  const finish = sampleById(sessionSamples, "api-session-finish-with-gaps");
  const asrPoll = sampleById(sessionSamples, "api-session-transcript-asr-finished");
  assert.equal(finish.endpoint.path, "/v1/sessions/ses_01JABC0032/finish", "finish closes ses_01JABC0032");
  assert.deepEqual(
    asrPoll.response.body.gaps,
    finish.request.body.gaps.map((g) => ({ ...g, reason: "skipped" })),
    "the poll's gaps are the finish-reported skip ranges",
  );
  assert.equal(finish.response.body.session.origin, "asr", "session 32 is an asr session");
});

test("resource detail summarizes the same sessions", () => {
  const sessionSamples = loadExamples("session-examples.json").samples;
  const detail = sampleById(sessionSamples, "api-resource-detail-with-sessions");
  const pollBySession = new Map(
    ["api-session-transcript-captions-finished", "api-session-transcript-asr-active", "api-session-transcript-asr-finished"]
      .map((id) => {
        const poll = sampleById(sessionSamples, id);
        return [poll.response.body.sessionId, poll.response.body];
      }),
  );

  for (const entry of detail.response.body.sessions) {
    const view = pollBySession.get(entry.id);
    if (!view) continue; // sessions without a poll sample just carry their own summary
    assert.deepEqual(
      entry.transcript,
      {
        recordCount: view.records.length,
        gapCount: view.gaps.length,
        failedCount: view.failed.length,
      },
      `${entry.id}: the summary counts match the polled transcript view`,
    );
    assert.equal(entry.origin, view.origin, `${entry.id}: summary origin matches the poll`);
    assert.equal(entry.status, view.sessionStatus, `${entry.id}: summary status matches the poll`);
    assert.equal(entry.sourceId, view.sourceId, `${entry.id}: summary source matches the poll`);
  }
  assert.equal(detail.response.body.resource.id, "res_01JABC0001", "detail extends the round-1 resource");
  // Same-interval single path (D15): each story session carries exactly one
  // origin, and captions/audio submissions never mix within a session.
  const audioSamples = loadExamples("audio-task-examples.json").samples;
  const captionTargets = new Set(
    sessionSamples.filter((s) => s.id.startsWith("api-session-captions")).map((s) => s.endpoint.path),
  );
  const uploadTargets = new Set(audioSamples.filter((s) => s.id.startsWith("api-audio-segment")).map((s) => s.endpoint.path));
  for (const target of captionTargets) {
    assert.ok(!uploadTargets.has(target), `${target}: captions and audio never hit the same session`);
  }
});

// --- round-2 error pins ---------------------------------------------------------

const ROUND2_ERROR_CODES = {
  400: new Set(["validation_failed"]),
  401: new Set(["unauthorized"]),
  404: new Set(["not_found"]),
  409: new Set(["session_already_finished", "transcript_origin_conflict"]),
};

test("round-2 error samples pin the session, segment and task failure behaviors", () => {
  const errorSamples = loadExamples("error-examples.json").samples;
  const byId = new Map(errorSamples.map((e) => [e.id, e]));

  const expected = [
    // 401 semantics carry over (D2 family): session creation without a
    // credential is 401, the worker credential is separate from user tokens.
    ["error-session-create-unauthorized", "POST /v1/sources/{id}/sessions", 401, "unauthorized"],
    ["error-worker-claim-unauthorized", "POST /v1/worker/tasks/claim", 401, "unauthorized"],
    // 404 isolation: another account's source/session/task is not_found.
    ["error-session-create-cross-account-source", "POST /v1/sources/{id}/sessions", 404, "not_found"],
    ["error-cross-account-session-transcript", "GET /v1/sessions/{id}/transcript", 404, "not_found"],
    ["error-worker-result-unknown-task", "POST /v1/worker/tasks/{id}/result", 404, "not_found"],
    // Session state machine: writes against a finished session are 409.
    ["error-session-finish-already-finished", "POST /v1/sessions/{id}/finish", 409, "session_already_finished"],
    ["error-audio-segment-after-finish", "POST /v1/sessions/{id}/audio-segments", 409, "session_already_finished"],
    // Same-interval single path: opposite-path submission is 409.
    ["error-transcript-origin-conflict", "POST /v1/sessions/{id}/captions", 409, "transcript_origin_conflict"],
    // Segment metadata validation.
    ["error-audio-segment-invalid-index", "POST /v1/sessions/{id}/audio-segments", 400, "validation_failed"],
    ["error-audio-segment-too-large", "POST /v1/sessions/{id}/audio-segments", 400, "validation_failed"],
  ];

  for (const [id, template, status, code] of expected) {
    const sample = byId.get(id);
    assert.ok(sample, `required round-2 error sample missing: ${id}`);
    assert.equal(endpointOf(sample), template, `${id}: sits on ${template}`);
    assert.equal(sample.response.status, status, `${id}: status is ${status}`);
    assert.equal(sample.response.body.error.code, code, `${id}: error.code is ${code}`);
  }

  // The already-finished and origin-conflict samples reference sessions from
  // the shared story: ses_01JABC0031 is the finished captions session,
  // ses_01JABC0033 the active asr session.
  assert.match(
    byId.get("error-session-finish-already-finished").endpoint.path,
    /ses_01JABC0031/,
    "already-finished targets the finished captions session",
  );
  assert.match(
    byId.get("error-transcript-origin-conflict").endpoint.path,
    /ses_01JABC0033/,
    "origin conflict targets the asr-locked session",
  );
  // Cross-account ids stay in the 01JZZZZ series, like round 1.
  assert.match(
    byId.get("error-cross-account-session-transcript").endpoint.path,
    /ses_01JZZZZ/,
    "cross-account session ids use the other-account series",
  );
});

// --- contract documents ----------------------------------------------------------

test("contract-r2.md and decisions.md list the round-2 anchors", () => {
  function readDoc(name) {
    return fs.readFileSync(path.join(CONTRACT_ROOT, name), "utf8");
  }

  const r2 = readDoc("contract-r2.md");
  for (const endpoint of ROUND2_ENDPOINTS) {
    assert.ok(r2.includes(endpoint), `contract-r2.md must list ${endpoint}`);
  }
  for (const token of [
    "Session", "TranscriptRecord", "TranscriptView", "startMs", "endMs",
    "origin", "gaps", "segmentIndex", "audioBase64", "audioMimeType",
    "transcription_failed", "session_already_finished", "transcript_origin_conflict",
    "pending", "transcribing", "done", "failed",
  ]) {
    assert.ok(r2.includes(token), `contract-r2.md must define ${token}`);
  }
  // The doc states the timeline reference and the caption-archive rule.
  for (const token of ["来源视频时间轴", "按原样归档", "skipped"]) {
    assert.ok(r2.includes(token), `contract-r2.md must state ${token}`);
  }

  const decisions = readDoc("decisions.md");
  for (const d of ["D9", "D10", "D11", "D12", "D13", "D14", "D15"]) {
    assert.ok(decisions.includes(`${d} ·`), `decisions.md must record ${d}`);
  }
  // The realtime WebSocket deferral is an explicit decision record.
  assert.ok(
    decisions.includes("qwen3-asr-flash-realtime"),
    "decisions.md must record the realtime WS deferral",
  );
  for (const token of ["pull", "独立单元", "0.1.0", "宽限"]) {
    assert.ok(decisions.includes(token), `decisions.md must cover ${token}`);
  }
});

