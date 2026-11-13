"""Qwen Speech Provider (ticket 4.5; Node ticket 2.3; port of the PoC
speech-providers.js qwen3-asr-flash segment call shape). Ported intent:
apps/worker/test/qwen-provider.test.js.

Seam: provider["transcribe"] with an injectable httpx transport — the HTTP
boundary IS the seam here (same injection point as the Node fetchImpl).
Tests pin the request shape (URL, headers, chat-completions body with the
base64 Data URI) and parse the response shape; no external network is
contacted. The real dashscope call stays a manual/ops exercise."""

import json

import httpx

from worker.providers.qwen import DEFAULTS, create_qwen_provider

SEGMENT_INPUT = {
    "audio_base64": "U29tZV9hdWRpb19ieXRlcw==",
    "audio_mime_type": "audio/webm;codecs=opus",
    "segment": {"segmentIndex": 1, "startMs": 30000, "endMs": 60000},
}


class StubTransport(httpx.BaseTransport):
    """Records each request and answers with a canned body (the httpx
    equivalent of the Node stubFetch)."""

    def __init__(self, body, status=200):
        self.calls = []
        self.body = body
        self.status = status

    def handle_request(self, request):
        self.calls.append(request)
        if isinstance(self.body, bytes):
            content = self.body
        elif isinstance(self.body, str):
            content = self.body.encode("utf-8")
        else:
            content = json.dumps(self.body).encode("utf-8")
        return httpx.Response(self.status, content=content, request=request)


def test_one_segment_is_one_chat_completions_call_in_the_poc_shape():
    transport = StubTransport(
        {"choices": [{"message": {"content": "注意力分数的计算，就是把查询向量和键向量做点积"}}]}
    )
    provider = create_qwen_provider(
        api_key="qwen-key", base_url=DEFAULTS["baseUrl"], model=DEFAULTS["model"], transport=transport
    )

    records = provider["transcribe"](**SEGMENT_INPUT)

    assert len(transport.calls) == 1
    request = transport.calls[0]
    assert str(request.url) == "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    assert request.method == "POST"
    assert request.headers["Authorization"] == "Bearer qwen-key"
    assert request.headers["Content-Type"] == "application/json"

    request_body = json.loads(request.content)
    assert sorted(request_body.keys()) == ["asr_options", "messages", "model"]
    assert request_body["model"] == "qwen3-asr-flash"
    assert request_body["asr_options"] == {"language": "zh", "enable_itn": True}
    assert len(request_body["messages"]) == 1
    assert request_body["messages"][0]["role"] == "user"
    assert request_body["messages"][0]["content"] == [
        {
            "type": "input_audio",
            "input_audio": {"data": "data:audio/webm;codecs=opus;base64,U29tZV9hdWRpb19ieXRlcw=="},
        }
    ]

    # Segment-relative record spanning the whole segment (the caller folds).
    assert records == [
        {"startMs": 0, "endMs": 30000, "text": "注意力分数的计算，就是把查询向量和键向量做点积"}
    ]


def test_empty_content_is_a_silence_segment():
    transport = StubTransport({"choices": [{"message": {"content": "  "}}]})
    provider = create_qwen_provider(api_key="qwen-key", transport=transport)
    records = provider["transcribe"](**SEGMENT_INPUT)
    assert records == []


def test_http_failures_surface_the_provider_detail():
    transport = StubTransport("_rate limit body", status=429)
    provider = create_qwen_provider(api_key="qwen-key", transport=transport)
    try:
        provider["transcribe"](**SEGMENT_INPUT)
    except Exception as error:
        assert "Qwen Speech Provider request failed with HTTP 429: _rate limit body" in str(error)
    else:
        raise AssertionError("HTTP 429 must raise with the provider detail")


def test_missing_api_key_fails_at_construction_before_any_request():
    transport = StubTransport({})
    # Factory-time raise (fail fast at worker startup, not per task).
    try:
        create_qwen_provider(api_key="  ", transport=transport)
    except Exception as error:
        assert "requires a Bailian API key" in str(error)
    else:
        raise AssertionError("missing api key must fail at construction")
    assert transport.calls == []
