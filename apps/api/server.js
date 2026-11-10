/**
 * Production entrypoint for @learning-digest/api 0.1.0. Zero dependencies:
 * node:http plus node builtins only.
 *
 * Environment:
 *   PORT                listen port (default 8787; 0 = ephemeral)
 *   LD_API_STATE_FILE   embedded store file (default data/state.json)
 *   LD_API_INVITE_SEED  invited-email seed file (default data/invites.seed.json)
 *   LD_API_OUTBOX_FILE  dev-mailer JSONL outbox (default data/outbox.jsonl)
 *
 * The real email service account is undecided (decision 3 note in the
 * ticket): until it exists, codes are delivered by the dev mailer to the
 * outbox file and stdout. Swapping in a real Mailer means passing a
 * different `mailer` into createApp — no route or storage changes.
 */
const path = require("node:path");
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
  const server = createApp({ store, mailer, seedFile });

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
