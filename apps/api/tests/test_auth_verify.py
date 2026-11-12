"""Slice 4: POST /v1/auth/verify. A correct code opens the account on first
use (201) and issues a Web credential; later logins repeat the same flow
(200, opened: false) and join the account's ACTIVE credential group —
decision 3: Web and extension credentials live and die as one group.
Ported intent: apps/api/test/auth-verify.test.js. Seam: the HTTP boundary."""


def seed_email():
    return "learner@example.com"


def request_code(app, email):
    response = app.request("POST", "/v1/auth/request-code", body={"email": email})
    assert response.status == 200
    return app.mailer.sent[-1]["code"]


def test_correct_code_opens_the_account_and_issues_a_web_credential(start_app):
    app = start_app(seed_emails=[seed_email()])
    code = request_code(app, seed_email())
    response = app.request("POST", "/v1/auth/verify", body={"email": seed_email(), "code": code})
    assert response.status == 201
    assert response.json["opened"] is True
    assert response.json["account"]["email"] == seed_email()
    assert len(response.json["account"]["id"]) > 0
    assert response.json["account"]["createdAt"].startswith("20") and "T" in response.json["account"]["createdAt"]
    assert len(response.json["credential"]["token"]) >= 32
    assert response.json["credential"]["kind"] == "web"
    assert len(response.json["credential"]["credentialGroupId"]) > 0


def test_second_login_with_a_fresh_code_does_not_re_open_the_account(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[seed_email()], now=lambda: clock["ms"])

    first_code = request_code(app, seed_email())
    first = app.request("POST", "/v1/auth/verify", body={"email": seed_email(), "code": first_code})
    assert first.status == 201

    clock["ms"] += 61_000  # pass the resend cooldown
    second_code = request_code(app, seed_email())
    second = app.request("POST", "/v1/auth/verify", body={"email": seed_email(), "code": second_code})
    assert second.status == 200
    assert second.json["opened"] is False
    assert second.json["account"]["id"] == first.json["account"]["id"]
    assert second.json["credential"]["token"] != first.json["credential"]["token"]


def test_repeat_login_joins_the_same_credential_group_as_the_first_login(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[seed_email()], now=lambda: clock["ms"])

    first_code = request_code(app, seed_email())
    first = app.request("POST", "/v1/auth/verify", body={"email": seed_email(), "code": first_code})

    clock["ms"] += 61_000
    second_code = request_code(app, seed_email())
    second = app.request("POST", "/v1/auth/verify", body={"email": seed_email(), "code": second_code})

    assert (
        second.json["credential"]["credentialGroupId"]
        == first.json["credential"]["credentialGroupId"]
    ), "logins join the account's active group (decision 3)"


def test_missing_code_field_returns_400_validation_failed(start_app):
    app = start_app(seed_emails=[seed_email()])
    response = app.request("POST", "/v1/auth/verify", body={"email": seed_email()})
    assert response.status == 400
    assert response.json == {
        "error": {"code": "validation_failed", "message": "缺少必填字段 code"},
    }


def test_missing_email_field_on_verify_returns_400_validation_failed(start_app):
    app = start_app(seed_emails=[seed_email()])
    response = app.request("POST", "/v1/auth/verify", body={"code": "123456"})
    assert response.status == 400
    assert response.json == {
        "error": {"code": "validation_failed", "message": "缺少必填字段 email"},
    }
