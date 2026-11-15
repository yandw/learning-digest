"""Session Digest (contract-r4.md §7, ticket 6.5, issue #90). Server-side
port of the PoC's global pass (apps/extension/session-summary.js
buildGlobalPassMessages + parseGlobalPass): ONE generation over the FULL
transcript of a FINISHED Session lands the whole rich report — 核心要点
(overview), 话题时间轴 (topics), 主题归纳 (categories), 金句 (quotes),
待办 (todos) — in the sessionDigests collection. The digest is 整节一次性
(D22): every accepted POST regenerates and overwrites the stored document,
the opposite of the append-only rolling summary.

Seams under test: POST /v1/sessions/{id}/digest and
GET /v1/sessions/{id}/digest over the /v1 HTTP endpoints, plus the
GET /v1/usage extension. The default deterministic stub provider makes
every expectation repeatable; failure and overwrite cases inject fault
providers through the same create_app seam the rolling-summary tests use.
"""

import re

from app.ai_providers import create_stub_provider
from helpers import auth_header, create_session_for, open_account_with_id

EMAIL = "digest@example.com"

RECORDS = [
    {"startMs": 0, "endMs": 30000, "text": "欢迎来到这一节，我们先回顾上一课留下的三个问题"},
    {"startMs": 30000, "endMs": 60000, "text": "注意力分数的计算，就是把查询向量和键向量做点积"},
]

ISO_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def open_finished_session(app, token: str, records: list, gaps: list | None = None) -> dict:
    """One resource + captions session archived with `records`, then
    finished (with the optional reported gaps). The digest only answers on
    finished Sessions."""
    sessioned = create_session_for(app, token, "digest")
    session_id = sessioned["session"]["id"]
    archived = app.request(
        "POST",
        f"/v1/sessions/{session_id}/captions",
        headers=auth_header(token),
        body={"segments": records},
    )
    assert archived.status == 201, archived.json
    finished = app.request(
        "POST",
        f"/v1/sessions/{session_id}/finish",
        headers=auth_header(token),
        body={"gaps": gaps} if gaps else {},
    )
    assert finished.status == 200, finished.json
    return finished.json["session"]


def generate_digest(app, token: str, session_id: str):
    return app.request(
        "POST",
        f"/v1/sessions/{session_id}/digest",
        headers=auth_header(token),
        body={},
    )


def read_digest(app, token: str, session_id: str):
    return app.request(
        "GET",
        f"/v1/sessions/{session_id}/digest",
        headers=auth_header(token),
    )


def test_first_generation_lands_the_digest_and_get_reads_it_back(start_app):
    app = start_app(seed_emails=[EMAIL])
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_finished_session(app, token, RECORDS)

    generated = generate_digest(app, token, session["id"])
    assert generated.status == 201, generated.json
    digest = generated.json["digest"]
    assert digest["sessionId"] == session["id"]
    # The fixed five-section rich report (the PoC global-pass schema): the
    # stub chunks the two records into one topic spanning them, quotes the
    # first and last record, and derives the rest from the material.
    assert digest["overview"] == [RECORDS[0]["text"]]
    assert digest["topics"] == [
        {
            "startMs": 0,
            "endMs": 60000,
            "title": RECORDS[0]["text"][:12],
            "bullets": [RECORDS[0]["text"], RECORDS[1]["text"]],
        }
    ]
    assert digest["categories"] == [{"title": "主题归纳", "points": [RECORDS[0]["text"]]}]
    assert digest["quotes"] == [
        {"startMs": 0, "text": RECORDS[0]["text"]},
        {"startMs": 30000, "text": RECORDS[1]["text"]},
    ]
    assert digest["todos"] == []
    assert digest["generation"]["provider"] == "stub"
    assert digest["generation"]["inputChars"] > 0
    assert ISO_TIMESTAMP.match(digest["generatedAt"])

    read_back = read_digest(app, token, session["id"])
    assert read_back.status == 200
    assert read_back.json["digest"] == digest


class CountingDigestProvider:
    """Produces a different usable report per call, so an overwrite is
    observable in the stored document."""

    id = "counting"
    model = "counting-1"

    def __init__(self):
        self.calls = 0

    def generate(self, *, system, user):
        raise AssertionError("the digest path must not use the course-summary operation")

    def generate_topics(self, *, system, user):
        raise AssertionError("the digest path must not use the rolling-summary operation")

    def generate_digest(self, *, system, user):
        self.calls += 1
        return {
            "topics": [
                {
                    "start": 0,
                    "end": 30000 * self.calls,
                    "title": f"第{self.calls}版话题",
                    "summary": f"第{self.calls}版正文",
                }
            ]
        }


