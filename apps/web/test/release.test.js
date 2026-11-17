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

test("apps/web release metadata is 0.1.16", () => {
  const packageJson = readPackageJson();
  assert.equal(packageJson.name, "@learning-digest/web");
  // 0.1.16: 一份资料只有一份逐字稿 — mergeTranscriptViews folds every
  // session's transcript on the shared source timeline (overlapping ranges
  // keep one copy: longest text, captions over asr, smaller sessionId) and
  // the resource detail renders the single merged transcript with a
  // per-segment 来源 tag, instead of one duplicated block per session.
  // 0.1.15: the /v1 reverse proxy outlives the upstream AI provider timeout
  // (10s → 125s vs the API's 120s aiTimeoutMs), so slow-but-successful sync
  // generations stop surfacing a spurious 学习服务暂时不可用.
  // 0.1.14: align the collect form's labels, inputs and submit button; the
  // prefixed input no longer adds its inner control height to the wrapper.
  // 0.1.13 (issue #103): native React extension linking, account usage and
  // administrator site capabilities; the legacy page entries are retired.
  // 0.1.12 (issue #102): native React detail workbench for sources, notes,
  // session transcripts, summary history/citations, retitle and deletion.
  // 0.1.11 (issue #101): React + Ant Design login and learning-list shell,
  // with legacy detail compatibility and the original quick-delete flow.
  // 0.1.10 (issue #100): list-row delete clicks delegate from the stable
  // list, so the confirmation re-render cannot swallow the second click.
  // 0.1.9 (issue #99): extension detail deep links load the list before
  // opening the requested Resource, without a duplicate initial list load.
  // 0.1.8 (ticket 5.5, issue #94): the delete entry lands on the list rows
  // and the detail footer — two-step confirm (arm → 确认删除, blur/3s
  // revert), cascade notice on the detail, DELETE 404 presented as
  // 资料已不存在 (contract-r4 §8, D23).
  // 0.1.7 (round 4, ticket 6.2 / issue #87): the shell grows the
  // administrator's 站点管理 surface (isAdmin-driven nav entry, the
  // site-capability table with per-row boolean-subset saves, the D2
  // non-admin denied view) over the round-4 admin API.
  assert.equal(packageJson.version, "0.1.16");
  assert.equal(packageJson.private, true);
});

test("apps/web pins its React and Ant Design runtime dependencies", () => {
  const packageJson = readPackageJson();
  assert.equal(typeof packageJson.dependencies.react, "string");
  assert.equal(typeof packageJson.dependencies["react-dom"], "string");
  assert.equal(typeof packageJson.dependencies.antd, "string");
  assert.equal(typeof packageJson.devDependencies.vite, "string");
  assert.equal(typeof packageJson.devDependencies.jsdom, "string");
});

test("apps/web builds the React bundle before starting the Node production server", () => {
  const packageJson = readPackageJson();
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.scripts.dev, "vite");
  assert.equal(packageJson.scripts.build, "tsc --noEmit && vite build");
  assert.equal(packageJson.scripts.prestart, "npm run build");
  assert.equal(packageJson.scripts.start, "node server.js");
  assert.match(packageJson.scripts.test, /^node --test/);
  assert.equal(packageJson.scripts["test:ui"], "vitest run");
  assert.equal(packageJson.engines.node, "^22.12.0 || ^24.0.0 || >=26.0.0");
});
