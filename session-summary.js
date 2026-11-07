/**
 * Session summaries: pure assembly for the Rolling Summary and Session Digest.
 *
 * Two prompt inputs are assembled here, both browser-free so they can be
 * unit-tested in Node and loaded by the service worker with importScripts:
 *
 * - Rolling Summary input: the previous Rolling Summary text plus the
 *   Transcript records since it (records at or after `coveredUntil`). The
 *   background layer sends that to the AI Provider on the configured
 *   interval and feeds the result back as a `summaryTick` event; the state
 *   machine keeps only the latest summary, which is what makes the window
 *   slide forward.
 * - Session Digest input: reused from session-pipeline.js
 *   (`assembleSessionDigestInput`) — latest Rolling Summary plus the
 *   uncovered Transcript tail — and only formatted/prompt-wrapped here.
 *
 * The coveredUntil convention is shared with the digest assembly: a record
 * counts as covered when its `start` is strictly below `coveredUntil`, so
 * the next window is `start >= coveredUntil`. Failure-marker records stay in
 * the window so a summary can mention the gap instead of silently skipping
 * it.
 */
var YTD_SESSION_SUMMARY = (() => {
  // The [m:ss] timestamp formatter is shared with speech-transcription.js;
  // in Node tests we require it, in the service worker both globals arrive
  // via importScripts.
  const speechTranscription =
    typeof YTD_SPEECH_TRANSCRIPTION !== "undefined"
      ? YTD_SPEECH_TRANSCRIPTION
      : require("./speech-transcription.js");

  /**
   * Assembles the Rolling Summary prompt input from Session state.
   *
   * @param {object} state
   * @returns {{previousSummary: string|null, newTranscript: object[], coveredUntil: number}}
   */
  function assembleRollingSummaryInput(state) {
    const rollingSummary = state?.rollingSummary ?? null;
    const coveredUntil = Number(rollingSummary?.coveredUntil) || 0;
    const newTranscript = (state?.transcriptRecords || []).filter(
      (record) => (Number(record.start) || 0) >= coveredUntil,
    );
    return {
      previousSummary:
        typeof rollingSummary?.text === "string" ? rollingSummary.text : null,
      newTranscript,
      coveredUntil,
    };
  }

  /**
   * True when the state holds Transcript records the latest Rolling Summary
   * does not cover yet — summarizing without them would waste the AI call.
   *
   * @param {object} state
   * @returns {boolean}
   */
  function hasNewTranscript(state) {
    return assembleRollingSummaryInput(state).newTranscript.length > 0;
  }

  /**
   * The timeline position (seconds from Session start) up to which a set of
   * Transcript records is covered. The next window starts exactly here.
   *
   * @param {object[]} records
   * @returns {number}
   */
  function coveredUntilFor(records) {
    let end = 0;
    for (const record of records || []) {
      const start = Number(record?.start) || 0;
      const duration = Number(record?.duration) || 0;
      end = Math.max(end, start + duration);
    }
    return end;
  }

  /**
   * Pure scheduling decision for the Rolling Summary: the interval must have
   * elapsed since the last summary attempt AND there must be uncovered
   * Transcript to fold in. Attempt time (not success time) is what the
   * caller passes, so a failed summary simply waits one more interval
   * instead of retrying in a tight loop.
   *
   * @param {{nowMs: number, lastSummaryAtMs: number, intervalMinutes: number, hasNewTranscript: boolean}} input
   * @returns {boolean}
   */
  function isSummaryDue({
    nowMs,
    lastSummaryAtMs,
    intervalMinutes,
    hasNewTranscript: newTranscriptAvailable,
  }) {
    if (!newTranscriptAvailable) return false;
    const intervalMs = Math.max(0, Number(intervalMinutes) || 0) * 60 * 1000;
    return Number(nowMs) - Number(lastSummaryAtMs) >= intervalMs;
  }

  const formatTimestamp = speechTranscription.formatTimestamp;

  /**
   * Renders Transcript records as `[m:ss] text` lines — the same stamp
   * convention the analysis prompt documents, so the AI Provider can cite
   * timestamps in summaries.
   *
   * @param {object[]} records
   * @returns {string}
   */
  function formatTranscriptForPrompt(records) {
    return (records || [])
      .map(
        (record) =>
          `[${formatTimestamp(record?.start)}] ${String(record?.text ?? "")}`,
      )
      .join("\n");
  }

  const ROLLING_SUMMARY_SYSTEM_PROMPT = [
    "You maintain the rolling summary of a long lesson.",
    "Merge the previous rolling summary with the new transcript excerpt into ONE updated rolling summary of everything covered so far.",
    "Write in the same language as the transcript.",
    "Keep it compact: concise paragraphs or bullets covering the key concepts, arguments, and examples, with [m:ss] timestamps where they help the learner jump back.",
    "If the excerpt contains a transcription-failure marker like [语音转录失败], note that a gap exists at that timestamp instead of inventing content.",
    "Output only the updated rolling summary, no preamble.",
  ].join(" ");

  const DIGEST_SYSTEM_PROMPT = [
    "You write the final digest of a completed lesson.",
    "Combine the rolling summary so far with the remaining transcript excerpt into ONE complete session digest covering the whole lesson from start to finish.",
    "Write in the same language as the transcript.",
    "Structure it for review: an overview, then the main sections in lesson order with [m:ss] timestamps, then a short takeaways list.",
    "If the transcript contains transcription-failure markers like [语音转录失败], mention that those stretches could not be transcribed instead of inventing content.",
    "Output only the digest, no preamble.",
  ].join(" ");

  /**
   * Chat-completion messages for one Rolling Summary tick.
   *
   * @param {{previousSummary: string|null, newTranscriptText: string}} input
   * @returns {Array<{role: string, content: string}>}
   */
  function buildRollingSummaryMessages({ previousSummary, newTranscriptText }) {
    const userParts = [];
    if (previousSummary) {
      userParts.push(`Previous rolling summary:\n${previousSummary}`);
    } else {
      userParts.push(
        "There is no previous summary yet; this is the first tick of the session.",
      );
    }
    userParts.push(`New transcript excerpt:\n${newTranscriptText}`);
    return [
      { role: "system", content: ROLLING_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: userParts.join("\n\n") },
    ];
  }

  /**
   * Chat-completion messages for the Session Digest at session end.
   *
   * @param {{rollingSummaryText: string|null, uncoveredTranscriptText: string}} input
   * @returns {Array<{role: string, content: string}>}
   */
  function buildSessionDigestMessages({ rollingSummaryText, uncoveredTranscriptText }) {
    const userParts = [];
    if (rollingSummaryText) {
      userParts.push(`Rolling summary so far:\n${rollingSummaryText}`);
    } else {
      userParts.push(
        "There is no rolling summary; build the digest from the full transcript below.",
      );
    }
    userParts.push(`Transcript not yet covered by the summary:\n${uncoveredTranscriptText}`);
    return [
      { role: "system", content: DIGEST_SYSTEM_PROMPT },
      { role: "user", content: userParts.join("\n\n") },
    ];
  }

  return {
    assembleRollingSummaryInput,
    hasNewTranscript,
    coveredUntilFor,
    isSummaryDue,
    formatTranscriptForPrompt,
    buildRollingSummaryMessages,
    buildSessionDigestMessages,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SESSION_SUMMARY;
}
