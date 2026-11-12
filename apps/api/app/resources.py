"""Resource/Source favorite domain (contract-v1.md §2.1–2.2, §3.1;
decisions 1, D2–D8). Port of lib/resources.js.

One favorite = one Resource + one Source (D5); duplicate favorites return
the same data (D3); everything is account-scoped (D2).

Matching (platform-video-id-rules.md §2):
1. a declared (or server-extracted) platform identity matches on
   (platformId, platformScopeId, platformVideoId, episodeId);
2. with no identity confirmable, the §0 normalized address matches.
A declared identity that misses does NOT fall back to the address —
unresolvable share links stay separate Sources (D8).

The shared extractor (app/platform_video_id.py, the port of
contracts/platform-video-id.js) is the single source of identity
extraction and normalization; this module only adds the account-scoped
store access and the API kinds."""

from __future__ import annotations

import re
from typing import Any

from .errors import ApiError, not_found_resource, validation_failed
from .ids import generate_id
from .notes import notes_for_resource
from .platform_video_id import (
    PLATFORM_VIDEO_ID_FORMATS,
    _safe_parse_url,
    extract_video_identity,
    normalize_url,
)
from .sessions import sessions_for_resource
from .timeutil import iso_seconds_from_ms

# The declared-identity format judgment comes from the shared platform
# module (platform-video-id-rules.md §1) — the same regexes the extractors
# pin, so a URL that extracts an identity and a declared one are judged by
# one source. The 400 validation POLICY stays here (parse_identity).

_REPLAY_PATH_RE = re.compile(r"(^|/)(replay|playback)([_/-]|s|$)", re.IGNORECASE)


def invalid_url() -> ApiError:
    return ApiError(400, "invalid_url", "仅支持 http(s) 网页地址")


def _parse_url_for_request(url: str):
    """`new URL(url)` + the http(s) protocol check, as one gate. Returns
    the parsed URL or None (the caller answers invalid_url). WhatWG hard
    requirements the contract leans on (scheme/host/port) live in the
    platform module's parser."""
    return _safe_parse_url(url)


