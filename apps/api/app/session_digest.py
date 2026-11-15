"""Session Digest domain (contract-r4.md §7, ticket 6.5, issue #90).
Server-side port of the PoC's global pass (apps/extension/session-summary.js
buildGlobalPassMessages + parseGlobalPass @ f0d2c60; the rich template
semantics of report-render.js).

Owns the "sessionDigests" collection: one document per FINISHED Session
that has a generated digest, keyed by the session id (like transcripts /
sessionInsights — no new ID prefix) —

  { sessionId, accountId, resourceId, overview, topics, categories,
    quotes, todos, generation, generatedAt, generatedAtMs }

整节一次性 (D22): the digest is ONE global pass over the FULL transcript
of a finished Session, and every accepted POST regenerates it from the
full material and OVERWRITES the stored document — the opposite of the
rolling summary's append-only Topic timeline (ADR 0002). The PoC lands
its report the same way: re-running the global pass overwrites
report_<sessionId>. Overwrite-not-append is right for a finished
Session's deliverable: the material can no longer grow, so a regenerate
is always a deliberate request for a fresh full pass — history has no
readback value (D22).

PoC alignment: the input is the PoC's assembleGlobalPassInput — the full
transcript stamped `[startMs–endMs]` lines (the D21 ms-timeline
adaptation; explicit skipped ranges carry the course-summary gap marker,
the server's counterpart of the PoC's inline failure markers) and the
stored Rolling Summary's Topics as the live-topics merge hint (never
trusted input). The model reply is sanitized by the port of
parseGlobalPass: every section entry re-validated and length-capped, the
fixed five-section report always carries all five keys (the PoC's
"omit empty sections" is a renderer concern — the API's stored shape is
fixed), and a payload with nothing usable in ANY section is the 502
failure (the rolling tick's zero-usable-topics rule, D22).

Usage follows D18: the counters land with the digest (the response's same
moment); a failed attempt records nothing. Unlike the rolling tick's
idempotent replay (no AI call, no count), an overwrite IS an AI call and
counts again.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from .errors import ApiError, not_found_session
from .jsnum import is_js_integer
from .session_insights import (
    TOPIC_TEXT_MAX_LENGTH,
    TOPIC_TITLE_MAX_LENGTH,
    load_insight,
    no_session_transcript_to_summarize,
    stamped_lines,
)
from .summaries import (
    GAP_MARKER,
    NOTHING_MARKER,
    count_code_points,
    extract_fenced_block,
)
from .timeutil import iso_seconds_from_ms
from .transcripts import load_state
from .usage import record_digest_generation

# D17 precedent: the prompt template is the contract record at the repo root.
PROMPT_FILE = Path(__file__).resolve().parents[3] / "prompts" / "session-report.md"

# PoC constants (session-summary.js): the report sanitizer's caps. Topic
# title/text share the Overview validator caps (app/session_insights.py).
REPORT_QUOTE_MAX_LENGTH = 3000
REPORT_TODO_MAX_LENGTH = 500
REPORT_OVERVIEW_MAX_COUNT = 5
REPORT_OVERVIEW_MAX_LENGTH = 300
REPORT_BULLETS_MAX_COUNT = 5
REPORT_BULLET_MAX_LENGTH = 300
REPORT_CATEGORIES_MAX_COUNT = 4
REPORT_CATEGORY_POINTS_MAX_COUNT = 4
REPORT_CATEGORY_POINT_MAX_LENGTH = 300

_cached_template: dict | None = None

DIGEST_VARIABLE = re.compile(r"\{(liveTopicsLines|transcriptText)\}")


def session_not_finished() -> ApiError:
    return ApiError(
        409,
        "session_not_finished",
        "本次学习还没有结束，结束后才能生成纪要",
    )


def digest_failed() -> ApiError:
    return ApiError(
        502,
        "digest_failed",
        "纪要生成失败，请稍后重试；本次尝试不改变已有纪要",
    )


def digest_not_generated() -> ApiError:
    return ApiError(
        404,
        "digest_not_generated",
        "这次学习还没有生成过纪要，结束后先生成一次",
    )


def load_session_report_template() -> dict:
    """Load (and cache) the { system, user, user_without_topics } template
    from the contract file (the course-summary template loader's
    fenced-block shape; the live-topics variant when the Session carries a
    Rolling Summary, the bare transcript otherwise)."""
    global _cached_template
    if _cached_template is None:
        markdown = PROMPT_FILE.read_text(encoding="utf-8")
        _cached_template = {
            "system": extract_fenced_block(markdown, "## System prompt"),
            "user": extract_fenced_block(markdown, "## User prompt"),
            "user_without_topics": extract_fenced_block(
                markdown, "## User prompt without topics"
            ),
        }
    return _cached_template


def fill_digest_template(template: str, values: dict) -> str:
    """Fill the digest template's two variables in ONE pass (the tick
    template's fill semantics: a fill value that itself contains a `{...}`
    token is never re-replaced; an unknown placeholder stays visible;
    missing values fill as the EMPTY string and values are str()-coerced —
    deliberately one notch stricter than the course-summary filler, see
    app/session_insights.py fill_tick_template)."""
    filled = dict(values)

    def replace(match: re.Match) -> str:
        name = match.group(0)[1:-1]
        fill = filled[name] if name in filled else ""
        return fill() if callable(fill) else str(fill)

    return DIGEST_VARIABLE.sub(replace, template)


def sanitize_string_list(value: Any, *, max_length: int, max_count: int | None) -> list[str]:
    """Port of the PoC's sanitizeStringList: keeps only non-empty string
    items, trimmed and length-capped, at most max_count of them (None keeps
    every survivor — the PoC caps overview/bullets/points but not the
    topic/quote/todo list lengths)."""
    if not isinstance(value, list):
        return []
    items = [
        item.strip()[:max_length] for item in value if isinstance(item, str) and item.strip()
    ]
    return items if max_count is None else items[:max_count]


def sanitize_digest_topic(entry: Any) -> dict | None:
    """Port of the PoC's sanitizeReportTopic: a usable report Topic carries
    a valid ms range (non-negative integer ms, endMs >= startMs — the tick
    sanitizer's strictness, D21), a non-empty title, and a body in bullets
    (preferred) and/or summary (the v1 fallback). The model's `start`/`end`
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
    title = title.strip()[:TOPIC_TITLE_MAX_LENGTH] if isinstance(title, str) else ""
    summary = entry.get("summary")
    summary = summary.strip()[:TOPIC_TEXT_MAX_LENGTH] if isinstance(summary, str) else ""
    bullets = sanitize_string_list(
        entry.get("bullets"),
        max_length=REPORT_BULLET_MAX_LENGTH,
        max_count=REPORT_BULLETS_MAX_COUNT,
    )
    if not title or (not summary and not bullets):
        return None
    topic = {"startMs": start, "endMs": end, "title": title}
    if bullets:
        topic["bullets"] = bullets
    if summary:
        topic["summary"] = summary
    return topic


def sanitize_digest_quote(entry: Any) -> dict | None:
    """Port of the PoC's sanitizeReportQuote: a usable 金句 carries a valid
    timestamp and non-empty text."""
    if not isinstance(entry, dict):
        return None
    start = entry.get("start")
    text = entry.get("text")
    text = text.strip()[:REPORT_QUOTE_MAX_LENGTH] if isinstance(text, str) else ""
    if not is_js_integer(start) or start < 0 or not text:
        return None
    return {"startMs": int(start), "text": text}


def sanitize_digest_category(entry: Any) -> dict | None:
    """Port of the PoC's sanitizeReportCategory: a usable 主题归纳 card
    carries a non-empty title and at least one surviving point."""
    if not isinstance(entry, dict):
        return None
    title = entry.get("title")
    title = title.strip()[:TOPIC_TITLE_MAX_LENGTH] if isinstance(title, str) else ""
    points = sanitize_string_list(
        entry.get("points"),
        max_length=REPORT_CATEGORY_POINT_MAX_LENGTH,
        max_count=REPORT_CATEGORY_POINTS_MAX_COUNT,
    )
    if not title or not points:
        return None
    return {"title": title, "points": points}


def sanitize_digest_report(parsed: Any) -> dict | None:
    """Port of the PoC's parseGlobalPass: the payload must be a JSON
    object; every section entry is re-validated so a malformed item is
    dropped instead of reaching the panel. Returns the FIXED five-section
    report (all keys always present, empty arrays where nothing survived —
    the API's stored shape, D22), or None when no usable content survived
    anywhere — the caller answers the 502 (the zero-usable-content rule,
    the rolling tick's zero-usable-topics analog)."""
    if not isinstance(parsed, dict):
        return None
    raw_topics = parsed.get("topics") if isinstance(parsed.get("topics"), list) else []
    raw_quotes = parsed.get("quotes") if isinstance(parsed.get("quotes"), list) else []
    raw_categories = (
        parsed.get("categories") if isinstance(parsed.get("categories"), list) else []
    )
    report = {
        "overview": sanitize_string_list(
            parsed.get("overview"),
            max_length=REPORT_OVERVIEW_MAX_LENGTH,
            max_count=REPORT_OVERVIEW_MAX_COUNT,
        ),
        "topics": [
            topic for topic in (sanitize_digest_topic(entry) for entry in raw_topics) if topic
        ],
        "categories": [
            category
            for category in (sanitize_digest_category(entry) for entry in raw_categories)
            if category
        ][:REPORT_CATEGORIES_MAX_COUNT],
        "quotes": [
            quote for quote in (sanitize_digest_quote(entry) for entry in raw_quotes) if quote
        ],
        "todos": sanitize_string_list(
            parsed.get("todos"), max_length=REPORT_TODO_MAX_LENGTH, max_count=None
        ),
    }
    if any(report[section] for section in ("overview", "topics", "categories", "quotes", "todos")):
        return report
    return None


def assemble_digest_input(*, store: Any, session_id: str) -> dict:
    """Assemble the digest's input (the PoC's assembleGlobalPassInput): the
    FULL transcript — archived records AND the explicit skipped ranges (as
    the gap marker lines) on one startMs-ascending source timeline — plus
    the stored Rolling Summary's Topics (the live-topics merge hint; the
    PoC's liveTopic ride-along, never trusted input)."""
    state = load_state(store, session_id)
    entries = [
        {"startMs": record["startMs"], "endMs": record["endMs"], "text": record["text"]}
        for record in state["records"]
    ] + [
        {"startMs": gap["startMs"], "endMs": gap["endMs"], "text": GAP_MARKER}
        for gap in state["gaps"]
    ]
    entries.sort(key=lambda entry: entry["startMs"])
    insight = load_insight(store, session_id)
    live_topics = list(insight["topics"]) if insight else []
    return {"entries": entries, "live_topics": live_topics}


def live_topic_lines(topics: list) -> list[str]:
    """`[startMs–endMs] title` entries for the merge hint (the PoC's
    liveTopicsLines format on the ms timeline)."""
    return [f"[{topic['startMs']}–{topic['endMs']}] {topic['title']}" for topic in topics]


def build_digest_prompt(*, template: dict, digest_input: dict) -> dict:
    """Assemble the digest's { system, user, inputChars }: the live-topics
    user template when the Session carries Rolling Summary Topics,
    otherwise the bare-transcript template. inputChars is the full
    submitted prompt (system + user, code points) — the same number usage
    reports."""
    live_topics = digest_input["live_topics"]
    user_template = template["user"] if live_topics else template["user_without_topics"]
    transcript_text = "\n".join(stamped_lines(digest_input["entries"])) or NOTHING_MARKER
    values: dict = {"transcriptText": transcript_text}
    if live_topics:
        values["liveTopicsLines"] = "\n- ".join(live_topic_lines(live_topics))
    user = fill_digest_template(user_template, values)
    return {
        "system": template["system"],
        "user": user,
        "inputChars": count_code_points(template["system"]) + count_code_points(user),
    }


def serialize_digest(document: dict) -> dict:
    """Contract-r4 §7.1 full shape (the flat SessionDigest: the five report
    sections beside the sessionId/generation/generatedAt meta)."""
    return {
        "sessionId": document["sessionId"],
        "overview": document["overview"],
        "topics": document["topics"],
        "categories": document["categories"],
        "quotes": document["quotes"],
        "todos": document["todos"],
        "generation": document["generation"],
        "generatedAt": document["generatedAt"],
    }


def generate_digest(
    *,
    store: Any,
    account_id: str,
    session: dict | None,
    ai_provider: Any,
    now: Callable[[], int],
) -> dict:
    """POST /v1/sessions/{id}/digest (contract-r4 §7.2): assemble ->
    provider -> sanitize -> overwrite + count. The D2 lookup result is
    passed in (None is the same 404 whether the id is unknown or another
    account's). 整节一次性: an existing digest is REPLACED by the fresh
    full pass — 201 lands the first digest, 200 the overwrite; both were
    real AI calls and both count. Failure order: 409 未结束, 409 无记录,
    then the AI attempt — any provider failure (raise, timeout, unparseable,
    zero usable content) is the 502 with nothing written (不落脏数据, D16/
    D18: the previous digest and the usage counters are untouched)."""
    if not session:
        raise not_found_session()
    if session["status"] != "finished":
        raise session_not_finished()
    digest_input = assemble_digest_input(store=store, session_id=session["id"])
    if not digest_input["entries"]:
        raise no_session_transcript_to_summarize()

    prompt = build_digest_prompt(
        template=load_session_report_template(), digest_input=digest_input
    )
    try:
        raw_report = ai_provider.generate_digest(system=prompt["system"], user=prompt["user"])
    except Exception:
        raise digest_failed() from None
    report = sanitize_digest_report(raw_report)
    if report is None:
        raise digest_failed()

    existed = store.get("sessionDigests", session["id"]) is not None
    at_ms = now()
    document = {
        "sessionId": session["id"],
        "accountId": account_id,
        "resourceId": session["resourceId"],
        "overview": report["overview"],
        "topics": report["topics"],
        "categories": report["categories"],
        "quotes": report["quotes"],
        "todos": report["todos"],
        "generation": {
            "provider": ai_provider.id,
            "model": ai_provider.model,
            "inputChars": prompt["inputChars"],
        },
        "generatedAt": iso_seconds_from_ms(at_ms),
        "generatedAtMs": at_ms,
    }
    store.set("sessionDigests", session["id"], document)
    # D18 口径: the usage counters land with the digest (201/200's same
    # moment); a failed attempt records nothing. An overwrite is a real AI
    # call and counts again (the rolling replay's no-count rule does not
    # apply — there is no replay in the overwrite semantics).
    record_digest_generation(
        store=store, account_id=account_id, input_chars=prompt["inputChars"], now=now
    )
    return {"status": 200 if existed else 201, "body": {"digest": serialize_digest(document)}}


def get_digest(*, store: Any, session: dict | None) -> dict:
    """GET /v1/sessions/{id}/digest (contract-r4 §7.2): the bare current
    digest. The caller passes the D2 lookup result — None is the same 404
    for an unknown id and another account's session; a known session with
    no generated digest is the 404 digest_not_generated."""
    if not session:
        raise not_found_session()
    document = store.get("sessionDigests", session["id"])
    if not document:
        raise digest_not_generated()
    return {"status": 200, "body": {"digest": serialize_digest(document)}}
