const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Release metadata for the worker unit (AGENTS.md: apps/worker is the
// fourth release unit; its first runnable version starts at 0.1.0 in its
// own release metadata, mirroring apps/api's release test).

const workerRoot = path.resolve(__dirname, "..");

test("apps/worker release metadata is 0.1.0", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(workerRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "@learning-digest/worker");
  // 0.1.0: the first runnable worker (ticket 2.3, issue #66).
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.private, true);
});

test("apps/worker ships zero npm dependencies", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(workerRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});
