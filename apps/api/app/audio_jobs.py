"""Round-2 audio ingestion + transcription tasks (contract-r2.md §3.4/§3.7;
ticket 4.3 / Node ticket 2.3, issue #66; decisions D11/D13/D14/D15). Port
of lib/audio-jobs.js.

Two endpoint families live here:
- POST /v1/sessions/{id}/audio-segments — user Bearer. One ~30s segment
  (base64 audio + metadata in a JSON body, D11) is stored, a pending
  transcription task is enqueued, and the Session's transcript origin
  locks to "asr" (D15).
- POST /v1/worker/tasks/claim, POST /v1/worker/tasks/{id}/result — worker
  Bearer only (a statically configured service credential, not a user
  credential). Pull model (D13): claim hands out pending tasks with the
  audio base64 inlined; result writes done/failed terminal states
  (pending -> transcribing -> done|failed, terminal states never roll
  back).

Storage split (2.2 合入后统一): the transcript STATE (segment statuses,
asr records, pending/failed projection) lives in app/transcripts.py's
"transcripts" collection and is only touched through its write interface
— claim_audio_origin, upsert_audio_segment, apply_segment* — so the
TranscriptView (§2.5) stays consistent. This module owns the task QUEUE
and the audio bytes: "transcriptionTasks" (keyed taskId: the claimable
task, its state-machine state and the audio file reference) plus temp
files outside the repo (config.audio_dir). D14 cleanup: a done result
deletes the file immediately; a failed result keeps it. Session-end +
grace-period cleanup is an API deployment-side job (not this ticket) and
would sweep both this directory and stale task rows; the deletion seam
here (delete_audio_file) is where such a sweeper would hook in.

The done write-back also accrues the account's audioSeconds usage (D18,
app/usage.py) — behind the first-result gate, so a replay can never
double-record.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import os
import re
from typing import Any, Callable

from .errors import ApiError, not_found_session, validation_failed
from .fields import require_int_field
from .jsnum import coerce_js_integer, is_js_integer
from .http import bearer_token
from .ids import generate_id
from .sessions import find_account_session
from .transcripts import (
    apply_segment_done,
    apply_segment_failed,
    apply_segment_transcribing,
    claim_audio_origin,
    transcript_origin_conflict,
    upsert_audio_segment,
)
from .usage import record_audio_seconds

# Transport guard for the audio-segment route: the contract caps the
# encoded audio at 10MB (contract-r2 §3.4); the JSON envelope and metadata
# ride on top, so the route accepts ~11MB before its own precise
# validation answers 400 with the contract message.
AUDIO_BODY_MAX_BYTES = 11 * 1024 * 1024

# Contract-r2 §3.4: the encoded audio itself is capped at 10MB.
MAX_ENCODED_AUDIO_BYTES = 10 * 1024 * 1024

# RFC 4648 §4 base64 (the wire format the extension's encoder emits).
BASE64_PATTERN = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def require_segment_body(body: Any) -> dict:
    """Validate one audio-segment body (contract-r2 §3.4). Returns the
    coerced fields; raises the contract 400s. Field order is fixed so a
    fault always maps to one predictable message."""
    segment_index = require_int_field(
        body,
        "segmentIndex",
        missing_message="缺少必填字段 segmentIndex",
        invalid_message="segmentIndex 必须是不小于 0 的整数",
        non_dict_is_missing=False,
    )
    start_ms = require_int_field(
        body,
        "startMs",
        missing_message="缺少必填字段 startMs",
        invalid_message="startMs 必须是不小于 0 的整数",
        non_dict_is_missing=False,
    )
    duration_ms = require_int_field(
        body,
        "durationMs",
        missing_message="缺少必填字段 durationMs",
        invalid_message="durationMs 必须在 5000 到 60000 毫秒之间",
        min_value=5000,
        max_value=60000,
        non_dict_is_missing=False,
    )

    if body.get("audioMimeType") is None or body["audioMimeType"] == "":
        raise validation_failed("缺少必填字段 audioMimeType")
    if not isinstance(body["audioMimeType"], str) or not body["audioMimeType"].startswith("audio/"):
        raise validation_failed("audioMimeType 必须以 audio/ 开头")

    if body.get("audioBase64") is None or body["audioBase64"] == "":
        raise validation_failed("缺少必填字段 audioBase64")
    if not isinstance(body["audioBase64"], str) or not BASE64_PATTERN.fullmatch(body["audioBase64"]):
        raise validation_failed("audioBase64 必须是合法 base64")
    if len(body["audioBase64"]) > MAX_ENCODED_AUDIO_BYTES:
        raise validation_failed("音频超过 10MB 编码上限")

    return {
        "segmentIndex": coerce_js_integer(segment_index),
        "startMs": coerce_js_integer(start_ms),
        "durationMs": coerce_js_integer(duration_ms),
        "audioMimeType": body["audioMimeType"],
        "audioBase64": body["audioBase64"],
    }


def not_found_task() -> ApiError:
    """Unknown task result target (fixture error-worker-result-unknown-task)."""
    return ApiError(404, "not_found", "任务不存在")


def session_already_finished_for_audio() -> ApiError:
    """A finished Session accepts no new audio (contract-r2 §3.4 fixture)."""
    return ApiError(409, "session_already_finished", "本次学习已结束，不再接收音频")


# The captions-locked conflict body comes from transcripts.transcript_origin_conflict("captions")
# via claim_audio_origin — the same 409 code, mirrored message.


def require_session(*, store: Any, account_id: str, session_id: str) -> dict:
    """Lookup the caller's own Session (D2: other accounts read as unknown)."""
    session = find_account_session(store=store, account_id=account_id, session_id=session_id)
    if not session:
        raise not_found_session()
    return session


