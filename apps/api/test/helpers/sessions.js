/**
 * Session seeding for the round-2 audio/task tests (ticket 2.3, issue #66).
 *
 * Ticket 2.1 (issue #64) owns POST /v1/sources/{id}/sessions; until it
 * lands on the integration branch there is no public way to create a
 * Session. These helpers seed Session records straight into the "sessions"
 * collection using the contract-r2.md §2.1 shape, so 2.3 tests can run in
 * the meantime. When 2.1 merges, replace the seeding with the public
 * endpoint flow (the storage shape it writes is contract-pinned, so the
 * assertions below should keep passing unchanged).
 */
const { makeTempDir } = require("./harness");
const { openAccount } = require("./accounts");

/** Default temp audio directory for one test app instance. */
function makeAudioDir() {
  return makeTempDir("ld-api-audio");
}

/**
 * Seed one Session (contract-r2.md §2.1) owned by accountId.
 * Missing fields take the fresh-session defaults: active, no finish, no
 * origin lock yet.
 */
function seedSession(
  store,
  {
    id,
    accountId,
    sourceId,
    resourceId,
    status = "active",
    startedAt = "2026-01-01T00:00:00Z",
    finishedAt = null,
    origin = null,
  },
) {
  const session = { id, accountId, sourceId, resourceId, status, startedAt, finishedAt, origin };
  store.set("sessions", id, session);
  return session;
}

/**
 * Open an account through the public auth flow and resolve its account id
 * via GET /v1/me (no store poking for accounts). Requires the harness to
 * have been started with seedFileWith([email]) so the flow succeeds.
 */
async function openAccountWithId(harness, email) {
  const token = await openAccount(harness, email);
  const me = await harness.request("GET", "/v1/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  return { token, accountId: me.json.account.id };
}

module.exports = { seedSession, makeAudioDir, openAccountWithId };
