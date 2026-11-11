/**
 * Round-2 audio ingestion + transcription tasks (contract-r2.md §3.4/§3.7;
 * ticket 2.3, issue #66; decisions D11/D13/D14/D15).
 *
 * Two endpoint families live here:
 * - POST /v1/sessions/:id/audio-segments — user Bearer. One ~30s segment
 *   (base64 audio + metadata in a JSON body, D11) is stored, a pending
 *   transcription task is enqueued, and the Session's transcript origin
 *   locks to "asr" (D15).
 * - POST /v1/worker/tasks/claim, POST /v1/worker/tasks/:id/result — worker
 *   Bearer only (a statically configured service credential, not a user
 *   credential). Pull model (D13): claim hands out pending tasks with the
 *   audio base64 inlined; result writes done/failed terminal states
 *   (pending -> transcribing -> done|failed, terminal states never roll
 *   back).
 *
 * Storage layout on the generic collection store:
 * - "sessions": contract-r2 §2.1 records (owned by ticket 2.1's session
 *   endpoints; this module only reads them and locks `origin`).
 * - "audioSegments", keyed "<sessionId>:<segmentIndex>" (the idempotency
 *   key): one row per uploaded segment incl. its task linkage and status.
 * - "transcriptionTasks", keyed taskId: the claimable task with the audio
 *   file reference and its state-machine state.
 * - "transcriptRecords": rows written by the done path. Ticket 2.2 (issue
 *   #65) will own the transcript read model; the minimal write below uses
 *   the contract-r2 §2.2 TranscriptRecord shape so the swap is mechanical.
 *
 * Audio bytes are temporary files outside the repo (config.audioDir): the
 * store keeps only the path. D14 cleanup: a done result deletes the file
 * immediately; a failed result keeps it. Session-end + grace-period
 * cleanup is an API deployment-side job (not this ticket) and would sweep
 * both this directory and stale rows; the deletion seam here
 * (deleteAudioFile) is where such a sweeper would hook in.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ApiError, validationFailed } = require("./errors");
const { generateId } = require("./ids");

// Transport guard for the audio-segment route: the contract caps the
// encoded audio at 10MB (contract-r2 §3.4); the JSON envelope and metadata
// ride on top, so the route accepts ~11MB before its own precise
// validation answers 400 with the contract message.
const AUDIO_BODY_MAX_BYTES = 11 * 1024 * 1024;

// Contract-r2 §3.4: the encoded audio itself is capped at 10MB.
const MAX_ENCODED_AUDIO_BYTES = 10 * 1024 * 1024;

// RFC 4648 §4 base64 (the wire format the extension's encoder emits).
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validate one audio-segment body (contract-r2 §3.4). Returns the coerced
 * fields; throws the contract 400s. Field order is fixed so a fault
 * always maps to one predictable message.
 */
function requireSegmentBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw validationFailed("缺少必填字段 segmentIndex");
  }

  if (body.segmentIndex === undefined || body.segmentIndex === null) {
    throw validationFailed("缺少必填字段 segmentIndex");
  }
  if (!Number.isInteger(body.segmentIndex) || body.segmentIndex < 0) {
    throw validationFailed("segmentIndex 必须是不小于 0 的整数");
  }

  if (body.startMs === undefined || body.startMs === null) {
    throw validationFailed("缺少必填字段 startMs");
  }
  if (!Number.isInteger(body.startMs) || body.startMs < 0) {
    throw validationFailed("startMs 必须是不小于 0 的整数");
  }

  if (body.durationMs === undefined || body.durationMs === null) {
    throw validationFailed("缺少必填字段 durationMs");
  }
  if (
    !Number.isInteger(body.durationMs) ||
    body.durationMs < 5000 ||
    body.durationMs > 60000
  ) {
    throw validationFailed("durationMs 必须在 5000 到 60000 毫秒之间");
  }

  if (
    body.audioMimeType === undefined ||
    body.audioMimeType === null ||
    body.audioMimeType === ""
  ) {
    throw validationFailed("缺少必填字段 audioMimeType");
  }
  if (typeof body.audioMimeType !== "string" || !body.audioMimeType.startsWith("audio/")) {
    throw validationFailed("audioMimeType 必须以 audio/ 开头");
  }

  if (body.audioBase64 === undefined || body.audioBase64 === null || body.audioBase64 === "") {
    throw validationFailed("缺少必填字段 audioBase64");
  }
  if (
    typeof body.audioBase64 !== "string" ||
    !BASE64_PATTERN.test(body.audioBase64)
  ) {
    throw validationFailed("audioBase64 必须是合法 base64");
  }
  if (body.audioBase64.length > MAX_ENCODED_AUDIO_BYTES) {
    throw validationFailed("音频超过 10MB 编码上限");
  }

  return {
    segmentIndex: body.segmentIndex,
    startMs: body.startMs,
    durationMs: body.durationMs,
    audioMimeType: body.audioMimeType,
    audioBase64: body.audioBase64,
  };
}

