"""POST /v1/resources — favorite (Ticket P4, issue #53). Python port of
test/resources-create.test.js.

Seam: the /v1 HTTP endpoints, asserted against the P1 fixtures as the
shared test samples. api-examples.json drives the create/duplicate/generic
shapes; error-examples.json drives the 400/401 bodies verbatim."""

import re

import pytest

from helpers import api_example, auth_header, error_example, open_account

ISO_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

LEARNER = "learner@example.com"


def assert_favorite_matches_fixture(actual, example):
    """Concrete contract fields must equal the fixture exactly,
    server-generated ids are opaque but relational (source.resourceId
    links the resource)."""
    expected = example["response"]["body"]
    assert isinstance(actual["resource"]["id"], str)
    assert len(actual["resource"]["id"]) > 0
    assert actual["resource"]["title"] == expected["resource"]["title"]
    assert actual["resource"]["kind"] == expected["resource"]["kind"]
    assert ISO_TIMESTAMP.match(actual["resource"]["createdAt"])

    assert isinstance(actual["source"]["id"], str)
    assert len(actual["source"]["id"]) > 0
    assert actual["source"]["resourceId"] == actual["resource"]["id"]
    for key in ["kind", "url", "platformId", "platformVideoId", "episodeId", "platformScopeId", "progress"]:
        assert actual["source"][key] == expected["source"][key], (
            f"{example['id']}: source.{key} must equal the fixture"
        )


def test_first_favorite_of_a_bilibili_episode_creates_resource_and_source(start_app):
    example = api_example("api-resources-create-bilibili-p2")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=example["request"]["body"]
    )
    assert response.status == 201
    assert_favorite_matches_fixture(response.json, example)


def test_generic_webpage_favorite_without_identity(start_app):
    example = api_example("api-resources-create-generic-webpage")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=example["request"]["body"]
    )
    assert response.status == 201
    assert_favorite_matches_fixture(response.json, example)


def test_favorite_without_a_title_falls_back_to_the_address_as_display_title(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body={"url": "https://www.example.com/no-title-page"},
    )
    assert response.status == 201
    assert response.json["resource"]["title"] == "https://www.example.com/no-title-page"


def test_equivalent_share_link_duplicate_returns_the_same_source_and_keeps_the_original_url(start_app):
    create = api_example("api-resources-create-bilibili-p2")
    duplicate = api_example("api-resources-duplicate-bilibili-p2")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    first = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=create["request"]["body"]
    )
    assert first.status == 201

    second = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=duplicate["request"]["body"]
    )
    assert second.status == duplicate["response"]["status"]
    # Same Resource + Source (decision D3), body isomorphic with creation.
    assert second.json["resource"]["id"] == first.json["resource"]["id"]
    assert second.json["source"]["id"] == first.json["source"]["id"]
    assert second.json["resource"]["title"] == first.json["resource"]["title"]
    assert second.json["resource"]["createdAt"] == first.json["resource"]["createdAt"]
    assert second.json["source"]["url"] == first.json["source"]["url"], (
        "source.url stays the first-favorited address (fixture: "
        f"{duplicate['response']['body']['source']['url']})"
    )
    assert second.json["source"]["url"] == create["response"]["body"]["source"]["url"]


def test_non_http_address_is_rejected_with_invalid_url(start_app):
    example = error_example("error-invalid-url")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=example["request"]["body"]
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]


def test_missing_url_field_is_rejected_with_validation_failed(start_app):
    example = error_example("error-validation-failed-missing-url")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=example["request"]["body"]
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]


def test_malformed_or_unparseable_address_is_rejected_with_invalid_url(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    for url in ["not a url", "https://", 42]:
        response = app.request(
            "POST", "/v1/resources", headers=auth_header(token), body={"url": url}
        )
        assert response.status == 400
        assert response.json["error"]["code"] == "invalid_url"
    # A null url is an absent one: the authoritative missing-url sample code.
    missing = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body={"url": None}
    )
    assert missing.status == 400
    assert missing.json["error"]["code"] == "validation_failed"


def test_a_revoked_credential_cannot_favorite(start_app):
    example = error_example("error-unauthorized-expired-token")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    logout = app.request("POST", "/v1/auth/logout", headers=auth_header(token))
    assert logout.status == 200

    response = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=example["request"]["body"]
    )
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]
