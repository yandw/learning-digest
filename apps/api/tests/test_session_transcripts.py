"""Captions direct archive + transcript view (Ticket 4.3 / Node ticket 2.2,
issue #65; contract-r2.md §3.3, §2.5; decisions D15). Python port of
test/session-transcripts.test.js.

Seam: the /v1 HTTP endpoints against the round-2 fixtures, plus the
app/transcripts.py write seam that the audio/worker endpoints call
(claim_audio_origin) — both sides of the D15 origin lock are also
exercised over HTTP in test_audio_segments_upload.py once the upload route
lands in this same ticket.

D15 semantics pinned here: captions archive as-read (no server-side gap
inference), first submission locks origin "captions", a resend answers 200
with the stored content (首存为准, never overwritten or appended), the
reverse submission after an asr lock is 409 transcript_origin_conflict
(both directions), and a finished session accepts no captions at all.
"""

import pytest

from app.errors import ApiError
from app.transcripts import (
    apply_segment_done,
    apply_segment_failed,
    apply_segment_transcribing,
    claim_audio_origin,
    upsert_audio_segment,
)
from helpers import (
    auth_header,
    create_fixture_source as _create_fixture_source,
    error_example,
    open_account,
    open_session,
    session_example,
)

LEARNER = "learner@example.com"
OWNER = "owner@example.com"
OTHER = "other@example.com"


def create_fixture_source(app, token):
    """The session-transcripts fixture favorite carries its display title."""
    return _create_fixture_source(app, token, title="注意力机制详解 P2：自注意力")


def seed_asr_transcript(store, session, view):
    """The asr-path fixture precondition (audio segments + worker results on
    ses_0033/0032) through the write seam, seeded from the fixture sample's
    own values — the same seeding discipline as the P4 tests. Every
    assertion below still goes through HTTP."""
    claim_audio_origin(store=store, session=session)
    projections = [*view["failed"], *view["pending"]]
    claimed = {p["segmentIndex"] for p in projections}

    # Done segments take the lowest indexes the failed/pending projections
    # do not claim: a done segment's index is not observable in the view
    # (only failed[] and pending[] carry one), so any unclaimed index yields
    # the same TranscriptView.
    counter = {"next": 0}

    def next_done_segment_index():
        while counter["next"] in claimed:
            counter["next"] += 1
        index = counter["next"]
        counter["next"] += 1
        return index

    for record in view["records"]:
        segment_index = next_done_segment_index()
        upsert_audio_segment(
            store=store,
            session_id=session["id"],
            segment={
                "segmentIndex": segment_index,
                "startMs": record["startMs"],
                "endMs": record["endMs"],
                "audioMimeType": "audio/webm;codecs=opus",
            },
        )
        apply_segment_done(
            store=store, session_id=session["id"], segment_index=segment_index, records=[record]
        )
    for failed in view["failed"]:
        upsert_audio_segment(
            store=store,
            session_id=session["id"],
            segment={
                "segmentIndex": failed["segmentIndex"],
                "startMs": failed["startMs"],
                "endMs": failed["endMs"],
                "audioMimeType": "audio/webm;codecs=opus",
            },
        )
        apply_segment_failed(
            store=store,
            session_id=session["id"],
            segment_index=failed["segmentIndex"],
            error=failed["error"],
        )
    for pending in view["pending"]:
        upsert_audio_segment(
            store=store,
            session_id=session["id"],
            segment={
                "segmentIndex": pending["segmentIndex"],
                "startMs": pending["startMs"],
                "endMs": pending["endMs"],
                "audioMimeType": "audio/webm;codecs=opus",
            },
        )
        apply_segment_transcribing(
            store=store, session_id=session["id"], segment_index=pending["segmentIndex"]
        )


def test_captions_archives_as_read_and_locks_origin(start_app):
    example = session_example("api-session-captions-archive")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]
    session = open_session(app, token, source["id"], clock)

    response = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    assert response.json == {
        "transcript": {
            **example["response"]["body"]["transcript"],
            "sessionId": session["id"],
            "sourceId": source["id"],
            "resourceId": resource["id"],
        }
    }

    # The first archive locked the session's path (D15): the Session now
    # reports origin "captions".
    assert response.json["transcript"]["origin"] == "captions"
    me = app.request("GET", "/v1/me", headers=auth_header(token))
    assert me.status == 200


