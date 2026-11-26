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

import json
import re
from types import SimpleNamespace

import httpx
import pytest

from app.ai_providers import create_qwen_provider, create_stub_provider

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
    assert "flowchart" not in summary
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


def test_generate_uses_one_global_prompt_for_theme_based_review(start_app):
    provider = CapturingProvider()
    app, account, _ = start_summary_app(start_app, provider)
    token = account["token"]
    mixed = "能听清吗另外缩放点积的系数要怎么选"
    archived = favorite_and_archive(
        app,
        token,
        records=[
            {"startMs": 0, "endMs": 30000, "text": "查询向量和键向量做点积"},
            {"startMs": 30000, "endMs": 60000, "text": mixed},
            {"startMs": 60000, "endMs": 90000, "text": "只在键向量维数较大时显著影响分布"},
        ],
        label="theme",
    )

    response = generate(app, token, archived["resource"]["id"])
    assert response.status == 201, response.json
    assert len(provider.captured) == 1
    system, user = provider.captured[0]["system"], provider.captured[0]["user"]
    for instruction in ("按主题合并", "混合发言", "相关问答", "适用条件", "反例", "###"):
        assert instruction in system
    assert mixed in user, "model needs the full utterance to distinguish useful context"
    assert "只在键向量维数较大时显著影响分布" in user


def test_configured_prompt_is_used_for_generation_without_changing_other_app_instances(start_app):
    for version in ("relationship", "detailed"):
        provider = CapturingProvider()
        app = start_app(
            seed_emails=[EMAIL_A],
            ai_provider=provider,
            config={"course_summary_prompt": version},
        )
        token = open_account_with_id(app, EMAIL_A)["token"]
        archived = favorite_and_archive(app, token, records=RECORDS, label=version)

        response = generate(app, token, archived["resource"]["id"])

        assert response.status == 201, response.json
        call, = provider.captured
        assert ("relation 从" in call["system"]) == (version == "relationship")
        assert RECORDS[0]["text"] in call["user"]


def test_generate_keeps_only_flowchart_connections_with_verbatim_sources(start_app):
    calls = []
    evidence = "如果维数大，就缩放点积，否则直接使用点积。"
    reminder = "练习后要记录维数。"

    def completion(result):
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(result)}}]})

    def reply(request):
        messages = json.loads(request.content)["messages"]
        user = messages[-1]["content"]
        if user.startswith("{"):
            return completion({"paragraphs": [[evidence, reminder]]})
        calls.append(messages)
        session_id = re.search(r"\[(ses_\S+) 30000–60000\]", user)[1]
        ref = {"sessionId": session_id, "startMs": 30000, "endMs": 60000}
        result = {
            "content": "## 并列建议\n\n- 记录维数\n- 保存结果",
            "citations": [
                {"recordId": "R2", "quote": "模型转述的记录建议"},
                {"recordId": "R99", **ref, "quote": evidence},
            ],
            "flowchart": {
                "title": "点积处理",
                "nodes": [
                    {"id": "check", "label": "检查维数"},
                    {"id": "scale", "label": "缩放点积"},
                    {"id": "direct", "label": "直接使用点积"},
                    {"id": "log", "label": "记录维数"},
                ],
                "edges": [
                    {"from": "check", "to": "scale", "label": "维数大", "citation": {"recordId": "R1"}},
                    {"from": "check", "to": "direct", "label": "其他情况", "citation": {**ref, "quote": evidence}},
                    {"from": "scale", "to": "log", "citation": {**ref, "quote": "先缩放，再记录维数"}},
                    {"from": "direct", "to": "log", "citation": {**ref, "endMs": 60001, "quote": evidence}},
                    {"from": "check", "to": "log", "citation": {"recordId": "R99", **ref, "quote": evidence}},
                    {"from": "scale", "to": "unknown", "citation": {**ref, "quote": evidence}},
                ],
            },
        }
        return completion(result)

    provider = create_qwen_provider(api_key="test", transport=httpx.MockTransport(reply))
    app, account, _ = start_summary_app(start_app, provider)
    token = account["token"]
    archived = favorite_and_archive(
        app,
        token,
        records=[
            {"startMs": 30000, "endMs": 45000, "text": "如果维数大"},
            {"startMs": 45000, "endMs": 60000, "text": "就缩放点积否则直接使用点积"},
            {"startMs": 60000, "endMs": 75000, "text": "练习后要记录维数"},
        ],
        label="flowchart",
    )
    response = generate(app, token, archived["resource"]["id"])
    assert response.status == 201, response.json
    assert len(calls) == 1
    assert "并列" in calls[0][0]["content"]
    session_id = archived["session"]["id"]
    assert f"[引用编号 R1]\n[{session_id} 30000–60000] {evidence}" in calls[0][-1]["content"]
    assert f"[引用编号 R2]\n[{session_id} 60000–75000] {reminder}" in calls[0][-1]["content"]
    summary = response.json["summary"]
    assert "- 记录维数\n- 保存结果" in summary["content"]
    assert summary["citations"] == [{
        "quote": reminder,
        "segmentRef": {"sessionId": session_id, "startMs": 60000, "endMs": 75000},
    }]
    citation = {
        "quote": evidence,
        "segmentRef": {"sessionId": session_id, "startMs": 30000, "endMs": 60000},
    }
    assert summary["flowchart"] == {
        "title": "点积处理",
        "nodes": [
            {"id": "check", "label": "检查维数"},
            {"id": "scale", "label": "缩放点积"},
            {"id": "direct", "label": "直接使用点积"},
        ],
        "edges": [
            {"from": "check", "to": "scale", "label": "维数大", "citation": citation},
            {"from": "check", "to": "direct", "label": "其他情况", "citation": citation},
        ],
    }
    detail = app.request("GET", f"/v1/summaries/{summary['id']}", headers=auth_header(token))
    assert detail.json["summary"] == summary


