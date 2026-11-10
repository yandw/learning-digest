/**
 * Session timeline: pure, derived views over Session state.
 *
 * The persisted snapshot (session-pipeline.js) keeps `transcriptRecords` and
 * `segments` in event-arrival order, on purpose: no migration of old
 * snapshots, and late ASR results stay bound to the Segment they belong to.
 * This module derives the *timeline* view — records sorted by video time
 * plus a coverage map (covered / hole / failed intervals) — that the
 * sidepanel, the AI prompt assembly and the capture-time seek decisions all
 * consume, so every surface agrees on what has been captured, what was
 * skipped, and what can still be filled by re-watching.
 *
 * Pure logic with no browser dependencies: importScripts'ed into the service
 * worker, required from Node tests, loaded as a plain script by sidepanel.
 *
 * Classification rules:
 * - segments with status "done" cover [start, start+duration] even when
 *   they produced no words (a silent segment is still captured);
 * - plain transcriptRecords cover their [start, start+duration];
 * - playbackWindows (realtime mode: ranges the player actually passed
 *   through while capturing) cover silently, so a muted stretch counts as
 *   processed instead of a phantom hole;
 * - segments with status "failed" and records with failed === true are
 *   failure intervals (re-watching may retry them);
 * - gapSkipped markers (isGapSkippedRecord) are holes (re-watching fills);
 * - wherever a success and a failure/hole overlap, the failure/hole wins,
 *   so a fillable range is never hidden behind a stale coverage claim.
 */

