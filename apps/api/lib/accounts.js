/**
 * Account lifecycle for decision 3: first verification with a correct code
 * opens the account; every successful verification afterwards is a login.
 * Both paths end in a fresh credential issued into the account's active
 * credential group.
 */
const crypto = require("node:crypto");
const { ApiError } = require("./errors");
const { generateId } = require("./ids");
const { hashCode } = require("./codes");
const { issueCredential } = require("./credentials");

const ERROR_INVALID_CODE = () =>
  new ApiError(401, "unauthorized", "验证码错误或已过期");
const ERROR_TOO_MANY_ATTEMPTS = () =>
  new ApiError(401, "unauthorized", "验证码尝试次数过多，请重新获取");

function findAccountByEmail(store, email) {
  return store.get("accounts", email);
}

function codeMatches(record, code) {
  const provided = Buffer.from(hashCode(code), "hex");
  const stored = Buffer.from(record.codeHash, "hex");
  return crypto.timingSafeEqual(provided, stored);
}

/**
 * Verify an email + code pair and open-or-login the account.
 * @returns {{ opened: boolean, account: object, credential: object }}
 */
function openOrLogin({ store, email, code, now, config }) {
  const atMs = now();
  const record = store.get("verificationCodes", email);
  if (!record || record.consumedAt !== null || record.expiresAt <= atMs) {
    throw ERROR_INVALID_CODE();
  }
  if (record.attempts >= config.codeMaxAttempts) {
    throw ERROR_TOO_MANY_ATTEMPTS();
  }

  if (!codeMatches(record, code)) {
    record.attempts += 1;
    store.set("verificationCodes", email, record);
    throw ERROR_INVALID_CODE();
  }

  // Consume the code: one verification per issued code.
  record.consumedAt = atMs;
  store.set("verificationCodes", email, record);

  let account = findAccountByEmail(store, email);
  let opened = false;
  if (!account) {
    opened = true;
    account = {
      id: generateId("acc"),
      email,
      createdAt: new Date(atMs).toISOString(),
    };
    store.set("accounts", email, account);
  }

  const { token, credential } = issueCredential({
    store,
    accountId: account.id,
    kind: "web",
    now,
    config,
  });

  return {
    opened,
    account: { id: account.id, email: account.email, createdAt: account.createdAt },
    credential: {
      token,
      kind: credential.kind,
      credentialGroupId: credential.credentialGroupId,
    },
  };
}

module.exports = { findAccountByEmail, openOrLogin };
