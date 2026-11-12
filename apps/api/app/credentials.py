"""Credential + credential-group model (decision 3 of #49). Port of
lib/credentials.js.

A credential is one Bearer token (Web session or extension link). Every
credential belongs to exactly one credential group; the group is the
revocation boundary: revoking a group invalidates every credential in it,
which is what linked logout (Web + extension exiting together) builds on.
Round-1 rule: login issues the new credential into the account's ACTIVE
group, creating one only when none is active — so Web and extension
credentials of one account share a group.

Storage: credentials are keyed by token SHA-256 (the raw token never
touches the store); groups are keyed by id."""

from __future__ import annotations

import hashlib
import secrets
from typing import Any, Callable

from .config import Config
from .ids import base64url, generate_id


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def find_active_group(store: Any, account_id: str) -> dict | None:
    groups = [
        group
        for group in store.list("credentialGroups")
        if group["accountId"] == account_id and group["revokedAt"] is None
    ]
    if not groups:
        return None
    # Newest first (Node: sort((a, b) => b.createdAt - a.createdAt)[0]).
    return sorted(groups, key=lambda group: group["createdAt"], reverse=True)[0]


def issue_credential(
    *,
    store: Any,
    account_id: str,
    kind: str,
    now: Callable[[], int],
    config: Config,
    credential_group_id: str | None = None,
) -> dict:
    """Issue a Bearer credential into the account's active group (creating
    the group when none is active). The extension link flow pins the group
    instead: it passes credential_group_id so the extension credential
    joins the group of the Web session that confirmed the link."""
    at_ms = now()
    group = (
        store.get("credentialGroups", credential_group_id)
        if credential_group_id
        else find_active_group(store, account_id)
    )
    if not group:
        group = {
            "id": generate_id("credgrp"),
            "accountId": account_id,
            "createdAt": at_ms,
            "revokedAt": None,
        }
        store.set("credentialGroups", group["id"], group)
    token = base64url(secrets.token_bytes(config.token_bytes))
    credential = {
        "id": generate_id("cred"),
        "tokenHash": hash_token(token),
        "accountId": account_id,
        "kind": kind,
        "credentialGroupId": group["id"],
        "createdAt": at_ms,
        "revokedAt": None,
    }
    store.set("credentials", credential["tokenHash"], credential)
    return {"token": token, "credential": credential}


def authenticate(*, store: Any, token: str) -> dict | None:
    """Authenticate a Bearer token: resolves the credential by token hash
    and rejects it when the credential itself or its whole group is
    revoked. Returns the live credential record, or None."""
    record = store.get("credentials", hash_token(token))
    if not record or record["revokedAt"] is not None:
        return None
    group = store.get("credentialGroups", record["credentialGroupId"])
    if not group or group["revokedAt"] is not None:
        return None
    return record


def find_credential_by_token(*, store: Any, token: str) -> dict | None:
    """Resolve a credential record by token WITHOUT the revocation checks.
    The logout endpoint needs the record of an already-revoked credential
    so a repeated logout stays an idempotent 200 instead of a 401; unknown
    tokens (never issued) still return None."""
    return store.get("credentials", hash_token(token))


def revoke_credential(*, store: Any, token: str, now: Callable[[], int]) -> bool:
    """Revoke ONE credential. Siblings in the same group stay valid. The
    logout ENDPOINT drives revoke_credential_group instead; this primitive
    stays part of the model for tests and future single-credential needs.
    Unknown or already-revoked tokens are a no-op."""
    record = store.get("credentials", hash_token(token))
    if not record or record["revokedAt"] is not None:
        return False
    record["revokedAt"] = now()
    store.set("credentials", record["tokenHash"], record)
    return True


def revoke_credential_group(*, store: Any, group_id: str, now: Callable[[], int]) -> bool:
    """Revoke a whole credential group — the revocation boundary for
    decision 3 (Web and extension credentials exit together)."""
    group = store.get("credentialGroups", group_id)
    if not group or group["revokedAt"] is not None:
        return False
    group["revokedAt"] = now()
    store.set("credentialGroups", group["id"], group)
    return True
