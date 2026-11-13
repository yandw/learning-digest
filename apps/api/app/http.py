"""node:http plumbing shared by all routes: body reading with a size cap.
Port of lib/http.js's readBody/readJsonBody. JSON responses and the error
envelope live in FastAPI handlers (app_factory._register_error_handlers)."""

from __future__ import annotations

import json
import re

from fastapi import Request

from .errors import validation_failed


async def read_raw_body(request: Request, max_bytes: int) -> str:
    body = await request.body()
    if len(body) > max_bytes:
        raise validation_failed("请求体过大")
    # Node's Buffer.toString("utf8") replaces invalid sequences; mirror it.
    return body.decode("utf-8", errors="replace")


async def read_json_body(request: Request, max_bytes: int):
    """Parse a request body as JSON. An empty body parses to `None`
    (routes then report their own missing-field errors)."""
    raw = await read_raw_body(request, max_bytes)
    if raw.strip() == "":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise validation_failed("请求体不是合法 JSON") from None


_BEARER_PATTERN = re.compile(r"^Bearer\s+(\S+)$", re.IGNORECASE)


def bearer_token(request: Request) -> str | None:
    """Extract the Bearer token from the Authorization header, or None when
    the header is absent or not Bearer (RFC 7235: scheme is
    case-insensitive). Shared by the auth guard and the worker guard."""
    header = request.headers.get("authorization")
    if not isinstance(header, str):
        return None
    match = _BEARER_PATTERN.match(header.strip())
    return match.group(1).strip() if match else None
