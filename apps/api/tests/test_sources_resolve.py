"""POST /v1/sources/resolve (Ticket P4, issue #53). Python port of
test/sources-resolve.test.js.

Seam: the /v1 HTTP endpoints against the P1 fixtures. Resolve is
read-only (contract §3.4): matched/unmatched shapes per api-examples,
the 401 shape per error-examples, and "no data is created" asserted by
re-reading the account list after resolving."""

import pytest

from helpers import api_example, auth_header, error_example, open_account

LEARNER = "learner@example.com"
OWNER = "owner@example.com"
OTHER = "other@example.com"


def create_fixture_favorites(app, token):
    """Favorite the two fixture create samples; returns the response bodies."""
    created = []
    for example_id in ["api-resources-create-bilibili-p2", "api-resources-create-generic-webpage"]:
        example = api_example(example_id)
        response = app.request(
            "POST", "/v1/resources", headers=auth_header(token), body=example["request"]["body"]
        )
        assert response.status == 201
        created.append(response.json)
    return {"bilibili": created[0], "generic": created[1]}


def test_resolve_with_a_declared_identity_hits_the_existing_source(start_app):
    create = api_example("api-resources-create-bilibili-p2")
    example = api_example("api-resolve-matched-episode2")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    bilibili = create_fixture_favorites(app, token)["bilibili"]
    app.store.set("progress", bilibili["source"]["id"], {"positionMs": 250000, "revision": 2})

    response = app.request(
        "POST", "/v1/sources/resolve", headers=auth_header(token), body=example["request"]["body"]
    )
    assert response.status == example["response"]["status"]
    assert response.json["matched"] is True
    assert response.json["resource"]["id"] == bilibili["resource"]["id"]
    assert response.json["source"]["id"] == bilibili["source"]["id"]
    assert response.json["source"]["url"] == create["response"]["body"]["source"]["url"]
    assert response.json["source"]["progress"] == example["response"]["body"]["source"][
        "progress"
    ], "resolve carries the latest progress (fixture chain end state)"
    assert response.json["source"] == {
        **bilibili["source"],
        "progress": {"positionMs": 250000, "revision": 2},
    }


def test_resolve_without_identity_falls_back_to_the_server_side_extractor(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    bilibili = create_fixture_favorites(app, token)["bilibili"]

    # Same episode through the recognizable share link, no identity sent.
    response = app.request(
        "POST",
        "/v1/sources/resolve",
        headers=auth_header(token),
        body={"url": "https://b23.tv/BV1ab411L78c?p=2&share_session_id=s-9"},
    )
    assert response.status == 200
    assert response.json["matched"] is True
    assert response.json["source"]["id"] == bilibili["source"]["id"]
    assert response.json["resource"]["id"] == bilibili["resource"]["id"]


def test_resolve_of_an_unknown_page_is_matched_false_and_creates_nothing(start_app):
    example = api_example("api-resolve-unmatched-generic")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    created = create_fixture_favorites(app, token)
    bilibili, generic = created["bilibili"], created["generic"]

    response = app.request(
        "POST", "/v1/sources/resolve", headers=auth_header(token), body=example["request"]["body"]
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]

    # Read-only: the account still holds exactly the two favorites.
    list_response = app.request("GET", "/v1/resources", headers=auth_header(token))
    assert sorted(
        item["resource"]["id"] for item in list_response.json["resources"]
    ) == sorted([bilibili["resource"]["id"], generic["resource"]["id"]])


def test_resolve_does_not_create_on_a_miss_for_a_recognized_platform_either(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    created = create_fixture_favorites(app, token)
    bilibili, generic = created["bilibili"], created["generic"]

    response = app.request(
        "POST",
        "/v1/sources/resolve",
        headers=auth_header(token),
        body={"url": "https://www.youtube.com/watch?v=aaaaaaaaaaa"},
    )
    assert response.status == 200
    assert response.json == {"matched": False}

    list_response = app.request("GET", "/v1/resources", headers=auth_header(token))
    assert sorted(
        item["resource"]["id"] for item in list_response.json["resources"]
    ) == sorted([bilibili["resource"]["id"], generic["resource"]["id"]]), (
        "resolve must not write, even for a recognizable platform URL"
    )


def test_resolve_stays_account_scoped_another_accounts_favorite_is_unmatched(start_app):
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    resolve_example = api_example("api-resolve-matched-episode2")
    create_fixture_favorites(app, owner)

    response = app.request(
        "POST", "/v1/sources/resolve", headers=auth_header(other), body=resolve_example["request"]["body"]
    )
    assert response.status == 200
    assert response.json == {"matched": False}, "no cross-account resolution"


def test_resolve_with_a_revoked_credential_is_401_and_leaks_nothing(start_app):
    example = error_example("error-unauthorized-resolve")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    logout = app.request("POST", "/v1/auth/logout", headers=auth_header(token))
    assert logout.status == 200

    response = app.request(
        "POST", "/v1/sources/resolve", headers=auth_header(token), body=example["request"]["body"]
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]
