"""/v1 resource/source routes (contract-v1.md §3.1–§3.7). Port of the
P4/P5/P9/P12 slice of lib/routes.js. Round-4 tickets append slices here;
the sessions domain (contract-r2 §3) lands with ticket 4.3."""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from .ctx import AppContext
from .http import read_json_body
from .notes import create_note
from .progress import save_progress
from .resources import (
    create_favorite,
    get_resource_detail,
    list_resources,
    match_source,
    parse_source_request,
    present_favorite,
    retitle_resource,
)
from .routes_auth import CtxDep, CredentialDep


def register_resources_routes(app, ctx: AppContext) -> None:
    @app.post("/v1/resources")
    async def create_resource(
        request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Favorite (contract §3.1): identity hit first, else the normalized
        # address; 201 creates, 200 returns the existing Resource + Source
        # with the original first-favorited URL (D3).
        body = await read_json_body(request, ctx.config.max_body_bytes)
        parsed = parse_source_request(body)
        existing = match_source(store=ctx.store, account_id=credential["accountId"], request=parsed)
        if existing:
            return JSONResponse(
                status_code=200, content=present_favorite(store=ctx.store, **existing)
            )
        created = create_favorite(
            store=ctx.store, account_id=credential["accountId"], request=parsed, now=ctx.now
        )
        return JSONResponse(
            status_code=201, content=present_favorite(store=ctx.store, **created)
        )

    @app.get("/v1/resources")
    async def get_resources(credential: CredentialDep, ctx: CtxDep) -> JSONResponse:
        # The account's list, newest first (contract §3.2).
        result = list_resources(store=ctx.store, account_id=credential["accountId"])
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.get("/v1/resources/{resource_id}")
    async def get_resource(
        resource_id: str, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Detail with sources and notes; cross-account reads are the same
        # 404 as unknown ids (D2).
        result = get_resource_detail(
            store=ctx.store, account_id=credential["accountId"], resource_id=resource_id
        )
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.post("/v1/resources/{resource_id}/notes")
    async def add_note(
        resource_id: str, request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Add a note (contract §3.6; P12): a clientRequestId dedupes resends
        # (201 creates, 200 returns the original note); an optional
        # sourceId + positionMs pair stamps the note onto one of the
        # resource's own sources. Cross-account resources are 404 (D2).
        body = await read_json_body(request, ctx.config.max_body_bytes)
        result = create_note(
            store=ctx.store,
            account_id=credential["accountId"],
            resource_id=resource_id,
            body=body,
            now=ctx.now,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.patch("/v1/resources/{resource_id}")
    async def patch_resource(
        resource_id: str, request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Manual retitle (contract §3.7, the round-1 supplement): the body
        # accepts only { title }; the title never participates in matching.
        # Cross-account and unknown ids are the same 404 (D2), after body
        # validation like the other write endpoints.
        body = await read_json_body(request, ctx.config.max_body_bytes)
        result = retitle_resource(
            store=ctx.store,
            account_id=credential["accountId"],
            resource_id=resource_id,
            body=body,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.post("/v1/sources/resolve")
    async def resolve_source(
        request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Read-only pre-study lookup (contract §3.4): the same matching as
        # favoriting, but a miss answers matched:false and writes nothing.
        body = await read_json_body(request, ctx.config.max_body_bytes)
        parsed = parse_source_request(body)
        existing = match_source(store=ctx.store, account_id=credential["accountId"], request=parsed)
        if not existing:
            return JSONResponse(status_code=200, content={"matched": False})
        return JSONResponse(
            status_code=200,
            content={"matched": True, **present_favorite(store=ctx.store, **existing)},
        )

    @app.put("/v1/sources/{source_id}/progress")
    async def put_progress(
        source_id: str, request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Save the playback position with optimistic concurrency (contract
        # §3.5; decision D4). Semantics live in app/progress.py: rewinds
        # are legal, resends of the last write are idempotent, cross-account
        # sources are 404.
        body = await read_json_body(request, ctx.config.max_body_bytes)
        result = save_progress(
            store=ctx.store,
            account_id=credential["accountId"],
            source_id=source_id,
            body=body,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])
