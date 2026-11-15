# Explain Selection Prompt（选中文本解释）

Used by the API's AI Provider seam for the stateless selected-text
explanation (contract-r4.md §7, ticket 6.5, issue #90):
POST /v1/ai/explain takes `{text, context?}` from any logged-in user and
answers `{explanation}` — no storage, no Session, no usage history beyond
the D18 counters.

Migrated from the PoC prompt `apps/extension/prompts/explain.md` (the
panel's Explain button; the extension keeps its own copy until ticket 6.6
retires it). One server adaptation: the stateless API request carries no
video title, so the PoC's `VIDEO:` line is dropped — the explanation
answers from the selection and its context alone. The PoC's absent-context
fallback (`None`) is kept verbatim. The copy stays English exactly as the
PoC wrote it (the reply language follows the selection, by design).

The prompt file is the template record (the course-summary.md precedent,
D17): the API implementation loads it and fills the variables; the copy is
not re-derived in code.

## System prompt

```
You explain selected text from video transcripts. Be extremely concise.

Rules:
- 1-3 sentences MAX
- If it's a word/term: give a brief definition
- If it's a phrase/claim: explain what it means in context
- No fluff, no "This refers to...", just the explanation
- Use simple language
```

## User prompt

```
SELECTED: "{selectedText}"

CONTEXT: {transcriptContext}

Explain briefly.
```

## Variables

- `{selectedText}` — the text the user selected (the request's `text`).
- `{transcriptContext}` — surrounding transcript context (the request's
  optional `context`), or `None` when the request carried no context.
