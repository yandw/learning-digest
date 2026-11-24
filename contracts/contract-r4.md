# Learning Digest 第四轮共享契约：站点能力注册表与管理员标记

状态：第四轮（站点能力工程化）三端共享契约。对应 Ticket 6.1（issue #86，spec #49 第四轮节）。术语遵循仓库根 [GLOSSARY.md](../GLOSSARY.md)。通用约定——协议与编码、身份、账号隔离（404）、错误封套、201/200、不透明 ID、ISO 8601 UTC——完全沿用 [contract-v1.md](contract-v1.md) §1/§4；本文只写第四轮新增结构与端点。

本文是 Web 学习库、浏览器插件与后端 API 的公共接口定义。**唯一权威样例仍是 `fixtures/` 下的 JSON 文件**：第四轮成功样例在 `fixtures/site-capability-examples.json`，错误样例追加在 `fixtures/error-examples.json` 尾部；`contract-fixtures.test.js`、`contract-r2-fixtures.test.js`、`contract-r3-fixtures.test.js` 与新增 `contract-r4-fixtures.test.js`（`node --test contracts/` 可跑）保证样例可解析且符合本文定义。三端实现票直接引用同一份样例，不各自另写期望值。

- 第一轮结构与端点：[contract-v1.md](contract-v1.md)
- 第二轮结构与端点：[contract-r2.md](contract-r2.md)
- 第三轮结构与端点：[contract-r3.md](contract-r3.md)
- 第四轮结构与端点：本文
- 第六轮追加（面板 AI 服务端化 I，§6）：滚动摘要与概览；样例在 `fixtures/session-overview-examples.json`，tick prompt 外移 [../prompts/topic-tick.md](../prompts/topic-tick.md)
- 第六轮追加（面板 AI 服务端化 II，§7）：Session Digest 与选中文本解释；样例在 `fixtures/session-digest-examples.json`，digest prompt 外移 [../prompts/session-report.md](../prompts/session-report.md)、explain prompt 外移 [../prompts/explain.md](../prompts/explain.md)
- 第七轮追加（删除能力，§8）：DELETE /v1/resources/{id}；样例在 `fixtures/resource-delete-examples.json`，错误样例复用既有 `error-cross-account-resource` / `error-unauthorized-missing-token`（不新增错误样例）
- 契约决策记录（第四轮 D19–D20、面板轮 D21–D22、删除轮 D23）：[decisions.md](decisions.md)
- 样例：成功样例在 `fixtures/site-capability-examples.json` 与 `fixtures/session-digest-examples.json`；错误样例追加在 `fixtures/error-examples.json` 尾部。

## 1. 通用约定（沿用与差异）

- 沿用 contract-v1 §1 与 contract-r2/r3 §1 的全部约定。本轮不新增 ID 前缀：能力行以 platformId 为键，账号沿用既有 `acc_` 语义。
- **站点能力是服务端数据**（D20）：插件不再各自内置平台能力假设，字幕/ASR/禁用行为统一以服务端注册表为准；服务端是唯一写入方（管理员面），插件只读。
- **管理面的身份语义**（D19）：管理员标记是账号属性 `account.isAdmin`（默认 false），本轮唯一标记入口是邀请 CLI（`python -m app.invites add --admin`，邀请即标记）；没有翻转 isAdmin 的 API。管理面端点要求有效凭据 + `isAdmin`：未携带凭据 401（与一切受保护端点一致）；**已认证的非管理员一律 404，不透露端点存在性**（D2 语义延伸到管理面）。
- 幂等总则照旧：PUT 更新是「最后写入为准」的常规幂等写（非首轮的「首存为准」家族）。

## 2. 数据结构

### 2.1 SiteCapability（站点能力行）

按 platformId 一行，描述服务端对该平台的能力判定：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `platformId` | string | 是 | 平台标识（bilibili / youtube / xiaoe / xiaohongshu / xiaoyuzhou 等，非枚举约束的不透明字符串） |
| `captions` | boolean | 是 | 该平台能否取到可用字幕（字幕优先路径是否可用） |
| `asr` | boolean | 是 | 该平台是否允许 ASR 转写 |
| `enabled` | boolean | 是 | 该平台是否启用站点能力（false 即整体禁用，插件不发起该平台的材料采集） |

