"""Platform Video ID extraction + URL normalization (contract v1, round 1).

Python port of contracts/platform-video-id.js — the server-side authority
for the four round-1 Source Platforms (xiaoe-tech, bilibili, youtube,
xiaohongshu). Implements contracts/platform-video-id-rules.md:

- extract_video_identity(url): the platform identity a URL carries, or
  None when the URL alone cannot confirm one. Per decision 1 the client
  submits this identity on POST /v1/resources and /v1/sources/resolve;
  per D6/D8 the client omits it for image-text notes and unresolvable
  short links (the URL alone cannot confirm those).
- normalize_url(url): the §0 normalized address used for url-exact
  matching — scheme + lowercase host + path + query, fragment dropped,
  the platform's share/tracking params and all utm_* dropped, remaining
  query params name-sorted. Storage keeps the raw first-favorited URL.
- PLATFORM_VIDEO_ID_FORMATS: the §1 per-platform platformVideoId regexes
  (the same ones the extractors pin), the single format-judgment source
  for consumers that validate declared identities.

Like the JS module: pure logic, zero dependencies, total functions — any
input (including garbage) returns a result and never throws, so callers
can feed it whatever a tab or a paste box happens to contain.

JS-parity notes (the JS contract test is the mirror authority):
- WHATWG URL parsing is approximated where the contract depends on it:
  http(s) scheme required, host must be non-empty, out-of-range ports
  rejected — everything else normalizes to None without raising. IDN
  hosts stay un-punycoded (no fixture or station depends on that form).
- Regexes use fullmatch so `$` cannot match before a trailing newline
  the way Python's `$` would; JS `^...$`.test() has no such allowance.
- Digit classes are spelled [0-9]: JS backslash-d is ASCII-only, the
  Python default is not."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse

XIAOE_SUFFIX = ".xiaoe-tech.com"
# Resource tokens: p_ column/product, v_ video, a_ audio, i_ image-text,
# l_ live/replay; the prefix stays part of the platformVideoId (D7).
XIAOE_TOKEN_RE = re.compile(r"^(p|v|a|i|l)_[a-z0-9]{4,}$", re.IGNORECASE)
BV_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
YT_ID_RE = re.compile(r"^[0-9A-Za-z_-]{11}$")
# Case-insensitive so the extractor agrees with source-platforms.js's
# recognition adapter (NOTE_ID_RE, also /i): a URL whose note id carries
# uppercase hex must not recognize as a video page yet fail extraction.
XHS_NOTE_RE = re.compile(r"^[0-9a-f]{24}$", re.IGNORECASE)

BILI_HOSTS = {"www.bilibili.com", "m.bilibili.com", "b23.tv"}
YT_HOSTS = {"www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
XHS_HOSTS = {"www.xiaohongshu.com", "xhslink.com"}

# Share/tracking params each platform's ignore list drops (rules §1).
# All platforms additionally drop every utm_* param.
IGNORE_PARAMS: dict[str, set[str]] = {
    "xiaoe-tech": {"app_id"},
    "bilibili": {
        "spm_id_from", "vd_source", "share_medium", "share_source",
        "share_plat", "share_tag", "share_session_id", "share_token",
        "unique_k", "buvid", "is_story_h5", "from_spmid", "up_id", "mid",
        "pop_share", "bsource", "broadcast_type", "plat_id",
    },
    "youtube": {
        "si", "t", "start", "time_continue", "list", "index", "feature",
        "pp", "app", "persist_app", "redir_token", "html5_redirect",
    },
    "xiaohongshu": {
        "xsec_token", "xsec_source", "share_token", "app_platform",
        "app_id", "share_plat", "share_from", "share_session_id",
    },
}


def safe_parse_url(url: Any):
    """Node's safeParseUrl: parse as http(s) or return None; never throws.
    Mirrors the WHATWG constructor's hard requirements the contract leans
    on (valid scheme, non-empty host, in-range port)."""
    try:
        parsed = urlparse(str(url))
    except Exception:  # str() of any input still parses; belt and braces
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    if not parsed.hostname:
        return None
    try:
        _ = parsed.port  # ValueError on out-of-range ports
    except ValueError:
        return None
    return parsed


def _platform_id_for_host(hostname: str) -> str | None:
    if hostname == XIAOE_SUFFIX.lstrip(".") or hostname.endswith(XIAOE_SUFFIX):
        return "xiaoe-tech"
    if hostname in BILI_HOSTS:
        return "bilibili"
    if hostname in YT_HOSTS:
        return "youtube"
    if hostname in XHS_HOSTS:
        return "xiaohongshu"
    return None


def _url_host(parsed) -> str | None:
    """Node's URL.host: lowercase host including an explicit port, without
    userinfo (urlparse's netloc would carry it)."""
    hostname = parsed.hostname or ""
    try:
        port = parsed.port
    except ValueError:
        return None
    if ":" in hostname:  # IPv6 literal — WHATWG keeps the brackets in host
        hostname = f"[{hostname}]"
    if port is None:
        return hostname
    return f"{hostname}:{port}"


def normalize_url(url: Any) -> str | None:
    """§0 normalized address for url-exact matching. Returns None for
    garbage or non-http(s) input; never throws."""
    parsed = safe_parse_url(url)
    if parsed is None:
        return None
    host = _url_host(parsed)
    if host is None:
        return None
    platform_id = _platform_id_for_host(parsed.hostname or "")
    ignored = IGNORE_PARAMS.get(platform_id, set())
    kept = [
        (name, value)
        for name, value in parse_qsl(parsed.query, keep_blank_values=True)
        # The utm_ prefix check is case-insensitive; the ignore-list match
        # is exact (name-sensitive), exactly like the JS reference.
        if not name.lower().startswith("utm_") and name not in ignored
    ]
    # Remaining params sorted by name (stable for duplicate names).
    kept.sort(key=lambda pair: pair[0])
    query = f"?{urlencode(kept)}" if kept else ""
    # WHATWG URL keeps an empty path as "/" for special schemes —
    # "https://host" and "https://host/" must normalize alike.
    path = parsed.path if parsed.path else "/"
    return f"{parsed.scheme}://{host}{path}{query}"


def _path_segments(pathname: str) -> list[str]:
    return [segment for segment in pathname.split("/") if segment]


def _first_param(parsed, name: str) -> str | None:
    """URLSearchParams.get: the first value under exactly this name."""
    return next((value for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key == name), None)


# --- per-station extractors ------------------------------------------------


def _extract_xiaoe(parsed) -> dict | None:
    # D7: the shop subdomain is part of the identity.
    host = parsed.hostname or ""
    scope_id = None if host == XIAOE_SUFFIX.lstrip(".") else host[: -len(XIAOE_SUFFIX)]
    for segment in _path_segments(parsed.path):
        if XIAOE_TOKEN_RE.fullmatch(segment):
            return {
                "platformId": "xiaoe-tech",
                "platformVideoId": segment,
                "episodeId": None,
                "platformScopeId": scope_id,
            }
    # term_ / goods_..._detail container pages carry no video identity.
    return None


def _extract_bilibili(parsed) -> dict | None:
    segments = _path_segments(parsed.path)
    bv = None
    if (parsed.hostname or "") == "b23.tv":
        # D8: b23.tv/<BV> is locally confirmable; a bare short code is not.
        if segments and BV_RE.fullmatch(segments[0]):
            bv = segments[0]
    else:
        for i in range(len(segments) - 1):
            if segments[i] == "video" and BV_RE.fullmatch(segments[i + 1]):
                bv = segments[i + 1]
                break
    if not bv:
        return None
    # The p query value is the episode id, decimal; absent (or not a
    # decimal) means the first episode, so p=1 and no-p are one Source.
    p = _first_param(parsed, "p")
    if p is not None and re.fullmatch(r"[0-9]+", p):
        episode_id = str(int(p))
    else:
        episode_id = "1"
    return {
        "platformId": "bilibili",
        "platformVideoId": bv,
        "episodeId": episode_id,
        "platformScopeId": None,
    }


def _extract_youtube(parsed) -> dict | None:
    video_id = None
    if (parsed.hostname or "") == "youtu.be":
        segments = _path_segments(parsed.path)
        if segments and YT_ID_RE.fullmatch(segments[0]):
            video_id = segments[0]
    elif parsed.path == "/watch":
        v = _first_param(parsed, "v")
        if v is not None and YT_ID_RE.fullmatch(v):
            video_id = v
    if not video_id:
        return None
    return {
        "platformId": "youtube",
        "platformVideoId": video_id,
        "episodeId": None,
        "platformScopeId": None,
    }


def _extract_xiaohongshu(parsed) -> dict | None:
    # xhslink.com short codes are not locally confirmable (D8); the note
    # id only appears on www.xiaohongshu.com paths.
    if (parsed.hostname or "") != "www.xiaohongshu.com":
        return None
    segments = _path_segments(parsed.path)
    note_id = None
    if len(segments) >= 2 and segments[0] == "explore" and XHS_NOTE_RE.fullmatch(segments[1]):
        note_id = segments[1]
    elif (
        len(segments) >= 3
        and segments[0] == "discovery"
        and segments[1] == "item"
        and XHS_NOTE_RE.fullmatch(segments[2])
    ):
        note_id = segments[2]
    if not note_id:
        return None
    # URL shape alone cannot tell video notes from image-text ones; the
    # client submits this identity only for playable video notes (D6).
    return {
        "platformId": "xiaohongshu",
        "platformVideoId": note_id,
        "episodeId": None,
        "platformScopeId": None,
    }


_EXTRACTORS = {
    "xiaoe-tech": _extract_xiaoe,
    "bilibili": _extract_bilibili,
    "youtube": _extract_youtube,
    "xiaohongshu": _extract_xiaohongshu,
}


def extract_video_identity(url: Any) -> dict | None:
    """The platform identity a URL carries, per platform-video-id-rules.md.
    Returns None when no identity is confirmable from the URL alone;
    never throws on any input."""
    parsed = safe_parse_url(url)
    if parsed is None:
        return None
    platform_id = _platform_id_for_host(parsed.hostname or "")
    if platform_id is None:
        return None
    try:
        return _EXTRACTORS[platform_id](parsed)
    except Exception:
        return None


# The §1 platformVideoId formats, one regex per platform — the SAME
# regexes the extractors pin above, consumed by the API's declared-identity
# validation (parse_identity) so a URL that extracts an identity and a
# declared one are judged by one source. Contract data, not caller state.
PLATFORM_VIDEO_ID_FORMATS: dict[str, re.Pattern] = {
    "xiaoe-tech": XIAOE_TOKEN_RE,
    "bilibili": BV_RE,
    "youtube": YT_ID_RE,
    "xiaohongshu": XHS_NOTE_RE,
}
