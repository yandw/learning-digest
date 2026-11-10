/**
 * Session pipeline: a pure, event-driven state machine over Session state.
 *
 * Events (segmentCaptured, transcribeOk, transcribeFailed, gapSkipped,
 * gapFilled, utteranceCaptured, topicsAppended, titleCaptured, sessionEnd)
 * drive
 * transitions over state
 * { sessionId, segments, transcriptRecords, topics, title?, status }.
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
   *   (a failed segmentId retries that Segment: its marker is replaced, #48)
   * - {type: "transcribeFailed", segmentId}
   * - {type: "gapSkipped", start, duration} - seek-forward hole marker (#48)
 * - {type: "gapFilled", filledStart, filledEnd} - a re-watched hole range
 *   was filled; shrinks the covering gapSkipped marker (#48)
 * - {type: "utteranceCaptured", text, start, duration, failed?} - one
 *   finalized realtime utterance (#47); appends a plain Transcript record
 *   (failed: true lands the segment path's failure-marker shape)
   * - {type: "topicsAppended", topics: [{start, end, title, text, continuation?}]}
   * - {type: "titleCaptured", title: string} - the page title (#32)
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
      case "gapSkipped":
        return onGapSkipped(state, event);
      case "gapFilled":
        return onGapFilled(state, event);
      case "utteranceCaptured":
        return onUtteranceCaptured(state, event);
      case "topicsAppended":
        return onTopicsAppended(state, event);
      case "titleCaptured":
        return onTitleCaptured(state, event);
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
    const segment = findSegment(state, event.segmentId);
    if (!segment) throw new Error(`Unknown Segment: ${String(event.segmentId)}`);
    // A re-listen retry (#48, Plan A): transcribeOk targeting a failed
    // Segment replaces its [语音转录失败] marker with the re-watched
    // records — exactly once, since the Segment is marked done here and a
    // later result for a done Segment is dropped below.
    if (segment.status === "failed") {
      return replaceFailureMarker(state, segment, records);
    }
    return settleSegment(state, event.segmentId, "done", records);
  }

  /**
   * Marks a failed Segment done and swaps its failure-marker record for the
   * retry's records at the same position in the timeline. The marker is
   * matched by its exact shape (failedChunkRecord over the Segment's own
   * range), so gap markers and other Segments' annotations are never
   * touched. When the marker is absent (a pre-0.1.45 snapshot), the records
   * are appended — the Segment still becomes done, never duplicated.
   */
  function replaceFailureMarker(state, segment, records) {
    const marker = speechTranscription.failedChunkRecord(
      segment.start,
      segment.duration,
    );
    const markerIndex = state.transcriptRecords.findIndex(
      (record) =>
        record.failed === true &&
        record.start === marker.start &&
        record.duration === marker.duration &&
        record.text === marker.text,
    );
    const transcriptRecords = [...state.transcriptRecords];
    if (markerIndex >= 0) {
      transcriptRecords.splice(markerIndex, 1, ...records);
    } else {
      transcriptRecords.push(...records);
    }
    return {
      ...state,
      segments: state.segments.map((candidate) =>
        candidate.id === segment.id ? { ...candidate, status: "done" } : candidate,
      ),
      transcriptRecords,
    };
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

  /**
   * The shape test for a seek-forward's gap marker (#48): failed: true like
   * the failure markers, carrying the [已跳过 …] text the gapSkipped event
   * stamps. The background derives fill-eligible holes from the transcript
   * records at check time through this same predicate, so the worker and
   * the state machine can never drift on what counts as a hole.
   */
  function isGapSkippedRecord(record) {
    return (
      !!record &&
      typeof record === "object" &&
      record.failed === true &&
      typeof record.text === "string" &&
      record.text.startsWith("[已跳过 ") &&
      Number.isFinite(Number(record.start)) &&
      Number.isFinite(Number(record.duration))
    );
  }

  /** The one gap-marker text builder: [已跳过 m:ss–m:ss]. */
  function gapMarkerText(start, end) {
    return `[已跳过 ${speechTranscription.formatTimestamp(start)}–${speechTranscription.formatTimestamp(end)}]`;
  }

  /**
   * Lands the one visible marker record for a seek-forward skipped range
   * (#48): the Digest stays honest about the hole without inventing Segments
   * for audio that was never recorded. The marker shape mirrors
   * failedChunkRecord (failed: true) so it renders and formats exactly like
   * the other visible annotations.
   *
   * A new range adjacent to (or overlapping) an existing gapSkipped marker
   * extends that marker instead of appending: consecutive small drags keep
   * ONE hole and ONE "[已跳过 a-b]" row, never one row per drag.
   */
  function onGapSkipped(state, event) {
    const start = Math.floor(Number(event.start));
    const duration = Math.floor(Number(event.duration));
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new Error(
        "gapSkipped requires a non-negative start and a positive duration",
      );
    }
    const end = start + duration;
    const existing = state.transcriptRecords.find(
      (record) =>
        isGapSkippedRecord(record) &&
        start <= record.start + record.duration &&
        end >= record.start,
    );
    if (existing) {
      const mergedStart = Math.min(existing.start, start);
      const mergedEnd = Math.max(existing.start + existing.duration, end);
      return {
        ...state,
        transcriptRecords: replaceRecord(state.transcriptRecords, existing, {
          text: gapMarkerText(mergedStart, mergedEnd),
          start: mergedStart,
          duration: mergedEnd - mergedStart,
          failed: true,
        }),
      };
    }
    const marker = {
      text: gapMarkerText(start, start + duration),
      start,
      duration,
      failed: true,
    };
    return { ...state, transcriptRecords: [...state.transcriptRecords, marker] };
  }

  /**
   * Shrinks the gapSkipped marker covering a filled range (#48 hole-fill):
   * re-watching a skipped hole dispatches fill Segments forward through it,
   * and each gapFilled event hands the covered range over to the fill
   * records — the marker must never coexist with fill records for the same
   * range. The event carries the fill pass's cumulative covered range
   * {filledStart, filledEnd}: filledStart is where playback entered the
   * hole, filledEnd the end of the most recently dispatched fill Segment.
   * The marker keeps whichever side of the hole is still unfilled:
   *
   * - the fill covers the whole marker → the marker is removed;
   * - the fill started past the marker's head → the remainder is the head
   *   [marker.start, filledStart] (fills proceed forward, so the marker's
   *   end tracks back to the fill frontier);
   * - the fill started at the marker's head → the head is consumed and the
   *   remainder is the tail [filledEnd, marker end], whose start advances
   *   with each fill until the hole is fully filled and the marker drops.
   *
   * A covering marker is required: the background only emits gapFilled for
   * a range it derived from a live marker, so a miss means corruption.
   */
  function onGapFilled(state, event) {
    const filledStart = Math.floor(Number(event.filledStart));
    const filledEnd = Math.floor(Number(event.filledEnd));
    if (
      !Number.isFinite(filledStart) ||
      filledStart < 0 ||
      !Number.isFinite(filledEnd) ||
      filledEnd <= filledStart
    ) {
      throw new Error(
        "gapFilled requires a non-negative filledStart and a filledEnd past it",
      );
    }
    const markers = state.transcriptRecords.filter(isGapSkippedRecord);
    const covers = (marker, point) =>
      marker.start <= point && point <= marker.start + marker.duration;
    // A boundary-inclusive containment test: later fills of one pass start
    // exactly at the shrunk marker's end, and the final fill ends exactly at
    // the marker's end. When the filled range straddles the seam between two
    // adjacent holes, the marker containing the whole range wins.
    const marker =
      markers.find((candidate) => covers(candidate, filledStart) && covers(candidate, filledEnd)) ||
      markers.find((candidate) => covers(candidate, filledStart)) ||
      markers.find((candidate) => covers(candidate, filledEnd));
    if (!marker) {
      throw new Error("gapFilled requires a covering gapSkipped marker");
    }
    const markerEnd = marker.start + marker.duration;
    let transcriptRecords;
    if (filledStart <= marker.start && filledEnd >= markerEnd) {
      // Fully covered: the hole is gone, and so is its marker.
      transcriptRecords = state.transcriptRecords.filter(
        (record) => record !== marker,
      );
    } else if (filledStart > marker.start) {
      // The unfilled remainder is the marker's head; its start stands.
      transcriptRecords = replaceRecord(state.transcriptRecords, marker, {
        text: gapMarkerText(marker.start, filledStart),
        start: marker.start,
        duration: filledStart - marker.start,
        failed: true,
      });
    } else {
      // The fill consumed the marker's head: the remainder is the tail.
      transcriptRecords = replaceRecord(state.transcriptRecords, marker, {
        text: gapMarkerText(filledEnd, markerEnd),
        start: filledEnd,
        duration: markerEnd - filledEnd,
        failed: true,
      });
    }
    return { ...state, transcriptRecords };
  }

  /** In-place record replacement that never mutates the input array. */
  function replaceRecord(records, original, replacement) {
    return records.map((record) => (record === original ? replacement : record));
  }

  /**
   * Appends one finalized realtime utterance (#47) as a plain Transcript
   * record: the realtime stream has no Segments, so the record goes
   * straight into the timeline and every consumer (panel rows, Topic tick
   * coverage, the Digest) sees it like any other record. Validation is
   * tolerant on purpose — the events arrive unsolicited from the ASR
   * server, so an empty (whitespace-only) text or a non-finite timing is a
   * no-op that leaves the state untouched instead of an error.
   *
   * A failed utterance rides the same event with `failed: true`: the
   * record lands with the flag set, the same shape as failureChunkRecord
   * records, so the existing failure-marker styling and the
   * allSegmentsFailed check treat it exactly like a failed Segment's
   * [语音转录失败] annotation.
   */
  function onUtteranceCaptured(state, event) {
    const text = typeof event?.text === "string" ? event.text.trim() : "";
    const start = Number(event?.start);
    const duration = Number(event?.duration);
    if (!text || !Number.isFinite(start) || !Number.isFinite(duration)) {
      return state;
    }
    const record = { text, start, duration };
    if (event?.failed === true) record.failed = true;
    return {
      ...state,
      transcriptRecords: [...state.transcriptRecords, record],
    };
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
   * Stores the page title the bridge reported (#32), the stable first line
   * of the report header. First write wins: a later titleCaptured (pagehide
   * re-report, SPA rename) never overwrites the title captured at Session
   * start, so the header stays stable for the whole Session.
   *
   * @param {object} state
   * @param {object} event
   * @returns {object} the next Session state
   */
  function onTitleCaptured(state, event) {
    if (typeof event?.title !== "string" || event.title.trim().length === 0) {
      throw new Error("titleCaptured requires a non-empty title string");
    }
    if (state.title) return state;
    return { ...state, title: event.title };
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
    const restored = {
      sessionId: snapshot.sessionId,
      status: snapshot.status === "ended" ? "ended" : "active",
      segments: Array.isArray(snapshot.segments) ? snapshot.segments : [],
      transcriptRecords: Array.isArray(snapshot.transcriptRecords)
        ? snapshot.transcriptRecords
        : [],
      topics: Array.isArray(snapshot.topics) ? snapshot.topics : [],
    };
    // The captured page title (#32) rides along when the snapshot has one;
    // older snapshots simply resume titleless and can capture it later.
    if (typeof snapshot.title === "string" && snapshot.title) {
      restored.title = snapshot.title;
    }
    return restored;
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

  return {
    createSession,
    applyEvent,
    resumeFromSnapshot,
    settleInterruptedSegments,
    allSegmentsFailed,
    isGapSkippedRecord,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SESSION_PIPELINE;
}
