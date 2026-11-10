/**
 * The P12 timestamp-note path on the P10b stations (#63): the page bridge
 * now injects on bilibili/youtube/xiaohongshu playback pages, so
 * getMediaPosition has a receiver there and the save-note handler stamps
 * the note with the bridged position. Before P10b these pages had no
 * bridge — the same flow fell back to a plain note, which is exactly what
 * must still happen when no media answers (image-text notes, pre-injection
 * tabs). Notes behavior itself is untouched (P12, #61); this pins the
 * upgrade the new injection buys.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

const BILI_P2 = "https://www.bilibili.com/video/BV1ab411L78c?p=2";

const RESOLVE_MATCHED_BODY = {
  matched: true,
  resource: {
    id: "res_01JABC0001",
    title: "视频课",
    kind: "video",
    createdAt: "2026-11-10T08:00:00Z",
  },
  source: {
    id: "src_01JBILI0001",
    resourceId: "res_01JABC0001",
    kind: "video",
    url: BILI_P2,
    platformId: "bilibili",
    platformVideoId: "BV1ab411L78c",
    episodeId: "2",
    platformScopeId: null,
    progress: { positionMs: 300000, revision: 4 },
  },
};

const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.example.com/ai",
    aiModel: "test-model",
    apiBaseUrl: "https://api.example.com",
    speechProvider: "groq",
    speechProviders: { groq: { apiKey: "groq-key" } },
    segmentLengthSeconds: 60,
    ...overrides,
  };
}

/** Scripted /v1 fetch seam: resolve + the notes POST, both recorded. */
function v1Fetch() {
  const v1Calls = [];
  const fetchImpl = async (url, init) => {
    const path = String(url).replace(/^https:\/\/api\.example\.com/, "");
    if (path === "/v1/sources/resolve") {
      v1Calls.push({ path, body: JSON.parse(init.body) });
      return { status: 200, ok: true, json: async () => RESOLVE_MATCHED_BODY };
    }
    if (/^\/v1\/resources\/[^/]+\/notes$/.test(path)) {
      v1Calls.push({ path, body: JSON.parse(init.body) });
      return {
        status: 201,
        ok: true,
        json: async () => ({ note: { id: "note_01JNOTE", text: JSON.parse(init.body).text } }),
      };
    }
    return { status: 404, ok: false, json: async () => ({}) };
  };
  return { v1Calls, fetchImpl };
}

test("a note saved on a bilibili video page carries the bridged media position (P10b #63)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch();
  const tabMessages = [];
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsQuery: async () => [{ id: 5, url: BILI_P2, title: "视频课 P2" }],
    // The injected bridge answers the one-shot query with the player's
    // position in seconds — the exact response shape page-bridge.js sends.
    tabMessageImpl: (msg) =>
      msg.action === "getMediaPosition" ? { success: true, position: 125.25 } : { success: true },
    tabMessages,
    fetchImpl,
  });

  const result = await helpers.handleSaveNoteToLibrary({ text: "二分查找的关键边界" });

  assert.equal(result.ok, true, result.message || "");
  assert.equal(result.note.id, "note_01JNOTE");
  assert.deepEqual(
    v1Calls.find((call) => call.path.startsWith("/v1/resources/")).body,
    {
      clientRequestId: result.note.clientRequestId ?? v1Calls.at(-1).body.clientRequestId,
      text: "二分查找的关键边界",
      sourceId: "src_01JBILI0001",
      // 125.25s → the contract's integer milliseconds.
      positionMs: 125250,
    },
  );
  assert.equal(
    tabMessages.some((msg) => msg.action === "getMediaPosition"),
    true,
    "the worker sampled the tab's media position through the bridge",
  );
});

test("without a bridged answer the note stays plain (the P12 fallback itself)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch();
  const helpers = loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsQuery: async () => [{ id: 5, url: BILI_P2, title: "视频课 P2" }],
    // No receiver in the frame (image-text note page, or pre-injection):
    // the worker gets nothing and the note goes out without a timestamp
    // instead of guessing.
    tabMessageImpl: (msg) =>
      msg.action === "getMediaPosition" ? undefined : { success: true },
    fetchImpl,
  });

  const result = await helpers.handleSaveNoteToLibrary({ text: "先记一笔" });

  assert.equal(result.ok, true, result.message || "");
  const body = v1Calls.find((call) => call.path.startsWith("/v1/resources/")).body;
  assert.equal(body.sourceId, undefined);
  assert.equal(body.positionMs, undefined);
  assert.equal(body.text, "先记一笔");
});
