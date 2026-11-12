"""POST /v1/resources/{id}/notes and the notes in GET /v1/resources/{id}
(Ticket P12, issue #61; contract-v1.md §2.4, §3.3, §3.6). Python port of
test/resources-notes.test.js.

Seam: the /v1 HTTP endpoints against the P1 fixtures (same as the P4/P9
tests). The bilibili fixture chain runs against a live Resource + Source
created through POST /v1/resources with the fixture bodies — the opaque
fixture ids (res_01JABC0001 / src_01JABC0002) map onto the live ids.
Concrete contract fields are asserted verbatim from the fixtures; the
injected clock pins createdAt to the fixture value exactly.

Semantics pinned here (the fixtures do not cover them):
- the idempotent resend is scoped to the account + clientRequestId: the
  first POST that carried a given clientRequestId is THE note; a resend
  answers 200 with the original note and never duplicates;
- a timestamped note's sourceId must point at a Source of the SAME
  resource under the SAME account (otherwise 400 validation_failed);
  a cross-account Resource is always the D2 404 first."""

import re

import pytest

from helpers import api_example, auth_header, error_example, open_account, parse_ms

ISO_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

LEARNER = "learner@example.com"
OWNER = "owner@example.com"
OTHER = "other@example.com"

# Fixture clock: the timestamped note sample's createdAt, verbatim.
NOTE_CLOCK_MS = parse_ms("2026-11-10T08:30:00Z")
# The webpage note sample's createdAt ("2026-11-10T08:40:00Z").
WEBPAGE_CLOCK_MS = parse_ms("2026-11-10T08:40:00Z")


def create_fixture_library(app, token):
    """Create the fixture bilibili Resource + Source (the note fixtures'
    res_01JABC0001 / src_01JABC0002) and the fixture generic webpage
    (res_01JABC0010) through the public favoriting endpoint."""
    video = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body=api_example("api-resources-create-bilibili-p2")["request"]["body"],
    )
    assert video.status == 201
    webpage = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body=api_example("api-resources-create-generic-webpage")["request"]["body"],
    )
    assert webpage.status == 201
    return {
        "videoSource": video.json["source"],
        "webpageResource": webpage.json["resource"],
    }


def test_timestamped_note_create_matches_the_fixture(start_app):
    example = api_example("api-note-create-timestamped")
    app = start_app(seed_emails=[LEARNER], now=lambda: NOTE_CLOCK_MS)
    token = open_account(app, LEARNER)
    video_source = create_fixture_library(app, token)["videoSource"]

    # The fixture's opaque sourceId (src_01JABC0002) maps onto the live id
    # (the P9 progress-test pattern); every other field goes verbatim.
    response = app.request(
        "POST",
        f"/v1/resources/{video_source['resourceId']}/notes",
        headers=auth_header(token),
        body={**example["request"]["body"], "sourceId": video_source["id"]},
    )
    assert response.status == example["response"]["status"]
    note = response.json["note"]
    assert isinstance(note["id"], str)
    assert len(note["id"]) > 0
    # Relational ids: the note belongs to the resource and the source it
    # was stamped on.
    assert note["resourceId"] == video_source["resourceId"]
    assert note["sourceId"] == video_source["id"]
    for key in ["positionMs", "text", "clientRequestId", "createdAt"]:
        assert note[key] == example["response"]["body"]["note"][key], f"note.{key}"


