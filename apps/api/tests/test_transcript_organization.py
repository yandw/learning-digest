"""Post-session organization through the existing HTTP finish, worker and read entry points."""

import json

from helpers import audio_example, auth_header, create_session_for, make_audio_dir, open_account

EMAIL = "transcript-learner@example.com"
WORKER_TOKEN = "test-transcript-worker"


class TranscriptProvider:
    id = "fixture"
    model = "test-editor"

    def __init__(self, paragraphs):
        self.paragraphs = paragraphs
        self.inputs = []

    def organize_transcript(self, *, system, user):
        self.inputs.append(json.loads(user))
        return {"paragraphs": self.paragraphs, "inputTokens": 42, "outputTokens": 16}


def start_session(start_app, provider):
    app = start_app(
        seed_emails=[EMAIL],
        config={"audio_dir": make_audio_dir(), "worker_token": WORKER_TOKEN},
        ai_provider=provider,
    )
    token = open_account(app, EMAIL)
    created = create_session_for(app, token, "transcript-organization")
    session_id = created["session"]["id"]

    def request(method, endpoint, body=None):
        return app.request(
            method, f"/v1/sessions/{session_id}/{endpoint}", headers=auth_header(token), body=body
        )

    def worker(endpoint, body):
        return app.request("POST", f"/v1/worker/tasks/{endpoint}", headers=auth_header(WORKER_TOKEN), body=body)

    return request, worker


def test_late_worker_result_organizes_finished_session_once_and_preserves_cross_segment_sources(start_app):
    provider = TranscriptProvider([["如果输入足够，就继续。", "否则先"]])
    request, worker = start_session(start_app, provider)
    for fixture in ("api-audio-segment-upload", "api-audio-segment-upload-second"):
        segment = audio_example(fixture)["request"]["body"]
        assert request("POST", "audio-segments", segment).status == 201

    first, second = worker("claim", {"limit": 2}).json["tasks"]
    first_result = {"status": "done", "records": [{"startMs": 30000, "endMs": 60000, "text": "如果输入"}]}
    second_result = {"status": "done", "records": [{"startMs": 60000, "endMs": 90000, "text": "足够就继续否则先"}]}
    # Worker completion order does not change the playback order.
    assert worker(f"{second['taskId']}/result", second_result).status == 200
    assert "organized" not in request("GET", "transcript").json
    assert request("POST", "finish", {}).status == 200
    waiting = request("GET", "transcript").json
    assert waiting["records"][0]["text"] == "足够就继续否则先"
    assert len(waiting["pending"]) == 1
    assert provider.inputs == []

    assert worker(f"{first['taskId']}/result", first_result).status == 200
    view = request("GET", "transcript").json
    assert [record["text"] for record in view["records"]] == ["如果输入", "足够就继续否则先"]
    assert view["organized"] == {"status": "ready", "paragraphs": [{"sentences": [
        {"text": "如果输入足够，就继续。", "startMs": 30000, "endMs": 90000, "spans": [
            {"recordIndex": 0, "startMs": 30000, "endMs": 60000, "segmentIndex": first["segmentIndex"]},
            {"recordIndex": 1, "startMs": 60000, "endMs": 90000, "segmentIndex": second["segmentIndex"]},
        ]},
        {"text": "否则先", "startMs": 60000, "endMs": 90000, "spans": [
            {"recordIndex": 1, "startMs": 60000, "endMs": 90000, "segmentIndex": second["segmentIndex"]},
        ]},
    ]}]}
    assert worker(f"{first['taskId']}/result", first_result).status == 200
    assert request("POST", "finish", {}).status == 409
    assert request("GET", "transcript").json == view
    assert provider.inputs == [{"text": "如果输入足够就继续否则先", "final": True}]


def test_finish_organizes_on_each_side_of_recorded_gap(start_app):
    class EchoProvider(TranscriptProvider):
        def organize_transcript(self, *, system, user):
            payload = json.loads(user)
            self.inputs.append(payload)
            return {"paragraphs": [[payload["text"]]]}

    provider = EchoProvider(None)
    request, _ = start_session(start_app, provider)
    assert request("POST", "captions", {"segments": [
        {"startMs": 0, "endMs": 1000, "text": "前面没讲完"},
        {"startMs": 4000, "endMs": 5000, "text": "这里继续"},
    ]}).status == 201

    assert request("POST", "finish", {"gaps": [{"startMs": 1000, "endMs": 4000}]}).status == 200
    view = request("GET", "transcript").json
    assert [paragraph["sentences"][0]["text"] for paragraph in view["organized"]["paragraphs"]] == [
        "前面没讲完", "这里继续",
    ]
    assert view["gaps"] == [{"startMs": 1000, "endMs": 4000, "reason": "skipped"}]
    assert [payload["text"] for payload in provider.inputs] == ["前面没讲完", "这里继续"]


def test_qwen_output_with_changed_words_keeps_raw_transcript_and_is_not_retried(start_app, caplog):
    import httpx

    from app.ai_providers import create_qwen_provider

    seen = []
    caplog.set_level("INFO", logger="app.transcript_organization")

    def chat(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": '{"paragraphs":[["如果足够就默认通过。"]]}'}}],
            "usage": {"prompt_tokens": 42, "completion_tokens": 16},
        })

    provider = create_qwen_provider(api_key="fake-key", transport=httpx.MockTransport(chat))
    request, _ = start_session(start_app, provider)
    raw = {"startMs": 0, "endMs": 1000, "text": "如果足够，呃就继续"}
    assert request("POST", "captions", {"segments": [raw]}).status == 201
    assert request("POST", "finish", {}).status == 200
    view = request("GET", "transcript").json
    assert view["organized"] == {"status": "failed"}
    assert view["records"] == [{**raw, "origin": "captions"}]
    assert request("GET", "transcript").json == view
    assert len(seen) == 1
    assert json.loads(seen[0]["messages"][1]["content"]) == {"text": raw["text"], "final": True}
    assert any(
        "'inputTokens': 42" in record.message
        and "'outputTokens': 16" in record.message
        and "'latencyMs':" in record.message
        for record in caplog.records
    )


def test_logout_also_organizes_the_session_it_finishes(start_app):
    provider = TranscriptProvider([["听课结束。"]])
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    token = open_account(app, EMAIL)
    headers = auth_header(token)
    session_id = create_session_for(app, token, "logout-transcript")["session"]["id"]
    archived = app.request("POST", f"/v1/sessions/{session_id}/captions", headers=headers, body={
        "segments": [{"startMs": 0, "endMs": 1000, "text": "听课结束"}],
    })
    assert archived.status == 201
    assert provider.inputs == []
    assert app.request("POST", "/v1/auth/logout", headers=headers).status == 200
    assert provider.inputs == [{"text": "听课结束", "final": True}]
