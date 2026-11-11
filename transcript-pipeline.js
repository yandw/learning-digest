/**
 * Transcript archive pipeline (ticket 2.4, issue #67; contract-r2.md
 * §3.1–§3.5, decisions D10/D11/D12/D15): the pure contract layer behind the
 * plugin's server-side ASR path. The learning Session's transcript no longer
 * comes from a local Speech Provider — audio Segments upload to the API
 * (D11), the Worker transcribes them, and the panel renders the polled
 * TranscriptView (§2.5).
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts. Follows the
 * learning-start.js pattern: fetch/clock/timers are injected so tests drive
 * every schedule deterministically, and the §1 error envelope helpers ride
 * the shared api-client.js module.
 *
 * Policies (contract + D12, the plugin's own call):
 * - Upload: one Segment = one POST audio-segments (§3.4). A network failure
 *   replays the SAME body byte-for-byte (the (sessionId, segmentIndex) key
 *   is idempotent: first store wins, resends answer 200 with the stored
 *   Segment). Bounded retries, then the Segment gives up loudly — the audio
 *   buffer is gone, so a silent loss is the honest outcome.
 * - 409 transcript_origin_conflict: the Session is locked to the captions
 *   path (D15) — ASR submission stops for good, the server's message is
 *   surfaced as-is.
 * - 409 session_already_finished: the Session was closed under us — stop
 *   uploading.
 * - 401: the credential was revoked; the wiring routes the P7
 *   handleCredentialsInvalidated path (capture stops, panel re-gates).
 * - 404: the Session is not ours (D2) — stop.
 * - Poll: GET transcript (§3.5) on a fixed 4s cadence (configurable), with
 *   exponential backoff while the network is down. The poller stops at the
 *   terminal view (finished and pending drained) and keeps polling briefly
 *   past finish until the Worker's tail results land.
 */
