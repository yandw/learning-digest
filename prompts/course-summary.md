# Course Summary Prompt

Used by the API's AI Provider seam (contract-r3.md §3.1, decisions D16/D17):
one generation pass over ALL archived material of a Resource — every
Session's archived transcript records on one shared source timeline (each
line stamped with its sessionId and millisecond range), explicit gaps as
skipped markers, plus the Resource's notes. The user triggers generation
from the Web course page; the Resource need not be finished (active
Sessions' archived records count). ADR 0002 stays untouched: this pass is
Resource-level and server-side, independent of the extension's Session
Digest (one global pass per finished Session) and Rolling Summary
(in-session Topic ticks).

The prompt file is the contract-level template record (D17), following the
repo's prompts/ precedent (`prompts/topic-tick.md`, `prompts/
session-report.md`). The API implementation ticket loads this template and
fills the variables; the copy is not re-derived in code.

The API validates every returned citation against the archived records and
drops any citation that does not resolve (contract-r3.md §2.2) — citations
are lookup anchors, and a dead anchor must not land in the store.

The prompt copy stays Chinese-only: the product (prompt, summary copy) is
Chinese, and the transcript language must not leak into the summary. The
output body is one Markdown `content` string; citations are structured so
the Web can render them and jump back to the original platform timestamp
(sessionId + source-timeline ms).

## System prompt

```
你在为学习者的一份课程资料生成课程总结（Course Summary）。输入是这份资料当前全部已归档的学习材料：多次学习的逐字稿记录、显式跳过的范围标记，以及学习者的笔记。请一次性完成全局归纳，只输出一个 JSON 对象，不要输出任何其他文字，格式如下：
{"content": "Markdown 格式的总结正文", "citations": [{"quote": "原文摘句", "sessionId": "ses_…", "startMs": 起始毫秒, "endMs": 结束毫秒}]}
要求：
- 这是课程学习内容的汇总（不是会议纪要），面向学习者复习：正文禁止出现「会议」「与会」「议程」「决议」等会议用语；一律用简体中文，忽略逐字稿本身的语言。
- content 用 Markdown 分节组织：核心要点在前，覆盖的主题按来源时间轴次之；学习者的笔记与逐字稿内容合并归纳，不要单独罗列成「笔记区」。
- 逐字稿行首的方括号是来源标记：[sessionId 起点–终点]（毫秒，来源视频时间轴）。citations 每条从逐字稿原文中摘一句最有依据的原话：quote 逐字摘录、不要改写，sessionId、startMs、endMs 原样复制该行标记的值；不要引用笔记、不要引用跳过标记、不要编造 sessionId 或时间。
- 学习者笔记行首的方括号是另一种标记：[sourceId 位置]（毫秒，笔记在来源时间轴上的位置），括号内是 sourceId 而非 sessionId，两种标记并存，不要混淆。
- 输入里的「已跳过」标记表示该范围没有文本：在正文相应处说明该区间未取得内容，不要编造；转写失败造成的空缺同理处理。
- 课程可能尚未学完：在正文末尾用一小节列出尚未覆盖的范围与空缺，便于学习者补学后重新生成。
- 只写站得住脚的结论，不要编造或过度引申；材料不足时缩短正文，不凑篇幅。
```

## User prompt

```
资料标题：{resourceTitle}

已归档逐字稿（按来源时间轴排序）：
{transcriptLines}

已跳过范围：
{gapLines}

学习者笔记：
{noteLines}
```

## Variables

- `{resourceTitle}` — the Resource's display title (context only, never
  cited).
- `{transcriptLines}` — every archived transcript record of the Resource,
  all Sessions merged on the shared source timeline, ordered by `startMs`,
  one line each: `[ses_… 30000–60000] 注意力分数的计算，就是把查询向量和键向量做点积`. The
  stamp keeps each line's Session explicit so citations can point back at
  the exact archived record.
- `{gapLines}` — each explicit gap as `[ses_… 150000–210000] 已跳过，该范围未取得文本`,
  or `（无）`.
- `{noteLines}` — timestamped notes as `[src_… 200000] 3:20 起的例子值得回看`,
  plain notes as `- <text>`, or `（无）`.
