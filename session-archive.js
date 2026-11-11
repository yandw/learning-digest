/**
 * Session archive client (Ticket 2.5, issue #68): the pure contract layer
 * between the extension and the round-2 Session endpoints. The background
 * service worker calls this module on the captions path — 开始学习 creates
 * the server Session (§3.1), the read captions archive directly (§3.3),
 * the transcript view polls (§3.5), and the P11 finish closes the Session
 * (§3.2). Copy strings and DOM stay in the panel.
 *
 * Contract-r2 (contracts/contract-r2.md), decisions D15:
 * - §3.3 archives the captions AS READ (按原样归档); the first submission
 *   locks the Session's origin to "captions" (201), a resend answers the
 *   stored archive (200, 首存为准); an asr-locked Session is 409
 *   transcript_origin_conflict and a finished one 409
 *   session_already_finished — both surface verbatim so the plugin's
 *   conflict feedback can never invent a kinder story.
 * - §3.5's TranscriptView carries four arrays always (records/gaps/pending/
 *   failed); the view→rows mappers below feed the panel's 逐字稿 tab so the
 *   字幕 / 转写中 / failed states render from one shape.
 *
 * Pure and require()-able — no chrome or DOM dependencies — following the
 * notes.js / learning-start.js pattern: fully covered by Node tests against
 * the contract fixtures, consumed by the service worker via importScripts.
 */
