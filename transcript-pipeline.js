/**
 * Audio-segment upload client (ticket 2.4, issue #67; contract-r2.md §3.4,
 * decisions D10/D11/D12/D15): the ASR path's own contract piece. Everything
 * the Session lifecycle needs — §3.1 create, §3.2 finish, §3.3 captions,
 * §3.5 transcript parse and the view→row mappers — lives in the shared
 * session-archive.js module (ticket 2.5) and is reused from there; this
 * module carries only what that client does not have: the D11 segmented
 * audio upload.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts. Follows the
 * learning-start.js pattern: fetch/clock/timers are injected so tests drive
 * the schedule deterministically, and the §1 error envelope helpers ride
 * the shared api-client.js module.
 *
 * Upload policy (contract §3.4 + D12, the plugin's own call):
 * - One Segment = one POST audio-segments. A network failure replays the
 *   SAME body byte-for-byte — the (sessionId, segmentIndex) key is
 *   idempotent (first store wins; resends answer 200 with the stored
 *   Segment and never re-enqueue). Bounded retries, then the Segment gives
 *   up loudly: the audio buffer is gone, so a silent loss is the honest
 *   outcome.
 * - 409 transcript_origin_conflict: the Session is locked to the captions
 *   path (D15) — ASR submission stops for good; the server's message is
 *   surfaced verbatim (如实呈现).
 * - 409 session_already_finished: the Session was closed under us — stop
 *   uploading.
 * - 401: the credential was revoked; the wiring routes the P7
 *   handleCredentialsInvalidated path (capture stops, panel re-gates).
 * - 404: the Session is not ours (D2) — stop.
 * - 5xx/429 are transient (the server is asking to slow down, not to stop);
 *   any other 4xx is poison for that Segment.
 */
