# Learning Digest 第二轮共享契约：Session 与逐字稿归档

状态：第二轮（字幕或 ASR 与归档）三端共享契约。对应 Ticket 2.1（issue #64，spec #49 第二轮节）。术语遵循仓库根 [GLOSSARY.md](../GLOSSARY.md)。通用约定——协议与编码、身份、账号隔离（404）、错误封套、201/200、不透明 ID、ISO 8601 UTC——完全沿用 [contract-v1.md](contract-v1.md) §1/§4，本文只写第二轮新增结构与端点；与第一轮的关系见 §5。

本文是 Web 学习库、浏览器插件、后端 API 与录播转写 Worker 的公共接口定义。**唯一权威样例仍是 `fixtures/` 下的 JSON 文件**，`contract-fixtures.test.js` 与 `contract-r2-fixtures.test.js`（`node --test contracts/` 可跑）保证样例可解析且符合本文定义。三端实现票直接引用同一份样例。

- 第一轮结构与端点：[contract-v1.md](contract-v1.md)
- 第二轮结构与端点：本文
- 契约决策记录（第二轮 D9–D15）：[decisions.md](decisions.md)
- 样例：成功样例在 `fixtures/session-examples.json`（Session 生命周期、字幕归档、逐字稿轮询、资料详情扩展）与 `fixtures/audio-task-examples.json`（音频上传、Worker 领取与回写）；错误样例追加在 `fixtures/error-examples.json` 尾部。

## 1. 通用约定（沿用与差异）

- 沿用 contract-v1 §1 全部约定；新增 ID 前缀 `ses_`（Session）、`tsk_`（Worker 任务）——样例阅读用，实现不必遵循前缀格式。
- **时间轴**：本文所有 `startMs` / `endMs` 都是**来源视频时间轴**上的毫秒位置——与 Source 进度的 `positionMs` 同一参照系（插件的位置流，P10b），不是 Session 内相对时间。PoC 的 Session 相对秒 `{start, duration}`（session-segmenter 的 Segment、utterance 记录）由插件换算成来源时间轴毫秒后提交；Worker 把 Speech Provider 返回的段内相对时间折算到任务段起点，落库时同样是来源时间轴。
- **Worker 身份**：§3.7 的 Worker 端点不接受用户凭据，使用独立签发的 Worker 凭据（`Authorization: Bearer <worker credential>`）。签发与轮换属运维约定，不在三端契约内；凭据缺失或无效返回 401（封套同 §1）。
- **幂等总则**：写操作以自然键首存为准——字幕按 Session 首存为准，音频段按 `(sessionId, segmentIndex)` 首存为准，Worker 回写按 `taskId` 首存为准；重发一律返回 200 与已存数据（与决策 D3 首存优先同构）。finish 例外：它是状态迁移而非创建，对已结束 Session 重复收尾返回 409（§3.2）。

## 2. 数据结构

### 2.1 Session（一次学习）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `id` | string | 服务端生成 | Session 标识 |
| `sourceId` | string | 是 | 本次学习针对的 Source |
| `resourceId` | string | 是 | 所属 Resource（冗余字段，便于 Web 端组装） |
| `status` | enum | 是 | `active` `finished` |
| `startedAt` | string | 服务端生成 | 开始时间，ISO 8601 UTC |
| `finishedAt` | string \| null | 是 | 结束时间；`active` 恒为 `null` |
| `origin` | enum \| null | 是 | 本次学习的逐字稿路径：`captions` / `asr` / `null`。未提交任何字幕或音频时为 `null`；首次归档字幕后锁定 `captions`，首个音频段入库后锁定 `asr`（同区间单一路径，决策 D15） |

多次学习各自 Session（用户故事 20）：同一 Source 上可有多个 Session，历史归档与进行中的并存。服务端不禁止同一 Source 并发 `active`（进度仍按账号 + Source 单条保存，见 D9）；单浏览器内「一次只记录一个选定标签页」由插件保证。

