"""Slice 7: invited emails are DATA — a seed file loads them on startup and
the invite CLI registers more at runtime. No admin UI in round 1. Ported
intent: apps/api/test/invite-script.test.js. Seams: the `python -m
app.invites` subprocess (the scripts/invite.js equivalent) and its state
file; end-to-end into request-code via a shared FileStore."""

import json
import os
import subprocess
import sys
from pathlib import Path

from app.persistence import create_file_store

API_DIR = Path(__file__).resolve().parents[1]
LEARNER = "learner@example.com"


def run(args, env=None):
    completed = subprocess.run(
        [sys.executable, "-m", "app.invites", *args],
        cwd=str(API_DIR),
        env={**os.environ, **(env or {})},
        capture_output=True,
        text=True,
        timeout=30,
    )
    return {"code": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}


def temp_state_file(tmp_path):
    return str(tmp_path / "state.json")


def read_state(file):
    if not os.path.exists(file):
        return {"invites": {}}
    with open(file, encoding="utf-8") as fh:
        return json.load(fh)


def test_invite_script_add_registers_an_invited_email_as_data(tmp_path):
    state_file = temp_state_file(tmp_path)
    result = run(["add", "invited@example.com", "--file", state_file])
    assert result["code"] == 0, result["stderr"]
    state = read_state(state_file)
    assert list(state["invites"]) == ["invited@example.com"]
    assert state["invites"]["invited@example.com"]["invitedAt"].startswith("20")


def test_invite_script_add_is_idempotent_and_normalizes_the_address(tmp_path):
    state_file = temp_state_file(tmp_path)
    run(["add", "invited@example.com", "--file", state_file])
    again = run(["add", "  INVITED@Example.COM ", "--file", state_file])
    assert again["code"] == 0, again["stderr"]
    state = read_state(state_file)
    assert len(state["invites"]) == 1


def test_invite_script_list_shows_registered_emails(tmp_path):
    state_file = temp_state_file(tmp_path)
    run(["add", "a@example.com", "--file", state_file])
    run(["add", "b@example.com", "--file", state_file])
    listing = run(["list", "--file", state_file])
    assert listing["code"] == 0, listing["stderr"]
    assert "a@example.com" in listing["stdout"]
    assert "b@example.com" in listing["stdout"]


def test_invite_script_rejects_non_email_shaped_input_without_writing_state(tmp_path):
    state_file = temp_state_file(tmp_path)
    result = run(["add", "not-an-email", "--file", state_file])
    assert result["code"] != 0
    assert "invalid email" in result["stderr"]
    assert read_state(state_file)["invites"] == {}


def test_emails_registered_by_the_script_are_accepted_by_request_code(start_app, tmp_path):
    # End to end: the CLI writes the store the server then reads.
    state_file = temp_state_file(tmp_path)
    run(["add", "scripted@example.com", "--file", state_file])
    app = start_app(store=create_file_store({"file": state_file}))
    response = app.request("POST", "/v1/auth/request-code", body={"email": "scripted@example.com"})
    assert response.status == 200
    assert len(app.mailer.sent) == 1
