"""POST /v1/worker/tasks/claim + POST /v1/worker/tasks/{id}/result — the
round-2 worker contract (Ticket 4.3 / Node ticket 2.3, issue #66;
contract-r2.md §3.7, decisions D13/D14/D15). Python port of
test/worker-tasks.test.js.

Seams (pre-agreed in the ticket):
- the /v1 HTTP endpoints asserted against contracts/fixtures
  (audio-task-examples.json, error-examples.json);
- the worker service credential is a statically configured bearer token
  (config.worker_token) — implementation decision recorded in the ticket;
  empty config means every worker request is 401;
- outcome assertions read the public GET /v1/sessions/{id}/transcript view
  plus the task queue this module owns; the only store reads are the audio
  file paths (D14 deletion is unobservable via the API by design) and the
  task queue's own status.

Upload-side behavior lives in test_audio_segments_upload.py; the
end-to-end chain lives in test_audio_chain.py.
"""

import os

from helpers import (
    audio_example,
    auth_header,
    create_session_for,
    error_example,
    make_audio_dir,
    open_account_with_id,
)

EMAIL = "worker-chain@example.com"
WORKER_TOKEN = "worker-service-token-01"

SEGMENT_BODIES = {
    1: audio_example("api-audio-segment-upload")["request"]["body"],
    2: audio_example("api-audio-segment-upload-second")["request"]["body"],
    3: audio_example("api-audio-segment-out-of-order")["request"]["body"],
}


def start_worker_app(start_app):
    """One app instance with a worker credential, an invited account, and
    an active session (public flow)."""
    app = start_app(
        seed_emails=[EMAIL],
        config={"audio_dir": make_audio_dir(), "worker_token": WORKER_TOKEN},
    )
    account = open_account_with_id(app, EMAIL)
    sessioned = create_session_for(app, account["token"], "worker")
    session_id = sessioned["session"]["id"]

    def claim(body):
        return app.request(
            "POST",
            "/v1/worker/tasks/claim",
            headers=auth_header(WORKER_TOKEN),
            body=body,
        )

    def upload(segment_index):
        return app.request(
            "POST",
            f"/v1/sessions/{session_id}/audio-segments",
            headers=auth_header(account["token"]),
            body=SEGMENT_BODIES[segment_index],
        )

    def get_transcript():
        return app.request(
            "GET",
            f"/v1/sessions/{session_id}/transcript",
            headers=auth_header(account["token"]),
        )

    def submit_result(task_id, body):
        return app.request(
            "POST",
            f"/v1/worker/tasks/{task_id}/result",
            headers=auth_header(WORKER_TOKEN),
            body=body,
        )

    return {
        "app": app,
        "store": app.store,
        "token": account["token"],
        "accountId": account["accountId"],
        "sessionId": session_id,
        "claim": claim,
        "upload": upload,
        "getTranscript": get_transcript,
        "submitResult": submit_result,
    }


def claim_one(started, index):
    """Upload segment `index`, claim it, and return the claimed task so a
    test can write a result against the real taskId."""
    started["upload"](index)
    response = started["claim"]({"limit": 1})
    return response.json["tasks"][0]


def test_worker_claim_missing_user_and_wrong_credentials_all_answer_the_fixture_401(start_app):
    started = start_worker_app(start_app)
    app = started["app"]
    token = started["token"]
    try:
        missing = app.request("POST", "/v1/worker/tasks/claim", body={"limit": 1})
        assert missing.status == 401
        assert missing.json == error_example("error-worker-claim-unauthorized")["response"]["body"]

        # A valid user credential is still not a worker credential.
        user = app.request(
            "POST",
            "/v1/worker/tasks/claim",
            headers=auth_header(token),
            body={"limit": 1},
        )
        assert user.status == 401
        assert user.json == error_example("error-worker-claim-unauthorized")["response"]["body"]

        wrong = app.request(
            "POST",
            "/v1/worker/tasks/claim",
            headers=auth_header("not-the-worker-token"),
            body={"limit": 1},
        )
        assert wrong.status == 401
        assert wrong.json == error_example("error-worker-claim-unauthorized")["response"]["body"]
    finally:
        app.close()


def test_worker_claim_no_pending_tasks_answers_the_empty_state(start_app):
    started = start_worker_app(start_app)
    try:
        response = started["claim"]({"limit": 3})
        assert response.status == 200
        assert response.json == {"tasks": []}
    finally:
        started["app"].close()