四个字段全部必填且为布尔值；行内不携带时间戳等元数据——能力判定没有历史版本面，当前值即全部事实。

**种子默认**（启动时只补缺失行；已有行永不被启动覆写，D20）：

| platformId | captions | asr | enabled |
| --- | --- | --- | --- |
| `bilibili` | true | true | true |
| `youtube` | true | true | true |
| `xiaoe` | false | true | true |
| `xiaohongshu` | false | true | true |
| `xiaoyuzhou` | false | true | true |
| 其他（未种子平台） | false | true | true |

种子外的 platformId 不存在行，也不可经管理面创建（未知平台 404）——注册表的生长只发生在服务端代码/种子里，不由 API 调用方扩张。

### 2.2 account.isAdmin（管理员标记）

GET /v1/me 的 `account` 对象在既有 `id`/`email` 之上增加 `isAdmin`（boolean，普通账号缺省 false）。样例：`api-me-admin-flag`。标记入口见 §1（D19）；邀请 CLI 的 `list` 输出追加 admin 标记列（CLI 形态不属于 HTTP 契约面）。

## 3. 端点

### 3.1 GET /v1/site-capabilities — 普通用户读全表

- 任何登录用户可读（Bearer 凭据即可，不要求 isAdmin）：返回 `{ capabilities }`（§2.1 全表，种子顺序）。插件据此决定各平台的字幕/ASR/禁用行为。
- 未登录 401。
- 样例：`api-site-capabilities-list`、`error-site-capabilities-unauthorized`。

### 3.2 GET /v1/admin/site-capabilities — 管理员读全表

- 要求有效凭据 + `isAdmin`（D19）。返回与 §3.1 同构的 `{ capabilities }`——同一张表，不设分歧投影。
- 未登录 401；已认证的非管理员 404（D2，不透露端点存在性）。
- 样例：`api-admin-site-capabilities-list`、`error-admin-site-capabilities-not-admin`。

### 3.3 PUT /v1/admin/site-capabilities/{platformId} — 管理员改一行

- 要求有效凭据 + `isAdmin`（D19）。请求体是 `{captions?, asr?, enabled?}` 的**任意布尔子集**：未提及的字段保持原值；空对象 `{}` 是合法的空子集（200 原样返回该行）。
- 200：返回 `{ capability }`（更新后的完整行）。
- 校验（400 `validation_failed`）：字段值非布尔、请求体出现 `{captions, asr, enabled}` 之外的字段、请求体不是 JSON 对象——三种形态的固定文案见错误样例。
- 未知 platformId 404（`平台不存在`）：只有种子过的平台可管理。
- 样例：`api-admin-site-capability-update`、`error-admin-site-capability-unknown-platform`、`error-admin-site-capability-invalid-field`、`error-admin-site-capability-unknown-field`、`error-admin-site-capability-body-not-object`、`error-admin-site-capabilities-not-admin`（非管理员同样 404）。

## 4. 错误码（第四轮新增）

本轮不新增 `error.code`：400 `validation_failed`、401 `unauthorized`、404 `not_found` 全部沿用 contract-v1 §4 的封套与语义，第四轮只固定新的文案样例：

| HTTP | `error.code` | 语义 | 固定样例 |
| --- | --- | --- | --- |
| 401 | `unauthorized` | 未登录读能力表（普通用户 GET 与管理面 GET/PUT 同） | `error-site-capabilities-unauthorized` |
| 404 | `not_found` | 已认证非管理员访问管理面（D2：与未知路径不可区分） | `error-admin-site-capabilities-not-admin` |
| 404 | `not_found` | PUT 未知 platformId | `error-admin-site-capability-unknown-platform` |
| 400 | `validation_failed` | PUT 字段值非布尔（`captions 必须是布尔值`） | `error-admin-site-capability-invalid-field` |
| 400 | `validation_failed` | PUT 体出现子集外字段（`不支持的字段 {field}`） | `error-admin-site-capability-unknown-field` |
| 400 | `validation_failed` | PUT 体不是 JSON 对象（`请求体必须是对象`） | `error-admin-site-capability-body-not-object` |

## 5. 与前三轮的关系

