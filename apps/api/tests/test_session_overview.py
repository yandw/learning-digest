"""Session rolling summary + overview (contract-r4.md §6, ticket 6.4,
issue #89; ADR 0002). Python port of the PoC's topic-tick semantics
(apps/extension/session-summary.js): the server assembles each tick's
input from the Session's archived transcript records since the coverage
cursor (the end of the last Topic, or 0) plus a 120s context-only overlap
tail, calls the shared AI Provider seam, and appends the parsed Topics to
the append-only timeline stored in the sessionInsights collection. The
PoC's debounce (>=15min coverage or >=10 records) stays with the caller:
the server ticks whenever it is called with new material and replays the
current overview when the window is empty.

Seams under test: POST /v1/sessions/{id}/rolling-summary and
GET /v1/sessions/{id}/overview over the /v1 HTTP endpoints, plus the
GET /v1/usage extension. The default deterministic stub provider makes
every expectation repeatable; failure cases inject fault providers through
the same create_app seam the course-summary tests use.
"""

import re

from helpers import auth_header, create_session_for, make_audio_dir, open_account_with_id

EMAIL = "overview@example.com"
WORKER_TOKEN = "overview-worker-token"

SEGMENT = {
    "durationMs": 30000,
    "audioMimeType": "audio/webm;codecs=opus",
    "audioBase64": "T3ZlcnZpZXctc2VnbWVudC1hdWRpbw==",
}

# ASR text keyed by the segment's source-timeline start (the scripted
# Speech Provider below); each segment yields one 30s record.
ASR_TEXT_BY_START = {
    0: "欢迎来到这一节，我们先回顾上一课留下的三个问题",
    30000: "注意力分数的计算，就是把查询向量和键向量做点积",
    60000: "最后我们补一段：注意力机制在长序列下的处理思路",
    90000: "多头注意力的并行结构与参数拆分",
}

RECORDS = [
    {"startMs": 0, "endMs": 30000, "text": ASR_TEXT_BY_START[0]},
    {"startMs": 30000, "endMs": 60000, "text": ASR_TEXT_BY_START[30000]},
]


def archive_captions(app, token: str, session_id: str, records: list) -> None:
    """Archive captions records on the session (the captions path archives
    once; the append cases below drive the ASR write-back instead)."""
    response = app.request(
        "POST",
        f"/v1/sessions/{session_id}/captions",
        headers=auth_header(token),
        body={"segments": records},
    )
    assert response.status == 201, response.json


def open_captions_session(app, token: str, records: list) -> dict:
    """One resource + source + captions session carrying `records`."""
    sessioned = create_session_for(app, token, "overview")
    archive_captions(app, token, sessioned["session"]["id"], records)
    return sessioned["session"]


def drain(app) -> dict:
    """One worker cycle over the claim/result endpoints with the scripted
    Speech Provider (test_audio_chain's pattern): each claimed task
    transcribes to one 30s record on the source timeline."""
    claimed = app.request(
        "POST",
        "/v1/worker/tasks/claim",
        headers=auth_header(WORKER_TOKEN),
        body={"limit": 8},
    ).json["tasks"]
    for task in claimed:
        records = [
            {
                "startMs": task["startMs"],
                "endMs": task["endMs"],
                "text": ASR_TEXT_BY_START[task["startMs"]],
            }
        ]
        app.request(
            "POST",
            f"/v1/worker/tasks/{task['taskId']}/result",
            headers=auth_header(WORKER_TOKEN),
            body={"status": "done", "records": records},
        )
    return {"claimed": len(claimed)}


def upload(app, token: str, session_id: str, segment_index: int, start_ms: int) -> None:
    response = app.request(
        "POST",
        f"/v1/sessions/{session_id}/audio-segments",
        headers=auth_header(token),
        body={**SEGMENT, "segmentIndex": segment_index, "startMs": start_ms},
    )
    assert response.status == 201, response.json


def open_asr_session(app, token: str, uploads: list) -> dict:
    """One ASR session whose archived records come through the worker
    write-back (the only path that can append records to a session)."""
    sessioned = create_session_for(app, token, "overview-append")
    for segment_index, start_ms in uploads:
        upload(app, token, sessioned["session"]["id"], segment_index, start_ms)
    drain(app)
    return sessioned["session"]


def tick(app, token: str, session_id: str):
    return app.request(
        "POST",
        f"/v1/sessions/{session_id}/rolling-summary",
        headers=auth_header(token),
        body={},
    )


