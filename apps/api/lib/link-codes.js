/**
 * One-time short-lived link codes (P6, decision 3 of #49): the Web
 * confirmation page creates one bound to ITS credential group; the browser
 * extension exchanges the code for a live extension credential in the same
 * group (the P7 linked-logout premise). The code travels through the
 * browser location bar, so it is single use and expires quickly.
 *
 * Rules (mirroring verification codes and credentials):
 * - the raw code is never persisted: only its SHA-256 hash is stored
 * - one exchange per code: consuming marks consumedAt, further exchanges
 *   fail the same way as unknown/expired codes (no information leak)
 * - the issuing credential group is pinned at creation; if the group is
 *   revoked before the exchange (Web logged out in between), the exchange
 *   fails instead of issuing a dead credential
 */
const crypto = require("node:crypto");
const { ApiError } = require("./errors");
const { generateId } = require("./ids");

const ERROR_INVALID_CODE = () =>
  new ApiError(401, "unauthorized", "关联码无效或已过期，请在网页上重新发起关联");

function hashCode(code) {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

function generateLinkCode() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Create a link code bound to the caller's credential group.
 * @returns {{ linkCode: string, expiresAt: string }} expiresAt is an
 *   ISO 8601 UTC string (contract §1 timestamp convention)
 */
function createLinkCode({ store, credential, now, config }) {
  const atMs = now();
  const linkCode = generateLinkCode();
  const record = {
    id: generateId("linkreq"),
    codeHash: hashCode(linkCode),
    accountId: credential.accountId,
    credentialGroupId: credential.credentialGroupId,
    issuedAt: atMs,
    expiresAt: atMs + config.linkCodeTtlMs,
    consumedAt: null,
  };
  store.set("linkCodes", record.codeHash, record);
  return {
    linkCode,
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

/**
 * Consume a presented link code: unknown, expired, already used, or a
 * revoked credential group all answer the same uniform 401.
 * @returns {{ accountId: string, credentialGroupId: string }}
 */
function consumeLinkCode({ store, code, now }) {
  const atMs = now();
  if (typeof code !== "string" || code.trim() === "") {
    throw ERROR_INVALID_CODE();
  }
  const record = store.get("linkCodes", hashCode(code.trim()));
  if (!record || record.consumedAt !== null || record.expiresAt <= atMs) {
    throw ERROR_INVALID_CODE();
  }
  const group = store.get("credentialGroups", record.credentialGroupId);
  if (!group || group.revokedAt !== null) {
    throw ERROR_INVALID_CODE();
  }
  record.consumedAt = atMs;
  store.set("linkCodes", record.codeHash, record);
  return {
    accountId: record.accountId,
    credentialGroupId: record.credentialGroupId,
  };
}

module.exports = { createLinkCode, consumeLinkCode, hashCode, generateLinkCode };