def test_worker_claim_claims_one_pending_task_with_inline_audio_and_moves_it_to_transcribing(start_app):
    started = start_worker_app(start_app)
    try:
        started["upload"](1)

        response = started["claim"]({"limit": 1})
        assert response.status == 200

        task = response.json["tasks"][0]
        # Exactly the eight contract fields (contract-r2 §3.7 Task shape).
        assert sorted(task.keys()) == sorted(
            [
                "audioBase64",
                "audioMimeType",
                "endMs",
                "segmentIndex",
                "sessionId",
                "sourceId",
                "startMs",
                "taskId",
            ]
        )
        assert task["segmentIndex"] == 1
        assert task["startMs"] == 30000
        assert task["endMs"] == 60000
        assert task["audioMimeType"] == "audio/webm;codecs=opus"
        assert task["audioBase64"] == SEGMENT_BODIES[1]["audioBase64"]
        assert task["sessionId"] == started["sessionId"]
        assert len(task["sourceId"]) > 0
        assert len(task["taskId"]) > 0

        # Claim is a transition: the claimed task is no longer pending, and
        # the transcript view projects it as "transcribing" in pending[] (§2.5).
        again = started["claim"]({"limit": 1})
        assert again.json == {"tasks": []}

        view = started["getTranscript"]().json
        assert view["pending"] == [
            {"segmentIndex": 1, "startMs": 30000, "endMs": 60000, "status": "transcribing"}
        ]
        assert view["failed"] == []
        assert view["records"] == []
    finally:
        started["app"].close()


def test_worker_claim_claims_in_segment_index_ascending_order(start_app):
    started = start_worker_app(start_app)
    try:
        # Upload out of order: 3, then 1, then 2.
        started["upload"](3)
        started["upload"](1)
        started["upload"](2)

        response = started["claim"]({"limit": 3})
        assert response.status == 200
        assert [task["segmentIndex"] for task in response.json["tasks"]] == [1, 2, 3]
        # Each task carries its own audio.
        assert response.json["tasks"][0]["audioBase64"] == SEGMENT_BODIES[1]["audioBase64"]
        assert response.json["tasks"][1]["audioBase64"] == SEGMENT_BODIES[2]["audioBase64"]
        assert response.json["tasks"][2]["audioBase64"] == SEGMENT_BODIES[3]["audioBase64"]
    finally:
        started["app"].close()


def test_worker_claim_limit_defaults_to_1_must_be_positive_integer_and_caps_at_10(start_app):
    started = start_worker_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        started["upload"](1)
        started["upload"](2)

        # Default (no body): limit 1.
        default_claim = started["claim"](None)
        assert default_claim.status == 200
        assert len(default_claim.json["tasks"]) == 1
        assert default_claim.json["tasks"][0]["segmentIndex"] == 1

        # Non-positive / non-integer limits are 400.
        for bad_limit in [0, -1, 1.5, "3"]:
            bad = started["claim"]({"limit": bad_limit})
            assert bad.status == 400, f"limit {bad_limit!r}"
            assert bad.json["error"]["code"] == "validation_failed", f"limit {bad_limit!r}"

        # Server cap: 11 pending tasks, limit 99 -> at most 10.
        for index in range(3, 12):
            response = app.request(
                "POST",
                f"/v1/sessions/{session_id}/audio-segments",
                headers=auth_header(token),
                body={
                    "segmentIndex": index,
                    "startMs": (index - 1) * 30000,
                    "durationMs": 30000,
                    "audioMimeType": "audio/webm;codecs=opus",
                    "audioBase64": f"c2VnbWVudF8={index}".replace("=", "") + "=",
                },
            )
            assert response.status == 201, f"upload segment {index}"
        capped = started["claim"]({"limit": 99})
        assert capped.status == 200
        assert len(capped.json["tasks"]) == 10
    finally:
        app.close()


# --- result endpoint ----------------------------------------------------------


