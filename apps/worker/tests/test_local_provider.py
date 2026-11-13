"""Local Speech Provider (ticket 5.1, issue #83): OpenAI-compatible
transcription against a self-hosted / LAN ASR service (faster-whisper-server,
LocalAI, whisper.cpp server shape). Ported intent: the qwen provider seam —
the HTTP boundary IS the seam here, tested through an injectable httpx
transport; no external network is contacted. The real LAN service stays a
manual/ops exercise (round2-acceptance §5.6 placeholder).

Contract-r2 §1: everything the API stores is on the source video timeline,
so the provider returns segment-relative milliseconds and run_once folds
them; origin is always "asr" (the API stamps it, the worker never sends one)."""

import json

import httpx

from worker.providers.local import DEFAULTS, create_local_provider

SEGMENT_INPUT = {
    "audio_base64": "U29tZV9hdWRpb19ieXRlcw==",
    "audio_mime_type": "audio/webm;codecs=opus",
    "segment": {"segmentIndex": 1, "startMs": 30000, "endMs": 60000},
}


class StubTransport(httpx.BaseTransport):
    """Records each request and answers with a canned body (the same
    injection point as the qwen provider tests)."""

    def __init__(self, body, status=200):
        self.calls = []
        self.body = body
        self.status = status

    def handle_request(self, request):
        request.read()  # multipart bodies are streams until read
        self.calls.append(request)
        if isinstance(self.body, bytes):
            content = self.body
        elif isinstance(self.body, str):
            content = self.body.encode("utf-8")
        else:
            content = json.dumps(self.body).encode("utf-8")
        return httpx.Response(self.status, content=content, request=request)


def parse_multipart(content_type: str, body: bytes) -> dict:
    """Parse a multipart/form-data body into name -> {filename, content_type,
    value bytes} so the request shape is asserted exactly. Shared with the
    loopback stub server (test_loopback_local.py)."""
    boundary = content_type.split("boundary=")[1].encode("utf-8")
    fields = {}
    for part in body.split(b"--" + boundary):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        head, _, payload = part.partition(b"\r\n\r\n")
        headers = {}
        for line in head.split(b"\r\n"):
            name, _, value = line.partition(b": ")
            headers[name.decode().lower()] = value.decode()
        disposition = headers.get("content-disposition", "")
        field_name = disposition.split('name="')[1].split('"')[0]
        filename = None
        if 'filename="' in disposition:
            filename = disposition.split('filename="')[1].split('"')[0]
        fields[field_name] = {
            "filename": filename,
            "content_type": headers.get("content-type"),
            "value": payload,
        }
    return fields


def multipart_fields(request):
    return parse_multipart(request.headers["content-type"], request.content)


def test_one_segment_is_one_multipart_transcription_call():
    transport = StubTransport({"text": "注意力分数的计算，就是把查询向量和键向量做点积"})
    provider = create_local_provider(
        base_url="http://127.0.0.1:8000",
        model="whisper-large-v3",
        language="zh",
        transport=transport,
    )

    records = provider["transcribe"](**SEGMENT_INPUT)

    assert len(transport.calls) == 1
    request = transport.calls[0]
    assert str(request.url) == "http://127.0.0.1:8000/v1/audio/transcriptions"
    assert request.method == "POST"
    # No token configured -> no Authorization header.
    assert "Authorization" not in request.headers
    assert request.headers["content-type"].startswith("multipart/form-data; boundary=")

    fields = multipart_fields(request)
    assert fields["model"]["value"] == b"whisper-large-v3"
    assert fields["language"]["value"] == b"zh"
    # verbose_json is requested so self-hosted servers return the
    # {text, segments} shape this provider folds into segment records.
    assert fields["response_format"]["value"] == b"verbose_json"
    assert fields["file"]["content_type"] == "audio/webm;codecs=opus"
    # The audio rides as raw bytes (base64 decoded from the claim task).
    assert fields["file"]["value"] == b"Some_audio_bytes"

    # No segments in the response -> one record spanning the whole segment,
    # segment-relative milliseconds (the caller folds onto the timeline).
    assert records == [
        {"startMs": 0, "endMs": 30000, "text": "注意力分数的计算，就是把查询向量和键向量做点积"}
    ]


