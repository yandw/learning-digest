"""Shared helpers for the resource-domain tests — the Python mirror of
test/helpers/accounts.js plus the per-file fixture loading the Node tests
repeat. Fixtures are the shared contract samples: api-examples.json drives
the success shapes, error-examples.json the 400/401/404/409 bodies
verbatim, source-matching.json the matching relations. Only public
endpoints are used to open accounts — no store poking."""

import json
import pathlib
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