def store_audio_file(*, config: Any, data: bytes, task_id: str) -> str:
    """Write the segment's decoded audio bytes to a temp file, return the path."""
    os.makedirs(config.audio_dir, exist_ok=True)
    audio_file = os.path.join(config.audio_dir, f"{task_id}.audio")
    with open(audio_file, "wb") as fh:
        fh.write(data)
    return audio_file


def delete_audio_file(audio_file: str) -> None:
    """D14 deletion seam: done results drop the temp audio; re-deleting is
    a no-op."""
    try:
        os.unlink(audio_file)
    except FileNotFoundError:
        pass


def present_segment(segment: dict) -> dict:
    """Contract-r2 §3.4 segment projection (exactly the fixture's five fields)."""
    return {
        "segmentIndex": segment["segmentIndex"],
        "startMs": segment["startMs"],
        "endMs": segment["endMs"],
        "status": segment["status"],
        "audioMimeType": segment["audioMimeType"],
    }


def worker_unauthorized() -> ApiError:
    """Worker endpoints 401 (fixture error-worker-claim-unauthorized)."""
    return ApiError(401, "unauthorized", "Worker 凭据缺失或无效")


def tokens_equal(a: str, b: str) -> bool:
    """Constant-time compare for the static worker token."""
    left = str(a).encode("utf-8")
    right = str(b).encode("utf-8")
    if len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)


def require_worker_credential(*, request: Any, config: Any) -> None:
    """Worker service credential guard (contract-r2 §3.7): the endpoints
    accept only the statically configured bearer token — never a user
    credential (an implementation decision of ticket 2.3; issuance/rotation
    is ops territory per D13). An empty configured token rejects
    everything, so a misconfigured deployment fails closed."""
    token = bearer_token(request)
    if (
        not config.worker_token
        or not isinstance(token, str)
        or not tokens_equal(token, config.worker_token)
    ):
        raise worker_unauthorized()


def parse_claim_limit(body: Any) -> int:
    """Parse the claim body's limit (contract-r2 §3.7): positive integer,
    default 1, server cap 10 (larger values are clamped, not rejected)."""
    if body is not None and not isinstance(body, dict):
        raise validation_failed("limit 必须是正整数")
    requested = body.get("limit") if isinstance(body, dict) and body.get("limit") is not None else 1
    if not is_js_integer(requested) or requested < 1:
        raise validation_failed("limit 必须是正整数")
    return min(int(requested), 10)


def claim_tasks(*, store: Any, now: Callable[[], int], limit: int) -> dict:
    """Atomically move up to `limit` pending tasks to transcribing and hand
    them out with the audio base64 inlined (D13: one handover, no second
    fetch endpoint). The request-scoped scan + transition is atomic the
    same way single-threaded Node's was.

    Claim order (contract-r2 §3.7): segmentIndex ascending; ties (tasks
    from different sessions) break by claim age, then taskId, for
    determinism."""
    pending = [t for t in store.list("transcriptionTasks") if t["status"] == "pending"]
    pending.sort(key=lambda t: (t["segmentIndex"], t["createdAt"], t["taskId"]))
    pending = pending[:limit]

    tasks = []
    for task in pending:
        with open(task["audioFile"], "rb") as fh:
            audio_base64 = base64.b64encode(fh.read()).decode("ascii")
        store.set(
            "transcriptionTasks",
            task["taskId"],
            {**task, "status": "transcribing", "claimedAt": now()},
        )
        # The transcript state's segment mirrors the task state machine, so
        # the TranscriptView's pending[] shows "transcribing" while it works.
        apply_segment_transcribing(
            store=store, session_id=task["sessionId"], segment_index=task["segmentIndex"]
        )
        tasks.append(
            {
                "taskId": task["taskId"],
                "sessionId": task["sessionId"],
                "sourceId": task["sourceId"],
                "segmentIndex": task["segmentIndex"],
                "startMs": task["startMs"],
                "endMs": task["endMs"],
                "audioMimeType": task["audioMimeType"],
                "audioBase64": audio_base64,
            }
        )
    return {"status": 200, "body": {"tasks": tasks}}


