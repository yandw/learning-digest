"""Round 4 ticket 6.1 (issue #86): the server-side site capability
registry. The store carries a `siteCapabilities` collection — one row per
platformId `{platformId, captions, asr, enabled}` — seeded at startup for
the known platforms (missing rows are added; existing rows, including
admin edits, are never overwritten). Every logged-in user reads the full
table via GET /v1/site-capabilities; the extension branches on it to
decide captions / ASR / disabled behavior. Admin read/write comes in the
/v1/admin slices. Seams: the HTTP boundary and the state file (the ops
surface a previous deployment's admin edits live in)."""

import json
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(API_DIR))

from app.persistence import create_file_store  # noqa: E402

from helpers import (  # noqa: E402
    ADMIN,
    LEARNER,
    admin_app,
    auth_header,
    error_example,
    open_account,
    site_capability_example,
)

# Seed defaults (contract-r4.md §2): which platforms the service can pull
# captions for, which need ASR, and which are enabled at all.
SEEDED_TABLE = [
    {"platformId": "bilibili", "captions": True, "asr": True, "enabled": True},
    {"platformId": "youtube", "captions": True, "asr": True, "enabled": True},
    {"platformId": "xiaoe", "captions": False, "asr": True, "enabled": True},
    {"platformId": "xiaohongshu", "captions": False, "asr": True, "enabled": True},
]


def test_startup_seeds_the_known_platform_rows(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request("GET", "/v1/site-capabilities", headers=auth_header(token))
    assert response.status == 200
    assert response.json["capabilities"] == SEEDED_TABLE


def test_site_capabilities_require_a_credential(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request("GET", "/v1/site-capabilities")
    assert response.status == 401
    assert response.json == error_example("error-site-capabilities-unauthorized")["response"]["body"]


def test_startup_never_overwrites_previously_edited_rows(tmp_path, start_app):
    # A state file from a previous deployment carries an admin's edit
    # (bilibili captions turned off). Restarting must keep it and only add
    # rows that are missing entirely.
    state_file = str(tmp_path / "registry-state.json")
    with open(state_file, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "invites": {
                    LEARNER: {"email": LEARNER, "invitedAt": "2026-11-10T08:00:00Z"}
                },
                "siteCapabilities": {
                    "bilibili": {
                        "platformId": "bilibili",
                        "captions": False,
                        "asr": True,
                        "enabled": True,
                    }
                },
            },
            fh,
        )
    app = start_app(store=create_file_store({"file": state_file}))
    token = open_account(app, LEARNER)
    response = app.request("GET", "/v1/site-capabilities", headers=auth_header(token))
    assert response.status == 200
    rows = {row["platformId"]: row for row in response.json["capabilities"]}
    assert rows["bilibili"]["captions"] is False
    assert set(rows) == {"bilibili", "youtube", "xiaoe", "xiaohongshu"}


# --- the admin surface (Bearer + isAdmin; D2 404 for non-admins) ----------


def test_admin_list_returns_the_table_to_an_admin(start_app, tmp_path):
    app = admin_app(start_app, tmp_path)
    token = open_account(app, ADMIN)
    response = app.request("GET", "/v1/admin/site-capabilities", headers=auth_header(token))
    assert response.status == 200
    assert response.json["capabilities"] == SEEDED_TABLE


def test_admin_list_answers_the_d2_404_to_a_non_admin(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request("GET", "/v1/admin/site-capabilities", headers=auth_header(token))
    assert response.status == 404
    assert response.json == error_example("error-admin-site-capabilities-not-admin")["response"]["body"]


def test_admin_list_asks_anonymous_callers_to_authenticate(start_app):
    # Anonymous: the standard 401 (same as any protected endpoint). Only
    # the authenticated non-admin learns nothing (D2).
    app = start_app(seed_emails=[LEARNER])
    response = app.request("GET", "/v1/admin/site-capabilities")
    assert response.status == 401
    assert response.json == error_example("error-unauthorized-missing-token")["response"]["body"]


# --- the admin PUT (boolean subset patch per platform) ---------------------


def admin_token(app) -> str:
    return open_account(app, ADMIN)


def test_admin_put_updates_one_field_and_returns_the_row(start_app, tmp_path):
    app = admin_app(start_app, tmp_path)
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/bilibili",
        headers=auth_header(admin_token(app)),
        body={"captions": False},
    )
    assert response.status == 200
    assert response.json["capability"] == {
        "platformId": "bilibili",
        "captions": False,
        "asr": True,
        "enabled": True,
    }


def test_admin_put_unmentioned_fields_keep_their_values(start_app, tmp_path):
    app = admin_app(start_app, tmp_path)
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/xiaohongshu",
        headers=auth_header(admin_token(app)),
        body={"enabled": False},
    )
    assert response.status == 200
    assert response.json["capability"] == {
        "platformId": "xiaohongshu",
        "captions": False,
        "asr": True,
        "enabled": False,
    }


