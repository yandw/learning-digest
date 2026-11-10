const test = require("node:test");
const assert = require("node:assert/strict");

// The pure note state machine behind the extension's library-note entry
// (issue #61): contract §3.6 POST /v1/resources/{id}/notes request building
// (clientRequestId + optional sourceId/positionMs pair), the seconds→ms
// position mapping from the page-bridge media stream, the 201/200 response
// mapping, and the network-failure draft policy (kept locally, resent with
// the SAME clientRequestId until a send succeeds). Expected values come
// from contracts/fixtures/api-examples.json, not from the code.

const YTD_NOTES = require("../notes.js");

const CREATED_NOTE = {
  id: "note_01JABC0021",
  resourceId: "res_01JABC0001",
  sourceId: "src_01JABC0002",
  positionMs: 200000,
  text: "3:20 起的例子值得回看",
  clientRequestId: "note-req-001",
  createdAt: "2026-11-10T08:30:00Z",
};

// --- buildNotesPath -----------------------------------------------------------

test("buildNotesPath targets the resource's notes endpoint with an encoded id", () => {
  assert.equal(YTD_NOTES.buildNotesPath("res_01JABC0001"), "/v1/resources/res_01JABC0001/notes");
  // Ids are opaque; a hostile value must not change the path shape.
  assert.equal(YTD_NOTES.buildNotesPath("res/a?b"), "/v1/resources/res%2Fa%3Fb/notes");
});

// --- positionMsFromSeconds ----------------------------------------------------

test("positionMsFromSeconds maps the page-bridge seconds to integer milliseconds", () => {
  assert.equal(YTD_NOTES.positionMsFromSeconds(200), 200000);
  assert.equal(YTD_NOTES.positionMsFromSeconds(3.25), 3250);
  assert.equal(YTD_NOTES.positionMsFromSeconds(0), 0);
  assert.equal(YTD_NOTES.positionMsFromSeconds(200.0005), 200001, "rounds, never truncates");
});

test("positionMsFromSeconds rejects unusable positions (null, caller falls back to a plain note)", () => {
  assert.equal(YTD_NOTES.positionMsFromSeconds(null), null);
  assert.equal(YTD_NOTES.positionMsFromSeconds(undefined), null);
  assert.equal(YTD_NOTES.positionMsFromSeconds(Number.NaN), null);
  assert.equal(YTD_NOTES.positionMsFromSeconds(-1), null);
  assert.equal(YTD_NOTES.positionMsFromSeconds(Number.POSITIVE_INFINITY), null);
});

// --- buildNoteRequest ---------------------------------------------------------

test("buildNoteRequest sends clientRequestId, text and the sourceId+positionMs pair", () => {
  const body = YTD_NOTES.buildNoteRequest({
    clientRequestId: "note-req-001",
    text: "3:20 起的例子值得回看",
    sourceId: "src_01JABC0002",
    positionMs: 200000,
  });
  assert.deepEqual(body, {
    clientRequestId: "note-req-001",
    text: "3:20 起的例子值得回看",
    sourceId: "src_01JABC0002",
    positionMs: 200000,
  });
});

test("buildNoteRequest sends a plain webpage note without source or position", () => {
  const body = YTD_NOTES.buildNoteRequest({
    clientRequestId: "note-req-002",
    text: "这篇的复利概念可以整理进学习计划",
    sourceId: null,
    positionMs: null,
  });
  assert.deepEqual(body, {
    clientRequestId: "note-req-002",
    text: "这篇的复利概念可以整理进学习计划",
  });
  assert.equal("sourceId" in body, false);
  assert.equal("positionMs" in body, false);
});

test("buildNoteRequest returns null for an empty text (the contract 400s on it)", () => {
  assert.equal(YTD_NOTES.buildNoteRequest({ clientRequestId: "r1", text: "   " }), null);
  assert.equal(YTD_NOTES.buildNoteRequest({ clientRequestId: "r1", text: "" }), null);
  assert.equal(YTD_NOTES.buildNoteRequest({ clientRequestId: "r1", text: undefined }), null);
});

test("buildNoteRequest returns null for a broken sourceId/positionMs pair (client-side guard)", () => {
  assert.equal(
    YTD_NOTES.buildNoteRequest({ clientRequestId: "r1", text: "a", sourceId: "src_1", positionMs: null }),
    null,
    "sourceId without positionMs",
  );
  assert.equal(
    YTD_NOTES.buildNoteRequest({ clientRequestId: "r1", text: "a", sourceId: null, positionMs: 1000 }),
    null,
    "positionMs without sourceId",
  );
  assert.equal(
    YTD_NOTES.buildNoteRequest({ clientRequestId: "r1", text: "a", sourceId: "src_1", positionMs: -5 }),
    null,
    "negative positionMs",
  );
  assert.equal(
    YTD_NOTES.buildNoteRequest({ clientRequestId: "r1", text: "a", sourceId: "", positionMs: 1000 }),
    null,
    "empty sourceId",
  );
});

test("buildNoteRequest trims the text and requires a clientRequestId", () => {
  const body = YTD_NOTES.buildNoteRequest({
    clientRequestId: "r1",
    text: "  前后有空白  ",
    sourceId: null,
    positionMs: null,
  });
  assert.equal(body.text, "前后有空白");
  assert.equal(YTD_NOTES.buildNoteRequest({ text: "no id" }), null);
  assert.equal(YTD_NOTES.buildNoteRequest({ clientRequestId: "", text: "x" }), null);
});

