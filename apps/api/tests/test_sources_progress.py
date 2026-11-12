"""PUT /v1/sources/{id}/progress — playback progress with optimistic
concurrency (Ticket P9, issue #54). Python port of
test/sources-progress.test.js.

Seam: the /v1 HTTP endpoints against the P1 fixtures (same as the P4
tests). The progress fixture chain runs against a live Source created
through POST /v1/resources with the create fixture body — the fixture's
opaque source id (src_01JABC0002) maps onto the live id. Expected values
come from the fixture samples, never recomputed.

Idempotent resend semantics (ticket #54; fixtures do not cover it, so it
is pinned here and in app/progress.py): a request whose expectedRevision
equals the current revision AND whose positionMs equals the stored value
is a resend of the last successful write (e.g. after a network drop) —
it answers 200 with the current values and does NOT bump the revision.
The same expectedRevision with a different positionMs is a fresh write
and bumps."""

import pytest

from helpers import api_example, auth_header, error_example, open_account

LEARNER = "learner@example.com"
OWNER = "owner@example.com"
OTHER = "other@example.com"

# Marker for "send no request body at all" (the harness's _UNSET role).
_ABSENT = object()


def create_fixture_source(app, token):
    """Create the fixture bilibili Source through the public favoriting
    endpoint (the progress fixtures' src_01JABC0002 is that source)."""
    created = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body=api_example("api-resources-create-bilibili-p2")["request"]["body"],
    )
    assert created.status == 201
    return created.json["source"]


def test_first_write_no_progress_counts_as_revision_0_write_returns_revision_1(start_app):
    example = api_example("api-progress-first-write")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source = create_fixture_source(app, token)

    response = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]


def test_update_with_the_read_revision_bumps_to_revision_2(start_app):
    first_write = api_example("api-progress-first-write")
    update = api_example("api-progress-update")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source = create_fixture_source(app, token)

    first = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=first_write["request"]["body"],
    )
    assert first.json == first_write["response"]["body"]

    # The fixture update carries the revision the first write returned.
    response = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=update["request"]["body"],
    )
    assert response.status == update["response"]["status"]
    assert response.json == update["response"]["body"]


def test_stale_expected_revision_is_a_409_carrying_the_current_progress(start_app):
    first_write = api_example("api-progress-first-write")
    update = api_example("api-progress-update")
    conflict = error_example("error-progress-conflict")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source = create_fixture_source(app, token)

    # Bring the chain to the fixture conflict's precondition: revision 2.
    app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=first_write["request"]["body"],
    )
    app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=update["request"]["body"],
    )

    response = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=conflict["request"]["body"],
    )
    assert response.status == conflict["response"]["status"]
    assert response.json == conflict["response"]["body"]


def test_writing_another_accounts_source_is_a_404_and_writes_nothing(start_app):
    example = error_example("error-cross-account-progress")
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    source = create_fixture_source(app, owner)

    response = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(other),
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]

    # Unknown ids are the same 404 (D2).
    unknown = app.request(
        "PUT",
        "/v1/sources/src_missing/progress",
        headers=auth_header(other),
        body=example["request"]["body"],
    )
    assert unknown.status == 404
    assert unknown.json == example["response"]["body"]

    # No write happened: the owner still sees no progress and the very
    # first write with expectedRevision 0 succeeds.
    owner_list = app.request("GET", "/v1/resources", headers=auth_header(owner))
    assert owner_list.json["resources"][0]["sources"][0]["progress"] is None
    owner_write = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(owner),
        body=api_example("api-progress-first-write")["request"]["body"],
    )
    assert owner_write.status == 200
    assert owner_write.json["revision"] == 1


