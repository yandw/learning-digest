# Learning Digest 第一轮共享契约 v1

状态：第一轮（收藏与续学）三端共享契约。对应 Ticket P1（issue #50），上游规格为 #49 的「跨端共享的数据」表与 `/v1` 接口草案。术语遵循仓库根 [GLOSSARY.md](../GLOSSARY.md)；计划背景见 [docs/productization-four-part-plan-v0.1.md](../docs/productization-four-part-plan-v0.1.md)。

本契约是 Web 学习库、浏览器插件、后端 API 三端的公共接口定义。**唯一权威样例是本目录 `fixtures/` 下的 JSON 文件**，`contract-fixtures.test.js`（`node --test contracts/` 可跑）保证样例可解析且符合本文定义。三端实现票直接引用同一份样例，不各自另写期望值。

- 数据结构：`contract-v1.md`（本文）
- 来源识别与 Platform Video ID 提取规则：[platform-video-id-rules.md](platform-video-id-rules.md)
- 契约决策记录（含 Session 缓到第二轮）：[decisions.md](decisions.md)

## 1. 通用约定

- **协议与编码**：全部端点为 HTTPS + JSON（`Content-Type: application/json`）；路径前缀 `/v1` 表示对外接口代际，独立于 API 构建版本（见决策 2，#49）。
- **身份**：除特别说明外全部端点要求有效凭据，请求头 `Authorization: Bearer <token>`。凭据由 Web 登录与插件关联流程签发；签发、刷新与联动撤销的细节属账号契约，不在本文范围。凭据缺失、过期或被联动撤销时返回 401（见错误码表）。
- **账号归属**：API 从有效凭据解析账号。资料、来源、进度、笔记全部按账号隔离；跨账号访问一律 404，不区分「不存在」与「不属于你」（见决策 D2）。
- **错误封套**：非 2xx 响应统一为 `{ "error": { "code": "<错误码>", "message": "<中文说明>" } }`；进度冲突额外携带 `current`。样例见 `fixtures/error-examples.json`。
- **成功状态码**：创建新数据返回 201；请求命中账号内已有数据（重复收藏、笔记重发）返回 200，响应体与创建时同构。
- **ID**：服务端生成的 ID 为不透明字符串。样例中使用 `res_` / `src_` / `note_` 前缀便于阅读，实现不必遵循前缀格式。
- **时间戳**：`createdAt` 等时间字段为 ISO 8601 UTC 字符串（如 `2026-11-10T08:00:00Z`）。
- **幂等**：笔记用客户端生成的 `clientRequestId` 支持断网重发；进度用 `expectedRevision` 乐观并发（见下文）。

## 2. 数据结构

### 2.1 Resource（学习资料）

账号收藏的一条资料，可代表一个独立网页或课节。

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `id` | string | 服务端生成 | 资料标识，账号内唯一 |
| `title` | string | 是 | 展示标题。收藏时可缺省（客户端可先存链接后补标题），服务端可用地址兜底 |
| `kind` | enum | 是 | `webpage`（普通网页、小红书图文等）`video` `audio` `live` |
| `createdAt` | string | 服务端生成 | 首次收藏时间，ISO 8601 UTC |

标题只用于展示、搜索和人工判断，**不参与匹配**：同名不同视频分别收藏（样例 `match-same-title-video-a/b`）。

### 2.2 Source（来源）

资料的某个具体网页或可播放版本。第一轮中一次收藏产生一个 Resource + 一个 Source；同一资料多版本（直播/回放）与专题归组延后（决策 D5）。

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `id` | string | 服务端生成 | 来源标识，账号内唯一 |
| `resourceId` | string | 是 | 所属 Resource 的 `id` |
| `kind` | enum | 是 | `webpage` `video` `audio` `live` `replay` |
| `url` | string | 是 | **原始网页地址**：保留首次收藏时的完整地址，供用户重新打开原平台；后续等价地址收藏不覆盖它 |
| `platformId` | string \| null | 是 | 识别出的 Source Platform：`xiaoe-tech` / `bilibili` / `youtube` / `xiaohongshu`，未识别为 `null` |
| `platformVideoId` | string \| null | 是 | 平台视频标识，提取规则见 [platform-video-id-rules.md](platform-video-id-rules.md)；未识别为 `null` |
| `episodeId` | string \| null | 是 | 分集标识（如 B 站 `p` 值）；无分集概念的平台为 `null` |
| `platformScopeId` | string \| null | 是 | 平台内作用域（仅小鹅通使用：商店子域）；其他平台为 `null` |
| `progress` | Progress \| null | 否 | 当前账号在该来源的进度；随 Source 一起返回，无进度时为 `null` |