def test_worker_result_done_lands_asr_records_and_deletes_the_audio(start_app):
    started = start_worker_app(start_app)
    store = started["store"]
    try:
        task = claim_one(started, 1)

        # The audio file observation point: D14 deletion is unobservable
        # through the API by design, so tests read the temp file system.
        stored = store.get("transcriptionTasks", task["taskId"])
        assert os.path.exists(stored["audioFile"])

        done = audio_example("worker-task-result-done")
        response = started["submitResult"](
            task["taskId"],
            {
                "status": "done",
                "records": [
                    {
                        "startMs": 30000,
                        "endMs": 60000,
                        "text": "注意力分数的计算，就是把查询向量和键向量做点积",
                    }
                ],
            },
        )
        assert response.status == 200
        # Same shape as the fixture; the taskId is server-generated (opaque).
        assert response.json == {"taskId": task["taskId"], "status": done["response"]["body"]["status"]}

        # The public transcript view now carries the record; nothing is
        # pending or failed.
        view = started["getTranscript"]().json
        assert [
            {"startMs": r["startMs"], "endMs": r["endMs"], "text": r["text"], "origin": r["origin"]}
            for r in view["records"]
        ] == [
            {
                "startMs": 30000,
                "endMs": 60000,
                "text": "注意力分数的计算，就是把查询向量和键向量做点积",
                "origin": "asr",
            }
        ]
        assert view["pending"] == []
        assert view["failed"] == []

        # D14: done deletes the audio immediately; the task is terminal.
        assert not os.path.exists(stored["audioFile"])
        assert store.get("transcriptionTasks", task["taskId"])["status"] == "done"
    finally:
        started["app"].close()


def test_worker_result_silence_is_still_done_writes_no_records_deletes_audio(start_app):
    started = start_worker_app(start_app)
    store = started["store"]
    try:
        task = claim_one(started, 2)
        stored = store.get("transcriptionTasks", task["taskId"])

        response = started["submitResult"](task["taskId"], {"status": "done", "records": []})
        assert response.status == 200
        assert response.json == {"taskId": task["taskId"], "status": "done"}

        view = started["getTranscript"]().json
        assert view["records"] == []
        assert view["pending"] == []
        assert view["failed"] == []
        assert not os.path.exists(stored["audioFile"])
        assert store.get("transcriptionTasks", task["taskId"])["status"] == "done"
    finally:
        started["app"].close()


def test_worker_result_failed_keeps_audio_and_surfaces_error_in_view(start_app):
    started = start_worker_app(start_app)
    store = started["store"]
    try:
        task = claim_one(started, 3)
        stored = store.get("transcriptionTasks", task["taskId"])

        failed = audio_example("worker-task-result-failed")
        response = started["submitResult"](
            task["taskId"],
            {
                "status": "failed",
                "error": {"code": "transcription_failed", "message": "Speech Provider 返回 429，重试后仍失败"},
            },
        )
        assert response.status == 200
        assert response.json == {
            "taskId": task["taskId"],
            "status": failed["response"]["body"]["status"],
        }

        # The public view's failed[] carries the error verbatim; no records.
        view = started["getTranscript"]().json
        assert view["failed"] == [
            {
                "segmentIndex": 3,
                "startMs": 90000,
                "endMs": 120000,
                "error": {
                    "code": "transcription_failed",
                    "message": "Speech Provider 返回 429，重试后仍失败",
                },
            }
        ]
        assert view["records"] == []

        # D14: failed audio is retained for session-end + grace cleanup.
        assert os.path.exists(stored["audioFile"])
        assert store.get("transcriptionTasks", task["taskId"])["status"] == "failed"
    finally:
        started["app"].close()


def test_worker_result_unknown_task_404_and_result_needs_worker_credential(start_app):
    started = start_worker_app(start_app)
    app, token = started["app"], started["token"]
    try:
        unknown = started["submitResult"](
            "tsk_unknown_task",
            {"status": "failed", "error": {"code": "transcription_failed", "message": "x"}},
        )
        assert unknown.status == 404
        assert unknown.json == error_example("error-worker-result-unknown-task")["response"]["body"]

        # Missing/wrong/user credentials are the same 401 as claim.
        missing = app.request(
            "POST",
            "/v1/worker/tasks/tsk_x/result",
            body={"status": "done", "records": []},
        )
        assert missing.status == 401
        assert missing.json == error_example("error-worker-claim-unauthorized")["response"]["body"]

        user = app.request(
            "POST",
            "/v1/worker/tasks/tsk_x/result",
            headers=auth_header(token),
            body={"status": "done", "records": []},
        )
        assert user.status == 401
        assert user.json == error_example("error-worker-claim-unauthorized")["response"]["body"]
    finally:
        app.close()


