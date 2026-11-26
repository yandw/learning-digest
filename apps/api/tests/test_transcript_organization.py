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
    provider = TranscriptProvider([["如果输入足够，就继续。否则先"]])
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


def test_qwen_output_with_changed_words_retries_once_then_reuses_raw_fallback(start_app, caplog):
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
    assert len(seen) == 2
    assert seen[0]["response_format"] == {"type": "json_object"}
    assert "前一次校验失败" in seen[1]["messages"][0]["content"]
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


def test_organization_restores_archived_whitespace_between_english_sentences(start_app):
    provider = TranscriptProvider([["First point.", "Next point."], ["The final"]])
    request, _ = start_session(start_app, provider)
    raw = "First point.\t  Next point.  The final"
    assert request("POST", "captions", {"segments": [
        {"startMs": 0, "endMs": 1000, "text": raw},
    ]}).status == 201

    assert request("POST", "finish", {}).status == 200
    view = request("GET", "transcript").json
    assert [[sentence["text"] for sentence in paragraph["sentences"]]
            for paragraph in view["organized"]["paragraphs"]] == [
        ["First point.", "\t  Next point."], ["  The final"],
    ]
    assert view["records"][0]["text"] == raw
    assert len(provider.inputs) == 1


def test_long_transcript_reuses_uncertain_tail_before_the_next_window_and_stops_at_gap(start_app):
    class WindowProvider(TranscriptProvider):
        def organize_transcript(self, *, system, user):
            payload = json.loads(user)
            self.inputs.append(payload)
            text = payload["text"]
            if not payload["final"]:
                return {"paragraphs": [[opening, text.removeprefix(opening) + "。"]]}
            if text.startswith("如果"):
                return {"paragraphs": [[condition + "。", "最后我们还"]]}
            return {"paragraphs": [[text]]}

    opening = "开场" * 490 + "。"
    condition = "如果" + "条件" * 8 + "需要补充就继续"
    records = [
        {"startMs": 0, "endMs": 1000, "text": opening + "如果"},
        {"startMs": 1000, "endMs": 2000, "text": condition.removeprefix("如果") + "最后我们还"},
        {"startMs": 3000, "endMs": 4000, "text": "下一段缺录前的半句"},
    ]
    provider = WindowProvider(None)
    request, _ = start_session(start_app, provider)
    assert request("POST", "captions", {"segments": records}).status == 201
    assert request("POST", "finish", {"gaps": [{"startMs": 2000, "endMs": 3000}]}).status == 200

    view = request("GET", "transcript").json
    paragraphs = view["organized"]["paragraphs"]
    opening_sentence, joined, tail, after_gap = [
        sentence for paragraph in paragraphs for sentence in paragraph["sentences"]
    ]
    assert [sentence["text"] for sentence in (opening_sentence, joined, tail, after_gap)] == [
        opening, condition + "。", "最后我们还", "下一段缺录前的半句",
    ]
    assert joined["spans"] == [
        {"recordIndex": 0, "startMs": 0, "endMs": 1000},
        {"recordIndex": 1, "startMs": 1000, "endMs": 2000},
    ]
    assert tail["spans"] == [{"recordIndex": 1, "startMs": 1000, "endMs": 2000}]
    assert after_gap["spans"] == [{"recordIndex": 2, "startMs": 3000, "endMs": 4000}]
    assert len(paragraphs[-1]["sentences"]) == 1
    assert [model_input["final"] for model_input in provider.inputs] == [False, True, True]
    assert len(provider.inputs[0]["text"]) <= 1000
    assert provider.inputs[1]["text"] == condition + "最后我们还"
    assert view["records"] == [{**record, "origin": "captions"} for record in records]


