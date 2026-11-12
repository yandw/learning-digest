"""POST /v1/sessions/{id}/audio-segments — round-2 audio upload (Ticket 4.3
/ Node ticket 2.3, issue #66; contract-r2.md §3.4, decisions D11/D14/D15).
Python port of test/audio-segments-upload.test.js.

Seams (pre-agreed in the ticket):
- the /v1 HTTP endpoints asserted against contracts/fixtures as the shared
  samples (audio-task-examples.json, error-examples.json);
- Sessions come from the public flow (favorite -> session), and the
  transcript STATE behind the endpoint is read back through the
  TranscriptView shape via app/transcripts.py primitives where needed.

This file covers the upload endpoint's own behavior. The worker claim /
result endpoints live in test_worker_tasks.py; the end-to-end chain lives
in test_audio_chain.py.
"""

import base64
import os

from app.transcripts import load_state
from helpers import (
    audio_example,
    auth_header,
    create_session_for,
    error_example,
    make_audio_dir,
    open_account_with_id,
)

EMAIL = "audio-uploader@example.com"
OTHER_EMAIL = "other-uploader@example.com"


def start_sessioned_app(start_app):
    """One app instance with two invited accounts, one active Session per
    account (public flow). Returns the harness plus ids."""
    app = start_app(seed_emails=[EMAIL, OTHER_EMAIL], config={"audio_dir": make_audio_dir()})
    account = open_account_with_id(app, EMAIL)
    sessioned = create_session_for(app, account["token"], "upload")
    other = open_account_with_id(app, OTHER_EMAIL)
    return {
        "app": app,
        "store": app.store,
        "token": account["token"],
        "accountId": account["accountId"],
        "sessionId": sessioned["session"]["id"],
        "otherToken": other["token"],
    }


def post_segment(app, token, session_id, overrides=None):
    """Post one segment with the fixture body, override selected fields."""
    base = audio_example("api-audio-segment-upload")["request"]["body"]
    return app.request(
        "POST",
        f"/v1/sessions/{session_id}/audio-segments",
        headers=auth_header(token),
        body={**base, **(overrides or {})},
    )


def test_first_segment_answers_201_with_the_pending_segment_per_fixture(start_app):
    started = start_sessioned_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        sample = audio_example("api-audio-segment-upload")
        response = post_segment(app, token, session_id)
        assert response.status == 201
        # The fixture segment is the whole body: exactly the five contract
        # fields, no server-side extras.
        assert response.json["segment"] == sample["response"]["body"]["segment"]
    finally:
        app.close()


def test_invalid_segment_index_answers_the_fixture_400_body(start_app):
    started = start_sessioned_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        response = post_segment(app, token, session_id, {"segmentIndex": -1})
        assert response.status == 400
        assert response.json == error_example("error-audio-segment-invalid-index")["response"]["body"]
    finally:
        app.close()


def test_audio_above_the_10mb_encoded_cap_answers_the_fixture_400_body(start_app):
    started = start_sessioned_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        # Just over the 10MB encoded limit (contract-r2 §3.4).
        oversized = "A" * (10 * 1024 * 1024 + 1)
        response = post_segment(app, token, session_id, {"audioBase64": oversized})
        assert response.status == 400
        assert response.json == error_example("error-audio-segment-too-large")["response"]["body"]
    finally:
        app.close()


def test_out_of_range_metadata_is_400(start_app):
    started = start_sessioned_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        cases = [
            {"durationMs": 4999},  # below the [5000, 60000] window
            {"durationMs": 60001},  # above the window
            {"startMs": -1},
            {"audioMimeType": "text/plain"},
            {"audioBase64": "not base64!!!"},
        ]
        for overrides in cases:
            response = post_segment(app, token, session_id, overrides)
            assert response.status == 400, f"case {overrides}"
            assert response.json["error"]["code"] == "validation_failed", f"case {overrides}"
    finally:
        app.close()


def test_unknown_and_cross_account_sessions_are_the_same_404(start_app):
    started = start_sessioned_app(start_app)
    app = started["app"]
    token, other_token, session_id = started["token"], started["otherToken"], started["sessionId"]
    try:
        unknown = post_segment(app, token, "ses_unknown")
        assert unknown.status == 404
        assert unknown.json == error_example("error-cross-account-session-transcript")["response"]["body"]

        # The second account cannot upload into the first account's session.
        cross_account = post_segment(app, other_token, session_id)
        assert cross_account.status == 404
        assert cross_account.json == error_example("error-cross-account-session-transcript")["response"]["body"]
    finally:
        app.close()


def test_new_segment_on_a_finished_session_is_409_session_already_finished(start_app):
    started = start_sessioned_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        finished = app.request(
            "POST",
            f"/v1/sessions/{session_id}/finish",
            headers=auth_header(token),
            body={},
        )
        assert finished.status == 200

        response = post_segment(app, token, session_id)
        assert response.status == 409
        assert response.json == error_example("error-audio-segment-after-finish")["response"]["body"]
    finally:
        app.close()


def test_audio_into_a_captions_locked_session_is_409_transcript_origin_conflict(start_app):
    started = start_sessioned_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        # Lock the other direction first (captions direct archive).
        captions = app.request(
            "POST",
            f"/v1/sessions/{session_id}/captions",
            headers=auth_header(token),
            body={"segments": [{"startMs": 0, "endMs": 1000, "text": "字幕文本"}]},
        )
        assert captions.status == 201

        response = post_segment(app, token, session_id)
        assert response.status == 409
        assert response.json == {
            "error": {
                "code": "transcript_origin_conflict",
                "message": "本次学习已按字幕归档，同一区间只采用一种方式",
            }
        }
    finally:
        app.close()