def test_worker_result_resends_replay_the_first_stored_result_and_never_reapply(start_app):
    started = start_worker_app(start_app)
    try:
        task = claim_one(started, 1)
        first = started["submitResult"](
            task["taskId"],
            {"status": "done", "records": [{"startMs": 30000, "endMs": 60000, "text": "首存文本"}]},
        )
        assert first.status == 200

        # Same taskId, different body: still a 200 replay of the first
        # result, and the view keeps exactly one record.
        resend = started["submitResult"](
            task["taskId"],
            {"status": "done", "records": [{"startMs": 0, "endMs": 1, "text": "重发不应入库"}]},
        )
        assert resend.status == 200
        assert resend.json == {"taskId": task["taskId"], "status": "done"}
        view = started["getTranscript"]().json
        assert [r["text"] for r in view["records"]] == ["首存文本"]
    finally:
        started["app"].close()


def test_worker_result_terminal_states_never_roll_back(start_app):
    started = start_worker_app(start_app)
    store = started["store"]
    try:
        task = claim_one(started, 1)
        started["submitResult"](
            task["taskId"],
            {"status": "done", "records": [{"startMs": 30000, "endMs": 60000, "text": "终态文本"}]},
        )

        late_failed = started["submitResult"](
            task["taskId"],
            {
                "status": "failed",
                "error": {"code": "transcription_failed", "message": "迟到的失败不应改写终态"},
            },
        )
        assert late_failed.status == 200
        assert late_failed.json == {"taskId": task["taskId"], "status": "done"}
        assert store.get("transcriptionTasks", task["taskId"])["status"] == "done"
        view = started["getTranscript"]().json
        assert [r["text"] for r in view["records"]] == ["终态文本"]
        assert view["failed"] == []

        # And a failed task cannot become done afterwards.
        failed_task = claim_one(started, 2)
        started["submitResult"](
            failed_task["taskId"],
            {"status": "failed", "error": {"code": "transcription_failed", "message": "先失败"}},
        )
        late_done = started["submitResult"](
            failed_task["taskId"],
            {"status": "done", "records": [{"startMs": 0, "endMs": 1, "text": "迟到的成功"}]},
        )
        assert late_done.json == {"taskId": failed_task["taskId"], "status": "failed"}
        assert store.get("transcriptionTasks", failed_task["taskId"])["status"] == "failed"
        view = started["getTranscript"]().json
        assert [r["text"] for r in view["records"]] == ["终态文本"]
        assert len(view["failed"]) == 1
    finally:
        started["app"].close()


def test_worker_result_against_a_not_yet_claimed_pending_task_is_rejected(start_app):
    started = start_worker_app(start_app)
    store = started["store"]
    try:
        started["upload"](1)
        task = store.list("transcriptionTasks")[0]
        assert task["status"] == "pending"

        response = started["submitResult"](
            task["taskId"],
            {"status": "done", "records": [{"startMs": 0, "endMs": 1, "text": "未领取就回写"}]},
        )
        # Discretion (pinned here): the state machine is pending ->
        # transcribing -> done|failed; writing a result skips no steps.
        assert response.status == 400
        assert response.json["error"]["code"] == "validation_failed"
        assert store.get("transcriptionTasks", task["taskId"])["status"] == "pending"
        view = started["getTranscript"]().json
        assert view["records"] == []
        assert view["failed"] == []
    finally:
        started["app"].close()


def test_worker_result_malformed_bodies_are_400_validation_failed(start_app):
    started = start_worker_app(start_app)
    store = started["store"]
    try:
        task = claim_one(started, 1)
        cases = [
            {"status": "unknown"},
            {"status": "done"},  # records missing
            {"status": "done", "records": "not-an-array"},
            {"status": "done", "records": [{"startMs": 0, "endMs": 1}]},  # text missing
            {"status": "done", "records": [{"startMs": -1, "endMs": 1, "text": "x"}]},
            {"status": "done", "records": [{"startMs": 5, "endMs": 1, "text": "x"}]},  # end < start
            {"status": "failed"},  # error missing
            {"status": "failed", "error": {"code": "other_code", "message": "x"}},
            {"status": "failed", "error": {"code": "transcription_failed"}},  # message missing
        ]
        for i, body in enumerate(cases):
            response = started["submitResult"](task["taskId"], body)
            assert response.status == 400, f"case {i} {body}"
            assert response.json["error"]["code"] == "validation_failed", f"case {i}"
        # The task survives malformed resends still transcribing.
        assert store.get("transcriptionTasks", task["taskId"])["status"] == "transcribing"
    finally:
        started["app"].close()
