"""AI Provider seam unit tests (contract-r3.md §2.3; decisions D16/D17,
ticket 4.4 — Python port of test/ai-providers.test.js, issue #74; the
rolling-summary tick operation is contract-r4.md §6, ticket 6.4). Seam
under test: app/ai_providers.py — the interface the AI seams call
({ id, model, generate(system, user), generate_topics(system, user) }),
never the HTTP route.

Testing Decisions: a replacement AI Provider makes tests repeatable. The
stub must be deterministic (same input -> same output) and cite real
input material so the citation reconciliation can hold. The qwen provider
is tested for REQUEST SHAPE through an injected httpx transport (Bailian
compatible-mode chat/completions; no external network) — real calls stay
out of the test suite (D16: 真实调用留实测). The per-call timeout is
observed through the injectable `timeout_factory` — the regression pin of
the round-3 review fix (a construction-time signal aborts once and would
poison every later generation).
"""

import json

import httpx
import pytest

from app.ai_providers import (
    create_qwen_provider,
    create_stub_provider,
    select_ai_provider,
)
from app.config import Config

SYSTEM = "系统提示：只输出一个 JSON 对象。"
USER = "\n".join(
    [
        "资料标题：注意力机制详解 P2：自注意力",
        "",
        "已归档逐字稿（按来源时间轴排序）：",
        "[ses_a 0–30000] 欢迎来到这一节",
        "[ses_b 30000–60000] 注意力分数的计算",
        "[ses_a 138000–159000] 矩阵视角",
        "",
        "已跳过范围：",
        "[ses_b 150000–210000] 已跳过，该范围未取得文本",
        "",
        "学习者笔记：",
        "[src_x 200000] 3:20 起的例子值得回看",
    ]
)


def test_stub_provider_deterministic_same_input_byte_identical_output():
    provider = create_stub_provider()
    first = provider.generate(system=SYSTEM, user=USER)
    second = provider.generate(system=SYSTEM, user=USER)
    assert second == first


def test_stub_provider_exposes_id_and_model_and_names_the_resource():
    provider = create_stub_provider()
    assert provider.id == "stub"
    assert provider.model and isinstance(provider.model, str)
    generated = provider.generate(system=SYSTEM, user=USER)
    assert isinstance(generated["content"], str)
    assert "注意力机制详解 P2：自注意力" in generated["content"]
    assert "##" in generated["content"]


def test_stub_provider_citations_quote_lines_verbatim_one_latest_per_session():
    provider = create_stub_provider()
    generated = provider.generate(system=SYSTEM, user=USER)
    assert isinstance(generated["citations"], list)
    # One citation per distinct session — that session's latest record on
    # the shared timeline, quote verbatim, sorted by startMs.
    assert [c["sessionId"] for c in generated["citations"]] == ["ses_b", "ses_a"]
    assert [(c["startMs"], c["endMs"], c["quote"]) for c in generated["citations"]] == [
        (30000, 60000, "注意力分数的计算"),
        (138000, 159000, "矩阵视角"),
    ]


def test_stub_provider_model_override_is_honored():
    provider = create_stub_provider(model="stub-custom")
    assert provider.model == "stub-custom"


def _capturing_transport(calls, handler):
    """A MockTransport whose responses come from `handler`; every request
    is appended to `calls` (the ported `fetchImpl` capture seam)."""

    def wrapped(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    return httpx.MockTransport(wrapped)


def test_qwen_provider_requires_an_api_key_at_construction_fails_closed():
    with pytest.raises(RuntimeError, match="API key"):
        create_qwen_provider(api_key=None)
    with pytest.raises(RuntimeError, match="API key"):
        create_qwen_provider(api_key="   ")


def test_qwen_provider_default_model_is_qwen3_8_flash_and_configurable():
    assert create_qwen_provider(api_key="k").model == "qwen3.8-flash"
    assert create_qwen_provider(api_key="k", model="qwen-plus").model == "qwen-plus"


def test_qwen_provider_posts_bailian_chat_completions_and_parses_the_json_payload():
    calls: list[httpx.Request] = []
    payload = {
        "content": "# 总结",
        "citations": [{"quote": "原文", "sessionId": "ses_a", "startMs": 0, "endMs": 30000}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]},
        )

    provider = create_qwen_provider(api_key="ld-key", transport=_capturing_transport(calls, handler))
    generated = provider.generate(system=SYSTEM, user=USER)

    assert len(calls) == 1
    assert str(calls[0].url) == "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    assert calls[0].headers["Authorization"] == "Bearer ld-key"
    body = json.loads(calls[0].content)
    assert body["model"] == "qwen3.8-flash"
    assert [m["role"] for m in body["messages"]] == ["system", "user"]
    assert body["messages"][0]["content"] == SYSTEM
    assert body["messages"][1]["content"] == USER
    # qwen3 reasons before answering by default; on a long merged transcript
    # the reasoning phase outlived the 120s AI timeout and every generation
    # 502'd — product generations run with thinking disabled.
    assert body["enable_thinking"] is False
    assert generated == payload