def test_captions_resend_answers_200_with_the_stored_archive(start_app):
    archive = session_example("api-session-captions-archive")
    resend = session_example("api-session-captions-resend-idempotent")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]
    session = open_session(app, token, source["id"], clock)

    first = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body=archive["request"]["body"],
    )
    assert first.status == 201

    # The byte-identical resend (network drop retry) answers 200 with the
    # same archived transcript.
    again = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body=resend["request"]["body"],
    )
    assert again.status == resend["response"]["status"]
    assert again.json == {
        "transcript": {
            **resend["response"]["body"]["transcript"],
            "sessionId": session["id"],
            "sourceId": source["id"],
            "resourceId": resource["id"],
        }
    }

    # 首存为准: even a resend with DIFFERENT segments answers with the
    # stored archive — never overwritten, never appended.
    different = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body={"segments": [{"startMs": 0, "endMs": 1000, "text": "不应落库的字幕"}]},
    )
    assert different.status == 200
    assert different.json["transcript"]["records"] == first.json["transcript"]["records"], (
        "the first submission stays the archive"
    )
    assert len(different.json["transcript"]["records"]) == 2


def test_captions_on_an_asr_locked_session_is_409_transcript_origin_conflict(start_app):
    example = error_example("error-transcript-origin-conflict")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    source = created["source"]
    session = open_session(app, token, source["id"])

    # The fixture precondition (ses_0033 already locked asr by its audio
    # segments) via the audio-side write seam.
    claim_audio_origin(store=app.store, session=app.store.get("sessions", session["id"]))
    assert app.store.get("sessions", session["id"])["origin"] == "asr"

    response = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]

    # The rejected captions did not touch the archive: the session's origin
    # stays asr and no transcript document appeared.
    assert app.store.get("sessions", session["id"])["origin"] == "asr"


def test_claiming_asr_on_a_captions_locked_session_is_the_same_409(start_app):
    conflict = error_example("error-transcript-origin-conflict")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    source = created["source"]
    session = open_session(app, token, source["id"])

    archived = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body=session_example("api-session-captions-archive")["request"]["body"],
    )
    assert archived.status == 201

    # The audio path's first segment calls claim_audio_origin; on a
    # captions-locked session that is the same 409 code (mirror message).
    with pytest.raises(ApiError) as exc_info:
        claim_audio_origin(store=app.store, session=app.store.get("sessions", session["id"]))
    assert exc_info.value.status == conflict["response"]["status"]
    assert exc_info.value.code == "transcript_origin_conflict"


def test_captions_on_a_finished_session_is_409_session_already_finished(start_app):
    already_finished = error_example("error-session-finish-already-finished")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    source = created["source"]
    session = open_session(app, token, source["id"], clock)

    finished = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/finish",
        headers=auth_header(token),
        body={},
    )
    assert finished.status == 200

    # 已结束不再接收 (§3.3): even a resend of valid segments is the 409.
    response = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body=session_example("api-session-captions-archive")["request"]["body"],
    )
    assert response.status == already_finished["response"]["status"]
    assert response.json == already_finished["response"]["body"]


