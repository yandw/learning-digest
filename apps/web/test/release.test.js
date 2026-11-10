import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Release metadata for the Web unit (AGENTS.md: apps/web's first runnable
// version starts at 0.1.0 in its own release metadata; the root 0.2.0
// belongs to the Chrome extension and is not touched from here).

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(webRoot, "package.json"), "utf8"));
}

test("apps/web release metadata is 0.1.1", () => {
  const packageJson = readPackageJson();
  assert.equal(packageJson.name, "@learning-digest/web");
  assert.equal(packageJson.version, "0.1.1");
  assert.equal(packageJson.private, true);
});

test("apps/web ships zero npm dependencies", () => {
  const packageJson = readPackageJson();
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});

test("apps/web runs with node builtins only (ESM, start + test scripts)", () => {
  const packageJson = readPackageJson();
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.scripts.start, "node server.js");
  assert.match(packageJson.scripts.test, /^node --test/);
  assert.match(packageJson.engines.node, /^>=18$/);
});