- 前三轮端点签名、语义与样例**零改动**。唯一的既有端点形态变化是 GET /v1/me 的 `account` 对象**追加** `isAdmin` 键（§2.2）：追加键不破坏既有消费者（按 id/email 读取的路径不受影响），contract-v1 的 me 语义不变。
- 站点能力是**纯配置读**：不与 Resource/Source/Session 的任何状态耦合，不出现在资料详情与 Session 归档里；插件在发起字幕/ASR 前查询（或缓存）该表。
- 管理面与第三轮用量端点同属「账号级服务端状态」家族，但能力行是**全局**的（无 accountId 维度）——行不属于账号，只属于平台。
- 本契约与前三轮同属 `/v1` 接口代际，fixtures 共用 `learning-digest-contracts/v1` 标记；版本发布单元不受本契约影响（planning-only，不 bump）。

## 6. 第六轮追加（面板 AI 服务端化 I）：滚动摘要与概览

第六轮把 PoC 的课中 Topic 时间轴（Rolling Summary，ADR 0002：append-only 的 Topic 时间轴，术语见 GLOSSARY）收归服务端——插件在会话中按内容节奏触发，服务端提供幂等的生成与读取端点（Ticket 6.4，issue #89；决策 D21）。面板 AI 与课程总结共用同一 AI Provider seam（D16 的 LD_AI_PROVIDER / LD_AI_API_KEY 语义不变）。本轮样例：成功样例在 `fixtures/session-overview-examples.json`；错误样例追加在 `fixtures/error-examples.json` 尾部。

### 6.1 SessionOverview（会话概览）

按 Session 一份，存于服务端 `sessionInsights` 集合（键为 sessionId，同 transcripts 的键法，本轮不新增 ID 前缀）：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `sessionId` | string | 是 | 所属 Session |
| `topics` | Topic[] | 是 | append-only 的 Topic 时间轴（ADR 0002），按时间轴次序 |
| `lastCoveredMs` | integer ≥ 0 | 是 | 时间轴覆盖到的逐字稿位置：最后一个 Topic 的终点（来源时间轴毫秒）；下一次 tick 从这里继续 |
| `generation` | object | 是 | 最近一次 tick 的生成元数据，形态同 contract-r3 §2.3（provider / model / inputChars） |
| `generatedAt` | string | 服务端生成 | 最近一次 tick 的完成时间，ISO 8601 UTC |

**Topic（概览条目）**：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `index` | integer ≥ 1 | 是 | 时间轴内的序号（1..N，时间轴次序），跨 tick 延续不重置 |
| `startMs` / `endMs` | integer ≥ 0 | 是 | 话题段在来源时间轴上的毫秒区间（endMs ≥ startMs；与 contract-r2 records 同一时间轴） |
| `title` | string | 是 | 不超过 20 字的短标题（服务端截断到 300 字硬上限） |
| `text` | string | 是 | 2–4 句的总结（服务端截断到 1500 字硬上限） |
| `continuation` | boolean | 否 | 仅当该 Topic 延续上一批最后一个话题时为 true；其余条目不带该键 |

### 6.2 端点

#### POST /v1/sessions/{id}/rolling-summary — 生成/追加滚动摘要（tick）

- 请求体为空对象 `{}`；任何登录用户可调用（Bearer，不要求 isAdmin）。**防抖语义由调用方控制**（PoC 的 ≥15 分钟覆盖或 ≥10 条新记录的内容驱动节奏留在插件）：服务端不设定时器，只在被调用时处理当前材料。
- 服务端从该 Session 已归档 transcript records 组装 tick 输入（PoC assembleTopicTickInput 移植）：覆盖游标（最后一个 Topic 的终点，无 Topic 时为 0）之后的 records（覆盖约定与 PoC 一致：记录 startMs 低于游标即视为已覆盖）、游标前 120 秒的仅上下文重叠尾（不总结成新 Topic）、既有 Topic 标题（延续锚）；按外移 prompt（[../prompts/topic-tick.md](../prompts/topic-tick.md)）组装后调 AI Provider。
- **append-only 语义**（ADR 0002）：新 tick 只把解析出的 Topic 追加到时间轴——既有 Topic 永不改写，index 延续；整份概览落库为最新版（文档级覆盖落库，追加规则活在 topics 内部）。覆盖游标随最后一个 Topic 的终点推进；跨 tick 边界的话题段以 continuation 标注。
- **幂等**：游标之后没有新记录时返回 200 与当前概览原样（**幂等回放**）——不调 AI、generatedAt 与 topics 不变、用量不计数；重复触发与重试因此安全。
- 201 首次生成（概览创建）；200 追加或幂等回放。响应体 `{ overview }`（§6.1 全形态）。
- 该 Session 没有任何已归档逐字稿记录：409 `no_session_transcript_to_summarize`，不发起 AI 调用（409 在 AI 调用前判定）。未知或其他账号的 Session 404（D2）。
- 失败反馈形态：AI Provider 调用失败/超时/返回不可解析或零可用话题返回 502 `rolling_summary_failed`，**不落脏数据**——概览与用量都不出现本次尝试（D16/D18 同口径）。
- 样例：`api-rolling-summary-generate`、`api-rolling-summary-append`、`api-rolling-summary-replay`、`error-rolling-summary-unauthorized`、`error-rolling-summary-cross-account`、`error-rolling-summary-no-transcript`、`error-rolling-summary-failed`。

