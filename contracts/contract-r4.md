# Learning Digest 第四轮共享契约：站点能力注册表与管理员标记

状态：第四轮（站点能力工程化）三端共享契约。对应 Ticket 6.1（issue #86，spec #49 第四轮节）。术语遵循仓库根 [GLOSSARY.md](../GLOSSARY.md)。通用约定——协议与编码、身份、账号隔离（404）、错误封套、201/200、不透明 ID、ISO 8601 UTC——完全沿用 [contract-v1.md](contract-v1.md) §1/§4；本文只写第四轮新增结构与端点。

本文是 Web 学习库、浏览器插件与后端 API 的公共接口定义。**唯一权威样例仍是 `fixtures/` 下的 JSON 文件**：第四轮成功样例在 `fixtures/site-capability-examples.json`，错误样例追加在 `fixtures/error-examples.json` 尾部；`contract-fixtures.test.js`、`contract-r2-fixtures.test.js`、`contract-r3-fixtures.test.js` 与新增 `contract-r4-fixtures.test.js`（`node --test contracts/` 可跑）保证样例可解析且符合本文定义。三端实现票直接引用同一份样例，不各自另写期望值。

- 第一轮结构与端点：[contract-v1.md](contract-v1.md)
- 第二轮结构与端点：[contract-r2.md](contract-r2.md)
- 第三轮结构与端点：[contract-r3.md](contract-r3.md)
- 第四轮结构与端点：本文
- 第六轮追加（面板 AI 服务端化 I，§6）：滚动摘要与概览；样例在 `fixtures/session-overview-examples.json`，tick prompt 外移 [../prompts/topic-tick.md](../prompts/topic-tick.md)
- 契约决策记录（第四轮 D19–D20、面板轮 D21）：[decisions.md](decisions.md)
- 样例：成功样例在 `fixtures/site-capability-examples.json`；错误样例追加在 `fixtures/error-examples.json` 尾部。

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
| `platformId` | string | 是 | 平台标识（bilibili / youtube / xiaoe / xiaohongshu 等，非枚举约束的不透明字符串） |
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