def test_defaults_model_language_and_mime_without_overrides():
    transport = StubTransport({"text": "文本"})
    provider = create_local_provider(base_url="http://127.0.0.1:8000/", transport=transport)
    assert DEFAULTS == {"model": "whisper-1", "language": "zh", "mimeType": "audio/mpeg", "responseFormat": "verbose_json"}

    provider["transcribe"](**SEGMENT_INPUT)

    fields = multipart_fields(transport.calls[0])
    assert fields["model"]["value"] == b"whisper-1"
    assert fields["language"]["value"] == b"zh"
    assert fields["response_format"]["value"] == b"verbose_json"
    # The claim task's mime type wins when no LD_WORKER_LOCAL_MIME_TYPE override.
    assert fields["file"]["content_type"] == "audio/webm;codecs=opus"
    # Trailing slash on the base URL is normalized away.
    assert str(transport.calls[0].url) == "http://127.0.0.1:8000/v1/audio/transcriptions"


def test_segments_become_per_segment_millisecond_records():
    transport = StubTransport(
        {
            "text": "第一句。第二句。",
            "segments": [
                {"start": 0.0, "end": 2.5, "text": "第一句。"},
                {"start": 2.5, "end": 5.0, "text": "第二句。"},
                {"start": 5.0, "end": 6.0, "text": "   "},  # empty text: skipped
            ],
        }
    )
    provider = create_local_provider(base_url="http://127.0.0.1:8000", transport=transport)

    records = provider["transcribe"](**SEGMENT_INPUT)

    assert records == [
        {"startMs": 0, "endMs": 2500, "text": "第一句。"},
        {"startMs": 2500, "endMs": 5000, "text": "第二句。"},
    ]


def test_empty_text_without_segments_is_a_silence_segment():
    transport = StubTransport({"text": ""})
    provider = create_local_provider(base_url="http://127.0.0.1:8000", transport=transport)
    assert provider["transcribe"](**SEGMENT_INPUT) == []


def test_optional_token_rides_as_a_bearer_header():
    transport = StubTransport({"text": "文本"})
    provider = create_local_provider(
        base_url="http://127.0.0.1:8000", token="lan-token", transport=transport
    )
    provider["transcribe"](**SEGMENT_INPUT)
    assert transport.calls[0].headers["Authorization"] == "Bearer lan-token"


def test_mime_type_override_replaces_the_claim_mime():
    """LD_WORKER_LOCAL_MIME_TYPE: local services are picky about containers
    (wav/webm), so the override wins over the claim's mime type."""
    transport = StubTransport({"text": "文本"})
    provider = create_local_provider(
        base_url="http://127.0.0.1:8000", mime_type="audio/wav", transport=transport
    )
    provider["transcribe"](**SEGMENT_INPUT)

    fields = multipart_fields(transport.calls[0])
    assert fields["file"]["content_type"] == "audio/wav"
    assert fields["file"]["filename"] == "audio.wav"


def test_http_failures_surface_the_provider_detail():
    transport = StubTransport("_transcription body", status=500)
    provider = create_local_provider(base_url="http://127.0.0.1:8000", transport=transport)
    try:
        provider["transcribe"](**SEGMENT_INPUT)
    except Exception as error:
        assert "Local Speech Provider request failed with HTTP 500: _transcription body" in str(
            error
        )
    else:
        raise AssertionError("HTTP 500 must raise with the provider detail")


def test_missing_base_url_fails_at_construction_before_any_request():
    transport = StubTransport({})
    # Factory-time raise (fail fast at worker startup, not per task).
    for blank in (None, "", "   "):
        try:
            create_local_provider(base_url=blank, transport=transport)
        except Exception as error:
            assert "LD_WORKER_LOCAL_BASE_URL" in str(error)
        else:
            raise AssertionError("missing base url must fail at construction")
    assert transport.calls == []


def test_timeout_raises_through_to_the_cycle_level():
    """No explicit timeout knob: the client keeps the shared httpx default
    like qwen; a timeout surfaces as an exception (run_once turns it into
    transcription_failed)."""

    class TimeoutTransport(httpx.BaseTransport):
        def handle_request(self, request):
            raise httpx.ConnectTimeout("timed out", request=request)

    provider = create_local_provider(
        base_url="http://127.0.0.1:8000", transport=TimeoutTransport()
    )
    try:
        provider["transcribe"](**SEGMENT_INPUT)
    except httpx.ConnectTimeout:
        pass
    else:
        raise AssertionError("a LAN service timeout must raise, not pass silently")


def test_response_format_override_flows_through():
    transport = StubTransport({"text": "文本"})
    provider = create_local_provider(
        base_url="http://127.0.0.1:8000",
        response_format="json",
        transport=transport,
    )
    provider["transcribe"](**SEGMENT_INPUT)

    fields = multipart_fields(transport.calls[0])
    assert fields["response_format"]["value"] == b"json"
    # A plain json body (text only) still folds to the whole-span record.
    assert len(transport.calls) == 1
