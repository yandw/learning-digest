"""Course Summary domain (contract-r3.md §2.1–2.3, §3.1–3.3; decisions
D16/D17/D18, ticket 4.4). Port of lib/summaries.js.

Owns the "summaries" collection, one document per successful generation:

  { id, accountId, resourceId, content, citations,
    generation: { provider, model, inputChars }, generatedAt, generatedAtMs, seq }

Only successful generations exist — a failed provider call answers the
contract 502 and lands NOTHING (no summary row, no usage write, D16
不落脏数据); there is no status field because every stored summary is
queryable. Each accepted POST creates a NEW record (contract-r3 §1
幂等例外): regenerating is the user's decision, history is kept.

Generation pipeline (one POST, synchronous, D16):
1. aggregate the Resource's CURRENT archived material (D17): every
   Session's transcript records (startMs-ascending across sessions) and
   gaps as skipped markers, plus the account's notes — pending/failed
   segments and silent segments contribute nothing (no text);
2. assemble the prompt from the contract template
   prompts/course-summary.md (D17: the copy lives in the template file,
   code only fills the four variables) — inputChars is the full
   assembled prompt (system + user), the same number usage reports;
3. call the injected AI Provider (app/ai_providers.py);
4. reconcile the returned citations against the archived records and
   drop every one that does not resolve (§2.2: sessionId belongs to the
   resource, the range matches a real record, quote is a verbatim
   excerpt) — 宁可少引用不落死链;
5. store the summary and record usage in the same stroke (D18: the
   record-keeping timepoint is the landing moment).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from .errors import ApiError, not_found_resource
from .ids import generate_id
from .jsnum import is_js_integer
from .notes import notes_for_resource
from .timeutil import iso_seconds_from_ms
from .transcripts import load_state
from .usage import record_summary_generation

# D17: the prompt template is the contract record at the repo root.
PROMPT_FILE = Path(__file__).resolve().parents[3] / "prompts" / "course-summary.md"

GAP_MARKER = "已跳过，该范围未取得文本"
NOTHING_MARKER = "（无）"

_cached_template: dict | None = None


def extract_fenced_block(markdown: str, heading: str) -> str:
    """Extract the first fenced code block after a markdown heading."""
    heading_index = markdown.find(heading)
    if heading_index < 0:
        raise RuntimeError(f'prompts/course-summary.md is missing the "{heading}" section')
    fence = markdown.find("```", heading_index)
    if fence < 0:
        raise RuntimeError(f'prompts/course-summary.md has no code block after "{heading}"')
    content_start = markdown.find("\n", fence) + 1
    closing = markdown.find("```", content_start)
    return markdown[content_start:closing].rstrip("\n")


def load_course_summary_template() -> dict:
    """Load (and cache) the { system, user } template from the contract file."""
    global _cached_template
    if _cached_template is None:
        markdown = PROMPT_FILE.read_text(encoding="utf-8")
        _cached_template = {
            "system": extract_fenced_block(markdown, "## System prompt"),
            "user": extract_fenced_block(markdown, "## User prompt"),
        }
    return _cached_template


def count_code_points(text: str) -> int:
    """Unicode code-point count (D18: 字符量用 Unicode 码点数). Python len()
    on str already counts code points."""
    return len(text)


def no_transcript_to_summarize() -> ApiError:
    return ApiError(
        409,
        "no_transcript_to_summarize",
        "这门资料还没有可总结的逐字稿，先学习并归档后再生成",
    )


def summary_generation_failed() -> ApiError:
    return ApiError(
        502,
        "summary_generation_failed",
        "总结生成失败，请稍后重试；本次尝试不产生总结记录",
    )


def not_found_summary() -> ApiError:
    return ApiError(404, "not_found", "总结不存在或无权访问")


def require_account_resource(*, store: Any, account_id: str, resource_id: str) -> dict:
    """D2 lookup: the account's Resource by id, or throw the same 404 for
    unknown ids."""
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
    return resource


def collect_material(*, store: Any, account_id: str, resource_id: str) -> dict:
    """Aggregate one Resource's archived material (D17): records and gaps
    from ALL of the account's Sessions on the resource (active and finished
    alike — 未学完可生成), merged on the shared source timeline."""
    sessions = [
        s
        for s in store.list("sessions")
        if s["accountId"] == account_id and s["resourceId"] == resource_id
    ]
    records: list[dict] = []
    gaps: list[dict] = []
    for session in sessions:
        state = load_state(store, session["id"])
        for record in state["records"]:
            records.append(
                {
                    "sessionId": session["id"],
                    "startMs": record["startMs"],
                    "endMs": record["endMs"],
                    "text": record["text"],
                }
            )
        for gap in state["gaps"]:
            gaps.append({"sessionId": session["id"], "startMs": gap["startMs"], "endMs": gap["endMs"]})
    records.sort(key=lambda r: r["startMs"])
    gaps.sort(key=lambda g: g["startMs"])
    return {"sessions": sessions, "records": records, "gaps": gaps}


def stamp_line(entry: dict) -> str:
    """Line the transcript rows up with their session id stamp (D17)."""
    return f"[{entry['sessionId']} {entry['startMs']}–{entry['endMs']}] {entry['text']}"


TEMPLATE_VARIABLE = re.compile(r"\{(resourceTitle|transcriptLines|gapLines|noteLines)\}")


def fill_template(template: str, values: dict) -> str:
    """Fill the template's four variables in ONE pass — a fill value that
    itself contains a `{...}` token is never re-replaced (Node's replace-
    with-function semantics). String arguments are wrapped in functions."""
    filled = {name: values[name] for name in values}

    def replace(match: re.Match) -> str:
        fill = filled.get(match.group(0)[1:-1])
        return fill() if callable(fill) else match.group(0)

    return TEMPLATE_VARIABLE.sub(replace, template)


def build_generation_input(*, store: Any, account_id: str, resource: dict) -> dict:
    """Assemble the generation input (D17). Returns { system, user,
    inputChars, records } — inputChars is the full submitted prompt
    (system + user, code points), the same number the usage report carries."""
    material = collect_material(store=store, account_id=account_id, resource_id=resource["id"])
    records, gaps = material["records"], material["gaps"]
    transcript_lines = [stamp_line(record) for record in records]
    gap_lines = [stamp_line({**gap, "text": GAP_MARKER}) for gap in gaps]
    notes = notes_for_resource(store=store, account_id=account_id, resource_id=resource["id"])
    note_lines = [
        f"[{note['sourceId']} {note['positionMs']}] {note['text']}"
        if note["sourceId"] is not None and note["positionMs"] is not None
        else f"- {note['text']}"
        for note in notes
    ]

    template = load_course_summary_template()
    user = fill_template(
        template["user"],
        {
            "resourceTitle": lambda: resource["title"],
            "transcriptLines": lambda: "\n".join(transcript_lines),
            "gapLines": lambda: "\n".join(gap_lines) if gap_lines else NOTHING_MARKER,
            "noteLines": lambda: "\n".join(note_lines) if note_lines else NOTHING_MARKER,
        },
    )
    return {
        "system": template["system"],
        "user": user,
        "inputChars": count_code_points(template["system"]) + count_code_points(user),
        "records": records,
    }


def reconcile_citations(*, raw_citations: Any, records: list[dict]) -> list[dict]:
    """Citation reconciliation (§2.2, D17 引用清洗): keep a citation only
    when the session belongs to this resource, the range matches one of its
    real archived records exactly, and the quote is a verbatim excerpt of
    that record's text. Survivors are sorted by source-timeline startMs."""
    if not isinstance(raw_citations, list):
        return []
    by_session: dict[str, list[dict]] = {}
    for record in records:
        by_session.setdefault(record["sessionId"], []).append(record)
    kept: list[dict] = []
    for raw in raw_citations:
        if not isinstance(raw, dict):
            continue
        quote = raw.get("quote")
        session_id = raw.get("sessionId")
        start_ms = raw.get("startMs")
        end_ms = raw.get("endMs")
        if not isinstance(quote, str) or quote.strip() == "":
            continue
        if not isinstance(session_id, str) or session_id == "":
            continue
        if (
            not is_js_integer(start_ms)
            or not is_js_integer(end_ms)
            or start_ms < 0
            or end_ms <= start_ms
        ):
            continue
        start_ms = int(start_ms)
        end_ms = int(end_ms)
        record = next(
            (
                candidate
                for candidate in by_session.get(session_id, [])
                if candidate["startMs"] == start_ms and candidate["endMs"] == end_ms
            ),
            None,
        )
        if not record or quote not in record["text"]:
            continue
        kept.append({"quote": quote, "segmentRef": {"sessionId": session_id, "startMs": start_ms, "endMs": end_ms}})
    kept.sort(key=lambda c: c["segmentRef"]["startMs"])
    return kept