### 2.2 TranscriptRecord（逐字稿记录）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `startMs` | integer ≥ 0 | 是 | 来源视频时间轴起点（毫秒） |
| `endMs` | integer ≥ startMs | 是 | 来源视频时间轴终点（毫秒） |
| `text` | string | 是 | 该段文本，非空 |
| `origin` | enum | 是 | `captions` / `asr`，与所属 Session 锁定的 `origin` 一致 |

### 2.3 Gap（显式缺口）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `startMs` | integer ≥ 0 | 是 | 缺口起点（来源视频时间轴） |
| `endMs` | integer > startMs | 是 | 缺口终点 |
| `reason` | enum | 是 | 第二轮固定 `skipped` |

**语义**：本次学习中被播放器跳过、且至归档时仍未取得文本的范围——显式区分「跳过或未取得文本的范围」与文本记录（#49 第二轮；对齐 PoC #48 的 `[已跳过 m:ss–m:ss]` 标记）。由插件在收尾时一次性上报（§3.2），已回看补录成功的范围不再上报。

**不是 Gap 的两种空缺**：

- 字幕不全——字幕路径按原样归档（D15），缺字幕的区间不产生记录、也不标记 gap；
- 转写失败——显式出现在 `failed[]`，带错误详情（§2.5），不进 `gaps[]`。

### 2.4 AudioSegment（音频段）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `segmentIndex` | integer ≥ 0 | 是 | 段序号，从 0 起；`(sessionId, segmentIndex)` 唯一，是幂等键。乱序上传按序号归位，服务端不要求连续 |
| `startMs` | integer ≥ 0 | 是 | 来源视频时间轴起点 |
| `endMs` | integer > startMs | 是 | 起点 + 时长，服务端由 `startMs + durationMs` 推导 |
| `status` | enum | 是 | `pending` `transcribing` `done` `failed`——任务状态机（§3.7）在段上的投影 |
| `audioMimeType` | string | 是 | 采集容器的真实 MIME（如 `audio/webm;codecs=opus`），Worker 据此选择 Speech Provider 的输入格式 |

时长目标约 30 秒：`durationMs` 接受 5000–60000ms（与 PoC segmenter 的 [5, 60] 秒边界一致），尾段不足 5000ms 由插件丢弃不提交。越界返回 400 `validation_failed`。

### 2.5 TranscriptView（逐字稿统一形态）

轮询（§3.5）、字幕归档响应（§3.3）与 Web 回查共用的唯一形态：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `sessionId` / `sourceId` / `resourceId` | string | 是 | 归属标识 |
| `sessionStatus` | enum | 是 | `active` / `finished`，随 Session |
| `origin` | enum \| null | 是 | 随 Session（§2.1） |
| `records` | TranscriptRecord[] | 是 | 已取得的文本，按 `startMs` 升序 |
| `gaps` | Gap[] | 是 | 显式跳过范围 |
| `pending` | 段状态[] | 是 | 转写中：`{ segmentIndex, startMs, endMs, status: "pending" \| "transcribing" }` |
| `failed` | 段状态[] | 是 | 转写失败：`{ segmentIndex, startMs, endMs, error: { code, message } }`，第二轮 `error.code` 固定 `transcription_failed` |

四个数组恒在场（可为空），客户端统一遍历。**状态单调**：`done` / `failed` 为终态不回退；`finished` 后 `pending` 随尾段 drain 渐进清空（插件 `endActiveSession` 先 finish 后 drain，预算 15 拍），视图按 `sessionStatus` 把滞留段标注为排队而非终态——worker 停机且无租约时 `pending` 可滞留，不视作归档损坏。captions 路径的 Session `pending` / `failed` 恒为空。

## 3. 端点

### 3.1 POST /v1/sources/{id}/sessions — 开始学习

- 开始学习时创建 Session；请求体为空对象 `{}`（账号来自凭据，Source 来自路径）。
- 201：返回 `{ session }`（`origin` 为 `null`）。未登录 401；未知或其他账号的 Source 404（D2）。
- 第一轮进度端点签名不变：进度仍 `PUT /v1/sources/{id}/progress`，按账号 + Source 单条保存（D1 → D9 演进说明）。
- 样例：`api-session-create-bilibili`、`error-session-create-unauthorized`、`error-session-create-cross-account-source`。