def test_qwen_provider_base_url_and_model_overrides_hit_the_configured_endpoint():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"choices": [{"message": {"content": '{"content":"c","citations":[]}'}}]}
        )

    provider = create_qwen_provider(
        api_key="k",
        base_url="https://proxy.example/v1/",
        model="qwen-plus",
        transport=_capturing_transport(calls, handler),
    )
    provider.generate(system="s", user="u")
    assert str(calls[0].url) == "https://proxy.example/v1/chat/completions"
    assert json.loads(calls[0].content)["model"] == "qwen-plus"


def test_qwen_provider_fenced_and_chatty_json_output_is_parsed_missing_citations_defaults_empty():
    def make_handler(content: str):
        return lambda request: httpx.Response(
            200, json={"choices": [{"message": {"content": content}}]}
        )

    fenced = create_qwen_provider(
        api_key="k",
        transport=_capturing_transport(
            [], make_handler('```json\n{"content":"c","citations":[]}\n```')
        ),
    ).generate(system="s", user="u")
    assert fenced == {"content": "c", "citations": []}

    chatty = create_qwen_provider(
        api_key="k",
        transport=_capturing_transport(
            [],
            make_handler(
                '前言 {"content":"正","citations":[{"quote":"q","sessionId":"s","startMs":1,"endMs":2}]} 后记'
            ),
        ),
    ).generate(system="s", user="u")
    assert chatty["content"] == "正"
    assert len(chatty["citations"]) == 1

    # Missing citations key defaults to [] (content-only responses stay usable).
    no_citations = create_qwen_provider(
        api_key="k", transport=_capturing_transport([], make_handler('{"content":"c"}'))
    ).generate(system="s", user="u")
    assert no_citations == {"content": "c", "citations": []}


def test_qwen_provider_http_failure_and_unparseable_payloads_both_raise():
    # The route turns both into the contract 502; here they must raise.
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="rate limited")

    with pytest.raises(RuntimeError, match="HTTP 429"):
        create_qwen_provider(api_key="k", transport=_capturing_transport([], failing)).generate(
            system="s", user="u"
        )

    def garbage(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "完全不是 JSON"}}]})

    with pytest.raises(RuntimeError, match="unparseable"):
        create_qwen_provider(api_key="k", transport=_capturing_transport([], garbage)).generate(
            system="s", user="u"
        )


def test_qwen_provider_timeout_is_created_fresh_per_generate_call():
    factory_calls: list[float] = []
    timeouts_seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        timeouts_seen.append(request.extensions.get("timeout"))
        return httpx.Response(
            200, json={"choices": [{"message": {"content": '{"content":"c","citations":[]}'}}]}
        )

    def timeout_factory(seconds: float) -> httpx.Timeout:
        factory_calls.append(seconds)
        return httpx.Timeout(seconds)

    provider = create_qwen_provider(
        api_key="k",
        transport=_capturing_transport([], handler),
        timeout_ms=120000,
        timeout_factory=timeout_factory,
    )
    provider.generate(system="s", user="u")
    provider.generate(system="s", user="u")

    # Every call builds a NEW timeout object with the construction-fixed
    # value. A construction-time signal/timeout would expire once and make
    # every later generation fail (the pre-fix production regression).
    assert len(timeouts_seen) == 2
    assert factory_calls == [120.0, 120.0]
    assert timeouts_seen[0] is not None and timeouts_seen[1] is not None


def test_qwen_provider_timeout_units_are_seconds_not_milliseconds():
    """config/main promise milliseconds (LD_AI_TIMEOUT_MS); httpx.Timeout
    speaks seconds. The default path (no injected factory) must convert:
    timeout_ms=120000 reaches the transport as 120.0s, never 120000s."""
    timeouts_seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        timeouts_seen.append(request.extensions.get("timeout"))
        return httpx.Response(
            200, json={"choices": [{"message": {"content": '{"content":"c","citations":[]}'}}]}
        )

    provider = create_qwen_provider(
        api_key="k",
        transport=_capturing_transport([], handler),
        timeout_ms=120000,
    )
    provider.generate(system="s", user="u")

    assert len(timeouts_seen) == 1
    # httpx stores the timeout on the request extensions as a plain
    # {connect, read, write, pool} dict of SECONDS.
    timeout = timeouts_seen[0]
    assert timeout is not None
    assert timeout == {
        "connect": 120.0,
        "read": 120.0,
        "write": 120.0,
        "pool": 120.0,
    }


