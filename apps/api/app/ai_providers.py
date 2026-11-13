"""AI Provider seam for course summary generation (contract-r3.md §2.3,
§3.1; decisions D16/D17, ticket 4.4). Python port of lib/ai-providers.js.

The API is the ONLY holder of AI Provider credentials (D16: same reasoning
as D10 for speech, but the inputs are already-archived text, so the seam
lives here, not in the Worker — the two seams are parallel and
independent).

Interface (the one thing consumers may rely on):

    provider = { id: str, model: str, generate(*, system, user) }
    generate returns { content: str, citations: RawCitation[] }
    where RawCitation = { quote, sessionId, startMs, endMs } — the shape
    the model is asked for by prompts/course-summary.md; every citation is
    later reconciled against the archived records (app/summaries.py)
    before anything lands.

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


def create_stub_provider(model: str | None = None) -> StubProvider:
    return StubProvider(model)


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
    }


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
        timeout_factory: Callable[[int], httpx.Timeout] | None = None,
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

    def generate(self, *, system: str, user: str) -> dict:
        # A fresh timeout per call, never one shared across calls.
        timeout = (
            self._timeout_factory(self._timeout_ms)
            if self._timeout_factory
            else httpx.Timeout(self._timeout_ms)
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
        parsed = parse_summary_payload(_reply_text(response.json()))
        if not parsed:
            raise RuntimeError("Qwen AI Provider returned an unparseable summary payload")
        return parsed


def create_qwen_provider(
    *,
    api_key: Any,
    base_url: Any = "",
    model: Any = "",
    transport: httpx.BaseTransport | None = None,
    timeout_ms: Any = None,
    timeout_factory: Callable[[int], httpx.Timeout] | None = None,
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
