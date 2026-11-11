/**
 * Production entrypoint for @learning-digest/api 0.1.0. Zero dependencies:
 * node:http plus node builtins only.
 *
 * Environment:
 *   PORT                  listen port (default 8787; 0 = ephemeral)
 *   LD_API_STATE_FILE     embedded store file (default data/state.json)
 *   LD_API_INVITE_SEED    invited-email seed file (default data/invites.seed.json)
 *   LD_API_OUTBOX_FILE    dev-mailer JSONL outbox (default data/outbox.jsonl)
 *   LD_API_WORKER_TOKEN   worker service credential for /v1/worker/tasks/*
 *                         (contract-r2 §3.7; unset = worker endpoints 401)
 *   LD_API_AUDIO_DIR      temp audio directory for uploaded segments
 *                         (D14; default a system temp dir)
 *
 * The real email service account is undecided (decision 3 note in the
 * ticket): until it exists, codes are delivered by the dev mailer to the
 * outbox file and stdout. Swapping in a real Mailer means passing a
 * different `mailer` into createApp — no route or storage changes.
 */
const path = require("node:path");
const os = require("node:os");
const { createApp } = require("./lib/app");
const { createFileStore } = require("./lib/persistence");
const { createDevMailer } = require("./lib/mailer");

function main(env = process.env) {
  const dir = __dirname;
  const stateFile = env.LD_API_STATE_FILE || path.join(dir, "data", "state.json");
  const seedFile = env.LD_API_INVITE_SEED || path.join(dir, "data", "invites.seed.json");
  const outFile = env.LD_API_OUTBOX_FILE || path.join(dir, "data", "outbox.jsonl");

  const store = createFileStore({ file: stateFile });
  const mailer = createDevMailer({ outFile });
  const server = createApp({
    store,
    mailer,
    seedFile,
    config: {
      workerToken: env.LD_API_WORKER_TOKEN || "",
      audioDir: env.LD_API_AUDIO_DIR || path.join(os.tmpdir(), "ld-api-audio"),
    },
  });

  const port = Number.parseInt(env.PORT || "8787", 10);
  server.listen(port, () => {
    process.stdout.write(`[api] listening on port ${server.address().port}\n`);
  });
  return server;
}

if (require.main === module) {
  main();
}

module.exports = { main };