var YTD_TRANSCRIPT_PIPELINE = (() => {
  const apiClient =
    typeof YTD_API_CLIENT !== "undefined"
      ? YTD_API_CLIENT
      : require("./api-client.js");

  // Contract §3.4 bounds: durationMs ∈ [5000, 60000]; the encoded audio
  // caps at 10MB. Mirrors apps/api/lib/audio-jobs.js so a refused Segment
  // never leaves the client.
  const MIN_DURATION_MS = 5000;
  const MAX_DURATION_MS = 60000;
  const MAX_ENCODED_AUDIO_CHARS = 10_000_000;

  const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
  const DEFAULT_POLL_INTERVAL_MS = 4_000;
  const MAX_POLL_BACKOFF_MS = 30_000;
  // After finish, the Worker may still be draining the tail Segments; the
  // poller keeps going this many extra rounds at most before it accepts the
  // last view as final.
  const MAX_POST_FINISH_POLLS = 10;

  // ============================================================
  // PATHS AND REQUEST BUILDERS
  // ============================================================

  function sessionPath(sourceId) {
    return `/v1/sources/${encodeURIComponent(String(sourceId))}/sessions`;
  }

  function audioSegmentsPath(sessionId) {
    return `/v1/sessions/${encodeURIComponent(String(sessionId))}/audio-segments`;
  }

  function transcriptPath(sessionId) {
    return `/v1/sessions/${encodeURIComponent(String(sessionId))}/transcript`;
  }

  function finishPath(sessionId) {
    return `/v1/sessions/${encodeURIComponent(String(sessionId))}/finish`;
  }

  function buildSessionApiUrl(apiBaseUrl, sourceId) {
    return apiClient.buildApiUrl(apiBaseUrl, sessionPath(sourceId));
  }

  function buildAudioSegmentsApiUrl(apiBaseUrl, sessionId) {
    return apiClient.buildApiUrl(apiBaseUrl, audioSegmentsPath(sessionId));
  }

  function buildTranscriptApiUrl(apiBaseUrl, sessionId) {
    return apiClient.buildApiUrl(apiBaseUrl, transcriptPath(sessionId));
  }

  function buildFinishApiUrl(apiBaseUrl, sessionId) {
    return apiClient.buildApiUrl(apiBaseUrl, finishPath(sessionId));
  }

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
   * validation would 400 the whole finish.
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
  // RESPONSE PARSING (the §1 envelope and the §3.x payloads)
  // ============================================================

  /** One read of the response body; a non-JSON body parses to null. */
  async function readJson(response) {
    try {
      return await response.json();
    } catch (_error) {
      return null;
    }
  }

  /** §3.4 response Segment projection, or null when malformed. */
  function parseSegmentResponse(data) {
    const segment = data && typeof data === "object" ? data.segment : null;
    if (!segment || typeof segment !== "object") return null;
    if (!Number.isInteger(segment.segmentIndex) || segment.segmentIndex < 0) return null;
    if (!Number.isInteger(segment.startMs) || segment.startMs < 0) return null;
    if (!Number.isInteger(segment.endMs) || segment.endMs < segment.startMs) return null;
    if (segment.status !== "pending" && segment.status !== "transcribing" &&
        segment.status !== "done" && segment.status !== "failed") {
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

  /**
   * One HTTP attempt → verdict. The terminal verdicts (originConflict,
   * finished, unauthorized, notFound, invalid) never retry; only network
   * failures and 5xx go around the loop again. 429 counts as transient:
   * the server is telling us to slow down, not to stop.
   */
  function classifyUploadOutcome({ status, data, network, networkMessage }) {
    if (network) return { kind: "network", message: networkMessage };
    if (status >= 200 && status < 300) {
      const segment = parseSegmentResponse(data);
      if (segment) return { kind: "ok", segment };
      // A 2xx without a parseable Segment is an unexpected server answer:
      // treat it as terminal invalid — retrying cannot fix the shape.
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
    if (status === 401) return { kind: "unauthorized", code, message: apiClient.parseEnvelope(data, "凭据已失效") };
    if (status === 404) return { kind: "notFound", code, message: apiClient.parseEnvelope(data, "会话不存在") };
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

  /** §3.1 response Session projection, or null when malformed. */
  function parseSessionResponse(data) {
    const session = data && typeof data === "object" ? data.session : null;
    if (!session || typeof session !== "object") return null;
    if (typeof session.id !== "string" || !session.id) return null;
    if (typeof session.sourceId !== "string" || !session.sourceId) return null;
    if (session.status !== "active" && session.status !== "finished") return null;
    return {
      id: session.id,
      sourceId: session.sourceId,
      resourceId:
        typeof session.resourceId === "string" ? session.resourceId : null,
      status: session.status,
      origin:
        session.origin === "captions" || session.origin === "asr"
          ? session.origin
          : null,
    };
  }

  /**
   * The transient-retry loop shared by create/upload/finish: bounded
   * byte-level resends while the verdict stays "network", one sleep per
   * retryDelaysMs entry.
   */
  async function withTransientRetries(
    attempt,
    { retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, setTimeoutImpl } = {},
  ) {
    const sleep = makeSleep({ setTimeoutImpl });
    for (let i = 0; ; i += 1) {
      const outcome = await attempt(i);
      if (outcome.kind !== "network" || i >= retryDelaysMs.length) {
        return outcome;
      }
      await sleep(retryDelaysMs[i]);
    }
  }

  // ============================================================
  // §2.5 TranscriptView — parse and the §3.5 poll
  // ============================================================

  /**
   * §2.5 TranscriptView parse. All four arrays are always present on the
   * wire (possibly empty); malformed entries are dropped rather than
   * passed through, and records sort by startMs. Returns null for anything
   * that is not a recognizable view (an error envelope, garbage).
   */
  function parseTranscriptView(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const sessionStatus =
      data.sessionStatus === "finished" ? "finished"
        : data.sessionStatus === "active" ? "active"
          : null;
    if (!sessionStatus) return null;
    // §2.5: all four arrays are always present on the wire. A view missing
    // one is malformed — reported as null (the poller treats it as a
    // transient miss and retries) instead of an empty-array view that would
    // silently erase text the learner already saw.
    if (
      !Array.isArray(data.records) ||
      !Array.isArray(data.gaps) ||
      !Array.isArray(data.pending) ||
      !Array.isArray(data.failed)
    ) {
      return null;
    }
    const origin =
      data.origin === "captions" || data.origin === "asr" ? data.origin : null;
    const records = [];
    for (const record of Array.isArray(data.records) ? data.records : []) {
      if (!record || typeof record !== "object") continue;
      const startMs = Number(record.startMs);
      const endMs = Number(record.endMs);
      if (!Number.isInteger(startMs) || startMs < 0) continue;
      if (!Number.isInteger(endMs) || endMs < startMs) continue;
      if (typeof record.text !== "string" || record.text.trim() === "") continue;
      records.push({ startMs, endMs, text: record.text, origin: origin || record.origin || null });
    }
    records.sort((a, b) => a.startMs - b.startMs);
    const gaps = [];
    for (const gap of Array.isArray(data.gaps) ? data.gaps : []) {
      if (!gap || typeof gap !== "object") continue;
      const startMs = Number(gap.startMs);
      const endMs = Number(gap.endMs);
      if (!Number.isInteger(startMs) || startMs < 0) continue;
      if (!Number.isInteger(endMs) || endMs <= startMs) continue;
      gaps.push({ startMs, endMs, reason: gap.reason === "skipped" ? "skipped" : "skipped" });
    }
    gaps.sort((a, b) => a.startMs - b.startMs);
    const pending = [];
    for (const segment of Array.isArray(data.pending) ? data.pending : []) {
      if (!segment || typeof segment !== "object") continue;
      const startMs = Number(segment.startMs);
      const endMs = Number(segment.endMs);
      if (!Number.isInteger(segment.segmentIndex) || segment.segmentIndex < 0) continue;
      if (!Number.isInteger(startMs) || startMs < 0) continue;
      if (!Number.isInteger(endMs) || endMs <= startMs) continue;
      pending.push({
        segmentIndex: segment.segmentIndex,
        startMs,
        endMs,
        status: segment.status === "transcribing" ? "transcribing" : "pending",
      });
    }
    const failed = [];
    for (const segment of Array.isArray(data.failed) ? data.failed : []) {
      if (!segment || typeof segment !== "object") continue;
      const startMs = Number(segment.startMs);
      const endMs = Number(segment.endMs);
      if (!Number.isInteger(segment.segmentIndex) || segment.segmentIndex < 0) continue;
      if (!Number.isInteger(startMs) || startMs < 0) continue;
      if (!Number.isInteger(endMs) || endMs <= startMs) continue;
      const code = segment.error?.code;
      const message = segment.error?.message;
      if (typeof message !== "string" || message === "") continue;
      failed.push({
        segmentIndex: segment.segmentIndex,
        startMs,
        endMs,
        error: { code: typeof code === "string" ? code : "transcription_failed", message },
      });
    }
    return {
      sessionId:
        typeof data.sessionId === "string" ? data.sessionId : null,
      sourceId:
        typeof data.sourceId === "string" ? data.sourceId : null,
      resourceId:
        typeof data.resourceId === "string" ? data.resourceId : null,
      sessionStatus,
      origin,
      records,
      gaps,
      pending,
      failed,
    };
  }

  /**
   * The §3.5 poll loop. One GET at a time; the first poll fires on start()
   * and every subsequent one is scheduled by the previous outcome:
   *
   * - a parseable view reports through onView, then waits pollIntervalMs —
   *   unless the view is terminal (finished AND pending drained), which
   *   stops the poller with reason "terminal";
   * - finished but still draining keeps polling, at most
   *   maxPostFinishPolls further rounds, so the Worker's tail results land
   *   visibly before the poller stands down;
   * - network failures and malformed bodies back off exponentially
   *   (interval doubling, capped at maxBackoffMs) and never stop;
   * - 401 and 404 stop the poller through onStop — the wiring routes the
   *   401 to the P7 credentials-invalidated path, and a 404 (D2) means the
   *   Session is not ours to read.
   *
   * @param {object} options
   * @param {(url: string, init?: object) => Promise<Response>} options.fetchImpl
   * @param {string} options.apiBaseUrl
   * @param {string} options.token
   * @param {string} options.sessionId
   * @param {number} [options.pollIntervalMs] - the fixed cadence (default 4s)
   * @param {number} [options.maxBackoffMs] - the backoff cap (default 30s)
   * @param {number} [options.maxPostFinishPolls] - drain bound after finish
   * @param {Function} [options.setTimeoutImpl]
   * @param {Function} [options.clearTimeoutImpl]
   * @param {(view: object) => void} [options.onView]
   * @param {(info: {reason: "terminal"|"unauthorized"|"notFound", message?: string}) => void} [options.onStop]
   * @returns {{start: Function, stop: Function, running: Function}}
   */
  function createTranscriptPoller({
    fetchImpl,
    apiBaseUrl,
    token,
    sessionId,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxBackoffMs = MAX_POLL_BACKOFF_MS,
    maxPostFinishPolls = MAX_POST_FINISH_POLLS,
    setTimeoutImpl = (fn, delay) => setTimeout(fn, delay),
    clearTimeoutImpl = (id) => clearTimeout(id),
    onView = () => {},
    onStop = () => {},
  }) {
    const url = buildTranscriptApiUrl(apiBaseUrl, sessionId);
    let running = false;
    let stopped = false;
    let timerEntry = null;
    let consecutiveFailures = 0;
    let postFinishPolls = 0;

    function stopInternal(info) {
      if (stopped) return;
      stopped = true;
      running = false;
      if (timerEntry !== null) {
        clearTimeoutImpl(timerEntry);
        timerEntry = null;
      }
      try {
        onStop(info);
      } catch (_error) {
        // The hook must never break the loop teardown.
      }
    }

    function schedule(delayMs) {
      timerEntry = setTimeoutImpl(() => {
        timerEntry = null;
        void pollOnce();
      }, Math.max(0, delayMs));
    }

    async function pollOnce() {
      if (stopped) return;
      let outcome;
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await readJson(response);
        if (response.status >= 200 && response.status < 300) {
          const view = parseTranscriptView(data);
          if (view) {
            consecutiveFailures = 0;
            try {
              onView(view);
            } catch (_error) {
              // A throwing view consumer must not kill the poll.
            }
            if (view.sessionStatus === "finished") {
              if (view.pending.length === 0) {
                stopInternal({ reason: "terminal" });
                return;
              }
              // Finished but still draining: the Worker's tail results are
              // one poll away in the normal case; the bound keeps the loop
              // from spinning forever on a stuck Worker.
              if (postFinishPolls >= maxPostFinishPolls) {
                stopInternal({ reason: "terminal" });
                return;
              }
              postFinishPolls += 1;
            }
            schedule(pollIntervalMs);
            return;
          }
          outcome = { kind: "network" };
        } else if (response.status === 401) {
          stopInternal({
            reason: "unauthorized",
            message: apiClient.parseEnvelope(data, "凭据已失效"),
          });
          return;
        } else if (response.status === 404) {
          stopInternal({
            reason: "notFound",
            message: apiClient.parseEnvelope(data, "会话不存在"),
          });
          return;
        } else {
          outcome = { kind: "network" };
        }
      } catch (_error) {
        outcome = { kind: "network" };
      }
      if (stopped) return;
      consecutiveFailures += 1;
      const delay = Math.min(
        maxBackoffMs,
        pollIntervalMs * 2 ** Math.max(1, consecutiveFailures),
      );
      schedule(delay);
    }

    return {
      start() {
        if (stopped || running || !url) return;
        running = true;
        void pollOnce();
      },
      stop() {
        if (stopped) return;
        stopped = true;
        running = false;
        if (timerEntry !== null) {
          clearTimeoutImpl(timerEntry);
          timerEntry = null;
        }
      },
      running() {
        return running;
      },
    };
  }

  /**
   * One [m:ss] label from whole milliseconds — the gap-row vocabulary the
   * PoC established ([已跳过 m:ss–m:ss]). Minutes stay unpadded, seconds
   * zero-padded; negative or non-numeric input renders as 0:00.
   */
  function formatMsLabel(ms) {
    const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  const PENDING_ROW_TEXT = "转写中…";

  /**
   * The transcript tab's render input: the §2.5 view's four arrays merged
   * with the local upload-outstanding Segments into ONE ordered row list.
   *
   * Rows carry milliseconds (the contract's timeline) and a kind the panel
   * styles: "record" (archived text), "failed" (the server's message, 契约
   * 文案 as-is), "gap" (the skipped range, PoC marker copy) and "pending"
   * (waiting for the Worker — both the server-known pendings and the
   * Segments captured locally whose upload has not been accepted yet).
   *
   * A local pending Segment whose startMs the server already knows is
   * dropped — the same range must not render twice (the server's row is
   * authoritative once it exists). Rows sort by startMs; equal starts keep
   * kind priority record > gap > failed > pending so a pending spinner
   * never hides text that arrived for the same position.
   */
  function buildTranscriptRows(view, pendingSegments = []) {
    if (!view || typeof view !== "object") return [];
    const kindPriority = { record: 0, gap: 1, failed: 2, pending: 3 };
    const rows = [];
    for (const record of Array.isArray(view.records) ? view.records : []) {
      rows.push({
        kind: "record",
        startMs: record.startMs,
        endMs: record.endMs,
        text: record.text,
      });
    }
    for (const gap of Array.isArray(view.gaps) ? view.gaps : []) {
      rows.push({
        kind: "gap",
        startMs: gap.startMs,
        endMs: gap.endMs,
        text: `[已跳过 ${formatMsLabel(gap.startMs)}–${formatMsLabel(gap.endMs)}]`,
      });
    }
    for (const segment of Array.isArray(view.failed) ? view.failed : []) {
      rows.push({
        kind: "failed",
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: `转写失败：${segment.error.message}`,
      });
    }
    for (const segment of Array.isArray(view.pending) ? view.pending : []) {
      rows.push({
        kind: "pending",
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: PENDING_ROW_TEXT,
      });
    }
    const knownStarts = new Set(
      rows.map((row) => row.startMs),
    );
    for (const segment of Array.isArray(pendingSegments) ? pendingSegments : []) {
      const startMs = Math.round(Number(segment?.start) * 1000);
      const durationMs = Math.round(Number(segment?.duration) * 1000);
      if (!Number.isFinite(startMs) || startMs < 0) continue;
      if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
      if (knownStarts.has(startMs)) continue;
      rows.push({
        kind: "pending",
        startMs,
        endMs: startMs + durationMs,
        text: PENDING_ROW_TEXT,
      });
    }
    rows.sort(
      (a, b) =>
        a.startMs - b.startMs || kindPriority[a.kind] - kindPriority[b.kind],
    );
    return rows;
  }

  /**
   * §3.1 — 开始学习: creates the Session on the resolved Source. The body
   * is the contract's empty object (the account rides the credential, the
   * Source the path). Transient failures retry within the budget; a start
   * that cannot create its Session is refused outright by the wiring.
   *
   * @returns {Promise<{ok: true, session: object} | {ok: false, kind: string, message?: string}>}
   */
  async function createLearningSession({
    fetchImpl,
    apiBaseUrl,
    token,
    sourceId,
    retryDelaysMs,
    setTimeoutImpl,
  }) {
    const url = buildSessionApiUrl(apiBaseUrl, sourceId);
    if (!url) return { ok: false, kind: "invalid", message: "API base URL 未配置或非法" };
    return withTransientRetries(
      async () => {
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: "{}",
          });
          const data = await readJson(response);
          if (response.status >= 200 && response.status < 300) {
            const session = parseSessionResponse(data);
            if (session) return { ok: true, session };
            return { ok: false, kind: "invalid", message: "响应缺少合法的 session 字段" };
          }
          const kind =
            response.status === 401
              ? "unauthorized"
              : response.status === 404
                ? "notFound"
                : response.status >= 500 || response.status === 429
                  ? "network"
                  : "error";
          return {
            ok: false,
            kind,
            message: apiClient.parseEnvelope(data, `HTTP ${response.status}`),
          };
        } catch (error) {
          return { ok: false, kind: "network", message: error?.message || String(error) };
        }
      },
      { retryDelaysMs, setTimeoutImpl },
    );
  }

  /**
   * §3.2 — 收尾: closes the Session with the finish-reported gaps. The
   * repeat close answers 409 session_already_finished, which for the caller
   * IS a finished Session — reported as ok with alreadyFinished: true.
   *
   * @returns {Promise<{ok: true, session: object, alreadyFinished?: boolean} | {ok: false, kind: string, message?: string}>}
   */
  async function finishLearningSession({
    fetchImpl,
    apiBaseUrl,
    token,
    sessionId,
    gaps = [],
    retryDelaysMs,
    setTimeoutImpl,
  }) {
    const url = buildFinishApiUrl(apiBaseUrl, sessionId);
    if (!url) return { ok: false, kind: "invalid", message: "API base URL 未配置或非法" };
    const bodyText = JSON.stringify({ gaps: Array.isArray(gaps) ? gaps : [] });
    return withTransientRetries(
      async () => {
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: bodyText,
          });
          const data = await readJson(response);
          if (response.status >= 200 && response.status < 300) {
            const session = parseSessionResponse(data);
            if (session) return { ok: true, session };
            return { ok: false, kind: "invalid", message: "响应缺少合法的 session 字段" };
          }
          if (response.status === 409 && apiClient.envelopeCode(data) === "session_already_finished") {
            const session = parseSessionResponse(data);
            return { ok: true, session, alreadyFinished: true };
          }
          const kind =
            response.status === 401
              ? "unauthorized"
              : response.status === 404
                ? "notFound"
                : response.status === 400
                  ? "invalid"
                  : response.status >= 500 || response.status === 429
                    ? "network"
                    : "error";
          return {
            ok: false,
            kind,
            message: apiClient.parseEnvelope(data, `HTTP ${response.status}`),
          };
        } catch (error) {
          return { ok: false, kind: "network", message: error?.message || String(error) };
        }
      },
      { retryDelaysMs, setTimeoutImpl },
    );
  }

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
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    setTimeoutImpl,
  }) {
    const url = buildAudioSegmentsApiUrl(apiBaseUrl, sessionId);
    if (!url) return { kind: "invalid", message: "API base URL 未配置或非法" };
    if (!body || !buildAudioSegmentBody({
      segmentIndex: body.segmentIndex,
      startSeconds: body.startMs / 1000,
      durationSeconds: body.durationMs / 1000,
      audioBase64: body.audioBase64,
      audioMimeType: body.audioMimeType,
    })) {
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
        outcome = classifyUploadOutcome({ status: response.status, data: await readJson(response) });
      } catch (error) {
        outcome = classifyUploadOutcome({ network: true, networkMessage: error?.message || String(error) });
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
    DEFAULT_RETRY_DELAYS_MS,
    DEFAULT_POLL_INTERVAL_MS,
    MAX_POLL_BACKOFF_MS,
    MAX_POST_FINISH_POLLS,
    sessionPath,
    audioSegmentsPath,
    transcriptPath,
    finishPath,
    buildSessionApiUrl,
    buildAudioSegmentsApiUrl,
    buildTranscriptApiUrl,
    buildFinishApiUrl,
    buildAudioSegmentBody,
    buildFinishGaps,
    parseSegmentResponse,
    parseSessionResponse,
    parseTranscriptView,
    createTranscriptPoller,
    buildTranscriptRows,
    formatMsLabel,
    uploadAudioSegment,
    createLearningSession,
    finishLearningSession,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_TRANSCRIPT_PIPELINE;
}
