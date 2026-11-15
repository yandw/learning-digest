"""Invited-email registry (decision 3 of #49): trial access starts from an
invited email. Port of lib/invites.js + scripts/invite.js — invites are
data in the store's `invites` collection, plus a seed file loaded at
startup and this module's CLI entry (`python -m app.invites`) — no admin
UI in round 1.

Run `python -m app.invites add [--admin] <email> ...` / `list` with
`--file` pointing at the API's embedded store file (same file the server
uses); default apps/api/data/state.json, overridable with
LD_API_STATE_FILE. `--admin` (round 4, issue #86) marks the invite — and
an already-opened account for the same email — as an admin.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Callable

from .timeutil import iso_from_ms

EMAIL_PATTERN = re.compile(r"[^\s@]+@[^\s@]+")


def normalize_email(value: Any) -> str | None:
    """Normalize an email for lookup and delivery: trim + lowercase.
    Returns the normalized address, or None when the value is not
    email-shaped (callers turn None into a validation error)."""
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if not EMAIL_PATTERN.fullmatch(normalized):
        return None
    return normalized


def add_invite(
    store: Any,
    email: str,
    now: Callable[[], int] | None = None,
    admin: bool = False,
) -> str:
    """Register an invited email (idempotent). With ``admin=True`` the
    invite is marked `isAdmin` — and if that email already opened an
    account, the stored account is promoted too (round 4, issue #86: the
    invite CLI is the only admin-marking tool; invitation marks). Returns
    "registered", "marked-admin" or "already-invited"."""
    normalized = normalize_email(email)
    if not normalized:
        raise ValueError(f"invalid invite email: {email}")
    existing = store.get("invites", normalized)
    if existing is None:
        at_ms = (now or _default_now)()
        store.set("invites", normalized, {
            "email": normalized,
            "invitedAt": iso_from_ms(at_ms),
            "isAdmin": admin,
        })
        return "registered"
    if admin and not existing.get("isAdmin", False):
        existing["isAdmin"] = True
        store.set("invites", normalized, existing)
        account = store.get("accounts", normalized)
        if account is not None and not account.get("isAdmin", False):
            account["isAdmin"] = True
            store.set("accounts", normalized, account)
        return "marked-admin"
    return "already-invited"


def is_invited(store: Any, email: str) -> bool:
    return store.get("invites", email) is not None


def load_seed_invites(
    store: Any,
    seed_file: str | None,
    now: Callable[[], int] | None = None,
) -> None:
    """Load invited emails from a seed file (JSON array of addresses) into
    the store. Idempotent: existing invites stay untouched; a missing file
    is a no-op so deployments can start without one."""
    if not seed_file or not os.path.exists(seed_file):
        return
    with open(seed_file, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    if not isinstance(raw, list):
        raise ValueError(f"invite seed file must be a JSON array: {seed_file}")
    for email in raw:
        add_invite(store, email, now)


def _default_now() -> int:
    import time

    return int(time.time() * 1000)


# --- CLI (python -m app.invites): the scripts/invite.js equivalent -------


def _resolve_state_file(args: list[str], env: dict) -> str:
    if "--file" in args:
        index = args.index("--file")
        if index + 1 < len(args):
            return os.path.abspath(args[index + 1])
    if env.get("LD_API_STATE_FILE"):
        return os.path.abspath(env["LD_API_STATE_FILE"])
    package_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(package_dir, "data", "state.json")


def _strip_file_flag(args: list[str]) -> list[str]:
    if "--file" in args:
        index = args.index("--file")
        return args[:index] + args[index + 2:]
    return list(args)


def main(argv: list[str], env: dict | None = None) -> int:
    env = dict(os.environ if env is None else env)
    file = _resolve_state_file(argv, env)
    args = _strip_file_flag(argv)
    from .persistence import create_file_store

    store = create_file_store({"file": file})
    command = args[0] if args else None
    operands = args[1:]

    if command == "add":
        # --admin may sit anywhere among the operands (`add user@x --admin`
        # and `add --admin user@x` both mark the invite).
        admin = "--admin" in operands
        emails = [value for value in operands if value != "--admin"]
        if not emails:
            sys.stderr.write(
                "usage: python -m app.invites add [--admin] <email> [...]\n"
            )
            return 1
        for email in emails:
            if not normalize_email(email):
                sys.stderr.write(f"invalid email: {email}\n")
                return 1
        for email in emails:
            normalized = normalize_email(email)
            status = add_invite(store, email, admin=admin)
            if status == "registered":
                line = f"registered: {normalized}" + (" (admin)" if admin else "")
            elif status == "marked-admin":
                line = f"marked admin: {normalized}"
            else:
                record = store.get("invites", normalized)
                already_admin = bool(record.get("isAdmin", False))
                line = f"already invited: {normalized}" + (" (admin)" if already_admin else "")
            sys.stdout.write(f"{line}\n")
        return 0

    if command == "list":
        for invite in store.list("invites"):
            line = f"{invite['email']}\tinvited {invite['invitedAt']}"
            if invite.get("isAdmin", False):
                line += "\tadmin"
            sys.stdout.write(f"{line}\n")
        sys.stdout.write(f"({store.count('invites')} invited email(s))\n")
        return 0

    sys.stderr.write("usage: python -m app.invites <add|list> [...]\n")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