#### GET /v1/sessions/{id}/overview — 读当前概览

- 返回 `{ overview }`（§6.1 全形态）：幂等读，与最近一次 tick 落库的文档一致。任何登录用户可调用（Bearer）。
- 未登录 401；未知或其他账号的 Session 404（D2）；该 Session 从未成功生成过概览返回 404 `overview_not_generated`（会话存在但概览未生成，与 D2 的 not_found 是两个码）。
- 样例：`api-session-overview`、`error-overview-unauthorized`、`error-overview-cross-account`、`error-overview-not-generated`。

### 6.3 用量口径扩展（D18 同构）

GET /v1/usage 的 Usage 在 contract-r3 §2.4 的四键之上追加两个键（既有键语义零改动，追加键不破坏既有消费者）：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `rollingSummaryCount` | integer ≥ 0 | 是 | 账号累计成功落库的滚动摘要 tick 次数（幂等回放不计） |
| `rollingSummaryInputChars` | integer ≥ 0 | 是 | 账号累计滚动摘要输入字符量：历次 tick 的 `generation.inputChars` 之和（Unicode 码点数，D18 口径） |

记录时点同 D18：tick 产物落库的同一时刻计数；失败 tick 与幂等回放不产生任何计数。

### 6.4 错误码（面板轮新增）

| HTTP | `error.code` | 语义 | 固定样例 |
| --- | --- | --- | --- |
| 409 | `no_session_transcript_to_summarize` | 该 Session 没有任何已归档逐字稿记录，tick 无法进行 | `error-rolling-summary-no-transcript` |
| 502 | `rolling_summary_failed` | AI Provider 调用失败/超时/返回不可解析或零可用话题；不落库、不计数，可再次触发 | `error-rolling-summary-failed` |
| 404 | `overview_not_generated` | 该 Session 还没有概览（从未成功生成过） | `error-overview-not-generated` |

401 / 404（跨账号，D2）沿用 contract-v1 §4 的封套与语义；本轮无新增 400 形态（tick 请求体为空对象，无字段校验面）。

## 7. 第六轮追加（面板 AI 服务端化 II）：Session Digest 与选中文本解释

第六轮把 PoC 的整节学习纪要（Session Digest，GLOSSARY 术语：已完成 Session 的按话题组织的汇总）与选中文本解释（Explain）收归服务端（Ticket 6.5，issue #90；决策 D22）。面板 AI 与课程总结共用同一 AI Provider seam（D16 的 LD_AI_PROVIDER / LD_AI_API_KEY 语义不变；seam 增加 digest 报告对象与 explain 两种形态）。本轮样例：成功样例在 `fixtures/session-digest-examples.json`；错误样例追加在 `fixtures/error-examples.json` 尾部。两个 prompt 外移为契约记录：digest 用 [../prompts/session-report.md](../prompts/session-report.md)（自 PoC `apps/extension/prompts/session-report.md` 迁移，时间轴从会话相对秒改为来源时间轴毫秒——D21 同一适配），explain 用 [../prompts/explain.md](../prompts/explain.md)（自 PoC `apps/extension/prompts/explain.md` 迁移；无状态请求不携带视频标题，VIDEO 行删除；context 缺省填 `None` 沿 PoC）。

