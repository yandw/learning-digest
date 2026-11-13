"""WorkerClient — the worker's HTTP seam to the API (ticket 4.5, §3.7).
Ported intent: apps/worker/test/client.test.js.

Seam: create_worker_client with an injectable httpx transport (same
injection point as the providers). Tests pin the request shapes and the
non-2xx error mapping; the happy paths against a REAL loopback API run in
the loopback chain test."""

import json

import httpx

from worker.client import create_worker_client


class StubTransport(httpx.BaseTransport):
    """Records each request and answers with a canned body."""

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


def make_client(transport):
    return create_worker_client(
        api_base="http://127.0.0.1:8787", token="worker-secret", transport=transport
    )


def test_claim_posts_the_worker_credential_and_the_limit():
    transport = StubTransport({"tasks": []})
    client = make_client(transport)

    result = client.claim(limit=3)

    assert result == {"tasks": []}
    assert len(transport.calls) == 1
    request = transport.calls[0]
    assert str(request.url) == "http://127.0.0.1:8787/v1/worker/tasks/claim"
    assert request.method == "POST"
    assert request.headers["Authorization"] == "Bearer worker-secret"
    assert json.loads(request.content) == {"limit": 3}


def test_submit_result_posts_to_the_tasks_result_endpoint():
    transport = StubTransport({"taskId": "tsk_1", "status": "done"})
    client = make_client(transport)

    result = client.submit_result(
        "tsk_1",
        {"status": "done", "records": [{"startMs": 30000, "endMs": 60000, "text": "text"}]},
    )

    assert result == {"taskId": "tsk_1", "status": "done"}
    request = transport.calls[0]
    assert str(request.url) == "http://127.0.0.1:8787/v1/worker/tasks/tsk_1/result"
    assert request.method == "POST"
    assert request.headers["Authorization"] == "Bearer worker-secret"
    assert json.loads(request.content) == {
        "status": "done",
        "records": [{"startMs": 30000, "endMs": 60000, "text": "text"}],
    }


def test_non_2xx_answers_reject_with_status_and_the_api_error_code():
    transport = StubTransport(
        json.dumps({"error": {"code": "unauthorized", "message": "Worker 凭据缺失或无效"}}),
        status=401,
    )
    client = make_client(transport)
    try:
        client.claim(limit=1)
    except Exception as error:
        message = str(error)
        assert "401" in message
        assert "unauthorized" in message
    else:
        raise AssertionError("401 must raise with the API error code")