def test_regeneration_overwrites_the_stored_digest_and_counts_again(start_app):
    provider = CountingDigestProvider()
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_finished_session(app, token, RECORDS)

    first = generate_digest(app, token, session["id"])
    assert first.status == 201, first.json
    first_digest = first.json["digest"]
    assert first_digest["topics"] == [
        {"startMs": 0, "endMs": 30000, "title": "第1版话题", "summary": "第1版正文"}
    ]

    # 整节一次性 (D22): the repeat POST is a NEW digest that replaces the
    # stored one — no append, no replay (the finished session's material
    # never grows, so a regenerate is always a fresh full pass).
    second = generate_digest(app, token, session["id"])
    assert second.status == 200, second.json
    second_digest = second.json["digest"]
    assert second_digest["topics"] == [
        {"startMs": 0, "endMs": 60000, "title": "第2版话题", "summary": "第2版正文"}
    ]
    assert second_digest["generatedAt"] >= first_digest["generatedAt"]

    read_back = read_digest(app, token, session["id"])
    assert read_back.status == 200
    assert read_back.json["digest"] == second_digest

    # D18 口径: every landed digest was a real AI call — both count.
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["digestCount"] == 2
    assert usage["digestInputChars"] == (
        first_digest["generation"]["inputChars"] + second_digest["generation"]["inputChars"]
    )
    # The other counters stay untouched by digest calls.
    assert usage["rollingSummaryCount"] == 0
    assert usage["summaryCount"] == 0
    assert usage["explainCount"] == 0


class ScriptedDigestProvider:
    """Captures the assembled digest prompt and returns a fixed raw report
    (or fails, for the 502 paths). The rolling-summary operation delegates
    to the deterministic stub, so tests that drive a rolling tick first
    (the live-topics assembly case) work unchanged."""

    id = "scripted"
    model = "scripted-1"

    def __init__(self, report=None, fail=False):
        self.calls = 0
        self.prompts = []
        self.report = report
        self.fail = fail
        self._stub = create_stub_provider()

    def generate(self, *, system, user):
        raise AssertionError("the digest path must not use the course-summary operation")

    def generate_topics(self, *, system, user):
        return self._stub.generate_topics(system=system, user=user)

    def generate_digest(self, *, system, user):
        self.calls += 1
        if self.fail:
            raise RuntimeError("AI Provider 宕机")
        self.prompts.append({"system": system, "user": user})
        return self.report


def test_ai_failure_answers_502_and_lands_nothing(start_app):
    provider = ScriptedDigestProvider(fail=True)
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_finished_session(app, token, RECORDS)

    failed = generate_digest(app, token, session["id"])
    assert failed.status == 502
    assert failed.json["error"]["code"] == "digest_failed"

    # 不落脏数据: no digest, no usage — and the provider was actually called.
    assert provider.calls == 1
    read_back = read_digest(app, token, session["id"])
    assert read_back.status == 404
    assert read_back.json["error"]["code"] == "digest_not_generated"
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["digestCount"] == 0
    assert usage["digestInputChars"] == 0


def test_ai_failure_on_regeneration_preserves_the_previous_digest(start_app):
    report = {
        "overview": ["只有一轮的核心结论"],
        "topics": [{"start": 0, "end": 60000, "title": "唯一话题", "summary": "唯一正文"}],
    }
    provider = ScriptedDigestProvider(report=report)
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_finished_session(app, token, RECORDS)

    first = generate_digest(app, token, session["id"])
    assert first.status == 201, first.json
    landed = first.json["digest"]

    provider.fail = True
    failed = generate_digest(app, token, session["id"])
    assert failed.status == 502
    assert failed.json["error"]["code"] == "digest_failed"

    # The stored digest is untouched — 生成失败不改变已有纪要.
    read_back = read_digest(app, token, session["id"])
    assert read_back.status == 200
    assert read_back.json["digest"] == landed
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["digestCount"] == 1
    assert usage["digestInputChars"] == landed["generation"]["inputChars"]


def test_an_unfinished_session_answers_409_before_any_ai_call(start_app):
    provider = ScriptedDigestProvider()
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    sessioned = create_session_for(app, token, "digest-active")
    archived = app.request(
        "POST",
        f"/v1/sessions/{sessioned['session']['id']}/captions",
        headers=auth_header(token),
        body={"segments": RECORDS},
    )
    assert archived.status == 201, archived.json
    session = sessioned["session"]  # still active

    response = generate_digest(app, token, session["id"])
    assert response.status == 409
    assert response.json["error"]["code"] == "session_not_finished"
    assert provider.calls == 0
    read_back = read_digest(app, token, session["id"])
    assert read_back.status == 404
    assert read_back.json["error"]["code"] == "digest_not_generated"


