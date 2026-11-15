"""/v1 AI utility routes (contract-r4.md §7; ticket 6.5). The stateless
selected-text explanation: any logged-in user, no collection of its own —
the D18 usage counters are the only record a call happened. The digest
endpoints stay with the session routes (they are Session-scoped); this
module holds the AI-utility surface that outlives any one Session.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from .ctx import AppContext
from .explanations import explain
from .http import read_json_body
from .routes_auth import CtxDep, CredentialDep


async def explain_body(request: Request) -> Any:
    """The explain request body as an async dependency: reading/parsing
    stays on the event loop while the sync (def) route below runs its
    blocking AI pass in the threadpool; oversize/invalid JSON answer 400
    exactly as when the route awaited inline. Module-level (not a closure)
    because this file uses `from __future__ import annotations` — a
    Depends() closure name inside a parameter annotation cannot be
    evaluated against module globals (Python 3.14 lazy annotations) and
    the parameter would degrade into a required query parameter."""
    ctx: AppContext = request.app.state.ctx
    return await read_json_body(request, ctx.config.max_body_bytes)


def register_ai_routes(app, ctx: AppContext) -> None:
    @app.post("/v1/ai/explain")
    def post_ai_explain(
        credential: CredentialDep,
        ctx: CtxDep,
        body: Annotated[Any, Depends(explain_body)],
    ) -> JSONResponse:
        # Selected-text explanation (contract-r4 §7.2, ticket 6.5): the
        # body carries the selection and its optional context; the domain
        # owns the shape validation (400 family) and the failure envelope.
        #
        # def, not async: explain is a blocking sync AI pass (provider call);
        # FastAPI runs def routes in the threadpool, so one slow explanation
        # no longer serializes the event loop for every other request.
        result = explain(
            store=ctx.store,
            account_id=credential["accountId"],
            body=body,
            ai_provider=ctx.ai_provider,
            now=ctx.now,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])
