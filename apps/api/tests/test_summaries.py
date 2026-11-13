"""Course summary generation endpoints (contract-r3.md §2.1–2.3, §3.1–3.3;
decisions D16/D17/D18; ticket 4.4 — Python port of test/summaries.test.js,
Node ticket 3.2, issue #74). Seams under test: the three HTTP endpoints
POST /v1/resources/{id}/summaries, GET /v1/resources/{id}/summaries,
GET /v1/summaries/{id} — plus the AI Provider seam boundary (stub by
default; failing/fault-injecting providers for the failure paths; no
external network).

Pinned here: generation aggregates ALL archived material (records/gaps/
notes, D17), every POST creates a NEW record (contract-r3 §1 幂等例外),
the citation reconciliation drops anything that does not resolve to a
real archived record (§2.2), failures land nothing (D16 不落脏数据),
and usage accrues only on success (D18).
"""

import re
from types import SimpleNamespace

from app.ai_providers import create_stub_provider

from helpers import auth_header, open_account_with_id

EMAIL_A = "summary-a@example.com"
EMAIL_B = "summary-b@example.com"

RECORDS = [
    {"startMs": 30000, "endMs": 60000, "text": "注意力分数的计算，就是把查询向量和键向量做点积"},
    {"startMs": 60000, "endMs": 90000, "text": "上一节我们留了一个问题：为什么要缩放点积"},
]


class CapturingProvider:
    """Delegates to the real stub and records the exact prompt it was
    handed — the D17/D18 inputChars 口径 is checked against it."""

    def __init__(self):
        stub = create_stub_provider()
        self.id = stub.id
        self.model = stub.model
        self._stub = stub
        self.captured: list[dict] = []

    def generate(self, *, system, user):
        self.captured.append({"system": system, "user": user})
        return self._stub.generate(system=system, user=user)


def start_summary_app(start_app, provider=None):
    """One app instance with two accounts; the AI provider is injectable
    per test (default None -> the app resolves the deterministic stub)."""
    app = start_app(seed_emails=[EMAIL_A, EMAIL_B], ai_provider=provider)
    a = open_account_with_id(app, EMAIL_A)
    b = open_account_with_id(app, EMAIL_B)
    return app, a, b


def favorite_and_archive(
    app,
    token,
    *,
    records,
    gaps=None,
    finish=True,
    label,
    url="https://www.bilibili.com/video/BV1ab411L78c?p=2",
):
    """Favorite a fixture source and archive captions + finish on a new
    session (public flow only). With `records: []` the session stays
    record-less (gaps-only when gaps are reported) — the 409 material."""
    created = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body={"url": url, "title": f"注意力机制详解 P2：自注意力（{label}）"},
    )
    assert created.status == 201, created.json
    resource, source = created.json["resource"], created.json["source"]
    session_response = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(token),
        body={},
    )
    assert session_response.status == 201
    session = session_response.json["session"]

    if records:
        archived = app.request(
            "POST",
            f"/v1/sessions/{session['id']}/captions",
            headers=auth_header(token),
            body={"segments": records},
        )
        assert archived.status == 201, archived.json
    if finish:
        finished = app.request(
            "POST",
            f"/v1/sessions/{session['id']}/finish",
            headers=auth_header(token),
            body={"gaps": gaps} if gaps else {},
        )
        assert finished.status == 200
    return {"resource": resource, "source": source, "session": session}


def generate(app, token, resource_id):
    return app.request(
        "POST",
        f"/v1/resources/{resource_id}/summaries",
        headers=auth_header(token),
        body={},
    )


