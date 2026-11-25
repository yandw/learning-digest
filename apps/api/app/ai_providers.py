"""AI Provider seam for course summary generation (contract-r3.md §2.3,
§3.1; decisions D16/D17, ticket 4.4). Python port of lib/ai-providers.js.

The API is the ONLY holder of AI Provider credentials (D16: same reasoning
as D10 for speech, but the inputs are already-archived text, so the seam
lives here, not in the Worker — the two seams are parallel and
independent).

Interface (the one thing consumers may rely on):

    provider = { id: str, model: str, generate(*, system, user),
                 generate_topics(*, system, user),
                 generate_digest(*, system, user),
                 explain(*, system, user) }
    generate returns { content: str, citations: RawCitation[], flowchart? }
    where RawCitation = { quote, sessionId, startMs, endMs } — the shape
    the model is asked for by prompts/course-summary.md; every citation is
    later reconciled against the archived records (app/summaries.py)
    before anything lands.
    generate_topics returns the RAW Topic entries the topic-tick prompt
    (prompts/topic-tick.md, contract-r4.md §6) asks for — one JSON array
    of {start, end, title, text, continuation?}; the rolling domain
    (app/session_insights.py) sanitizes them before anything lands.
    generate_digest returns the RAW report object the session-report
    prompt (prompts/session-report.md, contract-r4.md §7) asks for — one
    JSON object {overview?, topics, categories?, quotes, todos}; the
    digest domain (app/session_digest.py) sanitizes it before anything
    lands.
    explain returns { explanation: str } — the stateless selected-text
    explanation (contract-r4.md §7, prompts/explain.md).

Two implementations (D16: default deployment is the real product path,
tests inject the stub):
- create_stub_provider: deterministic — output depends only on the input
  prompt text. It reads the assembled transcript lines back out of the
  user prompt and cites them verbatim, so the citation reconciliation
  can hold; same input always yields the same summary.
- create_qwen_provider: Aliyun Bailian compatible-mode chat/completions.
  The API key comes from env LD_AI_API_KEY (main.py) — deliberately NOT
  the worker's speech credentials (apps/worker uses QWEN_API_KEY for
  ASR): the two seams have different owners, credentials and lifecycles
  (D16). The model defaults to qwen3.8-flash and is configurable
  (one model behind config, per the round-3 product decision). Real
  network calls stay out of the test suite; an injected httpx transport
  is the seam.

select_ai_provider(config) resolves the config into a provider instance
at startup; an unknown name or a keyless qwen selection fails closed
(raise at startup), never per-request.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

import httpx

from .summaries import GAP_MARKER

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen3.8-flash"
DEFAULT_TIMEOUT_MS = 120_000

# The user prompt's section markers (prompts/course-summary.md — the
# template is the contract record, D17; the stub parses it, it never
# re-derives the prompt copy).
SECTION_TRANSCRIPT = "已归档逐字稿（按来源时间轴排序）："
SECTION_GAPS = "已跳过范围："
SECTION_NOTES = "学习者笔记："

# One transcript/gap line as assembled by app/summaries.py:
# [ses_… 30000–60000] text — en dash between the ms marks.
STAMPED_LINE = re.compile(r"^\[(\S+) (\d+)–(\d+)\] (.+)$", re.MULTILINE)

TITLE_LINE = re.compile(r"^资料标题：(.*)$", re.MULTILINE)


def _parse_stamped_lines(section: str) -> list[dict]:
    """Extract { sessionId, startMs, endMs, text } lines from one section."""
    return [
        {
            "sessionId": match.group(1),
            "startMs": int(match.group(2)),
            "endMs": int(match.group(3)),
            "text": match.group(4),
        }
        for match in STAMPED_LINE.finditer(section)
    ]


def parse_user_prompt(user: str) -> dict:
    """Slice the user prompt into its three material sections."""
    transcript_start = user.find(SECTION_TRANSCRIPT)
    gaps_start = user.find(SECTION_GAPS)
    notes_start = user.find(SECTION_NOTES)
    transcript_section = (
        user[transcript_start + len(SECTION_TRANSCRIPT) : gaps_start]
        if transcript_start >= 0 and gaps_start > transcript_start
        else ""
    )
    gaps_section = (
        user[gaps_start + len(SECTION_GAPS) : notes_start]
        if gaps_start >= 0 and notes_start > gaps_start
        else ""
    )
    notes_section = user[notes_start + len(SECTION_NOTES) :] if notes_start >= 0 else ""
    title_match = TITLE_LINE.search(user)
    return {
        "title": title_match.group(1).strip() if title_match else "课程资料",
        "records": _parse_stamped_lines(transcript_section),
        "gaps": _parse_stamped_lines(gaps_section),
        "notes": [
            line.strip()
            for line in notes_section.split("\n")
            if line.strip() != "" and line.strip() != "（无）"
        ],
    }


def stub_citations(records: list[dict], max_sessions: int = 6) -> list[dict]:
    """The stub's citation rule: one citation per distinct Session, pointing
    at that Session's latest record on the shared timeline (the newest
    material), quote verbatim. Deterministic; everything it cites exists in
    the input, so the reconciliation keeps them all."""
    latest_by_session: dict[str, dict] = {}
    for record in records:
        # The assembled lines are startMs-ascending, so the last occurrence
        # per session is that session's latest record.
        latest_by_session[record["sessionId"]] = record
    ordered = sorted(latest_by_session.values(), key=lambda r: r["startMs"])
    return [
        {
            "quote": record["text"],
            "sessionId": record["sessionId"],
            "startMs": record["startMs"],
            "endMs": record["endMs"],
        }
        for record in ordered[:max_sessions]
    ]


def stub_content(parsed: dict) -> str:
    """Deterministic Markdown body, derived only from the parsed input."""
    title = parsed["title"]
    records = parsed["records"]
    gaps = parsed["gaps"]
    notes = parsed["notes"]
    lines = [f"# {title}：课程总结", "", "## 核心要点", ""]
    # Up to 8 records so the body visibly grows when a catch-up session
    # adds material (the two-generation story regenerates over a growing
    # archive); a real provider would synthesize, the stub quotes.
    for record in records[:8]:
        lines.append(f"- {record['text']}")
    if notes:
        lines.extend(["", "## 学习笔记并入", ""])
        for note in notes[:3]:
            lines.append(f"- {note}")
    lines.extend(["", "## 尚未覆盖", ""])
    if gaps:
        for gap in gaps:
            lines.append(
                f"- [{gap['sessionId']} {gap['startMs']}–{gap['endMs']}] 该范围被跳过，未取得文本。"
            )
        lines.append("- 这些区间没有文本，补学后可重新生成总结。")
    else:
        lines.append("- 没有显式跳过范围。")
    return "\n".join(lines)


class StubProvider:
    """The deterministic test provider (Testing Decisions: 替代 AI Provider
    使测试可重复). `system` shapes the real provider's behavior; the stub is
    deterministic by construction and only consumes the material."""

    def __init__(self, model: str | None = None):
        self.id = "stub"
        self.model = model or "stub-course-summary-1"

    def generate(self, *, system: str, user: str) -> dict:
        parsed = parse_user_prompt(user)
        return {
            "content": stub_content(parsed),
            "citations": stub_citations(parsed["records"]),
        }

    def generate_topics(self, *, system: str, user: str) -> list:
        """The rolling-summary tick path (contract-r4.md §6): deterministic
        Topic synthesis from the tick input. `system` shapes the real
        provider's behavior; the stub only consumes the material."""
        return stub_topics(parse_tick_user_prompt(user))

    def generate_digest(self, *, system: str, user: str) -> dict:
        """The Session Digest path (contract-r4.md §7): deterministic
        one-shot report synthesis from the full-transcript input."""
        return stub_digest_report(parse_digest_user_prompt(user))

    def explain(self, *, system: str, user: str) -> dict:
        """The selected-text explanation path (contract-r4.md §7):
        deterministic explanation from the filled explain template."""
        return {"explanation": stub_explanation(parse_explain_user_prompt(user))}


