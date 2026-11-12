"""Session lifecycle endpoints (Ticket 4.3 / Node ticket 2.2, issue #65;
contract-r2.md §3.1–3.2). Python port of test/sessions-lifecycle.test.js.

Seam: the /v1 HTTP endpoints against the round-2 fixtures — the same
discipline as the P2/P4/P9/P12 tests. The fixture session ids
(ses_01JABC0031/0032/0033) map onto live ids; expected values come from
the fixture samples, never recomputed.

Ticket-note divergence (documented decision, kept from the Node port):
the ticket text says a repeated finish "answers 200 with the original
state", but the contract (contract-r2.md §1 idempotency rule + §3.2) and
the fixtures (error-session-finish-already-finished) pin 409
session_already_finished. The contract samples are the authoritative
expected values, so finish is a state transition: repeated finish is 409,
and "idempotent" holds in the state sense (the session stays finished,
nothing changes).
"""

from helpers import (
    auth_header,
    create_fixture_source,
    error_example,
    open_account,
    session_example,
)

LEARNER = "learner@example.com"
OWNER = "owner@example.com"
OTHER = "other@example.com"


def _parse(iso: str) -> int:
    from helpers import parse_ms

    return parse_ms(iso)


def test_create_session_answers_the_fixture_201_body(start_app):
    example = session_example("api-session-create-bilibili")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]

    # The fixture session starts at 10:00:00Z.
    clock["ms"] = _parse("2026-11-10T10:00:00Z")
    response = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(token),
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    assert response.json == {
        "session": {
            **example["response"]["body"]["session"],
            "id": response.json["session"]["id"],
            "sourceId": source["id"],
            "resourceId": resource["id"],
        }
    }
    assert response.json["session"]["id"].startswith("ses_")


def test_session_creation_requires_credentials(start_app):
    example = error_example("error-session-create-unauthorized")
    app = start_app(seed_emails=[LEARNER])
    response = app.request(
        "POST",
        "/v1/sources/src_01JABC0002/sessions",
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]


def test_session_on_another_accounts_source_is_404_and_creates_nothing(start_app):
    example = error_example("error-session-create-cross-account-source")
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    created = create_fixture_source(app, owner)
    source = created["source"]

    # Cross-account: the fixture 404 body verbatim.
    cross = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(other),
        body=example["request"]["body"],
    )
    assert cross.status == example["response"]["status"]
    assert cross.json == example["response"]["body"]

    # Unknown ids are the same 404 (D2).
    unknown = app.request(
        "POST",
        "/v1/sources/src_missing/sessions",
        headers=auth_header(other),
        body=example["request"]["body"],
    )
    assert unknown.status == 404
    assert unknown.json == example["response"]["body"]

    # The rejected attempts left no trace in the owner's flow: their own
    # create on the same source still succeeds with a fresh session.
    owner_create = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(owner),
        body=example["request"]["body"],
    )
    assert owner_create.status == 201
    assert owner_create.json["session"]["sourceId"] == source["id"]


