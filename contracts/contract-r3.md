# Learning Digest 第三轮共享契约：课程总结与用量

状态：第三轮（按需生成课程总结）三端共享契约。对应 Ticket 3.1（issue #73，spec #49 第三轮节）。术语遵循仓库根 [GLOSSARY.md](../GLOSSARY.md)。通用约定——协议与编码、身份、账号隔离（404）、错误封套、201/200、不透明 ID、ISO 8601 UTC——完全沿用 [contract-v1.md](contract-v1.md) §1/§4；Session 与逐字稿结构沿用 [contract-r2.md](contract-r2.md)，本文只写第三轮新增结构与端点；与第一、二轮的关系见 §5。

本文是 Web 学习库、浏览器插件与后端 API 的公共接口定义。**唯一权威样例仍是 `fixtures/` 下的 JSON 文件**，`contract-fixtures.test.js`、`contract-r2-fixtures.test.js` 与 `contract-r3-fixtures.test.js`（`node --test contracts/` 可跑）保证样例可解析且符合本文定义。三端实现票直接引用同一份样例，不各自另写期望值。

- 第一轮结构与端点：[contract-v1.md](contract-v1.md)
- 第二轮结构与端点：[contract-r2.md](contract-r2.md)
- 第三轮结构与端点：本文
- 契约决策记录（第三轮 D16–D18）：[decisions.md](decisions.md)
- 总结生成 prompt（外移模板，D17）：[../prompts/course-summary.md](../prompts/course-summary.md)
- 样例：成功样例在 `fixtures/summary-examples.json`（含补学 Session 的逐字稿视图锚样例）；错误样例追加在 `fixtures/error-examples.json` 尾部。

## 1. 通用约定（沿用与差异）

- 沿用 contract-v1 §1 与 contract-r2 §1 的全部约定；新增 ID 前缀 `sum_`（Course Summary）——样例阅读用，实现不必遵循前缀格式。
- **幂等总则的例外**：`POST /v1/resources/{id}/summaries` 不适用「首存为准」——每次被接受的生成请求都创建一条新 Summary（201，见 §3.1）。课程总结的语义是「用户主动发起的一次生成」（用户故事 28/29）：服务端无法判断材料是否值得重新归纳，是否再生成由用户决定；历次生成全部保留可回查。重复点击的防抖由 Web 实现票处理，不进契约。
- **同步生成**：生成在 POST 请求内完成（组装 → AI Provider → 落库 → 201）。课程总结没有渐进产出——一次调用一份产物，不设轮询面，与逐字稿的 D12 轮询不同构；异步化（任务下发 Worker）是 D16 预留的演进路径，不改变端点形态。
- **ADR 0002 边界**：课程总结是 Resource 级的独立触发，跨 Session 聚合，由服务端生成。插件侧的 Session Digest（单次学习结束的全局 pass）与 Rolling Summary（课中追加的 Topic 时间轴）按 ADR 0002 照旧——三者作用域不同、产物独立，互不替代。

## 2. 数据结构

### 2.1 Course Summary（课程总结）

用户主动发起生成的一份资料级总结，聚合该 Resource 当前全部已归档材料（多次 Session 的逐字稿 + 笔记）。

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `id` | string | 服务端生成 | 总结标识 |
| `resourceId` | string | 是 | 所属 Resource |
| `content` | string | 是 | 总结正文，Markdown |
| `citations` | Citation[] | 是 | 原文引用，按来源时间轴 `startMs` 升序（可为空数组） |
| `generation` | object | 是 | 生成元数据（§2.3） |
| `generatedAt` | string | 服务端生成 | 生成完成时间，ISO 8601 UTC |

只存在成功落库的 Summary：生成失败不产生记录（§3.1），因此没有 `status` 字段——存在的每一条都可回查。

### 2.2 Citation（原文引用）

正文论点的回查锚点：原文摘句 + 指向已归档逐字稿的段引用（spec #49「通过原文和时间戳回查实际来源」）。

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `quote` | string | 是 | 引用的原文摘句（摘自所指记录的文本，逐字不改写） |
| `segmentRef.sessionId` | string | 是 | 来源 Session（该 Resource 名下的某次学习） |
| `segmentRef.startMs` | integer ≥ 0 | 是 | 所指记录的来源时间轴起点（毫秒） |
| `segmentRef.endMs` | integer > startMs | 是 | 所指记录的终点（毫秒） |

服务端只落库能对上真实归档记录的引用：`segmentRef` 必须命中该 Resource 某 Session 的已归档 TranscriptRecord（contract-r2 §2.2）——sessionId 归属该 Resource，区间对上该记录，quote 是该记录文本的逐字摘句。对不上的引用在落库前丢弃，宁可少引用不落死链。Web 据此可从引用跳回原平台对应时间点（Session 的 Source + `startMs`）。

### 2.3 生成元数据（generation）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `provider` | string | 是 | AI Provider 标识，不透明字符串（默认部署为 `qwen`；测试注入 stub，D16），不是三端约定的枚举 |
| `model` | string | 是 | Provider 侧模型标识，不透明字符串 |
| `inputChars` | integer ≥ 0 | 是 | 提交给 AI Provider 的完整输入字符数（组装后的 prompt 全文，含模板与时间戳标记）——用量 `summaryInputChars` 的同源口径（D18） |

