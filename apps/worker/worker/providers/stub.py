"""Stub Speech Provider (ticket 4.5; Node ticket 2.3, lib/providers/stub.js;
Testing Decisions: a replacement Speech Provider makes tests repeatable —
D10 puts the provider seam server-side).

Deterministic: one segment becomes one record with the segment's full span
and a text that only depends on the segment index. A zero-byte audio input
models a silence segment (contract-r2 §3.7: records: [] written back as
done).

Times are segment-relative milliseconds; run-once folds them onto the
source timeline."""

from __future__ import annotations

import base64
import binascii


def _decoded(audio_base64: str) -> bytes:
    """Buffer.from(str, "base64") equivalent: a lenient decode (invalid
    characters dropped, padding optional) so the silence check sees exactly
    what the Node stub would have decoded."""
    payload = (audio_base64 or "").rstrip("=")
    if len(payload) % 4 == 1:
        payload = payload[:-1]
    try:
        return base64.b64decode(payload + "=" * (-len(payload) % 4))
    except (binascii.Error, ValueError):  # pragma: no cover - decode is lenient
        return b""


def transcribe(*, audio_base64: str, audio_mime_type: str, segment: dict) -> list[dict]:
    if len(_decoded(audio_base64)) == 0:
        return []
    return [
        {
            "startMs": 0,
            "endMs": segment["endMs"] - segment["startMs"],
            "text": f"stub 转写文本（第 {segment['segmentIndex']} 段）",
        }
    ]


def create_stub_provider() -> dict:
    return {"id": "stub", "transcribe": transcribe}