def require_result_body(body: Any) -> dict:
    """Validate one result body (contract-r2 §3.7): either done with a
    records array (TranscriptRecord timestamps; [] is a silence segment),
    or failed with the round-2's single task error code. Returns the
    validated shape."""
    if not isinstance(body, dict):
        raise validation_failed("status 必须是 done 或 failed")
    if body.get("status") not in ("done", "failed"):
        raise validation_failed("status 必须是 done 或 failed")

    if body["status"] == "done":
        if "records" not in body or not isinstance(body["records"], list):
            raise validation_failed("records 必须是数组")
        records = []
        for index, record in enumerate(body["records"]):
            if not isinstance(record, dict):
                raise validation_failed(f"records[{index}] 必须是对象")
            start_ms = record.get("startMs")
            end_ms = record.get("endMs")
            if (
                not is_js_integer(start_ms)
                or start_ms < 0
                or not is_js_integer(end_ms)
                or end_ms < start_ms
            ):
                raise validation_failed(f"records[{index}] 时间戳必须满足 0 ≤ startMs ≤ endMs")
            text = record.get("text")
            if not isinstance(text, str) or text.strip() == "":
                raise validation_failed(f"records[{index}].text 不能为空")
            records.append(
                {
                    "startMs": coerce_js_integer(start_ms),
                    "endMs": coerce_js_integer(end_ms),
                    "text": text,
                }
            )
        return {"status": "done", "records": records}

    error = body.get("error")
    if not isinstance(error, dict):
        raise validation_failed("error 必须是 { code, message }")
    if error.get("code") != "transcription_failed":
        raise validation_failed("error.code 固定为 transcription_failed")
    message = error.get("message")
    if not isinstance(message, str) or message.strip() == "":
        raise validation_failed("error.message 不能为空")
    return {"status": "failed", "error": {"code": error["code"], "message": message}}


def apply_task_result(
    *, store: Any, task_id: str, body: Any, now: Callable[[], int]
) -> dict:
    """Apply one worker result (contract-r2 §3.7). First result wins
    (幂等总则): a resend replays the stored terminal status without
    re-applying, and terminal states never roll back. A result against a
    still-pending task is rejected (400): the state machine is
    pending -> transcribing -> done|failed, and no step may be skipped.
    The transcript state itself moves through app/transcripts.py's
    apply_segment_done/apply_segment_failed (no-ops once terminal, so a
    double-submitted result can never double-append records)."""
    task = store.get("transcriptionTasks", task_id)
    if not task:
        raise not_found_task()
    fields = require_result_body(body)

    if task["status"] in ("done", "failed"):
        # 首存为准: replay the first stored terminal status, ignore the body.
        return {"status": 200, "body": {"taskId": task["taskId"], "status": task["status"]}}
    if task["status"] == "pending":
        raise validation_failed("任务尚未领取，不能回写结果")

    if fields["status"] == "done":
        apply_segment_done(
            store=store,
            session_id=task["sessionId"],
            segment_index=task["segmentIndex"],
            records=fields["records"],
        )
        # D18: audioSeconds accrues at the first-done write-back — this
        # branch only runs for a non-terminal task (the replay path above
        # returns early), so a resend can never double-record. Silent
        # segments (empty records) count too; failed/transcribing never
        # reach this branch.
        record_audio_seconds(
            store=store,
            account_id=task["accountId"],
            duration_ms=task["endMs"] - task["startMs"],
            now=now,
        )
        # D14: a done task's audio has no second consumer — delete immediately.
        delete_audio_file(task["audioFile"])
        store.set(
            "transcriptionTasks",
            task["taskId"],
            {**task, "status": "done", "result": {"records": fields["records"]}},
        )
    else:
        # D14: failed audio is retained until session end + grace period
        # (deployment-side sweeper, not this ticket).
        apply_segment_failed(
            store=store,
            session_id=task["sessionId"],
            segment_index=task["segmentIndex"],
            error=fields["error"],
        )
        store.set(
            "transcriptionTasks",
            task["taskId"],
            {**task, "status": "failed", "result": {"error": fields["error"]}},
        )
    return {"status": 200, "body": {"taskId": task["taskId"], "status": fields["status"]}}


