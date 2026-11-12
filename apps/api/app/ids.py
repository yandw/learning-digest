"""Opaque server-generated IDs (contract §1: IDs are opaque strings; the
readable prefixes exist for debugging only, clients must not parse them)."""

import base64
import secrets


def base64url(data: bytes) -> str:
    """Node's randomBytes(n).toString("base64url"): unpadded url-safe base64."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def generate_id(prefix: str) -> str:
    return f"{prefix}_{base64url(secrets.token_bytes(12))}"