### 3.2 POST /v1/sessions/{id}/finish — 结束学习

- 请求体：`{ "gaps": [{ "startMs", "endMs" }] }`——可选，缺省为无缺口。`gaps` 是本次学习结束时仍未取得文本且非转写失败的显式跳过范围（§2.3）；每项 `endMs > startMs`，越界或倒置 400 `validation_failed`。
- 200：Session 置 `finished`，`finishedAt` 由服务端生成，返回 `{ session }`。
- 409 `session_already_finished`：重复收尾。未知或其他账号的 Session 404。
- 样例：`api-session-finish-with-gaps`、`error-session-finish-already-finished`。

### 3.3 POST /v1/sessions/{id}/captions — 字幕直归档

- 请求体：`{ "segments": [{ "startMs", "endMs", "text" }] }`——插件读取到的字幕段，来源时间轴毫秒，`text` 非空。**按原样归档**：字幕不全服务端不补全、不推断缺口（D15）。
- 201：首次归档，Session `origin` 锁定 `captions`，返回 `{ transcript: TranscriptView }`。
- 200：重发（断网重试）返回已归档内容，首存为准，不覆盖、不追加。
- 409 `transcript_origin_conflict`：该 Session 已按 `asr` 路径归档（同区间单一路径，D15）；409 `session_already_finished`：已结束不再接收。
- 样例：`api-session-captions-archive`、`api-session-captions-resend-idempotent`、`error-transcript-origin-conflict`。

### 3.4 POST /v1/sessions/{id}/audio-segments — 音频分段上传

- 请求体（JSON，音频以 base64 传输，D11）：

```json
{
  "segmentIndex": 1,
  "startMs": 30000,
  "durationMs": 30000,
  "audioMimeType": "audio/webm;codecs=opus",
  "audioBase64": "<该段音频的 base64>"
}
```

  - **传输编码**：音频以 base64 字段放进 JSON 体。理由：沿用 contract-v1 §1「全部端点 HTTPS + JSON」；vanilla Node 服务端零新增解析器；插件端复用 PoC 的 base64 编码路径（speech-transcription.js）；约 30s opus 段常规体积为数十 KB，与腾讯云（≤3MB base64）、Qwen（≤10MB）等 Speech Provider 的既有 base64 形态同构。**不采用 multipart**（服务端需引入 multipart 解析器）、**不采用二进制 body**（破坏全 JSON 约定，且元数据要与音频原子提交、重试要字节级重放）。`audioBase64` 编码后上限 10MB，超限 400 `validation_failed`。
  - 校验：`segmentIndex` ≥ 0 整数、`startMs` ≥ 0、`durationMs` ∈ [5000, 60000]、`audioMimeType` 以 `audio/` 开头；越界 400 `validation_failed`（样例 `error-audio-segment-invalid-index`、`error-audio-segment-too-large`）。
- 201：先落库再入队 Worker 任务，返回 `{ segment }`（`status: "pending"`）。重复/重试：同 `(sessionId, segmentIndex)` 重放返回 200 与已存段，首存为准，不覆盖、不重复入队。乱序上传接受，按 `segmentIndex` 归位。
- **重试协议**：插件对网络失败的段做字节级重放（同一请求体原样重发）；收到 409 `session_already_finished`（`error-audio-segment-after-finish`）说明 Session 已收尾，停止上传。服务端不比较音频内容，首存为准。
- 样例：`api-audio-segment-upload`、`api-audio-segment-duplicate-idempotent`、`api-audio-segment-out-of-order`、`api-audio-segment-upload-second`。

### 3.5 GET /v1/sessions/{id}/transcript — 逐字稿轮询

- 返回裸 TranscriptView（§2.5）。未登录 401；未知或其他账号的 Session 404。
- **未结束/已结束语义**：`active` 时 `pending` / `failed` 可非空（「转写中」与失败反馈的展示依据）；`finished` 后 `pending` 随尾段 drain 渐进清空（插件 `endActiveSession` 先 finish 后 drain，预算 15 拍），视图即最终归档形态（可回查）——worker 停机且无租约时 `pending` 可滞留，视图把滞留段标注为排队而非终态。轮询频率与退避由插件实现票决定（D12）；服务端保证幂等读与状态单调。
- 样例：`api-session-transcript-asr-active`（转写中 + 失败段）、`api-session-transcript-asr-finished`（gap + 失败段终态）、`api-session-transcript-captions-finished`（字幕路径全文）、`error-cross-account-session-transcript`。

