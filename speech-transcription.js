/**
 * Speech Transcription chunk alignment, stitching, and failure annotation.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts. Mirrors captions.js:
 * both produce the same Transcript record shape ({ text, start, duration,
 * language }) so downstream code (Overview/Translation/Notes) never needs
 * to know whether a Transcript came from a Caption Track or from Speech
 * Transcription.
 */
var YTD_SPEECH_TRANSCRIPTION = (() => {
  const FAILED_SEGMENT_TEXT = "语音转录失败";

  /**
   * Converts one chunk's Groq-style verbose_json response into Transcript
   * records with absolute timestamps, by adding the chunk's start offset
   * (in seconds) to each segment's chunk-relative start/end.
   *
   * @param {{segments?: Array<{start: number, end: number, text: string}>}} verboseJson
   * @param {number} offsetSeconds - this chunk's start time within the video
   * @param {string} [language] - language code, if known; omitted when the
   *   provider auto-detected it and didn't report one back
   * @returns {Array<{text: string, start: number, duration: number, language?: string}>}
   */
  function alignChunkSegments(verboseJson, offsetSeconds, language) {
    const segments = verboseJson?.segments;
    if (!Array.isArray(segments)) return [];

    const records = [];
    for (const segment of segments) {
      const text = String(segment?.text || "").trim();
      if (!text) continue;

      const start = Number(segment.start) || 0;
      const end = Number(segment.end) || start;
      const record = {
        text,
        start: Math.floor(offsetSeconds + start),
        duration: Math.max(0, Math.floor(end - start)),
      };
      if (language) record.language = language;
      records.push(record);
    }
    return records;
  }

  /**
   * Builds a failure-annotation Transcript record for a chunk whose request
   * failed outright, covering its [offsetSeconds, offsetSeconds+durationSeconds)
   * range so the gap is visible in the stitched output instead of silently
   * disappearing.
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
   * Formats whole seconds as `[m:ss]` (minutes unpadded, seconds
   * zero-padded). The single [m:ss] formatter for the extension:
   * speech-transcription stitching, transcript-for-prompt rendering, and
   * the background analysis layer all share it. Non-numeric or negative
   * input renders as 0:00.
   */
  function formatTimestamp(startSeconds) {
    const total = Math.max(0, Math.floor(Number(startSeconds) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  // --- shared Speech Provider cloud helpers ----------------------------------
  //
  // Used by the multi-request cloud Speech Providers (Tencent Cloud ASR,
  // Qwen ASR). Each provider used to carry its own copy of these; they now
  // live here once, next to the other shared pure helpers this module
  // already provides to every Speech Provider.

  /**
   * node:crypto when running under Node (tests), otherwise null. The
   * service worker has no require(), so providers fall through to Web
   * Crypto there.
   */
  function loadNodeCrypto() {
    if (typeof require !== "function") return null;
    try {
      return require("node:crypto");
    } catch (_error) {
      return null;
    }
  }

  /**
   * Base64-encodes a byte array on both platforms: Buffer in Node, chunked
   * btoa in the service worker.
   */
  function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString("base64");
    }
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /**
   * Region string with fallback: the provider's declared default region is
   * used when the configured value is missing or blank.
   */
  function normalizeRegion(region, fallback) {
    const trimmed = typeof region === "string" ? region.trim() : "";
    return trimmed || fallback;
  }

  /**
   * Maps the Segment audio's MIME type / file name to a cloud ASR format
   * value, one cascade shared by the Tencent Cloud and Qwen Speech
   * Providers. The two providers document nearly identical format lists;
   * the only real differences are the label they accept for the optimistic
   * webm/opus mapping (EBML is in neither documented list) and the fallback
   * value, both passed in here. Providers keep thin wrappers so their
   * provider-specific names and docs stay in place.
   */
  function detectCloudAudioFormat(segmentAudio, { opusFormat, fallback }) {
    const type = `${segmentAudio?.type || ""} ${segmentAudio?.name || ""}`.toLowerCase();
    if (type.includes("wav")) return "wav";
    if (type.includes("pcm")) return "pcm";
    if (type.includes("mp3") || type.includes("mpeg")) return "mp3";
    if (type.includes("m4a") || type.includes("mp4")) return "m4a";
    if (type.includes("aac")) return "aac";
    if (type.includes("amr")) return "amr";
    if (type.includes("silk")) return "silk";
    if (type.includes("speex")) return "speex";
    if (type.includes("ogg") || type.includes("opus") || type.includes("webm")) {
      return opusFormat;
    }
    return fallback;
  }

  /**
   * Stitches ordered per-chunk Transcript record lists (as produced by
   * alignChunkSegments/failedChunkRecord) into the same shape
   * captions.js:parseTimedtextJson3 returns: a flat transcript array plus
   * transcriptTextPlain and transcriptTextTimestamped strings.
   *
   * A failed record renders as "[MM:SS-MM:SS] 语音转录失败" in the
   * timestamped text and is skipped in transcriptTextPlain (there is no
   * text to show there).
   *
   * @param {Array<Array<object>>} chunkRecordLists - one array per chunk, in
   *   chunk order; each element is a Transcript record or a failed-chunk record
   * @returns {{transcript: object[], transcriptTextPlain: string, transcriptTextTimestamped: string, hasFailures: boolean}}
   */
  function stitchChunks(chunkRecordLists) {
    const transcript = [];
    let transcriptTextPlain = "";
    let transcriptTextTimestamped = "";
    let hasFailures = false;

    for (const records of chunkRecordLists) {
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        transcript.push(record);
        const startLabel = formatTimestamp(record.start);

        if (record.failed) {
          hasFailures = true;
          const endLabel = formatTimestamp(record.start + record.duration);
          transcriptTextTimestamped += `[${startLabel}-${endLabel}] ${FAILED_SEGMENT_TEXT}\n`;
          continue;
        }

        transcriptTextPlain += record.text + " ";
        transcriptTextTimestamped += `[${startLabel}] ${record.text}\n`;
      }
    }

    return {
      transcript,
      transcriptTextPlain: transcriptTextPlain.trim(),
      transcriptTextTimestamped: transcriptTextTimestamped.trim(),
      hasFailures,
    };
  }

  /**
   * True when every chunk in the list failed outright, meaning the overall
   * Speech Transcription attempt produced no usable text at all. Callers
   * use this to decide whether to fall back to the No-Caption Video message
   * instead of returning a transcript made entirely of failure markers.
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

  return {
    FAILED_SEGMENT_TEXT,
    alignChunkSegments,
    failedChunkRecord,
    stitchChunks,
    allChunksFailed,
    formatTimestamp,
    loadNodeCrypto,
    bytesToBase64,
    normalizeRegion,
    detectCloudAudioFormat,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SPEECH_TRANSCRIPTION;
}
