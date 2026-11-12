"""Slice 5: Bearer credential authentication on protected endpoints, shown
on GET /v1/me. The 401 bodies must match the shared contract fixtures
EXACTLY (contracts/fixtures/error-examples.json):
  error-unauthorized-missing-token -> "未登录或凭据缺失"
  error-unauthorized-expired-token -> "凭据已失效，请重新登录并关联"
Ported intent: apps/api/test/auth-me.test.js. Seam: the HTTP boundary."""

import json
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]

with open(REPO_ROOT / "contracts" / "fixtures" / "error-examples.json", encoding="utf-8") as _fh:
    FIXTURES = json.load(_fh)


def fixture_body(sample_id):
    sample = next(entry for entry in FIXTURES["samples"] if entry["id"] == sample_id)
    return sample["response"]["body"]


LEARNER = "learner@example.com"


def login_and_get_token(app, email=LEARNER):
    app.request("POST", "/v1/auth/request-code", body={"email": email})
    code = app.mailer.sent[-1]["code"]
    verify = app.request("POST", "/v1/auth/verify", body={"email": email, "code": code})
    assert verify.status == 201
    return verify.json["credential"]["token"]


def test_get_me_with_a_valid_bearer_credential_returns_the_account(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = login_and_get_token(app)
    response = app.request("GET", "/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status == 200
    assert response.json["account"]["email"] == LEARNER
    assert len(response.json["account"]["id"]) > 0


def test_missing_credential_returns_the_contract_missing_token_401_body(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request("GET", "/v1/me")
    assert response.status == 401
    assert response.json == fixture_body("error-unauthorized-missing-token")


def test_unknown_token_returns_the_contract_expired_token_401_body(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request("GET", "/v1/me", headers={"Authorization": "Bearer not-a-real-token"})
    assert response.status == 401
    assert response.json == fixture_body("error-unauthorized-expired-token")


def test_non_bearer_authorization_header_counts_as_missing_credential(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request("GET", "/v1/me", headers={"Authorization": "Basic dXNlcjpwYXNz"})
    assert response.status == 401
    assert response.json == fixture_body("error-unauthorized-missing-token")


def test_post_to_a_protected_route_also_enforces_the_credential(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request("POST", "/v1/me", body={})
    assert response.status == 405
    without_token = app.request("GET", "/v1/me")
    assert without_token.status == 401