def test_generate_201_full_summary_verbatim_citations_input_chars_and_usage_accrues(start_app):
    provider = CapturingProvider()
    app, a, _b = start_summary_app(start_app, provider)
    archived = favorite_and_archive(
        app,
        a["token"],
        records=RECORDS,
        gaps=[{"startMs": 150000, "endMs": 210000}],
        label="happy",
    )
    resource, source, session = (
        archived["resource"],
        archived["source"],
        archived["session"],
    )
    note = app.request(
        "POST",
        f"/v1/resources/{resource['id']}/notes",
        headers=auth_header(a["token"]),
        body={
            "clientRequestId": "note-1",
            "text": "3:20 起的例子值得回看",
            "sourceId": source["id"],
            "positionMs": 200000,
        },
    )
    assert note.status == 201

    response = generate(app, a["token"], resource["id"])
    assert response.status == 201, response.json
    summary = response.json["summary"]
    assert summary["id"]
    assert summary["resourceId"] == resource["id"]
    assert isinstance(summary["content"], str)
    assert "注意力机制详解 P2：自注意力（happy）" in summary["content"]
    # generation metadata: the provider identity is recorded, never credentials (D16).
    assert sorted(summary["generation"].keys()) == ["inputChars", "model", "provider"]
    assert summary["generation"]["provider"] == "stub"
    assert isinstance(summary["generation"]["model"], str)
    # inputChars = the FULL assembled prompt (system + user, code points,
    # D17/D18) — verified against what the provider actually received.
    assert len(provider.captured) == 1
    system, user = provider.captured[0]["system"], provider.captured[0]["user"]
    assert summary["generation"]["inputChars"] == len(system) + len(user)
    # The assembled user prompt carries the template's 4 variables' material:
    # stamped transcript lines, the gap marker, and the timestamped note.
    assert f"[{source['id']} 200000] 3:20 起的例子值得回看" in user
    assert "课程总结" in system
    assert any(
        re.match(r"^\[ses_\S+ 30000–60000\] ", line) for line in user.split("\n")
    )
    assert "已跳过，该范围未取得文本" in user

    # Citations: every segmentRef resolves to a real archived record and
    # every quote is a verbatim excerpt; sorted by startMs ascending (§2.2).
    assert isinstance(summary["citations"], list)
    assert len(summary["citations"]) > 0
    previous_start = -1
    for citation in summary["citations"]:
        assert sorted(citation.keys()) == ["quote", "segmentRef"]
        assert sorted(citation["segmentRef"].keys()) == ["endMs", "sessionId", "startMs"]
        assert citation["segmentRef"]["sessionId"] == session["id"]
        record = next(
            (
                r
                for r in RECORDS
                if r["startMs"] == citation["segmentRef"]["startMs"]
                and r["endMs"] == citation["segmentRef"]["endMs"]
            ),
            None,
        )
        assert record is not None, citation
        assert citation["quote"] in record["text"]
        assert citation["segmentRef"]["startMs"] > previous_start
        previous_start = citation["segmentRef"]["startMs"]

    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", summary["generatedAt"])

    # Usage accrued exactly once, with the same inputChars (D18).
    usage = app.request("GET", "/v1/usage", headers=auth_header(a["token"]))
    assert usage.status == 200
    assert usage.json["summaryCount"] == 1
    assert usage.json["summaryInputChars"] == summary["generation"]["inputChars"]
    assert usage.json["updatedAt"]


def test_generate_every_post_creates_a_new_summary_regeneration_deterministic_but_separate(start_app):
    app, a, _b = start_summary_app(start_app)
    archived = favorite_and_archive(app, a["token"], records=RECORDS, label="repeat")
    resource = archived["resource"]

    first = generate(app, a["token"], resource["id"])
    assert first.status == 201
    second = generate(app, a["token"], resource["id"])
    assert second.status == 201
    assert second.json["summary"]["id"] != first.json["summary"]["id"]
    # Same input -> same output (stub determinism, Testing Decisions).
    assert second.json["summary"]["content"] == first.json["summary"]["content"]
    assert second.json["summary"]["citations"] == first.json["summary"]["citations"]
    assert (
        second.json["summary"]["generation"]["inputChars"]
        == first.json["summary"]["generation"]["inputChars"]
    )

    listing = app.request(
        "GET",
        f"/v1/resources/{resource['id']}/summaries",
        headers=auth_header(a["token"]),
    )
    assert listing.status == 200
    assert len(listing.json["summaries"]) == 2
    # Newest first; the list projection carries counts, not the body.
    assert listing.json["summaries"][0]["id"] == second.json["summary"]["id"]
    assert sorted(listing.json["summaries"][0].keys()) == [
        "citationCount",
        "generatedAt",
        "generation",
        "id",
        "resourceId",
    ]
    assert (
        listing.json["summaries"][0]["citationCount"]
        == len(first.json["summary"]["citations"])
    )

    # Detail: the bare full shape, identical to the generation response.
    detail = app.request(
        "GET",
        f"/v1/summaries/{second.json['summary']['id']}",
        headers=auth_header(a["token"]),
    )
    assert detail.status == 200
    assert detail.json["summary"] == second.json["summary"]


