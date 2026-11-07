/**
 * Session pipeline: a pure, event-driven state machine over Session state.
 *
 * Events (segmentCaptured, transcribeOk, transcribeFailed, topicsAppended,
 * sessionEnd) drive transitions over state
 * { sessionId, segments, transcriptRecords, topics, status }.
 * Segments carry their own lifecycle (pending → done / failed).
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts. A thin browser layer
 * (session-persistence.js) feeds events in and snapshots state to
 * chrome.storage.local after every transition, which is what makes closing
 * the tab mid-lesson safe: resume is just loadSnapshot → keep feeding events.
 *
 * Failure semantics mirror speech-transcription.js: a failed Segment yields
 * a visible `[语音转录失败]` marker record in the Transcript (reusing
 * failedChunkRecord so the vocabulary stays identical) and never blocks or
 * discards neighbouring Segments; when every Segment failed, the Session is
 * treated as having no Transcript (allSegmentsFailed).
 */
var YTD_SESSION_PIPELINE = (() => {
  // Shared failure-marker helper lives in speech-transcription.js; in Node
  // tests we require it, in the service worker both globals arrive via
  // importScripts.
  const speechTranscription =
    typeof YTD_SPEECH_TRANSCRIPTION !== "undefined"
      ? YTD_SPEECH_TRANSCRIPTION
      : require("./speech-transcription.js");

  /**
   * @typedef {Object} Segment
   * @property {string} id
   * @property {number} start - seconds from Session start
   * @property {number} duration - seconds
   * @property {"pending"|"done"|"failed"} status
   */

  /**
   * Creates an active Session.
   *
   * @param {{sessionId: string}} options
   * @returns {{sessionId: string, status: "active", segments: Segment[], transcriptRecords: object[], topics: object[]}}
   */
  function createSession({ sessionId }) {
    return {
      sessionId,
      status: "active",
      segments: [],
      transcriptRecords: [],
      topics: [],
    };
  }

  /**
   * Validates one raw Topic entry for the append-only timeline: numeric
   * time range with end at or after start, non-empty title and text. The
   * tolerant parser (session-summary.js) produces this shape; the state
   * machine re-checks so a malformed append can never corrupt the timeline.
   *
   * @param {*} topic
   * @returns {boolean}
   */
  function isValidTopic(topic) {
    if (!topic || typeof topic !== "object" || Array.isArray(topic)) return false;
    const start = Number(topic.start);
    const end = Number(topic.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (Math.max(0, Math.floor(end)) < Math.max(0, Math.floor(start))) return false;
    return (
      typeof topic.title === "string" &&
      topic.title.trim().length > 0 &&
      typeof topic.text === "string" &&
      topic.text.trim().length > 0
    );
  }

  /**
   * Applies one event to the Session state and returns the next state.
   * Transitions never mutate their input, so a snapshot is just the state
   * object itself (JSON-plain). Unknown event types and references to
   * unknown Segments throw; late results for an already-settled Segment
   * (done or failed) are ignored so a resumed Session can never
   * re-transcribe or double-charge a finished Segment.
   *
   * Events:
   * - {type: "segmentCaptured", segment: {id, start, duration}}
   * - {type: "transcribeOk", segmentId, records: [{text, start, duration, language?}]}
   * - {type: "transcribeFailed", segmentId}
   * - {type: "topicsAppended", topics: [{start, end, title, text, continuation?}]}
   * - {type: "sessionEnd"}
   *
   * @param {object} state
   * @param {object} event
   * @returns {object} the next Session state
   */
  function applyEvent(state, event) {
    if (!state || typeof state !== "object") {
      throw new Error("Session state is required");
    }
    switch (event?.type) {
      case "segmentCaptured":
        return onSegmentCaptured(state, event);
      case "transcribeOk":
        return onTranscribeOk(state, event);
      case "transcribeFailed":
        return onTranscribeFailed(state, event);
      case "topicsAppended":
        return onTopicsAppended(state, event);
      case "sessionEnd":
        return { ...state, status: "ended" };
      default:
        throw new Error(`Unknown event type: ${String(event?.type)}`);
    }
  }

  function findSegment(state, segmentId) {
    return state.segments.find((segment) => segment.id === segmentId);
  }

  function onSegmentCaptured(state, event) {
    const segment = event.segment;
    if (!segment || typeof segment.id !== "string" || !segment.id) {
      throw new Error("segmentCaptured requires a Segment with an id");
    }
    // Idempotent: a duplicate capture (e.g. a replayed event after resume)
    // must not re-add the Segment.
    if (findSegment(state, segment.id)) return state;

    const pending = {
      id: segment.id,
      start: Math.floor(Number(segment.start) || 0),
      duration: Math.max(0, Math.floor(Number(segment.duration) || 0)),
      status: "pending",
    };
    return { ...state, segments: [...state.segments, pending] };
  }

  function settleSegment(state, segmentId, status, extraRecords) {
    const segment = findSegment(state, segmentId);
    if (!segment) throw new Error(`Unknown Segment: ${String(segmentId)}`);
    // A Segment settles exactly once: late results after done/failed are
    // dropped, so a resumed Session never re-transcribes finished Segments.
    if (segment.status !== "pending") return state;

    return {
      ...state,
      segments: state.segments.map((candidate) =>
        candidate.id === segmentId ? { ...candidate, status } : candidate,
      ),
      transcriptRecords: [...state.transcriptRecords, ...extraRecords],
    };
  }

  function onTranscribeOk(state, event) {
    const records = Array.isArray(event.records) ? event.records : [];
    return settleSegment(state, event.segmentId, "done", records);
  }

  function onTranscribeFailed(state, event) {
    const segment = findSegment(state, event.segmentId);
    if (!segment) throw new Error(`Unknown Segment: ${String(event.segmentId)}`);
    // The failure marker covers the Segment's own time range so the gap is
    // visible in the Transcript instead of silently disappearing — the same
    // record shape speech-transcription.js stitches into its output.
    const marker = speechTranscription.failedChunkRecord(
      segment.start,
      segment.duration,
    );
    return settleSegment(state, event.segmentId, "failed", [marker]);
  }

  function onTopicsAppended(state, event) {
    const topics = Array.isArray(event.topics) ? event.topics : null;
    if (!topics || topics.some((topic) => !isValidTopic(topic))) {
      throw new Error(
        "topicsAppended requires Topic entries with {start, end, title, text}",
      );
    }
    // Append-only (ADR 0002): new Topics never rewrite earlier ones, and an
    // empty append (e.g. the parser found nothing to summarize) is a no-op.
    if (topics.length === 0) return state;
    return { ...state, topics: [...state.topics, ...topics] };
  }

  /**
   * Restores Session state from a persisted snapshot so the caller can keep
   * feeding events exactly where the Session left off. Snapshots from
   * before the Topic timeline carry the retired rollingSummary field and no
   * topics at all; the retired field is simply ignored and the timeline
   * starts empty (old summaries are never migrated, per #27).
   *
   * @param {object} snapshot - a state object previously saved to storage
   * @returns {object} Session state
   */
  function resumeFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || !snapshot.sessionId) {
      throw new Error("Session snapshot is malformed");
    }
    return {
      sessionId: snapshot.sessionId,
      status: snapshot.status === "ended" ? "ended" : "active",
      segments: Array.isArray(snapshot.segments) ? snapshot.segments : [],
      transcriptRecords: Array.isArray(snapshot.transcriptRecords)
        ? snapshot.transcriptRecords
        : [],
      topics: Array.isArray(snapshot.topics) ? snapshot.topics : [],
    };
  }

  /**
   * Settles the resume gap left by an interrupted service worker. A Segment
   * still `pending` after resumeFromSnapshot was in flight when the worker
   * died; the rebuilt segmenter starts at the end of the persisted Segments
   * (its cursor already lies at or past such a Segment's time range), so it
   * would never be dispatched again. Failing it here emits the normal
   * `transcribeFailed` marker record: the gap stays visible in the Transcript
   * instead of silently disappearing. Settled Segments are never re-touched,
   * and the state is returned unchanged (same reference) when nothing was
   * pending.
   *
   * @param {object} state - Session state from resumeFromSnapshot
   * @returns {object} the next Session state
   */
  function settleInterruptedSegments(state) {
    if (!state || typeof state !== "object") {
      throw new Error("Session state is required");
    }
    // The segmenter cursor on resume is the end of the last persisted
    // Segment, i.e. the max end over all Segments (pending ones included).
    const segmenterCursor = state.segments.reduce(
      (end, segment) => Math.max(end, segment.start + segment.duration),
      0,
    );
    let next = state;
    for (const segment of state.segments) {
      if (segment.status !== "pending") continue;
      if (segment.start + segment.duration > segmenterCursor) continue;
      const settled = applyEvent(next, {
        type: "transcribeFailed",
        segmentId: segment.id,
      });
      if (settled !== next) next = settled;
    }
    return next;
  }

  /**
   * True when every captured Segment failed (or none produced any usable
   * text), meaning the Session has no Transcript at all. Callers use this to
   * surface "no transcript" instead of a Transcript made entirely of failure
   * markers, mirroring speech-transcription.js:allChunksFailed.
   *
   * @param {object} state
   * @returns {boolean}
   */
  function allSegmentsFailed(state) {
    const records = state?.transcriptRecords;
    if (!Array.isArray(records) || records.length === 0) return false;
    return records.every((record) => record.failed === true);
  }

  /**
   * Assembles the Session Digest input per ADR 0002: one global pass over
   * the full Transcript, independent of the Topic timeline. The AI Provider
   * call itself lives outside this pure module; this only computes what the
   * digest prompt is built from. Failed-marker records are kept so the
   * digest can mention the gap.
   *
   * @param {object} state
   * @returns {{uncoveredTranscript: object[]}}
   */
  function assembleSessionDigestInput(state) {
    return {
      uncoveredTranscript: [...(state?.transcriptRecords || [])],
    };
  }

  return {
    createSession,
    applyEvent,
    resumeFromSnapshot,
    settleInterruptedSegments,
    allSegmentsFailed,
    assembleSessionDigestInput,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SESSION_PIPELINE;
}
