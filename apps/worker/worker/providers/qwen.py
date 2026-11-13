"""Qwen Speech Provider — Aliyun Bailian qwen3-asr-flash, OpenAI-compatible
(ticket 4.5; Node ticket 2.3, lib/providers/qwen.js; ported from the PoC
speech-providers.js YTD_SPEECH_PROVIDER_QWEN).

Per the published API contract: one audio segment per chat-completions
call, audio rides as a base64 Data URI content part, auth is a single
service-scoped Bailian key (Authorization: Bearer). One segment becomes
one request; the single transcript record is segment-relative and spans
the whole segment. Language is pinned to zh per the product's Chinese-only
contract."""

from __future__ import annotations

from typing import Any

import httpx

DEFAULTS = {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "qwen3-asr-flash",
}


def normalize_base_url(base_url: str | None) -> str:
    trimmed = base_url.strip() if isinstance(base_url, str) else ""
    return (trimmed or DEFAULTS["baseUrl"]).rstrip("/")


def normalize_model(model: str | None) -> str:
    trimmed = model.strip() if isinstance(model, str) else ""
    return trimmed or DEFAULTS["model"]


def provider_http_error(response: httpx.Response) -> RuntimeError:
    """Port of the PoC's providerHttpError: status + a body slice for
    triage."""
    body = response.text
    detail = f": {body[:500]}" if body else ""
    return RuntimeError(
        f"Qwen Speech Provider request failed with HTTP {response.status_code}{detail}"
    )


def create_qwen_provider(
    *,
    api_key: str,
    base_url: str | None = None,
    model: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any]:
    trimmed_key = api_key.strip() if isinstance(api_key, str) else ""
    if not trimmed_key:
        raise ValueError("Qwen Speech Provider requires a Bailian API key")
    client = httpx.Client(transport=transport)

    def transcribe(*, audio_base64: str, audio_mime_type: str, segment: dict) -> list[dict]:
        media_type = audio_mime_type or "audio/mpeg"
        data_uri = f"data:{media_type};base64,{audio_base64}"

        response = client.post(
            f"{normalize_base_url(base_url)}/chat/completions",
            headers={
                "Authorization": f"Bearer {trimmed_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": normalize_model(model),
                "messages": [
                    {
                        "role": "user",
                        "content": [{"type": "input_audio", "input_audio": {"data": data_uri}}],
                    }
                ],
                "asr_options": {"language": "zh", "enable_itn": True},
            },
        )
        if not (200 <= response.status_code < 300):
            raise provider_http_error(response)

        payload = response.json()
        choices = payload.get("choices") if isinstance(payload, dict) else None
        message = choices[0].get("message") if choices and isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        text = str(content or "").strip()
        if not text:
            return []
        return [
            {
                "startMs": 0,
                "endMs": segment["endMs"] - segment["startMs"],
                "text": text,
            }
        ]

    return {"id": "qwen", "transcribe": transcribe}
