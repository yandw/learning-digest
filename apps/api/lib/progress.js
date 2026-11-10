/**
 * Playback progress domain (contract-v1.md §2.3, §3.5; decision D4).
 *
 * Progress is stored per account + Source in the shared "progress"
 * collection (P4's GET paths already read it). Writes use optimistic
 * concurrency on `expectedRevision`:
 * - no progress yet counts as revision 0; a successful write bumps to 1;
 * - a stale expectedRevision is a 409 carrying the current progress, so
 *   the client can decide to overwrite or give up without a read-back;
 * - `positionMs` is never clamped server-side (D4): rewinding is legal,
 *   it records the last actually-played position.
 *
 * Idempotent resend (ticket #54; the fixtures do not cover it, so the
 * semantics are pinned here and in test/sources-progress.test.js): a
 * request whose expectedRevision equals the current revision AND whose
 * positionMs equals the stored value is a resend of the last successful
 * write (e.g. after a network drop). It answers 200 with the current
 * values and does NOT bump the revision, so retries keep the result
 * consistent. The same expectedRevision with a different positionMs is a
 * fresh write and bumps normally. A stale expectedRevision is always a
 * 409, whether or not the position matches.
 */
const { ApiError, validationFailed, notFoundSource } = require("./errors");

/** Contract §3.5 conflict body: 409 + the current progress verbatim. */
function progressConflict(current) {
  return new ApiError(
    409,
    "progress_revision_conflict",
    "进度已被其他端更新，请以 current 为准重试",
    { current },
  );
}

/** Non-negative integer field (contract §2.3: positionMs, expectedRevision). */
function requireNonNegativeInteger(body, field) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw validationFailed(`缺少必填字段 ${field}`);
  }
  const value = body[field];
  if (value === undefined || value === null) {
    throw validationFailed(`缺少必填字段 ${field}`);
  }
  if (!Number.isInteger(value) || value < 0) {
    throw validationFailed(`${field} 必须是非负整数`);
  }
  return value;
}

/**
 * Save one progress write (contract §3.5). Returns the 200 result; throws
 * the contract errors on validation (400), isolation (404, D2) and
 * concurrency (409) failures.
 */
function saveProgress({ store, accountId, sourceId, body }) {
  const positionMs = requireNonNegativeInteger(body, "positionMs");
  const expectedRevision = requireNonNegativeInteger(body, "expectedRevision");

  // D2: other accounts' sources and unknown ids are the same 404.
  const source = store
    .list("sources")
    .find((s) => s.id === sourceId && s.accountId === accountId);
  if (!source) {
    throw notFoundSource();
  }

  const progress = store.get("progress", sourceId);
  const currentRevision = progress ? progress.revision : 0;

  // Optimistic concurrency (D4): the version number is the only reliable
  // write order — positionMs can legally go backwards (dragging), so it is
  // never a concurrency signal.
  if (currentRevision !== expectedRevision) {
    throw progressConflict({
      // No progress yet reads as positionMs null at revision 0 (§2.3).
      positionMs: progress ? progress.positionMs : null,
      revision: currentRevision,
    });
  }

  // Idempotent resend (ticket #54): the exact duplicate of the last
  // acknowledged write answers with the stored values and does not bump,
  // so retries after a network drop keep the result consistent.
  if (progress && progress.positionMs === positionMs) {
    return { status: 200, body: { positionMs: progress.positionMs, revision: progress.revision } };
  }

  const next = { positionMs, revision: currentRevision + 1 };
  store.set("progress", sourceId, next);
  return { status: 200, body: next };
}

module.exports = { saveProgress, progressConflict };
