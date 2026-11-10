/**
 * Mailer seam: the routes never touch a concrete email vendor. The real
 * mail service account is undecided, so round 1 ships a dev implementation
 * (code written to a readable file/log) plus an in-memory spy for tests.
 * A production implementation only needs to satisfy `send()` — no vendor
 * SDK or SMTP client is bundled here.
 */
const fs = require("node:fs");
const path = require("node:path");

function createMemoryMailer() {
  const sent = [];
  return {
    sent,
    async send(record) {
      sent.push({ ...record, sentAt: new Date().toISOString() });
    },
  };
}

/**
 * Dev mailer: appends one JSON line per email to `outFile` and logs to
 * stdout. The verification code rides on the record so tests (and the
 * operator) can read it directly from the outbox.
 */
function createDevMailer({ outFile, log = true }) {
  return {
    async send(record) {
      const line = JSON.stringify({ ...record, sentAt: new Date().toISOString() });
      if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.appendFileSync(outFile, `${line}\n`);
      }
      if (log) {
        process.stdout.write(
          `[mailer] to=${record.to} subject="${record.subject}" code=${record.code}\n`,
        );
      }
    },
  };
}

module.exports = { createMemoryMailer, createDevMailer };