def test_qwen_provider_a_timed_out_call_does_not_poison_the_next_one():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectTimeout("simulated elapsed timeout", request=request)
        return httpx.Response(
            200, json={"choices": [{"message": {"content": '{"content":"ok","citations":[]}'}}]}
        )

    provider = create_qwen_provider(api_key="k", transport=_capturing_transport([], handler))
    with pytest.raises(Exception):
        provider.generate(system="s", user="u")
    second = provider.generate(system="s", user="u")
    assert second["content"] == "ok"


TICK_FIRST_BATCH_USER = "\n".join(
    [
        "这是本次会话的第一批话题段，此前没有已有话题。",
        "",
        "上文回顾（仅作上下文，不要总结成新的话题段）：",
        "（无）",
        "",
        "本段新逐字稿：",
        "[0–30000] 欢迎来到这一节，我们先回顾上一课留下的三个问题",
        "[30000–60000] 注意力分数的计算，就是把查询向量和键向量做点积",
    ]
)

TICK_CONTINUATION_USER = "\n".join(
    [
        "已有话题（按时间顺序）：",
        "- 开场回顾",
        "",
        "上一批的最后一个话题：「开场回顾」",
        "",
        "上文回顾（仅作上下文，不要总结成新的话题段）：",
        "[0–30000] 欢迎来到这一节",
        "",
        "本段新逐字稿：",
        "[60000–90000] 最后我们补一段：注意力机制在长序列下的处理思路",
    ]
)


def test_stub_provider_topics_chunk_the_tick_window_deterministically():
    provider = create_stub_provider()
    topics = provider.generate_topics(system="系统提示：只输出一个 JSON 数组。", user=TICK_FIRST_BATCH_USER)

    # Deterministic rule: consecutive pairs of records become one Topic
    # spanning the group; the title quotes the first line (12 chars).
    assert topics == [
        {
            "start": 0,
            "end": 60000,
            "title": "欢迎来到这一节，我们先回",
            "text": "欢迎来到这一节，我们先回顾上一课留下的三个问题；注意力分数的计算，就是把查询向量和键向量做点积",
        }
    ]
    # Same input, same append (the tick stub is deterministic).
    again = create_stub_provider().generate_topics(system="s", user=TICK_FIRST_BATCH_USER)
    assert again == topics

    # A tick after existing Topics marks the first output as continuation
    # (the prompt's continuation rule), and the context tail is ignored.
    continued = provider.generate_topics(system="s", user=TICK_CONTINUATION_USER)
    assert continued == [
        {
            "start": 60000,
            "end": 90000,
            "title": "最后我们补一段：注意力机",
            "text": "最后我们补一段：注意力机制在长序列下的处理思路",
            "continuation": True,
        }
    ]


def test_qwen_provider_topics_tolerate_fences_prose_and_wrappers():
    bare = '[{"start":0,"end":60000,"title":"话题","text":"总结"}]'

    def make_handler(content: str):
        return lambda request: httpx.Response(
            200, json={"choices": [{"message": {"content": content}}]}
        )

    parsed = [{"start": 0, "end": 60000, "title": "话题", "text": "总结"}]
    for reply in (bare, f"```json\n{bare}\n```", f"好的，以下是切分结果：{bare}", f'{{"topics": {bare}}}'):
        provider = create_qwen_provider(
            api_key="k", transport=_capturing_transport([], make_handler(reply))
        )
        assert provider.generate_topics(system="s", user="u") == parsed, reply

    # The most common LLM slip — a trailing comma before ] — is repaired.
    repaired = create_qwen_provider(
        api_key="k",
        transport=_capturing_transport([], make_handler('[{"start":0,"end":60000,"title":"t","text":"x"},]')),
    ).generate_topics(system="s", user="u")
    assert repaired == [{"start": 0, "end": 60000, "title": "t", "text": "x"}]

    # Unparseable replies raise — the domain answers the contract 502.
    garbage = create_qwen_provider(
        api_key="k", transport=_capturing_transport([], make_handler("完全不是 JSON"))
    )
    with pytest.raises(RuntimeError, match="unparseable topic-tick"):
        garbage.generate_topics(system="s", user="u")


def test_select_ai_provider_defaults_to_stub_gates_qwen_on_key_fails_loudly_on_unknown():
    assert select_ai_provider(Config()).id == "stub"
    assert select_ai_provider(Config(ai_provider_name="stub")).id == "stub"
    assert select_ai_provider(Config(ai_provider_name="qwen", ai_api_key="ld-key")).id == "qwen"
    # A qwen selection without a key fails closed at startup, not per request.
    with pytest.raises(RuntimeError, match="API key"):
        select_ai_provider(Config(ai_provider_name="qwen"))
    with pytest.raises(RuntimeError, match="bogus"):
        select_ai_provider(Config(ai_provider_name="bogus"))
    # The model override flows through to the constructed provider.
    assert select_ai_provider(Config(ai_model="stub-x")).model == "stub-x"
    assert (
        select_ai_provider(Config(ai_provider_name="qwen", ai_api_key="k", ai_model="qwen-plus")).model
        == "qwen-plus"
    )