def create_stub_provider(model: str | None = None) -> StubProvider:
    return StubProvider(model)


# --- Rolling-summary tick support (contract-r4.md §6, ticket 6.4) -----------
#
# The panel AI shares the course summary's seam (LD_AI_PROVIDER /
# LD_AI_API_KEY unchanged): one more operation on the same provider
# interface — generate_topics(*, system, user) -> list[dict] — where the
# topic-tick system prompt (prompts/topic-tick.md) demands a bare JSON
# array of Topics {start, end, title, text, continuation?}. Entries come
# back RAW; the domain sanitizes them (app/session_insights.py).

# One tick's new-transcript line as assembled by app/session_insights.py:
# [30000–60000] text — en dash between the ms marks.
TICK_STAMPED_LINE = re.compile(r"^\[(\d+)–(\d+)\] (.+)$", re.MULTILINE)

# The tick user prompt's section markers (prompts/topic-tick.md — the
# stub parses them, it never re-derives the prompt copy).
TICK_SECTION_EXISTING = "已有话题（按时间顺序）："
TICK_SECTION_LAST = "上一批的最后一个话题："
TICK_SECTION_NEW = "本段新逐字稿："


def parse_tick_user_prompt(user: str) -> dict:
    """Slice one tick's user prompt into the material the rolling stub
    consumes: the new-window stamped records and the existing Topics'
    titles (the continuation anchor)."""
    new_start = user.find(TICK_SECTION_NEW)
    new_section = user[new_start + len(TICK_SECTION_NEW) :] if new_start >= 0 else ""
    records = [
        {"startMs": int(match.group(1)), "endMs": int(match.group(2)), "text": match.group(3)}
        for match in TICK_STAMPED_LINE.finditer(new_section)
    ]
    existing_start = user.find(TICK_SECTION_EXISTING)
    last_start = user.find(TICK_SECTION_LAST)
    titles: list[str] = []
    if existing_start >= 0 and last_start > existing_start:
        section = user[existing_start + len(TICK_SECTION_EXISTING) : last_start]
        titles = [
            line.strip()[2:] for line in section.split("\n") if line.strip().startswith("- ")
        ]
    return {"records": records, "existing_topic_titles": titles}


