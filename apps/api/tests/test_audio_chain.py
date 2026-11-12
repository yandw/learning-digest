"""Full audio -> transcription chain (Ticket 4.3 / Node ticket 2.3
acceptance, issue #66). Python port of test/audio-chain.test.js.

Public session flow -> out-of-order upload -> worker claim -> result
write-back -> GET transcript shows the archive. The Node test runs the
worker unit's real client + stub provider over the loopback HTTP listener;
this port drives the identical claim/result HTTP round-trips directly (the
worker unit itself stays Node, apps/worker — the API contract surface it
consumes is exactly what these tests exercise). The end state is observed
through the public TranscriptView seam (GET /v1/sessions/{id}/transcript)
end to end.
"""

import os

from helpers import (
    audio_example,
    auth_header,
    create_session_for,
    make_audio_dir,
    open_account_with_id,
)

EMAIL_A = "chain-a@example.com"
EMAIL_B = "chain-b@example.com"
WORKER_TOKEN = "chain-worker-token"

SEGMENT_BODIES = {
    1: audio_example("api-audio-segment-upload")["request"]["body"],
    2: audio_example("api-audio-segment-upload-second")["request"]["body"],
    3: audio_example("api-audio-segment-out-of-order")["request"]["body"],
}


def start_chain_app(start_app):
    """One app instance, two invited accounts, one active session per
    account (public flow: favorite -> session)."""
    app = start_app(
        seed_emails=[EMAIL_A, EMAIL_B],
        config={"audio_dir": make_audio_dir(), "worker_token": WORKER_TOKEN},
    )
    accounts = []
    for index, email in enumerate([EMAIL_A, EMAIL_B]):
        account = open_account_with_id(app, email)
        sessioned = create_session_for(app, account["token"], f"chain-{index}")
        accounts.append(
            {
                "token": account["token"],
                "accountId": account["accountId"],
                "session": sessioned["session"],
            }
        )

    def upload(account, segment_index):
        return app.request(
            "POST",
            f"/v1/sessions/{account['session']['id']}/audio-segments",
            headers=auth_header(account["token"]),
            body=SEGMENT_BODIES[segment_index],
        )

    def transcript_of(account):
        response = app.request(
            "GET",
            f"/v1/sessions/{account['session']['id']}/transcript",
            headers=auth_header(account["token"]),
        )
        assert response.status == 200
        return response.json

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

    def drain(provider=None):
        """Claim + write back like the worker loop until one idle claim
        comes back empty. `provider` maps a claimed task to a result body;
        the default is the stub provider's success text."""
        done = 0
        failed = 0
        while True:
            claimed = claim({"limit": 1}).json["tasks"]
            if not claimed:
                break
            for task in claimed:
                if provider is None:
                    result_body = {
                        "status": "done",
                        "records": [
                            {
                                "startMs": task["startMs"],
                                "endMs": task["endMs"],
                                "text": f"stub 转写文本（第 {task['segmentIndex']} 段）",
                            }
                        ],
                    }
                else:
                    result_body = provider(task)
                result = submit_result(task["taskId"], result_body)
                if result.json["status"] == "done":
                    done += 1
                else:
                    failed += 1
        return {"done": done, "failed": failed}

    return {
        "app": app,
        "store": app.store,
        "accounts": accounts,
        "upload": upload,
        "transcriptOf": transcript_of,
        "claim": claim,
        "submitResult": submit_result,
        "drain": drain,
    }