def test_finish_reports_gaps_and_finishes(start_app):
    example = session_example("api-session-finish-with-gaps")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    resource, source = created["resource"], created["source"]

    # The fixture session runs 09:00 -> 09:45.
    clock["ms"] = _parse("2026-11-10T09:00:00Z")
    session = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(token),
        body={},
    )
    assert session.status == 201
    session_id = session.json["session"]["id"]

    clock["ms"] = _parse("2026-11-10T09:45:00Z")
    response = app.request(
        "POST",
        f"/v1/sessions/{session_id}/finish",
        headers=auth_header(token),
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    # The fixture session (ses_0032) carries origin "asr" from its audio
    # history; this slice's session has had no transcript submission yet,
    # so origin is still null. The full asr chain including origin "asr"
    # is reproduced verbatim in test_session_transcripts.py through the
    # write seam (the audio-side interface points).
    assert response.json == {
        "session": {
            **example["response"]["body"]["session"],
            "id": session_id,
            "sourceId": source["id"],
            "resourceId": resource["id"],
            "origin": None,
        }
    }


def test_finish_without_gaps_defaults_to_no_gaps_and_stamps_finished_at_server_side(start_app):
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    source = created["source"]
    session = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(token),
        body={},
    )
    session_id = session.json["session"]["id"]

    clock["ms"] = _parse("2026-11-10T09:45:00Z")
    # Both an empty object body and a missing body mean "no gaps".
    empty_body = app.request(
        "POST",
        f"/v1/sessions/{session_id}/finish",
        headers=auth_header(token),
        body={},
    )
    assert empty_body.status == 200
    assert empty_body.json["session"]["finishedAt"] == "2026-11-10T09:45:00Z"

    second = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(token),
        body={},
    )
    no_body = app.request(
        "POST",
        f"/v1/sessions/{second.json['session']['id']}/finish",
        headers=auth_header(token),
    )
    assert no_body.status == 200
    assert no_body.json["session"]["status"] == "finished"


def test_repeated_finish_is_409_session_already_finished(start_app):
    example = error_example("error-session-finish-already-finished")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    source = created["source"]
    session = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(token),
        body={},
    )
    session_id = session.json["session"]["id"]

    first = app.request(
        "POST",
        f"/v1/sessions/{session_id}/finish",
        headers=auth_header(token),
        body={},
    )
    assert first.status == 200

    # The fixture 409 body verbatim on the repeat.
    repeat = app.request(
        "POST",
        f"/v1/sessions/{session_id}/finish",
        headers=auth_header(token),
        body=example["request"]["body"],
    )
    assert repeat.status == example["response"]["status"]
    assert repeat.json == example["response"]["body"]


def test_finishing_another_accounts_session_is_a_404(start_app):
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    created = create_fixture_source(app, owner)
    source = created["source"]
    session = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(owner),
        body={},
    )
    session_id = session.json["session"]["id"]

    cross = app.request(
        "POST",
        f"/v1/sessions/{session_id}/finish",
        headers=auth_header(other),
        body={},
    )
    assert cross.status == 404
    assert cross.json["error"]["code"] == "not_found"

    unknown = app.request(
        "POST",
        "/v1/sessions/ses_missing/finish",
        headers=auth_header(other),
        body={},
    )
    assert unknown.status == 404
    assert unknown.json == cross.json, "unknown and cross-account are the same 404"


def test_invalid_gap_ranges_are_validation_failed_400s(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    created = create_fixture_source(app, token)
    source = created["source"]
    session = app.request(
        "POST",
        f"/v1/sources/{source['id']}/sessions",
        headers=auth_header(token),
        body={},
    )
    session_id = session.json["session"]["id"]

    def finish(body):
        return app.request(
            "POST",
            f"/v1/sessions/{session_id}/finish",
            headers=auth_header(token),
            body=body,
        )

    cases = [
        ("gaps not an array", {"gaps": {"startMs": 1, "endMs": 2}}),
        ("gap item not an object", {"gaps": [150000]}),
        ("missing startMs", {"gaps": [{"endMs": 210000}]}),
        ("missing endMs", {"gaps": [{"startMs": 150000}]}),
        ("inverted range", {"gaps": [{"startMs": 210000, "endMs": 150000}]}),
        ("empty range (endMs must be > startMs)", {"gaps": [{"startMs": 150000, "endMs": 150000}]}),
        ("negative startMs", {"gaps": [{"startMs": -1, "endMs": 150000}]}),
        ("fractional endMs", {"gaps": [{"startMs": 150000, "endMs": 1.5}]}),
    ]
    for label, body in cases:
        response = finish(body)
        assert response.status == 400, label
        assert response.json["error"]["code"] == "validation_failed", label

    # A rejected finish must not finish the session.
    still_active = app.request(
        "POST",
        f"/v1/sessions/{session_id}/finish",
        headers=auth_header(token),
        body={},
    )
    assert still_active.status == 200
