/**
 * Email verification codes (decision 3: first verification opens the
 * account, later logins repeat the same code flow).
 *
 * Rules:
 * - one outstanding code per email, keyed by normalized address
 * - the code itself is never persisted: only its SHA-256 hash is stored
 * - a resend inside the cooldown window answers nothing new (the caller
 *   still returns the uniform 200, so uninvited/probing requests cannot
 *   tell the difference)
 */
const crypto = require("node:crypto");

function hashCode(code) {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function isLive(record, atMs) {
  return (
    record !== null &&
    record.consumedAt === null &&
    record.expiresAt > atMs
  );
}

/**
 * Issue (or silently skip) a code for one email.
 * @returns {{resent: boolean, code: string|null}}
 */
async function issueCode({ store, email, now, config, mailer }) {
  const atMs = now();
  const existing = store.get("verificationCodes", email);
  if (
    isLive(existing, atMs) &&
    atMs - existing.issuedAt < config.codeResendCooldownMs
  ) {
    return { resent: false, code: null };
  }

  const code = generateCode();
  const record = {
    email,
    codeHash: hashCode(code),
    issuedAt: atMs,
    expiresAt: atMs + config.codeTtlMs,
    attempts: 0,
    consumedAt: null,
  };
  store.set("verificationCodes", email, record);
  await mailer.send({
    to: email,
    subject: "Learning Digest 登录验证码",
    text: `您的 Learning Digest 验证码是 ${code}，${Math.round(
      config.codeTtlMs / 60_000,
    )} 分钟内有效。`,
    code,
  });
  return { resent: true, code };
}

module.exports = { issueCode, hashCode, generateCode };
