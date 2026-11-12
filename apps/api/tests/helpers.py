"""Shared helpers for the resource-domain tests — the Python mirror of
test/helpers/accounts.js plus the per-file fixture loading the Node tests
repeat. Fixtures are the shared contract samples: api-examples.json drives
the success shapes, error-examples.json the 400/401/404/409 bodies
verbatim, source-matching.json the matching relations. Only public
endpoints are used to open accounts — no store poking."""

import json
import pathlib
import tempfile
from datetime import datetime, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
FIXTURES_DIR = REPO_ROOT / "contracts" / "fixtures"


def _load(name: str) -> dict:
    with open(FIXTURES_DIR / name, encoding="utf-8") as fh:
        return json.load(fh)


def api_example(example_id: str) -> dict:
    return next(s for s in _load("api-examples.json")["samples"] if s["id"] == example_id)


def error_example(example_id: str) -> dict:
    return next(s for s in _load("error-examples.json")["samples"] if s["id"] == example_id)


def session_example(example_id: str) -> dict:
    """Round-2 sample (session-examples.json): Session lifecycle, captions
    archive, transcript polling, resource-detail extension."""
    return next(s for s in _load("session-examples.json")["samples"] if s["id"] == example_id)


def audio_example(example_id: str) -> dict:
    """Round-2 sample (audio-task-examples.json): audio upload, worker
    claim and result write-back."""
    return next(s for s in _load("audio-task-examples.json")["samples"] if s["id"] == example_id)


def matching_samples() -> list[dict]:
    return _load("source-matching.json")["samples"]


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def parse_ms(iso: str) -> int:
    """Date.parse equivalent for the fixture ISO timestamps (UTC, Z form)."""
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def open_account(app, email: str) -> str:
    """Open (or log into) an account through the public auth flow
    (request-code -> verify) and return its Bearer token."""
    requested = app.request("POST", "/v1/auth/request-code", body={"email": email})
    assert requested.status == 200
    code = app.mailer.sent[-1]["code"]
    verified = app.request("POST", "/v1/auth/verify", body={"email": email, "code": code})
    assert verified.status in (200, 201)
    return verified.json["credential"]["token"]


def create_fixture_source(app, token, title: str | None = None) -> dict:
    """Favorite the round-2 fixture bilibili Source through the public
    favoriting endpoint (the session fixtures' src_01JABC0002 is that
    source). Returns the { resource, source } body like the Node helper."""
    body = {"url": "https://www.bilibili.com/video/BV1ab411L78c?p=2"}
    if title is not None:
        body["title"] = title
    created = app.request("POST", "/v1/resources", headers=auth_header(token), body=body)
    assert created.status == 201
    return created.json


def open_session(app, token: str, source_id: str, clock: dict | None = None) -> dict:
    """Open a session on the fixture source (default fixture start 08:00Z
    when a clock is passed). Returns the Session body."""
    if clock is not None:
        clock["ms"] = parse_ms("2026-11-10T08:00:00Z")
    created = app.request(
        "POST",
        f"/v1/sources/{source_id}/sessions",
        headers=auth_header(token),
        body={},
    )
    assert created.status == 201
    return created.json["session"]


def make_audio_dir() -> str:
    """Default temp audio directory for one test app instance (D14: audio
    bytes are temp files outside the repo)."""
    return tempfile.mkdtemp(prefix="ld-api-audio-")


def open_account_with_id(app, email: str) -> dict:
    """Open an account through the public auth flow and resolve its account
    id via GET /v1/me (no store poking for accounts)."""
    token = open_account(app, email)
    me = app.request("GET", "/v1/me", headers=auth_header(token))
    return {"token": token, "accountId": me.json["account"]["id"]}


def create_session_for(app, token: str, label: str = "audio-chain") -> dict:
    """Favorite a small fixture source and start a Session on it. Returns
    { resource, source, session }."""
    created = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body={
            "url": "https://www.bilibili.com/video/BV1ab411L78c?p=2",
            "title": f"注意力机制详解 P2：自注意力（{label}）",
        },
    )
    assert created.status == 201
    session = app.request(
        "POST",
        f"/v1/sources/{created.json['source']['id']}/sessions",
        headers=auth_header(token),
        body={},
    )
    assert session.status == 201
    return {
        "resource": created.json["resource"],
        "source": created.json["source"],
        "session": session.json["session"],
    }
