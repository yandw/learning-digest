"""P6: extension account linking (decision 3 of #49). The Web confirmation
page creates a one-time link code bound to its credential group; the
extension exchanges it for a live extension credential IN THE SAME GROUP
(the P7 linked-logout premise). CORS lets the extension's service worker
call these endpoints without host_permissions. Ported intent:
apps/api/test/auth-link.test.js. Seams: HTTP boundary + store inspection."""

import time

LEARNER = "learner@example.com"


def login_web_user(app, email):
    code_response = app.request("POST", "/v1/auth/request-code", body={"email": email})
    assert code_response.status == 200
    code = app.mailer.sent[-1]["code"]
    verify = app.request("POST", "/v1/auth/verify", body={"email": email, "code": code})
    assert verify.status == 201
    return verify.json["credential"]


def test_link_flow_issues_an_extension_credential_into_the_web_sessions_group(start_app):
    app = start_app(seed_emails=[LEARNER])
    web = login_web_user(app, LEARNER)

    created = app.request(
        "POST", "/v1/auth/link-requests", body={}, headers={"Authorization": f"Bearer {web['token']}"}
    )
    assert created.status == 201
    assert len(created.json["linkCode"]) >= 32, "the link code carries real entropy"
    assert created.json["expiresAt"].startswith("20") and "T" in created.json["expiresAt"]

    linked = app.request("POST", "/v1/auth/link", body={"code": created.json["linkCode"]})
    assert linked.status == 201
    assert linked.json["account"]["email"] == LEARNER
    assert linked.json["credential"]["kind"] == "extension"
    assert len(linked.json["credential"]["token"]) >= 32
    assert (
        linked.json["credential"]["credentialGroupId"] == web["credentialGroupId"]
    ), "the extension credential joins the confirming web session's group"

    # The new credential is live and resolves to the same account.
    me = app.request(
        "GET", "/v1/me", headers={"Authorization": f"Bearer {linked.json['credential']['token']}"}
    )
    assert me.status == 200
    assert me.json["account"]["email"] == LEARNER


def test_a_link_code_is_single_use(start_app):
    app = start_app(seed_emails=[LEARNER])
    web = login_web_user(app, LEARNER)
    created = app.request(
        "POST", "/v1/auth/link-requests", body={}, headers={"Authorization": f"Bearer {web['token']}"}
    )

    first = app.request("POST", "/v1/auth/link", body={"code": created.json["linkCode"]})
    assert first.status == 201

    replay = app.request("POST", "/v1/auth/link", body={"code": created.json["linkCode"]})
    assert replay.status == 401
    assert replay.json["error"]["code"] == "unauthorized"


def test_an_expired_link_code_fails_the_exchange(start_app):
    base = 1_700_000_000_000
    clock = {"ms": base}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    web = login_web_user(app, LEARNER)
    created = app.request(
        "POST", "/v1/auth/link-requests", body={}, headers={"Authorization": f"Bearer {web['token']}"}
    )

    clock["ms"] += 10 * 60 * 1000 + 1  # past the 10-minute link code TTL
    linked = app.request("POST", "/v1/auth/link", body={"code": created.json["linkCode"]})
    assert linked.status == 401
    assert linked.json["error"]["code"] == "unauthorized"


def test_a_group_revoked_between_link_requests_and_link_fails_the_exchange(start_app):
    app = start_app(seed_emails=[LEARNER])
    web = login_web_user(app, LEARNER)
    created = app.request(
        "POST", "/v1/auth/link-requests", body={}, headers={"Authorization": f"Bearer {web['token']}"}
    )

    # The Web session logs out before the extension exchanges the code:
    # revoke the group through the store to simulate the linked exit.
    group = next(
        entry for entry in app.store.list("credentialGroups") if entry["id"] == web["credentialGroupId"]
    )
    group["revokedAt"] = int(time.time() * 1000)
    app.store.set("credentialGroups", group["id"], group)

    linked = app.request("POST", "/v1/auth/link", body={"code": created.json["linkCode"]})
    assert linked.status == 401, "no credential is issued into a dead group"
    assert linked.json["error"]["code"] == "unauthorized"
    extension_credentials = [c for c in app.store.list("credentials") if c["kind"] == "extension"]
    assert extension_credentials == []


def test_missing_or_unknown_code_fields_answer_the_contract_envelopes(start_app):
    app = start_app(seed_emails=[LEARNER])
    missing = app.request("POST", "/v1/auth/link", body={})
    assert missing.status == 400
    assert missing.json == {"error": {"code": "validation_failed", "message": "缺少必填字段 code"}}

    unknown = app.request("POST", "/v1/auth/link", body={"code": "no-such-code"})
    assert unknown.status == 401
    assert unknown.json["error"]["code"] == "unauthorized"


def test_link_requests_requires_a_bearer_credential(start_app):
    app = start_app(seed_emails=[LEARNER])
    anonymous = app.request("POST", "/v1/auth/link-requests", body={})
    assert anonymous.status == 401
    assert anonymous.json == {"error": {"code": "unauthorized", "message": "未登录或凭据缺失"}}

    stale = app.request(
        "POST", "/v1/auth/link-requests", body={}, headers={"Authorization": "Bearer not-a-token"}
    )
    assert stale.status == 401
    assert stale.json == {"error": {"code": "unauthorized", "message": "凭据已失效，请重新登录并关联"}}


def test_cors_preflight_is_answered_and_v1_responses_echo_the_origin(start_app):
    app = start_app(seed_emails=[LEARNER])
    preflight = app.request(
        "OPTIONS",
        "/v1/auth/link",
        headers={
            "Origin": "chrome-extension://abcdefg",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert preflight.status == 204
    assert (
        preflight.headers.get("access-control-allow-origin") == "chrome-extension://abcdefg"
    ), "the requesting origin is echoed"
    assert "Authorization" in preflight.headers.get("access-control-allow-headers", "")
    assert "Content-Type" in preflight.headers.get("access-control-allow-headers", "")

    anonymous = app.request(
        "POST", "/v1/auth/link", body={}, headers={"Origin": "chrome-extension://abcdefg"}
    )
    assert anonymous.status == 400
    assert (
        anonymous.headers.get("access-control-allow-origin") == "chrome-extension://abcdefg"
    ), "actual responses carry the echoed origin too"

    unknown_path = app.request(
        "GET", "/v1/no-such-endpoint", headers={"Origin": "chrome-extension://abcdefg"}
    )
    assert unknown_path.status == 404
    assert (
        unknown_path.headers.get("access-control-allow-origin") == "chrome-extension://abcdefg"
    ), "CORS headers land before routing, so errors are readable from the extension"