var YTD_TRANSCRIPT_PIPELINE = (() => {
  const apiClient =
    typeof YTD_API_CLIENT !== "undefined"
      ? YTD_API_CLIENT
      : require("./api-client.js");

  // Contract §3.4 bounds: durationMs ∈ [5000, 60000]; the encoded audio
  // caps at 10MB. Mirrors apps/api/lib/audio-jobs.js so a refused Segment
  // never leaves the client. The segmenter's tail flush keeps ≥ 5s, so a
  // shorter Segment can only be a bug — refused client-side.
  const MIN_DURATION_MS = 5000;
  const MAX_DURATION_MS = 60000;
  const MAX_ENCODED_AUDIO_CHARS = 10_000_000;

  // The ASR path's transcript poll (§3.5): the Worker turns a Segment
  // around in seconds-to-tens-of-seconds, so the fixed cadence is tighter
  // than the captions path's slow re-sync (2.5); the wiring reads these.
  const TRANSCRIPT_POLL_INTERVAL_MS = 4_000;
  const MAX_TRANSCRIPT_POLL_BACKOFF_MS = 30_000;

  // ============================================================
  // PATHS (§1: opaque ids are encoded — a hostile id must not change the
  // path shape; session-archive.js owns the other paths)
  // ============================================================

  function audioSegmentsPath(sessionId) {
    return `/v1/sessions/${encodeURIComponent(String(sessionId))}/audio-segments`;
  }

  function buildAudioSegmentsApiUrl(apiBaseUrl, sessionId) {
    return apiClient.buildApiUrl(apiBaseUrl, audioSegmentsPath(sessionId));
  }

  // ============================================================
  // §3.4 REQUEST BODY (D11)
  // ============================================================

  /**
   * §3.4 request body from one Segment. Times arrive in whole seconds on
   * the source-video timeline (session-segmenter's Segment) and leave as
   * milliseconds; audio rides as base64 (D11). Returns null when any field
   * is outside the contract's bounds — the request is refused client-side
   * instead of burning a round trip on a guaranteed 400.
   */
  function buildAudioSegmentBody({
    segmentIndex,
    startSeconds,
    durationSeconds,
    audioBase64,
    audioMimeType,
  }) {
    const index = Number(segmentIndex);
    const startMs = Math.round(Number(startSeconds) * 1000);
    const durationMs = Math.round(Number(durationSeconds) * 1000);
    if (!Number.isInteger(index) || index < 0) return null;
    if (!Number.isInteger(startMs) || startMs < 0) return null;
    if (!Number.isInteger(durationMs)) return null;
    if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) return null;
    if (typeof audioMimeType !== "string" || !audioMimeType.startsWith("audio/")) {
      return null;
    }
    if (typeof audioBase64 !== "string" || audioBase64 === "") return null;
    if (audioBase64.length > MAX_ENCODED_AUDIO_CHARS) return null;
    return {
      segmentIndex: index,
      startMs,
      durationMs,
      audioMimeType,
      audioBase64,
    };
  }

  /**
   * §3.2 finish gaps from the Session's seek-skipped markers ({start,
   * duration} in whole seconds, the session-pipeline gapSkipped record
   * shape). Malformed or inverted ranges are dropped — a gap that fails
   * validation would 400 the whole finish (session-archive.js's
   * buildFinishRequest re-checks the exact shape before it goes out).
   */
  function buildFinishGaps(markers) {
    const gaps = [];
    for (const marker of Array.isArray(markers) ? markers : []) {
      const startMs = Math.round(Number(marker?.start) * 1000);
      const durationMs = Math.round(Number(marker?.duration) * 1000);
      if (!Number.isFinite(startMs) || startMs < 0) continue;
      if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
      gaps.push({ startMs, endMs: startMs + durationMs });
    }
    return gaps;
  }

  // ============================================================
  // §3.4 UPLOAD VERDICTS + IDEMPOTENT REPLAY
  // ============================================================

  /** §3.4 response Segment projection, or null when malformed. */
  function parseSegmentResponse(data) {
    const segment = data && typeof data === "object" ? data.segment : null;
    if (!segment || typeof segment !== "object") return null;
    if (!Number.isInteger(segment.segmentIndex) || segment.segmentIndex < 0) return null;
    if (!Number.isInteger(segment.startMs) || segment.startMs < 0) return null;
    if (!Number.isInteger(segment.endMs) || segment.endMs < segment.startMs) return null;
    if (
      segment.status !== "pending" &&
      segment.status !== "transcribing" &&
      segment.status !== "done" &&
      segment.status !== "failed"
    ) {
      return null;
    }
    if (typeof segment.audioMimeType !== "string" || !segment.audioMimeType.startsWith("audio/")) {
      return null;
    }
    return {
      segmentIndex: segment.segmentIndex,
      startMs: segment.startMs,
      endMs: segment.endMs,
      status: segment.status,
      audioMimeType: segment.audioMimeType,
    };
  }

  /** One read of the response body; a non-JSON body parses to null. */
  async function readJson(response) {
    try {
      return await response.json();
    } catch (_error) {
      return null;
    }
  }

  /**
   * One HTTP attempt → verdict. The terminal verdicts (originConflict,
   * finished, unauthorized, notFound, invalid) never retry; only network
   * failures and 5xx/429 go around the loop again.
   */
  function classifyUploadOutcome({ status, data, network, networkMessage }) {
    if (network) return { kind: "network", message: networkMessage };
    if (status >= 200 && status < 300) {
      const segment = parseSegmentResponse(data);
      if (segment) return { kind: "ok", segment };
      // A 2xx without a parseable Segment is an unexpected server answer:
      // terminal invalid — retrying cannot fix the shape.
      return { kind: "invalid", message: "响应缺少合法的 segment 字段" };
    }
    const code = apiClient.envelopeCode(data);
    if (status === 409) {
      if (code === "transcript_origin_conflict") {
        return {
          kind: "originConflict",
          code,
          message: apiClient.parseEnvelope(data, "本次学习已按字幕归档，同一区间只采用一种方式"),
        };
      }
      if (code === "session_already_finished") {
        return {
          kind: "finished",
          code,
          message: apiClient.parseEnvelope(data, "本次学习已结束，不再接收音频"),
        };
      }
      return { kind: "invalid", message: apiClient.parseEnvelope(data, "请求被拒绝") };
    }
    if (status === 401) {
      return { kind: "unauthorized", code, message: apiClient.parseEnvelope(data, "凭据已失效") };
    }
    if (status === 404) {
      return { kind: "notFound", code, message: apiClient.parseEnvelope(data, "会话不存在") };
    }
    if (status === 400) {
      return { kind: "invalid", code, message: apiClient.parseEnvelope(data, "请求未通过校验") };
    }
    // 5xx and 429 are transient; any other 4xx is poison.
    if (status >= 500 || status === 429) return { kind: "network", message: `HTTP ${status}` };
    return { kind: "invalid", message: apiClient.parseEnvelope(data, `HTTP ${status}`) };
  }

  /**
   * The sleep for one retry delay; a non-positive delay needs no timer at
   * all (the progress writer's same test configuration rule).
   */
  function makeSleep({ setTimeoutImpl = (fn, delay) => setTimeout(fn, delay) } = {}) {
    return (ms) =>
      ms > 0
        ? new Promise((resolve) => {
            setTimeoutImpl(resolve, ms);
          })
        : Promise.resolve();
  }

  const DEFAULT_UPLOAD_RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

  /**
   * Uploads one Segment (§3.4). The body arrives prebuilt
   * (buildAudioSegmentBody) and is replayed byte-for-byte on every network
   * retry — the (sessionId, segmentIndex) idempotency key makes the replay
   * a 200 replay of the stored Segment, never a duplicate.
   *
   * @param {object} options
   * @param {(url: string, init?: object) => Promise<Response>} options.fetchImpl
   * @param {string} options.apiBaseUrl
   * @param {string} options.token
   * @param {string} options.sessionId - the API Session id (ses_…)
   * @param {object} options.body - buildAudioSegmentBody's shape
   * @param {number[]} [options.retryDelaysMs] - backoff waits inside one upload
   * @param {Function} [options.setTimeoutImpl]
   * @returns {Promise<{kind: "ok"|"originConflict"|"finished"|"unauthorized"|"notFound"|"invalid"|"network", segment?: object, code?: string, message?: string}>}
   */
  async function uploadAudioSegment({
    fetchImpl,
    apiBaseUrl,
    token,
    sessionId,
    body,
    retryDelaysMs = DEFAULT_UPLOAD_RETRY_DELAYS_MS,
    setTimeoutImpl,
  }) {
    const url = buildAudioSegmentsApiUrl(apiBaseUrl, sessionId);
    if (!url) return { kind: "invalid", message: "API base URL 未配置或非法" };
    if (
      !body ||
      !buildAudioSegmentBody({
        segmentIndex: body.segmentIndex,
        startSeconds: body.startMs / 1000,
        durationSeconds: body.durationMs / 1000,
        audioBase64: body.audioBase64,
        audioMimeType: body.audioMimeType,
      })
    ) {
      return { kind: "invalid", message: "音频段请求体不符合契约" };
    }
    const bodyText = JSON.stringify(body);
    const sleep = makeSleep({ setTimeoutImpl });
    for (let attempt = 0; ; attempt += 1) {
      let outcome;
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: bodyText,
        });
        outcome = classifyUploadOutcome({
          status: response.status,
          data: await readJson(response),
        });
      } catch (error) {
        outcome = classifyUploadOutcome({
          network: true,
          networkMessage: error?.message || String(error),
        });
      }
      if (outcome.kind !== "network" || attempt >= retryDelaysMs.length) {
        return outcome;
      }
      await sleep(retryDelaysMs[attempt]);
    }
  }

  return {
    MIN_DURATION_MS,
    MAX_DURATION_MS,
    TRANSCRIPT_POLL_INTERVAL_MS,
    MAX_TRANSCRIPT_POLL_BACKOFF_MS,
    DEFAULT_UPLOAD_RETRY_DELAYS_MS,
    audioSegmentsPath,
    buildAudioSegmentsApiUrl,
    buildAudioSegmentBody,
    buildFinishGaps,
    parseSegmentResponse,
    uploadAudioSegment,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_TRANSCRIPT_PIPELINE;
}