/** Cross-account or unknown Session reads/writes (D2: always 404). */
function notFoundSession() {
  return new ApiError(404, "not_found", "学习记录不存在或无权访问");
}

/** Unknown task result target (fixture error-worker-result-unknown-task). */
function notFoundTask() {
  return new ApiError(404, "not_found", "任务不存在");
}

/** A finished Session accepts no new audio (contract-r2 §3.4 fixture). */
function sessionAlreadyFinishedForAudio() {
  return new ApiError(409, "session_already_finished", "本次学习已结束，不再接收音频");
}

/** Captions-locked Session rejects audio (D15 single path per Session). */
function transcriptOriginConflictForAudio() {
  return new ApiError(409, "transcript_origin_conflict", "本次学习已按字幕归档，同一区间只采用一种方式");
}

/** Lookup the caller's own Session (D2: other accounts read as unknown). */
function requireSession({ store, accountId, sessionId }) {
  const session = store.get("sessions", sessionId);
  if (!session || session.accountId !== accountId) {
    throw notFoundSession();
  }
  return session;
}

/** Write the segment's decoded audio bytes to a temp file, return the path. */
function storeAudioFile({ config, bytes, taskId }) {
  fs.mkdirSync(config.audioDir, { recursive: true });
  const file = path.join(config.audioDir, `${taskId}.audio`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** D14 deletion seam: done results drop the temp audio; re-deleting is a no-op. */
function deleteAudioFile(audioFile) {
  try {
    fs.unlinkSync(audioFile);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/** Contract-r2 §3.4 segment projection (exactly the fixture's five fields). */
function presentSegment(segment) {
  return {
    segmentIndex: segment.segmentIndex,
    startMs: segment.startMs,
    endMs: segment.endMs,
    status: segment.status,
    audioMimeType: segment.audioMimeType,
  };
}

/** Worker endpoints 401 (fixture error-worker-claim-unauthorized). */
function workerUnauthorized() {
  return new ApiError(401, "unauthorized", "Worker 凭据缺失或无效");
}

/** Constant-time compare for the static worker token. */
function tokensEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Worker service credential guard (contract-r2 §3.7): the endpoints accept
 * only the statically configured bearer token — never a user credential
 * (an implementation decision of ticket 2.3; issuance/rotation is ops
 * territory per D13). An empty configured token rejects everything, so a
 * misconfigured deployment fails closed.
 */
function requireWorkerCredential({ req, config, bearerToken }) {
  const token = bearerToken(req);
  if (!config.workerToken || typeof token !== "string" || !tokensEqual(token, config.workerToken)) {
    throw workerUnauthorized();
  }
}

/**
 * Parse the claim body's limit (contract-r2 §3.7): positive integer,
 * default 1, server cap 10 (larger values are clamped, not rejected).
 */
function parseClaimLimit(body) {
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) {
    throw validationFailed("limit 必须是正整数");
  }
  const requested = body && body.limit !== undefined && body.limit !== null ? body.limit : 1;
  if (!Number.isInteger(requested) || requested < 1) {
    throw validationFailed("limit 必须是正整数");
  }
  return Math.min(requested, 10);
}

/**
 * Claim order (contract-r2 §3.7): segmentIndex ascending; ties (tasks from
 * different sessions) break by claim age, then taskId, for determinism.
 */
function bySegmentOrder(a, b) {
  if (a.segmentIndex !== b.segmentIndex) {
    return a.segmentIndex - b.segmentIndex;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.taskId < b.taskId ? -1 : 1;
}

/**
 * Atomically move up to `limit` pending tasks to transcribing and hand
 * them out with the audio base64 inlined (D13: one handover, no second
 * fetch endpoint). Single-threaded Node makes the scan + transition atomic
 * within one request.
 */
function claimTasks({ store, now, limit }) {
  const pending = store
    .list("transcriptionTasks")
    .filter((task) => task.status === "pending")
    .sort(bySegmentOrder)
    .slice(0, limit);

  const tasks = pending.map((task) => {
    const audioBase64 = fs.readFileSync(task.audioFile).toString("base64");
    store.set("transcriptionTasks", task.taskId, { ...task, status: "transcribing", claimedAt: now() });
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      sourceId: task.sourceId,
      segmentIndex: task.segmentIndex,
      startMs: task.startMs,
      endMs: task.endMs,
      audioMimeType: task.audioMimeType,
      audioBase64,
    };
  });
  return { status: 200, body: { tasks } };
}

/**
 * Validate one result body (contract-r2 §3.7): either done with a records
 * array (TranscriptRecord timestamps; [] is a silence segment), or failed
 * with the round-2's single task error code. Returns the validated shape.
 */
function requireResultBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw validationFailed("status 必须是 done 或 failed");
  }
  if (body.status !== "done" && body.status !== "failed") {
    throw validationFailed("status 必须是 done 或 failed");
  }
  if (body.status === "done") {
    if (!Array.isArray(body.records)) {
      throw validationFailed("records 必须是数组");
    }
    const records = body.records.map((record, index) => {
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw validationFailed(`records[${index}] 必须是对象`);
      }
      if (
        !Number.isInteger(record.startMs) ||
        record.startMs < 0 ||
        !Number.isInteger(record.endMs) ||
        record.endMs < record.startMs
      ) {
        throw validationFailed(`records[${index}] 时间戳必须满足 0 ≤ startMs ≤ endMs`);
      }
      if (typeof record.text !== "string" || record.text.trim() === "") {
        throw validationFailed(`records[${index}].text 不能为空`);
      }
      return { startMs: record.startMs, endMs: record.endMs, text: record.text };
    });
    return { status: "done", records };
  }
  const error = body.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    throw validationFailed("error 必须是 { code, message }");
  }
  if (error.code !== "transcription_failed") {
    throw validationFailed("error.code 固定为 transcription_failed");
  }
  if (typeof error.message !== "string" || error.message.trim() === "") {
    throw validationFailed("error.message 不能为空");
  }
  return { status: "failed", error: { code: error.code, message: error.message } };
}