// --- createClientRequestId ----------------------------------------------------

test("createClientRequestId combines a timestamp and randomness", () => {
  const id = YTD_NOTES.createClientRequestId({
    now: () => 1731217800000,
    random: () => 0.25,
  });
  // Deterministic under injected seams; format: note-<base36 ms>-<base36 random>.
  assert.equal(id, `note-${(1731217800000).toString(36)}-${Math.floor(0.25 * 1e9).toString(36)}`);
  assert.match(id, /^note-[a-z0-9]+-[a-z0-9]+$/);
});

test("two generated ids differ (random part is not constant)", () => {
  const a = YTD_NOTES.createClientRequestId({ now: () => 1, random: () => 0.1 });
  const b = YTD_NOTES.createClientRequestId({ now: () => 1, random: () => 0.2 });
  assert.notEqual(a, b);
});

// --- parseNoteResponse --------------------------------------------------------

test("parseNoteResponse maps 201 to a created outcome with the note verbatim", () => {
  const result = YTD_NOTES.parseNoteResponse({ status: 201, data: { note: CREATED_NOTE } });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "created");
  assert.deepEqual(result.note, CREATED_NOTE);
  assert.equal(result.message, null);
});

test("parseNoteResponse maps 200 to the idempotent outcome with the original note", () => {
  const result = YTD_NOTES.parseNoteResponse({ status: 200, data: { note: CREATED_NOTE } });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "idempotent");
  assert.deepEqual(result.note, CREATED_NOTE);
});

test("parseNoteResponse surfaces the contract envelope message verbatim", () => {
  const result = YTD_NOTES.parseNoteResponse({
    status: 400,
    data: { error: { code: "validation_failed", message: "笔记正文不能为空" } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.note, null);
  assert.equal(result.message, "笔记正文不能为空");
});

test("parseNoteResponse flags a 401 so the wiring can route back to the gate", () => {
  const result = YTD_NOTES.parseNoteResponse({
    status: 401,
    data: { error: { code: "unauthorized", message: "凭据已失效，请重新登录并关联" } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.unauthorized, true);
  assert.equal(result.message, "凭据已失效，请重新登录并关联");
});

test("parseNoteResponse tolerates a non-JSON or malformed response", () => {
  const malformed = YTD_NOTES.parseNoteResponse({ status: 502, data: null });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.unauthorized, false);
  assert.ok(typeof malformed.message === "string" && malformed.message.length > 0);

  const badShape = YTD_NOTES.parseNoteResponse({ status: 201, data: { note: { id: 1 } } });
  assert.equal(badShape.ok, false);
});

// --- draft policy ---------------------------------------------------------------
//
// Policy: a note the learner meant to save must survive a network failure.
// The draft is written BEFORE the first send attempt, holds the request body
// it was built with, and lives until a send succeeds (201 or 200). A retry
// resends the draft verbatim — same clientRequestId (重发不换).

function fakeStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? { [key]: map.get(key) } : {};
    },
    async set(entries) {
      for (const [k, v] of Object.entries(entries)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) map.delete(k);
    },
  };
}

test("a draft is written before the first send and read back intact", async () => {
  const storage = fakeStorage();
  const draft = YTD_NOTES.buildDraft({
    resourceId: "res_01JABC0001",
    sourceId: "src_01JABC0002",
    positionMs: 200000,
    text: "3:20 起的例子值得回看",
    clientRequestId: "note-req-001",
    savedAt: 1731217800000,
  });
  await YTD_NOTES.writeDraft(storage, draft);
  const read = await YTD_NOTES.readDraft(storage);
  assert.deepEqual(read, draft);
});

test("a malformed stored draft reads as null instead of breaking the panel", async () => {
  const storage = fakeStorage();
  await storage.set({ [YTD_NOTES.DRAFT_STORAGE_KEY]: { text: 42 } });
  assert.equal(await YTD_NOTES.readDraft(storage), null);
  assert.equal(await YTD_NOTES.readDraft(fakeStorage()), null);
});

test("a successful send clears the draft; a failed one keeps it", async () => {
  const storage = fakeStorage();
  const draft = YTD_NOTES.buildDraft({
    resourceId: "res_1",
    sourceId: null,
    positionMs: null,
    text: "草稿",
    clientRequestId: "r-draft",
    savedAt: 1,
  });
  await YTD_NOTES.writeDraft(storage, draft);
  await YTD_NOTES.clearDraft(storage);
  assert.equal(await YTD_NOTES.readDraft(storage), null);
});

test("a resent draft rebuilds the exact request it was saved with (same clientRequestId)", () => {
  const draft = YTD_NOTES.buildDraft({
    resourceId: "res_1",
    sourceId: "src_1",
    positionMs: 65000,
    text: "草稿正文",
    clientRequestId: "r-draft",
    savedAt: 1,
  });
  const body = YTD_NOTES.buildNoteRequest({
    clientRequestId: draft.clientRequestId,
    text: draft.text,
    sourceId: draft.sourceId,
    positionMs: draft.positionMs,
  });
  assert.deepEqual(body, {
    clientRequestId: "r-draft",
    text: "草稿正文",
    sourceId: "src_1",
    positionMs: 65000,
  });
});
