"""Slice 3: POST /v1/auth/request-code. Invited emails (loaded from the seed
file) get a 6-digit code through the Mailer seam; uninvited emails get the
IDENTICAL 200 response with no email (anti-enumeration). Codes are
rate-limited: a resend cooldown, one outstanding code per email. Ported
intent: apps/api/test/auth-request-code.test.js. Seam: the HTTP boundary."""


def invited_app(start_app, **overrides):
    return start_app(seed_emails=["learner@example.com"], **overrides)


def test_invited_email_receives_a_6_digit_code_through_the_mailer_seam(start_app):
    app = invited_app(start_app)
    response = app.request("POST", "/v1/auth/request-code", body={"email": "learner@example.com"})
    assert response.status == 200
    assert response.json == {"ok": True}
    assert len(app.mailer.sent) == 1
    mail = app.mailer.sent[0]
    assert mail["to"] == "learner@example.com"
    assert len(mail["code"]) == 6 and mail["code"].isdigit()
    assert mail["code"] in mail["text"], "delivery text carries the code"


def test_uninvited_email_gets_the_identical_response_and_no_email(start_app):
    app = invited_app(start_app)
    invited = app.request("POST", "/v1/auth/request-code", body={"email": "learner@example.com"})
    uninvited = app.request("POST", "/v1/auth/request-code", body={"email": "stranger@example.com"})
    assert uninvited.status == 200
    assert uninvited.json == invited.json
    assert len(app.mailer.sent) == 1, "only the invited email was sent"


def test_email_is_normalized_before_invite_lookup_and_delivery(start_app):
    app = invited_app(start_app)
    response = app.request("POST", "/v1/auth/request-code", body={"email": "  Learner@Example.COM "})
    assert response.status == 200
    assert app.mailer.sent[0]["to"] == "learner@example.com"


def test_requesting_again_within_the_cooldown_answers_200_but_does_not_resend(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = invited_app(start_app, now=lambda: clock["ms"])
    app.request("POST", "/v1/auth/request-code", body={"email": "learner@example.com"})
    clock["ms"] += 10_000  # 10s later, inside the default 60s cooldown
    response = app.request("POST", "/v1/auth/request-code", body={"email": "learner@example.com"})
    assert response.status == 200
    assert response.json == {"ok": True}
    assert len(app.mailer.sent) == 1, "no duplicate email in cooldown"


def test_requesting_after_the_cooldown_replaces_the_outstanding_code(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = invited_app(start_app, now=lambda: clock["ms"])
    app.request("POST", "/v1/auth/request-code", body={"email": "learner@example.com"})
    clock["ms"] += 61_000  # cooldown passed
    app.request("POST", "/v1/auth/request-code", body={"email": "learner@example.com"})
    assert len(app.mailer.sent) == 2
    assert app.mailer.sent[0]["code"] != app.mailer.sent[1]["code"]


def test_missing_email_field_returns_400_validation_failed(start_app):
    app = invited_app(start_app)
    response = app.request("POST", "/v1/auth/request-code", body={})
    assert response.status == 400
    assert response.json == {
        "error": {"code": "validation_failed", "message": "缺少必填字段 email"},
    }


def test_non_email_shaped_address_returns_400_validation_failed(start_app):
    app = invited_app(start_app)
    response = app.request("POST", "/v1/auth/request-code", body={"email": "not-an-email"})
    assert response.status == 400
    assert response.json == {
        "error": {"code": "validation_failed", "message": "邮箱格式不正确"},
    }


def test_malformed_json_body_returns_400_validation_failed_envelope(start_app):
    app = invited_app(start_app)
    response = app.request("POST", "/v1/auth/request-code", body="{not json")
    assert response.status == 400
    assert response.json == {
        "error": {"code": "validation_failed", "message": "请求体不是合法 JSON"},
    }


def test_get_on_request_code_returns_405_method_not_allowed(start_app):
    app = invited_app(start_app)
    response = app.request("GET", "/v1/auth/request-code")
    assert response.status == 405
    assert response.json == {
        "error": {"code": "method_not_allowed", "message": "HTTP 方法不被允许"},
    }