def test_invalid_caption_segments_are_validation_failed_400s(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    source = created["source"]
    session = open_session(app, token, source["id"])

    def post(body):
        return app.request(
            "POST",
            f"/v1/sessions/{session['id']}/captions",
            headers=auth_header(token),
            body=body,
        )

    cases = [
        ("missing segments", {}),
        ("segments not an array", {"segments": {"startMs": 0}}),
        ("segment item not an object", {"segments": [138000]}),
        ("missing startMs", {"segments": [{"endMs": 159000, "text": "x"}]}),
        ("missing endMs", {"segments": [{"startMs": 138000, "text": "x"}]}),
        ("missing text", {"segments": [{"startMs": 138000, "endMs": 159000}]}),
        ("empty text", {"segments": [{"startMs": 138000, "endMs": 159000, "text": ""}]}),
        ("non-string text", {"segments": [{"startMs": 138000, "endMs": 159000, "text": 3}]}),
        ("negative startMs", {"segments": [{"startMs": -1, "endMs": 159000, "text": "x"}]}),
        ("endMs below startMs", {"segments": [{"startMs": 159000, "endMs": 138000, "text": "x"}]}),
    ]
    for label, body in cases:
        response = post(body)
        assert response.status == 400, label
        assert response.json["error"]["code"] == "validation_failed", label

    # §2.2 records: endMs >= startMs — an exactly-zero-length caption
    # segment is legal per the contract, on a fresh session.
    second = open_session(app, token, source["id"])
    zero_length = app.request(
        "POST",
        f"/v1/sessions/{second['id']}/captions",
        headers=auth_header(token),
        body={"segments": [{"startMs": 138000, "endMs": 138000, "text": "零长段合法"}]},
    )
    assert zero_length.status == 201

    # A rejected first archive must not have locked the origin: an empty
    # segments array is still a legal first submission (原样归档) and
    # answers 201 with zero records.
    third = open_session(app, token, source["id"])
    empty_first = app.request(
        "POST",
        f"/v1/sessions/{third['id']}/captions",
        headers=auth_header(token),
        body={"segments": []},
    )
    assert empty_first.status == 201
    assert empty_first.json["transcript"]["records"] == []
    assert empty_first.json["transcript"]["origin"] == "captions"


def test_captions_on_another_accounts_session_is_the_404_and_401_without_credentials(start_app):
    cross_transcript = error_example("error-cross-account-session-transcript")
    unauthorized = error_example("error-session-create-unauthorized")
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    created = create_fixture_source(app, owner)
    source = created["source"]
    session = open_session(app, owner, source["id"])

    cross = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(other),
        body=session_example("api-session-captions-archive")["request"]["body"],
    )
    assert cross.status == cross_transcript["response"]["status"]
    assert cross.json == cross_transcript["response"]["body"]

    unknown = app.request(
        "POST",
        "/v1/sessions/ses_missing/captions",
        headers=auth_header(other),
        body={"segments": []},
    )
    assert unknown.status == 404
    assert unknown.json == cross_transcript["response"]["body"]

    no_auth = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        body={"segments": []},
    )
    assert no_auth.status == unauthorized["response"]["status"]
    assert no_auth.json == unauthorized["response"]["body"]


# --- GET /v1/sessions/{id}/transcript (contract-r2 §3.5) ----------------------


def test_transcript_captions_path_finished(start_app):
    archive = session_example("api-session-captions-archive")
    example = session_example("api-session-transcript-captions-finished")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]
    session = open_session(app, token, source["id"], clock)

    archived = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body=archive["request"]["body"],
    )
    assert archived.status == 201

    # The fixture session closes at 08:45 with the explicit skip range
    # 300000-360000; the caption hole (181000-300000) stays unmarked (D15).
    from helpers import parse_ms

    clock["ms"] = parse_ms("2026-11-10T08:45:00Z")
    finished = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/finish",
        headers=auth_header(token),
        body={
            "gaps": [
                {"startMs": gap["startMs"], "endMs": gap["endMs"]}
                for gap in example["response"]["body"]["gaps"]
            ]
        },
    )
    assert finished.status == 200

    response = app.request(
        "GET",
        f"/v1/sessions/{session['id']}/transcript",
        headers=auth_header(token),
    )
    assert response.status == example["response"]["status"]
    assert response.json == {
        **example["response"]["body"],
        "sessionId": session["id"],
        "sourceId": source["id"],
        "resourceId": resource["id"],
    }


def test_transcript_asr_path_active_with_pending_and_failed(start_app):
    example = session_example("api-session-transcript-asr-active")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]
    session = open_session(app, token, source["id"], clock)

    # Fixture precondition via the write seam (segments 0-3, two done,
    # one failed, one transcribing).
    seed_asr_transcript(app.store, app.store.get("sessions", session["id"]), example["response"]["body"])

    response = app.request(
        "GET",
        f"/v1/sessions/{session['id']}/transcript",
        headers=auth_header(token),
    )
    assert response.status == example["response"]["status"]
    assert response.json == {
        **example["response"]["body"],
        "sessionId": session["id"],
        "sourceId": source["id"],
        "resourceId": resource["id"],
    }


