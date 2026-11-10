/**
 * Mailer seam: the routes never touch a concrete email vendor. The real
 * mail service account is undecided, so round 1 ships a dev implementation
 * (code written to a readable file/log) plus an in-memory spy for tests.
 * A production implementation only needs to satisfy `send()`.
 */
function createMemoryMailer() {
  const sent = [];
  return {
    sent,
    async send(record) {
      sent.push({ ...record, sentAt: new Date().toISOString() });
    },
  };
}

module.exports = { createMemoryMailer };
