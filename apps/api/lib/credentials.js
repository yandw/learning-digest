/**
 * Credential + credential-group model (decision 3 of #49).
 *
 * A credential is one Bearer token (Web session or extension link). Every
 * credential belongs to exactly one credential group; the group is the
 * revocation boundary: revoking a group invalidates every credential in it,
 * which is what linked logout (Web + extension exiting together) builds on
 * in P7. Round-1 rule: login issues the new credential into the account's
 * ACTIVE group, creating one only when none is active — so Web and
 * extension credentials of one account share a group.
 *
 * Storage: credentials are keyed by token SHA-256 (the raw token never
 * touches the store); groups are keyed by id.
 */
const crypto = require("node:crypto");
const { generateId } = require("./ids");

function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function findActiveGroup(store, accountId) {
  return (
    store
      .list("credentialGroups")
      .filter((group) => group.accountId === accountId && group.revokedAt === null)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null
  );
}

/**
 * Issue a Bearer credential into the account's active group (creating the
 * group when none is active). The extension link flow (P6) pins the group
 * instead: it passes credentialGroupId so the extension credential joins
 * the group of the Web session that confirmed the link.
 * @returns {{ token: string, credential: object }}
 */
function issueCredential({ store, accountId, kind, now, config, credentialGroupId }) {
  const atMs = now();
  let group = credentialGroupId
    ? store.get("credentialGroups", credentialGroupId)
    : findActiveGroup(store, accountId);
  if (!group) {
    group = {
      id: generateId("credgrp"),
      accountId,
      createdAt: atMs,
      revokedAt: null,
    };
    store.set("credentialGroups", group.id, group);
  }
  const token = crypto.randomBytes(config.tokenBytes).toString("base64url");
  const credential = {
    id: generateId("cred"),
    tokenHash: hashToken(token),
    accountId,
    kind,
    credentialGroupId: group.id,
    createdAt: atMs,
    revokedAt: null,
  };
  store.set("credentials", credential.tokenHash, credential);
  return { token, credential };
}

/**
 * Authenticate a Bearer token: resolves the credential by token hash and
 * rejects it when the credential itself or its whole group is revoked.
 * @returns {object|null} the live credential record, or null
 */
function authenticate({ store, token }) {
  const record = store.get("credentials", hashToken(token));
  if (!record || record.revokedAt !== null) {
    return null;
  }
  const group = store.get("credentialGroups", record.credentialGroupId);
  if (!group || group.revokedAt !== null) {
    return null;
  }
  return record;
}

/**
 * Revoke ONE credential. Siblings in the same group stay valid. Round 1
 * wired logout through this; since P7 the logout ENDPOINT drives
 * revokeCredentialGroup instead (linked logout), and this primitive stays
 * part of the model for tests and future single-credential needs. Unknown
 * or already-revoked tokens are a no-op.
 * @returns {boolean} true when a live credential was revoked
 */
function revokeCredential({ store, token, now }) {
  const record = store.get("credentials", hashToken(token));
  if (!record || record.revokedAt !== null) {
    return false;
  }
  record.revokedAt = now();
  store.set("credentials", record.tokenHash, record);
  return true;
}

/**
 * Resolve a credential record by token WITHOUT the revocation checks.
 * P7's logout endpoint needs the record of an already-revoked credential
 * so a repeated logout stays an idempotent 200 instead of a 401; unknown
 * tokens (never issued) still return null.
 * @returns {object|null} the credential record, live or revoked
 */
function findCredentialByToken({ store, token }) {
  return store.get("credentials", hashToken(token));
}

/**
 * Revoke a whole credential group — the revocation boundary for decision 3
 * (Web and extension credentials exit together). This is the server-side
 * primitive P7's linked-logout endpoint/behavior drives; the round-1
 * logout endpoint deliberately does NOT call it.
 */
function revokeCredentialGroup({ store, groupId, now }) {
  const group = store.get("credentialGroups", groupId);
  if (!group || group.revokedAt !== null) {
    return false;
  }
  group.revokedAt = now();
  store.set("credentialGroups", groupId, group);
  return true;
}

module.exports = {
  issueCredential,
  findActiveGroup,
  hashToken,
  authenticate,
  findCredentialByToken,
  revokeCredential,
  revokeCredentialGroup,
};
