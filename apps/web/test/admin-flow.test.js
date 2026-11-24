import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminFlow, changedCapabilityKeys, shouldShowAdminEntry, presentRowStatus } from "../public/js/admin.js";

// Round-4 admin flow (contract-r4 §3.2/§3.3, ticket 6.2 / issue #87): the
// site-capability table for administrators. The pure module owns every
// decision — the table load, the per-row toggle state, the only-changed-keys
// patch computation, the D2 non-admin 404 presentation and the row-level
// save status — while the page only binds snapshots to the DOM.
//
// The api seam is faked with the exact shape createApiClient exposes
// (getAdminSiteCapabilities / updateAdminSiteCapability returning
// { ok, status, data }); the fixtures pin the wire shapes.

const FIXTURES_DIR = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "..",
  "..",
  "contracts",
  "fixtures",
);
const siteCapabilityExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "site-capability-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);
// The round-4 error samples live at the tail of error-examples.json (the
// capability fixture's own description pins that location).
const errorExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "error-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);

const ADMIN_LIST = siteCapabilityExampleById.get("api-admin-site-capabilities-list").response.body;
const ADMIN_UPDATE = siteCapabilityExampleById.get("api-admin-site-capability-update");
const NOT_ADMIN_ENVELOPE = errorExampleById.get("error-admin-site-capabilities-not-admin").response.body;
const UNKNOWN_PLATFORM_ENVELOPE = errorExampleById.get("error-admin-site-capability-unknown-platform").response.body;

/** Fake api: script the next result of each admin method; record calls. */
function fakeApi({ listResults, listResult, updateResults, updateResult } = {}) {
  const calls = { adminList: 0, adminUpdate: [] };
  const listQueue = listResults ? [...listResults] : [];
  const updateQueue = updateResults ? [...updateResults] : [];
  return {
    calls,
    async getAdminSiteCapabilities() {
      calls.adminList += 1;
      if (listQueue.length > 0) {
        return listQueue.shift();
      }
      return listResult || { ok: true, status: 200, data: ADMIN_LIST };
    },
    async updateAdminSiteCapability(platformId, patch) {
      calls.adminUpdate.push({ platformId, patch });
      if (updateQueue.length > 0) {
        return updateQueue.shift();
      }
      return updateResult || { ok: true, status: 200, data: ADMIN_UPDATE.response.body };
    },
  };
}

function rowByPlatform(rows, platformId) {
  return rows.find((row) => row.platformId === platformId);
}

test("load() fills the table from the admin GET; every row starts unchanged", async () => {
  const api = fakeApi();
  const flow = createAdminFlow({ api });

  const result = await flow.load();

  const state = flow.getState();
  assert.equal(result.ok, true);
  assert.equal(state.view, "table");
  assert.equal(state.rows.length, 5);
  assert.deepEqual(
    state.rows.map((row) => row.platformId),
    ["bilibili", "youtube", "xiaoe", "xiaohongshu", "xiaoyuzhou"],
  );
  // The fixture pins the seed defaults: bilibili/youtube all-on, the others
  // without captions capture.
  assert.deepEqual(rowByPlatform(state.rows, "bilibili"), {
    platformId: "bilibili",
    captions: true,
    asr: true,
    enabled: true,
    saved: { captions: true, asr: true, enabled: true },
    changedKeys: [],
    saveState: "idle",
    saveError: null,
  });
  assert.deepEqual(rowByPlatform(state.rows, "xiaoe").saved, { captions: false, asr: true, enabled: true });
  assert.equal(rowByPlatform(state.rows, "xiaohongshu").captions, false);
});

test("load() with the non-admin 404 presents the denied view, envelope verbatim", async () => {
  const api = fakeApi({ listResult: { ok: false, status: 404, data: NOT_ADMIN_ENVELOPE } });
  const flow = createAdminFlow({ api });

  await flow.load();

  const state = flow.getState();
  assert.equal(state.view, "denied");
  assert.equal(state.error, "接口不存在或无权访问");
  assert.equal(state.rows.length, 0);
});

test("load() with an unusable 404 envelope still falls back to the D2 wording", async () => {
  const api = fakeApi({ listResult: { ok: false, status: 404, data: null } });
  const flow = createAdminFlow({ api });

  await flow.load();

  const state = flow.getState();
  assert.equal(state.view, "denied");
  assert.equal(state.error, "接口不存在或无权访问");
});

test("load() with another failure presents the envelope verbatim as a load error", async () => {
  const api = fakeApi({
    listResult: { ok: false, status: 0, data: { error: { code: "network_error", message: "无法连接服务器，请稍后重试" } } },
  });
  const flow = createAdminFlow({ api });

  await flow.load();

  const state = flow.getState();
  assert.equal(state.view, "error");
  assert.equal(state.error, "无法连接服务器，请稍后重试");
});

test("setToggle() flips only the targeted row and field; toggling back clears the diff", async () => {
  const api = fakeApi();
  const flow = createAdminFlow({ api });
  await flow.load();

  flow.setToggle("xiaoe", "captions", true);
  flow.setToggle("bilibili", "asr", false);
  flow.setToggle("bilibili", "enabled", false);

  let state = flow.getState();
  assert.deepEqual(rowByPlatform(state.rows, "xiaoe").changedKeys, ["captions"]);
  assert.equal(rowByPlatform(state.rows, "xiaoe").captions, true);
  assert.deepEqual(rowByPlatform(state.rows, "bilibili").changedKeys, ["asr", "enabled"]);
  assert.equal(rowByPlatform(state.rows, "youtube").captions, true);

  // Toggling a field back to its saved value removes it from the diff.
  flow.setToggle("bilibili", "asr", true);
  state = flow.getState();
  assert.deepEqual(rowByPlatform(state.rows, "bilibili").changedKeys, ["enabled"]);

  // Unknown platforms and non-capability fields are ignored.
  assert.equal(flow.setToggle("nope", "captions", true).ok, false);
  assert.equal(flow.setToggle("bilibili", "volume", true).ok, false);
  state = flow.getState();
  assert.deepEqual(rowByPlatform(state.rows, "bilibili").changedKeys, ["enabled"]);
});

