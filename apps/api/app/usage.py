"""Account usage accounting (contract-r3.md §2.4/§3.4; decision D18;
contract-r4.md §6.3 extends the row with the rolling-summary counters,
ticket 6.4; §7 extends it with the digest and explain counters, ticket
6.5). Port of lib/usage.js.

One "usage" row per account, keyed by accountId:

  { accountId, audioMs, summaryCount, summaryInputChars,
    rollingSummaryCount, rollingSummaryInputChars,
    digestCount, digestInputChars, explainCount, explainInputChars,
    updatedAt, updatedAtMs }

D18 口径 (record-only, no billing): the recording timepoints are all
"the moment a product lands" —
- audioMs accrues when an audio segment task FIRST reaches done (the
  write-back's 首存为准 replay path never re-records; the caller in
  app/audio_jobs.py sits behind that gate). Read as
  audioSeconds = floor(audioMs / 1000), so fractional seconds only round
  once at the account level. Transcribing and failed segments never reach
  this module; a silent segment (done with records: []) does.
- summaryCount/summaryInputChars accrue when a summary generation lands
  (201, app/summaries.py); a failed generation records nothing.
- rollingSummaryCount/rollingSummaryInputChars accrue when a rolling-
  summary tick lands (contract-r4 §6.3, same D18 structure): one counter
  pair per landed tick, a failed tick and an idempotent replay (no AI
  call) record nothing.
- digestCount/digestInputChars accrue when a Session Digest lands
  (contract-r4 §7, app/session_digest.py): one pair per landed
  generation — overwrites included, because an overwrite IS a real AI
  call (the digest has no idempotent replay: 整节一次性, D22); a failed
  attempt records nothing.
- explainCount/explainInputChars accrue when a selected-text explanation
  answers successfully (contract-r4 §7, app/explanations.py): a
  stateless call's only landing is the answer itself; a failed call
  records nothing.

Monotonic by contract (no delete endpoints); updatedAt advances only on a
recording write — before the first write the projection reports
updatedAt: null ("nothing counted yet").
"""

from __future__ import annotations

from typing import Any, Callable

from .timeutil import iso_seconds_from_ms


def empty_usage(account_id: str) -> dict:
    return {
        "accountId": account_id,
        "audioMs": 0,
        "summaryCount": 0,
        "summaryInputChars": 0,
        "rollingSummaryCount": 0,
        "rollingSummaryInputChars": 0,
        "digestCount": 0,
        "digestInputChars": 0,
        "explainCount": 0,
        "explainInputChars": 0,
        "updatedAt": None,
        "updatedAtMs": None,
    }


def load_usage(store: Any, account_id: str) -> dict | None:
    """Load one account's usage row, or None when nothing was ever recorded."""
    return store.get("usage", account_id)


def record_audio_seconds(
    *, store: Any, account_id: str, duration_ms: int, now: Callable[[], int]
) -> dict:
    """Record audio duration (ms) against the account (D18: the first-done
    gate lives with the caller)."""
    row = load_usage(store, account_id) or empty_usage(account_id)
    row["audioMs"] += duration_ms
    at_ms = now()
    row["updatedAt"] = iso_seconds_from_ms(at_ms)
    row["updatedAtMs"] = at_ms
    store.set("usage", account_id, row)
    return row


def record_summary_generation(
    *, store: Any, account_id: str, input_chars: int, now: Callable[[], int]
) -> dict:
    """Record one successful summary generation (D18: count +1, inputChars
    summed). The caller (app/summaries.py generate_summary) invokes this in
    the same stroke as the summary landing — the 201's same moment."""
    row = load_usage(store, account_id) or empty_usage(account_id)
    row["summaryCount"] += 1
    row["summaryInputChars"] += input_chars
    at_ms = now()
    row["updatedAt"] = iso_seconds_from_ms(at_ms)
    row["updatedAtMs"] = at_ms
    store.set("usage", account_id, row)
    return row


def record_rolling_summary_generation(
    *, store: Any, account_id: str, input_chars: int, now: Callable[[], int]
) -> dict:
    """Record one successful rolling-summary tick (contract-r4.md §6.3, the
    D18 structure extended): rollingSummaryCount +1, rollingSummaryInputChars
    summed. The caller (app/session_insights.py generate_rolling_summary)
    invokes this in the same stroke as the overview landing; a failed tick
    and an idempotent replay never reach here."""
    row = load_usage(store, account_id) or empty_usage(account_id)
    row["rollingSummaryCount"] += 1
    row["rollingSummaryInputChars"] += input_chars
    at_ms = now()
    row["updatedAt"] = iso_seconds_from_ms(at_ms)
    row["updatedAtMs"] = at_ms
    store.set("usage", account_id, row)
    return row


def record_digest_generation(
    *, store: Any, account_id: str, input_chars: int, now: Callable[[], int]
) -> dict:
    """Record one successful Session Digest generation (contract-r4.md §7,
    the D18 structure extended): digestCount +1, digestInputChars summed.
    The caller (app/session_digest.py generate_digest) invokes this in the
    same stroke as the digest landing; a failed attempt never reaches here.
    Overwrites count again — an overwrite IS an AI call (D22: the digest
    has no idempotent replay)."""
    row = load_usage(store, account_id) or empty_usage(account_id)
    row["digestCount"] += 1
    row["digestInputChars"] += input_chars
    at_ms = now()
    row["updatedAt"] = iso_seconds_from_ms(at_ms)
    row["updatedAtMs"] = at_ms
    store.set("usage", account_id, row)
    return row


def record_explain_generation(
    *, store: Any, account_id: str, input_chars: int, now: Callable[[], int]
) -> dict:
    """Record one successful selected-text explanation (contract-r4.md §7):
    explainCount +1, explainInputChars summed. The caller
    (app/explanations.py explain) invokes this in the same stroke as the
    200 answer landing; a failed call never reaches here."""
    row = load_usage(store, account_id) or empty_usage(account_id)
    row["explainCount"] += 1
    row["explainInputChars"] += input_chars
    at_ms = now()
    row["updatedAt"] = iso_seconds_from_ms(at_ms)
    row["updatedAtMs"] = at_ms
    store.set("usage", account_id, row)
    return row


def usage_view(*, store: Any, account_id: str) -> dict:
    """Contract §2.4 projection — the bare Usage body of GET /v1/usage.
    Contract-r4 §6.3 appends the rolling-summary pair to the r3 keys;
    §7 appends the digest and explain pairs (existing keys' semantics
    unchanged)."""
    row = load_usage(store, account_id)
    return {
        "audioSeconds": row["audioMs"] // 1000 if row else 0,
        "summaryCount": row["summaryCount"] if row else 0,
        "summaryInputChars": row["summaryInputChars"] if row else 0,
        "rollingSummaryCount": row["rollingSummaryCount"] if row else 0,
        "rollingSummaryInputChars": row["rollingSummaryInputChars"] if row else 0,
        "digestCount": row["digestCount"] if row else 0,
        "digestInputChars": row["digestInputChars"] if row else 0,
        "explainCount": row["explainCount"] if row else 0,
        "explainInputChars": row["explainInputChars"] if row else 0,
        "updatedAt": row["updatedAt"] if row else None,
    }