def test_a_finished_session_without_records_answers_409(start_app):
    provider = ScriptedDigestProvider()
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    sessioned = create_session_for(app, token, "digest-empty")
    finished = app.request(
        "POST",
        f"/v1/sessions/{sessioned['session']['id']}/finish",
        headers=auth_header(token),
        body={},
    )
    assert finished.status == 200, finished.json
    session = finished.json["session"]  # finished, but nothing archived

    response = generate_digest(app, token, session["id"])
    assert response.status == 409
    assert response.json["error"]["code"] == "no_session_transcript_to_summarize"
    assert provider.calls == 0


def test_cross_account_reads_and_generates_are_the_same_404(start_app):
    app = start_app(seed_emails=["owner-a@example.com", "owner-b@example.com"])
    owner = open_account_with_id(app, "owner-a@example.com")
    stranger = open_account_with_id(app, "owner-b@example.com")
    session = open_finished_session(app, owner["token"], RECORDS)

    for method in ("POST", "GET"):
        response = app.request(
            method,
            f"/v1/sessions/{session['id']}/digest",
            headers=auth_header(stranger["token"]),
            body={} if method == "POST" else None,
        )
        assert response.status == 404, (method, response.json)
        # D2: another account's session and an unknown id are the same 404.
        unknown = app.request(
            method,
            "/v1/sessions/ses_does_not_exist/digest",
            headers=auth_header(stranger["token"]),
            body={} if method == "POST" else None,
        )
        assert response.json == unknown.json


def test_both_digest_endpoints_require_a_bearer_credential(start_app):
    app = start_app(seed_emails=[EMAIL])

    for method in ("POST", "GET"):
        response = app.request(method, "/v1/sessions/ses_any/digest", body={})
        assert response.status == 401, (method, response.json)
        assert response.json["error"]["code"] == "unauthorized"


def test_prompt_assembles_the_full_transcript_gaps_and_live_topics(start_app):
    """The digest input is the FULL transcript (records + the reported gap
    ranges as skipped markers, source-timeline order), and the stored
    rolling summary's Topics ride along as the merge hint — the migrated
    session-report.md template's variables."""
    provider = ScriptedDigestProvider(
        report={"topics": [{"start": 0, "end": 90000, "title": "话题", "summary": "正文"}]}
    )
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    # A rolling overview first: the digest's liveTopicsLines hint.
    sessioned = create_session_for(app, token, "digest-assembly")
    session_id = sessioned["session"]["id"]
    app.request(
        "POST",
        f"/v1/sessions/{session_id}/captions",
        headers=auth_header(token),
        body={"segments": RECORDS},
    )
    ticked = app.request(
        "POST",
        f"/v1/sessions/{session_id}/rolling-summary",
        headers=auth_header(token),
        body={},
    )
    assert ticked.status == 201, ticked.json

    finished = app.request(
        "POST",
        f"/v1/sessions/{session_id}/finish",
        headers=auth_header(token),
        body={"gaps": [{"startMs": 60000, "endMs": 90000}]},
    )
    assert finished.status == 200, finished.json

    generated = generate_digest(app, token, session_id)
    assert generated.status == 201, generated.json
    assert provider.calls == 1
    user = provider.prompts[0]["user"]
    # The template's live-topics section carries the stored rolling Topics.
    assert "课中已识别的话题段（可参考/合并）：" in user
    assert f"- [0–60000] {RECORDS[0]['text'][:12]}" in user
    # The full transcript: both records and the reported gap as the skipped
    # marker, one timeline, startMs-ascending.
    assert "完整逐字稿：" in user
    assert f"[0–30000] {RECORDS[0]['text']}" in user
    assert f"[30000–60000] {RECORDS[1]['text']}" in user
    assert "[60000–90000] 已跳过，该范围未取得文本" in user


def test_new_error_copies_match_the_contract_fixtures(start_app):
    """The new codes' messages are the error-examples.json samples verbatim
    (the shared-samples discipline: the API implementation quotes the
    fixtures, it does not re-derive copy)."""
    from helpers import error_example

    app = start_app(seed_emails=[EMAIL])
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    sessioned = create_session_for(app, token, "digest-copies")
    session = sessioned["session"]

    not_finished = generate_digest(app, token, session["id"])
    assert not_finished.json["error"]["message"] == (
        error_example("error-digest-not-finished")["response"]["body"]["error"]["message"]
    )

    read_back = read_digest(app, token, session["id"])
    assert read_back.json["error"]["message"] == (
        error_example("error-digest-not-generated")["response"]["body"]["error"]["message"]
    )