def test_failed_window_preserves_exact_raw_range_and_later_window_still_organizes(start_app):
    class MixedProvider(TranscriptProvider):
        def organize_transcript(self, *, system, user):
            payload = json.loads(user)
            self.inputs.append(payload)
            if not payload["final"]:
                return {"paragraphs": [["原词被换掉了。"]]}
            return {"paragraphs": [["这里已经讲完。", "后面还"]]}

    original = "原话" * 500
    provider = MixedProvider(None)
    request, _ = start_session(start_app, provider)
    records = [
        {"startMs": 0, "endMs": 1000, "text": original + "这里已经讲完"},
        {"startMs": 1000, "endMs": 2000, "text": "后面还"},
    ]
    assert request("POST", "captions", {"segments": records}).status == 201
    assert request("POST", "finish", {}).status == 200

    view = request("GET", "transcript").json
    assert view["organized"]["status"] == "partial"
    raw, formatted = view["organized"]["paragraphs"]
    assert raw == {"status": "raw", "sentences": [{
        "text": original, "startMs": 0, "endMs": 1000,
        "spans": [{"recordIndex": 0, "startMs": 0, "endMs": 1000}],
    }]}
    assert [sentence["text"] for sentence in formatted["sentences"]] == ["这里已经讲完。", "后面还"]
    assert [sentence["spans"][0]["recordIndex"] for sentence in formatted["sentences"]] == [0, 1]
    assert [model_input["text"] for model_input in provider.inputs] == [original, original, "这里已经讲完后面还"]
    assert view["records"] == [{**record, "origin": "captions"} for record in records]


def test_provider_timeout_retries_middle_window_and_preserves_other_windows(start_app):
    class TimingOutProvider(TranscriptProvider):
        def organize_transcript(self, *, system, user):
            text = json.loads(user)["text"]
            self.inputs.append(text)
            if text == "中间原话":
                raise TimeoutError
            return {"paragraphs": [[text + "。"]]}

    provider = TimingOutProvider(None)
    request, _ = start_session(start_app, provider)
    records = [
        {"startMs": 0, "endMs": 1000, "text": "前面的话"},
        {"startMs": 2000, "endMs": 3000, "text": "中间原话"},
        {"startMs": 4000, "endMs": 5000, "text": "后面的话"},
    ]
    assert request("POST", "captions", {"segments": records}).status == 201
    assert request("POST", "finish", {"gaps": [
        {"startMs": 1000, "endMs": 2000}, {"startMs": 3000, "endMs": 4000},
    ]}).status == 200

    organized = request("GET", "transcript").json["organized"]
    assert organized["status"] == "partial"
    assert [(paragraph.get("status"), paragraph["sentences"][0]["text"])
            for paragraph in organized["paragraphs"]] == [
        (None, "前面的话。"), ("raw", "中间原话"), (None, "后面的话。"),
    ]
    assert provider.inputs == ["前面的话", "中间原话", "中间原话", "后面的话"]


def test_failed_organization_write_can_retry_on_transcript_read(start_app, monkeypatch):
    from app.persistence import FileStore

    provider = TranscriptProvider([["保存后的整理稿。"]])
    request, _ = start_session(start_app, provider)
    assert request("POST", "captions", {"segments": [
        {"startMs": 0, "endMs": 1000, "text": "保存后的整理稿"},
    ]}).status == 201

    save = FileStore._save

    def fail_organization_write(store, replacements=None):
        if provider.inputs:
            raise OSError("disk write failed")
        return save(store, replacements)

    with monkeypatch.context() as patch:
        patch.setattr(FileStore, "_save", fail_organization_write)
        assert request("POST", "finish", {}).status == 200

    assert request("GET", "transcript").json["organized"] == {"status": "processing"}
    assert request("GET", "transcript").json["organized"]["status"] == "ready"


def test_raw_fallback_bounds_calls_when_no_sentence_boundary_is_returned(start_app):
    class EchoProvider(TranscriptProvider):
        def organize_transcript(self, *, system, user):
            payload = json.loads(user)
            self.inputs.append(payload)
            return {"paragraphs": [[payload["text"]]]}

    source = "原话" * 1005
    provider = EchoProvider(None)
    request, _ = start_session(start_app, provider)
    assert request("POST", "captions", {"segments": [
        {"startMs": 0, "endMs": 1000, "text": source},
    ]}).status == 201
    assert request("POST", "finish", {}).status == 200
    view = request("GET", "transcript").json
    assert view["organized"]["status"] == "partial"
    assert "".join(sentence["text"] for paragraph in view["organized"]["paragraphs"]
                   for sentence in paragraph["sentences"]) == source
    assert [(len(payload["text"]), payload["final"]) for payload in provider.inputs] == [
        (1000, False), (2000, False), (10, True),
    ]