def stub_topics(parsed: dict, group_size: int = 2) -> list[dict]:
    """The rolling stub's deterministic rule: chunk the new-window records
    into consecutive groups of `group_size`, one Topic per group spanning
    its first record's start to its last record's end; the title quotes the
    first record's text and the body joins the group's lines. The first
    output Topic continues the previous tick when the timeline already
    holds Topics (the prompt's continuation rule). Deterministic: same
    input, same append."""
    records = parsed["records"]
    topics = []
    for index in range(0, len(records), group_size):
        group = records[index : index + group_size]
        topics.append(
            {
                "start": group[0]["startMs"],
                "end": group[-1]["endMs"],
                "title": group[0]["text"][:12],
                "text": "；".join(record["text"] for record in group),
            }
        )
    if topics and parsed["existing_topic_titles"]:
        topics[0]["continuation"] = True
    return topics


# --- Session Digest support (contract-r4.md §7, ticket 6.5) -----------------
#
# The digest shares the course summary's seam (LD_AI_PROVIDER / LD_AI_API_KEY
# unchanged): one more operation on the same provider interface —
# generate_digest(*, system, user) -> dict — where the session-report system
# prompt (prompts/session-report.md) demands one bare JSON object with the
# rich report sections {overview?, topics, categories?, quotes, todos}.
# The reply comes back RAW; the domain sanitizes it (app/session_digest.py).

# The digest user prompt's section markers (prompts/session-report.md — the
# stub parses them, it never re-derives the prompt copy).
DIGEST_SECTION_LIVE_TOPICS = "课中已识别的话题段（可参考/合并）："
DIGEST_SECTION_TRANSCRIPT = "完整逐字稿："


def parse_digest_user_prompt(user: str) -> dict:
    """Slice one digest's user prompt into the material the digest stub
    consumes: the stamped transcript lines (records and skipped-gap
    markers on one source timeline; the gap marker carries no summarizable
    text) and the stored rolling Topics' titles (the merge hint)."""
    transcript_start = user.find(DIGEST_SECTION_TRANSCRIPT)
    transcript_section = (
        user[transcript_start + len(DIGEST_SECTION_TRANSCRIPT) :]
        if transcript_start >= 0
        else ""
    )
    records = [
        {"startMs": int(match.group(1)), "endMs": int(match.group(2)), "text": match.group(3)}
        for match in TICK_STAMPED_LINE.finditer(transcript_section)
        if match.group(3) != GAP_MARKER
    ]
    live_start = user.find(DIGEST_SECTION_LIVE_TOPICS)
    live_end = user.find(DIGEST_SECTION_TRANSCRIPT)
    titles: list[str] = []
    if live_start >= 0 and live_end > live_start:
        section = user[live_start + len(DIGEST_SECTION_LIVE_TOPICS) : live_end]
        titles = [
            line.strip()[2:] for line in section.split("\n") if line.strip().startswith("- ")
        ]
    return {"records": records, "live_topic_titles": titles}