def test_byte_level_replay_answers_200_with_the_stored_segment_no_second_task(start_app):
    started = start_sessioned_app(start_app)
    app, store = started["app"], started["store"]
    token, session_id = started["token"], started["sessionId"]
    try:
        first = post_segment(app, token, session_id)
        assert first.status == 201

        replay = audio_example("api-audio-segment-duplicate-idempotent")
        second = post_segment(app, token, session_id)
        assert second.status == 200
        assert second.json["segment"] == replay["response"]["body"]["segment"]

        # First store wins: exactly one task enqueued for the segment.
        assert store.count("transcriptionTasks") == 1
    finally:
        app.close()


def test_crash_window_self_heal_stored_segment_with_lost_task_reenqueues_on_resend(start_app):
    started = start_sessioned_app(start_app)
    app, store = started["app"], started["store"]
    token, session_id = started["token"], started["sessionId"]
    try:
        first = post_segment(app, token, session_id)
        assert first.status == 201

        # Simulate the crash window between storing the segment and
        # enqueueing its task: drop the task row, keep the stored segment.
        # (Round-2 review fix: before the self-heal, every resend replayed
        # 200 while the segment stayed pending forever.)
        lost_task = store.list("transcriptionTasks")[0]
        assert lost_task, "the first upload must have enqueued exactly one task"
        store.delete("transcriptionTasks", lost_task["taskId"])
        assert store.count("transcriptionTasks") == 0

        # The resend hits the idempotent path (segment already stored) but
        # finds no task: it self-heals by re-enqueueing one.
        resend = post_segment(app, token, session_id)
        assert resend.status == 200
        assert (
            resend.json["segment"]
            == audio_example("api-audio-segment-duplicate-idempotent")["response"]["body"]["segment"]
        )

        healed = store.list("transcriptionTasks")
        assert len(healed) == 1
        assert healed[0]["sessionId"] == session_id
        assert healed[0]["segmentIndex"] == 1
        assert healed[0]["status"] == "pending"
        assert healed[0]["taskId"] != lost_task["taskId"]
        assert healed[0]["audioFile"], "the healed task carries a rebuilt audio file"

        # A further resend with the task present stays a plain replay: still
        # exactly one task (no duplicate enqueue).
        replay = post_segment(app, token, session_id)
        assert replay.status == 200
        assert store.count("transcriptionTasks") == 1
    finally:
        app.close()


def test_replay_with_different_bytes_still_answers_the_first_stored_segment(start_app):
    started = start_sessioned_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        post_segment(app, token, session_id)
        second = post_segment(
            app,
            token,
            session_id,
            {"audioBase64": "U29tZV9kaWZmZXJlbnRfYnl0ZXM=", "durationMs": 30000},
        )
        # Same (sessionId, segmentIndex): first store wins, body is not compared.
        assert second.status == 200
        assert second.json["segment"]["segmentIndex"] == 1
        assert (
            second.json["segment"]
            == audio_example("api-audio-segment-upload")["response"]["body"]["segment"]
        )
    finally:
        app.close()


def test_out_of_order_segments_are_accepted_and_placed_by_segment_index(start_app):
    started = start_sessioned_app(start_app)
    app, token, session_id = started["app"], started["token"], started["sessionId"]
    try:
        # Segment 1 first (fixture upload), then 3 before 2, then 2.
        first = post_segment(app, token, session_id)
        out_of_order = audio_example("api-audio-segment-out-of-order")
        third = post_segment(app, token, session_id, out_of_order["request"]["body"])
        second = audio_example("api-audio-segment-upload-second")
        second_response = post_segment(app, token, session_id, second["request"]["body"])

        assert first.status == 201
        assert third.status == 201
        assert third.json["segment"] == out_of_order["response"]["body"]["segment"]
        assert second_response.status == 201
        assert second_response.json["segment"] == second["response"]["body"]["segment"]
    finally:
        app.close()


def test_audio_bytes_land_in_the_temp_audio_dir(start_app):
    audio_dir = make_audio_dir()
    app = start_app(seed_emails=[EMAIL], config={"audio_dir": audio_dir})
    try:
        account = open_account_with_id(app, EMAIL)
        sessioned = create_session_for(app, account["token"], "audio-file")

        response = post_segment(app, account["token"], sessioned["session"]["id"])
        assert response.status == 201

        task = app.store.list("transcriptionTasks")[0]
        assert not task["audioFile"].startswith(os.getcwd()), "audio path must not live in the repo"
        assert task["audioFile"].startswith(audio_dir)
        assert os.path.exists(task["audioFile"])
        with open(task["audioFile"], "rb") as fh:
            decoded = base64.b64encode(fh.read()).decode("ascii")
        assert (
            decoded
            == audio_example("api-audio-segment-upload")["request"]["body"]["audioBase64"]
        )
    finally:
        app.close()


def test_first_audio_segment_locks_the_session_origin_to_asr(start_app):
    started = start_sessioned_app(start_app)
    app, store = started["app"], started["store"]
    token, session_id = started["token"], started["sessionId"]
    try:
        post_segment(app, token, session_id)
        # The transcript state's projection is the transcripts domain's;
        # read it through the shared serializer's source (load_state).
        assert store.get("sessions", session_id)["origin"] == "asr"
        state = load_state(store, session_id)
        assert list(state["segments"].keys()) == ["1"]
        segment = state["segments"]["1"]
        assert segment["status"] == "pending"
        assert segment["startMs"] == 30000
        assert segment["endMs"] == 60000
        assert segment["audioMimeType"] == "audio/webm;codecs=opus"
    finally:
        app.close()
