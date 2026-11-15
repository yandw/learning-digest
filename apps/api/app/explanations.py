"""Selected-text explanation domain (contract-r4.md §7, ticket 6.5,
issue #90). Port of the PoC's handleExplainSelection
(apps/extension/background.js) to a STATELESS server endpoint:
POST /v1/ai/explain takes {text, context?} from any logged-in user and
answers {explanation} — no collection of its own, no Session, only the
D18 usage counters record that a call happened.

The prompt is the migrated prompts/explain.md (D17 template-record
precedent): the PoC's Explain-button copy with the VIDEO line dropped
(the stateless request carries no video title) and the PoC's
absent-context fallback `None` kept verbatim.

Validation (400 validation_failed): the body must be a JSON object with
a non-empty string `text` and, when present, a string `context`; both
capped at EXPLAIN_TEXT_MAX_CHARS code points (the D18 counting unit).
Failure feedback (502 explain_failed): any provider raise, timeout, or
an explanation that is not a usable string — a stateless call lands
nothing but the answer, so there is no 脏数据 beyond a non-counted usage
row (which never gets written: the counters land with the answer, D18).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from .errors import ApiError, validation_failed
from .summaries import count_code_points, extract_fenced_block
from .usage import record_explain_generation

# D17 precedent: the prompt template is the contract record at the repo root.
PROMPT_FILE = Path(__file__).resolve().parents[3] / "prompts" / "explain.md"

# The stateless endpoint's length cap (code points, the D18 counting unit).
EXPLAIN_TEXT_MAX_CHARS = 8000

# The PoC's absent-context fallback (background.js: `transcriptContext:
# transcriptContext || "None"`), kept verbatim by the migration.
NOTHING_CONTEXT = "None"

_cached_template: dict | None = None

EXPLAIN_VARIABLE = re.compile(r"\{(selectedText|transcriptContext)\}")


def explain_failed() -> ApiError:
    return ApiError(
        502,
        "explain_failed",
        "解释生成失败，请稍后重试",
    )


def load_explain_template() -> dict:
    """Load (and cache) the { system, user } template from the contract
    file (the course-summary template loader's fenced-block shape)."""
    global _cached_template
    if _cached_template is None:
        markdown = PROMPT_FILE.read_text(encoding="utf-8")
        _cached_template = {
            "system": extract_fenced_block(markdown, "## System prompt"),
            "user": extract_fenced_block(markdown, "## User prompt"),
        }
    return _cached_template


def fill_explain_template(template: str, values: dict) -> str:
    """Fill the explain template's two variables in ONE pass (the
    tick/digest fill semantics: a fill value that itself contains a
    `{...}` token is never re-replaced; an unknown placeholder stays
    visible; missing values fill as the EMPTY string and values are
    str()-coerced — deliberately one notch stricter than the course-summary
    filler, see app/session_insights.py fill_tick_template)."""
    filled = dict(values)

    def replace(match: re.Match) -> str:
        name = match.group(0)[1:-1]
        fill = filled[name] if name in filled else ""
        return fill() if callable(fill) else str(fill)

    return EXPLAIN_VARIABLE.sub(replace, template)


def validate_explain_body(body: Any) -> dict:
    """The request shape (contract-r4 §7.2): text is a required non-empty
    string within the cap; context is an optional string within the cap
    (an empty one means no context, exactly like the PoC's falsy-or-None
    fallback). Unknown extra fields are ignored (the session domain's
    lenient-body style); a non-object body is the 400."""
    if not isinstance(body, dict):
        raise validation_failed("请求体必须是 JSON 对象")
    text = body.get("text")
    if not isinstance(text, str) or text.strip() == "":
        raise validation_failed("text 必须是非空字符串")
    if count_code_points(text) > EXPLAIN_TEXT_MAX_CHARS:
        raise validation_failed(f"text 不能超过 {EXPLAIN_TEXT_MAX_CHARS} 字符")
    context = body.get("context")
    if context is not None:
        if not isinstance(context, str):
            raise validation_failed("context 必须是字符串")
        if count_code_points(context) > EXPLAIN_TEXT_MAX_CHARS:
            raise validation_failed(f"context 不能超过 {EXPLAIN_TEXT_MAX_CHARS} 字符")
    return {"text": text, "context": context}


def explain(
    *,
    store: Any,
    account_id: str,
    body: Any,
    ai_provider: Any,
    now: Callable[[], int],
) -> dict:
    """POST /v1/ai/explain (contract-r4 §7.2): validate -> prompt ->
    provider -> answer + count. Stateless: 200 {explanation} or a contract
    error — there is nothing to store, so a failed attempt leaves nothing
    anywhere (the usage counters land with the 200, D18)."""
    parsed = validate_explain_body(body)
    template = load_explain_template()
    user = fill_explain_template(
        template["user"],
        {
            "selectedText": parsed["text"],
            "transcriptContext": parsed["context"] or NOTHING_CONTEXT,
        },
    )
    input_chars = count_code_points(template["system"]) + count_code_points(user)
    try:
        result = ai_provider.explain(system=template["system"], user=user)
    except Exception:
        raise explain_failed() from None
    explanation = result.get("explanation") if isinstance(result, dict) else None
    if not isinstance(explanation, str) or explanation.strip() == "":
        raise explain_failed()
    record_explain_generation(
        store=store, account_id=account_id, input_chars=input_chars, now=now
    )
    return {"status": 200, "body": {"explanation": explanation}}