def test_webpage_note_without_source_and_position_matches_the_fixture(start_app):
    example = api_example("api-note-create-webpage")
    app = start_app(seed_emails=[LEARNER], now=lambda: WEBPAGE_CLOCK_MS)
    token = open_account(app, LEARNER)
    webpage_resource = create_fixture_library(app, token)["webpageResource"]

    response = app.request(
        "POST",
        f"/v1/resources/{webpage_resource['id']}/notes",
        headers=auth_header(token),
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    note = response.json["note"]
    assert isinstance(note["id"], str)
    assert len(note["id"]) > 0
    assert note["resourceId"] == webpage_resource["id"]
    assert note["sourceId"] is None
    assert note["positionMs"] is None
    for key in ["text", "clientRequestId", "createdAt"]:
        assert note[key] == example["response"]["body"]["note"][key], f"note.{key}"


def test_get_detail_returns_the_created_notes(start_app):
    # Contract §3.3, real data.
    detail_example = api_example("api-resources-detail-with-notes")
    create = api_example("api-note-create-timestamped")
    webpage = api_example("api-note-create-webpage")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    library = create_fixture_library(app, token)
    video_source = library["videoSource"]
    webpage_resource = library["webpageResource"]

    app.request(
        "POST",
        f"/v1/resources/{video_source['resourceId']}/notes",
        headers=auth_header(token),
        body={**create["request"]["body"], "sourceId": video_source["id"]},
    )
    app.request(
        "POST",
        f"/v1/resources/{webpage_resource['id']}/notes",
        headers=auth_header(token),
        body=webpage["request"]["body"],
    )

    # The timestamped resource detail carries its note (P4's empty array
    # placeholder becomes the real read-back).
    detail = app.request(
        "GET", f"/v1/resources/{video_source['resourceId']}", headers=auth_header(token)
    )
    assert detail.status == 200
    assert len(detail.json["notes"]) == 1
    note = detail.json["notes"][0]
    assert note["sourceId"] == video_source["id"]
    expected_note = detail_example["response"]["body"]["notes"][0]
    assert note["positionMs"] == expected_note["positionMs"]
    assert note["text"] == expected_note["text"]
    assert note["clientRequestId"] == expected_note["clientRequestId"]
    assert ISO_TIMESTAMP.match(note["createdAt"])

    # The webpage resource's notes stay separate (no cross-resource leak).
    webpage_detail = app.request(
        "GET", f"/v1/resources/{webpage_resource['id']}", headers=auth_header(token)
    )
    assert len(webpage_detail.json["notes"]) == 1
    assert webpage_detail.json["notes"][0]["sourceId"] is None


def test_resending_the_same_client_request_id_returns_the_original_note(start_app):
    # api-note-resend-idempotent: 200 and the original note, no duplicate.
    create = api_example("api-note-create-timestamped")
    resend = api_example("api-note-resend-idempotent")
    app = start_app(seed_emails=[LEARNER], now=lambda: NOTE_CLOCK_MS)
    token = open_account(app, LEARNER)
    video_source = create_fixture_library(app, token)["videoSource"]
    path = f"/v1/resources/{video_source['resourceId']}/notes"

    first = app.request(
        "POST",
        path,
        headers=auth_header(token),
        body={**create["request"]["body"], "sourceId": video_source["id"]},
    )
    assert first.status == 201

    # The resend (same clientRequestId, e.g. after a network drop) answers
    # 200 with the same note verbatim — the fixture pins 200 + same body.
    second = app.request(
        "POST",
        path,
        headers=auth_header(token),
        body={**resend["request"]["body"], "sourceId": video_source["id"]},
    )
    assert second.status == resend["response"]["status"]
    assert second.json["note"]["id"] == first.json["note"]["id"]
    assert second.json["note"] == first.json["note"]

    # And nothing was duplicated.
    detail = app.request(
        "GET", f"/v1/resources/{video_source['resourceId']}", headers=auth_header(token)
    )
    assert len(detail.json["notes"]) == 1


def test_a_client_request_id_is_the_dedupe_basis_account_wide(start_app):
    # Reusing it on another resource returns the original note.
    create = api_example("api-note-create-webpage")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    library = create_fixture_library(app, token)
    video_source = library["videoSource"]
    webpage_resource = library["webpageResource"]

    first = app.request(
        "POST",
        f"/v1/resources/{webpage_resource['id']}/notes",
        headers=auth_header(token),
        body=create["request"]["body"],
    )
    assert first.status == 201

    # The same clientRequestId aimed at a different resource of the same
    # account cannot create a second note: the original comes back.
    second = app.request(
        "POST",
        f"/v1/resources/{video_source['resourceId']}/notes",
        headers=auth_header(token),
        body=create["request"]["body"],
    )
    assert second.status == 200
    assert second.json["note"]["id"] == first.json["note"]["id"]
    assert second.json["note"]["resourceId"] == webpage_resource["id"]

    detail = app.request(
        "GET", f"/v1/resources/{video_source['resourceId']}", headers=auth_header(token)
    )
    assert len(detail.json["notes"]) == 0, "no note leaked onto the other resource"


def test_empty_note_text_is_the_fixture_400(start_app):
    example = error_example("error-validation-failed-empty-note-text")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    video_source = create_fixture_library(app, token)["videoSource"]

    response = app.request(
        "POST",
        f"/v1/resources/{video_source['resourceId']}/notes",
        headers=auth_header(token),
        body=example["request"]["body"],
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]


def test_request_validation_missing_client_request_id_pairing_and_position_ms(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    video_source = create_fixture_library(app, token)["videoSource"]

    def post(body):
        return app.request(
            "POST",
            f"/v1/resources/{video_source['resourceId']}/notes",
            headers=auth_header(token),
            body=body,
        )

    cases = [
        ("missing clientRequestId", {"text": "hello"}),
        ("empty clientRequestId", {"clientRequestId": "", "text": "hello"}),
        ("missing text", {"clientRequestId": "r1"}),
        ("whitespace text", {"clientRequestId": "r1", "text": "   "}),
        ("non-string text", {"clientRequestId": "r1", "text": 42}),
        (
            "sourceId without positionMs",
            {"clientRequestId": "r1", "text": "hello", "sourceId": video_source["id"]},
        ),
        (
            "positionMs without sourceId",
            {"clientRequestId": "r1", "text": "hello", "positionMs": 1000},
        ),
        (
            "negative positionMs",
            {
                "clientRequestId": "r1",
                "text": "hello",
                "sourceId": video_source["id"],
                "positionMs": -1,
            },
        ),
        (
            "fractional positionMs",
            {
                "clientRequestId": "r1",
                "text": "hello",
                "sourceId": video_source["id"],
                "positionMs": 1.5,
            },
        ),
        (
            "string positionMs",
            {
                "clientRequestId": "r1",
                "text": "hello",
                "sourceId": video_source["id"],
                "positionMs": "1000",
            },
        ),
        (
            "empty sourceId",
            {
                "clientRequestId": "r1",
                "text": "hello",
                "sourceId": "",
                "positionMs": 1000,
            },
        ),
    ]
    for label, body in cases:
        response = post(body)
        assert response.status == 400, label
        assert response.json["error"]["code"] == "validation_failed", label

    # A rejected write leaves no note behind.
    detail = app.request(
        "GET", f"/v1/resources/{video_source['resourceId']}", headers=auth_header(token)
    )
    assert len(detail.json["notes"]) == 0


def test_a_source_id_from_another_resource_of_the_same_account_is_a_400(start_app):
    # The pointer must stay in-resource.
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    library = create_fixture_library(app, token)
    video_source = library["videoSource"]
    webpage_resource = library["webpageResource"]

    response = app.request(
        "POST",
        f"/v1/resources/{webpage_resource['id']}/notes",
        headers=auth_header(token),
        body={
            "clientRequestId": "r-x",
            "text": "stamped",
            "sourceId": video_source["id"],
            "positionMs": 1000,
        },
    )
    assert response.status == 400
    assert response.json["error"]["code"] == "validation_failed"

    # A sourceId that exists nowhere is the same validation failure (the
    # resource itself is valid, so D2's 404 does not apply).
    unknown = app.request(
        "POST",
        f"/v1/resources/{webpage_resource['id']}/notes",
        headers=auth_header(token),
        body={
            "clientRequestId": "r-y",
            "text": "stamped",
            "sourceId": "src_missing",
            "positionMs": 1000,
        },
    )
    assert unknown.status == 400
    assert unknown.json["error"]["code"] == "validation_failed"


def test_writing_to_another_accounts_resource_is_the_fixture_404(start_app):
    example = error_example("error-cross-account-note-create")
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    video_source = create_fixture_library(app, owner)["videoSource"]

    # The fixture path /v1/resources/res_01JZZZZ9999/notes exercises the
    # unknown-id 404; the live cross-account id exercises the isolation one.
    fixture_path = app.request(
        "POST",
        example["endpoint"]["path"],
        headers=auth_header(other),
        body=example["request"]["body"],
    )
    assert fixture_path.status == example["response"]["status"]
    assert fixture_path.json == example["response"]["body"]

    cross_account = app.request(
        "POST",
        f"/v1/resources/{video_source['resourceId']}/notes",
        headers=auth_header(other),
        body=example["request"]["body"],
    )
    assert cross_account.status == 404
    assert cross_account.json == example["response"]["body"]

    # D2 404 wins over the source-pointer validation: a cross-account write
    # with a bogus sourceId is still the 404.
    with_bogus_source = app.request(
        "POST",
        f"/v1/resources/{video_source['resourceId']}/notes",
        headers=auth_header(other),
        body={**example["request"]["body"], "sourceId": "src_missing", "positionMs": 1000},
    )
    assert with_bogus_source.status == 404

    # Nothing was written anywhere.
    owner_detail = app.request(
        "GET", f"/v1/resources/{video_source['resourceId']}", headers=auth_header(owner)
    )
    assert len(owner_detail.json["notes"]) == 0


def test_notes_endpoints_require_credentials(start_app):
    missing = error_example("error-unauthorized-missing-token")
    expired = error_example("error-unauthorized-expired-token")
    app = start_app(seed_emails=[LEARNER])

    no_header = app.request(
        "POST",
        "/v1/resources/res_x/notes",
        body={"clientRequestId": "r1", "text": "hello"},
    )
    assert no_header.status == missing["response"]["status"]
    assert no_header.json == missing["response"]["body"]

    bad_token = app.request(
        "POST",
        "/v1/resources/res_x/notes",
        headers=auth_header("not-a-token"),
        body={"clientRequestId": "r1", "text": "hello"},
    )
    assert bad_token.status == expired["response"]["status"]
    assert bad_token.json == expired["response"]["body"]