def enqueue_transcription_task(
    *,
    store: Any,
    now: Callable[[], int],
    config: Any,
    session: dict,
    account_id: str,
    segment: dict,
    audio_base64: str,
) -> dict:
    """Enqueue one pending transcription task for an already-stored
    segment. Shared by the first-write path and the crash-window self-heal
    below so "one stored segment ⇒ exactly one task" has a single
    implementation."""
    try:
        # Buffer.from(str, "base64") decodes leniently: a dangling final
        # character (length % 4 == 1) is dropped rather than rejected, and
        # the trailing padding is optional. Mirror that so the Python port
        # accepts exactly the wire strings Node would have decoded.
        payload = audio_base64.rstrip("=")
        if len(payload) % 4 == 1:
            payload = payload[:-1]
        audio_bytes = base64.b64decode(payload + "=" * (-len(payload) % 4))
    except (binascii.Error, ValueError) as exc:  # pragma: no cover - guarded by the pattern
        raise validation_failed("audioBase64 必须是合法 base64") from exc
    task_id = generate_id("tsk")
    audio_file = store_audio_file(config=config, data=audio_bytes, task_id=task_id)

    task = {
        "taskId": task_id,
        "sessionId": session["id"],
        "accountId": account_id,
        "sourceId": session["sourceId"],
        "segmentIndex": segment["segmentIndex"],
        "startMs": segment["startMs"],
        "endMs": segment["endMs"],
        "audioMimeType": segment["audioMimeType"],
        "audioFile": audio_file,
        "status": "pending",
        "result": None,
        "createdAt": now(),
        "claimedAt": None,
    }
    store.set("transcriptionTasks", task_id, task)
    return task


def find_segment_task(*, store: Any, session_id: str, segment_index: int) -> dict | None:
    """The (sessionId, segmentIndex) → task lookup behind the crash-window
    self-heal: a task row is the only proof a stored segment will ever be
    transcribed."""
    return next(
        (
            task
            for task in store.list("transcriptionTasks")
            if task["sessionId"] == session_id and task["segmentIndex"] == segment_index
        ),
        None,
    )


def ingest_audio_segment(
    *,
    store: Any,
    now: Callable[[], int],
    config: Any,
    account_id: str,
    session_id: str,
    body: Any,
) -> dict:
    """Store one audio segment (contract-r2 §3.4). Failure order matches
    the captions path: 400 validation, 404 (D2), 409 finished (已结束不再
    接收 — also covers resends, so a late byte-level replay after finish is
    the same stop signal as a new segment), 409 origin conflict via
    claim_audio_origin (D15). First write for the (sessionId, segmentIndex)
    key wins and enqueues exactly one task; a repeat is a 200 replay of the
    stored segment (no overwrite, no second task) — unless the crash window
    between storing the segment and enqueueing its task swallowed the task,
    in which case the resend self-heals by enqueueing it (the resent audio
    bytes rebuild the audio file; the stored segment's fields stay 首存为
    准). Order is never enforced — segmentIndex is the placement."""
    fields = require_segment_body(body)
    session = require_session(store=store, account_id=account_id, session_id=session_id)

    if session["status"] == "finished":
        raise session_already_finished_for_audio()
    # D15: locks origin None -> "asr", 409 when captions already locked.
    claim_audio_origin(store=store, session=session)

    upserted = upsert_audio_segment(
        store=store,
        session_id=session_id,
        segment={
            "segmentIndex": fields["segmentIndex"],
            "startMs": fields["startMs"],
            "endMs": fields["startMs"] + fields["durationMs"],
            "audioMimeType": fields["audioMimeType"],
        },
    )
    segment, created = upserted["segment"], upserted["created"]
    if not created:
        # 首存为准: replay the stored segment, never overwrite. But first the
        # crash-window self-heal: if no task exists for this (sessionId,
        # segmentIndex), the enqueue crashed after the segment was stored —
        # rebuild the task from the resent audio and enqueue it, or the
        # segment would stay pending forever while every resend replays 200.
        if not find_segment_task(store=store, session_id=session_id, segment_index=segment["segmentIndex"]):
            enqueue_transcription_task(
                store=store,
                now=now,
                config=config,
                session=session,
                account_id=account_id,
                segment=segment,
                audio_base64=fields["audioBase64"],
            )
        return {"status": 200, "body": {"segment": present_segment(segment)}}

    enqueue_transcription_task(
        store=store,
        now=now,
        config=config,
        session=session,
        account_id=account_id,
        segment=segment,
        audio_base64=fields["audioBase64"],
    )

    return {"status": 201, "body": {"segment": present_segment(segment)}}
