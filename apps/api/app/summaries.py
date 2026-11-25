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
   Session's ready organized sentences or raw records, gaps as skipped
   markers, and the account's notes;
2. assemble the prompt from the contract template
   prompts/course-summary.md (D17: the copy lives in the template file,
   code only fills the four variables) — inputChars is the full
   assembled prompt (system + user), the same number usage reports;
3. call the injected AI Provider (app/ai_providers.py);
4. reconcile the returned citations against the archived records and
   drop every one that does not resolve (§2.2: sessionId belongs to the
   resource, the range matches a selected row, quote is a verbatim
   excerpt);
5. store the summary and record usage in the same stroke (D18: the
   record-keeping timepoint is the landing moment).
"""

from __future__ import annotations

import logging
import re
from itertools import groupby
from pathlib import Path
from time import perf_counter
from typing import Any, Callable

from .errors import ApiError, not_found_resource
from .ids import generate_id
from .jsnum import is_js_integer
from .notes import notes_for_resource
from .timeutil import iso_seconds_from_ms
from .transcript_organization import organized_paragraphs
from .transcripts import load_state, sorted_records
from .usage import record_summary_generation

# D17: the prompt template is the contract record at the repo root.
PROMPT_FILE = Path(__file__).resolve().parents[3] / "prompts" / "course-summary.md"

GAP_MARKER = "已跳过，该范围未取得文本"
NOTHING_MARKER = "（无）"

logger = logging.getLogger(__name__)

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
    alike — 未学完可生成), merged on each Source's own timeline.

    Merge/dedup (owner decision 2026-11-17: 一份资料只有一份逐字稿): multiple
    sessions re-watching the same ranges used to land every overlapping copy
    in the summary prompt (duplicated text, confused citations). Records now
    cluster on near-duplicate ranges — one range covering ≥80% of the
    other's shorter span — and the cluster keeps the best copy: longest
    text, then captions over asr (authored beats machine), then the smaller
    sessionId — deterministic regardless of session list order. Plain
    touching overlap is NOT a duplicate: caption/ASR chunks advance in
    sliding windows (each record overlaps its neighbours ~50%), and a
    transitive-overlap chain would collapse the whole transcript into one
    record. Gaps fold their overlaps, then drop any range a kept record
    already covers. The web library's mergeTranscriptViews implements the
    SAME rule for display."""
    sessions = [
        s
        for s in store.list("sessions")
        if s["accountId"] == account_id and s["resourceId"] == resource_id
    ]
    records: list[dict] = []
    gaps: list[dict] = []
    states = {}
    for session in sessions:
        session_id, source_id = session["id"], session.get("sourceId")
        state = load_state(store, session_id)
        states[session_id] = state
        for record_index, record in enumerate(sorted_records(state)):
            records.append(
                {
                    "sessionId": session_id,
                    "sourceId": source_id,
                    "origin": session.get("origin"),
                    "recordIndex": record_index,
                    "startMs": record["startMs"],
                    "endMs": record["endMs"],
                    "text": record["text"],
                }
            )
        for gap in state["gaps"]:
            gaps.append(
                {"sessionId": session_id, "sourceId": source_id, "startMs": gap["startMs"], "endMs": gap["endMs"]}
            )

    def _record_sort_key(r: dict) -> tuple:
        return (r["sourceId"] or "", r["startMs"], r["endMs"], str(r["sessionId"]))

    def _beats(challenger: dict, current: dict) -> bool:
        """Deterministic cluster winner: longest text; tie → captions over
        asr (authored beats machine); tie → smaller sessionId. Mirrors the
        web library's mergeTranscriptViews beat-for-beat."""
        len_diff = len(challenger["text"]) - len(current["text"])
        if len_diff != 0:
            return len_diff > 0
        origin_diff = (0 if challenger["origin"] == "captions" else 1) - (
            0 if current["origin"] == "captions" else 1
        )
        if origin_diff != 0:
            return origin_diff < 0
        return str(challenger["sessionId"]) < str(current["sessionId"])

    def _near_duplicate(a: dict, b: dict) -> bool:
        """Same range re-captured, not a sliding-window neighbour: the
        intersection must cover ≥80% of the shorter span. YouTube caption
        chunks advance by roughly half their width (~50% pairwise overlap),
        so they never cluster; exact copies across sessions do (100%)."""
        if a["sourceId"] != b["sourceId"]:
            return False
        overlap = min(a["endMs"], b["endMs"]) - max(a["startMs"], b["startMs"])
        shorter = min(a["endMs"] - a["startMs"], b["endMs"] - b["startMs"])
        return shorter > 0 and overlap * 5 >= shorter * 4

    records.sort(key=_record_sort_key)
    kept_records: list[dict] = []
    cluster: dict | None = None
    for record in records:
        if cluster is not None and _near_duplicate(record, cluster["chosen"]):
            if _beats(record, cluster["chosen"]):
                cluster["chosen"] = record
        else:
            if cluster is not None:
                kept_records.append(cluster["chosen"])
            cluster = {"chosen": record}
    if cluster is not None:
        kept_records.append(cluster["chosen"])

    gaps.sort(key=_record_sort_key)
    folded_gaps: list[dict] = []
    for gap in gaps:
        last = folded_gaps[-1] if folded_gaps else None
        if last is not None and gap["sourceId"] == last["sourceId"] and gap["startMs"] < last["endMs"]:
            if gap["endMs"] > last["endMs"]:
                last["endMs"] = gap["endMs"]
        else:
            folded_gaps.append(dict(gap))
    kept_gaps = [
        gap
        for gap in folded_gaps
        if not any(
            r["sourceId"] == gap["sourceId"]
            and r["startMs"] < gap["endMs"]
            and gap["startMs"] < r["endMs"]
            for r in kept_records
        )
    ]
    records_by_session: dict[str, list[dict]] = {}
    for record in kept_records:
        records_by_session.setdefault(record["sessionId"], []).append(record)
    selected_records = [
        record
        for session_id, session_records in records_by_session.items()
        for record in prefer_organized(states[session_id], session_records)
    ]
    selected_records.sort(key=lambda r: (r["sourceId"] or "", r["startMs"]))
    return {"sessions": sessions, "records": selected_records, "gaps": kept_gaps}


