"""Session rolling summary + overview domain (contract-r4.md §6, ticket 6.4,
issue #89; ADR 0002). Server-side port of the PoC's topic-tick path
(apps/extension/session-summary.js @ f0d2c60).

Owns the "sessionInsights" collection: one document per Session that has a
generated overview, keyed by the session id (like "transcripts" — no new
ID prefix) —

  { sessionId, accountId, resourceId, topics, lastCoveredMs,
    generation: { provider, model, inputChars }, generatedAt, generatedAtMs }

`topics` is the append-only Topic timeline (ADR 0002): each accepted tick
appends new Topics built from the archived records since the coverage
cursor (the end of the last Topic, or 0) — earlier Topics are never
rewritten and `index` (1-based) continues across ticks. The whole document
is re-landed per tick (the latest overview overwrites the stored one); the
append-only rule lives inside `topics`, not in document history.

PoC alignment: the tick input is the PoC's assembleTopicTickInput —
newTranscript (records with startMs >= cursor, the shared coveredUntil
convention: a record counts as covered when its start is strictly below
the cursor), a 120s context-only overlap tail before the cursor, and the
existing Topics' titles (the continuation anchor). The PoC's debounce
(>=15min coverage or >=10 records) and its timer stay with the caller
(issue: 防抖语义由调用方控制): the server ticks whenever it is called with
new material, and answers an idempotent replay — the current overview,
no AI call, nothing re-landed — when the window is empty. The PoC's
session-relative seconds become the source-timeline milliseconds the
transcript domain already speaks, so Topic ranges share one timeline with
the records and the course-summary citations.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from .errors import ApiError, not_found_session
from .jsnum import is_js_integer
from .summaries import count_code_points, extract_fenced_block
from .timeutil import iso_seconds_from_ms
from .transcripts import load_state
from .usage import record_rolling_summary_generation

# D17 precedent: the prompt template is the contract record at the repo root.
PROMPT_FILE = Path(__file__).resolve().parents[3] / "prompts" / "topic-tick.md"

# PoC constants: TOPIC_OVERLAP_SECONDS = 120; the caps mirror the PoC's
# Overview validator (TOPIC_TITLE_MAX_LENGTH / TOPIC_TEXT_MAX_LENGTH).
TOPIC_OVERLAP_MS = 120_000
TOPIC_TITLE_MAX_LENGTH = 300
TOPIC_TEXT_MAX_LENGTH = 1500

NOTHING_MARKER = "（无）"

_cached_template: dict | None = None

TICK_VARIABLE = re.compile(
    r"\{(existingTopicTitlesLines|lastTopicTitle|contextTranscriptText|newTranscriptText)\}"
)


def no_session_transcript_to_summarize() -> ApiError:
    return ApiError(
        409,
        "no_session_transcript_to_summarize",
        "这次学习还没有可总结的逐字稿记录，先归档后再生成",
    )


def overview_not_generated() -> ApiError:
    return ApiError(
        404,
        "overview_not_generated",
        "这次学习还没有生成过概览，先发起一次滚动摘要",
    )


def rolling_summary_failed() -> ApiError:
    return ApiError(
        502,
        "rolling_summary_failed",
        "滚动摘要生成失败，请稍后重试；本次尝试不改变概览",
    )


def load_topic_tick_template() -> dict:
    """Load (and cache) the { system, user, first_batch_user } template from
    the contract file (the course-summary template loader's three-section
    shape: the first tick of a Session fills the first-batch variant)."""
    global _cached_template
    if _cached_template is None:
        markdown = PROMPT_FILE.read_text(encoding="utf-8")
        _cached_template = {
            "system": extract_fenced_block(markdown, "## System prompt"),
            "user": extract_fenced_block(markdown, "## User prompt"),
            "first_batch_user": extract_fenced_block(markdown, "## First batch user prompt"),
        }
    return _cached_template


def fill_tick_template(template: str, values: dict) -> str:
    """Fill the tick template's four variables in ONE pass (a fill value
    that itself contains a `{...}` token is never re-replaced; an unknown
    placeholder stays visible). String arguments may be wrapped in
    functions for lazy assembly.

    Missing values fill as the EMPTY string and values are str()-coerced —
    deliberately one notch stricter than the course-summary filler
    (app/summaries.py fill_template), which leaves a missing placeholder
    visible and returns values uncoerced. The four domain fillers share the
    one-pass shape but keep their own variable regexes; the divergence is
    documented, not unified."""
    filled = dict(values)

    def replace(match: re.Match) -> str:
        name = match.group(0)[1:-1]
        fill = filled[name] if name in filled else ""
        return fill() if callable(fill) else str(fill)

    return TICK_VARIABLE.sub(replace, template)


def load_insight(store: Any, session_id: str) -> dict | None:
    """Load one Session's overview document, or None when none was ever
    generated."""
    return store.get("sessionInsights", session_id)


def topic_cursor(topics: list) -> int:
    """The coverage cursor: the end of the last Topic, or 0 when none exist
    (the PoC's topicCursor). Transcript at or after this point is what the
    next tick summarizes."""
    return max((topic["endMs"] for topic in topics), default=0)


def next_topic_index(topics: list) -> int:
    """The next Topic's index: one past the highest stored index (the
    numbering continues across ticks; topics are append-only, so this is
    len+1 in practice — the max keeps it true even for degenerate data)."""
    return max((topic.get("index", 0) for topic in topics), default=0) + 1


def sanitize_topic_entry(entry: Any) -> dict | None:
    """Port of the PoC's sanitizeTopicEntry: a usable Topic is an object
    carrying a valid time range (non-negative integer ms, endMs >= startMs)
    plus a non-empty title and text (trimmed, length-capped);
    `continuation` survives only as a true flag. The model's `start`/`end`
    land as the contract's `startMs`/`endMs`."""
    if not isinstance(entry, dict):
        return None
    start, end = entry.get("start"), entry.get("end")
    if not is_js_integer(start) or not is_js_integer(end) or start < 0 or end < 0:
        return None
    start, end = int(start), int(end)
    if end < start:
        return None
    title = entry.get("title")
    text = entry.get("text")
    title = title.strip()[:TOPIC_TITLE_MAX_LENGTH] if isinstance(title, str) else ""
    text = text.strip()[:TOPIC_TEXT_MAX_LENGTH] if isinstance(text, str) else ""
    if not title or not text:
        return None
    topic = {"startMs": start, "endMs": end, "title": title, "text": text}
    if entry.get("continuation") is True:
        topic["continuation"] = True
    return topic


