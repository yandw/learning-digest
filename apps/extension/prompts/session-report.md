# Session Digest Global Pass Prompt

Used in `background.js` when a Session ends (ADR 0002): one global pass over
the FULL Transcript produces the Session Digest report JSON, independent of
the Rolling Summary. `buildGlobalPassMessages` in `session-summary.js` fills
the placeholders from Session state.

Schema v2 (0.1.38) adds three optional fields the rich report template
renders: `overview` (3–5 one-sentence core takeaways for the 核心要点 card),
per-Topic `bullets` (2–5 short points, preferred over the v1 `summary`
fallback) and `categories` (2–4 thematic groupings for the 主题归纳 grid).
The parser clamps them; the renderers omit empty sections, so a model that
returns only the v1 shape still produces a complete report.

The prompt copy stays Chinese-only: the product (prompt, titles, summaries,
report copy) is Chinese, and the transcript language must not leak into the
report.

## System prompt

```
你在为已结束的课程生成一份完整的学习纪要（课程内容的汇总，不是会议纪要）。请通读全部逐字稿，一次性完成全局整理，只输出一个 JSON 对象，不要输出任何其他文字，格式如下：
{"overview": ["一句话核心结论"], "topics": [{"start": 起始秒数, "end": 结束秒数, "title": "短标题", "bullets": ["要点短句"], "summary": "总结"}], "categories": [{"title": "主题名", "points": ["要点"]}], "quotes": [{"start": 时间戳秒数, "text": "原话"}], "todos": ["待办事项"]}
要求：
- 这是课程学习内容的汇总纪要，面向学习者复习：标题与正文禁止出现「会议」「与会」「议程」「决议」等会议用语。
- overview 提炼 3 到 5 条一句话核心结论，每条都必须以逐字稿内容为依据，只写站得住脚的结论，不要编造或过度引申。
- topics 把整节课切分成语义连贯的话题段：start 和 end 是相对会话开始的秒数（整数），时间范围必须以逐字稿为准；title 是不超过 20 字的短标题，bullets 是 2 到 5 条概括这一话题的要点短句，两者一律用简体中文，忽略逐字稿本身的语言；内容不适合拆成要点时，可用 summary 给出 2 到 4 句的总结代替。
- 课中时间轴上因分段总结拆开的延续话题（同一话题被拆成多段）必须合并为一个完整的话题段，不要按拆分后的片段划分。
- 逐字稿因录音切片可能出现在开头或结尾被截断的句子：忽略截断痕迹，把跨切片的句子衔接起来理解，不要为切片边界单独划分话题。
- categories 从整节课的全局视角归纳 2 到 4 个主题类别，每个类别 2 到 4 条要点；主题类别是跨话题的内容归类，不要复述 topics 的时间轴。
- quotes 挑选课中最有价值的原话（最多 5 条），每条必须携带它在逐字稿中的时间戳（秒数）。
- 只有当逐字稿里确实出现行动项（作业、待办、下一步要做的事）时才输出 todos；没有就输出空数组。
- overview、bullets、categories 都是可选字段：没有合适内容时输出空数组即可，不要勉强编造。
- 如果逐字稿里有 [语音转录失败] 这样的失败标记，请在对应话题段的总结里提及该时间段的空缺，不要编造内容。
```

## User prompt

Used when the live Topic timeline holds Topics; they ride along as a merge
hint the model may use, never as input to trust blindly.

```
课中已识别的话题段（可参考/合并）：
- {liveTopicsLines}

完整逐字稿：
{transcriptText}
```

## User prompt without topics

Used when no live Topics were identified (for example, no tick fired).

```
完整逐字稿：
{transcriptText}
```

## Variables

- `{liveTopicsLines}` — the live Topics as `[m:ss–m:ss] title` entries,
  joined with newlines (the `- ` bullet above is part of the template).
- `{transcriptText}` — the FULL Transcript of the Session, stamped as
  `[m:ss]` lines, or `（无）`.
