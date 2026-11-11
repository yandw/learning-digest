/**
 * Session archive client (Ticket 2.5, issue #68): the pure contract layer
 * between the extension and the round-2 Session endpoints —
 * contract-r2.md §3.1 (POST sessions), §3.3 (POST captions, origin lock),
 * §3.5 (GET transcript polling), §3.2 (finish) and the §4 error codes.
 *
 * The fixtures are the single source of truth: every request/response shape
 * below is asserted against contracts/fixtures (session-examples.json and
 * error-examples.json), the same discipline the API's own tests follow.
 * The D15 origin-conflict verdict (409 transcript_origin_conflict) and the
 * 已结束 verdict (409 session_already_finished) are pinned here so the
 * plugin-side feedback can never misread them.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const YTD_SESSION_ARCHIVE = require("../session-archive.js");

const FIXTURES_DIR = path.join(__dirname, "..", "contracts", "fixtures");
const sessionSample = (id) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "session-examples.json"), "utf8")).samples.find(
    (s) => s.id === id,
  );
const errorSample = (id) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "error-examples.json"), "utf8")).samples.find(
    (s) => s.id === id,
  );

// --- paths -------------------------------------------------------------------

test("paths encode the opaque ids and keep the /v1 shapes", () => {
  assert.equal(YTD_SESSION_ARCHIVE.createSessionPath("src_01JABC0002"), "/v1/sources/src_01JABC0002/sessions");
  assert.equal(YTD_SESSION_ARCHIVE.captionsArchivePath("ses_01JABC0031"), "/v1/sessions/ses_01JABC0031/captions");
  assert.equal(YTD_SESSION_ARCHIVE.transcriptPath("ses_01JABC0031"), "/v1/sessions/ses_01JABC0031/transcript");
  assert.equal(YTD_SESSION_ARCHIVE.finishPath("ses_01JABC0031"), "/v1/sessions/ses_01JABC0031/finish");
  // A hostile id must not change the path shape (contract §1: opaque ids).
  assert.equal(
    YTD_SESSION_ARCHIVE.createSessionPath("src/a?b"),
    "/v1/sources/src%2Fa%3Fb/sessions",
  );
});

// --- POST /v1/sources/{id}/sessions (§3.1) --------------------------------------

test("buildCreateSessionRequest sends the contract's empty body", () => {
  // api-session-create-bilibili: the request body is {}.
  assert.deepEqual(YTD_SESSION_ARCHIVE.buildCreateSessionRequest(), {});
});

test("parseSessionResponse answers the fixture's 201 session", () => {
  const example = sessionSample("api-session-create-bilibili");
  const parsed = YTD_SESSION_ARCHIVE.parseSessionResponse({
    status: example.response.status,
    data: example.response.body,
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.session, example.response.body.session);
});

test("parseSessionResponse classifies the failure kinds", () => {
  const unauthorized = errorSample("error-session-create-unauthorized");
  const parsed = YTD_SESSION_ARCHIVE.parseSessionResponse({
    status: unauthorized.response.status,
    data: unauthorized.response.body,
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.kind, "unauthorized");
  assert.equal(parsed.code, "unauthorized");
  assert.equal(typeof parsed.message, "string");

  const cross = errorSample("error-session-create-cross-account-source");
  const notFound = YTD_SESSION_ARCHIVE.parseSessionResponse({
    status: cross.response.status,
    data: cross.response.body,
  });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.kind, "notFound");

  const serverError = YTD_SESSION_ARCHIVE.parseSessionResponse({
    status: 500,
    data: null,
  });
  assert.equal(serverError.ok, false);
  assert.equal(serverError.kind, "error");

  const malformed = YTD_SESSION_ARCHIVE.parseSessionResponse({
    status: 200,
    data: { session: { id: 42 } },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.kind, "error");
});

// --- POST /v1/sessions/{id}/captions (§3.3, D15) --------------------------------

test("buildCaptionsArchiveRequest shapes the fixture's archive body verbatim", () => {
  const example = sessionSample("api-session-captions-archive");
  const built = YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({
    segments: example.request.body.segments,
  });
  assert.deepEqual(built, example.request.body);
});

test("buildCaptionsArchiveRequest refuses segments the contract would 400", () => {
  const base = { startMs: 138000, endMs: 159000, text: "这一节我们把注意力分数放到矩阵上看" };
  assert.equal(YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({ segments: [] }), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({ segments: base.text }), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({}), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({ segments: [{ endMs: 159000, text: "x" }] }), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({ segments: [{ ...base, text: "" }] }), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({ segments: [{ ...base, endMs: 138000 - 1 }] }), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({ segments: [{ ...base, startMs: -1 }] }), null);
});

test("buildCaptionsArchiveRequest keeps zero-length segments (§2.2 allows endMs == startMs)", () => {
  const built = YTD_SESSION_ARCHIVE.buildCaptionsArchiveRequest({
    segments: [{ startMs: 138000, endMs: 138000, text: "零长段合法" }],
  });
  assert.deepEqual(built, { segments: [{ startMs: 138000, endMs: 138000, text: "零长段合法" }] });
});

test("parseCaptionsArchiveResponse answers the fixture's 201 TranscriptView", () => {
  const example = sessionSample("api-session-captions-archive");
  const parsed = YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({
    status: example.response.status,
    data: example.response.body,
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.outcome, "archived");
  assert.deepEqual(parsed.transcript, example.response.body.transcript);
});

test("parseCaptionsArchiveResponse answers the resend as idempotent (200)", () => {
  const example = sessionSample("api-session-captions-resend-idempotent");
  const parsed = YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({
    status: example.response.status,
    data: example.response.body,
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.outcome, "idempotent");
  assert.deepEqual(parsed.transcript, example.response.body.transcript);
});

test("parseCaptionsArchiveResponse reads the D15 origin-conflict 409 exactly", () => {
  const example = errorSample("error-transcript-origin-conflict");
  const parsed = YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({
    status: example.response.status,
    data: example.response.body,
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.kind, "originConflict");
  assert.equal(parsed.code, "transcript_origin_conflict");
  assert.equal(parsed.message, example.response.body.error.message);
});

test("parseCaptionsArchiveResponse reads the 已结束 409 exactly", () => {
  const example = errorSample("error-session-finish-already-finished");
  const parsed = YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({
    status: 409,
    data: example.response.body,
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.kind, "alreadyFinished");
  assert.equal(parsed.code, "session_already_finished");
});

test("parseCaptionsArchiveResponse classifies the remaining failures", () => {
  assert.equal(
    YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({ status: 401, data: { error: { code: "unauthorized" } } }).kind,
    "unauthorized",
  );
  assert.equal(
    YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({ status: 404, data: { error: { code: "not_found" } } }).kind,
    "notFound",
  );
  assert.equal(
    YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({ status: 400, data: { error: { code: "validation_failed" } } }).kind,
    "validation",
  );
  assert.equal(
    YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({ status: 500, data: null }).kind,
    "error",
  );
  // A 2xx body without a well-formed TranscriptView is a failure, not a guess.
  const malformed = YTD_SESSION_ARCHIVE.parseCaptionsArchiveResponse({
    status: 201,
    data: { transcript: { records: "nope" } },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.kind, "error");
});

// --- GET /v1/sessions/{id}/transcript (§3.5) -------------------------------------

test("parseTranscriptResponse answers the captions-finished fixture view", () => {
  const example = sessionSample("api-session-transcript-captions-finished");
  const parsed = YTD_SESSION_ARCHIVE.parseTranscriptResponse({
    status: example.response.status,
    data: example.response.body,
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.view, example.response.body);
});

test("parseTranscriptResponse keeps the asr-active view's pending and failed arrays", () => {
  const example = sessionSample("api-session-transcript-asr-active");
  const parsed = YTD_SESSION_ARCHIVE.parseTranscriptResponse({
    status: example.response.status,
    data: example.response.body,
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.view.pending.length, 1);
  assert.equal(parsed.view.failed.length, 1);
});

test("parseTranscriptResponse classifies 401/404 and malformed views", () => {
  const cross = errorSample("error-cross-account-session-transcript");
  assert.equal(
    YTD_SESSION_ARCHIVE.parseTranscriptResponse({ status: cross.response.status, data: cross.response.body }).kind,
    "notFound",
  );
  assert.equal(
    YTD_SESSION_ARCHIVE.parseTranscriptResponse({ status: 200, data: { records: [] } }).ok,
    false,
    "the four arrays are always present (§2.5); a body without them is not a view",
  );
});

test("parseTranscriptView validates the four-array shape field by field", () => {
  const example = sessionSample("api-session-transcript-captions-finished");
  assert.deepEqual(
    YTD_SESSION_ARCHIVE.parseTranscriptView(example.response.body),
    example.response.body,
  );
  const broken = { ...example.response.body };
  delete broken.gaps;
  assert.equal(YTD_SESSION_ARCHIVE.parseTranscriptView(broken), null);
  broken.gaps = "nope";
  assert.equal(YTD_SESSION_ARCHIVE.parseTranscriptView(broken), null);
});

// --- TranscriptView → plugin transcript rows --------------------------------------

test("transcriptViewToTranscriptRecords maps records to seconds-based rows", () => {
  const example = sessionSample("api-session-transcript-captions-finished");
  const rows = YTD_SESSION_ARCHIVE.transcriptViewToTranscriptRecords(example.response.body);
  assert.deepEqual(rows, [
    { start: 138, duration: 21, text: "这一节我们把注意力分数放到矩阵上看" },
    { start: 159, duration: 22, text: "Q K V 三个矩阵各司其职" },
  ]);
});

test("transcriptViewToTranscriptRecords renders failed segments as visible markers", () => {
  const example = sessionSample("api-session-transcript-asr-active");
  const rows = YTD_SESSION_ARCHIVE.transcriptViewToTranscriptRecords(example.response.body);
  const failedRow = rows.find((row) => row.failed === true);
  assert.ok(failedRow, "the failed segment lands as a visible annotation");
  assert.equal(failedRow.start, 60);
  assert.equal(failedRow.duration, 30);
  assert.match(failedRow.text, /60:00|60\.0|转写失败|失败/);
});

test("transcriptViewToPendingSegments maps the pending array to spinner segments", () => {
  const example = sessionSample("api-session-transcript-asr-active");
  const segments = YTD_SESSION_ARCHIVE.transcriptViewToPendingSegments(example.response.body);
  assert.deepEqual(segments, [
    { id: "srv_3", start: 90, duration: 30, status: "pending" },
  ]);
});

test("the mapped rows and segments sort by startMs and tolerate empty views", () => {
  const empty = sessionSample("api-session-create-bilibili");
  const view = {
    sessionId: "ses_x",
    sessionStatus: "active",
    origin: null,
    records: [],
    gaps: [],
    pending: [],
    failed: [],
  };
  assert.deepEqual(YTD_SESSION_ARCHIVE.transcriptViewToTranscriptRecords(view), []);
  assert.deepEqual(YTD_SESSION_ARCHIVE.transcriptViewToPendingSegments(view), []);
  assert.equal(YTD_SESSION_ARCHIVE.parseTranscriptView(empty.response.body), null);
});

// --- POST /v1/sessions/{id}/finish (§3.2) ----------------------------------------

test("buildFinishRequest sends the fixture's gaps verbatim", () => {
  const example = sessionSample("api-session-finish-with-gaps");
  const gaps = example.request.body.gaps;
  assert.deepEqual(YTD_SESSION_ARCHIVE.buildFinishRequest({ gaps }), example.request.body);
  assert.deepEqual(YTD_SESSION_ARCHIVE.buildFinishRequest({}), {});
  assert.deepEqual(YTD_SESSION_ARCHIVE.buildFinishRequest({ gaps: [] }), {});
});

test("buildFinishRequest refuses inverted or unbounded gaps", () => {
  assert.equal(YTD_SESSION_ARCHIVE.buildFinishRequest({ gaps: [{ startMs: 210000, endMs: 150000 }] }), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildFinishRequest({ gaps: [{ startMs: -1, endMs: 100 }] }), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildFinishRequest({ gaps: [{}] }), null);
  assert.equal(YTD_SESSION_ARCHIVE.buildFinishRequest({ gaps: "nope" }), null);
});

test("parseFinishResponse answers the fixture's finished session", () => {
  const example = sessionSample("api-session-finish-with-gaps");
  const parsed = YTD_SESSION_ARCHIVE.parseFinishResponse({
    status: example.response.status,
    data: example.response.body,
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.session, example.response.body.session);
});

test("parseFinishResponse reads the repeat-finish 409 as alreadyFinished", () => {
  const example = errorSample("error-session-finish-already-finished");
  const parsed = YTD_SESSION_ARCHIVE.parseFinishResponse({
    status: example.response.status,
    data: example.response.body,
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.kind, "alreadyFinished");
  assert.equal(parsed.message, example.response.body.error.message);
});
