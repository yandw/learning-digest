"""Slice 4: verify failure modes. Wrong, expired and replayed codes are all
rejected with ONE fixed 401 envelope (anti-enumeration: uninvited emails
verifying get the same body). Five failed attempts kill the code. Ported
intent: apps/api/test/auth-verify-failures.test.js. Seam: HTTP boundary."""

INVALID_CODE_BODY = {
    "error": {"code": "unauthorized", "message": "验证码错误或已过期"},
}
TOO_MANY_ATTEMPTS_BODY = {
    "error": {"code": "unauthorized", "message": "验证码尝试次数过多，请重新获取"},
}

LEARNER = "learner@example.com"


def request_code(app, email):
    response = app.request("POST", "/v1/auth/request-code", body={"email": email})
    assert response.status == 200
    return app.mailer.sent[-1]["code"]


def verify(app, email, code):
    return app.request("POST", "/v1/auth/verify", body={"email": email, "code": code})


def test_wrong_code_returns_the_fixed_401_envelope(start_app):
    app = start_app(seed_emails=[LEARNER])
    code = request_code(app, LEARNER)
    wrong = "000001" if code == "000000" else "000000"
    response = verify(app, LEARNER, wrong)
    assert response.status == 401
    assert response.json == INVALID_CODE_BODY


def test_uninvited_email_verifying_gets_the_same_envelope_as_a_wrong_code(start_app):
    app = start_app(seed_emails=[LEARNER])
    wrong_code = verify(app, LEARNER, "000000")
    uninvited = verify(app, "stranger@example.com", "123456")
    assert uninvited.status == 401
    assert uninvited.json == INVALID_CODE_BODY
    assert uninvited.json == wrong_code.json


def test_expired_code_is_rejected_with_the_same_envelope(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"], config={"code_ttl_ms": 5000})
    code = request_code(app, LEARNER)
    clock["ms"] += 6000  # past the 5s TTL
    response = verify(app, LEARNER, code)
    assert response.status == 401
    assert response.json == INVALID_CODE_BODY


def test_replayed_code_already_consumed_by_a_login_is_rejected(start_app):
    app = start_app(seed_emails=[LEARNER])
    code = request_code(app, LEARNER)
    first = verify(app, LEARNER, code)
    assert first.status == 201
    replay = verify(app, LEARNER, code)
    assert replay.status == 401
    assert replay.json == INVALID_CODE_BODY


def test_one_wrong_attempt_does_not_consume_the_code(start_app):
    app = start_app(seed_emails=[LEARNER])
    code = request_code(app, LEARNER)
    wrong = "000001" if code == "000000" else "000000"
    verify(app, LEARNER, wrong)
    correct = verify(app, LEARNER, code)
    assert correct.status == 201
    assert correct.json["opened"] is True


def test_after_five_wrong_attempts_even_the_correct_code_is_dead(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    code = request_code(app, LEARNER)
    wrong = "000001" if code == "000000" else "000000"
    for _ in range(5):
        attempt = verify(app, LEARNER, wrong)
        assert attempt.status == 401
        clock["ms"] += 1000  # stay inside the TTL but past any resend cooldown
    sixth = verify(app, LEARNER, code)
    assert sixth.status == 401
    assert sixth.json == TOO_MANY_ATTEMPTS_BODY