def test_transcript_asr_path_finished_with_gap_and_failed_terminal_states(start_app):
    example = session_example("api-session-transcript-asr-finished")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]

    from helpers import parse_ms

    clock["ms"] = parse_ms("2026-11-10T09:00:00Z")
    session = open_session(app, token, source["id"])
    seed_asr_transcript(app.store, app.store.get("sessions", session["id"]), example["response"]["body"])

    clock["ms"] = parse_ms("2026-11-10T09:45:00Z")
    finished = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/finish",
        headers=auth_header(token),
        body={
            "gaps": [
                {"startMs": gap["startMs"], "endMs": gap["endMs"]}
                for gap in example["response"]["body"]["gaps"]
            ]
        },
    )
    assert finished.status == 200
    # The asr lock from the seam is exactly the fixture's origin.
    assert finished.json["session"]["origin"] == "asr"

    response = app.request(
        "GET",
        f"/v1/sessions/{session['id']}/transcript",
        headers=auth_header(token),
    )
    assert response.status == example["response"]["status"]
    assert response.json == {
        **example["response"]["body"],
        "sessionId": session["id"],
        "sourceId": source["id"],
        "resourceId": resource["id"],
    }


def test_transcript_of_another_accounts_session_is_the_404_and_401_without_credentials(start_app):
    example = error_example("error-cross-account-session-transcript")
    unauthorized = error_example("error-session-create-unauthorized")
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    created = create_fixture_source(app, owner)
    source = created["source"]
    session = open_session(app, owner, source["id"])

    cross = app.request(
        "GET",
        f"/v1/sessions/{session['id']}/transcript",
        headers=auth_header(other),
    )
    assert cross.status == example["response"]["status"]
    assert cross.json == example["response"]["body"]

    unknown = app.request(
        "GET",
        "/v1/sessions/ses_missing/transcript",
        headers=auth_header(other),
    )
    assert unknown.status == 404
    assert unknown.json == example["response"]["body"]

    no_auth = app.request("GET", f"/v1/sessions/{session['id']}/transcript")
    assert no_auth.status == unauthorized["response"]["status"]
    assert no_auth.json == unauthorized["response"]["body"]


def test_transcript_reads_are_idempotent_and_states_are_monotonic_across_polls(start_app):
    example = session_example("api-session-transcript-asr-active")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    source = created["source"]
    session = open_session(app, token, source["id"])
    seed_asr_transcript(app.store, app.store.get("sessions", session["id"]), example["response"]["body"])

    def get():
        return app.request(
            "GET",
            f"/v1/sessions/{session['id']}/transcript",
            headers=auth_header(token),
        )

    first = get()
    assert first.status == 200
    second = get()
    assert second.json == first.json, "polling answers the same view"

    # done/failed are terminal: a repeated worker result must not revert
    # or duplicate anything.
    apply_segment_done(
        store=app.store,
        session_id=session["id"],
        segment_index=0,
        records=[{"startMs": 0, "endMs": 30000, "text": "不应重复落库"}],
    )
    after = get()
    assert after.json == first.json, "terminal states do not regress"


# --- GET /v1/resources/{id} sessions[] extension (contract-r2 §3.6) ----------


