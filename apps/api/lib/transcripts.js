/**
 * Transcript domain (contract-r2.md §2.2–2.5, §3.3, §3.5; decisions D14, D15).
 *
 * Owns the "transcripts" collection: one document per Session, keyed by the
 * session id —
 *
 *   { sessionId, records: TranscriptRecord[], gaps: Gap[], segments: {index: Segment} }
 *
 * `records` are the archived text (captions as-read, or ASR results), `gaps`
 * the explicit skipped ranges reported at finish (§2.3: reason "skipped" —
 * caption holes and transcription failures never land here, D15), and
 * `segments` the per-audio-segment task states (§2.4) whose pending/failed
 * projection feeds the TranscriptView. The view serializer
 * (transcriptView below) is the single shape shared by the captions
 * response, the polling endpoint and the resource-detail summary.
 *
 * Same-interval single path (D15): the Session's `origin` locks on the
 * first submission — captions lock "captions", the first audio segment
 * locks "asr" — and the reverse path is a 409 transcript_origin_conflict.
 *
 * WRITE INTERFACE FOR TICKET 2.3 (audio-segments / worker endpoints): this
 * module keeps the storage primitives the 2.3 routes call — claimAudioOrigin,
 * upsertAudioSegment, applySegmentTranscribing/Done/Failed. They are plain
 * functions over ({ store, session, ... }) with no HTTP concerns, so 2.3
 * wires them behind its own auth + validation without touching this file's
 * state shape.
 */
const { ApiError, validationFailed, notFoundSession, sessionAlreadyFinished } = require("./errors");

/** Contract §3.3 conflict body (asr direction pinned by the fixture; the
 * captions direction mirrors it). */
function transcriptOriginConflict(lockedOrigin) {
  const where = lockedOrigin === "asr" ? "音频转写" : "字幕";
  return new ApiError(
    409,
    "transcript_origin_conflict",
    `本次学习已按${where}归档，同一区间只采用一种方式`,
  );
}

/** Fresh transcript state for a Session with no transcript data yet. */
function emptyState(sessionId) {
  return { sessionId, records: [], gaps: [], segments: {} };
}

/** Load one Session's transcript state (an empty one when nothing yet). */
function loadState(store, sessionId) {
  return store.get("transcripts", sessionId) || emptyState(sessionId);
}

/** Persist one Session's transcript state. */
function saveState(store, state) {
  store.set("transcripts", state.sessionId, state);
}

/** Non-negative integer field with a caller-supplied name for the message. */
function requireNonNegativeIntegerField(object, field, where) {
  const value = object[field];
  if (value === undefined || value === null) {
    throw validationFailed(`缺少必填字段 ${where}`);
  }
  if (!Number.isInteger(value) || value < 0) {
    throw validationFailed(`${where} 必须是非负整数`);
  }
  return value;
}

/**
 * Finish request gaps (contract §3.2): optional array of {startMs, endMs}
 * with endMs strictly greater than startMs; a missing body or a body
 * without gaps means "no gaps". Returns the normalized ranges; throws the
 * contract 400s on any malformation.
 */
function parseGaps(body) {
  if (body === undefined || body === null) {
    return [];
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw validationFailed("请求体必须是 JSON 对象");
  }
  if (body.gaps === undefined || body.gaps === null) {
    return [];
  }
  if (!Array.isArray(body.gaps)) {
    throw validationFailed("gaps 必须是数组");
  }
  return body.gaps.map((gap, index) => {
    if (gap === null || typeof gap !== "object" || Array.isArray(gap)) {
      throw validationFailed(`gaps[${index}] 必须是对象`);
    }
    const startMs = requireNonNegativeIntegerField(gap, "startMs", `gaps[${index}].startMs`);
    const endMs = requireNonNegativeIntegerField(gap, "endMs", `gaps[${index}].endMs`);
    if (endMs <= startMs) {
      throw validationFailed(`gaps[${index}] 的 endMs 必须大于 startMs`);
    }
    return { startMs, endMs };
  });
}

/**
 * Store the finish-reported skipped ranges (§2.3: reason "skipped"). The
 * ranges replace whatever was there — finish is the single gap producer,
 * reported once at close (回看补录成功的范围不再上报).
 */
