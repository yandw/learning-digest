/**
 * Library-note state machine (P12, issue #61): the pure contract layer
 * between the extension and POST /v1/resources/{id}/notes. The background
 * service worker calls this module when the side panel's library-note entry
 * fires; copy strings and DOM stay in the panel.
 *
 * Contract v1 (contracts/contract-v1.md):
 * - §3.6 POST /v1/resources/{id}/notes — { clientRequestId, text, sourceId?,
 *   positionMs? }; 201 creates, 200 returns the original note for a resent
 *   clientRequestId (idempotent resend). sourceId + positionMs are an
 *   optional PAIR naming one of the resource's own sources; a plain webpage
 *   note carries neither.
 * - §2.4 Note — positionMs is the millisecond position on the Source; the
 *   page bridge reports media positions in seconds, so the mapping rounds
 *   to whole milliseconds here.
 * - §1 error envelope — non-2xx bodies are { error: { code, message } } and
 *   the message is what the learner sees; a 401 is flagged so the wiring
 *   routes back through the P6 authorization gate.
 *
 * Draft policy (network failure): the note request is written to a local
 * draft BEFORE the first send attempt and stays there until a send
 * succeeds (201 or 200). A retry resends the draft verbatim — same
 * clientRequestId (重发不换) — so the server's idempotency keeps the result
 * to one note however many times the send is retried.
 *
 * Pure and require()-able — no chrome or DOM dependencies — following the
 * collect.js pattern: fully covered by Node tests, consumed by the service
 * worker via importScripts.
 */
var YTD_NOTES = (() => {
  const DRAFT_STORAGE_KEY = "ytd_note_draft";

  const GENERIC_NOTE_ERROR = "笔记没有保存，请稍后重试";
  const UNAUTHORIZED_MESSAGE = "学习库授权已失效，请重新关联账号";

  /**
   * §3.6 path for one resource. Ids are opaque (contract §1), so the value
   * is encoded — a hostile id must not change the path shape.
   */
  function buildNotesPath(resourceId) {
    return `/v1/resources/${encodeURIComponent(String(resourceId))}/notes`;
  }

  /**
   * Page-bridge positions are seconds (media.currentTime); the contract
   * wants integer milliseconds. Returns null for anything unusable — the
   * caller then falls back to a plain note instead of guessing.
   */
  function positionMsFromSeconds(seconds) {
    if (typeof seconds !== "number") return null;
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }

  /**
   * §3.6 request body. Null when the note cannot be valid: an empty text
   * (the API's fixture 400), a missing clientRequestId, or a broken
   * sourceId/positionMs pair — catching these locally keeps the pointless
   * 400 round trip off the wire.
   */
  function buildNoteRequest({ clientRequestId, text, sourceId, positionMs } = {}) {
    if (typeof clientRequestId !== "string" || clientRequestId.trim() === "") return null;
    if (typeof text !== "string" || text.trim() === "") return null;
    const hasSource = sourceId !== undefined && sourceId !== null && sourceId !== "";
    const hasPosition = positionMs !== undefined && positionMs !== null;
    if (hasSource !== hasPosition) return null;
    if (hasSource && (!Number.isInteger(positionMs) || positionMs < 0)) return null;

    const body = { clientRequestId: clientRequestId.trim(), text: text.trim() };
    if (hasSource) {
      body.sourceId = sourceId;
      body.positionMs = positionMs;
    }
    return body;
  }

  /**
   * The client-generated request id: a millisecond timestamp plus a random
   * part (base36), so ids from one device never collide. Both seams are
   * injectable for tests; the retry path reuses the stored id instead of
   * calling this again (重发不换).
   */
  function createClientRequestId({ now = Date.now, random = Math.random } = {}) {
    const ms = Math.max(0, Math.floor(Number(now()) || 0));
    const randomPart = Math.floor(Math.abs(Number(random()) || 0) * 1e9);
    return `note-${ms.toString(36)}-${randomPart.toString(36)}`;
  }

  /** §1 error envelope: the server's Chinese message when well-formed. */
  function parseEnvelope(data, fallback) {
    const message = data && data.error && data.error.message;
    return typeof message === "string" && message ? message : fallback;
  }

  function envelopeCode(data) {
    const code = data && data.error && data.error.code;
    return typeof code === "string" ? code : null;
  }

  /** The §2.4 note shape, checked field by field. */
  function parseNoteBody(data) {
    if (!data || typeof data !== "object") return null;
    const note = data.note;
    if (!note || typeof note !== "object") return null;
    if (typeof note.id !== "string" || note.id === "") return null;
    if (typeof note.text !== "string") return null;
    return note;
  }

  /**
   * §3.6 response → outcome. 201 means "created", 200 means "the resend
   * hit the original note" (idempotent). Any other status — or a 2xx body
   * without a well-formed note — is a failure carrying the envelope
   * message; a 401 additionally sets unauthorized so the wiring sends the
   * panel back through the authorization gate.
   *
   * @returns {{ok: boolean, outcome: "created"|"idempotent"|null, note, status: number, unauthorized: boolean, code: string|null, message: string|null}}
   */
  function parseNoteResponse({ status, data } = {}) {
    const note = parseNoteBody(data);
    if (note && (status === 201 || status === 200)) {
      return {
        ok: true,
        outcome: status === 201 ? "created" : "idempotent",
        note,
        status,
        unauthorized: false,
        code: null,
        message: null,
      };
    }
    return {
      ok: false,
      outcome: null,
      note: null,
      status: status ?? 0,
      unauthorized: status === 401,
      code: envelopeCode(data),
      message: parseEnvelope(data, status === 401 ? UNAUTHORIZED_MESSAGE : GENERIC_NOTE_ERROR),
    };
  }

  /**
   * The local draft (network-failure policy): what a retry needs to resend
   * the note verbatim — the request fields plus where it was aimed and
   * when it was stashed. Written before the first send attempt.
   */
  function buildDraft({ resourceId, sourceId, positionMs, text, clientRequestId, savedAt }) {
    return {
      resourceId: String(resourceId),
      sourceId: sourceId === undefined || sourceId === null ? null : String(sourceId),
      positionMs: Number.isInteger(positionMs) && positionMs >= 0 ? positionMs : null,
      text: String(text),
      clientRequestId: String(clientRequestId),
      savedAt: Number(savedAt) || 0,
    };
  }

  /** Reads the stored draft; a malformed record behaves like "no draft". */
  async function readDraft(storage) {
    try {
      const result = await storage.get(DRAFT_STORAGE_KEY);
      const raw = result && result[DRAFT_STORAGE_KEY];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (typeof raw.text !== "string" || raw.text === "") return null;
      if (typeof raw.clientRequestId !== "string" || raw.clientRequestId === "") return null;
      if (typeof raw.resourceId !== "string" || raw.resourceId === "") return null;
      return buildDraft(raw);
    } catch (_error) {
      return null;
    }
  }

  async function writeDraft(storage, draft) {
    await storage.set({ [DRAFT_STORAGE_KEY]: draft });
  }

  /** Success (201/200) or an explicit discard: the draft is done. */
  async function clearDraft(storage) {
    await storage.remove(DRAFT_STORAGE_KEY);
  }

  return {
    DRAFT_STORAGE_KEY,
    GENERIC_NOTE_ERROR,
    UNAUTHORIZED_MESSAGE,
    buildNotesPath,
    positionMsFromSeconds,
    buildNoteRequest,
    createClientRequestId,
    parseNoteResponse,
    buildDraft,
    readDraft,
    writeDraft,
    clearDraft,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_NOTES;
}
