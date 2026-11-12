"""Note domain (contract-v1.md §2.4, §3.6; ticket P12, issue #61). Port of
lib/notes.js.

A note belongs to one account's Resource; a timestamped note additionally
pins a sourceId + positionMs pair, and the pair must point at an actual
Source under that same Resource (a pointer at another resource's Source
is a validation failure). Plain webpage notes carry sourceId/positionMs
null — the pair is either fully present or fully absent.

Idempotent resend: the client-generated clientRequestId is the dedupe
basis (contract §1). The first POST that carries a given clientRequestId
within an account IS the note; a resend (e.g. after a network drop)
answers 200 with the original note and never writes a duplicate. The
scope is the account, not the path resource, so a resent request can
never slip past dedupe by changing the path — the original note is
returned regardless of which resource id the retry hits.

Isolation (decision D2): reads and writes run with the accountId in the
query; unknown and other-account ids are the same 404, checked before
the source pointer validation."""

from __future__ import annotations

from typing import Any

from .errors import ApiError, not_found_resource, validation_failed
from .ids import generate_id
from .jsnum import coerce_js_integer, is_js_integer
from .timeutil import iso_seconds_from_ms

NOTE_TEXT_MAX = 10000


def serialize_note(note: dict) -> dict:
    """Contract §2.4 shape (internal fields stripped)."""
    return {
        "id": note["id"],
        "resourceId": note["resourceId"],
        "sourceId": note["sourceId"],
        "positionMs": note["positionMs"],
        "text": note["text"],
        "clientRequestId": note["clientRequestId"],
        "createdAt": note["createdAt"],
    }


def notes_for_resource(*, store: Any, account_id: str, resource_id: str) -> list:
    """All of one account's notes on one resource, oldest first."""
    notes = [
        n
        for n in store.list("notes")
        if n["accountId"] == account_id and n["resourceId"] == resource_id
    ]
    notes.sort(key=lambda n: n["createdAtMs"])
    return [serialize_note(n) for n in notes]


def parse_note_request(body: Any) -> dict:
    """Validate the request body shape (contract §3.6): clientRequestId and
    non-empty text required; sourceId + positionMs optional and paired.
    Returns the normalized fields; raises the contract 400s."""
    if body is None or not isinstance(body, dict):
        raise validation_failed("请求体必须是 JSON 对象")
    client_request_id = body.get("clientRequestId")
    if client_request_id is None or client_request_id == "":
        # JS undefined and null both take the missing-field branch.
        raise validation_failed("缺少必填字段 clientRequestId")
    if not isinstance(client_request_id, str):
        raise validation_failed("clientRequestId 必须是字符串")
    text = body.get("text")
    if text is None:
        raise validation_failed("缺少必填字段 text")
    if not isinstance(text, str) or text.strip() == "":
        # The fixture sample error-validation-failed-empty-note-text pins
        # the message for the empty case.
        raise ApiError(400, "validation_failed", "笔记正文不能为空")
    if len(text) > NOTE_TEXT_MAX:
        raise validation_failed(f"笔记正文不能超过 {NOTE_TEXT_MAX} 字")

    has_source = body.get("sourceId") is not None
    has_position = body.get("positionMs") is not None
    if has_source != has_position:
        raise validation_failed("sourceId 与 positionMs 必须成对出现")
    source_id = None
    position_ms = None
    if has_source:
        if not isinstance(body["sourceId"], str) or body["sourceId"] == "":
            raise validation_failed("sourceId 必须是非空字符串")
        if not is_js_integer(body["positionMs"]) or body["positionMs"] < 0:
            raise validation_failed("positionMs 必须是非负整数")
        source_id = body["sourceId"]
        position_ms = coerce_js_integer(body["positionMs"])
    return {
        "clientRequestId": client_request_id,
        "text": text,
        "sourceId": source_id,
        "positionMs": position_ms,
    }


def create_note(*, store: Any, account_id: str, resource_id: str, body: Any, now) -> dict:
    """Create (or idempotently re-answer) one note on an account resource
    (contract §3.6). Raises the contract errors on validation (400) and
    isolation (404, D2 first — before the source pointer check)."""
    request = parse_note_request(body)

    # D2: other accounts' resources and unknown ids are the same 404, and
    # it wins over the source pointer validation below.
    resource = next(
        (
            r
            for r in store.list("resources")
            if r["id"] == resource_id and r["accountId"] == account_id
        ),
        None,
    )
    if not resource:
        raise not_found_resource()

    # Idempotent resend: the account's first note with this clientRequestId
    # is returned as-is (200), whatever the path's resource id says.
    existing = next(
        (
            n
            for n in store.list("notes")
            if n["accountId"] == account_id
            and n["clientRequestId"] == request["clientRequestId"]
        ),
        None,
    )
    if existing:
        return {"status": 200, "body": {"note": serialize_note(existing)}}

    # A timestamped note must point at an actual Source under THIS resource
    # (and account); anything else is the contract 400.
    if request["sourceId"] is not None:
        source = next(
            (
                s
                for s in store.list("sources")
                if s["id"] == request["sourceId"]
                and s["accountId"] == account_id
                and s["resourceId"] == resource_id
            ),
            None,
        )
        if not source:
            raise validation_failed("sourceId 必须指向该资料名下的来源")

    at_ms = now()
    note = {
        "id": generate_id("note"),
        "accountId": account_id,
        "resourceId": resource_id,
        "sourceId": request["sourceId"],
        "positionMs": request["positionMs"],
        "text": request["text"],
        "clientRequestId": request["clientRequestId"],
        "createdAt": iso_seconds_from_ms(at_ms),
        "createdAtMs": at_ms,
    }
    store.set("notes", note["id"], note)
    return {"status": 201, "body": {"note": serialize_note(note)}}