def stub_digest_report(parsed: dict) -> dict:
    """The digest stub's deterministic rule (mirrors stub_topics' chunking):
    chunk the transcript records into consecutive groups of two, one Topic
    per group spanning its first record's start to its last record's end,
    the title quoting the first record's text and the bullets listing the
    group's lines; the first and last records become the 金句; the first
    record's text stands in for the 核心要点 and the single 主题归纳 card;
    todos stay empty (the stub never fabricates action items). Deterministic:
    same input, same report."""
    records = parsed["records"]
    topics = []
    for index in range(0, len(records), 2):
        group = records[index : index + 2]
        topics.append(
            {
                "start": group[0]["startMs"],
                "end": group[-1]["endMs"],
                "title": group[0]["text"][:12],
                "bullets": [record["text"] for record in group],
            }
        )
    quotes = []
    if records:
        quotes.append({"start": records[0]["startMs"], "text": records[0]["text"]})
        if len(records) > 1:
            quotes.append({"start": records[-1]["startMs"], "text": records[-1]["text"]})
    return {
        "overview": [records[0]["text"]] if records else [],
        "topics": topics,
        "categories": [{"title": "主题归纳", "points": [records[0]["text"]]}] if records else [],
        "quotes": quotes,
        "todos": [],
    }


# --- Selected-text explanation support (contract-r4.md §7, ticket 6.5) ------
#
# One more operation on the shared seam — explain(*, system, user) ->
# {explanation: str} — where the explain system prompt
# (prompts/explain.md) answers in plain prose, no JSON.

# The explain user prompt's section markers (prompts/explain.md — the stub
# parses them, it never re-derives the prompt copy).
EXPLAIN_SECTION_SELECTED = 'SELECTED: "'
EXPLAIN_SECTION_CONTEXT = "CONTEXT: "

# The PoC's absent-context fallback, filled by the domain
# (app/explanations.py NOTHING_CONTEXT); the stub reads it back.
EXPLAIN_NO_CONTEXT = "None"


def parse_explain_user_prompt(user: str) -> dict:
    """Slice one explain's user prompt into the selection and the filled
    context (the `None` literal when the request carried no context)."""
    selected_start = user.find(EXPLAIN_SECTION_SELECTED)
    context_start = user.find(EXPLAIN_SECTION_CONTEXT)
    selected = ""
    if selected_start >= 0:
        open_quote = selected_start + len(EXPLAIN_SECTION_SELECTED)
        close_quote = user.rfind('"', open_quote, context_start if context_start > open_quote else len(user))
        selected = user[open_quote:close_quote] if close_quote > open_quote else user[open_quote:]
    context = (
        user[context_start + len(EXPLAIN_SECTION_CONTEXT) :].splitlines()[0].strip()
        if context_start >= 0
        else ""
    )
    return {"selected_text": selected, "context": context}


def stub_explanation(parsed: dict) -> str:
    """The explain stub's deterministic rule: explain the selection; the
    filled context (when it is not the `None` fallback) shapes one clause."""
    selected = parsed["selected_text"]
    context = parsed["context"]
    explanation = f"「{selected}」是所选内容里的关键表述"
    if context and context != EXPLAIN_NO_CONTEXT:
        explanation += f"，结合上下文（{context[:20]}）可以确认它的含义"
    return explanation + "。"


def _normalize_base_url(base_url: Any) -> str:
    """Trim trailing slashes; empty falls back to the Bailian endpoint."""
    trimmed = base_url.strip() if isinstance(base_url, str) else ""
    return (trimmed or DEFAULT_BASE_URL).rstrip("/")


