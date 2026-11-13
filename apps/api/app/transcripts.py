"""Transcript domain (contract-r2.md §2.2–2.5, §3.3, §3.5; decisions D14,
D15). Port of lib/transcripts.js.

Owns the "transcripts" collection: one document per Session, keyed by the
session id —

  { sessionId, records: [TranscriptRecord], gaps: [Gap], segments: {index: Segment} }

`records` are the archived text (captions as-read, or ASR results), `gaps`
the explicit skipped ranges reported at finish (§2.3: reason "skipped" —
caption holes and transcription failures never land here, D15), and
`segments` the per-audio-segment task states (§2.4) whose pending/failed
projection feeds the TranscriptView. The view serializer (transcript_view
below) is the single shape shared by the captions response, the polling
endpoint and the resource-detail summary.

Same-interval single path (D15): the Session's `origin` locks on the first
submission — captions lock "captions", the first audio segment locks "asr"
— and the reverse path is a 409 transcript_origin_conflict.

WRITE INTERFACE FOR THE AUDIO/TASK SIDE (audio-segments / worker
endpoints): this module keeps the storage primitives the routes call —
claim_audio_origin, upsert_audio_segment, apply_segment_transcribing /
done / failed. They are plain functions over ({ store, session, ... })
with no HTTP concerns, so the audio domain wires them behind its own auth
+ validation without touching this file's state shape.

Segment keys: Node objects coerce property access to strings, and the
JSON snapshot round-trip does the same, so the Python port keys
`segments` by str(segmentIndex) — int and "1" are the same key, exactly
like the JS reference.
"""

from __future__ import annotations

from typing import Any

from .errors import (
    ApiError,
    not_found_session,
    session_already_finished,
    validation_failed,
)
from .jsnum import coerce_js_integer, is_js_integer
from .fields import require_int_field

# Error copy lives here (transcript-specific); the shared session/auth
# errors stay in app/errors.py like lib/errors.js.


def transcript_origin_conflict(locked_origin: str) -> ApiError:
    """Contract §3.3 conflict body (asr direction pinned by the fixture;
    the captions direction mirrors it)."""
    where = "音频转写" if locked_origin == "asr" else "字幕"
    return ApiError(409, "transcript_origin_conflict", f"本次学习已按{where}归档，同一区间只采用一种方式")


def empty_state(session_id: str) -> dict:
    """Fresh transcript state for a Session with no transcript data yet."""
    return {"sessionId": session_id, "records": [], "gaps": [], "segments": {}}


def load_state(store: Any, session_id: str) -> dict:
    """Load one Session's transcript state (an empty one when nothing yet)."""
    return store.get("transcripts", session_id) or empty_state(session_id)


def save_state(store: Any, state: dict) -> None:
    """Persist one Session's transcript state."""
    store.set("transcripts", state["sessionId"], state)


def _require_non_negative_integer_field(obj: dict, field: str, where: str) -> int:
    """Non-negative integer field with a caller-supplied name for the message."""
    return require_int_field(
        obj,
        field,
        missing_message=f"缺少必填字段 {where}",
        invalid_message=f"{where} 必须是非负整数",
        non_dict_is_missing=False,
    )


def parse_gaps(body: Any) -> list:
    """Finish request gaps (contract §3.2): optional array of {startMs,
    endMs} with endMs strictly greater than startMs; a missing body or a
    body without gaps means "no gaps". Returns the normalized ranges;
    raises the contract 400s on any malformation."""
    if body is None:
        return []
    if not isinstance(body, dict):
        raise validation_failed("请求体必须是 JSON 对象")
    if "gaps" not in body or body["gaps"] is None:
        return []
    gaps = body["gaps"]
    if not isinstance(gaps, list):
        raise validation_failed("gaps 必须是数组")
    normalized = []
    for index, gap in enumerate(gaps):
        if not isinstance(gap, dict):
            raise validation_failed(f"gaps[{index}] 必须是对象")
        start_ms = _require_non_negative_integer_field(gap, "startMs", f"gaps[{index}].startMs")
        end_ms = _require_non_negative_integer_field(gap, "endMs", f"gaps[{index}].endMs")
        if end_ms <= start_ms:
            raise validation_failed(f"gaps[{index}] 的 endMs 必须大于 startMs")
        normalized.append({"startMs": start_ms, "endMs": end_ms})
    return normalized


