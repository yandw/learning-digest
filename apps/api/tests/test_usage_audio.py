"""GET /v1/usage — the transcription slice of the account usage endpoint
(Ticket 4.3; contract-r3.md §2.4/§3.4; decision D18). Python port of the
audio-driven cases in test/usage.test.js (the summary-generation cases
land with the summaries ticket, 4.4).

Seam: GET /v1/usage (the bare account-level Usage) plus the round-2
upload/claim/result endpoints that accrue into it — all over the /v1 HTTP
endpoints with the contract fixtures. The Node test drives the worker via
its loop client + stub provider; this port drives the same write-backs
over HTTP directly (the worker unit itself stays Node, apps/worker).

Pinned here (D18 口径):
- audioSeconds accrues on FIRST done (回写首存为准 replays never re-count),
  read as floor(sum(audioMs) / 1000) at the account level;
- transcribing and failed segments never count; a silent segment
  (done with records: []) does;
- usage is account-scoped: two accounts never see each other's counts.
"""

from helpers import (
    audio_example,
    auth_header,
    create_session_for,
    make_audio_dir,
    open_account_with_id,
)

EMAIL_A = "usage-a@example.com"
EMAIL_B = "usage-b@example.com"
WORKER_TOKEN = "usage-worker-token"

SEGMENT = audio_example("api-audio-segment-upload")["request"]["body"]


def start_usage_app(start_app):
    """One app instance with a worker credential, two invited accounts,
    one active session per account (public flow)."""
    app = start_app(
        seed_emails=[EMAIL_A, EMAIL_B],
        config={"audio_dir": make_audio_dir(), "worker_token": WORKER_TOKEN},
    )
    accounts = []
    for email in [EMAIL_A, EMAIL_B]:
        account = open_account_with_id(app, email)
        sessioned = create_session_for(app, account["token"], "usage")
        accounts.append({**account, "session": sessioned["session"]})

    def upload(account, overrides=None):
        response = app.request(
            "POST",
            f"/v1/sessions/{account['session']['id']}/audio-segments",
            headers=auth_header(account["token"]),
            body={**SEGMENT, **(overrides or {})},
        )
        assert response.status == 201, response.json
        return response

    def claim(body):
        return app.request(
            "POST",
            "/v1/worker/tasks/claim",
            headers=auth_header(WORKER_TOKEN),
            body=body,
        )

    def submit_result(task_id, body):
        return app.request(
            "POST",
            f"/v1/worker/tasks/{task_id}/result",
            headers=auth_header(WORKER_TOKEN),
            body=body,
        )

    def usage_of(account):
        response = app.request(
            "GET",
            "/v1/usage",
            headers=auth_header(account["token"]),
        )
        assert response.status == 200
        return response.json

    def drain(limit=3):
        """Drive the claim/result cycle like the worker loop until one idle
        claim comes back empty (done for every claimed task)."""
        while True:
            claimed = claim({"limit": limit}).json["tasks"]
            if not claimed:
                return
            for task in claimed:
                result = submit_result(
                    task["taskId"],
                    {
                        "status": "done",
                        "records": [
                            {
                                "startMs": task["startMs"],
                                "endMs": task["endMs"],
                                "text": f"stub 转写文本（第 {task['segmentIndex']} 段）",
                            }
                        ],
                    },
                )
                assert result.status == 200

    return {
        "app": app,
        "accounts": accounts,
        "upload": upload,
        "claim": claim,
        "submitResult": submit_result,
        "usageOf": usage_of,
        "drain": drain,
    }