`platformId` 与 `platformVideoId` 要么同时为 `null` 要么同时有值。`timestampKind`（媒体时间轴 vs 墙钟）由 `kind` 推导（`live` → 墙钟，其余 → 媒体位置），随第二轮逐字稿契约显式化。

### 2.3 Progress（续播进度）

进度按**账号 + Source** 保存（第一轮无服务端 Session，见决策 D1）。

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `positionMs` | integer ≥ 0 | 是 | 最后实际播放位置（毫秒）。记录期间允许拖拽，保存的是最后播放位置，跳过区间不计作已看 |
| `revision` | integer ≥ 1 | 是 | 乐观并发版本，每次成功写入 +1。尚无进度时视为 revision 0 |

写入语义见 3.5；`live`（墙钟时间轴）来源的 `positionMs` 表示本次记录的已进行时长，第一轮续播验收只覆盖可定位视频。

### 2.4 Note（笔记）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `id` | string | 服务端生成 | 笔记标识 |
| `resourceId` | string | 是 | 所属 Resource 的 `id` |
| `sourceId` | string \| null | 是 | 时间戳笔记关联的实际来源；普通网页笔记为 `null` |
| `positionMs` | integer ≥ 0 \| null | 是 | 关联来源上的位置；与 `sourceId` 必须同时出现或同时为 `null` |
| `text` | string | 是 | 笔记正文，非空 |
| `clientRequestId` | string | 是 | 客户端生成的请求标识，重发去重的依据 |
| `createdAt` | string | 服务端生成 | 创建时间 |

### 2.5 identity（收藏/解析请求中的身份声明）

`POST /v1/resources` 与 `POST /v1/sources/resolve` 请求体中的可选对象，由客户端（插件或 Web）按 [platform-video-id-rules.md](platform-video-id-rules.md) 从地址中提取：

```json
{
  "platformId": "bilibili",
  "platformVideoId": "BV1ab411L78c",
  "episodeId": "2",
  "platformScopeId": null
}
```

- 字段语义与 Source 的同名一致；`platformScopeId` 仅小鹅通需要。
- 无法识别平台身份时省略整个对象（或不传 `identity`），服务端回退按归一化地址匹配。
- `title` 为可选展示标题；服务端不访问第三方网页，不抓取标题。

## 3. `/v1` 端点

六组核心端点（§3.1–§3.6），全部已登录；§3.7 为第一轮补充端点（P5）。成功样例在 `fixtures/api-examples.json`，错误样例在 `fixtures/error-examples.json`；下表「样例」列引用其 `id`。

### 3.1 POST /v1/resources — 收藏网页

提交地址与可选标题/身份，服务端校验 URL 类型、按决策 1 匹配，返回（或命中）Resource + Source。

- 请求体：`url`（必填，http(s)）、`title`（可选）、`identity`（可选，见 2.5）。
- 201：账号内无匹配来源，新建 Resource + Source。
- 200：命中账号内已有来源，返回同一条 Resource + Source（重复收藏返回同一条资料，决策 D3）；`url` 保留首次收藏的原始地址。
- 匹配顺序：identity 命中（platform + platformVideoId + episodeId [+ platformScopeId]）优先；否则按归一化地址。
- 样例：`api-resources-create-bilibili-p2`、`api-resources-duplicate-bilibili-p2`（分享短链重复收藏）、`api-resources-create-generic-webpage`、`error-invalid-url`、`error-validation-failed-missing-url`。

### 3.2 GET /v1/resources — 资料列表

返回账号内全部资料（第一轮不分页），按 `createdAt` 倒序。每项 `{ resource, sources: [Source…] }`，Source 含最新 `progress`，供学习列表直接展示「打开原地址 + 续播位置」。

- 样例：`api-resources-list`、`error-unauthorized-missing-token`。

