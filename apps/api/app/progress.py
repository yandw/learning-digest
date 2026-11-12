"""Playback progress domain (contract-v1.md §2.3, §3.5; decision D4).
Port of lib/progress.js.

Progress is stored per account + Source in the shared "progress"
collection (P4's GET paths already read it). Writes use optimistic
concurrency on `expectedRevision`:
- no progress yet counts as revision 0; a successful write bumps to 1;
- a stale expectedRevision is a 409 carrying the current progress, so
  the client can decide to overwrite or give up without a read-back;
- `positionMs` is never clamped server-side (D4): rewinding is legal,
  it records the last actually-played position.

Idempotent resend (ticket #54; the fixtures do not cover it, so the
semantics are pinned here and in test_sources_progress.py): a request
whose expectedRevision equals the current revision AND whose positionMs
equals the stored value is a resend of the last successful write (e.g.
after a network drop). It answers 200 with the current values and does
NOT bump the revision, so retries keep the result consistent. The same
expectedRevision with a different positionMs is a fresh write and bumps
normally. A stale expectedRevision is always a 409, whether or not the
position matches."""

from __future__ import annotations

from typing import Any

from .errors import ApiError, not_found_source, validation_failed
from .jsnum import coerce_js_integer, is_js_integer


def progress_conflict(current: dict) -> ApiError:
    """Contract §3.5 conflict body: 409 + the current progress verbatim."""
    return ApiError(
        409,
        "progress_revision_conflict",
        "进度已被其他端更新，请以 current 为准重试",
        {"current": current},
    )


def require_non_negative_integer(body: Any, field: str) -> int:
    """Non-negative integer field (contract §2.3: positionMs,
    expectedRevision). Non-object bodies (null, arrays, scalars) answer
    the missing-field error for the first field checked, like the JS
    reference's requireNonNegativeInteger."""
    if body is None or not isinstance(body, dict):
        raise validation_failed(f"缺少必填字段 {field}")
    value = body.get(field)
    if value is None:
        # JS undefined and null both take the missing-field branch.
        raise validation_failed(f"缺少必填字段 {field}")
    if not is_js_integer(value) or value < 0:
        raise validation_failed(f"{field} 必须是非负整数")
    return coerce_js_integer(value)


def save_progress(*, store: Any, account_id: str, source_id: str, body: Any) -> dict:
    """Save one progress write (contract §3.5). Returns the 200 result;
    raises the contract errors on validation (400), isolation (404, D2)
    and concurrency (409) failures."""
    position_ms = require_non_negative_integer(body, "positionMs")
    expected_revision = require_non_negative_integer(body, "expectedRevision")

    # D2: other accounts' sources and unknown ids are the same 404.
    source = next(
        (
            s
            for s in store.list("sources")
            if s["id"] == source_id and s["accountId"] == account_id
        ),
        None,
    )
    if not source:
        raise not_found_source()

    progress = store.get("progress", source_id)
    current_revision = progress["revision"] if progress else 0

    # Optimistic concurrency (D4): the version number is the only reliable
    # write order — positionMs can legally go backwards (dragging), so it
    # is never a concurrency signal.
    if current_revision != expected_revision:
        raise progress_conflict(
            {
                # No progress yet reads as positionMs null at revision 0 (§2.3).
                "positionMs": progress["positionMs"] if progress else None,
                "revision": current_revision,
            }
        )

    # Idempotent resend (ticket #54): the exact duplicate of the last
    # acknowledged write answers with the stored values and does not bump,
    # so retries after a network drop keep the result consistent.
    if progress and progress["positionMs"] == position_ms:
        return {
            "status": 200,
            "body": {
                "positionMs": progress["positionMs"],
                "revision": progress["revision"],
            },
        }

    write = {"positionMs": position_ms, "revision": current_revision + 1}
    store.set("progress", source_id, write)
    return {"status": 200, "body": write}