test("patchFor() returns only the changed keys with their new values", async () => {
  const api = fakeApi();
  const flow = createAdminFlow({ api });
  await flow.load();

  flow.setToggle("bilibili", "captions", false);
  flow.setToggle("bilibili", "enabled", false);

  assert.deepEqual(flow.patchFor("bilibili"), { captions: false, enabled: false });
  assert.deepEqual(flow.patchFor("youtube"), {});
});

test("saveRow() PUTs only the changed keys and adopts the read-back row", async () => {
  const api = fakeApi();
  const flow = createAdminFlow({ api });
  await flow.load();

  flow.setToggle("bilibili", "captions", false);
  const result = await flow.saveRow("bilibili");

  assert.equal(result.ok, true);
  assert.deepEqual(api.calls.adminUpdate, [{ platformId: "bilibili", patch: { captions: false } }]);
  const row = rowByPlatform(flow.getState().rows, "bilibili");
  // The read-back (the fixture's updated row) becomes both the displayed
  // value and the new baseline: the row reads clean after the save.
  assert.equal(row.captions, false);
  assert.deepEqual(row.saved, { captions: false, asr: true, enabled: true });
  assert.deepEqual(row.changedKeys, []);
  assert.equal(row.saveState, "saved");
  assert.equal(row.saveError, null);
  assert.equal(presentRowStatus(row), "已保存");
});

test("saveRow() failure presents the envelope verbatim and keeps the row dirty", async () => {
  const api = fakeApi({
    updateResult: { ok: false, status: 404, data: UNKNOWN_PLATFORM_ENVELOPE },
  });
  const flow = createAdminFlow({ api });
  await flow.load();

  flow.setToggle("bilibili", "captions", false);
  const result = await flow.saveRow("bilibili");

  assert.equal(result.ok, false);
  const row = rowByPlatform(flow.getState().rows, "bilibili");
  assert.equal(row.saveState, "error");
  assert.equal(row.saveError, "平台不存在");
  assert.deepEqual(row.changedKeys, ["captions"]);
  assert.equal(row.captions, false);
  assert.equal(presentRowStatus(row), "平台不存在");
});

test("saveRow() with no changes sends nothing", async () => {
  const api = fakeApi();
  const flow = createAdminFlow({ api });
  await flow.load();

  const result = await flow.saveRow("youtube");

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(api.calls.adminUpdate.length, 0);
});

test("saveRow() ignores re-entry while a save is in flight", async () => {
  let releaseSave;
  const api = {
    async getAdminSiteCapabilities() {
      return { ok: true, status: 200, data: ADMIN_LIST };
    },
    updateAdminSiteCapability(platformId, patch) {
      return new Promise((resolve) => {
        releaseSave = () => resolve({ ok: true, status: 200, data: ADMIN_UPDATE.response.body });
      });
    },
  };
  const flow = createAdminFlow({ api });
  await flow.load();
  flow.setToggle("bilibili", "captions", false);

  const pending = flow.saveRow("bilibili");
  const reentry = await flow.saveRow("bilibili");

  assert.equal(reentry.ok, false);
  assert.equal(flow.getState().rows.find((row) => row.platformId === "bilibili").saveState, "saving");
  releaseSave();
  await pending;
});

test("reset() returns to the idle view with no rows", async () => {
  const api = fakeApi();
  const flow = createAdminFlow({ api });
  await flow.load();

  flow.reset();

  const state = flow.getState();
  assert.equal(state.view, "idle");
  assert.equal(state.rows.length, 0);
  assert.equal(state.error, null);
});

test("changedCapabilityKeys() diffs booleans against the saved baseline", () => {
  assert.deepEqual(changedCapabilityKeys({ captions: true, asr: true, enabled: true }, { captions: true, asr: true, enabled: true }), []);
  assert.deepEqual(changedCapabilityKeys({ captions: false, asr: true, enabled: true }, { captions: true, asr: true, enabled: true }), ["captions"]);
  assert.deepEqual(changedCapabilityKeys({ captions: false, asr: false, enabled: false }, { captions: true, asr: true, enabled: true }), ["captions", "asr", "enabled"]);
});

test("shouldShowAdminEntry() follows only the account's isAdmin flag", () => {
  assert.equal(shouldShowAdminEntry({ id: "acc_01", email: "owner@example.com", isAdmin: true }), true);
  assert.equal(shouldShowAdminEntry({ id: "acc_02", email: "learner@example.com", isAdmin: false }), false);
  // Legacy accounts predate the field and read as non-admin.
  assert.equal(shouldShowAdminEntry({ id: "acc_03", email: "legacy@example.com" }), false);
  assert.equal(shouldShowAdminEntry({ isAdmin: "yes" }), false);
  assert.equal(shouldShowAdminEntry(null), false);
  assert.equal(shouldShowAdminEntry(undefined), false);
});

test("presentRowStatus() renders the row-level save states", () => {
  assert.equal(presentRowStatus({ saveState: "idle", saveError: null }), "");
  assert.equal(presentRowStatus({ saveState: "saving", saveError: null }), "保存中…");
  assert.equal(presentRowStatus({ saveState: "saved", saveError: null }), "已保存");
  assert.equal(presentRowStatus({ saveState: "error", saveError: "captions 必须是布尔值" }), "captions 必须是布尔值");
  assert.equal(presentRowStatus(null), "");
});
