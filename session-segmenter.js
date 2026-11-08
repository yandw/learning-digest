/**
 * Segment scheduler: pure timing math that turns a position stream into
 * Segments ready for transcription.
 *
 * The browser layer feeds the scheduler a position reading on some cadence:
 * wall-clock elapsed seconds since Session start for live, or media
 * position seconds for replay (the Source Platform's timestampKind decides
 * which — this module never knows). Completed Segments
 * ({index, start, duration}, whole seconds) come out in order; flush()
 * surfaces the trailing partial Segment at Session end so the tail is not
 * lost.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts. Resuming a Session just
 * means creating a fresh scheduler with startAt/startIndex taken from the
 * persisted snapshot's Segments.
 */
var YTD_SEGMENTER = (() => {
  const DEFAULT_SEGMENT_LENGTH_SECONDS = 30;
  const DEFAULT_MIN_SEGMENT_SECONDS = 5;
  const MIN_ALLOWED_SEGMENT_LENGTH = 30;
  const MAX_ALLOWED_SEGMENT_LENGTH = 600;

  /**
   * @param {object} [options]
   * @param {number} [options.segmentLengthSeconds] - target Segment length
   *   (clamped to [30, 600]; default 30)
   * @param {number} [options.minSegmentSeconds] - shortest tail flush keeps
   *   (default 5)
   * @param {number} [options.startAt] - position cursor to continue from
   *   when resuming an interrupted Session (default 0)
   * @param {number} [options.startIndex] - index of the first new Segment
   *   when resuming (default 0)
   */
  function createSegmenter(options = {}) {
    const requested = Number(options.segmentLengthSeconds);
    const segmentLength = Number.isFinite(requested)
      ? Math.min(
          MAX_ALLOWED_SEGMENT_LENGTH,
          Math.max(MIN_ALLOWED_SEGMENT_LENGTH, Math.floor(requested)),
        )
      : DEFAULT_SEGMENT_LENGTH_SECONDS;
    const requestedMin = Number(options.minSegmentSeconds);
    const minSegmentSeconds = Number.isFinite(requestedMin)
      ? Math.max(0, Math.floor(requestedMin))
      : DEFAULT_MIN_SEGMENT_SECONDS;

    let emittedUpTo = Math.max(0, Math.floor(Number(options.startAt) || 0));
    let nextIndex = Math.max(0, Math.floor(Number(options.startIndex) || 0));

    function emitSegment(start, duration) {
      const segment = { index: nextIndex, start, duration };
      nextIndex += 1;
      return segment;
    }

    /**
     * Feeds the current position. Positions never move the cursor
     * backwards (a replay seek back must not re-emit Segments), and every
     * full segment length of advance emits exactly one Segment.
     *
     * @param {number} positionSeconds
     * @returns {Array<{index: number, start: number, duration: number}>}
     */
    function recordPosition(positionSeconds) {
      const position = Math.floor(Number(positionSeconds) || 0);
      const segments = [];
      while (emittedUpTo + segmentLength <= position) {
        const start = emittedUpTo;
        emittedUpTo += segmentLength;
        segments.push(emitSegment(start, segmentLength));
      }
      return segments;
    }

    /**
     * Seeks the cursor forward to positionSeconds WITHOUT emitting anything
     * for the skipped range (#48 seek-forward). The caller owns everything
     * the skipped range needs (flushing the pre-seek tail, the visible gap
     * marker record); the scheduler only moves the cursor. Positions at or
     * before the cursor are ignored — the no-backward rule.
     *
     * @param {number} positionSeconds
     */
    function jumpTo(positionSeconds) {
      const position = Math.floor(Number(positionSeconds) || 0);
      if (position > emittedUpTo) emittedUpTo = position;
    }

    /**
     * Ends scheduling: returns the trailing partial Segment covering
     * [emittedUpTo, position], or null when nothing audible remains (an
     * exact boundary, or a tail shorter than minSegmentSeconds).
     *
     * @param {number} positionSeconds
     * @returns {?{index: number, start: number, duration: number}}
     */
    function flush(positionSeconds) {
      const position = Math.max(emittedUpTo, Math.floor(Number(positionSeconds) || 0));
      if (position - emittedUpTo < minSegmentSeconds) return null;
      const start = emittedUpTo;
      emittedUpTo = position;
      return emitSegment(start, position - start);
    }

    return {
      recordPosition,
      jumpTo,
      flush,
      get emittedUpTo() {
        return emittedUpTo;
      },
    };
  }

  return {
    DEFAULT_SEGMENT_LENGTH_SECONDS,
    DEFAULT_MIN_SEGMENT_SECONDS,
    // The single source of truth for the Segment-length bounds. The
    // segmenter clamps to these; settings.js reads them when normalizing
    // the user's configured Segment length so the two can never drift.
    MIN_ALLOWED_SEGMENT_LENGTH,
    MAX_ALLOWED_SEGMENT_LENGTH,
    createSegmenter,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SEGMENTER;
}
