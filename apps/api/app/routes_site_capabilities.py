"""/v1 site-capability routes (contract-r4.md §3; round 4 ticket 6.1,
issue #86). One user endpoint (any logged-in user reads the full table —
the extension branches captions/ASR/disabled on it) and the admin surface
(Bearer + account.isAdmin): the admin GET mirrors the user GET; the admin
PUT applies a boolean subset patch to one platform row.

The admin guard is a fastapi Depends (require_credential's pattern): a
non-admin raises the D2 404 so the surface's existence does not leak.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from .ctx import AppContext
from .errors import not_found_admin_surface, not_found_platform
from .http import read_json_body
from .routes_auth import CtxDep, CredentialDep
from .site_capabilities import list_site_capabilities, update_site_capability


def require_admin(
    credential: CredentialDep,
    ctx: CtxDep,
) -> dict:
    """Admin guard (fastapi Depends): resolves the credential's account and
    requires `isAdmin`. Everyone else — including unknown accounts — gets
    the D2 404 indistinguishable from an unknown path."""
    account = next(
        (entry for entry in ctx.store.list("accounts") if entry["id"] == credential["accountId"]),
        None,
    )
    if account is None or not account.get("isAdmin", False):
        raise not_found_admin_surface()
    return credential


# Shared admin dependency annotation (later admin endpoints import this).
AdminDep = Annotated[dict, Depends(require_admin)]


def register_site_capabilities_routes(app, ctx: AppContext) -> None:
    @app.get("/v1/site-capabilities")
    async def get_site_capabilities(credential: CredentialDep, ctx: CtxDep) -> JSONResponse:
        # Any logged-in user reads the full table: the extension decides
        # captions/ASR/disabled behavior per platform from it.
        return JSONResponse(
            status_code=200,
            content={"capabilities": list_site_capabilities(ctx.store)},
        )

    @app.get("/v1/admin/site-capabilities")
    async def get_admin_site_capabilities(admin: AdminDep, ctx: CtxDep) -> JSONResponse:
        # Admin view of the same table (admin == user GET shape: one table,
        # no divergent projections to keep in sync).
        return JSONResponse(
            status_code=200,
            content={"capabilities": list_site_capabilities(ctx.store)},
        )

    @app.put("/v1/admin/site-capabilities/{platform_id}")
    async def put_admin_site_capability(
        platform_id: str, request: Request, admin: AdminDep, ctx: CtxDep
    ) -> JSONResponse:
        # Subset patch: body carries any of captions/asr/enabled (booleans
        # only). Unmentioned fields keep their values; empty body is a
        # no-op read of the row.
        body = await read_json_body(request, ctx.config.max_body_bytes)
        row = update_site_capability(ctx.store, platform_id, body)
        if row is None:
            raise not_found_platform()
        return JSONResponse(status_code=200, content={"capability": row})
