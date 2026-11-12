"""PATCH /v1/resources/{id} — manual retitle (Ticket P5, issue #55; the
round-1 contract supplement documented in contract-v1.md §3.7). Python
port of test/resources-retitle.test.js.

Seam: the /v1 HTTP endpoints, asserted against the P1 fixtures as the
shared test samples. The retitle sample (api-resource-retitle) drives
the response shape on top of the create-generic-webpage sample it
retitles; error bodies follow the shared envelope semantics (400
validation_failed, 404 not_found per decision D2)."""

import pytest

from helpers import api_example, auth_header, open_account

LEARNER = "learner@example.com"
OWNER = "owner@example.com"
OTHER = "other@example.com"


def favorite_generic_webpage(app, token):
    """Favorite the create-generic-webpage sample into an account and
    return the Resource — the retitle sample's target."""
    favorite = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body=api_example("api-resources-create-generic-webpage")["request"]["body"],
    )
    assert favorite.status == 201
    return favorite.json["resource"]


def test_retitle_updates_the_display_title_and_returns_the_updated_resource(start_app):
    retitle = api_example("api-resource-retitle")
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    resource = favorite_generic_webpage(app, token)

    response = app.request(
        "PATCH",
        f"/v1/resources/{resource['id']}",
        headers=auth_header(token),
        body=retitle["request"]["body"],
    )

    assert response.status == 200
    # Contract §2.1 shape; the retitle sample pins title, kind and
    # createdAt against the same shared sample ids.
    assert response.json["resource"]["id"] == resource["id"]
    assert response.json["resource"]["title"] == retitle["response"]["body"]["resource"]["title"]
    assert response.json["resource"]["kind"] == retitle["response"]["body"]["resource"]["kind"]
    assert response.json["resource"]["createdAt"] == resource["createdAt"]

    # The new title is visible on the detail read.
    detail = app.request(
        "GET", f"/v1/resources/{resource['id']}", headers=auth_header(token)
    )
    assert detail.status == 200
    assert detail.json["resource"]["title"] == retitle["response"]["body"]["resource"]["title"]


def test_the_title_never_participates_in_matching_refavorite_after_retitle_returns_the_same_resource(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    resource = favorite_generic_webpage(app, token)

    retitled = app.request(
        "PATCH",
        f"/v1/resources/{resource['id']}",
        headers=auth_header(token),
        body={"title": "改名之后同样能认出这条资料"},
    )
    assert retitled.status == 200

    refavorite = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body=api_example("api-resources-create-generic-webpage")["request"]["body"],
    )
    assert refavorite.status == 200, "re-favorite hits the existing source"
    assert refavorite.json["resource"]["id"] == resource["id"]


def test_another_accounts_resource_is_the_same_404_as_an_unknown_id(start_app):
    app = start_app(seed_emails=[OWNER, OTHER])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    resource = favorite_generic_webpage(app, owner)

    for token, target in [(other, resource["id"]), (owner, "res_does_not_exist")]:
        response = app.request(
            "PATCH",
            f"/v1/resources/{target}",
            headers=auth_header(token),
            body={"title": "越权或未知的标题修改"},
        )
        assert response.status == 404
        assert response.json == {
            "error": {"code": "not_found", "message": "资源不存在或无权访问"}
        }


def test_empty_whitespace_missing_and_non_string_titles_are_validation_failures(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    resource = favorite_generic_webpage(app, token)

    for body in [{"title": ""}, {"title": "   "}, {}, {"title": 42}, {"title": None}]:
        response = app.request(
            "PATCH",
            f"/v1/resources/{resource['id']}",
            headers=auth_header(token),
            body=body,
        )
        assert response.status == 400, f"body {body} must be a 400"
        assert response.json["error"]["code"] == "validation_failed"


def test_the_request_body_accepts_only_title_extra_fields_are_rejected(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    resource = favorite_generic_webpage(app, token)

    response = app.request(
        "PATCH",
        f"/v1/resources/{resource['id']}",
        headers=auth_header(token),
        body={"title": "合法标题", "url": "https://www.example.com/sneaky"},
    )
    assert response.status == 400
    assert response.json["error"]["code"] == "validation_failed"

    # Nothing changed.
    detail = app.request(
        "GET", f"/v1/resources/{resource['id']}", headers=auth_header(token)
    )
    assert detail.json["resource"]["title"] == resource["title"]


def test_retitle_without_credentials_is_401(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request(
        "PATCH", "/v1/resources/res_01JABC0010", body={"title": "未登录的标题修改"}
    )
    assert response.status == 401
    assert response.json["error"]["code"] == "unauthorized"
