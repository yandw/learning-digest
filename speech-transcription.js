/**
 * Transcript record annotation and formatting helpers.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts. Mirrors captions.js:
 * both produce the same Transcript record shape ({ text, start, duration,
 * language }) so downstream code (Overview/Translation/Notes) never needs
 * to know whether a Transcript came from a Caption Track or from the ASR
 * archive pipeline.
 *
 * (Ticket 2.4, D10) The local Speech Transcription plumbing that used to
 * live here — chunk alignment/stitching, the base64/crypto/format helpers
 * the Speech Providers consumed — is retired with the Speech Provider
 * config: the audio path archives Segments through the learning service,
 * whose Worker holds the ASR credentials. What remains is what the
 * Session state machine and the panel still render from: the failure
 * marker, the all-failed check, and the shared [m:ss] formatter.
 */
var YTD_SPEECH_TRANSCRIPTION = (() => {
  const FAILED_SEGMENT_TEXT = "语音转录失败";

  /**
   * Builds a failure-annotation Transcript record for a Segment whose
   * transcription failed outright, covering its [offsetSeconds,
   * offsetSeconds+durationSeconds) range so the gap is visible in the
   * timeline instead of silently disappearing.
   *
   * @param {number} offsetSeconds
   * @param {number} durationSeconds
   * @returns {{text: string, start: number, duration: number, failed: true}}
   */
  function failedChunkRecord(offsetSeconds, durationSeconds) {
    return {
      text: `[${FAILED_SEGMENT_TEXT}]`,
      start: Math.floor(offsetSeconds),
      duration: Math.max(0, Math.floor(durationSeconds)),
      failed: true,
    };
  }

  /**
   * True when every chunk in the list failed outright, meaning the overall
   * transcription attempt produced no usable text at all. Callers use this
   * to decide whether to fall back to the No-Caption Video message instead
   * of returning a transcript made entirely of failure markers.
   *
   * @param {Array<Array<object>>} chunkRecordLists
   * @returns {boolean}
   */
  function allChunksFailed(chunkRecordLists) {
    if (!Array.isArray(chunkRecordLists) || chunkRecordLists.length === 0) {
      return true;
    }
    // A chunk contributes "success" only if it produced at least one
    // non-failed record; an empty or all-failed chunk list counts as failed.
    return !chunkRecordLists.some(
      (records) =>
        Array.isArray(records) && records.some((record) => !record.failed),
    );
  }

  /**
   * Formats whole seconds as `[m:ss]` (minutes unpadded, seconds
   * zero-padded). The single [m:ss] formatter for the extension:
   * transcript-for-prompt rendering, the seek/gap notices, and the
   * background analysis layer all share it. Non-numeric or negative input
   * renders as 0:00.
   */
  function formatTimestamp(startSeconds) {
    const total = Math.max(0, Math.floor(Number(startSeconds) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  return {
    FAILED_SEGMENT_TEXT,
    failedChunkRecord,
    allChunksFailed,
    formatTimestamp,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SPEECH_TRANSCRIPTION;
}
