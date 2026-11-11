/**
 * Shared Transcript-shape helpers: the contract-r2 §2.2 Segment check and
 * the coverage computation the caption paths and the archive client all
 * speak. Extracted from the three verbatim isValidSegment copies
 * (bilibili-captions.js, youtube-captions.js, session-archive.js) and the
 * two computeCaptionCoverage copies (bilibili-captions.js — the surviving
 * form — and youtube-captions.js) after the two readers drifted: the
 * youtube copy had lost the per-segment re-check the bilibili copy carries,
 * which is exactly the duplication bug a shared module prevents recurring.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded with importScripts / <script> tags. UMD like api-client.js:
 * consumer modules fall back to require() when the global is absent (Node
 * tests), which keeps the load order irrelevant there.
 */
var YTD_TRANSCRIPT_SHAPES = (() => {
  // Segment shape of contract-r2 §2.2 minus origin (the server stamps it).
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
   * Which ranges of [intervalStartMs, intervalEndMs] carry no caption
   * segment — the coverage block the 强制转写 ticket consumes. Null when
   * the interval itself is not well-formed (the caller then omits
   * coverage instead of guessing an interval).
   */
  function computeCaptionCoverage(segments, intervalStartMs, intervalEndMs) {
    const start = Number(intervalStartMs);
    const end = Number(intervalEndMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return null;
    }
    if (!Array.isArray(segments)) return null;
    // Garbage in, no coverage out: any malformed segment makes the whole
    // computation refuse (the 强制转写 input must never rest on a guessed
    // union of half-parsed ranges).
    if (!segments.every(isValidSegment)) return null;
    const coveredRanges = [];
    for (const segment of segments) {
      // Defensive re-check before the range math: the loop must never read
      // startMs/endMs off a segment that does not itself validate, even if
      // the every() gate above is ever loosened — the 强制转写 input stays
      // correct by construction, not by caller discipline.
      if (!isValidSegment(segment)) continue;
      const from = Math.max(segment.startMs, Math.round(start));
      const to = Math.min(segment.endMs, Math.round(end));
      if (to > from) coveredRanges.push([from, to]);
    }
    coveredRanges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const range of coveredRanges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) {
        last[1] = Math.max(last[1], range[1]);
      } else {
        merged.push([range[0], range[1]]);
      }
    }
    const uncovered = [];
    let cursor = Math.round(start);
    for (const [from, to] of merged) {
      if (from > cursor) uncovered.push({ startMs: cursor, endMs: from });
      cursor = Math.max(cursor, to);
    }
    if (cursor < Math.round(end)) uncovered.push({ startMs: cursor, endMs: Math.round(end) });
    return { covered: uncovered.length === 0, uncovered };
  }

  return { isValidSegment, computeCaptionCoverage };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_TRANSCRIPT_SHAPES;
}