def parse_summary_payload(text: Any) -> dict | None:
    """Parse the model's reply into the summary payload. The system prompt
    demands one bare JSON object, but real models wrap it (code fences,
    prose) — tolerate everything that contains a parseable object with a
    string `content`; `citations` defaults to []. Anything else is
    "unparseable" (the caller answers the contract 502)."""
    if not isinstance(text, str) or text.strip() == "":
        return None
    candidate = text.strip()
    fence = re.match(r"^```[a-zA-Z]*\s*(.*?)\s*```$", candidate, re.DOTALL)
    if fence:
        candidate = fence.group(1).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(candidate[start : end + 1])
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get("content"), str):
        return None
    citations = data.get("citations")
    return {
        "content": data["content"],
        "citations": citations if isinstance(citations, list) else [],
        **({"flowchart": data["flowchart"]} if "flowchart" in data else {}),
    }


def _parse_loose_json(text: str) -> Any:
    """Port of the PoC's parseLooseJson (session-summary.js): tolerate the
    small mistakes models make — code fences, prose around the payload,
    trailing commas. Isolates the outermost { ... } or [ ... ], then parses;
    returns None when nothing parseable remains."""
    candidate = text.strip()
    fence = re.match(r"^```[a-zA-Z]*\s*(.*?)\s*```$", candidate, re.DOTALL)
    if fence:
        candidate = fence.group(1).strip()
    openers = [index for index in (candidate.find("{"), candidate.find("[")) if index >= 0]
    closers = [index for index in (candidate.rfind("}"), candidate.rfind("]")) if index >= 0]
    if openers and closers:
        first, last = min(openers), max(closers)
        if last > first:
            candidate = candidate[first : last + 1]
    try:
        return json.loads(candidate)
    except ValueError:
        pass
    # Most common LLM slip: a trailing comma right before a } or ].
    try:
        return json.loads(re.sub(r",(\s*[}\]])", r"\1", candidate))
    except ValueError:
        return None


def parse_topics_payload(text: Any) -> list | None:
    """Parse a topic-tick reply into RAW Topic entries. The system prompt
    demands a bare JSON array, but real models wrap it: a bare array or
    an object wrapping one under `topics` both parse (the PoC's
    parseTopicTick acceptance). Anything else is None — the caller answers
    the contract 502. Entries are sanitized by the domain, not here."""
    if not isinstance(text, str) or text.strip() == "":
        return None
    parsed = _parse_loose_json(text)
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict) and isinstance(parsed.get("topics"), list):
        return parsed["topics"]
    return None


def parse_digest_payload(text: Any) -> dict | None:
    """Parse a digest reply into the RAW report object (the PoC's
    parseGlobalPass acceptance: the payload must be a JSON object — arrays
    and scalars are not reports). Anything else is None — the caller
    answers the contract 502. Sections are sanitized by the domain."""
    if not isinstance(text, str) or text.strip() == "":
        return None
    parsed = _parse_loose_json(text)
    return parsed if isinstance(parsed, dict) else None


def _reply_text(data: Any) -> str:
    """Port of `String(json?.choices?.[0]?.message?.content || "")`."""
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""
    return "" if content is None else str(content)


