const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

// Slice 7: invited emails are DATA — a seed file loads them on startup and
// scripts/invite.js registers more at runtime. No admin UI in round 1.

const SCRIPT = path.resolve(__dirname, "..", "scripts", "invite.js");

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, ...env }, timeout: 10_000 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

function tempStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ld-api-invite-")), "state.json");
}

async function readState(file) {
  if (!fs.existsSync(file)) {
    return { invites: {} };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("invite script add registers an invited email as data", async () => {
  const stateFile = tempStateFile();
  const result = await run(["add", "invited@example.com", "--file", stateFile]);
  assert.equal(result.code, 0, result.stderr);
  const state = await readState(stateFile);
  assert.deepEqual(Object.keys(state.invites), ["invited@example.com"]);
  assert.match(state.invites["invited@example.com"].invitedAt, /^\d{4}-/);
});

test("invite script add is idempotent and normalizes the address", async () => {
  const stateFile = tempStateFile();
  await run(["add", "invited@example.com", "--file", stateFile]);
  const again = await run(["add", "  INVITED@Example.COM ", "--file", stateFile]);
  assert.equal(again.code, 0, again.stderr);
  const state = await readState(stateFile);
  assert.equal(Object.keys(state.invites).length, 1);
});

test("invite script list shows registered emails", async () => {
  const stateFile = tempStateFile();
  await run(["add", "a@example.com", "--file", stateFile]);
  await run(["add", "b@example.com", "--file", stateFile]);
  const list = await run(["list", "--file", stateFile]);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(list.stdout.includes("a@example.com"));
  assert.ok(list.stdout.includes("b@example.com"));
});

test("invite script rejects non-email-shaped input without writing state", async () => {
  const stateFile = tempStateFile();
  const result = await run(["add", "not-an-email", "--file", stateFile]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("invalid email"));
  const state = await readState(stateFile);
  assert.deepEqual(state.invites, {});
});

test("emails registered by the script are accepted by request-code", async () => {
  // End to end: script writes the store the server then reads.
  const { startApp } = require("./helpers/harness");
  const { createFileStore } = require("../lib/persistence");
  const stateFile = tempStateFile();
  await run(["add", "scripted@example.com", "--file", stateFile]);
  const app = await startApp({ store: createFileStore({ file: stateFile }) });
  try {
    const response = await app.request("POST", "/v1/auth/request-code", {
      body: { email: "scripted@example.com" },
    });
    assert.equal(response.status, 200);
    assert.equal(app.mailer.sent.length, 1);
  } finally {
    await app.close();
  }
});