/**
 * Write the done path's transcript rows (contract-r2 §2.2 TranscriptRecord
 * shape, origin locked "asr" — the timestamps arrived already folded to the
 * source timeline). Ticket 2.2 (issue #65) owns the transcript read model;
 * until its write interface lands on the integration branch, this minimal
 * writer keeps the contract shape so the swap is mechanical.
 * 2.2 合入后统一.
 */
function writeDoneRecords({ store, task, records }) {
  records.forEach((record, index) => {
    store.set("transcriptRecords", `${task.sessionId}:${task.taskId}:${index}`, {
      sessionId: task.sessionId,
      accountId: task.accountId,
      sourceId: task.sourceId,
      startMs: record.startMs,
      endMs: record.endMs,
      text: record.text,
      origin: "asr",
      taskId: task.taskId,
    });
  });
}

/** Mark the owning segment done|failed so the transcript view's pending/failed arrays stay in step. */
function markSegment({ store, task, status, error }) {
  const key = `${task.sessionId}:${task.segmentIndex}`;
  const segment = store.get("audioSegments", key);
  if (segment) {
    store.set("audioSegments", key, { ...segment, status, error: error || null });
  }
}

/**
 * Apply one worker result (contract-r2 §3.7). First result wins
 * (幂等总则): a resend replays the stored terminal status without
 * re-applying, and terminal states never roll back. A result against a
 * still-pending task is rejected (400): the state machine is
 * pending -> transcribing -> done|failed, and no step may be skipped.
 */
function applyTaskResult({ store, taskId, body }) {
  const task = store.get("transcriptionTasks", taskId);
  if (!task) {
    throw notFoundTask();
  }
  const fields = requireResultBody(body);

  if (task.status === "done" || task.status === "failed") {
    // 首存为准: replay the first stored terminal status, ignore the body.
    return { status: 200, body: { taskId: task.taskId, status: task.status } };
  }
  if (task.status === "pending") {
    throw validationFailed("任务尚未领取，不能回写结果");
  }

  if (fields.status === "done") {
    writeDoneRecords({ store, task, records: fields.records });
    // D14: a done task's audio has no second consumer — delete immediately.
    deleteAudioFile(task.audioFile);
    store.set("transcriptionTasks", task.taskId, {
      ...task,
      status: "done",
      result: { records: fields.records },
    });
    markSegment({ store, task, status: "done" });
  } else {
    // D14: failed audio is retained until session end + grace period
    // (deployment-side sweeper, not this ticket).
    store.set("transcriptionTasks", task.taskId, {
      ...task,
      status: "failed",
      result: { error: fields.error },
    });
    markSegment({ store, task, status: "failed", error: fields.error });
  }
  return { status: 200, body: { taskId: task.taskId, status: fields.status } };
}