### 7.1 SessionDigest（会话纪要）

按 Session 一份，存于服务端 `sessionDigests` 集合（键为 sessionId，同 transcripts/sessionInsights 的键法，本轮不新增 ID 前缀）：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `sessionId` | string | 是 | 所属 Session |
| `overview` | string[] | 是 | 核心要点：3–5 条一句话核心结论（可为空数组） |
| `topics` | DigestTopic[] | 是 | 话题时间轴：整节课的语义分段（可为空数组） |
| `categories` | DigestCategory[] | 是 | 主题归纳：2–4 个跨话题的主题类别（可为空数组） |
| `quotes` | DigestQuote[] | 是 | 金句：课中最有价值的原话（可为空数组） |
| `todos` | string[] | 是 | 待办：逐字稿中确实出现的行动项（可为空数组） |
| `generation` | object | 是 | 本次生成的元数据，形态同 contract-r3 §2.3（provider / model / inputChars） |
| `generatedAt` | string | 服务端生成 | 本次生成的完成时间，ISO 8601 UTC |

五个 report 键**固定恒在**：PoC 的「空节省略」是渲染语义（渲染器跳过空段），API 的存储与响应形态固定为五键，空段即空数组。至少一个部分有可用内容才落库（全空即生成失败，见 §7.4）。

**DigestTopic（纪要话题条目）**：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `startMs` / `endMs` | integer ≥ 0 | 是 | 话题段在来源时间轴上的毫秒区间（endMs ≥ startMs；与 contract-r2 records 同一时间轴） |
| `title` | string | 是 | 不超过 20 字的短标题（服务端截断到 300 字硬上限） |
| `bullets` | string[] | 否 | 2–5 条概括这一话题的要点短句（优先形态；每条截断到 300 字） |
| `summary` | string | 否 | 2–4 句的总结（v1 回退形态；截断到 1500 字） |

`bullets` 与 `summary` 至少存在其一（服务端清洗后两者皆空的条目被丢弃）；两者都在时渲染方优先 bullets。**DigestCategory** = `{title: string, points: string[]}`（2–4 个类别、每类 2–4 条要点，服务端截断同上）。**DigestQuote** = `{startMs: integer ≥ 0, text: string}`（text 截断到 3000 字）。**todos** 条目为字符串（截断到 500 字）。

### 7.2 端点

#### POST /v1/sessions/{id}/digest — 生成/重新生成纪要

- 请求体为空对象 `{}`；任何登录用户可调用（Bearer，不要求 isAdmin）。
- **仅限已结束的 Session**（整节一次性语义的前提是材料定型）：未 finish 返回 409 `session_not_finished`，不发起 AI 调用（409 在 AI 调用前判定）。
- 服务端对该 Session 的**全量 transcript** 组装 digest 输入：已归档 records 与 finish 上报的 skipped gaps（`已跳过，该范围未取得文本` 标记行）合并在单一来源时间轴上（startMs 升序，`[startMs–endMs]` 戳）；该 Session 的 Rolling Summary Topics 作为 liveTopics 合并提示随行（可参考、不可盲信，PoC 同语义）。
- **整节一次性覆盖语义（D22，与 Rolling Summary 的 append-only 相反）**：每次成功 POST 都对全量逐字稿重新生成，并把整份新纪要**覆盖**落库——topics 从 1 起重新编号、旧纪要不保留历史。理由：纪要是对已结束会话的最终交付物，材料不再增长，重新生成是用户主动要求换一版，历史版本没有回查价值；PoC 亦如此（重跑 global pass 即覆写 `report_<sessionId>`）。
- 201 首次落库；200 覆盖重生成。响应体 `{ digest }`（§7.1 全形态）。
- 该 Session 没有任何已归档逐字稿记录：409 `no_session_transcript_to_summarize`（与 Rolling Summary 同码同文案），不发起 AI 调用。未知或其他账号的 Session 404（D2）。
- 失败反馈形态：AI Provider 调用失败/超时/返回不可解析或零可用内容返回 502 `digest_failed`，**不落脏数据**——已有纪要与用量都不出现本次尝试（D16/D18 同口径）。
- 样例：`api-session-digest-generate`、`api-session-digest-regenerate`、`api-session-digest-read`、`error-digest-unauthorized`、`error-digest-cross-account`、`error-digest-not-finished`、`error-digest-no-transcript`、`error-digest-failed`。

