const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

// Slice 7: the production entrypoint wires FileStore + dev file mailer +
// invite seed and listens. Tests drive the real process over loopback.

const SERVER = path.resolve(__dirname, "..", "server.js");

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-api-entry-"));
  return {
    dir,
    stateFile: path.join(dir, "data", "state.json"),
    outboxFile: path.join(dir, "data", "outbox.jsonl"),
    seedFile: path.join(dir, "invites.seed.json"),
  };
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function waitForListening(child, timeoutMs = 10_000) {
  const started = Date.now();
  let buffered = "";
  return new Promise((resolve, reject) => {
    function onData(chunk) {
      buffered += chunk.toString();
      const match = /listening on port (\d+)/.exec(buffered);
      if (match) {
        child.stdout.off("data", onData);
        resolve(Number(match[1]));
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      buffered += chunk.toString();
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code}): ${buffered}`)));
    function poll() {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timeout waiting for listening line: ${buffered}`));
      } else if (buffered.includes("listening on port")) {
        // handled by onData
      } else {
        setTimeout(poll, 50);
      }
    }
    poll();
  });
}

test("server.js wires file store, dev mailer and invite seed end to end", async () => {
  const ws = makeWorkspace();
  fs.writeFileSync(ws.seedFile, JSON.stringify(["entry@example.com"]));
  const child = startServer({
    LD_API_STATE_FILE: ws.stateFile,
    LD_API_INVITE_SEED: ws.seedFile,
    LD_API_OUTBOX_FILE: ws.outboxFile,
  });
  try {
    const port = await waitForListening(child);

    // Unknown path still speaks the contract envelope.
    const unknown = await fetch(`http://127.0.0.1:${port}/v1/nope`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), {
      error: { code: "not_found", message: "未知接口路径" },
    });

    // Invited email flows through the real process into the outbox file.
    const requestCode = await fetch(`http://127.0.0.1:${port}/v1/auth/request-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "entry@example.com" }),
    });
    assert.equal(requestCode.status, 200);
    const lines = fs.readFileSync(ws.outboxFile, "utf8").trim().split("\n");
    const mail = JSON.parse(lines[lines.length - 1]);
    assert.equal(mail.to, "entry@example.com");
    assert.match(mail.code, /^\d{6}$/);

    // State is persisted to the configured file.
    const state = JSON.parse(fs.readFileSync(ws.stateFile, "utf8"));
    assert.ok(state.invites["entry@example.com"]);
    assert.ok(state.verificationCodes["entry@example.com"]);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode || child.killed) {
        return resolve();
      }
      child.on("exit", resolve);
      child.on("error", resolve);
      setTimeout(resolve, 2000);
    });
  }
});
