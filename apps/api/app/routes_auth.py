"""/v1 route registration. Auth routes (request-code / verify / logout /
link-requests / link / me) are added slice by slice; later round-4 tickets
append resource/source/session routes here. Port of lib/routes.js.

The Bearer guard arrives with the /v1/me slice; request-code is public.
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from .accounts import open_or_login
from .codes import issue_code
from .ctx import AppContext
from .credentials import (
    authenticate,
    find_credential_by_token,
    issue_credential,
    revoke_credential_group,
)
from .errors import unauthorized_expired, unauthorized_missing
from .http import read_json_body
from .invites import is_invited
from .link_codes import consume_link_code, create_link_code
from .requests import LinkBody, RequestCodeBody, VerifyBody



def _body_dict(body) -> dict:
    """Non-object bodies (arrays, strings, numbers, null) answer the
    missing-field error for the endpoint's first required field, exactly
    like lib/routes.js requireEmail/verify do."""
    return body if isinstance(body, dict) else {}


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx


from .http import bearer_token  # noqa: E402  (moved to http.py; audio_jobs uses it too)


def require_credential(
    request: Request,
    ctx: Annotated[AppContext, Depends(get_ctx)],
) -> dict:
    """Guard for protected endpoints (fastapi Depends): 401 with the
    contract fixture bodies — missing header -> "未登录或凭据缺失";
    unknown/revoked token (or a credential whose whole group was revoked)
    -> "凭据已失效，请重新登录并关联"."""
    token = bearer_token(request)
    if not token:
        raise unauthorized_missing()
    credential = authenticate(store=ctx.store, token=token)
    if not credential:
        raise unauthorized_expired()
    return credential


# Shared dependency annotations (later domains import these).
CtxDep = Annotated[AppContext, Depends(get_ctx)]
CredentialDep = Annotated[dict, Depends(require_credential)]


def register_auth_routes(app, ctx: AppContext) -> None:
    @app.post("/v1/auth/request-code")
    async def request_code(request: Request) -> JSONResponse:
        # decision 3: invited email -> code email. The response is uniform
        # for invited and uninvited addresses so the endpoint cannot be
        # used to enumerate the invite list.
        body = await read_json_body(request, ctx.config.max_body_bytes)
        payload = RequestCodeBody.model_validate(_body_dict(body))
        email = payload.email
        if is_invited(ctx.store, email):
            await issue_code(
                store=ctx.store,
                email=email,
                now=ctx.now,
                config=ctx.config,
                mailer=ctx.mailer,
            )
        return JSONResponse(status_code=200, content={"ok": True})

    @app.post("/v1/auth/verify")
    async def verify(request: Request) -> JSONResponse:
        # A correct code opens the account (201) or logs in (200); both
        # issue a Web credential into the active credential group.
        body = await read_json_body(request, ctx.config.max_body_bytes)
        payload = VerifyBody.model_validate(_body_dict(body))
        result = open_or_login(
            store=ctx.store,
            email=payload.email,
            code=payload.code,
            now=ctx.now,
            config=ctx.config,
        )
        return JSONResponse(status_code=201 if result["opened"] else 200, content=result)

    @app.get("/v1/me")
    async def me(credential: CredentialDep, ctx: CtxDep) -> JSONResponse:
        # The round-1 protected endpoint: proves Bearer auth and gives
        # clients a way to inspect the logged-in account.
        account = next(
            (entry for entry in ctx.store.list("accounts") if entry["id"] == credential["accountId"]),
            None,
        )
        return JSONResponse(
            status_code=200,
            content={"account": {"id": credential["accountId"], "email": account["email"] if account else None}},
        )

    @app.post("/v1/auth/logout")
    async def logout(request: Request) -> JSONResponse:
        # Linked logout (P7, decision 3 of #49): the presented credential's
        # WHOLE credential group is revoked, so the Web session and the
        # extension credential die together (contract §1: 401 = expired OR
        # linked-revoked). A repeat logout with an already-revoked
        # credential stays a 200 no-op; a token the server never issued is
        # still the expired-token 401 body.
        token = bearer_token(request)
        if not token:
            raise unauthorized_missing()
        record = find_credential_by_token(store=ctx.store, token=token)
        if not record:
            raise unauthorized_expired()
        revoke_credential_group(store=ctx.store, group_id=record["credentialGroupId"], now=ctx.now)
        return JSONResponse(status_code=200, content={"ok": True})

    # --- P6: extension account linking (decision 3 of #49) ---

    @app.post("/v1/auth/link-requests")
    async def link_requests(credential: CredentialDep) -> JSONResponse:
        # The Web confirmation page (presenting its own Bearer credential)
        # creates a one-time short-lived link code bound to its credential
        # group. The page bounces the browser to a success address carrying
        # the code; the extension reads it from the tab it opened.
        created = create_link_code(store=ctx.store, credential=credential, now=ctx.now, config=ctx.config)
        return JSONResponse(status_code=201, content=created)

    @app.post("/v1/auth/link")
    async def link(request: Request) -> JSONResponse:
        # The extension exchanges the code (no Bearer: it has no credential
        # yet) for a live extension credential joined into the confirming
        # Web session's credential group. One exchange per code; a group
        # revoked in the meantime fails the exchange.
        body = await read_json_body(request, ctx.config.max_body_bytes)
        payload = LinkBody.model_validate(_body_dict(body))
        consumed = consume_link_code(store=ctx.store, code=payload.code, now=ctx.now)
        issued = issue_credential(
            store=ctx.store,
            account_id=consumed["accountId"],
            kind="extension",
            now=ctx.now,
            config=ctx.config,
            credential_group_id=consumed["credentialGroupId"],
        )
        account = next(
            (entry for entry in ctx.store.list("accounts") if entry["id"] == consumed["accountId"]),
            None,
        )
        return JSONResponse(
            status_code=201,
            content={
                "account": {
                    "id": consumed["accountId"],
                    "email": account["email"] if account else None,
                },
                "credential": {
                    "token": issued["token"],
                    "kind": issued["credential"]["kind"],
                    "credentialGroupId": issued["credential"]["credentialGroupId"],
                },
            },
        )