#### GET /v1/sessions/{id}/digest — 读当前纪要

- 返回 `{ digest }`（§7.1 全形态）：幂等读，与最近一次落库的文档一致。任何登录用户可调用（Bearer）。
- 未登录 401；未知或其他账号的 Session 404（D2）；该 Session 从未成功生成过纪要返回 404 `digest_not_generated`（会话存在但纪要未生成，与 D2 的 not_found 是两个码）。
- 样例：`api-session-digest-read`、`error-digest-read-unauthorized`、`error-digest-read-cross-account`、`error-digest-not-generated`。

#### POST /v1/ai/explain — 选中文本解释（无状态）

- 请求体 `{text, context?}`：`text` 必填且为非空字符串；`context` 可选字符串（空串与缺省同为「无上下文」，填 `None` 沿 PoC）。**无状态**：不落任何存储，登录即可（Bearer，不要求 isAdmin），回答即本次调用的全部产物。
- 限长校验（400 `validation_failed`）：`text` 或 `context` 超过 8000 字符（Unicode 码点，D18 计数单位）；`text` 缺失/非字符串/空或纯空白；`context` 非字符串。校验失败不发起 AI 调用、不计数。
- 200 `{ explanation }`：AI 的解释文本。失败反馈形态：AI Provider 调用失败/超时/返回不可用文本返回 502 `explain_failed`，用量不计本次尝试。
- 样例：`api-ai-explain`、`error-explain-unauthorized`、`error-explain-empty-text`、`error-explain-text-too-long`、`error-explain-failed`。

### 7.3 用量口径扩展（D18 同构）

GET /v1/usage 的 Usage 在 contract-r4 §6.3 的六键之上追加四个键（既有键语义零改动，追加键不破坏既有消费者）：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `digestCount` | integer ≥ 0 | 是 | 账号累计成功落库的纪要生成次数（**覆盖重生成同样计数**——每次都是真实 AI 调用；失败尝试不计） |
| `digestInputChars` | integer ≥ 0 | 是 | 账号累计纪要输入字符量：历次落库的 `generation.inputChars` 之和（Unicode 码点数，D18 口径） |
| `explainCount` | integer ≥ 0 | 是 | 账号累计成功应答的选中文本解释次数（失败不计） |
| `explainInputChars` | integer ≥ 0 | 是 | 账号累计解释输入字符量：历次提交的完整 prompt（system + user，Unicode 码点数，D18 口径）之和 |

记录时点同 D18：digest 计数在纪要落库的同一时刻（201 与 200 都计）；explain 计数在 200 应答的同一时刻；失败尝试不产生任何计数。与 Rolling Summary 幂等回放不计数不同——digest 没有「回放」形态，覆盖重生成就是一次新的 AI 调用（D22）。

### 7.4 错误码（面板轮 II 新增）

| HTTP | `error.code` | 语义 | 固定样例 |
| --- | --- | --- | --- |
| 409 | `session_not_finished` | Session 未结束，纪要只能在结束后生成 | `error-digest-not-finished` |
| 409 | `no_session_transcript_to_summarize` | 该 Session 没有任何已归档逐字稿记录（沿用 §6.4 的码与文案） | `error-digest-no-transcript` |
| 502 | `digest_failed` | AI Provider 调用失败/超时/返回不可解析或零可用内容；不落库、不计数，可再次触发 | `error-digest-failed` |
| 404 | `digest_not_generated` | 该 Session 还没有纪要（从未成功生成过） | `error-digest-not-generated` |
| 400 | `validation_failed` | explain 请求体校验失败（text 非对象/缺失/非字符串/空/超 8000 码点、context 非字符串/超 8000 码点） | `error-explain-empty-text`、`error-explain-text-too-long` |
| 502 | `explain_failed` | 解释的 AI Provider 调用失败/超时/返回不可用文本 | `error-explain-failed` |

401 / 404（跨账号，D2）沿用 contract-v1 §4 的封套与语义（样例：`error-digest-unauthorized`、`error-digest-read-unauthorized`、`error-digest-read-cross-account`、`error-digest-cross-account`、`error-explain-unauthorized`）。

