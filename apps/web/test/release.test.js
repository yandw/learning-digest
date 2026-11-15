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

test("apps/web release metadata is 0.1.8", () => {
  const packageJson = readPackageJson();
  assert.equal(packageJson.name, "@learning-digest/web");
  // 0.1.8 (ticket 5.5, issue #94): the delete entry lands on the list rows
  // and the detail footer — two-step confirm (arm → 确认删除, blur/3s
  // revert), cascade notice on the detail, DELETE 404 presented as
  // 资料已不存在 (contract-r4 §8, D23).
  // 0.1.7 (round 4, ticket 6.2 / issue #87): the shell grows the
  // administrator's 站点管理 surface (isAdmin-driven nav entry, the
  // site-capability table with per-row boolean-subset saves, the D2
  // non-admin denied view) over the round-4 admin API.
  assert.equal(packageJson.version, "0.1.8");
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
