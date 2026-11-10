#!/usr/bin/env node
/**
 * Invite registration CLI — invited emails are data (decision 3 of #49);
 * round 1 has no admin UI. The project side registers trial users here,
 * then hands out the trial URL manually.
 *
 * Usage:
 *   node scripts/invite.js add <email> [<email> ...] [--file <state.json>]
 *   node scripts/invite.js list [--file <state.json>]
 *
 * The state file is the API's embedded store (same file the server uses);
 * default: apps/api/data/state.json, overridable with LD_API_STATE_FILE.
 */
const { createFileStore } = require("../lib/persistence");
const { addInvite, normalizeEmail } = require("../lib/invites");
const path = require("node:path");

function parseArgs(argv) {
  const args = [...argv];
  const flagIndex = args.indexOf("--file");
  if (flagIndex !== -1) {
    args.splice(flagIndex, 2); // drop the flag and its value
  }
  let file = null;
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    file = path.resolve(argv[flagIndex + 1]);
  } else if (process.env.LD_API_STATE_FILE) {
    file = path.resolve(process.env.LD_API_STATE_FILE);
  } else {
    file = path.resolve(__dirname, "..", "data", "state.json");
  }
  return { command: args[0], operands: args.slice(1), file };
}

function main(argv) {
  const { command, operands, file } = parseArgs(argv);
  const rest = operands;
  const store = createFileStore({ file });

  if (command === "add") {
    if (rest.length === 0) {
      process.stderr.write("usage: invite.js add <email> [...]\n");
      return 1;
    }
    for (const email of rest) {
      if (!normalizeEmail(email)) {
        process.stderr.write(`invalid email: ${email}\n`);
        return 1;
      }
    }
    for (const email of rest) {
      const added = addInvite(store, email);
      process.stdout.write(
        `${added ? "registered" : "already invited"}: ${normalizeEmail(email)}\n`,
      );
    }
    return 0;
  }

  if (command === "list") {
    for (const invite of store.list("invites")) {
      process.stdout.write(`${invite.email}\tinvited ${invite.invitedAt}\n`);
    }
    process.stdout.write(`(${store.count("invites")} invited email(s))\n`);
    return 0;
  }

  process.stderr.write("usage: invite.js <add|list> [...]\n");
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