def parse_identity(value: Any) -> dict | None:
    """Validate a submitted identity declaration (contract §2.5). Returns
    the normalized identity tuple, or None when nothing is declared.
    Well-formed but unsupported declarations are contract 400s ("其他字段
    校验失败")."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise validation_failed("identity 必须是对象")
    platform_id = value.get("platformId")
    platform_video_id = value.get("platformVideoId")
    if platform_id is None and platform_video_id is None:
        return None
    # A non-string platformId cannot name a supported platform (the JS
    # reference would coerce object keys here — the Python side treats
    # that shape as the unsupported-platform 400).
    fmt = PLATFORM_VIDEO_ID_FORMATS.get(platform_id) if isinstance(platform_id, str) else None
    if fmt is None:
        raise validation_failed("identity.platformId 不受支持")
    if not isinstance(platform_video_id, str) or fmt.fullmatch(platform_video_id) is None:
        raise validation_failed("identity.platformVideoId 与该平台的格式不符")
    episode_id = value.get("episodeId")
    if platform_id == "bilibili":
        # Same default as URL extraction: an absent p means episode 1.
        if episode_id is None:
            episode_id = "1"
        elif isinstance(episode_id, bool):
            raise validation_failed("identity.episodeId 必须是十进制分集号")
        elif isinstance(episode_id, int):
            episode_id = str(episode_id)
        elif isinstance(episode_id, float) and episode_id.is_integer():
            episode_id = str(int(episode_id))
        elif isinstance(episode_id, str) and re.fullmatch(r"[0-9]+", episode_id):
            episode_id = str(int(episode_id))
        else:
            raise validation_failed("identity.episodeId 必须是十进制分集号")
    elif episode_id is not None:
        raise validation_failed("该平台没有分集概念，不应携带 identity.episodeId")
    platform_scope_id = value.get("platformScopeId")
    if platform_id == "xiaoe-tech":
        # D7: the shop subdomain is part of the xiaoe identity.
        if not isinstance(platform_scope_id, str) or platform_scope_id == "":
            raise validation_failed("小鹅通 identity 必须携带商店子域 platformScopeId")
    elif platform_scope_id is not None:
        raise validation_failed("identity.platformScopeId 仅小鹅通支持")
    return {
        "platformId": platform_id,
        "platformVideoId": platform_video_id,
        "episodeId": episode_id,
        "platformScopeId": platform_scope_id,
    }


def parse_source_request(body: Any) -> dict:
    """Validate a favorite/resolve request body (contract §3.1/§3.4: url
    required http(s), title optional, identity optional). The raw address
    is kept verbatim for storage; normalization happens through the shared
    module only for matching."""
    if not isinstance(body, dict):
        raise validation_failed("缺少必填字段 url")
    url = body.get("url")
    if url is None or url == "":
        raise validation_failed("缺少必填字段 url")
    if not isinstance(url, str):
        raise invalid_url()
    parsed = _parse_url_for_request(url)
    if parsed is None or parsed.scheme not in ("http", "https"):
        raise invalid_url()
    title = None
    raw_title = body.get("title")
    if raw_title is not None:
        if not isinstance(raw_title, str):
            raise validation_failed("title 必须是字符串")
        title = None if raw_title.strip() == "" else raw_title
    return {
        "url": url,
        "pathname": parsed.path,
        "title": title,
        "identity": parse_identity(body.get("identity")),
        "normalized": normalize_url(url),
    }


def derive_source_kind(identity: dict | None, pathname: str) -> str:
    """Source.kind from the identity (platform-video-id-rules.md §3): xiaoe
    tokens map v_→video, a_→audio, l_→live (explicit replay paths → replay,
    matching source-platforms.js precedence), i_/p_ containers → webpage;
    the other three stations are playable video pages; no identity →
    webpage."""
    if not identity:
        return "webpage"
    if identity["platformId"] == "xiaoe-tech":
        token = identity["platformVideoId"].lower()
        if token.startswith("v_"):
            return "video"
        if token.startswith("a_"):
            return "audio"
        if token.startswith("l_"):
            return "replay" if _REPLAY_PATH_RE.search(pathname) else "live"
        return "webpage"
    return "video"


def match_by_identity(sources: list, account_id: str, identity: dict) -> dict | None:
    return next(
        (
            s
            for s in sources
            if s["accountId"] == account_id
            and s["platformId"] == identity["platformId"]
            and s["platformScopeId"] == identity["platformScopeId"]
            and s["platformVideoId"] == identity["platformVideoId"]
            and s["episodeId"] == identity["episodeId"]
        ),
        None,
    )


def match_by_normalized_url(sources: list, account_id: str, normalized: str) -> dict | None:
    return next(
        (s for s in sources if s["accountId"] == account_id and s["normalizedUrl"] == normalized),
        None,
    )


def match_source(*, store: Any, account_id: str, request: dict) -> dict | None:
    """Find the account's existing Source for this request, or None. A
    declared or server-extracted identity matches on the identity tuple;
    otherwise the §0 normalized address decides (rules §2)."""
    identity = request["identity"] or extract_video_identity(request["url"])
    sources = store.list("sources")
    source = (
        match_by_identity(sources, account_id, identity)
        if identity
        else match_by_normalized_url(sources, account_id, request["normalized"])
    )
    if not source:
        return None
    resource = store.get("resources", source["resourceId"])
    if resource and resource["accountId"] == account_id:
        return {"resource": resource, "source": source}
    return None


def create_favorite(*, store: Any, account_id: str, request: dict, now) -> dict:
    """Create one Resource + one Source for the request (D5). The Source
    keeps the raw first-favorited address (§2.2); normalizedUrl is
    internal."""
    at_ms = now()
    identity = request["identity"] or extract_video_identity(request["url"]) or None
    source_kind = derive_source_kind(identity, request["pathname"])
    resource = {
        "id": generate_id("res"),
        "accountId": account_id,
        # Display title only (never matches); the address is the fallback.
        "title": request["title"] or request["url"],
        "kind": "video" if source_kind == "replay" else source_kind,
        # Contract §1: ISO 8601 UTC at the fixture sample's second precision;
        # ms stay internal for list ordering.
        "createdAt": iso_seconds_from_ms(at_ms),
        "createdAtMs": at_ms,
    }
    source = {
        "id": generate_id("src"),
        "resourceId": resource["id"],
        "accountId": account_id,
        "kind": source_kind,
        "url": request["url"],
        "platformId": identity["platformId"] if identity else None,
        "platformVideoId": identity["platformVideoId"] if identity else None,
        "episodeId": identity["episodeId"] if identity else None,
        "platformScopeId": identity["platformScopeId"] if identity else None,
        "normalizedUrl": request["normalized"],
    }
    store.set("resources", resource["id"], resource)
    store.set("sources", source["id"], source)
    return {"resource": resource, "source": source}


def serialize_resource(resource: dict) -> dict:
    """Contract §2.1 shape (internal fields stripped)."""
    return {
        "id": resource["id"],
        "title": resource["title"],
        "kind": resource["kind"],
        "createdAt": resource["createdAt"],
    }


def serialize_source(*, store: Any, source: dict) -> dict:
    """Contract §2.2 shape: the source plus the account's progress on it."""
    progress = store.get("progress", source["id"])
    return {
        "id": source["id"],
        "resourceId": source["resourceId"],
        "kind": source["kind"],
        "url": source["url"],
        "platformId": source["platformId"],
        "platformVideoId": source["platformVideoId"],
        "episodeId": source["episodeId"],
        "platformScopeId": source["platformScopeId"],
        "progress": (
            {"positionMs": progress["positionMs"], "revision": progress["revision"]}
            if progress
            else None
        ),
    }