凭据与端点不出现在任何契约字段里（D16）。

### 2.4 Usage（账号用量汇总）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `audioSeconds` | integer ≥ 0 | 是 | 账号累计转写时长（秒）：已 done 音频段时长毫秒总和 ÷ 1000 向下取整（记录时点见 D18） |
| `summaryCount` | integer ≥ 0 | 是 | 账号累计成功生成的总结次数 |
| `summaryInputChars` | integer ≥ 0 | 是 | 账号累计总结输入字符量：历次 `generation.inputChars` 之和 |
| `updatedAt` | string | 服务端生成 | 最后一次计数写入时间，ISO 8601 UTC |

只记录不计费：无价格、账单、付款与配额执行（#49 Out of Scope；D18）。账号级累计，无时间窗与资源维度参数；后续计费口径若需要维度扩展，加端点或参数，不改本形态。

## 3. 端点

### 3.1 POST /v1/resources/{id}/summaries — 生成课程总结（用户主动发起）

- 请求体为空对象 `{}`：Resource 来自路径，账号来自凭据，生成范围固定为该 Resource 当前全部已归档材料（D17），不接受客户端裁剪输入。
- 服务端聚合该 Resource 全部 Sessions（`active` 与 `finished` 均计入——未学完可生成，用户故事 28）的 transcripts（records 全文 + gaps 显式跳过标记）与 notes，按外移 prompt（[prompts/course-summary.md](../prompts/course-summary.md)）组装后调用 AI Provider（D16/D17）。
- 201：生成成功，返回 `{ summary }`（§2.1 全形态）。**每次被接受的请求创建一条新记录**：补学后再点击生成新的总结（用户故事 29），历次全部保留（§1 幂等例外）。
- 失败反馈形态（D16）：AI Provider 调用失败、超时或返回不可解析时返回 502 `summary_generation_failed`，**不落脏数据**——不产生 Summary 记录，列表与用量都不出现本次尝试（D18）；重试即用户再次发起。对比逐字稿的 `failed[]`：那是段级进行时状态（音频已入库、失败可排查），总结是原子产物——要么完整存在，要么不存在；失败条目没有可回查的内容，只会污染回查列表。
- 401 未登录；未知或其他账号的 Resource 404（D2）；该 Resource 名下没有任何已归档逐字稿记录（只有 gaps / failed / 静音段同样算无文本）返回 409 `no_transcript_to_summarize`，不发起 AI 调用。
- 样例：`api-summary-generate-bilibili`（未学完时首次生成）、`api-summary-generate-after-catch-up`（补学后再生成）、`error-summary-generate-unauthorized`、`error-summary-generate-cross-account`、`error-summary-generate-no-transcript`、`error-summary-generate-failed`。

### 3.2 GET /v1/resources/{id}/summaries — 历次总结列表

- 返回 `{ summaries }`：该 Resource 的历次生成，按 `generatedAt` 倒序（历史保留可回查）。每项为列表投影 `{ id, resourceId, generatedAt, generation, citationCount }`；正文与引用按 id 经 §3.3 取得。
- 从未生成过返回 `{ "summaries": [] }`（200）。
- 样例：`api-summaries-list`、`api-summaries-list-empty`（另一门资料独立计数，普通网页无逐字稿从未生成）、`error-summaries-list-cross-account`。

### 3.3 GET /v1/summaries/{id} — 单次总结详情

- 返回裸 Summary（§2.1 全形态）。未登录 401；未知或其他账号的 Summary 404（D2）。
- 样例：`api-summary-detail`、`error-cross-account-summary`。

### 3.4 GET /v1/usage — 账号用量汇总

- 返回裸 Usage（§2.4）：账号级累计，Web 查询入口的数据源。要求有效凭据。
- 样例：`api-usage`、`error-usage-unauthorized`。

## 4. 错误码（第三轮新增）

| HTTP | `error.code` | 语义 | 固定样例 |
| --- | --- | --- | --- |
| 409 | `no_transcript_to_summarize` | 该 Resource 没有任何已归档逐字稿文本，生成无法进行 | `error-summary-generate-no-transcript` |
| 502 | `summary_generation_failed` | AI Provider 调用失败/超时/返回不可解析；不落库、不计数，可再次发起 | `error-summary-generate-failed` |

400 / 401 / 404 沿用 contract-v1 §4：401 与 404（跨账号隔离，D2）语义不变；本轮无新增 400 形态（生成请求体为空对象，无字段校验面）。

## 5. 与第一、二轮的关系

- 前两轮端点签名、语义与样例零改动；资料详情**不新增键**——总结走独立列表端点（§3.2），不动 contract-r2 §3.6 的形态。
- 课程总结消费第二轮的归档产物（TranscriptView 的 records / gaps、notes），**只读**——生成不改变 Session、逐字稿与笔记的任何状态。
- 与 ADR 0002 的分工见 §1；与 Worker 的关系见 D16（AI Provider seam 在 API，与 worker 的 Speech Provider seam 并列独立；D13 预留的 claim/result 复用是异步化演进路径）。
- 本契约与前两轮同属 `/v1` 接口代际，fixtures 共用 `learning-digest-contracts/v1` 标记；版本发布单元不受本契约影响（planning-only，不 bump）。