class QwenProvider:
    """Bailian compatible-mode chat/completions (worker/providers/qwen.py is
    the shape precedent — same endpoint family, different credential
    ownership, D16). One request per generation: system + user messages.

    A FRESH timeout object per generate() call (the round-3 review fix's
    Python counterpart): httpx.Timeout built at provider construction and
    shared would still be *live*, but the Node regression was a shared
    AbortSignal — the port keeps the same shape (per-call factory, value
    fixed at construction) so the seam contract carries over verbatim.
    `timeout_factory` is injectable so tests can observe the timeouts
    handed to the transport; `transport` keeps real network calls out of
    the test suite (httpx.MockTransport)."""

    def __init__(
        self,
        *,
        api_key: Any,
        base_url: Any = "",
        model: Any = "",
        transport: httpx.BaseTransport | None = None,
        timeout_ms: Any = None,
        timeout_factory: Callable[[float], httpx.Timeout] | None = None,
    ):
        trimmed_key = api_key.strip() if isinstance(api_key, str) else ""
        if not trimmed_key:
            raise RuntimeError(
                "Qwen AI Provider requires an API key (env LD_AI_API_KEY; "
                "separate from the worker's speech credentials, D16)"
            )
        self.id = "qwen"
        self.model = (model.strip() if isinstance(model, str) else "") or DEFAULT_MODEL
        self._api_key = trimmed_key
        self._base_url = _normalize_base_url(base_url)
        self._timeout_ms = timeout_ms or DEFAULT_TIMEOUT_MS
        self._timeout_factory = timeout_factory
        self._client = httpx.Client(transport=transport)

    def _chat(self, *, system: str, user: str) -> str:
        """One chat/completions request, reply text back. A FRESH timeout
        per call, never one shared across calls (the round-3 review fix's
        discipline, shared by both operations).

        Units: config holds milliseconds (LD_AI_TIMEOUT_MS), but
        httpx.Timeout speaks SECONDS — so the ms value is divided by 1000
        before it reaches httpx. The injectable `timeout_factory` observes
        the converted seconds value, i.e. exactly what httpx is handed."""
        timeout_seconds = self._timeout_ms / 1000
        timeout = (
            self._timeout_factory(timeout_seconds)
            if self._timeout_factory
            else httpx.Timeout(timeout_seconds)
        )
        response = self._client.post(
            f"{self._base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                # Bailian's HTTP API reads this top-level field to disable reasoning.
                "enable_thinking": False,
            },
            timeout=timeout,
        )
        if not response.is_success:
            try:
                body = response.text
            except Exception:
                body = ""
            detail = f": {body[:500]}" if body else ""
            raise RuntimeError(
                f"Qwen AI Provider request failed with HTTP {response.status_code}{detail}"
            )
        return _reply_text(response.json())

    def generate(self, *, system: str, user: str) -> dict:
        parsed = parse_summary_payload(self._chat(system=system, user=user))
        if not parsed:
            raise RuntimeError("Qwen AI Provider returned an unparseable summary payload")
        return parsed

    def generate_topics(self, *, system: str, user: str) -> list:
        """One rolling-summary tick over chat/completions (contract-r4.md
        §6): the topic-tick system prompt demands a bare JSON array of
        Topics; unparseable replies raise — the domain answers the 502."""
        topics = parse_topics_payload(self._chat(system=system, user=user))
        if topics is None:
            raise RuntimeError("Qwen AI Provider returned an unparseable topic-tick payload")
        return topics

    def generate_digest(self, *, system: str, user: str) -> dict:
        """One Session Digest pass over chat/completions (contract-r4.md
        §7): the session-report system prompt demands a bare JSON object;
        unparseable replies raise — the domain answers the 502."""
        parsed = parse_digest_payload(self._chat(system=system, user=user))
        if parsed is None:
            raise RuntimeError("Qwen AI Provider returned an unparseable digest payload")
        return parsed

    def explain(self, *, system: str, user: str) -> dict:
        """One selected-text explanation over chat/completions
        (contract-r4.md §7): the reply is plain prose; an empty reply is
        the failure the domain answers with the 502."""
        text = self._chat(system=system, user=user).strip()
        if not text:
            raise RuntimeError("Qwen AI Provider returned an empty explanation")
        return {"explanation": text}


def create_qwen_provider(
    *,
    api_key: Any,
    base_url: Any = "",
    model: Any = "",
    transport: httpx.BaseTransport | None = None,
    timeout_ms: Any = None,
    timeout_factory: Callable[[float], httpx.Timeout] | None = None,
) -> QwenProvider:
    return QwenProvider(
        api_key=api_key,
        base_url=base_url,
        model=model,
        transport=transport,
        timeout_ms=timeout_ms,
        timeout_factory=timeout_factory,
    )


def select_ai_provider(config: Any):
    """Resolve the deployment config (main.py fills it from LD_AI_PROVIDER /
    LD_AI_API_KEY / LD_AI_MODEL / LD_AI_BASE_URL / LD_AI_TIMEOUT_MS) into
    one provider instance. Default is the deterministic stub so a bare
    start and every test get repeatable summaries; "qwen" is the product
    path."""
    name = str(getattr(config, "ai_provider_name", "") or "").strip().lower()
    if not name or name == "stub":
        return create_stub_provider(getattr(config, "ai_model", "") or None)
    if name == "qwen":
        return create_qwen_provider(
            api_key=getattr(config, "ai_api_key", ""),
            base_url=getattr(config, "ai_base_url", ""),
            model=getattr(config, "ai_model", ""),
            timeout_ms=getattr(config, "ai_timeout_ms", None),
        )
    raise RuntimeError(f'Unknown AI provider "{name}" (expected "stub" or "qwen")')
