"""Email verification codes (decision 3: first verification opens the
account, later logins repeat the same code flow). Port of lib/codes.js.

Rules:
- one outstanding code per email, keyed by normalized address
- the code itself is never persisted: only its SHA-256 hash is stored
- a resend inside the cooldown window answers nothing new (the caller
  still returns the uniform 200, so uninvited/probing requests cannot
  tell the difference)
"""

from __future__ import annotations

import hashlib
import secrets
from typing import Any, Callable

from .config import Config


def hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def is_live(record: dict | None, at_ms: int) -> bool:
    return (
        record is not None
        and record["consumedAt"] is None
        and record["expiresAt"] > at_ms
    )


async def issue_code(
    *,
    store: Any,
    email: str,
    now: Callable[[], int],
    config: Config,
    mailer: Any,
) -> dict:
    """Issue (or silently skip) a code for one email."""
    at_ms = now()
    existing = store.get("verificationCodes", email)
    if is_live(existing, at_ms) and at_ms - existing["issuedAt"] < config.code_resend_cooldown_ms:
        return {"resent": False, "code": None}

    code = generate_code()
    record = {
        "email": email,
        "codeHash": hash_code(code),
        "issuedAt": at_ms,
        "expiresAt": at_ms + config.code_ttl_ms,
        "attempts": 0,
        "consumedAt": None,
    }
    store.set("verificationCodes", email, record)
    await mailer.send({
        "to": email,
        "subject": "Learning Digest 登录验证码",
        "text": (
            f"您的 Learning Digest 验证码是 {code}，"
            f"{round(config.code_ttl_ms / 60_000)} 分钟内有效。"
        ),
        "code": code,
    })
    return {"resent": True, "code": code}
