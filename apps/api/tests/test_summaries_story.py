"""The contract's two-generation story (contract-r3.md §1 幂等例外, §3.1;
fixtures/summary-examples.json, ticket 4.4 — Python port of
test/summaries-story.test.js, Node ticket 3.2, issue #74). Seam under
test: the same POST /v1/resources/{id}/summaries endpoint across a
catch-up — generate while the third session is still active (未学完可生成),
archive the catch-up session, generate again: a NEW record whose
citations include the new session's record.

The material is the fixtures' verbatim story (session-examples.json +
summary-examples.json): the B 站 P2 注意力机制详解 resource with a captions
session, two ASR sessions, the skipped gaps, the timestamped note, and
the catch-up record. Server-generated ids differ from the fixture ids
(they are opaque, contract §1) — the fixture's session ids appear here
only as the story's roles (ses_31 captions / ses_32 ASR finished /
ses_33 ASR active / ses_34 catch-up).

The worker round-trips run over the same claim/result HTTP endpoints the
worker unit consumes (test_audio_chain.py's pattern), with the story's
Speech Provider scripted by the segment's source-timeline start (210000
fails). The usage numbers follow D18 and reproduce the fixture story's
totals: 4 done audio segments x 30s = audioSeconds 120 (transcribing,
failed and captions material never count), 2 generations.

The summary generation itself runs through the same deterministic stub
provider as the rest of the suite (config/env default — no injected
provider here; real AI calls stay out of tests, D16).
"""

import re

from helpers import auth_header, make_audio_dir, open_account_with_id

EMAIL = "story@example.com"
WORKER_TOKEN = "story-worker-token"

# fixtures/summary-examples.json + session-examples.json, verbatim.
TITLE = "注意力机制详解 P2：自注意力"
CAPTION_RECORDS = [
    {"startMs": 138000, "endMs": 159000, "text": "这一节我们把注意力分数放到矩阵上看"},
    {"startMs": 159000, "endMs": 181000, "text": "Q K V 三个矩阵各司其职"},
]
CAPTION_GAP = {"startMs": 300000, "endMs": 360000}
ASR_TEXT_BY_START = {
    60000: "上一节我们留了一个问题：为什么要缩放点积",
    0: "欢迎来到这一节，我们先回顾上一课留下的三个问题",
    30000: "注意力分数的计算，就是把查询向量和键向量做点积",
    120000: "最后我们补一段：注意力机制在长序列下的处理思路",
}
FIXTURE_QUOTE_1 = "注意力分数的计算，就是把查询向量和键向量做点积"
FIXTURE_QUOTE_CATCH_UP = "最后我们补一段：注意力机制在长序列下的处理思路"
FIXTURE_QUOTE_SCALED = "为什么要缩放点积"
NOTE_TEXT = "3:20 起的例子值得回看"

SEGMENT = {
    "durationMs": 30000,
    "audioMimeType": "audio/webm;codecs=opus",
    "audioBase64": "U3Rvcnktc2VnbWVudC1hdWRpbw==",
}


def story_speech_provider(task: dict) -> list[dict]:
    """Speech Provider keyed by the segment's source-timeline start;
    segment-relative ms (run-once folds them onto the source timeline).
    210000 fails."""
    if task["startMs"] == 210000:
        raise RuntimeError("Speech Provider 返回 429，重试后仍失败")
    text = ASR_TEXT_BY_START[task["startMs"]]
    assert text, f"unexpected segment start {task['startMs']}"
    return [{"startMs": 0, "endMs": task["endMs"] - task["startMs"], "text": text}]


def drain_once(app, provider=story_speech_provider) -> dict:
    """One worker cycle: claim one task -> transcribe through the scripted
    Speech Provider -> submit the result (run-once.js's timestamp fold)."""
    claimed = app.request(
        "POST",
        "/v1/worker/tasks/claim",
        headers=auth_header(WORKER_TOKEN),
        body={"limit": 1},
    ).json["tasks"]
    done = failed = 0
    for task in claimed:
        try:
            relative = provider(task)
            records = [
                {
                    "startMs": task["startMs"] + record["startMs"],
                    "endMs": task["startMs"] + record["endMs"],
                    "text": record["text"],
                }
                for record in relative
            ]
            body = {"status": "done", "records": records}
            done += 1
        except Exception as error:  # task-level: write the failed result back
            body = {
                "status": "failed",
                "error": {"code": "transcription_failed", "message": str(error)},
            }
            failed += 1
        app.request(
            "POST",
            f"/v1/worker/tasks/{task['taskId']}/result",
            headers=auth_header(WORKER_TOKEN),
            body=body,
        )
    return {"claimed": len(claimed), "done": done, "failed": failed}