def assemble_tick_input(*, store: Any, session_id: str, insight: dict | None) -> dict:
    """Assemble one tick's input (the PoC's assembleTopicTickInput):
    { cursor, new_records, overlap_tail, existing_topic_titles }. The
    records follow the video timeline (startMs-ascending), so a late
    write-back lands in its right place in the prompt."""
    records = sorted(load_state(store, session_id)["records"], key=lambda r: r["startMs"])
    topics = list(insight["topics"]) if insight else []
    cursor = topic_cursor(topics)
    new_records = [record for record in records if record["startMs"] >= cursor]
    overlap_tail: list[dict] = []
    if cursor > 0:
        # Strictly inside the tail window (PoC): a record ending exactly at
        # the cutoff covers nothing after it, and one at/after the cursor is
        # already new input.
        tail_cutoff = cursor - TOPIC_OVERLAP_MS
        overlap_tail = [
            record
            for record in records
            if record["startMs"] < cursor and record["endMs"] > tail_cutoff
        ]
    return {
        "cursor": cursor,
        "records": records,
        "new_records": new_records,
        "overlap_tail": overlap_tail,
        "existing_topic_titles": [topic["title"] for topic in topics],
    }


def stamped_lines(records: list) -> list[str]:
    """`[startMs–endMs] text` lines — the stamp convention the migrated
    prompt documents, so the model copies start/end from the line marks."""
    return [f"[{record['startMs']}–{record['endMs']}] {record['text']}" for record in records]