/**
 * Store one audio segment (contract-r2 §3.4). First write for the
 * (sessionId, segmentIndex) key wins and locks the Session's origin to
 * "asr"; a repeat is a 200 replay of the stored segment (no overwrite, no
 * second task). Order is never enforced — segmentIndex is the placement.
 */
function ingestAudioSegment({ store, now, config, accountId, sessionId, body }) {
  const fields = requireSegmentBody(body);
  const session = requireSession({ store, accountId, sessionId });

  // Idempotency first (contract-r2 §1): a replay of an already-stored
  // segment is a 200 replay even if the session finished in the meantime —
  // the 409 stop signal is for NEW segments.
  const key = `${sessionId}:${fields.segmentIndex}`;
  const existing = store.get("audioSegments", key);
  if (existing) {
    return { status: 200, body: { segment: presentSegment(existing) } };
  }

  if (session.status === "finished") {
    throw sessionAlreadyFinishedForAudio();
  }
  if (session.origin === "captions") {
    throw transcriptOriginConflictForAudio();
  }

  const audioBytes = Buffer.from(fields.audioBase64, "base64");
  const taskId = generateId("tsk");
  const audioFile = storeAudioFile({ config, bytes: audioBytes, taskId });
  const startMs = fields.startMs;
  const endMs = startMs + fields.durationMs;

  const task = {
    taskId,
    sessionId,
    accountId,
    sourceId: session.sourceId,
    segmentIndex: fields.segmentIndex,
    startMs,
    endMs,
    audioMimeType: fields.audioMimeType,
    audioFile,
    status: "pending",
    result: null,
    createdAt: now(),
    claimedAt: null,
  };
  store.set("transcriptionTasks", taskId, task);

  const segment = {
    sessionId,
    accountId,
    segmentIndex: fields.segmentIndex,
    startMs,
    endMs,
    durationMs: fields.durationMs,
    audioMimeType: fields.audioMimeType,
    audioFile,
    taskId,
    status: "pending",
    error: null,
    createdAt: now(),
  };
  store.set("audioSegments", key, segment);

  // D15: the first audio segment locks the Session onto the asr path.
  if (session.origin !== "asr") {
    store.set("sessions", sessionId, { ...session, origin: "asr" });
  }

  return { status: 201, body: { segment: presentSegment(segment) } };
}

/**
 * Register the round-2 audio/task routes. `requireCredential` and
 * `bearerToken` come from routes.js so the user-facing endpoint shares the
 * round-1 auth semantics; the worker endpoints authenticate against
 * config.workerToken instead (empty token = no worker may ever claim).
 */
function registerAudioJobRoutes({ router, store, now, config, requireCredential, bearerToken }) {
  router.add(
    "POST",
    "/v1/sessions/:id/audio-segments",
    async ({ req, params, body }) => {
      const credential = requireCredential(req);
      return ingestAudioSegment({
        store,
        now,
        config,
        accountId: credential.accountId,
        sessionId: params.id,
        body,
      });
    },
    { maxBodyBytes: AUDIO_BODY_MAX_BYTES },
  );

  // POST /v1/worker/tasks/claim — worker credential only (§3.7, D13).
  router.add("POST", "/v1/worker/tasks/claim", async ({ req, body }) => {
    requireWorkerCredential({ req, config, bearerToken });
    return claimTasks({ store, now, limit: parseClaimLimit(body) });
  });

  // POST /v1/worker/tasks/:id/result — worker credential only (§3.7).
  router.add("POST", "/v1/worker/tasks/:id/result", async ({ req, params, body }) => {
    requireWorkerCredential({ req, config, bearerToken });
    return applyTaskResult({ store, taskId: params.id, body });
  });
}

module.exports = {
  registerAudioJobRoutes,
  ingestAudioSegment,
  claimTasks,
  applyTaskResult,
  requireWorkerCredential,
  AUDIO_BODY_MAX_BYTES,
  deleteAudioFile,
};
