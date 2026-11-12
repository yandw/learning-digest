"""One-time short-lived link codes (P6, decision 3 of #49): the Web
confirmation page creates one bound to ITS credential group; the browser
extension exchanges the code for a live extension credential in the same
group (the P7 linked-logout premise). The code travels through the browser
location bar, so it is single use and expires quickly. Port of
lib/link-codes.js.

Rules (mirroring verification codes and credentials):
- the raw code is never persisted: only its SHA-256 hash is stored
- one exchange per code: consuming marks consumedAt, further exchanges
  fail the same way as unknown/expired codes (no information leak)
- the issuing credential group is pinned at creation; if the group is
  revoked before the exchange (Web logged out in between), the exchange
  fails instead of issuing a dead credential"""

from __future__ import annotations

import secrets
from typing import Any, Callable

from .codes import hash_code
from .config import Config
from .errors import ApiError
from .ids import base64url, generate_id
from .timeutil import iso_from_ms


def error_invalid_link_code() -> ApiError:
    return ApiError(401, "unauthorized", "关联码无效或已过期，请在网页上重新发起关联")


def generate_link_code() -> str:
    return base64url(secrets.token_bytes(32))


def create_link_code(
    *, store: Any, credential: dict, now: Callable[[], int], config: Config
) -> dict:
    """Create a link code bound to the caller's credential group."""
    at_ms = now()
    link_code = generate_link_code()
    record = {
        "id": generate_id("linkreq"),
        "codeHash": hash_code(link_code),
        "accountId": credential["accountId"],
        "credentialGroupId": credential["credentialGroupId"],
        "issuedAt": at_ms,
        "expiresAt": at_ms + config.link_code_ttl_ms,
        "consumedAt": None,
    }
    store.set("linkCodes", record["codeHash"], record)
    return {"linkCode": link_code, "expiresAt": iso_from_ms(record["expiresAt"])}


def consume_link_code(*, store: Any, code: str, now: Callable[[], int]) -> dict:
    """Consume a presented link code: unknown, expired, already used, or a
    revoked credential group all answer the same uniform 401."""
    at_ms = now()
    if not isinstance(code, str) or code.strip() == "":
        raise error_invalid_link_code()
    record = store.get("linkCodes", hash_code(code.strip()))
    if not record or record["consumedAt"] is not None or record["expiresAt"] <= at_ms:
        raise error_invalid_link_code()
    group = store.get("credentialGroups", record["credentialGroupId"])
    if not group or group["revokedAt"] is not None:
        raise error_invalid_link_code()
    record["consumedAt"] = at_ms
    store.set("linkCodes", record["codeHash"], record)
    return {"accountId": record["accountId"], "credentialGroupId": record["credentialGroupId"]}
