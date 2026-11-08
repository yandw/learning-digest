# Topic Tick Prompt

Used in `background.js` when the summary timer fires a Topic tick (ADR 0002):
the Transcript since the last Topic plus a short overlap tail are split into
new Topics and appended to the Rolling Summary. `buildTopicBlockMessages` in
`session-summary.js` fills the placeholders from Session state.

The prompt copy stays Chinese-only: the product (prompt, titles, summaries,
panel copy) is Chinese, and the transcript language must not leak into the
timeline.

## System prompt

```
你在维护一节长课程的话题段时间轴。请把「本段新逐字稿」切分成一到多个话题段（Topic）：每个话题段是语义连贯的一段内容，可以跨越逐字稿的固定切片边界。
只输出一个 JSON 数组，不要输出任何其他文字，格式如下：
[{"start": 起始秒数, "end": 结束秒数, "title": "短标题", "text": "总结", "continuation": true}]
要求：
- 这是课程学习内容的汇总纪要，面向学习者复习：标题与正文禁止出现「会议」「与会」「议程」「决议」等会议用语。
- start 和 end 是相对会话开始的秒数（整数），必须落在本段新逐字稿的时间范围内。
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

- `{existingTopicTitlesLines}` — the appended Topics' titles in timeline
  order, joined with newlines (the `- ` bullet above is part of the template).
- `{lastTopicTitle}` — the last existing Topic's title, the continuation
  anchor the system prompt refers to.
- `{contextTranscriptText}` — the overlap-tail Transcript before the cursor,
  context-only, or `（无）`.
- `{newTranscriptText}` — the new Transcript since the last Topic, stamped as
  `[m:ss]` lines.