def prefer_organized(state: dict, kept_records: list[dict]) -> list[dict]:
    paragraphs = organized_paragraphs(state)
    if not paragraphs:
        return kept_records

    kept_indices = {record["recordIndex"] for record in kept_records}
    session_id = kept_records[0]["sessionId"]
    source_id = kept_records[0]["sourceId"]
    organized = []
    for paragraph in paragraphs:
        for sentence in paragraph["sentences"]:
            sentence_indices = {span["recordIndex"] for span in sentence["spans"]}
            selected = sentence_indices & kept_indices
            if not selected:
                continue
            # shortcut: fall back to raw when dedup cuts a sentence, until citations can anchor a partial sentence.
            if selected != sentence_indices:
                return kept_records
            organized.append({
                "sessionId": session_id,
                "sourceId": source_id,
                "startMs": sentence["startMs"],
                "endMs": sentence["endMs"],
                "text": sentence["text"],
            })
    return organized or kept_records


def stamp_line(entry: dict) -> str:
    """Line the transcript rows up with their session id stamp (D17)."""
    return f"[{entry['sessionId']} {entry['startMs']}–{entry['endMs']}] {entry['text']}"


def stamp_sources(entries: list[dict]) -> str:
    sections = []
    for source_id, rows in groupby(entries, key=lambda entry: entry["sourceId"]):
        sections.append("\n".join([f"[来源 {source_id}]", *(stamp_line(row) for row in rows)]))
    return "\n\n".join(sections)


TEMPLATE_VARIABLE = re.compile(r"\{(resourceTitle|transcriptLines|gapLines|noteLines)\}")


def fill_template(template: str, values: dict) -> str:
    """Fill the template's four variables in ONE pass — a fill value that
    itself contains a `{...}` token is never re-replaced (Node's replace-
    with-function semantics). String arguments are wrapped in functions.

    A MISSING value leaves the placeholder visible, and values are returned
    uncoerced — deliberately one notch looser than the three r4 fillers
    (fill_tick_template / fill_digest_template / fill_explain_template),
    which fill missing values as "" and str()-coerce. The four domain
    fillers share the one-pass shape but keep their own variable regexes;
    the divergence is documented, not unified."""
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
            "transcriptLines": lambda: stamp_sources(records),
            "gapLines": lambda: stamp_sources([{**gap, "text": GAP_MARKER} for gap in gaps]) if gaps else NOTHING_MARKER,
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
    """Require an exact input range and verbatim quote from a raw or organized row."""
    if not isinstance(raw_citations, list):
        return []
    by_stamp: dict[tuple[str, int, int], list[str]] = {}
    for record in records:
        stamp = (record["sessionId"], record["startMs"], record["endMs"])
        by_stamp.setdefault(stamp, []).append(record["text"])
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
        if not any(quote in text for text in by_stamp.get((session_id, start_ms, end_ms), [])):
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

    started = perf_counter()
    status = "failed"
    usage = {}
    try:
        generated = ai_provider.generate(system=generation_input["system"], user=generation_input["user"])
        if isinstance(generated, dict):
            usage = generated
        content = usage.get("content")
        if not isinstance(content, str):
            raise summary_generation_failed()
        status = "ready"
    except Exception as error:
        usage = getattr(error, "usage", usage)
        raise summary_generation_failed() from None
    finally:
        telemetry = {
            "provider": ai_provider.id,
            "model": ai_provider.model,
            "status": status,
            "latencyMs": round((perf_counter() - started) * 1000),
            "callCount": 1,
            "retryCount": 0,
        }
        for key in ("inputTokens", "outputTokens"):
            value = usage.get(key) if isinstance(usage, dict) else None
            telemetry[key] = value if type(value) is int and value >= 0 else None
        logger.info("course summary attempt %s", telemetry)

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
