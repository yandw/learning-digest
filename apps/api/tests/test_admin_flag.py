"""Round 4 ticket 6.1 (issue #86): the admin flag. Accounts gain a
persistent `isAdmin` boolean (default false) and GET /v1/me reports it,
so the Web library and the extension can branch on admin capabilities.
The flag's ONLY entry path in this round is the invite CLI (`python -m
app.invites add --admin` — invitation marks the account, slices below);
there is no API that flips it. Seams: the HTTP boundary (GET /v1/me,
the auth flow) and the invite CLI entry point."""

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(API_DIR))

from app.invites import main as invites_main  # noqa: E402
from app.persistence import create_file_store  # noqa: E402

from helpers import ADMIN, LEARNER, auth_header, open_account, site_capability_example  # noqa: E402


def test_me_reports_is_admin_false_for_a_plain_account(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request("GET", "/v1/me", headers=auth_header(token))
    assert response.status == 200
    assert response.json["account"]["isAdmin"] is False


# --- the invite CLI marks admins (invitation marks, issue #86) ------------


def read_state(file):
    import json
    import os

    if not os.path.exists(file):
        return {}
    with open(file, encoding="utf-8") as fh:
        return json.load(fh)


def test_cli_add_marks_admin_with_flag_after_email(tmp_path):
    state_file = str(tmp_path / "state.json")
    assert invites_main(["add", ADMIN, "--admin", "--file", state_file]) == 0
    invite = read_state(state_file)["invites"][ADMIN]
    assert invite["isAdmin"] is True


def test_cli_add_marks_admin_with_flag_before_email(tmp_path):
    state_file = str(tmp_path / "state.json")
    assert invites_main(["add", "--admin", ADMIN, "--file", state_file]) == 0
    invite = read_state(state_file)["invites"][ADMIN]
    assert invite["isAdmin"] is True


def test_cli_plain_add_leaves_the_invite_non_admin(tmp_path):
    state_file = str(tmp_path / "state.json")
    assert invites_main(["add", LEARNER, "--file", state_file]) == 0
    invite = read_state(state_file)["invites"][LEARNER]
    assert not invite.get("isAdmin", False)


def test_cli_add_admin_upgrades_an_existing_non_admin_invite(tmp_path):
    state_file = str(tmp_path / "state.json")
    assert invites_main(["add", LEARNER, "--file", state_file]) == 0
    assert invites_main(["add", "--admin", LEARNER, "--file", state_file]) == 0
    invite = read_state(state_file)["invites"][LEARNER]
    assert invite["isAdmin"] is True


def test_cli_add_admin_also_promotes_an_already_open_account(start_app, tmp_path):
    # The CLI is the only admin tool this round: marking an already-opened
    # account's email promotes the stored account too, not just the invite
    # (the running server picks the flag up from the state file, same
    # reload discipline as round-1 invite additions).
    state_file = str(tmp_path / "state.json")
    assert invites_main(["add", LEARNER, "--file", state_file]) == 0
    app = start_app(store=create_file_store({"file": state_file}))
    token = open_account(app, LEARNER)
    before = app.request("GET", "/v1/me", headers=auth_header(token))
    assert before.json["account"]["isAdmin"] is False

    assert invites_main(["add", LEARNER, "--admin", "--file", state_file]) == 0
    stored = read_state(state_file)["accounts"][LEARNER]
    assert stored["isAdmin"] is True


def test_cli_list_shows_the_admin_marker(tmp_path):
    state_file = str(tmp_path / "state.json")
    assert invites_main(["add", "--admin", ADMIN, "--file", state_file]) == 0
    assert invites_main(["add", LEARNER, "--file", state_file]) == 0

    import io
    import contextlib

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        assert invites_main(["list", "--file", state_file]) == 0
    output = buffer.getvalue()
    admin_line = next(line for line in output.splitlines() if line.startswith(ADMIN))
    plain_line = next(line for line in output.splitlines() if line.startswith(LEARNER))
    assert "admin" in admin_line
    assert "admin" not in plain_line


# --- invitation marks the opened account (end to end) ---------------------


def test_account_opened_from_an_admin_invite_reports_is_admin_true(start_app, tmp_path):
    # The full ops flow: the operator marks an invite --admin before the
    # user ever signs up; the opened account inherits the admin flag and
    # GET /v1/me reports it. The me account shape is the shared round-4
    # fixture's shape (exact key set; ids are per-deployment).
    fixture_account = site_capability_example("api-me-admin-flag")["response"]["body"]["account"]
    state_file = str(tmp_path / "state.json")
    assert invites_main(["add", "--admin", ADMIN, "--file", state_file]) == 0
    app = start_app(store=create_file_store({"file": state_file}))
    token = open_account(app, ADMIN)
    response = app.request("GET", "/v1/me", headers=auth_header(token))
    assert response.status == 200
    assert set(response.json["account"]) == set(fixture_account)
    assert response.json["account"]["isAdmin"] == fixture_account["isAdmin"] is True


def test_account_opened_from_a_plain_invite_stays_non_admin(start_app):
    # The seed-file invite path (no admin info) opens plain accounts.
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request("GET", "/v1/me", headers=auth_header(token))
    assert response.json["account"]["isAdmin"] is False