def test_a_done_audio_segment_accrues_its_duration_in_seconds(start_app):
    started = start_usage_app(start_app)
    app = started["app"]
    try:
        account = started["accounts"][0]
        # Before any activity: zeros, nothing recorded yet.
        assert started["usageOf"](account) == {
            "audioSeconds": 0,
            "summaryCount": 0,
            "summaryInputChars": 0,
            "updatedAt": None,
        }

        started["upload"](account)
        claimed = started["claim"]({"limit": 1}).json["tasks"]
        assert len(claimed) == 1
        # Transcribing (claimed, no result yet) does not count.
        assert started["usageOf"](account)["audioSeconds"] == 0

        done = started["submitResult"](
            claimed[0]["taskId"],
            {"status": "done", "records": [{"startMs": 30000, "endMs": 60000, "text": "一段话"}]},
        )
        assert done.json == {"taskId": claimed[0]["taskId"], "status": "done"}
        usage = started["usageOf"](account)
        assert usage["audioSeconds"] == 30
        assert usage["summaryCount"] == 0
        assert usage["summaryInputChars"] == 0
        assert isinstance(usage["updatedAt"], str) and usage["updatedAt"].endswith("Z")
    finally:
        app.close()


def test_silent_segments_count_and_failed_segments_never_do(start_app):
    started = start_usage_app(start_app)
    app = started["app"]
    try:
        account = started["accounts"][0]
        # A failing provider: the segment reaches transcribing then failed —
        # no accrual either way (D18: 失败段不计).
        started["upload"](account)
        claimed = started["claim"]({"limit": 1}).json["tasks"]
        failed = started["submitResult"](
            claimed[0]["taskId"],
            {"status": "failed", "error": {"code": "transcription_failed", "message": "provider down"}},
        )
        assert failed.json == {"taskId": claimed[0]["taskId"], "status": "failed"}
        assert started["usageOf"](account)["audioSeconds"] == 0

        # A silent segment: done with an empty records array — still counted
        # (the audio was really transcribed, D18).
        started["upload"](account, {"segmentIndex": 2, "startMs": 60000})
        claimed = started["claim"]({"limit": 1}).json["tasks"]
        done = started["submitResult"](claimed[0]["taskId"], {"status": "done", "records": []})
        assert done.json == {"taskId": claimed[0]["taskId"], "status": "done"}
        assert started["usageOf"](account)["audioSeconds"] == 30
    finally:
        app.close()


def test_floor_semantics_two_30_5s_segments_sum_to_61s(start_app):
    started = start_usage_app(start_app)
    app = started["app"]
    try:
        account = started["accounts"][0]
        started["upload"](account, {"segmentIndex": 1, "startMs": 0, "durationMs": 30500})
        started["upload"](account, {"segmentIndex": 2, "startMs": 30500, "durationMs": 30500})
        started["drain"]()
        assert started["usageOf"](account)["audioSeconds"] == 61
    finally:
        app.close()


def test_a_replayed_done_result_never_double_counts(start_app):
    started = start_usage_app(start_app)
    app = started["app"]
    try:
        account = started["accounts"][0]
        started["upload"](account)
        claimed = started["claim"]({"limit": 1}).json["tasks"]
        task_id = claimed[0]["taskId"]
        result = {"status": "done", "records": [{"startMs": 0, "endMs": 30000, "text": "一段话"}]}
        first = started["submitResult"](task_id, result)
        assert first.json["status"] == "done"
        started["submitResult"](task_id, result)
        started["submitResult"](
            task_id,
            {"status": "failed", "error": {"code": "transcription_failed", "message": "迟到的失败"}},
        )
        assert started["usageOf"](account)["audioSeconds"] == 30
    finally:
        app.close()


def test_unauthenticated_reads_are_401_and_accounts_never_see_each_others_counts(start_app):
    started = start_usage_app(start_app)
    app = started["app"]
    try:
        a, b = started["accounts"]
        anonymous = app.request("GET", "/v1/usage")
        assert anonymous.status == 401
        assert anonymous.json["error"]["code"] == "unauthorized"

        started["upload"](a)
        started["drain"]()

        assert started["usageOf"](a)["audioSeconds"] == 30
        b_usage = started["usageOf"](b)
        assert b_usage["audioSeconds"] == 0
        assert b_usage["summaryCount"] == 0
        assert b_usage["summaryInputChars"] == 0
    finally:
        app.close()