### 3.3 GET /v1/resources/{id} — 资料详情

返回 `{ resource, sources, notes }`：可打开的原地址、各来源进度与全部笔记。访问其他账号的 `id` 返回 404（决策 D2）。

- 样例：`api-resources-detail-with-notes`、`error-cross-account-resource`。

### 3.4 POST /v1/sources/resolve — 解析来源（不创建）

插件开始学习前提交当前网页地址与已识别身份，查询当前账号下的匹配来源。**只读不写**：无匹配返回 `{ "matched": false }`，不创建任何数据；命中返回 `{ "matched": true, resource, source }`（Source 含最新进度，供「继续学习 / 从头开始」选择）。

- 请求体与 3.1 相同（`url`、`title` 可选、`identity` 可选）。
- 样例：`api-resolve-matched-episode2`、`api-resolve-unmatched-generic`、`error-unauthorized-resolve`。

### 3.5 PUT /v1/sources/{id}/progress — 保存进度

按乐观并发写入该来源的续播位置。

- 请求体：`positionMs`（integer ≥ 0）、`expectedRevision`（integer ≥ 0；尚无进度时为 0）。
- 200：写入成功，返回 `{ positionMs, revision }`，`revision` 自增。
- 409：`expectedRevision` 过期（其他端已写入），返回 `error.code = "progress_revision_conflict"` 与 `current: { positionMs, revision }`；客户端以 `current` 决定覆盖或提示，重写时带新 revision。样例覆盖同一来源首写、更新与冲突的完整链条：`api-progress-first-write`（→ rev 1）、`api-progress-update`（→ rev 2）、`error-progress-conflict`（409 + current = rev 2）。
- 对其他账号的来源写入返回 404：`error-cross-account-progress`。

### 3.6 POST /v1/resources/{id}/notes — 新增笔记

- 请求体：`clientRequestId`（必填）、`text`（必填非空）、`sourceId` + `positionMs`（可选，成对出现；时间戳笔记必须指向该 Resource 名下的实际来源）。
- 201：新建笔记。200：`clientRequestId` 已存在，返回原笔记（重发幂等）。样例：`api-note-create-timestamped`、`api-note-resend-idempotent`、`api-note-create-webpage`、`error-validation-failed-empty-note-text`。
- 对其他账号的 Resource 写笔记返回 404（与 3.3 同语义）：`error-cross-account-note-create`。

### 3.7 PATCH /v1/resources/{id} — 手动补标题（第一轮补充）

Web 端「先存链接、后补标题」流程的改标题端点，属**第一轮的契约补充**（Ticket P5，#55），不在首轮六组端点之列。只修改展示标题；标题从不参与匹配（见 2.1），改标题不影响后续重复收藏的命中。

- 请求体：仅接受 `{ "title": "<非空字符串>" }`。缺 `title`、`title` 非字符串、纯空白，或请求体携带其他字段，均为 400 `validation_failed`（错误封套见 §1，形态与 `error-validation-failed-missing-url` 一致）。
- 200：返回 `{ resource }`，即更新后的 Resource（2.1 形态，`title` 为新值，其余字段不变）。
- 对其他账号的 Resource 或未知 `id` 返回 404（与 3.3 同语义，决策 D2）。
- 样例：`api-resource-retitle`（200，标题更新；错误形态复用既有 400/404 封套样例，不另设固定样例）。

## 4. 错误码

| HTTP | `error.code` | 语义 | 固定样例 |
| --- | --- | --- | --- |
| 400 | `invalid_url` | 地址缺失、非法或非 http(s) | `error-invalid-url` |
| 400 | `validation_failed` | 其他字段校验失败（缺 `url`、`text` 为空等） | `error-validation-failed-missing-url` |
| 401 | `unauthorized` | 未携带凭据、凭据过期或被联动撤销 | `error-unauthorized-missing-token`、`error-unauthorized-expired-token` |
| 404 | `not_found` | 资源不存在或属于其他账号（隔离语义，见决策 D2） | `error-cross-account-resource`、`error-cross-account-progress` |
| 409 | `progress_revision_conflict` | 过期进度写入，附 `current` | `error-progress-conflict` |

未知路径、未知方法等通用 HTTP 错误不在本契约样例范围。
