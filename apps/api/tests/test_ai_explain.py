"""Selected-text explanation (contract-r4.md §7, ticket 6.5, issue #90).
The stateless POST /v1/ai/explain: {text, context?} from any logged-in
user answers {explanation} — no collection of its own, only the D18
usage counters record that a call happened. The prompt is the migrated
prompts/explain.md (the PoC panel's Explain button, minus the video-title
line the stateless request cannot fill); the deterministic stub provider
makes every expectation repeatable, and failure cases inject fault
providers through the same create_app seam the other AI tests use.
"""

from helpers import auth_header, open_account_with_id

EMAIL = "explain@example.com"

TEXT = "把查询向量和键向量做点积"
CONTEXT = "注意力分数的计算先从相似度开始"


def explain(app, token: str, body: dict):
    return app.request(
        "POST",
        "/v1/ai/explain",
        headers=auth_header(token),
        body=body,
    )


def test_explain_answers_the_explanation_and_counts(start_app):
    app = start_app(seed_emails=[EMAIL])
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    answered = explain(app, token, {"text": TEXT, "context": CONTEXT})
    assert answered.status == 200, answered.json
    explanation = answered.json["explanation"]
    assert isinstance(explanation, str) and explanation != ""
    # The deterministic stub explains from the filled template: the
    # selection and the context are both in the answer's making.
    assert TEXT in explanation

    # D18 口径: one landed stateless call, inputChars summed.
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["explainCount"] == 1
    assert usage["explainInputChars"] > 0
    assert usage["digestCount"] == 0
    assert usage["summaryCount"] == 0


def test_explain_without_context_uses_the_poc_fallback(start_app):
    app = start_app(seed_emails=[EMAIL])
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    answered = explain(app, token, {"text": TEXT})
    assert answered.status == 200, answered.json
    assert answered.json["explanation"] != ""


class ScriptedExplainProvider:
    """Captures the assembled explain prompt; fails on demand."""

    id = "scripted-explain"
    model = "scripted-explain-1"

    def __init__(self, fail=False, explanation=None):
        self.calls = 0
        self.prompts = []
        self.fail = fail
        self.explanation = explanation

    def generate(self, *, system, user):
        raise AssertionError("the explain path must not use the course-summary operation")

    def generate_topics(self, *, system, user):
        raise AssertionError("the explain path must not use the rolling-summary operation")

    def generate_digest(self, *, system, user):
        raise AssertionError("the explain path must not use the digest operation")

    def explain(self, *, system, user):
        self.calls += 1
        if self.fail:
            raise RuntimeError("AI Provider 宕机")
        self.prompts.append({"system": system, "user": user})
        return {"explanation": self.explanation or "点积衡量两个向量的对齐程度。"}


def test_explain_prompt_carries_the_selection_and_context(start_app):
    provider = ScriptedExplainProvider()
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    answered = explain(app, token, {"text": TEXT, "context": CONTEXT})
    assert answered.status == 200, answered.json
    assert provider.calls == 1
    assert provider.prompts[0]["system"].startswith("You explain selected text")
    user = provider.prompts[0]["user"]
    assert f'SELECTED: "{TEXT}"' in user
    assert f"CONTEXT: {CONTEXT}" in user

    answered = explain(app, token, {"text": TEXT})
    assert answered.status == 200
    assert "CONTEXT: None" in provider.prompts[1]["user"]


def test_explain_validates_text_and_context(start_app):
    provider = ScriptedExplainProvider()
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    too_long = "字" * 8001
    for body, where in [
        ({}, "missing text"),
        ({"text": ""}, "empty text"),
        ({"text": "   "}, "whitespace text"),
        ({"text": 123}, "non-string text"),
        ({"text": too_long}, "over-cap text"),
        ({"text": TEXT, "context": 123}, "non-string context"),
        ({"text": TEXT, "context": too_long}, "over-cap context"),
    ]:
        response = explain(app, token, body)
        assert response.status == 400, (where, response.json)
        assert response.json["error"]["code"] == "validation_failed", (where, response.json)

    # A non-object body is the same 400 family.
    response = app.request(
        "POST", "/v1/ai/explain", headers=auth_header(token), body=["text"]
    )
    assert response.status == 400
    assert response.json["error"]["code"] == "validation_failed"

    # No AI call, no usage for any rejected attempt.
    assert provider.calls == 0
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["explainCount"] == 0
    assert usage["explainInputChars"] == 0

    # 8000 code points exactly is inside the cap (the D18 口径 counts code
    # points, and the boundary is inclusive).
    at_cap = explain(app, token, {"text": "字" * 8000})
    assert at_cap.status == 200, at_cap.json


def test_explain_ai_failure_answers_502_and_counts_nothing(start_app):
    provider = ScriptedExplainProvider(fail=True)
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    failed = explain(app, token, {"text": TEXT})
    assert failed.status == 502
    assert failed.json["error"]["code"] == "explain_failed"
    assert provider.calls == 1

    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["explainCount"] == 0
    assert usage["explainInputChars"] == 0


class EmptyExplanationProvider(ScriptedExplainProvider):
    def explain(self, *, system, user):
        self.calls += 1
        return {"explanation": "   "}


def test_an_explanation_that_is_only_whitespace_is_a_failure(start_app):
    provider = EmptyExplanationProvider()
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    failed = explain(app, token, {"text": TEXT})
    assert failed.status == 502
    assert failed.json["error"]["code"] == "explain_failed"
    usage = app.request("GET", "/v1/usage", headers=auth_header(token)).json
    assert usage["explainCount"] == 0


def test_explain_requires_a_bearer_credential(start_app):
    app = start_app(seed_emails=[EMAIL])

    response = app.request("POST", "/v1/ai/explain", body={"text": TEXT})
    assert response.status == 401
    assert response.json["error"]["code"] == "unauthorized"


def test_error_copies_match_the_contract_fixtures(start_app):
    """The explain codes' messages are the error-examples.json samples
    verbatim (the shared-samples discipline: the API implementation quotes
    the fixtures, it does not re-derive copy)."""
    from helpers import error_example

    provider = ScriptedExplainProvider(fail=True)
    app = start_app(seed_emails=[EMAIL], ai_provider=provider)
    account = open_account_with_id(app, EMAIL)
    token = account["token"]

    failed = explain(app, token, {"text": TEXT})
    assert failed.json["error"]["message"] == (
        error_example("error-explain-failed")["response"]["body"]["error"]["message"]
    )

    empty = explain(app, token, {"text": ""})
    assert empty.json["error"]["message"] == (
        error_example("error-explain-empty-text")["response"]["body"]["error"]["message"]
    )

    too_long = explain(app, token, {"text": "字" * 8001})
    assert too_long.json["error"]["message"] == (
        error_example("error-explain-text-too-long")["response"]["body"]["error"]["message"]
    )