def report_gaps(*, store: Any, session_id: str, gaps: list) -> None:
    """Store the finish-reported skipped ranges (§2.3: reason "skipped").
    The ranges replace whatever was there — finish is the single gap
    producer, reported once at close (回看补录成功的范围不再上报)."""
    state = load_state(store, session_id)
    state["gaps"] = [{**gap, "reason": "skipped"} for gap in gaps]
    save_state(store, state)


def parse_caption_segments(body: Any) -> list:
    """Caption segments of the archive request (contract §3.3): an array of
    {startMs, endMs, text} on the source-video timeline, text non-empty.
    Records are archived as-read — a missing caption range produces neither
    a record nor a gap (D15). §2.2: endMs may equal startMs (zero-length
    caption segment); only endMs < startMs is invalid."""
    if not isinstance(body, dict):
        raise validation_failed("请求体必须是 JSON 对象")
    if "segments" not in body or not isinstance(body["segments"], list):
        raise validation_failed("缺少必填字段 segments")
    parsed = []
    for index, segment in enumerate(body["segments"]):
        if not isinstance(segment, dict):
            raise validation_failed(f"segments[{index}] 必须是对象")
        start_ms = _require_non_negative_integer_field(
            segment, "startMs", f"segments[{index}].startMs"
        )
        end_ms = _require_non_negative_integer_field(
            segment, "endMs", f"segments[{index}].endMs"
        )
        if end_ms < start_ms:
            raise validation_failed(f"segments[{index}] 的 endMs 不能小于 startMs")
        text = segment.get("text")
        if not isinstance(text, str) or text == "":
            raise validation_failed(f"segments[{index}].text 必须是非空字符串")
        parsed.append({"startMs": start_ms, "endMs": end_ms, "text": text})
    return parsed


def transcript_view(session: dict, state: dict) -> dict:
    """Contract §2.5 TranscriptView — the single shape shared by the
    captions response, the polling endpoint (§3.5) and the resource-detail
    summary. All four arrays are always present (possibly empty). records
    sort by startMs ascending; the pending/failed projections come from the
    audio segment states in `segments` (always empty on the captions path)."""
    segments = list(state["segments"].values())
    return {
        "sessionId": session["id"],
        "sourceId": session["sourceId"],
        "resourceId": session["resourceId"],
        "sessionStatus": session["status"],
        "origin": session["origin"],
        "records": sorted(state["records"], key=lambda r: r["startMs"]),
        "gaps": state["gaps"],
        "pending": [
            {
                "segmentIndex": s["segmentIndex"],
                "startMs": s["startMs"],
                "endMs": s["endMs"],
                "status": s["status"],
            }
            for s in sorted(
                (s for s in segments if s["status"] in ("pending", "transcribing")),
                key=lambda s: s["segmentIndex"],
            )
        ],
        "failed": [
            {
                "segmentIndex": s["segmentIndex"],
                "startMs": s["startMs"],
                "endMs": s["endMs"],
                "error": {"code": s["error"]["code"], "message": s["error"]["message"]},
            }
            for s in sorted(
                (s for s in segments if s["status"] == "failed"),
                key=lambda s: s["segmentIndex"],
            )
        ],
    }


def transcript_summary(state: dict) -> dict:
    """§2.5 count projection for the resource-detail sessions[] (§3.6)."""
    segments = list(state["segments"].values())
    return {
        "recordCount": len(state["records"]),
        "gapCount": len(state["gaps"]),
        "failedCount": sum(1 for s in segments if s["status"] == "failed"),
    }