def test_first_generation_lands_the_overview_and_get_reads_it_back(start_app):
    app = start_app(seed_emails=[EMAIL])
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_captions_session(app, token, RECORDS)

    generated = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/rolling-summary",
        headers=auth_header(token),
        body={},
    )
    assert generated.status == 201, generated.json
    overview = generated.json["overview"]
    assert overview["sessionId"] == session["id"]
    # The stub chunks the two-record window into one Topic spanning it
    # (stub rule: groups of two records, title quotes the first line).
    assert overview["topics"] == [
        {
            "index": 1,
            "startMs": 0,
            "endMs": 60000,
            "title": RECORDS[0]["text"][:12],
            "text": f"{RECORDS[0]['text']}；{RECORDS[1]['text']}",
        }
    ]
    assert overview["lastCoveredMs"] == 60000
    assert overview["generation"]["provider"] == "stub"
    assert overview["generation"]["inputChars"] > 0
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", overview["generatedAt"])

    read_back = app.request(
        "GET",
        f"/v1/sessions/{session['id']}/overview",
        headers=auth_header(token),
    )
    assert read_back.status == 200
    assert read_back.json["overview"] == overview


def test_append_tick_adds_new_topics_and_continues_the_numbering(start_app):
    app = start_app(
        seed_emails=[EMAIL],
        config={"audio_dir": make_audio_dir(), "worker_token": WORKER_TOKEN},
    )
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_asr_session(app, token, [(0, 0), (1, 30000)])

    first = tick(app, token, session["id"])
    assert first.status == 201, first.json
    first_topics = first.json["overview"]["topics"]
    assert first_topics == [
        {
            "index": 1,
            "startMs": 0,
            "endMs": 60000,
            "title": ASR_TEXT_BY_START[0][:12],
            "text": f"{ASR_TEXT_BY_START[0]}；{ASR_TEXT_BY_START[30000]}",
        }
    ]

    # Two more records arrive through the write-back; the next tick's
    # window starts at the cursor (the last Topic's end, 60000).
    upload(app, token, session["id"], 2, 60000)
    upload(app, token, session["id"], 3, 90000)
    assert drain(app) == {"claimed": 2}

    second = tick(app, token, session["id"])
    assert second.status == 200, second.json
    overview = second.json["overview"]
    # Append-only (ADR 0002): the first Topic is byte-identical, the new
    # one continues the numbering and carries the continuation flag.
    assert overview["topics"] == [
        first_topics[0],
        {
            "index": 2,
            "startMs": 60000,
            "endMs": 120000,
            "title": ASR_TEXT_BY_START[60000][:12],
            "text": f"{ASR_TEXT_BY_START[60000]}；{ASR_TEXT_BY_START[90000]}",
            "continuation": True,
        },
    ]
    assert overview["lastCoveredMs"] == 120000

    # The stored overview the GET serves is the appended one.
    read_back = app.request(
        "GET", f"/v1/sessions/{session['id']}/overview", headers=auth_header(token)
    )
    assert read_back.json["overview"] == overview

    # D18 口径 (contract-r4 §6.3): each landed tick counts once, inputChars
    # summed; the course-summary counters stay untouched.
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["rollingSummaryCount"] == 2
    assert usage["rollingSummaryInputChars"] == (
        first.json["overview"]["generation"]["inputChars"]
        + overview["generation"]["inputChars"]
    )
    assert usage["summaryCount"] == 0
    assert usage["summaryInputChars"] == 0
    assert usage["audioSeconds"] == 120  # four done ASR segments x 30s


class OnceThenRefuseTopicsProvider:
    """Test double for the replay contract: the first tick may call the AI
    Provider once; any further call is a contract breach (a replay must
    re-land nothing)."""

    id = "once"
    model = "once-1"

    def __init__(self):
        self.calls = 0

    def generate(self, *, system, user):
        raise AssertionError("the tick path must not use the course-summary operation")

    def generate_topics(self, *, system, user):
        self.calls += 1
        assert self.calls == 1, "a replay must not re-call the AI Provider"
        return [{"start": 0, "end": 60000, "title": "注入的话题", "text": "注入的总结正文"}]


def test_replay_with_no_new_records_returns_the_current_overview(start_app):
    provider = OnceThenRefuseTopicsProvider()
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_captions_session(app, token, RECORDS)

    first = tick(app, token, session["id"])
    assert first.status == 201, first.json

    # A repeat trigger inside the same window (the caller's debounce slipped)
    # replays the stored overview without re-calling the provider.
    replay = tick(app, token, session["id"])
    assert replay.status == 200
    assert replay.json["overview"] == first.json["overview"]
    assert provider.calls == 1


class FlakyTopicsProvider:
    """Fails the Nth tick call; otherwise returns one usable Topic."""

    id = "flaky"
    model = "flaky-1"

    def __init__(self, fail_on):
        self.calls = 0
        self.fail_on = set(fail_on)

    def generate(self, *, system, user):
        raise AssertionError("the tick path must not use the course-summary operation")

    def generate_topics(self, *, system, user):
        self.calls += 1
        if self.calls in self.fail_on:
            raise RuntimeError("AI Provider 宕机")
        return [{"start": 0, "end": 60000, "title": "注入的话题", "text": "注入的总结正文"}]