var YTD_SESSION_ARCHIVE = (() => {
  // Shared API client helpers (api-client.js): in Node tests we require
  // them, in the service worker the global arrives via importScripts.
  const apiClient =
    typeof YTD_API_CLIENT !== "undefined"
      ? YTD_API_CLIENT
      : require("./api-client.js");
  const parseEnvelope = apiClient.parseEnvelope;
  const envelopeCode = apiClient.envelopeCode;

  // ============================================================
  // PATHS (§1: opaque ids are encoded — a hostile id must not change
  // the path shape)
  // ============================================================

  function createSessionPath(sourceId) {
    return `/v1/sources/${encodeURIComponent(String(sourceId))}/sessions`;
  }

  function captionsArchivePath(sessionId) {
    return `/v1/sessions/${encodeURIComponent(String(sessionId))}/captions`;
  }

  function transcriptPath(sessionId) {
    return `/v1/sessions/${encodeURIComponent(String(sessionId))}/transcript`;
  }

  function finishPath(sessionId) {
    return `/v1/sessions/${encodeURIComponent(String(sessionId))}/finish`;
  }

  // ============================================================
  // POST /v1/sources/{id}/sessions (§3.1)
  // ============================================================

  /** The session shape §2.1 needs to be usable: an id to archive against. */
  function parseSessionBody(data) {
    const session = data && typeof data === "object" ? data.session : null;
    if (!session || typeof session !== "object") return null;
    if (typeof session.id !== "string" || session.id === "") return null;
    return session;
  }

  function buildCreateSessionRequest() {
    return {};
  }

  /** 201 {session} → ok; 401/404/409 → kinds; anything else → error. */
  function parseSessionResponse({ status, data } = {}) {
    const session = parseSessionBody(data);
    if (session && status >= 200 && status < 300) {
      return { ok: true, session, status };
    }
    return {
      ok: false,
      kind: failureKind(status),
      code: envelopeCode(data),
      message: parseEnvelope(data, defaultFailureMessage(status)),
      status: status ?? 0,
    };
  }

  // ============================================================
  // POST /v1/sessions/{id}/captions (§3.3)
  // ============================================================

  function isValidSegment(segment) {
    return (
      !!segment &&
      typeof segment === "object" &&
      Number.isInteger(segment.startMs) &&
      segment.startMs >= 0 &&
      Number.isInteger(segment.endMs) &&
      segment.endMs >= segment.startMs &&
      typeof segment.text === "string" &&
      segment.text.trim() !== ""
    );
  }

  /**
   * §3.3 request body: the read captions as-read. Null when anything is
   * malformed (including an empty array — there is nothing to archive, and
   * a pointless 400 round trip must stay off the wire).
   */
  function buildCaptionsArchiveRequest({ segments } = {}) {
    if (!Array.isArray(segments) || segments.length === 0) return null;
    if (!segments.every(isValidSegment)) return null;
    return {
      segments: segments.map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
      })),
    };
  }

  /**
   * §2.5 TranscriptView, checked field by field: the identifiers, the
   * session status, and the four arrays that are ALWAYS present (可为空).
   */
  function parseTranscriptView(data) {
    if (!data || typeof data !== "object") return null;
    if (typeof data.sessionId !== "string" || data.sessionId === "") return null;
    if (data.sessionStatus !== "active" && data.sessionStatus !== "finished") return null;
    const origin = data.origin === null || data.origin === undefined ? null : data.origin;
    if (origin !== null && origin !== "captions" && origin !== "asr") return null;
    for (const key of ["records", "gaps", "pending", "failed"]) {
      if (!Array.isArray(data[key])) return null;
    }
    return {
      sessionId: data.sessionId,
      sourceId:
        typeof data.sourceId === "string" ? data.sourceId : null,
      resourceId:
        typeof data.resourceId === "string" ? data.resourceId : null,
      sessionStatus: data.sessionStatus,
      origin,
      records: data.records,
      gaps: data.gaps,
      pending: data.pending,
      failed: data.failed,
    };
  }

  /** §3.3 response → verdict. 201 archived / 200 idempotent / failures. */
  function parseCaptionsArchiveResponse({ status, data } = {}) {
    const transcript = status >= 200 && status < 300 ? parseTranscriptView(data && data.transcript) : null;
    if (transcript) {
      return {
        ok: true,
        outcome: status === 201 ? "archived" : "idempotent",
        transcript,
        status,
      };
    }
    const code = envelopeCode(data);
    let kind = failureKind(status);
    if (status === 409) {
      kind = code === "session_already_finished" ? "alreadyFinished" : "originConflict";
    }
    if (status === 400) kind = "validation";
    return {
      ok: false,
      kind,
      code,
      message: parseEnvelope(data, defaultFailureMessage(status)),
      status: status ?? 0,
    };
  }

  // ============================================================
  // GET /v1/sessions/{id}/transcript (§3.5)
  // ============================================================

  function parseTranscriptResponse({ status, data } = {}) {
    const view = status >= 200 && status < 300 ? parseTranscriptView(data) : null;
    if (view) return { ok: true, view, status };
    return {
      ok: false,
      kind: failureKind(status),
      code: envelopeCode(data),
      message: parseEnvelope(data, defaultFailureMessage(status)),
      status: status ?? 0,
    };
  }

  // ============================================================
  // TranscriptView → plugin transcript rows (the 逐字稿 tab's input)
  // ============================================================

  /** The ms range → {start, duration} seconds; null when not usable. */
  function rangeToSeconds(entry) {
    const startMs = Number(entry.startMs);
    const endMs = Number(entry.endMs);
    if (!Number.isFinite(startMs) || startMs < 0 || !Number.isFinite(endMs) || endMs < startMs) {
      return null;
    }
    return {
      start: Math.round(startMs) / 1000,
      duration: Math.max(0, Math.round(endMs - startMs) / 1000),
    };
  }

  /**
   * One §2.2 record → one panel row on the source timeline. The panel's
   * rows speak seconds (the position stream's unit), so the mapping is the
   * only place the ms→s conversion lives.
   */
  function recordToRow(record) {
    if (!record || typeof record !== "object") return null;
    const range = rangeToSeconds(record);
    const text = typeof record.text === "string" ? record.text : "";
    if (!range || text.trim() === "") return null;
    return { ...range, text };
  }

  /**
   * The view's records + failed[] as panel rows, sorted by start. A failed
   * ASR segment lands as the visible failure annotation (the same shape the
   * Speech-path [语音转录失败] marker uses), never as a silent hole.
   */
  function transcriptViewToTranscriptRecords(view) {
    if (!view || typeof view !== "object") return [];
    const rows = [];
    for (const record of Array.isArray(view.records) ? view.records : []) {
      const row = recordToRow(record);
      if (row) rows.push(row);
    }
    for (const failed of Array.isArray(view.failed) ? view.failed : []) {
      if (!failed || typeof failed !== "object") continue;
      const range = rangeToSeconds(failed);
      if (!range) continue;
      const message =
        failed.error && typeof failed.error.message === "string" && failed.error.message
          ? failed.error.message
          : "语音转写失败";
      rows.push({ ...range, failed: true, text: `[${message}]` });
    }
    rows.sort((a, b) => a.start - b.start);
    return rows;
  }

  /**
   * The view's pending[] as pending segments for the panel's 转写中 spinner
   * rows (the same pending-segment rendering the Speech path uses). Both
   * pending and transcribing statuses spin — the learner sees one state.
   */
  function transcriptViewToPendingSegments(view) {
    if (!view || typeof view !== "object") return [];
    const segments = [];
    for (const pending of Array.isArray(view.pending) ? view.pending : []) {
      if (!pending || typeof pending !== "object") continue;
      const range = rangeToSeconds(pending);
      if (!range) continue;
      const index = Number(pending.segmentIndex);
      segments.push({
        id: `srv_${Number.isFinite(index) ? index : segments.length}`,
        ...range,
        status: "pending",
      });
    }
    segments.sort((a, b) => a.start - b.start);
    return segments;
  }

  // ============================================================
  // POST /v1/sessions/{id}/finish (§3.2)
  // ============================================================

  /**
   * §3.2 request body: the explicit skipped ranges (reason is fixed
   * "skipped" server-side, so it is not sent). No gaps → the empty body
   * the fixtures use. Null when a gap is inverted or unbounded — the
   * contract's 400 stays off the wire.
   */
  function buildFinishRequest({ gaps } = {}) {
    if (gaps === undefined || gaps === null) return {};
    if (!Array.isArray(gaps)) return null;
    if (gaps.length === 0) return {};
    const normalized = [];
    for (const gap of gaps) {
      if (
        !gap ||
        typeof gap !== "object" ||
        !Number.isInteger(gap.startMs) ||
        gap.startMs < 0 ||
        !Number.isInteger(gap.endMs) ||
        gap.endMs <= gap.startMs
      ) {
        return null;
      }
      normalized.push({ startMs: gap.startMs, endMs: gap.endMs });
    }
    return { gaps: normalized };
  }

  function parseFinishResponse({ status, data } = {}) {
    const session = status >= 200 && status < 300 ? parseSessionBody(data) : null;
    if (session) return { ok: true, session, status };
    const code = envelopeCode(data);
    let kind = failureKind(status);
    if (status === 409) {
      kind = code === "session_already_finished" ? "alreadyFinished" : "error";
    }
    return {
      ok: false,
      kind,
      code,
      message: parseEnvelope(data, defaultFailureMessage(status)),
      status: status ?? 0,
    };
  }

  // ============================================================
  // Shared failure classification (§1 envelope + §4 codes)
  // ============================================================

  function failureKind(status) {
    if (status === 401) return "unauthorized";
    if (status === 404) return "notFound";
    if (status === 409) return "conflict";
    if (status === 400) return "validation";
    return "error";
  }

  function defaultFailureMessage(status) {
    if (status === 401) return "学习库授权已失效，请重新关联账号";
    if (status === 404) return "学习记录不存在或无权访问";
    return "学习库请求失败，请稍后重试";
  }

  return {
    createSessionPath,
    captionsArchivePath,
    transcriptPath,
    finishPath,
    buildCreateSessionRequest,
    parseSessionResponse,
    buildCaptionsArchiveRequest,
    parseCaptionsArchiveResponse,
    parseTranscriptView,
    parseTranscriptResponse,
    transcriptViewToTranscriptRecords,
    transcriptViewToPendingSegments,
    buildFinishRequest,
    parseFinishResponse,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SESSION_ARCHIVE;
}