### 3.6 GET /v1/resources/{id} — 资料详情（第二轮扩展）

- 在第一轮 `{ resource, sources, notes }` 之上增加 `sessions[]`：该资料名下历次学习（含进行中的），按 `startedAt` 倒序。每项 = Session（§2.1）+ 逐字稿摘要 `{ recordCount, gapCount, failedCount }`（TranscriptView 的计数投影；逐字稿全文按 Session 经 §3.5 取得）。
- 第一轮三键形态不变，第一轮样例零改动；扩展形态单列样例。
- 样例：`api-resource-detail-with-sessions`。

### 3.7 Worker 任务契约 — POST /v1/worker/tasks/claim、POST /v1/worker/tasks/{id}/result

- **Pull 模型（D13）**：Worker 主动领取，API 不推送、不维护 Worker 心跳。
- `POST /v1/worker/tasks/claim`：请求 `{ "limit": 3 }`（正整数，缺省 1，服务端上限 10）。领取至多 limit 个 `pending` 任务并原子置 `transcribing`，返回 `{ tasks: [Task] }`，按 `segmentIndex` 升序。Task = `{ taskId, sessionId, sourceId, segmentIndex, startMs, endMs, audioMimeType, audioBase64 }`——音频 base64 内联（≤10MB 编码），一次交接完成，无需第二个取流端点。
- `POST /v1/worker/tasks/{id}/result`：请求体二选一，返回 200 `{ taskId, status }`：
  - `{ "status": "done", "records": [{ "startMs", "endMs", "text" }] }`——records 时间戳已是来源时间轴毫秒（Worker 负责折算）；静音段回写 `records: []`，同样 `done`。API 落库逐字稿（`origin: "asr"`）并**立即删除该段音频**（D14）。
  - `{ "status": "failed", "error": { "code": "transcription_failed", "message" } }`——第二轮唯一任务失败码，`message` 带可排查的 Provider 详情。API 保留音频至 Session 结束 + 宽限期（D14），轮询的 `failed[]` 显式反馈。
  - 回写幂等：同 `taskId` 重发返回 200 与已存结果（首存为准）。未知任务 404。
- **任务状态机**：`pending → transcribing → done | failed`；`done` / `failed` 终态不回退。Worker 领取后崩溃的恢复（租约过期重排）属 API 内部机制——被重排的任务可再次出现在 claim 结果中——不影响本契约的请求/响应形态。
- 样例：`worker-task-claim`、`worker-task-result-done`、`worker-task-result-failed`、`error-worker-claim-unauthorized`、`error-worker-result-unknown-task`。

## 4. 错误码（第二轮新增）

| HTTP | `error.code` | 语义 | 固定样例 |
| --- | --- | --- | --- |
| 409 | `session_already_finished` | 对已结束 Session 的写操作（重复收尾、字幕、音频） | `error-session-finish-already-finished`、`error-audio-segment-after-finish` |
| 409 | `transcript_origin_conflict` | 同一 Session 内字幕与音频混用（同区间单一路径，D15） | `error-transcript-origin-conflict` |

400 / 401 / 404 沿用 contract-v1 §4：`validation_failed` 覆盖段元数据越界、音频超限与 gap 倒置；401（含 Worker 凭据缺失或无效）与 404（跨账号隔离，D2）语义不变。

## 5. 与第一轮的关系

- 第一轮端点签名、语义与样例零改动；Session 不改变进度模型（D9）。
- 资料详情只增 `sessions[]` 键（§3.6）。
- 本契约与 contract-v1.md 同属 `/v1` 接口代际，fixtures 共用 `learning-digest-contracts/v1` 标记；版本发布单元不受本契约影响（planning-only，不 bump）。
