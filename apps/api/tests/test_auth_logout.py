"""Slice 6 (HTTP seam): POST /v1/auth/logout. Round 1 revoked the PRESENTED
credential only; P7 (linked logout, decision 3 of #49) takes the endpoint
over: logout now revokes the presented credential's WHOLE credential group,
so the Web session and the extension credential die together (contract §1:
401 = expired OR linked-revoked). Error bodies follow the contract
fixtures. Ported intent: apps/api/test/auth-logout.test.js. Seam: HTTP."""

MISSING_TOKEN_BODY = {"error": {"code": "unauthorized", "message": "未登录或凭据缺失"}}
EXPIRED_TOKEN_BODY = {"error": {"code": "unauthorized", "message": "凭据已失效，请重新登录并关联"}}

LEARNER = "learner@example.com"


def login(app, email=LEARNER):
    app.request("POST", "/v1/auth/request-code", body={"email": email})
    code = app.mailer.sent[-1]["code"]
    verify = app.request("POST", "/v1/auth/verify", body={"email": email, "code": code})
    assert verify.status in (200, 201), "verify opens (201) or logs in (200)"
    return verify.json["credential"]["token"]


def link_extension(app, web_token):
    """P6 link flow through the HTTP seam: a logged-in Web session creates a
    one-time link code bound to its credential group; the extension (no
    Bearer yet) exchanges it for a live extension credential in that group."""
    created = app.request(
        "POST", "/v1/auth/link-requests", body={}, headers={"Authorization": f"Bearer {web_token}"}
    )
    assert created.status == 201
    linked = app.request("POST", "/v1/auth/link", body={"code": created.json["linkCode"]})
    assert linked.status == 201
    return linked.json["credential"]["token"]


def test_logout_invalidates_the_presented_credential(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = login(app)
    logout = app.request("POST", "/v1/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert logout.status == 200
    assert logout.json == {"ok": True}
    after = app.request("GET", "/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert after.status == 401
    assert after.json == EXPIRED_TOKEN_BODY


def test_logout_without_a_credential_returns_the_missing_token_401_body(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request("POST", "/v1/auth/logout", body={})
    assert response.status == 401
    assert response.json == MISSING_TOKEN_BODY


def test_logout_with_an_unknown_token_returns_the_expired_token_401_body(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request("POST", "/v1/auth/logout", headers={"Authorization": "Bearer garbage"})
    assert response.status == 401
    assert response.json == EXPIRED_TOKEN_BODY


# P7 takeover: the round-1 behavior ("only the presented credential dies")
# is replaced by group-wide revocation — Web and extension credentials
# share one group (P6 pins the issue side), so one logout logs both out.
def test_logout_from_the_web_revokes_the_whole_credential_group_extension_included(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    web_token = login(app)
    clock["ms"] += 61_000
    extension_token = link_extension(app, web_token)

    logout = app.request("POST", "/v1/auth/logout", headers={"Authorization": f"Bearer {web_token}"})
    assert logout.status == 200
    assert logout.json == {"ok": True}

    for label, token in (("web", web_token), ("extension", extension_token)):
        after = app.request("GET", "/v1/me", headers={"Authorization": f"Bearer {token}"})
        assert after.status == 401, f"the {label} credential dies with the group"
        assert after.json == EXPIRED_TOKEN_BODY


def test_logout_from_the_extension_kills_the_web_session_too(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    web_token = login(app)
    clock["ms"] += 61_000
    extension_token = link_extension(app, web_token)

    logout = app.request("POST", "/v1/auth/logout", headers={"Authorization": f"Bearer {extension_token}"})
    assert logout.status == 200

    web_gone = app.request("GET", "/v1/me", headers={"Authorization": f"Bearer {web_token}"})
    assert web_gone.status == 401, "the web session dies with the group"
    extension_gone = app.request("GET", "/v1/me", headers={"Authorization": f"Bearer {extension_token}"})
    assert extension_gone.status == 401


def test_repeated_logout_with_an_already_revoked_credential_stays_200_idempotent(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = login(app)
    first = app.request("POST", "/v1/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert first.status == 200

    repeat = app.request("POST", "/v1/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert repeat.status == 200, "a repeat logout is a 200 no-op, not a 401"
    assert repeat.json == {"ok": True}


def test_re_login_after_a_group_logout_issues_a_fresh_group_and_re_linking_works(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    first_web_token = login(app)
    clock["ms"] += 61_000
    first_extension_token = link_extension(app, first_web_token)
    clock["ms"] += 61_000
    app.request("POST", "/v1/auth/logout", headers={"Authorization": f"Bearer {first_web_token}"})

    # The learner returns: Web login first (fresh active group), then the
    # extension re-links into that group.
    clock["ms"] += 61_000
    second_web_token = login(app)
    clock["ms"] += 61_000
    second_extension_token = link_extension(app, second_web_token)

    me = app.request("GET", "/v1/me", headers={"Authorization": f"Bearer {second_web_token}"})
    assert me.status == 200
    extension_me = app.request("GET", "/v1/me", headers={"Authorization": f"Bearer {second_extension_token}"})
    assert extension_me.status == 200, "the re-linked extension credential is live"

    # Old credentials from the revoked group stay dead.
    for token in (first_web_token, first_extension_token):
        stale = app.request("GET", "/v1/me", headers={"Authorization": f"Bearer {token}"})
        assert stale.status == 401