def build_tick_prompt(*, template: dict, tick_input: dict) -> dict:
    """Assemble the tick's { system, user, inputChars }: the first-batch
    user template when no Topics exist yet, otherwise the continuation
    template naming the prior Topics. inputChars is the full submitted
    prompt (system + user, code points) — the same number usage reports."""
    titles = tick_input["existing_topic_titles"]
    first_batch = not titles
    user_template = template["first_batch_user"] if first_batch else template["user"]

    context_text = "\n".join(stamped_lines(tick_input["overlap_tail"]))
    new_text = "\n".join(stamped_lines(tick_input["new_records"]))
    values: dict = {
        "contextTranscriptText": context_text or NOTHING_MARKER,
        "newTranscriptText": new_text,
    }
    if not first_batch:
        values["existingTopicTitlesLines"] = "\n- ".join(titles)
        values["lastTopicTitle"] = titles[-1]
    user = fill_tick_template(user_template, values)
    return {
        "system": template["system"],
        "user": user,
        "inputChars": count_code_points(template["system"]) + count_code_points(user),
    }


def serialize_overview(insight: dict) -> dict:
    """Contract-r4 §6.1 full shape."""
    return {
        "sessionId": insight["sessionId"],
        "topics": insight["topics"],
        "lastCoveredMs": insight["lastCoveredMs"],
        "generation": insight["generation"],
        "generatedAt": insight["generatedAt"],
    }


def generate_rolling_summary(
    *,
    store: Any,
    account_id: str,
    session: dict | None,
    ai_provider: Any,
    now: Callable[[], int],
) -> dict:
    """POST /v1/sessions/{id}/rolling-summary (contract-r4 §6.2): assemble
    -> provider -> append -> land + count. The D2 lookup result is passed
    in (None is the same 404 whether the id is unknown or another
    account's). Idempotent: a call whose window is empty replays the
    current overview (200, no AI call, nothing re-landed); a first
    generation answers 201, an append 200. Any provider failure (raise,
    timeout, unparseable, zero usable Topics) becomes the 502 with nothing
    written — 概览与用量都不出现本次尝试."""
    if not session:
        raise not_found_session()
    insight = load_insight(store, session["id"])
    tick_input = assemble_tick_input(store=store, session_id=session["id"], insight=insight)
    if not tick_input["records"]:
        raise no_session_transcript_to_summarize()
    if not tick_input["new_records"]:
        # Idempotent replay: nothing new since the cursor — the current
        # overview without a regeneration (the caller owns the debounce).
        return {"status": 200, "body": {"overview": serialize_overview(insight)}}

    prompt = build_tick_prompt(template=load_topic_tick_template(), tick_input=tick_input)
    try:
        raw_topics = ai_provider.generate_topics(system=prompt["system"], user=prompt["user"])
    except Exception:
        raise rolling_summary_failed() from None
    sanitized = [
        topic
        for topic in (sanitize_topic_entry(entry) for entry in (raw_topics or []))
        if topic
    ]
    if not sanitized:
        raise rolling_summary_failed()

    prior = list(insight["topics"]) if insight else []
    appended = [
        {"index": index, **topic}
        for index, topic in enumerate(sanitized, next_topic_index(prior))
    ]
    topics = prior + appended
    at_ms = now()
    document = {
        "sessionId": session["id"],
        "accountId": account_id,
        "resourceId": session["resourceId"],
        "topics": topics,
        "lastCoveredMs": topic_cursor(topics),
        "generation": {
            "provider": ai_provider.id,
            "model": ai_provider.model,
            "inputChars": prompt["inputChars"],
        },
        "generatedAt": iso_seconds_from_ms(at_ms),
        "generatedAtMs": at_ms,
    }
    store.set("sessionInsights", session["id"], document)
    # D18 口径: the usage counters land with the overview (201/200's same
    # moment); a failed tick or a replay records nothing.
    record_rolling_summary_generation(
        store=store, account_id=account_id, input_chars=prompt["inputChars"], now=now
    )
    return {"status": 200 if insight else 201, "body": {"overview": serialize_overview(document)}}


def get_overview(*, store: Any, session: dict | None) -> dict:
    """GET /v1/sessions/{id}/overview (contract-r4 §6.2): the bare current
    overview. The caller passes the D2 lookup result — None is the same
    404 for an unknown id and another account's session; a known session
    with no generated overview is the 404 overview_not_generated."""
    if not session:
        raise not_found_session()
    insight = load_insight(store, session["id"])
    if not insight:
        raise overview_not_generated()
    return {"status": 200, "body": {"overview": serialize_overview(insight)}}
