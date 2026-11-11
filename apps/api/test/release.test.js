const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Release metadata for the API unit (AGENTS.md: the API's first runnable
// version starts at 0.1.0 in its own release metadata; the root 0.2.0
// belongs to the Chrome extension and is not touched from here).

const apiRoot = path.resolve(__dirname, "..");

test("apps/api release metadata is 0.1.2", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(apiRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "@learning-digest/api");
  // 0.1.2 (ticket 2.2, issue #65): Session lifecycle + captions direct
  // archive + transcript polling + resource-detail sessions[] extension
  // (contract-r2 §3.1–3.3, §3.5–3.6; decisions D9/D15).
  assert.equal(packageJson.version, "0.1.2");
  assert.equal(packageJson.private, true);
});

test("apps/api ships zero npm dependencies", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(apiRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});

test("invited-email seed file is a JSON array", () => {
  const seed = JSON.parse(
    fs.readFileSync(path.join(apiRoot, "data", "invites.seed.json"), "utf8"),
  );
  assert.ok(Array.isArray(seed));
});
