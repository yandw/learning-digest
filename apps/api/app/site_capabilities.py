"""Site capability registry (round 4, issue #86): the server-side source
of truth for what each site can do — whether the platform serves usable
captions (the cheap path), whether ASR is allowed, and whether the
platform is enabled at all. Data lives in the store's `siteCapabilities`
collection, one row per platformId `{platformId, captions, asr, enabled}`;
startup seeds the known platforms (missing rows only — admin edits
survive restarts). The extension reads the full table via
GET /v1/site-capabilities and branches on it; admins edit rows via the
/v1/admin surface."""

from __future__ import annotations

from typing import Any

from .errors import validation_body_not_object, validation_failed

COLLECTION = "siteCapabilities"

# The registry's writable fields; a PUT body must be a subset of these.
CAPABILITY_FIELDS = ("captions", "asr", "enabled")

# Known platforms and their seed defaults. bilibili/youtube serve usable
# captions; xiaoe/xiaohongshu/xiaoyuzhou are audio-first (ASR only). Everything else
# would open as the ASR-only fallback (no captions before proven).
KNOWN_PLATFORMS = ("bilibili", "youtube", "xiaoe", "xiaohongshu", "xiaoyuzhou")
_PLATFORM_DEFAULTS = {
    "bilibili": {"captions": True, "asr": True, "enabled": True},
    "youtube": {"captions": True, "asr": True, "enabled": True},
    "xiaoe": {"captions": False, "asr": True, "enabled": True},
    "xiaohongshu": {"captions": False, "asr": True, "enabled": True},
}
UNKNOWN_PLATFORM_DEFAULTS = {"captions": False, "asr": True, "enabled": True}


def default_capabilities(platform_id: str) -> dict:
    defaults = _PLATFORM_DEFAULTS.get(platform_id, UNKNOWN_PLATFORM_DEFAULTS)
    return {"platformId": platform_id, **defaults}


def seed_site_capabilities(store: Any) -> None:
    """Add the default row for every known platform that has none.
    Idempotent; rows that already exist are never overwritten (admin edits
    survive restarts)."""
    for platform_id in KNOWN_PLATFORMS:
        if store.get(COLLECTION, platform_id) is None:
            store.set(COLLECTION, platform_id, default_capabilities(platform_id))


def list_site_capabilities(store: Any) -> list[dict]:
    """The full table, in seed/insertion order."""
    return list(store.list(COLLECTION))


def update_site_capability(store: Any, platform_id: str, patch: Any) -> dict | None:
    """Apply a boolean subset patch (`{captions?, asr?, enabled?}`) to the
    platform's row. A body outside the subset (unknown field, non-boolean
    value, non-object body) answers the contract 400s; a platformId with
    no registry row returns None (the route answers 404)."""
    if not isinstance(patch, dict):
        raise validation_body_not_object()
    current = store.get(COLLECTION, platform_id)
    if current is None:
        return None
    updates: dict[str, bool] = {}
    for field, value in patch.items():
        if field not in CAPABILITY_FIELDS:
            raise validation_failed(f"不支持的字段 {field}")
        if not isinstance(value, bool):
            raise validation_failed(f"{field} 必须是布尔值")
        updates[field] = value
    row = {**current, **updates}
    store.set(COLLECTION, platform_id, row)
    return row