## 8. 第七轮追加（删除能力）：DELETE /v1/resources/{id}

第七轮给学习资料补上删除（Ticket 5.5，issue #94；决策 D23）。收藏（contract-v1 §3.1）的对偶操作：删除一条 Resource 即删除它名下的**全部**学习数据，只有用量账目保留。样例：成功样例在 `fixtures/resource-delete-examples.json`（`api-resource-delete`）；**不新增错误样例**——401 与 404 沿用既有封套，三端直接引用 `fixtures/error-examples.json` 的 `error-unauthorized-missing-token`（401）与 `error-cross-account-resource`（404，`资源不存在或无权访问`）。

### 8.1 端点

#### DELETE /v1/resources/{id} — 删除一条学习资料（级联）

- 任何登录用户可调用（Bearer）；请求体为空（无 body）。
- **级联语义（D23）**：删除该 Resource 名下全部数据——
  | 集合 | 键法 | 删除范围 |
  | --- | --- | --- |
  | `resources` | resourceId | 该 Resource 本行 |
  | `sources` | sourceId | 该 Resource 名下全部 Source |
  | `progress` | sourceId | 上述全部 Source 的进度行 |
  | `notes` | resourceId（note.id 为行键） | 该账号在该 Resource 上的全部笔记 |
  | `sessions` | sessionId | 该 Resource 名下全部 Session |
  | `transcripts` | sessionId | 上述全部 Session 的逐字稿文档 |
  | `sessionInsights` | sessionId | 上述全部 Session 的滚动概览 |
  | `sessionDigests` | sessionId | 上述全部 Session 的学习纪要 |
  | `summaries` | resourceId（summary.id 为行键） | 该 Resource 的历次课程总结 |
  | `transcriptionTasks` | taskId | 上述全部 Session 的转写任务行（审查修复补入；任务行的临时音频文件——含 D14 为 failed 保留的——随级联删除，见 decisions D23 追加注记） |
- **usage 不删（D23）**：`GET /v1/usage` 的账目（audioSeconds、summaryCount/summaryInputChars、rollingSummary/digest/explain 各键）原样保留——账目记录的是已经发生且计过的真实消耗，不随资料删除回滚（只记录不计费，D18；无扣减路径）。
- 成功 200 `{"deleted": true}`：响应体只有这一个键，级联清空的集合不逐项回执。删除后：GET /v1/resources 列表不含该项；GET /v1/resources/{id} 详情 404；被删 Session 的 transcript/overview/digest 读端点 404（`学习记录不存在或无权访问`）；被删 Resource 的 summaries 列表 404；`POST /v1/sources/resolve` 对同 URL 返回 `matched: false`；同 URL 重新收藏按新建处理（201，新 Resource + 新 Source，不与已删 id 产生任何关联）。
- **删除即终态（D23，无幂等保留）**：重复 DELETE 是同一个 404——不设墓碑、不区分「刚删过」与「从未存在」（D2 封套 `资源不存在或无权访问`）；客户端的「已被另一端删除」场景按 404 呈现即可。
- 隔离（D2）：未知 id 与其他账号的 id 是同一个 404，不透露存在性；跨账号的 DELETE 删除不了任何数据。
- 未登录 401（与一切受保护端点一致）。
- 持久化原子性：服务端**先收集全部待删键，再一次性删除，最后单次快照落盘**——级联的多集合删除不产生中间态文件（单进程 JSON 存储，一次 store 快照写完成全部删除）。
- 样例：`api-resource-delete`（200）；401 复用 `error-unauthorized-missing-token`；404 复用 `error-cross-account-resource`。

### 8.2 消费端约定

- **Web**：学习列表条目与资源详情页各提供删除入口，均为**两步确认**（首次点击变「确认删除」，超时/失焦恢复，再点才发 DELETE）；详情页确认文案明确「将同时删除该资料的逐字稿、笔记与课程总结」。删除成功后清空该资料的 summaries/详情前端缓存并回学习列表；DELETE 命中 404（已被另一端删除）按「资料已不存在」呈现并从列表移除该项。
- **插件零改动**：对已删除资源的 resolve/开课按既有「无匹配」语义自然工作（`POST /v1/sources/resolve` 返回 `matched: false`，再次收藏即新建）。