@pytest.mark.parametrize(
    ("title", "archive_text"),
    [
        ("学习建议", "可以记录维数也可以保存结果"),
        ("学习建议\ud800", "先记录再保存"),
    ],
)
def test_generate_preserves_text_summary_when_flowchart_cannot_be_used(start_app, title, archive_text):
    def reply(*, system, user):
        session_id = re.search(r"\[(ses_\S+) 30000–60000\]", user)[1]
        return {
            "content": "## 并列建议\n\n- 记录维数\n- 保存结果",
            "citations": [],
            "flowchart": {
                "title": title,
                "nodes": [{"id": "a", "label": "记录维数"}, {"id": "b", "label": "保存结果"}],
                "edges": [{
                    "from": "a",
                    "to": "b",
                    "citation": {"quote": "先记录再保存", "sessionId": session_id, "startMs": 30000, "endMs": 60000},
                }],
            },
        }

    provider = SimpleNamespace(id="stub", model="flowchart-test", generate=reply)
    app, account, _ = start_summary_app(start_app, provider)
    token = account["token"]
    archived = favorite_and_archive(
        app,
        token,
        records=[{"startMs": 30000, "endMs": 60000, "text": archive_text}],
        label="parallel",
    )
    response = generate(app, token, archived["resource"]["id"])
    assert response.status == 201, response.json
    summary = response.json["summary"]
    assert "- 记录维数\n- 保存结果" in summary["content"]
    assert "flowchart" not in summary


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
    # Contract-r4 §6.3 appends the rolling-summary pair and §7 the digest/
    # explain pairs; the r3 keys' semantics are unchanged.
    assert usage.json == {
        "audioSeconds": 0,
        "summaryCount": 0,
        "summaryInputChars": 0,
        "rollingSummaryCount": 0,
        "rollingSummaryInputChars": 0,
        "digestCount": 0,
        "digestInputChars": 0,
        "explainCount": 0,
        "explainInputChars": 0,
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
    # Contract-r4 §6.3 appends the rolling-summary pair and §7 the digest/
    # explain pairs; the r3 keys' semantics are unchanged.
    assert usage.json == {
        "audioSeconds": 0,
        "summaryCount": 0,
        "summaryInputChars": 0,
        "rollingSummaryCount": 0,
        "rollingSummaryInputChars": 0,
        "digestCount": 0,
        "digestInputChars": 0,
        "explainCount": 0,
        "explainInputChars": 0,
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


def test_generate_keeps_equal_range_utterances_but_only_cites_nonzero_ranges(start_app):
    class Provider(_ScriptedProvider):
        def generate(self, *, system, user):
            self.user = user
            return {
                "content": "两种计算方式。",
                "citations": [{"recordId": "R1"}, {"recordId": "R2"}, {"recordId": "R3"}],
            }

    provider = Provider("range")
    app, account, _ = start_summary_app(start_app, provider)
    token = account["token"]
    archived = favorite_and_archive(app, token, label="range", records=[
        {"startMs": 0, "endMs": 0, "text": "题目"},
        {"startMs": 1000, "endMs": 3000, "text": "直接计算"},
        {"startMs": 1000, "endMs": 3000, "text": "先做缩放"},
    ])

    response = generate(app, token, archived["resource"]["id"])
    assert response.status == 201, response.json
    assert [citation["quote"] for citation in response.json["summary"]["citations"]] == [
        "直接计算", "先做缩放",
    ]
    session_id = archived["session"]["id"]
    assert f"[{session_id} 0–0] 题目" in provider.user
    assert f"[{session_id} 1000–3000] 直接计算" in provider.user
    assert f"[{session_id} 1000–3000] 先做缩放" in provider.user


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


def test_generate_merges_overlapping_sessions_into_one_transcript(start_app):
    """Owner decision 2026-11-17: 一份资料只有一份逐字稿。Two sessions
    re-watching the same ranges contribute every overlapping copy to the
    summary prompt; collect_material now clusters overlapping ranges and
    keeps one copy (longest text, then captions over asr, then smaller
    sessionId), and identical gaps fold into one. The dropped duplicate's
    text must not appear in the prompt at all."""
    provider = CapturingProvider()
    app, a, _b = start_summary_app(start_app, provider)
    created = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(a["token"]),
        body={
            "url": "https://www.bilibili.com/video/BV1ab411L78c?p=2",
            "title": "多段学习去重",
        },
    )
    assert created.status == 201, created.json
    resource, source = created.json["resource"], created.json["source"]

    sessions = []
    for _ in range(2):
        response = app.request(
            "POST",
            f"/v1/sources/{source['id']}/sessions",
            headers=auth_header(a["token"]),
            body={},
        )
        assert response.status == 201
        sessions.append(response.json["session"])

    first_records = [
        {"startMs": 0, "endMs": 30000, "text": "被丢弃的短文本甲"},
        {"startMs": 30000, "endMs": 60000, "text": "保留的乙第二段不重叠"},
    ]
    second_records = [
        {"startMs": 0, "endMs": 30000, "text": "保留的更长文本甲更加完整"},
        {"startMs": 60000, "endMs": 90000, "text": "保留的乙第三段"},
    ]
    for session, records in ((sessions[0], first_records), (sessions[1], second_records)):
        archived = app.request(
            "POST",
            f"/v1/sessions/{session['id']}/captions",
            headers=auth_header(a["token"]),
            body={"segments": records},
        )
        assert archived.status == 201, archived.json
        finished = app.request(
            "POST",
            f"/v1/sessions/{session['id']}/finish",
            headers=auth_header(a["token"]),
            body={"gaps": [{"startMs": 100000, "endMs": 160000}]},
        )
        assert finished.status == 200

    response = generate(app, a["token"], resource["id"])
    assert response.status == 201, response.json
    assert len(provider.captured) == 1
    user = provider.captured[0]["user"]

    assert "被丢弃的短文本甲" not in user, "the dropped duplicate leaves no copy in the prompt"
    for kept in ("保留的更长文本甲更加完整", "保留的乙第二段不重叠", "保留的乙第三段"):
        assert user.count(kept) == 1, f"{kept} appears exactly once"
    # The two sessions' identical gap folds to a single marker line.
    gap_lines = [line for line in user.split("\n") if "已跳过，该范围未取得文本" in line]
    assert len(gap_lines) == 1, gap_lines


def test_generate_keeps_same_time_material_and_gaps_from_distinct_sources(start_app):
    provider = CapturingProvider()
    app, account, _ = start_summary_app(start_app, provider)
    token = account["token"]
    first = favorite_and_archive(
        app,
        token,
        records=[{"startMs": 0, "endMs": 30000, "text": "第一集介绍点积"}],
        gaps=[{"startMs": 30000, "endMs": 60000}],
        label="part-one",
    )
    second = favorite_and_archive(
        app,
        token,
        records=[
            {"startMs": 0, "endMs": 30000, "text": "第二集回顾课程背景"},
            {"startMs": 30000, "endMs": 60000, "text": "第二集补充缩放系数与例外"},
        ],
        label="part-two",
        url="https://www.bilibili.com/video/BV1ab411L78c?p=3",
    )
    resource_id = first["resource"]["id"]
    # The favorite endpoint creates one Source at a time. Seed the
    # supported persisted shape of a Resource with multiple Sources.
    for collection, entity in (("sources", second["source"]), ("sessions", second["session"])):
        existing = app.store.get(collection, entity["id"])
        app.store.set(collection, entity["id"], {**existing, "resourceId": resource_id})

    response = generate(app, token, resource_id)
    assert response.status == 201, response.json
    assert {citation["quote"] for citation in response.json["summary"]["citations"]} == {
        "第一集介绍点积",
        "第二集补充缩放系数与例外",
    }
    user = provider.captured[0]["user"]
    assert "第二集回顾课程背景" in user
    assert f"[{first['session']['id']} 30000–60000] 已跳过，该范围未取得文本" in user
    for archived in (first, second):
        assert f"[来源 {archived['source']['id']}]" in user


def test_generate_prefers_organized_transcript_and_cites_exact_sentence(start_app):
    provider = _ScriptedProvider("organized")
    provider.organize_transcript = lambda **_: {
        "paragraphs": [[
            "大家好。", "现在，如果维数增大，就缩放点积。", "另一种情况不需要。", "也要核对维数。",
        ]],
    }
    app, account, _ = start_summary_app(start_app, provider)
    token = account["token"]
    archived = favorite_and_archive(
        app,
        token,
        records=[
            {"startMs": 0, "endMs": 30000, "text": "大家好现在如果维数增大"},
            {"startMs": 30000, "endMs": 60000, "text": "就缩放点积另一种情况不需要也要核对维数"},
        ],
        label="organized",
    )
    session_id = archived["session"]["id"]
    calls = []

    def summarize(*, system, user):
        calls.append(user)
        return {
            "content": "## 缩放点积\n\n### 适用条件\n\n维数增大时缩放点积。",
            "citations": [
                {"quote": "如果维数增大，就缩放点积。", "sessionId": session_id, "startMs": 0, "endMs": 60000},
                {"quote": "也要核对维数。", "sessionId": session_id, "startMs": 30000, "endMs": 60000},
                {"quote": "编造的原话。", "sessionId": session_id, "startMs": 0, "endMs": 60000},
            ],
        }

    provider.generate = summarize
    response = generate(app, token, archived["resource"]["id"])
    assert response.status == 201, response.json
    assert len(calls) == 1
    assert "大家好现在如果维数增大" not in calls[0]
    assert f"[{session_id} 0–60000] 现在，如果维数增大，就缩放点积。" in calls[0]
    assert response.json["summary"]["citations"] == [
        {
            "quote": "如果维数增大，就缩放点积。",
            "segmentRef": {"sessionId": session_id, "startMs": 0, "endMs": 60000},
        },
        {
            "quote": "也要核对维数。",
            "segmentRef": {"sessionId": session_id, "startMs": 30000, "endMs": 60000},
        },
    ]


@pytest.mark.parametrize(
    ("reply", "expected_status", "expected_outcome"),
    [('{"content":"## 缩放点积"}', 201, "ready"), ("invalid", 502, "failed")],
)
def test_generate_records_reported_tokens_and_one_attempt(
    start_app, caplog, reply, expected_status, expected_outcome
):
    requests = []

    def complete(request):
        requests.append(request)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": reply}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 3},
        })

    provider = create_qwen_provider(api_key="fixture-key", transport=httpx.MockTransport(complete))
    app, account, _ = start_summary_app(start_app, provider)
    token = account["token"]
    archived = favorite_and_archive(app, token, records=RECORDS, finish=False, label="metrics")

    with caplog.at_level("INFO", logger="app.summaries"):
        response = generate(app, token, archived["resource"]["id"])
    assert response.status == expected_status, response.json
    assert len(requests) == 1
    assert len(caplog.records) == 1
    metrics = dict(caplog.records[0].args)
    assert metrics.pop("latencyMs") >= 0
    assert metrics == {
        "provider": "qwen",
        "model": provider.model,
        "status": expected_outcome,
        "promptVersion": "relationship",
        "inputTokens": 12,
        "outputTokens": 3,
        "callCount": 1,
        "retryCount": 0,
    }
    assert RECORDS[0]["text"] not in caplog.text