def serialize_summary(summary: dict) -> dict:
    """Contract §2.1 full shape."""
    return {
        "id": summary["id"],
        "resourceId": summary["resourceId"],
        "content": summary["content"],
        "citations": summary["citations"],
        "generation": summary["generation"],
        "generatedAt": summary["generatedAt"],
    }


def serialize_summary_list_item(summary: dict) -> dict:
    """Contract §3.2 list projection (body and citations come from the
    detail endpoint)."""
    return {
        "id": summary["id"],
        "resourceId": summary["resourceId"],
        "generatedAt": summary["generatedAt"],
        "generation": summary["generation"],
        "citationCount": len(summary["citations"]),
    }


def generate_summary(
    *,
    store: Any,
    account_id: str,
    resource_id: str,
    ai_provider: Any,
    now: Callable[[], int],
) -> dict:
    """POST /v1/resources/{id}/summaries (contract §3.1): aggregate ->
    prompt -> provider -> reconcile -> land + count. Any provider failure
    (raise, timeout, unparseable payload) becomes the 502 with nothing
    written."""
    resource = require_account_resource(store=store, account_id=account_id, resource_id=resource_id)

    generation_input = build_generation_input(store=store, account_id=account_id, resource=resource)
    # 409 before any AI call: gaps/failed/silent-only archives have no text.
    if not generation_input["records"]:
        raise no_transcript_to_summarize()

    try:
        generated = ai_provider.generate(system=generation_input["system"], user=generation_input["user"])
    except Exception:
        raise summary_generation_failed() from None
    content = generated.get("content") if isinstance(generated, dict) else None
    if not isinstance(content, str):
        raise summary_generation_failed()
    citations = reconcile_citations(
        raw_citations=generated.get("citations"), records=generation_input["records"]
    )

    at_ms = now()
    summary = {
        "id": generate_id("sum"),
        "accountId": account_id,
        "resourceId": resource["id"],
        "content": content,
        "citations": citations,
        "generation": {
            "provider": ai_provider.id,
            "model": ai_provider.model,
            "inputChars": generation_input["inputChars"],
        },
        "generatedAt": iso_seconds_from_ms(at_ms),
        "generatedAtMs": at_ms,
        # Internal list-order tie-break: two generations can land in the same
        # millisecond (double click); the newest one must sort first. Monotonic
        # because the contract has no summary deletion.
        "seq": store.count("summaries") + 1,
    }
    store.set("summaries", summary["id"], summary)
    # D18: the usage counters land with the summary (201's same moment).
    record_summary_generation(
        store=store, account_id=account_id, input_chars=generation_input["inputChars"], now=now
    )
    return {"status": 201, "body": {"summary": serialize_summary(summary)}}


def list_summaries(*, store: Any, account_id: str, resource_id: str) -> dict:
    """GET /v1/resources/{id}/summaries (§3.2): newest first, projection items."""
    require_account_resource(store=store, account_id=account_id, resource_id=resource_id)
    summaries = [
        s
        for s in store.list("summaries")
        if s["accountId"] == account_id and s["resourceId"] == resource_id
    ]
    summaries.sort(key=lambda s: (s["generatedAtMs"], s["seq"]), reverse=True)
    return {"status": 200, "body": {"summaries": [serialize_summary_list_item(s) for s in summaries]}}


def get_summary(*, store: Any, account_id: str, summary_id: str) -> dict:
    """GET /v1/summaries/{id} (§3.3): the bare full shape; cross-account is
    the same 404 (D2)."""
    summary = store.get("summaries", summary_id)
    if not summary or summary["accountId"] != account_id:
        raise not_found_summary()
    return {"status": 200, "body": {"summary": serialize_summary(summary)}}
