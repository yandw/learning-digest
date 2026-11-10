/**
 * Session domain (contract-r2.md §2.1, §3.1–3.2; decisions D9, D15).
 *
 * A Session is one continuous act of learning from a Source (GLOSSARY).
 * The round-2 transcript data (records, gaps, pending/failed audio segments)
 * all hangs off the Session; the round-1 progress endpoint stays untouched —
 * progress is still the (account, Source) single record (D9), so nothing in
 * this module reads or writes the "progress" collection.
 *
 * Multiple sessions per Source coexist (历史归档与进行中的并存): the store
 * never rejects a second active Session on the same Source. `origin` starts
 * null and locks to "captions" or "asr" on the first transcript submission
 * of that path (D15, same-interval single path) — the locking itself lives
 * in lib/transcripts.js.
 *
 * Isolation (decision D2): unknown ids and other-account ids are the same
 * 404, indistinguishable.
 */
const { notFoundSource, notFoundSession, sessionAlreadyFinished } = require("./errors");
const { generateId } = require("./ids");
const { isoSeconds } = require("./notes");
const { parseGaps, reportGaps } = require("./transcripts");

/** Contract §2.1 shape (internal fields stripped). */
function serializeSession(session) {
  return {
    id: session.id,
    sourceId: session.sourceId,
    resourceId: session.resourceId,
    status: session.status,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    origin: session.origin,
  };
}

/**
 * D2 lookup: the account's Session by id, or null. Callers answer the
 * same 404 for null whether the id is unknown or another account's.
 */
function findAccountSession({ store, accountId, sessionId }) {
  return (
    store
      .list("sessions")
      .find((s) => s.id === sessionId && s.accountId === accountId) || null
  );
}

/**
 * Start one study session on the account's Source (contract §3.1): 201 with
 * the active Session, `origin` still null. The request body is an empty
 * object — identity comes from the credential, the target from the path —
 * so there is nothing to validate beyond auth + isolation.
 */
function createSession({ store, accountId, sourceId, now }) {
  // D2: other accounts' sources and unknown ids are the same 404.
  const source = store
    .list("sources")
    .find((s) => s.id === sourceId && s.accountId === accountId);
  if (!source) {
    throw notFoundSource();
  }

  const atMs = now();
  const session = {
    id: generateId("ses"),
    accountId,
    sourceId: source.id,
    resourceId: source.resourceId,
    status: "active",
    startedAt: isoSeconds(atMs),
    startedAtMs: atMs,
    finishedAt: null,
    finishedAtMs: null,
    origin: null,
  };
  store.set("sessions", session.id, session);
  return { status: 201, body: { session: serializeSession(session) } };
}

/**
 * Close one study session (contract §3.2): status -> finished, finishedAt
 * server-generated, the optional gaps reported into the Session's
 * transcript state (§2.3). Finish is a state transition, not a creation
 * (contract §1 idempotency rule): a repeat is 409 session_already_finished
 * — the session itself stays finished and unchanged, so retries never
 * corrupt state. Unknown and other-account sessions are the same 404 (D2).
 */
function finishSession({ store, accountId, sessionId, body, now }) {
  const gaps = parseGaps(body);

  // D2: other accounts' sessions and unknown ids are the same 404.
  const session = findAccountSession({ store, accountId, sessionId });
  if (!session) {
    throw notFoundSession();
  }
  if (session.status === "finished") {
    throw sessionAlreadyFinished();
  }

  const atMs = now();
  session.status = "finished";
  session.finishedAt = isoSeconds(atMs);
  session.finishedAtMs = atMs;
  store.set("sessions", session.id, session);
  reportGaps({ store, sessionId: session.id, gaps });
  return { status: 200, body: { session: serializeSession(session) } };
}

module.exports = { createSession, finishSession, serializeSession, findAccountSession };
