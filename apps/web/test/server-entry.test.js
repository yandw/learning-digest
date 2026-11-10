import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startUpstream } from "./helpers/upstream.js";

// The production entrypoint: server.js reads PORT and LD_API_UPSTREAM,
// serves the static bundle from public/ and proxies /v1 to the upstream.
// Drives the real process over loopback.

const SERVER = path.resolve(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "server.js",
);

function startServer(env) {
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForListening(child, timeoutMs = 10_000) {
  let buffered = "";
  return new Promise((resolve, reject) => {
    function onData(chunk) {
      buffered += chunk.toString();
      const match = /listening on port (\d+)/.exec(buffered);
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`server exited early (${code}): ${buffered}`));
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for listening line: ${buffered}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      buffered += chunk.toString();
    });
    child.on("exit", onExit);
  });
}

async function stopServer(child) {
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

test("server.js serves the shell and proxies /v1 to LD_API_UPSTREAM", async () => {
  const upstream = await startUpstream({
    respond: () => ({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: true }),
    }),
  });
  const child = startServer({ LD_API_UPSTREAM: upstream.url });
  try {
    const port = await waitForListening(child);

    const shell = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /id="loginView"/);

    const proxied = await fetch(`http://127.0.0.1:${port}/v1/auth/request-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "learner@example.com" }),
    });
    assert.equal(proxied.status, 200);
    assert.deepEqual(await proxied.json(), { ok: true });
    assert.equal(upstream.requests.length, 1);
  } finally {
    await stopServer(child);
    await upstream.close();
  }
});

test("server.js prints the listening port on stdout", async () => {
  const child = startServer({});
  try {
    const port = await waitForListening(child);
    assert.ok(Number.isInteger(port) && port > 0);
  } finally {
    await stopServer(child);
  }
});