def test_resending_the_last_write_is_idempotent_200_with_current_values_no_revision_bump(start_app):
    first_write = api_example("api-progress-first-write")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source = create_fixture_source(app, token)

    first = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=first_write["request"]["body"],
    )
    assert first.json == first_write["response"]["body"]

    # A resend: the client re-submits the same positionMs together with the
    # revision it holds from the last acknowledged response. Identical
    # position at the current revision = duplicate of the last write.
    resend = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body={
            "positionMs": first_write["request"]["body"]["positionMs"],
            "expectedRevision": 1,
        },
    )
    assert resend.status == 200
    assert resend.json == first_write["response"]["body"], "same result, same revision"

    # A resend that still carries a stale revision is NOT treated as a
    # duplicate: it is the ordinary 409 + current path (D4), which keeps
    # the outcome consistent because the earlier write did land.

    # The resend did not consume a version: the next fresh write still
    # lands on revision 2.
    nxt = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body={"positionMs": 126000, "expectedRevision": 1},
    )
    assert nxt.json == {"positionMs": 126000, "revision": 2}


def test_same_revision_but_a_different_position_is_a_fresh_write_and_bumps(start_app):
    first_write = api_example("api-progress-first-write")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source = create_fixture_source(app, token)

    app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=first_write["request"]["body"],
    )

    response = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body={"positionMs": 130000, "expectedRevision": 1},
    )
    assert response.json == {"positionMs": 130000, "revision": 2}


def test_rewinding_the_position_is_a_legal_write(start_app):
    # D4: no server-side clamping.
    first_write = api_example("api-progress-first-write")
    update = api_example("api-progress-update")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source = create_fixture_source(app, token)

    app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=first_write["request"]["body"],
    )
    app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body=update["request"]["body"],
    )

    # Dragged back to an earlier position: saved as the last actually
    # played position, still a normal versioned write.
    rewind = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body={"positionMs": 100000, "expectedRevision": 2},
    )
    assert rewind.status == 200
    assert rewind.json == {"positionMs": 100000, "revision": 3}


def test_invalid_fields_are_validation_failed_400s(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source = create_fixture_source(app, token)

    def put(body):
        request_kwargs = {"headers": auth_header(token)}
        if body is not _ABSENT:
            request_kwargs["body"] = body
        return app.request("PUT", f"/v1/sources/{source['id']}/progress", **request_kwargs)

    cases = [
        ("missing positionMs", {"expectedRevision": 0}),
        ("missing expectedRevision", {"positionMs": 1000}),
        ("empty body", _ABSENT),
        ("non-integer positionMs", {"positionMs": 12.5, "expectedRevision": 0}),
        ("string positionMs", {"positionMs": "1000", "expectedRevision": 0}),
        ("negative positionMs", {"positionMs": -1, "expectedRevision": 0}),
        ("negative expectedRevision", {"positionMs": 1000, "expectedRevision": -1}),
        ("string expectedRevision", {"positionMs": 1000, "expectedRevision": "0"}),
        ("fractional expectedRevision", {"positionMs": 1000, "expectedRevision": 1.5}),
    ]
    for label, body in cases:
        response = put(body)
        assert response.status == 400, label
        assert response.json["error"]["code"] == "validation_failed", label

    # A rejected write must not touch the store: the next valid write is
    # still the first (expectedRevision 0).
    after = put({"positionMs": 1000, "expectedRevision": 0})
    assert after.json == {"positionMs": 1000, "revision": 1}


def test_progress_writes_require_credentials(start_app):
    missing = error_example("error-unauthorized-missing-token")
    expired = error_example("error-unauthorized-expired-token")
    app = start_app(seed_emails=[LEARNER])

    no_header = app.request(
        "PUT",
        "/v1/sources/src_x/progress",
        body={"positionMs": 1000, "expectedRevision": 0},
    )
    assert no_header.status == missing["response"]["status"]
    assert no_header.json == missing["response"]["body"]

    bad_token = app.request(
        "PUT",
        "/v1/sources/src_x/progress",
        headers=auth_header("not-a-token"),
        body={"positionMs": 1000, "expectedRevision": 0},
    )
    assert bad_token.status == expired["response"]["status"]
    assert bad_token.json == expired["response"]["body"]