function reportGaps({ store, sessionId, gaps }) {
  const state = loadState(store, sessionId);
  state.gaps = gaps.map((gap) => ({ ...gap, reason: "skipped" }));
  saveState(store, state);
}

/**
 * Caption segments of the archive request (contract §3.3): an array of
 * {startMs, endMs, text} on the source-video timeline, text non-empty.
 * Records are archived as-read — a missing caption range produces neither
 * a record nor a gap (D15). §2.2: endMs may equal startMs (zero-length
 * caption segment); only endMs < startMs is invalid.
 */
function parseCaptionSegments(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw validationFailed("请求体必须是 JSON 对象");
  }
  if (!Array.isArray(body.segments)) {
    throw validationFailed("缺少必填字段 segments");
  }
  return body.segments.map((segment, index) => {
    if (segment === null || typeof segment !== "object" || Array.isArray(segment)) {
      throw validationFailed(`segments[${index}] 必须是对象`);
    }
    const startMs = requireNonNegativeIntegerField(
      segment,
      "startMs",
      `segments[${index}].startMs`,
    );
    const endMs = requireNonNegativeIntegerField(segment, "endMs", `segments[${index}].endMs`);
    if (endMs < startMs) {
      throw validationFailed(`segments[${index}] 的 endMs 不能小于 startMs`);
    }
    if (typeof segment.text !== "string" || segment.text === "") {
      throw validationFailed(`segments[${index}].text 必须是非空字符串`);
    }
    return { startMs, endMs, text: segment.text };
  });
}

/**
 * Contract §2.5 TranscriptView — the single shape shared by the captions
 * response, the polling endpoint (§3.5) and the resource-detail summary.
 * All four arrays are always present (possibly empty). records sort by
 * startMs ascending; the pending/failed projections come from the audio
 * segment states in `segments` (always empty on the captions path).
 */
function transcriptView(session, state) {
  const segments = Object.values(state.segments);
  return {
    sessionId: session.id,
    sourceId: session.sourceId,
    resourceId: session.resourceId,
    sessionStatus: session.status,
    origin: session.origin,
    records: [...state.records].sort((a, b) => a.startMs - b.startMs),
    gaps: state.gaps,
    pending: segments
      .filter((s) => s.status === "pending" || s.status === "transcribing")
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map((s) => ({
        segmentIndex: s.segmentIndex,
        startMs: s.startMs,
        endMs: s.endMs,
        status: s.status,
      })),
    failed: segments
      .filter((s) => s.status === "failed")
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map((s) => ({
        segmentIndex: s.segmentIndex,
        startMs: s.startMs,
        endMs: s.endMs,
        error: { code: s.error.code, message: s.error.message },
      })),
  };
}

/**
 * §2.5 count projection for the resource-detail sessions[] (§3.6).
 */
function transcriptSummary(state) {
  const segments = Object.values(state.segments);
  return {
    recordCount: state.records.length,
    gapCount: state.gaps.length,
    failedCount: segments.filter((s) => s.status === "failed").length,
  };
}

/**
 * Archive captions on one Session (contract §3.3). The caller passes the
 * D2 lookup result (lib/sessions.findAccountSession) — a null session is
 * the same 404 whether the id is unknown or another account's. Order of
 * failures: 400 validation, then 404, then 409 finished (已结束不再接收,
 * which also covers resends), then 409 origin conflict (D15).
 *
 * First submission locks origin "captions" and answers 201 with the
 * archive; any later submission (断网重试) answers 200 with the STORED
 * content — 首存为准, never overwritten, never appended.
 */
function archiveCaptions({ store, session, body }) {
  const segments = parseCaptionSegments(body);
  if (!session) {
    throw notFoundSession();
  }
  if (session.status === "finished") {
    throw sessionAlreadyFinished();
  }

  const state = loadState(store, session.id);
  if (session.origin === "captions") {
    // Idempotent resend: the already-archived content, whatever the retry
    // carried.
    return { status: 200, body: { transcript: transcriptView(session, state) } };
  }
  if (session.origin === "asr") {
    throw transcriptOriginConflict("asr");
  }

  state.records = segments.map((segment) => ({ ...segment, origin: "captions" }));
  saveState(store, state);
  session.origin = "captions";
  store.set("sessions", session.id, session);
  return { status: 201, body: { transcript: transcriptView(session, state) } };
}