def test_resource_detail_lists_past_sessions_newest_first_with_transcript_summaries(start_app):
    captions_archive = session_example("api-session-captions-archive")
    captions_finished = session_example("api-session-transcript-captions-finished")
    asr_finished = session_example("api-session-transcript-asr-finished")
    asr_active = session_example("api-session-transcript-asr-active")
    example = session_example("api-resource-detail-with-sessions")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)

    from helpers import parse_ms

    # 08:00: the fixture Resource + Source, and ses_0031 (captions path).
    clock["ms"] = parse_ms("2026-11-10T08:00:00Z")
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]
    ses31 = open_session(app, token, source["id"])
    archived = app.request(
        "POST",
        f"/v1/sessions/{ses31['id']}/captions",
        headers=auth_header(token),
        body=captions_archive["request"]["body"],
    )
    assert archived.status == 201

    # 08:30: the fixture note.
    clock["ms"] = parse_ms("2026-11-10T08:30:00Z")
    note = app.request(
        "POST",
        f"/v1/resources/{resource['id']}/notes",
        headers=auth_header(token),
        body={
            "clientRequestId": "note-req-001",
            "text": example["response"]["body"]["notes"][0]["text"],
            "sourceId": source["id"],
            "positionMs": example["response"]["body"]["notes"][0]["positionMs"],
        },
    )
    assert note.status == 201

    # 08:45: close ses_0031 with its explicit skip range.
    clock["ms"] = parse_ms("2026-11-10T08:45:00Z")
    finish31 = app.request(
        "POST",
        f"/v1/sessions/{ses31['id']}/finish",
        headers=auth_header(token),
        body={
            "gaps": [
                {"startMs": gap["startMs"], "endMs": gap["endMs"]}
                for gap in captions_finished["response"]["body"]["gaps"]
            ]
        },
    )
    assert finish31.status == 200

    # 09:00-09:45: ses_0032 (asr, finished with gap + failed terminal).
    clock["ms"] = parse_ms("2026-11-10T09:00:00Z")
    ses32 = open_session(app, token, source["id"])
    seed_asr_transcript(app.store, app.store.get("sessions", ses32["id"]), asr_finished["response"]["body"])
    clock["ms"] = parse_ms("2026-11-10T09:45:00Z")
    finish32 = app.request(
        "POST",
        f"/v1/sessions/{ses32['id']}/finish",
        headers=auth_header(token),
        body={
            "gaps": [
                {"startMs": gap["startMs"], "endMs": gap["endMs"]}
                for gap in asr_finished["response"]["body"]["gaps"]
            ]
        },
    )
    assert finish32.status == 200

    # 10:00: ses_0033 (asr, active, pending + failed).
    clock["ms"] = parse_ms("2026-11-10T10:00:00Z")
    ses33 = open_session(app, token, source["id"])
    seed_asr_transcript(app.store, app.store.get("sessions", ses33["id"]), asr_active["response"]["body"])

    # The fixture detail's progress chain end state (P4 seeding discipline).
    app.store.set("progress", source["id"], {"positionMs": 250000, "revision": 2})

    response = app.request(
        "GET",
        f"/v1/resources/{resource['id']}",
        headers=auth_header(token),
    )
    assert response.status == example["response"]["status"]

    # The round-1 three-key shape is unchanged; each key matches the
    # fixture values modulo the live ids.
    assert response.json["resource"] == {
        **example["response"]["body"]["resource"],
        "id": resource["id"],
    }
    assert len(response.json["sources"]) == 1
    assert response.json["sources"][0] == {
        **example["response"]["body"]["sources"][0],
        "id": source["id"],
        "resourceId": resource["id"],
        "progress": {"positionMs": 250000, "revision": 2},
    }
    assert len(response.json["notes"]) == 1
    assert response.json["notes"][0]["createdAt"] == example["response"]["body"]["notes"][0]["createdAt"]
    assert response.json["notes"][0]["text"] == example["response"]["body"]["notes"][0]["text"]
    assert response.json["notes"][0]["positionMs"] == example["response"]["body"]["notes"][0]["positionMs"]

    # The extension: sessions[] newest first, each = Session + transcript
    # summary counts, fixture values verbatim modulo the live ids.
    live_ids = {
        example["response"]["body"]["sessions"][0]["id"]: ses33["id"],
        example["response"]["body"]["sessions"][1]["id"]: ses32["id"],
        example["response"]["body"]["sessions"][2]["id"]: ses31["id"],
    }
    assert response.json["sessions"] == [
        {
            **session,
            "id": live_ids[session["id"]],
            "sourceId": source["id"],
            "resourceId": resource["id"],
        }
        for session in example["response"]["body"]["sessions"]
    ]


def test_resource_with_no_sessions_answers_round1_shape_plus_empty_sessions_array(start_app):
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]

    response = app.request(
        "GET",
        f"/v1/resources/{resource['id']}",
        headers=auth_header(token),
    )
    assert response.status == 200
    assert response.json["resource"] == {
        "id": resource["id"],
        "title": "注意力机制详解 P2：自注意力",
        "kind": "video",
        "createdAt": "1970-01-01T00:00:00Z",
    }
    assert response.json["notes"] == []
    assert response.json["sessions"] == []


# --- multi-Session / multi-account isolation (user story 20) -----------------