def test_story_generate_while_unfinished_catch_up_regenerate_cites_new_material(start_app):
    app = start_app(
        seed_emails=[EMAIL],
        config={"audio_dir": make_audio_dir(), "worker_token": WORKER_TOKEN},
    )
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    # The resource: the fixture's bilibili P2 分集.
    created = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body={"url": "https://www.bilibili.com/video/BV1ab411L78c?p=2", "title": TITLE},
    )
    assert created.status == 201
    resource, source = created.json["resource"], created.json["source"]

    def new_session() -> dict:
        response = app.request(
            "POST",
            f"/v1/sources/{source['id']}/sessions",
            headers=auth_header(token),
            body={},
        )
        assert response.status == 201
        return response.json["session"]

    def upload(session_id: str, segment_index: int, start_ms: int) -> None:
        response = app.request(
            "POST",
            f"/v1/sessions/{session_id}/audio-segments",
            headers=auth_header(token),
            body={
                **SEGMENT,
                "segmentIndex": segment_index,
                "startMs": start_ms,
            },
        )
        assert response.status == 201, response.json

    def finish_with_gaps(session_id: str, gaps: list) -> None:
        response = app.request(
            "POST",
            f"/v1/sessions/{session_id}/finish",
            headers=auth_header(token),
            body={"gaps": gaps} if gaps else {},
        )
        assert response.status == 200

    # ses_31-equivalent: captions path, finished, one skipped range.
    captions_session = new_session()
    archived = app.request(
        "POST",
        f"/v1/sessions/{captions_session['id']}/captions",
        headers=auth_header(token),
        body={"segments": CAPTION_RECORDS},
    )
    assert archived.status == 201
    finish_with_gaps(captions_session["id"], [CAPTION_GAP])

    # ses_32-equivalent: ASR, finished, one done segment + one skipped range.
    asr_finished_session = new_session()
    upload(asr_finished_session["id"], 0, 60000)
    finish_with_gaps(asr_finished_session["id"], [{"startMs": 150000, "endMs": 210000}])

    # ses_33-equivalent: ASR, left ACTIVE (未学完) — two done segments,
    # one failed segment (transcription_failed), one still pending.
    asr_active_session = new_session()
    upload(asr_active_session["id"], 0, 0)
    upload(asr_active_session["id"], 1, 30000)
    upload(asr_active_session["id"], 2, 210000)
    upload(asr_active_session["id"], 3, 300000)  # stays pending

    # Drain exactly the four queued tasks: 3 done + 1 failed.
    done = failed = 0
    for _ in range(4):
        summary = drain_once(app)
        done += summary["done"]
        failed += summary["failed"]
    assert done == 3
    assert failed == 1

    # The timestamped note (fixtures verbatim).
    note = app.request(
        "POST",
        f"/v1/resources/{resource['id']}/notes",
        headers=auth_header(token),
        body={
            "clientRequestId": "story-note-1",
            "text": NOTE_TEXT,
            "sourceId": source["id"],
            "positionMs": 200000,
        },
    )
    assert note.status == 201

    # --- Generation 1: while the third session is still active. ---
    def generate() -> object:
        return app.request(
            "POST",
            f"/v1/resources/{resource['id']}/summaries",
            headers=auth_header(token),
            body={},
        )

    first = generate()
    assert first.status == 201, first.json
    first_summary = first.json["summary"]
    assert first_summary["resourceId"] == resource["id"]

    # One citation per archived session, timeline-sorted; the fixture's
    # first quote is reproduced verbatim against the active session.
    assert len(first_summary["citations"]) == 3
    assert first_summary["citations"][0] == {
        "quote": FIXTURE_QUOTE_1,
        "segmentRef": {
            "sessionId": asr_active_session["id"],
            "startMs": 30000,
            "endMs": 60000,
        },
    }
    # The fixture's second citation is a verbatim excerpt of the ses_32 record.
    assert first_summary["citations"][1]["segmentRef"]["sessionId"] == asr_finished_session["id"]
    assert first_summary["citations"][1]["segmentRef"]["startMs"] == 60000
    assert FIXTURE_QUOTE_SCALED in first_summary["citations"][1]["quote"]

    # Content: the stub merges the note and names the uncovered ranges.
    assert NOTE_TEXT in first_summary["content"]
    assert "## 尚未覆盖" in first_summary["content"]
    assert str(CAPTION_GAP["startMs"]) in first_summary["content"]

    usage_after_first = app.request("GET", "/v1/usage", headers=auth_header(token))
    assert usage_after_first.json["audioSeconds"] == 90  # 3 done segments x 30s
    assert usage_after_first.json["summaryCount"] == 1
    assert usage_after_first.json["summaryInputChars"] == first_summary["generation"]["inputChars"]

    # --- The catch-up (用户故事 29): ses_34-equivalent archives one more
    # record on the same source, finished. ---
    catch_up_session = new_session()
    upload(catch_up_session["id"], 0, 120000)
    drained = drain_once(app)
    assert drained == {"claimed": 1, "done": 1, "failed": 0}
    finish_with_gaps(catch_up_session["id"], [])

    # The catch-up transcript view carries the fixture record verbatim.
    catch_up_view = app.request(
        "GET",
        f"/v1/sessions/{catch_up_session['id']}/transcript",
        headers=auth_header(token),
    )
    assert [
        {"startMs": r["startMs"], "endMs": r["endMs"], "text": r["text"]}
        for r in catch_up_view.json["records"]
    ] == [{"startMs": 120000, "endMs": 150000, "text": FIXTURE_QUOTE_CATCH_UP}]

    # --- Generation 2: the aggregation scope grew on its own (D17). ---
    second = generate()
    assert second.status == 201, second.json
    second_summary = second.json["summary"]
    assert second_summary["id"] != first_summary["id"]

    # Four citations now — the catch-up session's fixture quote is in.
    assert len(second_summary["citations"]) == 4
    assert second_summary["citations"][2] == {
        "quote": FIXTURE_QUOTE_CATCH_UP,
        "segmentRef": {
            "sessionId": catch_up_session["id"],
            "startMs": 120000,
            "endMs": 150000,
        },
    }
    # Still sorted by startMs across sessions.
    starts = [c["segmentRef"]["startMs"] for c in second_summary["citations"]]
    assert starts == sorted(starts)

    # The content grew with the material; the input grew with it too (D17).
    assert second_summary["content"] != first_summary["content"]
    assert FIXTURE_QUOTE_CATCH_UP in second_summary["content"]
    assert second_summary["generation"]["inputChars"] > first_summary["generation"]["inputChars"]

    # History kept: the list is newest-first with the fixture's counts.
    listing = app.request(
        "GET",
        f"/v1/resources/{resource['id']}/summaries",
        headers=auth_header(token),
    )
    assert listing.status == 200
    assert [[s["id"], s["citationCount"]] for s in listing.json["summaries"]] == [
        [second_summary["id"], 4],
        [first_summary["id"], 3],
    ]
    detail = app.request(
        "GET", f"/v1/summaries/{first_summary['id']}", headers=auth_header(token)
    )
    assert detail.json["summary"] == first_summary

    # --- Usage (D18, fixture totals): 4 done ASR segments = 120s; the
    # captions session, the failed segment and the pending one never count. ---
    usage = app.request("GET", "/v1/usage", headers=auth_header(token))
    assert usage.json["audioSeconds"] == 120
    assert usage.json["summaryCount"] == 2
    assert usage.json["summaryInputChars"] == (
        first_summary["generation"]["inputChars"]
        + second_summary["generation"]["inputChars"]
    )
    assert usage.json["updatedAt"]
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", usage.json["updatedAt"])
