const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { startApp } = require("./helpers/harness");
const { createDevMailer } = require("../lib/mailer");

// Slice 7: the dev Mailer implementation writes codes to a JSONL outbox
// file (and stdout) so tests and the operator can read them until a real
// email service account exists. No vendor SDKs ship in this repo.

function tempOutbox() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ld-api-mail-")), "outbox.jsonl");
}

test("dev mailer appends the code to the outbox file, readable by tests", async () => {
  const outFile = tempOutbox();
  const app = await startApp({
    seedFile: path.join(__dirname, "fixtures", "invites-seed-one.json"),
    mailer: createDevMailer({ outFile, log: false }),
  });
  try {
    const response = await app.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
    });
    assert.equal(response.status, 200);

    const lines = fs.readFileSync(outFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const mail = JSON.parse(lines[0]);
    assert.equal(mail.to, "learner@example.com");
    assert.match(mail.code, /^\d{6}$/);
    assert.ok(mail.text.includes(mail.code));
    assert.match(mail.sentAt, /^\d{4}-/);
  } finally {
    await app.close();
  }
});

test("dev mailer creates missing parent directories", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ld-api-mail-"));
  const outFile = path.join(base, "nested", "dir", "outbox.jsonl");
  const app = await startApp({
    seedFile: path.join(__dirname, "fixtures", "invites-seed-one.json"),
    mailer: createDevMailer({ outFile, log: false }),
  });
  try {
    await app.request("POST", "/v1/auth/request-code", {
      body: { email: "learner@example.com" },
    });
    assert.ok(fs.existsSync(outFile));
  } finally {
    await app.close();
  }
});
