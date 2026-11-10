/**
 * Opaque server-generated IDs (contract §1: IDs are opaque strings; the
 * readable prefixes exist for debugging only, clients must not parse them).
 */
const crypto = require("node:crypto");

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

module.exports = { generateId };