def test_generate_no_archived_transcript_text_409_provider_never_called_nothing_recorded(start_app):
    calls = {"n": 0}

    def spy_generate(*, system, user):
        calls["n"] += 1
        return {"content": "不应出现", "citations": []}

    provider = SimpleNamespace(id="spy", model="spy-1", generate=spy_generate)
    app, a, _b = start_summary_app(start_app, provider)
    # An active session with nothing archived yet.
    untouched = favorite_and_archive(app, a["token"], records=[], finish=False, label="untouched")
    # A finished session whose only transcript content is a reported gap
    # (D17: gaps are markers, not text — "只有 gaps 同样算无文本").
    gap_only = favorite_and_archive(
        app,
        a["token"],
        records=[],
        gaps=[{"startMs": 30000, "endMs": 60000}],
        label="gap-only",
        url="https://www.bilibili.com/video/BV1ab411L78c?p=3",
    )

    for archived in (untouched, gap_only):
        response = generate(app, a["token"], archived["resource"]["id"])
        assert response.status == 409, response.json
        assert response.json["error"]["code"] == "no_transcript_to_summarize"
        assert response.json["error"]["message"] == "这门资料还没有可总结的逐字稿，先学习并归档后再生成"
    assert calls["n"] == 0, "the AI provider must not be called without transcript text"

    usage = app.request("GET", "/v1/usage", headers=auth_header(a["token"]))
    assert usage.json == {
        "audioSeconds": 0,
        "summaryCount": 0,
        "summaryInputChars": 0,
        "updatedAt": None,
    }


def test_generate_provider_failure_502_lands_nothing_usage_untouched_retry_works(start_app):
    stub = create_stub_provider()
    state = {"fail_next": True}

    def flaky_generate(*, system, user):
        if state["fail_next"]:
            raise RuntimeError("provider timeout after 120s")
        return stub.generate(system=system, user=user)

    provider = SimpleNamespace(id="flaky", model="flaky-1", generate=flaky_generate)
    app, a, _b = start_summary_app(start_app, provider)
    archived = favorite_and_archive(app, a["token"], records=RECORDS, label="flaky")
    resource = archived["resource"]

    failed = generate(app, a["token"], resource["id"])
    assert failed.status == 502
    assert failed.json["error"]["code"] == "summary_generation_failed"
    assert failed.json["error"]["message"] == "总结生成失败，请稍后重试；本次尝试不产生总结记录"

    # Nothing landed: the list is empty, usage shows nothing (D18).
    listing = app.request(
        "GET",
        f"/v1/resources/{resource['id']}/summaries",
        headers=auth_header(a["token"]),
    )
    assert listing.json == {"summaries": []}
    usage = app.request("GET", "/v1/usage", headers=auth_header(a["token"]))
    assert usage.json == {
        "audioSeconds": 0,
        "summaryCount": 0,
        "summaryInputChars": 0,
        "updatedAt": None,
    }

    # Retry (provider recovers) succeeds as a normal generation.
    state["fail_next"] = False
    retried = generate(app, a["token"], resource["id"])
    assert retried.status == 201
    usage_after = app.request("GET", "/v1/usage", headers=auth_header(a["token"]))
    assert usage_after.json["summaryCount"] == 1


def test_generate_401_without_credentials_unknown_and_cross_account_same_404(start_app):
    app, a, b = start_summary_app(start_app)
    archived = favorite_and_archive(app, a["token"], records=RECORDS, label="iso")
    resource = archived["resource"]
    generated = generate(app, a["token"], resource["id"])
    assert generated.status == 201
    summary_id = generated.json["summary"]["id"]

    anonymous = app.request(
        "POST", f"/v1/resources/{resource['id']}/summaries", body={}
    )
    assert anonymous.status == 401
    assert anonymous.json["error"] == {"code": "unauthorized", "message": "未登录或凭据缺失"}
    anonymous_list = app.request("GET", f"/v1/resources/{resource['id']}/summaries")
    anonymous_detail = app.request("GET", f"/v1/summaries/{summary_id}")
    assert anonymous_list.status == 401
    assert anonymous_detail.status == 401

    cross_generate = generate(app, b["token"], resource["id"])
    assert cross_generate.status == 404
    assert cross_generate.json["error"] == {"code": "not_found", "message": "资源不存在或无权访问"}
    cross_list = app.request(
        "GET",
        f"/v1/resources/{resource['id']}/summaries",
        headers=auth_header(b["token"]),
    )
    assert cross_list.status == 404
    cross_detail = app.request(
        "GET", f"/v1/summaries/{summary_id}", headers=auth_header(b["token"])
    )
    assert cross_detail.status == 404
    assert cross_detail.json["error"] == {"code": "not_found", "message": "总结不存在或无权访问"}
    unknown_detail = app.request(
        "GET", "/v1/summaries/sum_does_not_exist", headers=auth_header(a["token"])
    )
    assert unknown_detail.status == 404


