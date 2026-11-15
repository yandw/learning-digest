"""/v1 AI utility routes (contract-r4.md §7; ticket 6.5). The stateless
selected-text explanation: any logged-in user, no collection of its own —
the D18 usage counters are the only record a call happened. The digest
endpoints stay with the session routes (they are Session-scoped); this
module holds the AI-utility surface that outlives any one Session.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from .ctx import AppContext
from .explanations import explain
from .http import read_json_body
from .routes_auth import CtxDep, CredentialDep


def register_ai_routes(app, ctx: AppContext) -> None:
    @app.post("/v1/ai/explain")
    async def post_ai_explain(
        request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Selected-text explanation (contract-r4 §7.2, ticket 6.5): the
        # body carries the selection and its optional context; the domain
        # owns the shape validation (400 family) and the failure envelope.
        body = await read_json_body(request, ctx.config.max_body_bytes)
        result = explain(
            store=ctx.store,
            account_id=credential["accountId"],
            body=body,
            ai_provider=ctx.ai_provider,
            now=ctx.now,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])