def test_admin_put_empty_body_returns_the_unchanged_row(start_app, tmp_path):
    # The empty subset is a valid read-back of the row.
    app = admin_app(start_app, tmp_path)
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/youtube",
        headers=auth_header(admin_token(app)),
        body={},
    )
    assert response.status == 200
    assert response.json["capability"] == {
        "platformId": "youtube",
        "captions": True,
        "asr": True,
        "enabled": True,
    }


def test_admin_put_edits_are_visible_through_the_user_table(start_app, tmp_path):
    app = admin_app(start_app, tmp_path, other_invites=(LEARNER,))
    app.request(
        "PUT",
        "/v1/admin/site-capabilities/bilibili",
        headers=auth_header(admin_token(app)),
        body={"captions": False, "asr": False},
    )
    token = open_account(app, LEARNER)
    response = app.request("GET", "/v1/site-capabilities", headers=auth_header(token))
    rows = {row["platformId"]: row for row in response.json["capabilities"]}
    assert rows["bilibili"]["captions"] is False
    assert rows["bilibili"]["asr"] is False


def test_non_admin_put_answers_the_d2_404(start_app):
    app = start_app(seed_emails=[LEARNER])
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/bilibili",
        headers=auth_header(open_account(app, LEARNER)),
        body={"captions": False},
    )
    assert response.status == 404
    assert response.json == error_example("error-admin-site-capabilities-not-admin")["response"]["body"]


# --- the admin PUT validations (contract-r4 §4 pinned copy) ----------------


def test_admin_put_unknown_platform_answers_404(start_app, tmp_path):
    # Only seeded platformIds are administrable; a typo'd platform is not
    # created into existence by a PUT.
    app = admin_app(start_app, tmp_path)
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/douyin",
        headers=auth_header(admin_token(app)),
        body={"captions": True},
    )
    assert response.status == 404
    assert response.json == error_example("error-admin-site-capability-unknown-platform")["response"]["body"]


def test_admin_put_non_boolean_value_answers_400(start_app, tmp_path):
    app = admin_app(start_app, tmp_path)
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/bilibili",
        headers=auth_header(admin_token(app)),
        body={"captions": "yes"},
    )
    assert response.status == 400
    assert response.json == error_example("error-admin-site-capability-invalid-field")["response"]["body"]


def test_admin_put_field_outside_the_subset_answers_400(start_app, tmp_path):
    app = admin_app(start_app, tmp_path)
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/bilibili",
        headers=auth_header(admin_token(app)),
        body={"volume": True},
    )
    assert response.status == 400
    assert response.json == error_example("error-admin-site-capability-unknown-field")["response"]["body"]


def test_admin_put_non_object_body_answers_400(start_app, tmp_path):
    app = admin_app(start_app, tmp_path)
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/bilibili",
        headers=auth_header(admin_token(app)),
        body=["captions"],
    )
    assert response.status == 400
    assert response.json == error_example("error-admin-site-capability-body-not-object")["response"]["body"]


def test_admin_put_boolean_validation_rejects_before_writing(start_app, tmp_path):
    # A rejected update leaves the row untouched (no partial writes).
    app = admin_app(start_app, tmp_path)
    app.request(
        "PUT",
        "/v1/admin/site-capabilities/bilibili",
        headers=auth_header(admin_token(app)),
        body={"captions": 1, "asr": False},
    )
    response = app.request(
        "GET", "/v1/site-capabilities", headers=auth_header(admin_token(app))
    )
    rows = {row["platformId"]: row for row in response.json["capabilities"]}
    assert rows["bilibili"] == {
        "platformId": "bilibili",
        "captions": True,
        "asr": True,
        "enabled": True,
    }


# --- the API speaks the shared round-4 fixtures verbatim -------------------


def test_seeded_table_matches_the_shared_fixture_sample(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request("GET", "/v1/site-capabilities", headers=auth_header(token))
    assert response.json == site_capability_example("api-site-capabilities-list")["response"]["body"]


def test_admin_table_matches_the_shared_fixture_sample(start_app, tmp_path):
    app = admin_app(start_app, tmp_path)
    response = app.request(
        "GET", "/v1/admin/site-capabilities", headers=auth_header(admin_token(app))
    )
    assert response.json == site_capability_example("api-admin-site-capabilities-list")["response"]["body"]


def test_admin_put_matches_the_shared_fixture_sample(start_app, tmp_path):
    app = admin_app(start_app, tmp_path)
    sample = site_capability_example("api-admin-site-capability-update")
    response = app.request(
        "PUT",
        "/v1/admin/site-capabilities/bilibili",
        headers=auth_header(admin_token(app)),
        body=sample["request"]["body"],
    )
    assert response.status == sample["response"]["status"]
    assert response.json == sample["response"]["body"]