def test_generate_accounts_are_isolated_lists_and_usage_never_leak(start_app):
    app, a, b = start_summary_app(start_app)
    mine = favorite_and_archive(app, a["token"], records=RECORDS, label="mine")
    theirs = favorite_and_archive(app, b["token"], records=RECORDS, label="theirs")

    assert generate(app, a["token"], mine["resource"]["id"]).status == 201
    assert generate(app, b["token"], theirs["resource"]["id"]).status == 201
    assert generate(app, b["token"], theirs["resource"]["id"]).status == 201

    my_list = app.request(
        "GET",
        f"/v1/resources/{mine['resource']['id']}/summaries",
        headers=auth_header(a["token"]),
    )
    assert len(my_list.json["summaries"]) == 1
    b_list = app.request(
        "GET",
        f"/v1/resources/{theirs['resource']['id']}/summaries",
        headers=auth_header(b["token"]),
    )
    assert len(b_list.json["summaries"]) == 2

    a_usage = app.request("GET", "/v1/usage", headers=auth_header(a["token"]))
    assert a_usage.json["summaryCount"] == 1
    b_usage = app.request("GET", "/v1/usage", headers=auth_header(b["token"]))
    assert b_usage.json["summaryCount"] == 2


class _ScriptedProvider:
    """A fault-injecting provider whose generate() returns the payload set
    on the instance (the ported "provider.generate = ..." redefinition)."""

    def __init__(self, provider_id: str):
        self.id = provider_id
        self.model = f"{provider_id}-1"
        self.payload: dict | None = None

    def generate(self, *, system, user):
        return self.payload


def test_citation_reconciliation_refs_that_do_not_resolve_are_dropped_before_landing(start_app):
    provider = _ScriptedProvider("messy")
    app, a, _b = start_summary_app(start_app, provider)
    archived = favorite_and_archive(app, a["token"], records=RECORDS, label="reconcile")
    session_id = archived["session"]["id"]
    # The session id is server-generated, so the provider resolves it lazily:
    # two resolvable citations plus seven dead/malformed ones.
    provider.payload = {
        "content": "# 正文照常落库",
        "citations": [
            {
                "quote": "注意力分数的计算，就是把查询向量和键向量做点积",
                "sessionId": session_id,
                "startMs": 30000,
                "endMs": 60000,
            },
            {"quote": "为什么要缩放点积", "sessionId": session_id, "startMs": 60000, "endMs": 90000},
            {"quote": "注意力分数的计算", "sessionId": "ses_unknown", "startMs": 30000, "endMs": 60000},
            {"quote": "注意力分数的计算", "sessionId": session_id, "startMs": 30000, "endMs": 59999},
            {"quote": "注意力分数就是点积", "sessionId": session_id, "startMs": 30000, "endMs": 60000},
            {"quote": "为什么要缩放点积", "sessionId": session_id, "startMs": 90000, "endMs": 90000},
            {"quote": "为什么要缩放点积", "sessionId": session_id},
            "a stray string",
            None,
        ],
    }

    response = generate(app, a["token"], archived["resource"]["id"])
    assert response.status == 201, response.json
    summary = response.json["summary"]
    # Only the two resolvable citations survive, sorted by startMs (§2.2).
    assert summary["citations"] == [
        {
            "quote": "注意力分数的计算，就是把查询向量和键向量做点积",
            "segmentRef": {"sessionId": session_id, "startMs": 30000, "endMs": 60000},
        },
        {
            "quote": "为什么要缩放点积",
            "segmentRef": {"sessionId": session_id, "startMs": 60000, "endMs": 90000},
        },
    ]
    assert summary["content"] == "# 正文照常落库"


def test_citation_reconciliation_all_invalid_summary_still_lands_with_empty_array(start_app):
    provider = _ScriptedProvider("hallucinating")
    provider.payload = {
        "content": "# 只有正文",
        "citations": [{"quote": "编造的话", "sessionId": "ses_nowhere", "startMs": 1, "endMs": 2}],
    }
    app, a, _b = start_summary_app(start_app, provider)
    archived = favorite_and_archive(app, a["token"], records=RECORDS, label="all-dead")

    response = generate(app, a["token"], archived["resource"]["id"])
    assert response.status == 201
    assert response.json["summary"]["citations"] == []
    listing = app.request(
        "GET",
        f"/v1/resources/{archived['resource']['id']}/summaries",
        headers=auth_header(a["token"]),
    )
    assert listing.json["summaries"][0]["citationCount"] == 0


def test_generate_provider_response_without_usable_content_string_is_502(start_app):
    provider = _ScriptedProvider("shapeless")
    provider.payload = {"citations": []}  # no content
    app, a, _b = start_summary_app(start_app, provider)
    archived = favorite_and_archive(app, a["token"], records=RECORDS, label="shapeless")

    response = generate(app, a["token"], archived["resource"]["id"])
    assert response.status == 502
    assert response.json["error"]["code"] == "summary_generation_failed"
    listing = app.request(
        "GET",
        f"/v1/resources/{archived['resource']['id']}/summaries",
        headers=auth_header(a["token"]),
    )
    assert listing.json == {"summaries": []}