def archive_captions(*, store: Any, session: dict | None, body: Any) -> dict:
    """Archive captions on one Session (contract §3.3). The caller passes
    the D2 lookup result (sessions.find_account_session) — a None session
    is the same 404 whether the id is unknown or another account's. Order
    of failures: 400 validation, then 404, then 409 finished (已结束不再接收,
    which also covers resends), then 409 origin conflict (D15).

    First submission locks origin "captions" and answers 201 with the
    archive; any later submission (断网重试) answers 200 with the STORED
    content — 首存为准, never overwritten, never appended."""
    segments = parse_caption_segments(body)
    if not session:
        raise not_found_session()
    if session["status"] == "finished":
        raise session_already_finished()

    state = load_state(store, session["id"])
    if session["origin"] == "captions":
        # Idempotent resend: the already-archived content, whatever the
        # retry carried.
        return {"status": 200, "body": {"transcript": transcript_view(session, state)}}
    if session["origin"] == "asr":
        raise transcript_origin_conflict("asr")

    state["records"] = [{**segment, "origin": "captions"} for segment in segments]
    save_state(store, state)
    session["origin"] = "captions"
    store.set("sessions", session["id"], session)
    return {"status": 201, "body": {"transcript": transcript_view(session, state)}}


def get_transcript(*, store: Any, session: dict | None) -> dict:
    """Poll/Web read of one Session's transcript (contract §3.5): the bare
    TranscriptView. Reads are idempotent; the view is monotonic because
    done/failed are terminal states and the archive never shrinks (D12).
    The caller passes the D2 lookup result — None is the same 404 for an
    unknown id and another account's session."""
    if not session:
        raise not_found_session()
    state = load_state(store, session["id"])
    return {"status": 200, "body": transcript_view(session, state)}


def claim_audio_origin(*, store: Any, session: dict) -> None:
    """[Audio/worker write interface] Lock the Session's origin to "asr"
    when the first audio segment lands (D15). A session already locked to
    captions is the 409 transcript_origin_conflict (the reverse direction
    of the fixture sample, error-transcript-origin-conflict); an existing
    asr lock is a no-op. The 404 lookup and the finished-session 409 stay
    with the routes — this primitive only arbitrates the path lock."""
    if session["origin"] == "captions":
        raise transcript_origin_conflict("captions")
    if session["origin"] is None:
        session["origin"] = "asr"
        store.set("sessions", session["id"], session)


def upsert_audio_segment(*, store: Any, session_id: str, segment: dict) -> dict:
    """[Audio/worker write interface] First-write-wins insert of one audio
    segment state (contract §3.4 idempotency: (sessionId, segmentIndex) is
    the idempotency key — a replay of the same index never overwrites or
    re-enqueues). Returns { segment, created }. Validation of the segment
    metadata (§3.4 bounds) stays with the routes; this primitive stores the
    state the TranscriptView projects into pending[]/failed[]."""
    state = load_state(store, session_id)
    key = str(segment["segmentIndex"])
    existing = state["segments"].get(key)
    if existing:
        return {"segment": existing, "created": False}
    stored = {**segment, "status": "pending"}
    state["segments"][key] = stored
    save_state(store, state)
    return {"segment": stored, "created": True}


def apply_segment_transcribing(*, store: Any, session_id: str, segment_index: int) -> None:
    """[Audio/worker write interface] Task-state transitions on one segment
    (contract §3.7 state machine pending → transcribing → done | failed;
    done/failed are terminal and never revert). apply_segment_done appends
    the Worker's records (origin "asr") — a silent segment's empty records
    array simply adds none (D14: the audio itself is deleted by the result
    endpoint, not here)."""
    state = load_state(store, session_id)
    segment = state["segments"].get(str(segment_index))
    if not segment or segment["status"] in ("done", "failed"):
        return
    segment["status"] = "transcribing"
    save_state(store, state)


def apply_segment_done(
    *, store: Any, session_id: str, segment_index: int, records: list | None
) -> None:
    state = load_state(store, session_id)
    segment = state["segments"].get(str(segment_index))
    if not segment or segment["status"] in ("done", "failed"):
        return
    segment["status"] = "done"
    for record in records or []:
        state["records"].append({**record, "origin": "asr"})
    save_state(store, state)


def apply_segment_failed(
    *, store: Any, session_id: str, segment_index: int, error: dict
) -> None:
    state = load_state(store, session_id)
    segment = state["segments"].get(str(segment_index))
    if not segment or segment["status"] in ("done", "failed"):
        return
    segment["status"] = "failed"
    segment["error"] = error
    save_state(store, state)
