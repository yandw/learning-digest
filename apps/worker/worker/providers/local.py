"""Local Speech Provider (ticket 5.1, issue #83) — OpenAI-compatible
transcription against a self-hosted / LAN ASR service. The default
protocol shape covers faster-whisper-server / LocalAI / whisper.cpp server:
multipart POST {BASE_URL}/v1/audio/transcriptions with file = the audio
bytes plus model + language, and an optional Bearer token.

Response: {text, segments?: [{start, end, text}]} with seconds — segments
become one record each (converted to segment-relative milliseconds,
aligned with qwen's whole-span record shape); no segments means one record
spanning the whole segment. Empty text is a silence segment (records: [],
contract-r2 §3.7). Times are segment-relative milliseconds; run-once folds
them onto the source timeline. origin is never sent by the worker — the
API stamps "asr" on audio transcripts."""

from __future__ import annotations

import base64
from typing import Any

import httpx

DEFAULTS = {"model": "whisper-1", "language": "zh", "mimeType": "audio/mpeg", "responseFormat": "verbose_json"}


def normalize_base_url(base_url: str | None) -> str:
    trimmed = base_url.strip() if isinstance(base_url, str) else ""
    return trimmed.rstrip("/")


def normalize_model(model: str | None) -> str:
    trimmed = model.strip() if isinstance(model, str) else ""
    return trimmed or DEFAULTS["model"]


def normalize_language(language: str | None) -> str:
    trimmed = language.strip() if isinstance(language, str) else ""
    return trimmed or DEFAULTS["language"]


def normalize_response_format(response_format: str | None) -> str:
    """verbose_json makes self-hosted servers return the
    {text, segments:[{start,end,text}]} shape this provider folds into
    segment-level records; plain json yields text only (one record per
    Segment). Configurable via LD_WORKER_LOCAL_RESPONSE_FORMAT."""
    trimmed = response_format.strip() if isinstance(response_format, str) else ""
    return trimmed or DEFAULTS["responseFormat"]


def provider_http_error(response: httpx.Response) -> RuntimeError:
    """The providerHttpError shape (qwen port): status + a body slice for
    triage."""
    body = response.text
    detail = f": {body[:500]}" if body else ""
    return RuntimeError(
        f"Local Speech Provider request failed with HTTP {response.status_code}{detail}"
    )


def _seconds_to_ms(value: Any) -> int:
    try:
        return int(round(float(value) * 1000))
    except (TypeError, ValueError):
        return 0


def _records_from_segments(segments: list) -> list[dict]:
    records = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        text = str(seg.get("text") or "").strip()
        # The API rejects empty record text, so an empty-text segment is
        # skipped (qwen treats empty content as silence the same way).
        if not text:
            continue
        records.append(
            {
                "startMs": _seconds_to_ms(seg.get("start")),
                "endMs": _seconds_to_ms(seg.get("end")),
                "text": text,
            }
        )
    return records


def create_local_provider(
    *,
    base_url: str | None,
    model: str | None = None,
    token: str | None = None,
    language: str | None = None,
    mime_type: str | None = None,
    response_format: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any]:
    """BASE_URL is required: a missing value raises here, at worker startup
    (fail fast, same as a qwen selection without a key) — never per task."""
    trimmed_url = normalize_base_url(base_url)
    if not trimmed_url:
        raise ValueError("Local Speech Provider requires LD_WORKER_LOCAL_BASE_URL")
    trimmed_token = token.strip() if isinstance(token, str) else ""
    client = httpx.Client(transport=transport)

    def transcribe(*, audio_base64: str, audio_mime_type: str, segment: dict) -> list[dict]:
        audio = base64.b64decode(audio_base64 or "")
        media_type = (
            (mime_type.strip() if isinstance(mime_type, str) else "")
            or audio_mime_type
            or DEFAULTS["mimeType"]
        )
        extension = media_type.split("/", 1)[-1].split(";", 1)[0] or "bin"
        if extension == "mpeg":
            extension = "mp3"

        headers = {}
        if trimmed_token:
            headers["Authorization"] = f"Bearer {trimmed_token}"

        response = client.post(
            f"{trimmed_url}/v1/audio/transcriptions",
            headers=headers,
            files={"file": (f"audio.{extension}", audio, media_type)},
            data={
                "model": normalize_model(model),
                "language": normalize_language(language),
                "response_format": normalize_response_format(response_format),
            },
        )
        if not (200 <= response.status_code < 300):
            raise provider_http_error(response)

        payload = response.json()
        segments = payload.get("segments") if isinstance(payload, dict) else None
        if isinstance(segments, list) and segments:
            return _records_from_segments(segments)
        text = str(payload.get("text") or "").strip() if isinstance(payload, dict) else ""
        if not text:
            return []
        return [
            {
                "startMs": 0,
                "endMs": segment["endMs"] - segment["startMs"],
                "text": text,
            }
        ]

    return {"id": "local", "transcribe": transcribe}