def present_favorite(*, store: Any, resource: dict, source: dict) -> dict:
    return {
        "resource": serialize_resource(resource),
        "source": serialize_source(store=store, source=source),
    }


def sources_for_resource(*, store: Any, account_id: str, resource_id: str) -> list:
    """All sources of one account's resource, insertion order."""
    return [
        s
        for s in store.list("sources")
        if s["accountId"] == account_id and s["resourceId"] == resource_id
    ]


def list_resources(*, store: Any, account_id: str) -> dict:
    """Contract §3.2: the account's resources, newest first, each with its
    sources carrying the latest progress."""
    resources = [r for r in store.list("resources") if r["accountId"] == account_id]
    # JS sort((a, b) => b.createdAtMs - a.createdAtMs): descending, stable
    # (ties keep insertion order) — sorted(reverse=True) is stable too.
    resources.sort(key=lambda r: r["createdAtMs"], reverse=True)
    items = [
        {
            "resource": serialize_resource(resource),
            "sources": [
                serialize_source(store=store, source=s)
                for s in sources_for_resource(
                    store=store, account_id=account_id, resource_id=resource["id"]
                )
            ],
        }
        for resource in resources
    ]
    return {"status": 200, "body": {"resources": items}}


def get_resource_detail(*, store: Any, account_id: str, resource_id: str) -> dict:
    """Contract §3.3: one account resource with sources and notes. Reads
    run with the accountId in the query (D2): other accounts' ids and
    unknown ids are the same 404. Notes are the real read-back (P12): the
    account's notes on this resource, oldest first. Round-2 extension
    (contract-r2 §3.6): the `sessions` key is purely additive — the
    round-1 three-key shape and its samples are unchanged. The Session
    domain itself lands with ticket 4.3."""
    resource = next(
        (
            r
            for r in store.list("resources")
            if r["id"] == resource_id and r["accountId"] == account_id
        ),
        None,
    )
    if not resource:
        raise not_found_resource()
    return {
        "status": 200,
        "body": {
            "resource": serialize_resource(resource),
            "sources": [
                serialize_source(store=store, source=s)
                for s in sources_for_resource(
                    store=store, account_id=account_id, resource_id=resource["id"]
                )
            ],
            "notes": notes_for_resource(
                store=store, account_id=account_id, resource_id=resource["id"]
            ),
            # contract-r2 §3.6 additive key (ticket 4.3): the account's
            # sessions on this resource, newest first, each with its
            # transcript summary counts.
            "sessions": sessions_for_resource(
                store=store, account_id=account_id, resource_id=resource["id"]
            ),
        },
    }


def retitle_resource(*, store: Any, account_id: str, resource_id: str, body: Any) -> dict:
    """Manual retitle (contract §3.7, the round-1 supplement for the Web
    "save the link first, add the title later" flow, P5): the request body
    accepts ONLY `{ title }` as a non-empty string — extra fields, a
    missing title or a blank one are the contract 400. The title is
    display-only (§2.1: it never matches), so retitling cannot affect
    duplicate detection. Cross-account and unknown ids are the same 404
    (D2), checked after body validation like the other write endpoints."""
    if not isinstance(body, dict):
        raise validation_failed("请求体必须是 JSON 对象")
    if any(key != "title" for key in body):
        raise validation_failed("请求体仅接受 title 字段")
    raw_title = body.get("title")
    if raw_title is None:
        raise validation_failed("缺少必填字段 title")
    if not isinstance(raw_title, str):
        raise validation_failed("title 必须是非空字符串")
    title = raw_title.strip()
    if title == "":
        raise validation_failed("title 不能为空")
    # D2: other accounts' resources and unknown ids are the same 404.
    resource = next(
        (
            r
            for r in store.list("resources")
            if r["id"] == resource_id and r["accountId"] == account_id
        ),
        None,
    )
    if not resource:
        raise not_found_resource()
    resource["title"] = title
    store.set("resources", resource["id"], resource)
    return {"status": 200, "body": {"resource": serialize_resource(resource)}}
