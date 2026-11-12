"""Account lifecycle for decision 3: first verification with a correct code
opens the account; every successful verification afterwards is a login.
Both paths end in a fresh credential issued into the account's active
credential group. Port of lib/accounts.js."""

from __future__ import annotations

import hmac
from typing import Any, Callable

from .codes import hash_code
from .config import Config
from .credentials import issue_credential
from .errors import ApiError
from .ids import generate_id
from .timeutil import iso_from_ms


def error_invalid_code() -> ApiError:
    return ApiError(401, "unauthorized", "验证码错误或已过期")


def error_too_many_attempts() -> ApiError:
    return ApiError(401, "unauthorized", "验证码尝试次数过多，请重新获取")


def find_account_by_email(store: Any, email: str) -> dict | None:
    return store.get("accounts", email)


def code_matches(record: dict, code: str) -> bool:
    # Node compares the two SHA-256 hex digests with timingSafeEqual; the
    # digests are always the same length, so compare_digest is equivalent.
    return hmac.compare_digest(record["codeHash"], hash_code(code))


def open_or_login(
    *,
    store: Any,
    email: str,
    code: str,
    now: Callable[[], int],
    config: Config,
) -> dict:
    """Verify an email + code pair and open-or-login the account."""
    at_ms = now()
    record = store.get("verificationCodes", email)
    if not record or record["consumedAt"] is not None or record["expiresAt"] <= at_ms:
        raise error_invalid_code()
    if record["attempts"] >= config.code_max_attempts:
        raise error_too_many_attempts()

    if not code_matches(record, code):
        record["attempts"] += 1
        store.set("verificationCodes", email, record)
        raise error_invalid_code()

    # Consume the code: one verification per issued code.
    record["consumedAt"] = at_ms
    store.set("verificationCodes", email, record)

    account = find_account_by_email(store, email)
    opened = False
    if not account:
        opened = True
        account = {
            "id": generate_id("acc"),
            "email": email,
            "createdAt": iso_from_ms(at_ms),
        }
        store.set("accounts", email, account)

    issued = issue_credential(
        store=store,
        account_id=account["id"],
        kind="web",
        now=now,
        config=config,
    )

    return {
        "opened": opened,
        "account": {
            "id": account["id"],
            "email": account["email"],
            "createdAt": account["createdAt"],
        },
        "credential": {
            "token": issued["token"],
            "kind": issued["credential"]["kind"],
            "credentialGroupId": issued["credential"]["credentialGroupId"],
        },
    }