var YTD_SESSION_TIMELINE = (() => {
  const pipeline =
    typeof YTD_SESSION_PIPELINE !== "undefined"
      ? YTD_SESSION_PIPELINE
      : require("./session-pipeline.js");

  /**
   * Transcript records paired with their original array index, sorted by
   * video time (`record.start` ascending). Ties keep arrival order so a
   * stable, deterministic view results even when two records share a start.
   *
   * @param {object} state - Session snapshot with transcriptRecords
   * @returns {Array<{record: object, index: number}>}
   */
  function orderedTranscriptEntries(state) {
    const records = Array.isArray(state?.transcriptRecords)
      ? state.transcriptRecords
      : [];
    return records
      .map((record, index) => ({ record, index }))
      .sort((a, b) => {
        const sa = Number(a.record?.start);
        const sb = Number(b.record?.start);
        const aFinite = Number.isFinite(sa);
        const bFinite = Number.isFinite(sb);
        if (aFinite && bFinite && sa !== sb) return sa - sb;
        if (aFinite !== bFinite) return aFinite ? -1 : 1;
        return a.index - b.index;
      });
  }

  /**
   * Just the sorted records, for prompt assembly and formatting.
   *
   * @param {object} state
   * @returns {object[]}
   */
  function orderedTranscriptRecords(state) {
    return orderedTranscriptEntries(state).map((entry) => entry.record);
  }

  function toInterval(startValue, durationValue) {
    const start = Number(startValue);
    const duration = Number(durationValue);
    if (!Number.isFinite(start) || start < 0) return null;
    const end = Number.isFinite(duration) ? start + Math.max(0, duration) : start;
    if (end <= start) return null;
    return { start, end };
  }

  function mergeIntervals(intervals) {
    const sorted = intervals
      .filter(Boolean)
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const interval of sorted) {
      const last = merged[merged.length - 1];
      if (last && interval.start <= last.end) {
        last.end = Math.max(last.end, interval.end);
      } else {
        merged.push({ start: interval.start, end: interval.end });
      }
    }
    return merged;
  }

  /** Subtract `cuts` from `base`; both must be pre-sorted merged lists. */
  function subtractIntervals(base, cuts) {
    const result = [];
    for (const interval of base) {
      let cursor = interval.start;
      for (const cut of cuts) {
        if (cut.end <= cursor || cut.start >= interval.end) continue;
        if (cut.start > cursor) {
          result.push({ start: cursor, end: Math.min(cut.start, interval.end) });
        }
        cursor = Math.max(cursor, cut.end);
        if (cursor >= interval.end) break;
      }
      if (cursor < interval.end) {
        result.push({ start: cursor, end: interval.end });
      }
    }
    return result;
  }

  function within(intervals, position) {
    return intervals.some(
      (interval) => position >= interval.start && position < interval.end,
    );
  }

  /**
   * Builds the timeline view for one Session snapshot.
   *
   * @param {object} state - Session snapshot
   * @param {Array<{start:number, end?:number, duration?:number}>} [playbackWindows]
   *   Realtime-mode ranges the player actually traversed while capturing.
   * @returns {{entries: Array, covered: Array, holes: Array, failed: Array}}
   */
  function buildTimelineView(state, playbackWindows = []) {
    const records = Array.isArray(state?.transcriptRecords)
      ? state.transcriptRecords
      : [];
    const segments = Array.isArray(state?.segments) ? state.segments : [];

    const successes = [];
    const failures = [];
    const holes = [];

    for (const segment of segments) {
      if (!segment || typeof segment !== "object") continue;
      const interval = toInterval(segment.start, segment.duration);
      if (!interval) continue;
      if (segment.status === "done") {
        successes.push(interval);
      } else if (segment.status === "failed") {
        failures.push(interval);
      }
    }

    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      if (pipeline.isGapSkippedRecord(record)) {
        const interval = toInterval(record.start, record.duration);
        if (interval) holes.push(interval);
        continue;
      }
      const interval = toInterval(record.start, record.duration);
      if (!interval) continue;
      if (record.failed === true) {
        failures.push(interval);
      } else {
        successes.push(interval);
      }
    }

    for (const window of Array.isArray(playbackWindows) ? playbackWindows : []) {
      const interval = toInterval(
        window?.start,
        window?.end != null ? Number(window.end) - Number(window.start) : window?.duration,
      );
      if (interval) successes.push(interval);
    }

    const mergedFailures = mergeIntervals(failures);
    const mergedHoles = mergeIntervals(holes);
    const blockers = mergeIntervals([...mergedFailures, ...mergedHoles]);
    const covered = subtractIntervals(mergeIntervals(successes), blockers);

    return {
      entries: orderedTranscriptEntries(state),
      covered,
      holes: mergedHoles,
      failed: mergedFailures,
    };
  }

  /**
   * True when `position` has been captured: inside a covered interval and
   * not inside any hole or failure interval (a fillable range never counts
   * as covered, even if a stale success overlaps it).
   *
   * @param {ReturnType<typeof buildTimelineView>} view
   * @param {number} position
   * @returns {boolean}
   */
  function isCoveredAt(view, position) {
    const point = Number(position);
    if (!Number.isFinite(point)) return false;
    return (
      within(view?.covered ?? [], point) &&
      !within(view?.holes ?? [], point) &&
      !within(view?.failed ?? [], point)
    );
  }

  /**
   * Where capture should (re)start given a playback position, so re-watching
   * lands exactly where work remains:
   * - inside covered audio → the end of the covered run (hold until then,
   *   resume there — never re-capture what succeeded, silent parts included);
   * - inside a hole or failure interval, or anywhere uncaptured → the
   *   position itself: live audio can only be captured from the actual
   *   landing point, so a fill starts there and the hole/failure keeps its
   *   head.
   *
   * @param {ReturnType<typeof buildTimelineView>} view
   * @param {number} position
   * @returns {number}
   */
  function nextCaptureStart(view, position) {
    const point = Number(position);
    if (!Number.isFinite(point)) return 0;
    for (const interval of view?.covered ?? []) {
      if (point >= interval.start && point < interval.end) return interval.end;
    }
    return Math.max(0, point);
  }

  return {
    orderedTranscriptEntries,
    orderedTranscriptRecords,
    buildTimelineView,
    isCoveredAt,
    nextCaptureStart,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SESSION_TIMELINE;
}