def test_ai_failure_before_landing_answers_502_and_lands_nothing(start_app):
    provider = FlakyTopicsProvider(fail_on={1})
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_captions_session(app, token, RECORDS)

    failed = tick(app, token, session["id"])
    assert failed.status == 502
    assert failed.json["error"]["code"] == "rolling_summary_failed"

    # 不落脏数据: no overview, no usage.
    read_back = app.request(
        "GET", f"/v1/sessions/{session['id']}/overview", headers=auth_header(token)
    )
    assert read_back.status == 404
    assert read_back.json["error"]["code"] == "overview_not_generated"
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["rollingSummaryCount"] == 0
    assert usage["rollingSummaryInputChars"] == 0


def test_ai_failure_after_landing_preserves_the_previous_overview(start_app):
    provider = FlakyTopicsProvider(fail_on={2})
    app = start_app(
        seed_emails=[EMAIL],
        ai_provider=provider,
        config={"audio_dir": make_audio_dir(), "worker_token": WORKER_TOKEN},
    )
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    session = open_asr_session(app, token, [(0, 0), (1, 30000)])

    first = tick(app, token, session["id"])
    assert first.status == 201, first.json
    landed = first.json["overview"]

    upload(app, token, session["id"], 2, 60000)
    assert drain(app) == {"claimed": 1}
    failed = tick(app, token, session["id"])
    assert failed.status == 502
    assert failed.json["error"]["code"] == "rolling_summary_failed"

    # The stored overview is untouched — earlier Topics stay, generatedAt
    # stays, and the usage counters only ever saw the first landing.
    read_back = app.request(
        "GET", f"/v1/sessions/{session['id']}/overview", headers=auth_header(token)
    )
    assert read_back.status == 200
    assert read_back.json["overview"] == landed
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["rollingSummaryCount"] == 1
    assert usage["rollingSummaryInputChars"] == landed["generation"]["inputChars"]


def test_cross_account_reads_and_ticks_are_the_same_404(start_app):
    app = start_app(seed_emails=["owner-a@example.com", "owner-b@example.com"])
    owner = open_account_with_id(app, "owner-a@example.com")
    stranger = open_account_with_id(app, "owner-b@example.com")
    session = open_captions_session(app, owner["token"], RECORDS)

    for method, path in [
        ("POST", f"/v1/sessions/{session['id']}/rolling-summary"),
        ("GET", f"/v1/sessions/{session['id']}/overview"),
    ]:
        response = app.request(method, path, headers=auth_header(stranger["token"]), body={})
        assert response.status == 404, (method, response.json)
        # D2: another account's session and an unknown id are the same 404.
        assert response.json == app.request(
            method,
            "/v1/sessions/ses_does_not_exist/rolling-summary"
            if method == "POST"
            else "/v1/sessions/ses_does_not_exist/overview",
            headers=auth_header(stranger["token"]),
            body={},
        ).json


def test_a_session_without_archived_records_answers_409(start_app):
    app = start_app(seed_emails=[EMAIL])
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    sessioned = create_session_for(app, token, "overview-empty")
    session = sessioned["session"]  # nothing archived yet

    response = tick(app, token, session["id"])
    assert response.status == 409
    assert response.json["error"]["code"] == "no_session_transcript_to_summarize"
    # The overview was never created, and the GET says so with its own code.
    read_back = app.request(
        "GET", f"/v1/sessions/{session['id']}/overview", headers=auth_header(token)
    )
    assert read_back.status == 404
    assert read_back.json["error"]["code"] == "overview_not_generated"


def test_both_panel_endpoints_require_a_bearer_credential(start_app):
    app = start_app(seed_emails=[EMAIL])

    for method, path in [
        ("POST", "/v1/sessions/ses_any/rolling-summary"),
        ("GET", "/v1/sessions/ses_any/overview"),
    ]:
        response = app.request(method, path, body={})
        assert response.status == 401, (method, response.json)
        assert response.json["error"]["code"] == "unauthorized"


def test_new_error_copies_match_the_contract_fixtures(start_app):
    """The new codes' messages are the error-examples.json samples verbatim
    (the shared-samples discipline: the API implementation quotes the
    fixtures, it does not re-derive copy)."""
    from helpers import error_example

    app = start_app(seed_emails=[EMAIL])
    account = open_account_with_id(app, EMAIL)
    token = account["token"]
    empty_session = create_session_for(app, token, "overview-empty")["session"]

    no_records = tick(app, token, empty_session["id"])
    assert no_records.json["error"]["message"] == (
        error_example("error-rolling-summary-no-transcript")["response"]["body"]["error"]["message"]
    )

    read_back = app.request(
        "GET", f"/v1/sessions/{empty_session['id']}/overview", headers=auth_header(token)
    )
    assert read_back.json["error"]["message"] == (
        error_example("error-overview-not-generated")["response"]["body"]["error"]["message"]
    )
