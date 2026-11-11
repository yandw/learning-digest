const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Release metadata for the API unit (AGENTS.md: the API's first runnable
// version starts at 0.1.0 in its own release metadata; the root 0.2.0
// belongs to the Chrome extension and is not touched from here).

const apiRoot = path.resolve(__dirname, "..");

test("apps/api release metadata is 0.1.6", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(apiRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "@learning-digest/api");
  // 0.1.5 (round 3, ticket 3.2 / issue #74): course summary endpoints
  // (POST /v1/resources/{id}/summaries + list/detail), the AI Provider
  // seam (lib/ai-providers.js: stub + qwen, env LD_AI_*), GET /v1/usage
  // and the D18 usage recording (audioSeconds at first-done,
  // summaryCount/inputChars at landing).
  // 0.1.6 (round-3 review fixes): the qwen timeout signal is created per
  // generate() call via the injectable createTimeoutSignal (a
  // construction-time AbortSignal.timeout aborted once after 120s and
  // would 502 every later generation), and the course-summary system
  // prompt (prompts/course-summary.md) gains the [sourceId 位置]
  // notes-marker explanation.
  assert.equal(packageJson.version, "0.1.6");
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
