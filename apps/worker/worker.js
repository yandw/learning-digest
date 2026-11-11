/**
 * Production entrypoint for @learning-digest/worker 0.1.0. Zero
 * dependencies: global fetch plus node builtins only.
 *
 * Environment (see lib/config.js for the full list):
 *   LD_WORKER_API_BASE          API base (default http://127.0.0.1:8787)
 *   LD_WORKER_TOKEN             worker service credential (required for
 *                               the real API; empty -> claim answers 401)
 *   LD_WORKER_PROVIDER          stub | qwen (default stub)
 *   QWEN_API_KEY                Bailian key for the qwen provider
 *
 * Pull model (D13): the loop polls POST /v1/worker/tasks/claim, drains
 * claimed tasks serially (concurrency 1), and idles pollIntervalMs between
 * empty polls. Ctrl-C stops it; a claimed-but-unfinished task is
 * re-claimable after a lease mechanism lands (API-side, not this ticket).
 */
const { loadWorkerConfig, createProviderFromConfig } = require("./lib/config");
const { createWorkerClient } = require("./lib/client");
const { runLoop } = require("./lib/loop");

function main(env = process.env) {
  const config = loadWorkerConfig(env);
  const provider = createProviderFromConfig(config);
  const client = createWorkerClient({ apiBase: config.apiBase, token: config.token });

  process.stdout.write(
    `[worker] provider=${config.provider} api=${config.apiBase} poll=${config.pollIntervalMs}ms\n`,
  );
  return runLoop({
    client,
    provider,
    pollIntervalMs: config.pollIntervalMs,
    errorBackoffMs: config.errorBackoffMs,
    log: (line) => process.stdout.write(`${line}\n`),
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