def test_multiple_sessions_on_one_source_do_not_bleed_into_each_other(start_app):
    captions_archive = session_example("api-session-captions-archive")
    captions_finished = session_example("api-session-transcript-captions-finished")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]

    from helpers import parse_ms

    # Session A (08:00) archives captions and finishes with a gap;
    # session B (09:00) never receives any transcript submission.
    clock["ms"] = parse_ms("2026-11-10T08:00:00Z")
    session_a = open_session(app, token, source["id"])
    archived = app.request(
        "POST",
        f"/v1/sessions/{session_a['id']}/captions",
        headers=auth_header(token),
        body=captions_archive["request"]["body"],
    )
    assert archived.status == 201
    clock["ms"] = parse_ms("2026-11-10T08:45:00Z")
    finish_a = app.request(
        "POST",
        f"/v1/sessions/{session_a['id']}/finish",
        headers=auth_header(token),
        body={"gaps": [{"startMs": 300000, "endMs": 360000}]},
    )
    assert finish_a.status == 200

    clock["ms"] = parse_ms("2026-11-10T09:00:00Z")
    session_b = open_session(app, token, source["id"])

    # B's transcript is its own empty view — none of A's records, gaps or
    # finished state leak into it.
    transcript_b = app.request(
        "GET",
        f"/v1/sessions/{session_b['id']}/transcript",
        headers=auth_header(token),
    )
    assert transcript_b.status == 200
    assert transcript_b.json == {
        "sessionId": session_b["id"],
        "sourceId": source["id"],
        "resourceId": resource["id"],
        "sessionStatus": "active",
        "origin": None,
        "records": [],
        "gaps": [],
        "pending": [],
        "failed": [],
    }

    # A's transcript keeps its archive; the two views are independent.
    transcript_a = app.request(
        "GET",
        f"/v1/sessions/{session_a['id']}/transcript",
        headers=auth_header(token),
    )
    assert transcript_a.json == {
        **captions_finished["response"]["body"],
        "sessionId": session_a["id"],
        "sourceId": source["id"],
        "resourceId": resource["id"],
    }

    # B was untouched by A's finish: it is still active and finishable.
    clock["ms"] = parse_ms("2026-11-10T09:30:00Z")
    finish_b = app.request(
        "POST",
        f"/v1/sessions/{session_b['id']}/finish",
        headers=auth_header(token),
        body={},
    )
    assert finish_b.status == 200
    assert finish_b.json["session"]["status"] == "finished"

    # The resource detail lists both, newest first, with per-session
    # summaries that do not mix.
    detail = app.request(
        "GET",
        f"/v1/resources/{resource['id']}",
        headers=auth_header(token),
    )
    assert [
        [entry["id"], entry["status"], entry["transcript"]] for entry in detail.json["sessions"]
    ] == [
        [session_b["id"], "finished", {"recordCount": 0, "gapCount": 0, "failedCount": 0}],
        [session_a["id"], "finished", {"recordCount": 2, "gapCount": 1, "failedCount": 0}],
    ]


def test_two_accounts_studying_their_own_sources_keep_fully_separate_session_archives(start_app):
    captions_archive = session_example("api-session-captions-archive")
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    owner_favorite = create_fixture_source(app, owner)

    # The other account favorites the same address: a separate Source under
    # its own account (favorites are account-scoped, D2/D3/D5), and it runs
    # its own session on that Source.
    other_favorite = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(other),
        body={
            "url": "https://www.bilibili.com/video/BV1ab411L78c?p=2",
            "title": "注意力机制详解 P2：自注意力",
        },
    )
    assert other_favorite.status == 201
    owner_session = open_session(app, owner, owner_favorite["source"]["id"])
    other_session = open_session(app, other, other_favorite.json["source"]["id"])

    owner_archive = app.request(
        "POST",
        f"/v1/sessions/{owner_session['id']}/captions",
        headers=auth_header(owner),
        body=captions_archive["request"]["body"],
    )
    assert owner_archive.status == 201

    # The other account's transcript stays empty — its session, its source,
    # its account scope (D2).
    other_transcript = app.request(
        "GET",
        f"/v1/sessions/{other_session['id']}/transcript",
        headers=auth_header(other),
    )
    assert other_transcript.status == 200
    assert other_transcript.json["records"] == []
    assert other_transcript.json["origin"] is None
    assert other_transcript.json["sourceId"] == other_favorite.json["source"]["id"]

    # And each account's resource detail lists only its own session.
    owner_detail = app.request(
        "GET",
        f"/v1/resources/{owner_favorite['resource']['id']}",
        headers=auth_header(owner),
    )
    assert [entry["id"] for entry in owner_detail.json["sessions"]] == [owner_session["id"]]
    other_detail = app.request(
        "GET",
        f"/v1/resources/{other_favorite.json['resource']['id']}",
        headers=auth_header(other),
    )
    assert [entry["id"] for entry in other_detail.json["sessions"]] == [other_session["id"]]