/**
 * Poll/Web read of one Session's transcript (contract §3.5): the bare
 * TranscriptView. Reads are idempotent; the view is monotonic because
 * done/failed are terminal states and the archive never shrinks (D12).
 * The caller passes the D2 lookup result — null is the same 404 for an
 * unknown id and another account's session.
 */
function getTranscript({ store, session }) {
  if (!session) {
    throw notFoundSession();
  }
  const state = loadState(store, session.id);
  return { status: 200, body: transcriptView(session, state) };
}

/**
 * [Ticket 2.3 write interface] Lock the Session's origin to "asr" when the
 * first audio segment lands (D15). A session already locked to captions is
 * the 409 transcript_origin_conflict (the reverse direction of the fixture
 * sample, error-transcript-origin-conflict); an existing asr lock is a
 * no-op. The 404 lookup and the finished-session 409 stay with 2.3's
 * routes — this primitive only arbitrates the path lock.
 */
function claimAudioOrigin({ store, session }) {
  if (session.origin === "captions") {
    throw transcriptOriginConflict("captions");
  }
  if (session.origin === null) {
    session.origin = "asr";
    store.set("sessions", session.id, session);
  }
}

/**
 * [Ticket 2.3 write interface] First-write-wins insert of one audio
 * segment state (contract §3.4 idempotency: (sessionId, segmentIndex) is
 * the idempotency key — a replay of the same index never overwrites or
 * re-enqueues). Returns { segment, created }. Validation of the segment
 * metadata (§3.4 bounds) stays with 2.3's routes; this primitive stores
 * the state the TranscriptView projects into pending[]/failed[].
 */
function upsertAudioSegment({ store, sessionId, segment }) {
  const state = loadState(store, sessionId);
  const existing = state.segments[segment.segmentIndex];
  if (existing) {
    return { segment: existing, created: false };
  }
  const stored = { ...segment, status: "pending" };
  state.segments[stored.segmentIndex] = stored;
  saveState(store, state);
  return { segment: stored, created: true };
}

/**
 * [Ticket 2.3 write interface] Task-state transitions on one segment
 * (contract §3.7 state machine pending → transcribing → done | failed;
 * done/failed are terminal and never revert). `applySegmentDone` appends
 * the Worker's records (origin "asr") — a silent segment's empty records
 * array simply adds none (D14: the audio itself is deleted by 2.3's
 * result endpoint, not here).
 */
function applySegmentTranscribing({ store, sessionId, segmentIndex }) {
  const state = loadState(store, sessionId);
  const segment = state.segments[segmentIndex];
  if (!segment || segment.status === "done" || segment.status === "failed") {
    return;
  }
  segment.status = "transcribing";
  saveState(store, state);
}

function applySegmentDone({ store, sessionId, segmentIndex, records }) {
  const state = loadState(store, sessionId);
  const segment = state.segments[segmentIndex];
  if (!segment || segment.status === "done" || segment.status === "failed") {
    return;
  }
  segment.status = "done";
  for (const record of records || []) {
    state.records.push({ ...record, origin: "asr" });
  }
  saveState(store, state);
}

function applySegmentFailed({ store, sessionId, segmentIndex, error }) {
  const state = loadState(store, sessionId);
  const segment = state.segments[segmentIndex];
  if (!segment || segment.status === "done" || segment.status === "failed") {
    return;
  }
  segment.status = "failed";
  segment.error = error;
  saveState(store, state);
}

module.exports = {
  transcriptOriginConflict,
  emptyState,
  loadState,
  saveState,
  parseGaps,
  reportGaps,
  parseCaptionSegments,
  transcriptView,
  transcriptSummary,
  archiveCaptions,
  getTranscript,
  claimAudioOrigin,
  upsertAudioSegment,
  applySegmentTranscribing,
  applySegmentDone,
  applySegmentFailed,
};
