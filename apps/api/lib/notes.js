/**
 * Note domain (contract-v1.md §2.4, §3.6; ticket P12, issue #61).
 *
 * A note belongs to one account's Resource; a timestamped note additionally
 * pins a sourceId + positionMs pair, and the pair must point at an actual
 * Source under that same Resource (a pointer at another resource's Source
 * is a validation failure). Plain webpage notes carry sourceId/positionMs
 * null — the pair is either fully present or fully absent.
 *
 * Idempotent resend: the client-generated clientRequestId is the dedupe
 * basis (contract §1). The first POST that carries a given clientRequestId
 * within an account IS the note; a resend (e.g. after a network drop)
 * answers 200 with the original note and never writes a duplicate. The
 * scope is the account, not the path resource, so a resent request can
 * never slip past dedupe by changing the path — the original note is
 * returned regardless of which resource id the retry hits.
 *
 * Isolation (decision D2): reads and writes run with the accountId in the
 * query; unknown and other-account ids are the same 404, checked before
 * the source pointer validation.
 */
const { ApiError, validationFailed, notFoundResource } = require("./errors");
const { generateId } = require("./ids");

const NOTE_TEXT_MAX = 10000;

/**
 * Contract §1 timestamp format: ISO 8601 UTC at second precision, like the
 * fixture samples ("2026-11-10T08:00:00Z"). The API's single timestamp
 * formatter — resources.js reuses it so every createdAt is shaped alike.
 */
function isoSeconds(atMs) {
  return new Date(Math.floor(atMs / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Contract §2.4 shape (internal fields stripped). */
function serializeNote(note) {
  return {
    id: note.id,
    resourceId: note.resourceId,
    sourceId: note.sourceId,
    positionMs: note.positionMs,
    text: note.text,
    clientRequestId: note.clientRequestId,
    createdAt: note.createdAt,
  };
}

/** All of one account's notes on one resource, oldest first. */
function notesForResource({ store, accountId, resourceId }) {
  return store
    .list("notes")
    .filter((n) => n.accountId === accountId && n.resourceId === resourceId)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map(serializeNote);
}

/**
 * Validate the request body shape (contract §3.6): clientRequestId and
 * non-empty text required; sourceId + positionMs optional and paired.
 * Returns the normalized fields; throws the contract 400s.
 */
function parseNoteRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw validationFailed("请求体必须是 JSON 对象");
  }
  if (
    body.clientRequestId === undefined ||
    body.clientRequestId === null ||
    body.clientRequestId === ""
  ) {
    throw validationFailed("缺少必填字段 clientRequestId");
  }
  if (typeof body.clientRequestId !== "string") {
    throw validationFailed("clientRequestId 必须是字符串");
  }
  if (body.text === undefined || body.text === null) {
    throw validationFailed("缺少必填字段 text");
  }
  if (typeof body.text !== "string" || body.text.trim() === "") {
    // The fixture sample error-validation-failed-empty-note-text pins the
    // message for the empty case.
    throw new ApiError(400, "validation_failed", "笔记正文不能为空");
  }
  if (body.text.length > NOTE_TEXT_MAX) {
    throw validationFailed(`笔记正文不能超过 ${NOTE_TEXT_MAX} 字`);
  }

  const hasSource = body.sourceId !== undefined && body.sourceId !== null;
  const hasPosition = body.positionMs !== undefined && body.positionMs !== null;
  if (hasSource !== hasPosition) {
    throw validationFailed("sourceId 与 positionMs 必须成对出现");
  }
  let sourceId = null;
  let positionMs = null;
  if (hasSource) {
    if (typeof body.sourceId !== "string" || body.sourceId === "") {
      throw validationFailed("sourceId 必须是非空字符串");
    }
    if (!Number.isInteger(body.positionMs) || body.positionMs < 0) {
      throw validationFailed("positionMs 必须是非负整数");
    }
    sourceId = body.sourceId;
    positionMs = body.positionMs;
  }
  return { clientRequestId: body.clientRequestId, text: body.text, sourceId, positionMs };
}

/**
 * Create (or idempotently re-answer) one note on an account resource
 * (contract §3.6). Throws the contract errors on validation (400) and
 * isolation (404, D2 first — before the source pointer check).
 */
function createNote({ store, accountId, resourceId, body, now }) {
  const request = parseNoteRequest(body);

  // D2: other accounts' resources and unknown ids are the same 404, and it
  // wins over the source pointer validation below.
  const resource = store
    .list("resources")
    .find((r) => r.id === resourceId && r.accountId === accountId);
  if (!resource) {
    throw notFoundResource();
  }

  // Idempotent resend: the account's first note with this clientRequestId
  // is returned as-is (200), whatever the path's resource id says.
  const existing = store
    .list("notes")
    .find((n) => n.accountId === accountId && n.clientRequestId === request.clientRequestId);
  if (existing) {
    return { status: 200, body: { note: serializeNote(existing) } };
  }

  // A timestamped note must point at an actual Source under THIS resource
  // (and account); anything else is the contract 400.
  if (request.sourceId !== null) {
    const source = store
      .list("sources")
      .find(
        (s) =>
          s.id === request.sourceId &&
          s.accountId === accountId &&
          s.resourceId === resourceId,
      );
    if (!source) {
      throw validationFailed("sourceId 必须指向该资料名下的来源");
    }
  }

  const atMs = now();
  const note = {
    id: generateId("note"),
    accountId,
    resourceId,
    sourceId: request.sourceId,
    positionMs: request.positionMs,
    text: request.text,
    clientRequestId: request.clientRequestId,
    createdAt: isoSeconds(atMs),
    createdAtMs: atMs,
  };
  store.set("notes", note.id, note);
  return { status: 201, body: { note: serializeNote(note) } };
}

module.exports = { createNote, notesForResource, serializeNote, parseNoteRequest, isoSeconds };
