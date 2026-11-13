"""/v1 session-domain routes (contract-r2.md §3.1–3.5; ticket 4.3). Port of
the round-2 slice of lib/routes.js + lib/sessions.js + lib/transcripts.js
route registrations. The audio-segment upload and worker task endpoints
live here too (they are the write side of the Session transcript), as does
the usage read endpoint the transcription write-back accrues into.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from .audio_jobs import (
    AUDIO_BODY_MAX_BYTES,
    apply_task_result,
    claim_tasks,
    ingest_audio_segment,
    parse_claim_limit,
    require_worker_credential,
)
from .ctx import AppContext
from .http import read_json_body
from .routes_auth import CtxDep, CredentialDep
from .sessions import create_session, find_account_session, finish_session
from .transcripts import archive_captions, get_transcript
from .usage import usage_view


def register_sessions_routes(app, ctx: AppContext) -> None:
    @app.post("/v1/sources/{source_id}/sessions")
    async def post_session(
        source_id: str, request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Start learning (contract-r2 §3.1): the body is an empty object —
        # identity comes from the credential, the target from the path — so
        # it is read (like Node's readJsonBody) and then ignored.
        await read_json_body(request, ctx.config.max_body_bytes)
        result = create_session(
            store=ctx.store,
            account_id=credential["accountId"],
            source_id=source_id,
            now=ctx.now,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.post("/v1/sessions/{session_id}/finish")
    async def post_finish(
        session_id: str, request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Close learning (contract-r2 §3.2): optional gaps, 409 on repeat
        # finish (a state transition, not a creation).
        body = await read_json_body(request, ctx.config.max_body_bytes)
        result = finish_session(
            store=ctx.store,
            account_id=credential["accountId"],
            session_id=session_id,
            body=body,
            now=ctx.now,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.post("/v1/sessions/{session_id}/captions")
    async def post_captions(
        session_id: str, request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Captions direct archive (contract-r2 §3.3): as-read archive, the
        # first submission locks origin "captions" (D15), a resend replays
        # the stored archive (首存为准).
        body = await read_json_body(request, ctx.config.max_body_bytes)
        session = find_account_session(
            store=ctx.store, account_id=credential["accountId"], session_id=session_id
        )
        result = archive_captions(store=ctx.store, session=session, body=body)
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.get("/v1/sessions/{session_id}/transcript")
    async def get_session_transcript(
        session_id: str, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Transcript polling (contract-r2 §3.5): the bare TranscriptView,
        # idempotent reads, monotonic states (D12). Cross-account and
        # unknown ids are the same 404 (D2).
        session = find_account_session(
            store=ctx.store, account_id=credential["accountId"], session_id=session_id
        )
        result = get_transcript(store=ctx.store, session=session)
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.post("/v1/sessions/{session_id}/audio-segments")
    async def post_audio_segment(
        session_id: str, request: Request, credential: CredentialDep, ctx: CtxDep
    ) -> JSONResponse:
        # Audio segmented upload (contract-r2 §3.4; D11/D15): the route
        # widens its own body cap to carry ~10MB of base64 audio, then the
        # domain does the precise per-field validation. First store wins
        # per (sessionId, segmentIndex); the enqueue's crash window
        # self-heals on resend.
        body = await read_json_body(request, AUDIO_BODY_MAX_BYTES)
        result = ingest_audio_segment(
            store=ctx.store,
            now=ctx.now,
            config=ctx.config,
            account_id=credential["accountId"],
            session_id=session_id,
            body=body,
        )
        return JSONResponse(status_code=result["status"], content=result["body"])

    # --- Worker task endpoints (contract-r2 §3.7; D13 pull model) ----------

    @app.post("/v1/worker/tasks/claim")
    async def post_worker_claim(request: Request, ctx: CtxDep) -> JSONResponse:
        # Worker credential only (§3.7, D13): never a user credential; an
        # empty configured token fails closed.
        require_worker_credential(request=request, config=ctx.config)
        body = await read_json_body(request, ctx.config.max_body_bytes)
        result = claim_tasks(store=ctx.store, now=ctx.now, limit=parse_claim_limit(body))
        return JSONResponse(status_code=result["status"], content=result["body"])

    @app.post("/v1/worker/tasks/{task_id}/result")
    async def post_worker_result(
        task_id: str, request: Request, ctx: CtxDep
    ) -> JSONResponse:
        # Worker credential only (§3.7): first result wins, terminal states
        # never roll back; a done result deletes the audio (D14).
        require_worker_credential(request=request, config=ctx.config)
        body = await read_json_body(request, ctx.config.max_body_bytes)
        result = apply_task_result(store=ctx.store, task_id=task_id, body=body, now=ctx.now)
        return JSONResponse(status_code=result["status"], content=result["body"])

    # --- Usage read (contract-r3 §3.4; D18) ---------------------------------

    @app.get("/v1/usage")
    async def get_usage(credential: CredentialDep, ctx: CtxDep) -> JSONResponse:
        # Account usage totals: the bare Usage, account-scoped by the
        # presented credential. Read-only record of what landed (done audio
        # seconds via the write-back; summary counters via the summary
        # domain's landing writes, ticket 4.4).
        body = usage_view(store=ctx.store, account_id=credential["accountId"])
        return JSONResponse(status_code=200, content=body)
