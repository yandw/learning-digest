"""/v1 course-summary routes (contract-r3.md §3.1–3.3; ticket 4.4). Port
of the round-3 slice of lib/routes.js + lib/summaries.js route
registrations (registerSummaryRoutes). The AI provider is resolved once
at startup by app.ai_providers.select_ai_provider and injected through
create_app — tests swap it for stubs/fault-injectors there.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from .ctx import AppContext
from .routes_auth import CtxDep, CredentialDep
from .summaries import generate_summary, get_summary, list_summaries


def register_summaries_routes(app, ctx: AppContext) -> None:
    @app.post("/v1/resources/{resource_id}/summaries")
    async def post_summary(
        resource_id: str, request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Generate a course summary (contract-r3 §3.1): the request body is
        # an empty object by contract (no client-side input trimming, D17) —
        # nothing to validate, nothing to read.
        result = generate_summary(
            store=ctx.store,
            account_id=credential["accountId"],
            resource_id=resource_id,
            ai_provider=ctx.ai_provider,
            now=ctx.now,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.get("/v1/resources/{resource_id}/summaries")
    async def get_resource_summaries(
        resource_id: str, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Historical generations, newest first (contract-r3 §3.2).
        result = list_summaries(
            store=ctx.store, account_id=credential["accountId"], resource_id=resource_id
        )
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.get("/v1/summaries/{summary_id}")
    async def get_summary_detail(
        summary_id: str, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # One generation's full shape; cross-account is the same 404 (D2).
        result = get_summary(
            store=ctx.store, account_id=credential["accountId"], summary_id=summary_id
        )
        return JSONResponse(status_code=result["status"], content=result["body"])
