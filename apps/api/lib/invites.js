/**
 * Invited-email registry (decision 3 of #49): trial access starts from an
 * invited email. Invites are data in the store's `invites` collection, plus
 * a seed file loaded at startup and a CLI script (scripts/invite.js) — no
 * admin UI in round 1.
 */
const fs = require("node:fs");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

/**
 * Normalize an email for lookup and delivery: trim + lowercase.
 * Returns the normalized address, or null when the value is not
 * email-shaped (callers turn null into a validation error).
 */
function normalizeEmail(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function addInvite(store, email, now = () => Date.now()) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error(`invalid invite email: ${email}`);
  }
  if (store.get("invites", normalized)) {
    return false; // already registered, idempotent
  }
  store.set("invites", normalized, {
    email: normalized,
    invitedAt: new Date(now()).toISOString(),
  });
  return true;
}

function isInvited(store, email) {
  return store.get("invites", email) !== null;
}

/**
 * Load invited emails from a seed file (JSON array of addresses) into the
 * store. Idempotent: existing invites stay untouched; a missing file is a
 * no-op so deployments can start without one.
 */
function loadSeedInvites(store, seedFile, now) {
  if (!seedFile || !fs.existsSync(seedFile)) {
    return;
  }
  const raw = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`invite seed file must be a JSON array: ${seedFile}`);
  }
  for (const email of raw) {
    addInvite(store, email, now);
  }
}

module.exports = { normalizeEmail, addInvite, isInvited, loadSeedInvites, EMAIL_PATTERN };
