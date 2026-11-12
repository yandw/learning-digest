"""Session domain (contract-r2.md §2.1, §3.1–3.2; decisions D9, D15). Port
of lib/sessions.js.

A Session is one continuous act of learning from a Source (GLOSSARY). The
round-2 transcript data (records, gaps, pending/failed audio segments) all
hangs off the Session; the round-1 progress endpoint stays untouched —
progress is still the (account, Source) single record (D9), so nothing in
this module reads or writes the "progress" collection.

Multiple sessions per Source coexist (历史归档与进行中的并存): the store
never rejects a second active Session on the same Source. `origin` starts
None and locks to "captions" or "asr" on the first transcript submission
of that path (D15, same-interval single path) — the locking itself lives
in app/transcripts.py.

Isolation (decision D2): unknown ids and other-account ids are the same
404, indistinguishable.
"""

from __future__ import annotations

from typing import Any, Callable

from .errors import not_found_session, not_found_source, session_already_finished
from .ids import generate_id
from .timeutil import iso_seconds_from_ms
from .transcripts import load_state, parse_gaps, report_gaps, transcript_summary


def serialize_session(session: dict) -> dict:
    """Contract §2.1 shape (internal fields stripped)."""
    return {
        "id": session["id"],
        "sourceId": session["sourceId"],
        "resourceId": session["resourceId"],
        "status": session["status"],
        "startedAt": session["startedAt"],
        "finishedAt": session["finishedAt"],
        "origin": session["origin"],
    }


def find_account_session(*, store: Any, account_id: str, session_id: str) -> dict | None:
    """D2 lookup: the account's Session by id, or None. Callers answer the
    same 404 for None whether the id is unknown or another account's."""
    return next(
        (
            s
            for s in store.list("sessions")
            if s["id"] == session_id and s["accountId"] == account_id
        ),
        None,
    )


def create_session(*, store: Any, account_id: str, source_id: str, now: Callable[[], int]) -> dict:
    """Start one study session on the account's Source (contract §3.1): 201
    with the active Session, `origin` still null. The request body is an
    empty object — identity comes from the credential, the target from the
    path — so there is nothing to validate beyond auth + isolation."""
    # D2: other accounts' sources and unknown ids are the same 404.
    source = next(
        (
            s
            for s in store.list("sources")
            if s["id"] == source_id and s["accountId"] == account_id
        ),
        None,
    )
    if not source:
        raise not_found_source()

    at_ms = now()
    session = {
        "id": generate_id("ses"),
        "accountId": account_id,
        "sourceId": source["id"],
        "resourceId": source["resourceId"],
        "status": "active",
        "startedAt": iso_seconds_from_ms(at_ms),
        "startedAtMs": at_ms,
        "finishedAt": None,
        "finishedAtMs": None,
        "origin": None,
    }
    store.set("sessions", session["id"], session)
    return {"status": 201, "body": {"session": serialize_session(session)}}


def finish_session(
    *,
    store: Any,
    account_id: str,
    session_id: str,
    body: Any,
    now: Callable[[], int],
) -> dict:
    """Close one study session (contract §3.2): status -> finished,
    finishedAt server-generated, the optional gaps reported into the
    Session's transcript state (§2.3). Finish is a state transition, not a
    creation (contract §1 idempotency rule): a repeat is 409
    session_already_finished — the session itself stays finished and
    unchanged, so retries never corrupt state. Unknown and other-account
    sessions are the same 404 (D2)."""
    gaps = parse_gaps(body)

    # D2: other accounts' sessions and unknown ids are the same 404.
    session = find_account_session(store=store, account_id=account_id, session_id=session_id)
    if not session:
        raise not_found_session()
    if session["status"] == "finished":
        raise session_already_finished()

    at_ms = now()
    session["status"] = "finished"
    session["finishedAt"] = iso_seconds_from_ms(at_ms)
    session["finishedAtMs"] = at_ms
    store.set("sessions", session["id"], session)
    report_gaps(store=store, session_id=session["id"], gaps=gaps)
    return {"status": 200, "body": {"session": serialize_session(session)}}


def sessions_for_resource(*, store: Any, account_id: str, resource_id: str) -> list:
    """Contract-r2 §3.6: the resource's study sessions (历史归档与进行中的
    并存), newest first by startedAt, each = Session (§2.1) + the transcript
    summary counts { recordCount, gapCount, failedCount } (§2.5 projection).
    The full transcript is read per Session through
    GET /v1/sessions/{id}/transcript."""
    sessions = [
        s
        for s in store.list("sessions")
        if s["accountId"] == account_id and s["resourceId"] == resource_id
    ]
    sessions.sort(key=lambda s: s["startedAtMs"], reverse=True)
    return [
        {**serialize_session(session), "transcript": transcript_summary(load_state(store, session["id"]))}
        for session in sessions
    ]
