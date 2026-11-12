"""App factory: wires the /v1 auth routes onto a FastAPI application with
all seams injectable (store, mailer, clock, config). Port of lib/app.js's
factory minus the node:http plumbing (FastAPI/Starlette replaces it) —
the error envelope and CORS behavior are the contract-visible parts.

The uniform error envelope ({ error: { code, message } }) is installed as
exception handlers so EVERY non-2xx path — routing 404s, method errors,
domain ApiErrors — speaks the contract envelope with the fixture copy.
"""

from __future__ import annotations

import sys
import time
from typing import Any, Callable

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import Config, resolve_config
from .cors import V1CorsMiddleware
from .ctx import AppContext
from .errors import ApiError, internal_error, method_not_allowed, not_found_unknown_path
from .invites import load_seed_invites
from .mailer import create_memory_mailer
from .persistence import create_memory_store
from .routes_auth import register_auth_routes
from .routes_resources import register_resources_routes


def _default_now() -> int:
    return int(time.time() * 1000)


def create_app(
    *,
    store: Any | None = None,
    mailer: Any | None = None,
    now: Callable[[], int] | None = None,
    config: dict | None = None,
    seed_file: str | None = None,
) -> FastAPI:
    store = store if store is not None else create_memory_store()
    mailer = mailer or create_memory_mailer()
    now = now or _default_now
    cfg: Config = resolve_config(config)

    # Invited emails are data: the seed file is loaded into the store on
    # every startup, idempotently (the invite CLI adds more at runtime).
    load_seed_invites(store, seed_file, now)

    ctx = AppContext(store=store, mailer=mailer, now=now, config=cfg, seed_file=seed_file)

    app = FastAPI()
    app.state.ctx = ctx
    # CORS owns /v1 (the extension's service worker fetches these paths
    # cross-origin); an OPTIONS preflight is answered here and never
    # reaches the router.
    app.add_middleware(V1CorsMiddleware)
    _register_error_handlers(app)
    register_auth_routes(app, ctx)
    register_resources_routes(app, ctx)
    return app


def _register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def handle_api_error(request, exc: ApiError):
        return JSONResponse(status_code=exc.status, content=exc.to_body())

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            error = not_found_unknown_path()
        elif exc.status_code == 405:
            error = method_not_allowed()
        else:
            error = ApiError(exc.status_code, internal_error().code, internal_error().message)
        return JSONResponse(
            status_code=error.status,
            content=error.to_body(),
            headers=dict(getattr(exc, "headers", None) or {}),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation(request, exc: RequestValidationError):
        # Safety net: route-level validation mirrors Node's field checks, so
        # this only fires for shapes Node would have covered there.
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "validation_failed", "message": "请求参数校验失败"}},
        )

    @app.exception_handler(Exception)
    async def handle_unhandled(request, exc: Exception):
        # Unknown failure: log for the operator, never leak internals to callers.
        sys.stderr.write(f"[api] unhandled error: {exc!r}\n")
        return JSONResponse(status_code=500, content=internal_error().to_body())
