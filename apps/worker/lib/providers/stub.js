/**
 * Stub Speech Provider (Testing Decisions: a replacement Speech Provider
 * makes tests repeatable — D10 puts the provider seam server-side).
 *
 * Deterministic: one segment becomes one record with the segment's full
 * span and a text that only depends on the segment index. A zero-byte
 * audio input models a silence segment (contract-r2 §3.7: records: []
 * written back as done).
 *
 * Times are segment-relative milliseconds; run-once folds them onto the
 * source timeline.
 */

/** @param {string} audioBase64 */
function isSilence(audioBase64) {
  return Buffer.from(audioBase64, "base64").length === 0;
}

async function transcribe({ audioBase64, segment }) {
  if (isSilence(audioBase64)) {
    return [];
  }
  return [
    {
      startMs: 0,
      endMs: segment.endMs - segment.startMs,
      text: `stub 转写文本（第 ${segment.segmentIndex} 段）`,
    },
  ];
}

function createStubProvider() {
  return { id: "stub", transcribe };
}

module.exports = { createStubProvider };
