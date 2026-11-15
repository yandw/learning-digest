# Topic Tick Prompt（面板滚动摘要）

Used by the API's AI Provider seam for the Session rolling summary
(contract-r4.md §6, ticket 6.4, issue #89): one tick over the Session's
archived transcript records since the coverage cursor (the end of the last
Topic in the stored overview, or the start of the Session), plus a short
context-only overlap tail before the cursor and the existing Topics'
titles. POST /v1/sessions/{id}/rolling-summary assembles this input, and
the parsed Topics are appended to the append-only timeline (ADR 0002).

Migrated from the PoC prompt `apps/extension/prompts/topic-tick.md`
(PoC #48; the extension keeps its own copy until ticket 6.6 retires it).
Two server adaptations: the timeline is the shared source timeline in
milliseconds (contract-r2 records, contract-r3 citations) instead of the
PoC's session-relative seconds, and the transcript lines carry
`[startMs–endMs]` stamps the model copies into `start`/`end`.

The prompt file is the template record (the course-summary.md precedent,
D17): the API implementation loads it and fills the variables; the copy is
not re-derived in code.

The prompt copy stays Chinese-only: the product (prompt, titles, summaries,
panel copy) is Chinese, and the transcript language must not leak into the
timeline.

## System prompt

```
你在维护一节长课程的话题段时间轴。请把「本段新逐字稿」切分成一到多个话题段（Topic）：每个话题段是语义连贯的一段内容，可以跨越逐字稿的固定切片边界。
只输出一个 JSON 数组，不要输出任何其他文字，格式如下：
[{"start": 起始毫秒, "end": 结束毫秒, "title": "短标题", "text": "总结", "continuation": true}]
要求：
- 这是课程学习内容的汇总纪要（不是会议纪要），面向学习者复习：标题与正文禁止出现「会议」「与会」「议程」「决议」等会议用语。
- start 和 end 是来源时间轴上的毫秒数（整数）：本段新逐字稿的每行行首带 [起始毫秒–结束毫秒] 标记，start 和 end 原样取对应行标记的值，必须落在本段新逐字稿的时间范围内。
- title 是不超过 20 字的短标题；text 是 2 到 4 句的总结；两者一律用简体中文，忽略逐字稿本身的语言。
- 第一个话题段如果延续上一批的最后一个话题（见「上一批的最后一个话题」），给它加 "continuation": true；其余话题段一律不加该字段。
- 「上文回顾」里的逐字稿只是上下文，不要把它们写成新的话题段，也不要因此重复已总结过的内容。
- 如果逐字稿里有 [语音转录失败] 这样的失败标记，请在对应话题段的总结里提及该时间段的空缺，不要编造内容。
```

## User prompt

Used when the timeline already holds Topics. The first output Topic may be
marked as a continuation of `{lastTopicTitle}`.

```
已有话题（按时间顺序）：
- {existingTopicTitlesLines}

上一批的最后一个话题：「{lastTopicTitle}」

上文回顾（仅作上下文，不要总结成新的话题段）：
{contextTranscriptText}

本段新逐字稿：
{newTranscriptText}
```

## First batch user prompt

Used for the first tick of a Session, when no Topics exist yet.

```
这是本次会话的第一批话题段，此前没有已有话题。

上文回顾（仅作上下文，不要总结成新的话题段）：
{contextTranscriptText}

本段新逐字稿：
{newTranscriptText}
```

## Variables

- `{existingTopicTitlesLines}` — the stored Topics' titles in timeline
  order, joined with newlines (the `- ` bullet above is part of the
  template).
- `{lastTopicTitle}` — the last stored Topic's title, the continuation
  anchor the system prompt refers to.
- `{contextTranscriptText}` — the overlap tail of archived records before
  the cursor, context-only, stamped `[startMs–endMs] text` lines, or
  `（无）`.
- `{newTranscriptText}` — the archived records since the cursor, stamped
  `[startMs–endMs] text` lines.