def test_out_of_order_upload_worker_drains_all_segments_transcript_shows_archive(start_app):
    started = start_chain_app(start_app)
    app, store = started["app"], started["store"]
    try:
        account = started["accounts"][0]
        # Out of order: 3, 1, 2 — the server places them by segmentIndex.
        for index in [3, 1, 2]:
            response = started["upload"](account, index)
            assert response.status == 201

        # Mid-flight: the view shows all three segments pending.
        mid_view = started["transcriptOf"](account)
        assert [p["segmentIndex"] for p in mid_view["pending"]] == [1, 2, 3]
        assert mid_view["origin"] == "asr"

        # The worker drains three tasks (limit 1 per cycle) plus one idle poll.
        summary = started["drain"]()
        assert summary == {"done": 3, "failed": 0}

        # The public transcript view now carries the whole archive, records
        # sorted by startMs, nothing pending, nothing failed.
        view = started["transcriptOf"](account)
        assert view["sessionId"] == account["session"]["id"]
        assert view["sourceId"] == account["session"]["sourceId"]
        assert view["resourceId"] == account["session"]["resourceId"]
        assert view["sessionStatus"] == "active"
        assert view["origin"] == "asr"
        assert [
            {"startMs": r["startMs"], "endMs": r["endMs"], "text": r["text"], "origin": r["origin"]}
            for r in view["records"]
        ] == [
            {"startMs": 30000, "endMs": 60000, "text": "stub 转写文本（第 1 段）", "origin": "asr"},
            {"startMs": 60000, "endMs": 90000, "text": "stub 转写文本（第 2 段）", "origin": "asr"},
            {"startMs": 90000, "endMs": 120000, "text": "stub 转写文本（第 3 段）", "origin": "asr"},
        ]
        assert view["pending"] == []
        assert view["failed"] == []
        assert view["gaps"] == []

        # Every task is terminal-done and every audio file is gone (D14).
        for task in store.list("transcriptionTasks"):
            assert task["status"] == "done"
            assert not os.path.exists(task["audioFile"]), task["taskId"]

        # The queue is drained: another claim gets the empty state.
        drained = started["claim"]({"limit": 1})
        assert drained.json == {"tasks": []}
    finally:
        app.close()


def test_a_failing_provider_writes_failed_feedback_into_the_view_and_keeps_audio(start_app):
    started = start_chain_app(start_app)
    app, store = started["app"], started["store"]
    try:
        account = started["accounts"][0]
        started["upload"](account, 1)

        def failing_provider(task):
            return {
                "status": "failed",
                "error": {"code": "transcription_failed", "message": "Speech Provider 返回 429，重试后仍失败"},
            }

        summary = started["drain"](provider=failing_provider)
        assert summary == {"done": 0, "failed": 1}

        view = started["transcriptOf"](account)
        assert view["failed"] == [
            {
                "segmentIndex": 1,
                "startMs": 30000,
                "endMs": 60000,
                "error": {
                    "code": "transcription_failed",
                    "message": "Speech Provider 返回 429，重试后仍失败",
                },
            }
        ]
        assert view["records"] == []
        assert view["pending"] == []

        # D14: failed audio is retained.
        task = store.list("transcriptionTasks")[0]
        assert task["status"] == "failed"
        assert os.path.exists(task["audioFile"])
    finally:
        app.close()


def test_a_silence_segment_flows_through_as_done_with_no_records_and_deletes_audio(start_app):
    started = start_chain_app(start_app)
    app, store = started["app"], started["store"]
    try:
        account = started["accounts"][0]
        # Normal audio upload; the provider just finds no speech in it
        # (contract-r2 §3.7: records: [] written back is still done).
        response = started["upload"](account, 1)
        assert response.status == 201

        def silent_provider(task):
            return {"status": "done", "records": []}

        summary = started["drain"](provider=silent_provider)
        assert summary == {"done": 1, "failed": 0}

        view = started["transcriptOf"](account)
        assert view["records"] == []
        assert view["pending"] == []
        assert view["failed"] == []

        task = store.list("transcriptionTasks")[0]
        assert task["status"] == "done"
        assert not os.path.exists(task["audioFile"])
    finally:
        app.close()


def test_dual_account_isolation_each_transcript_view_shows_only_its_own_session(start_app):
    started = start_chain_app(start_app)
    app = started["app"]
    try:
        a, b = started["accounts"]
        started["upload"](a, 1)
        started["upload"](b, 2)

        summary = started["drain"]()
        assert summary == {"done": 2, "failed": 0}

        a_view = started["transcriptOf"](a)
        b_view = started["transcriptOf"](b)
        # A's view belongs to A's session/source, not B's.
        assert a_view["sessionId"] == a["session"]["id"]
        assert a_view["sourceId"] == a["session"]["sourceId"]
        assert [{"startMs": r["startMs"], "text": r["text"]} for r in a_view["records"]] == [
            {"startMs": 30000, "text": "stub 转写文本（第 1 段）"}
        ]
        assert b_view["sessionId"] == b["session"]["id"]
        assert b_view["sourceId"] == b["session"]["sourceId"]
        assert [{"startMs": r["startMs"], "text": r["text"]} for r in b_view["records"]] == [
            {"startMs": 60000, "text": "stub 转写文本（第 2 段）"}
        ]
    finally:
        app.close()
