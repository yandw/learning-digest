/**
 * Test harness for apps/api: starts a real HTTP server on an ephemeral
 * loopback port (no external network) with all seams injected.
 *
 * Seams (see test/README comments in each slice):
 * - store:  generic collection store (defaults to a temp-file FileStore)
 * - mailer: dev/memory mailer (defaults to memory spy)
 * - now:    injectable clock for expiry/cooldown determinism
 */
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("../../lib/app");
const { createFileStore } = require("../../lib/persistence");
const { createMemoryMailer } = require("../../lib/mailer");

function makeTempDir(label = "ld-api-test") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

/**
 * Start an app instance with injected seams. Returns { port, request, close }.
 * `request(method, path, { body, headers })` returns
 * { status, headers, text, json } — json is null when the body is not JSON.
 */
async function startApp(options = {}) {
  const store =
    options.store ||
    createFileStore({ file: path.join(makeTempDir(), "state.json") });
  const mailer = options.mailer || createMemoryMailer();
  const app = createApp({
    store,
    mailer,
    now: options.now,
    config: options.config,
    seedFile: options.seedFile,
  });
  await new Promise((resolve) => {
    app.listen(0, "127.0.0.1", resolve);
  });
  const { port } = app.address();

  async function request(method, requestPath, { body, headers } = {}) {
    const init = {
      method,
      headers: { ...headers },
      // A real external host is never contacted: fetch targets the local
      // loopback listener only.
      signal: AbortSignal.timeout(5000),
    };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!init.headers["Content-Type"] && typeof body !== "string") {
        init.headers["Content-Type"] = "application/json";
      }
    }
    const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, init);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_error) {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  function close() {
    return new Promise((resolve) => app.close(() => resolve()));
  }

  return { port, app, store, mailer, request, close };
}

module.exports = { startApp, makeTempDir };
