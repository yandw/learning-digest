# 契约决策记录（第一轮、第二轮）

状态：契约的一部分。记录三端实现必须遵守、且在实现前需要说清理由的契约级裁量。上游决策 1/2/3/4（#49 已确认）不在此重复，只记录其契约化落点。D1–D8 属第一轮（[contract-v1.md](contract-v1.md)），D9–D15 属第二轮（[contract-r2.md](contract-r2.md)），D16–D18 属第三轮（[contract-r3.md](contract-r3.md)）。

## D1 · 第一轮契约不含服务端 Session —— 进度按账号 + Source 保存

**决策**：`/v1` 第一轮端点集中不存在 Session 资源或字段。播放进度按（账号， Source）保存为单条 `{ positionMs, revision }`；「开始学习」在插件侧本地成立（决策 4 的开场、暂停、收尾行为都在插件内），收尾时通过 `PUT /v1/sources/{id}/progress` 落一条最终位置。

**理由**：

- 第一轮的用户验收是收藏、续播和手写笔记。进度查询只问「这条分集上次学到哪里」，一个账号在一个 Source 上只有一个续播位置，Session 维度在第一轮没有查询方。
- Session 的真正价值是第二轮逐字稿的归属边界（字幕/音频按 Session 与来源归档，见 #49 第二轮）。提前落 Session 会让第一轮出现没有消费者的表和端点，且「一次学习记录」的时长、区间、文本归属等字段都要等第二轮设计才能定型。
- 决策 4 的验收样例（A/B 标签页切换、多次学习、暂停恢复）全部只依赖插件本地 Session 状态加服务端最终位置写入，契约上等价于一次 `PUT progress`。
- 契约已为此预留演进路径：`POST /v1/sources/resolve` 返回不绑 Session；第二轮引入 Session 时，现有端点签名与样例无需破坏性变更（进度写入仍是 `PUT progress`，只是附带 Session 语境）。

**影响**：同一分集分多次学习时，服务端只保留最后写入的位置与版本；多次学习的历史归档由第二轮 Session/Transcript 契约承载。

## D2 · 跨账号隔离统一返回 404

**决策**：访问不属于当前账号的 Resource/Source（读、写进度、写笔记）一律返回 `404 not_found`，不使用 403。

**理由**：隔离语义要求不向调用方透露资源存在与否；403 会确认「资源存在但你无权访问」。404 让越权枚举与不存在不可区分，实现也更简单（查询条件直接带 accountId）。

**影响**：客户端不能凭 404 区分「被删了」与「不是你的」，第一轮无此需求。

## D3 · 重复收藏返回同一条资料：201/200 区分，响应体同构

**决策**：`POST /v1/resources` 首次创建返回 201；命中账号内已有 Source（按身份或归一化地址）返回 200，响应体与 201 同构（同一 Resource + Source）。重复收藏不更新已存地址与标题（原始 URL 保留首次收藏的地址）。

**理由**：与 HTTP 语义一致，三端无需额外字段即可区分「新建」与「已存在」；响应体同构让客户端可以完全忽略两者差异。原始 URL 是用户重新打开原平台的入口，保留用户第一次实际使用的地址最可预期。

**影响**：等价地址（普通链接 vs 可识别分享链）第二次收藏得到同一条 Source（样例 `api-resources-duplicate-bilibili-p2`）。

## D4 · 进度用 expectedRevision 乐观并发；首写 revision 为 0

**决策**：进度写入必须带 `expectedRevision`；服务端当前版本不一致时返回 409 + `current: { positionMs, revision }`。无进度时视为 revision 0，首写成功后为 1。不做单调位置钳制（回拖按最后实际播放位置保存）。

**理由**：决策 4 允许多端/多标签页写同一来源进度，`positionMs` 本身可回退（拖拽），不能当作并发判断依据；版本号是唯一可靠的写入顺序依据。409 附 `current` 让客户端能直接决定覆盖或放弃，不需要额外一次读回。位置不做服务端钳制，因为「最后播放位置」的语义在 #49 已确认由客户端判定。

**影响**：冲突处理（读 `current` → 用户/策略决定 → 带新 revision 重写）由三端各自实现，契约固定冲突响应形态（样例 `error-progress-conflict`）。

## D5 · 第一轮一次收藏 = 一个 Resource + 一个 Source；归组延后

**决策**：第一轮每条收藏创建独立 Resource 与 Source，即使两条收藏同属一个 BV 的不同分集或同一节课的直播/回放。Resource↔Source 的 1:N 模型已在结构中预留（`source.resourceId`），但第一轮服务端不自动归组。

**理由**：#49 明确「专题与有序课程归组可在验证收藏和续学后补齐」。自动归组规则（同 BV 算一门课？同一 Resource？）需要用户验证收藏心智后再定，先归组会猜错结构。

**影响**：B 站多分集收藏后是列表里的多条资料，各有独立进度（满足 #49 用户故事 21）；后续引入归组时需要一次数据迁移，由 API 侧承担。

## D6 · 小红书图文笔记第一轮按归一化地址匹配

**决策**：小红书**视频笔记**提取 note id 作为 `platformVideoId` 参与身份匹配；**图文笔记**不是可播放视频，第一轮不提取身份，按归一化地址（url-exact）匹配。归一化丢弃 `xsec_token` 等分享参数，因此同一图文换 token 的分享地址仍匹配同一条。

**理由**：决策 1 的身份匹配限定在「能识别视频时」，GLOSSARY 的 Platform Video ID 也定义在视频上；把图文纳入视频身份会扩大术语语义。图文的重复风险（不同 token 地址）由归一化解决，剩余的重复（如 `/explore/` 与 `/discovery/item/` 两种路径形态）留给用户整理（决策 1 第 4 条）。

**影响**：图文收藏、打开与普通网页笔记一致；为图文引入身份匹配是后续可加的增强，不需破坏本契约。

## D7 · 小鹅通身份包含商店子域（platformScopeId）

**决策**：小鹅通的来源身份 = `platformScopeId`（商店子域，如 `appdemo`）+ `platformVideoId`（含前缀的资源 token）。`Source` 与请求 `identity` 中都携带 `platformScopeId`；其他平台恒为 `null`。

**理由**：资源 token 只在所属商店内有意义，不同商店是不同内容方；若只按 token 匹配，理论上的跨店撞号会把两家的课并成一条。子域是地址中稳定可提取的部分，不需要额外请求。

**影响**：`Source.platformScopeId` 成为四站中唯一一个平台专属字段；后续新增多租户形态平台时可复用该字段。

## D8 · 无法本地确认的分享短链按地址匹配

**决策**：`b23.tv/<短码>`、`xhslink.com/<短码>` 等不含媒体标识的短链不提取身份，按归一化地址（url-exact）匹配；解析重定向确认目标不在第一轮契约内。含标识的分享链（`b23.tv/<BV>?p=2`、`youtu.be/<id>`）直接按身份匹配。

**理由**：决策 1 第 2 条原文「分享短链只有在能确认对应网页和媒体标识时才按视频身份匹配」。本地无网或未解析时无法确认短码目标，强行按身份匹配会猜错；url-exact 保底，重复由用户整理。

**影响**：用户从 App 分享的纯短码先收藏、后从真实网页再收藏时会出现两条，属决策 1 第 4 条预期行为。

---

第二轮决策（Ticket 2.1，issue #64；结构与端点见 [contract-r2.md](contract-r2.md)）：

## D9 · Session 进入契约：逐字稿按 Session + Source 归档，进度仍按账号 + Source

**决策**：第二轮引入 Session 资源与生命周期端点 `POST /v1/sources/{id}/sessions`、`POST /v1/sessions/{id}/finish`。字幕归档、音频段、缺口与逐字稿全部挂在 Session 上（Session 关联 sourceId）。第一轮进度端点签名与语义不变：进度仍是（账号， Source）单条 `{ positionMs, revision }`，收尾时照旧写一次最终位置。兑现 D1 预留的演进路径——现有端点与样例零破坏。

**理由**：

- #49 第二轮的用户故事 20/27：一门课分多次学，每次的逐字稿归到同一份资料但按次区分，Web 要按次回查。Session 是唯一能承载「本次学习」边界的资源，这正是 D1 预判的第二轮归属需求。
- 进度的消费者（续播位置）仍只问「这条分集上次学到哪里」，单条即可；把进度并入 Session 会破坏第一轮续播语义与已发布样例。
- Session 服务端化让归档有明确的开关边界：字幕、音频、缺口都在 Session 关闭时定格，「已结束」由此成为可校验的状态（409 `session_already_finished`）。

**影响**：同一 Source 可并存多个 Session（历史归档 + 进行中，服务端不禁止并发 active）；进度与逐字稿是两个独立维度——续播位置单条覆盖，逐字稿按 Session 累积。Session 创建/收尾时机由插件实现票与决策 4 的开场收尾行为对齐。

## D10 · 转写服务端化：Speech Provider 凭据收归服务端

**决策**：产品流中音频转写只发生在服务端——API 调度 Worker（D13），Worker 调 Speech Provider。插件不再持有 Speech Provider 凭据、不再直连转写服务；PoC 的本地直连路径（options 页配置的 Groq / Tencent / Qwen 凭据与分段直转）作为 PoC 基线保留，不进入产品流，也不属于本契约。契约里没有任何 Provider 字段暴露给插件。

**理由**：

- 凭据随插件分发等于公开；只有服务端持有凭据才可控用量、可替换 Provider（Testing Decisions 的「替代 Speech Provider 使测试可重复」注入点在服务端）。
- 结果统一从 API 轮询取得（D12），插件无需感知 Provider 差异，三端契约因此与具体 Provider 解耦。
- 第三轮用量记录需要服务端是唯一转写入口，第一轮就位可避免日后迁移。

**影响**：Worker 使用的 Provider 凭据与 Worker 凭据都是服务端部署配置；插件设置页的 Speech Provider 配置在产品流中退役（PoC 行为不变）。

## D11 · 音频 = HTTP 约 30s 分段上传；实时 WS 留后续优化

**决策**：插件按约 30 秒一段（PoC segmenter 边界 5–60s）经 HTTP `POST /v1/sessions/{id}/audio-segments` 上传：JSON 体、音频 base64 字段、元数据与音频原子提交（contract-r2.md §3.4）。**实时 WebSocket（qwen3-asr-flash-realtime）不做进第二轮，留作后续优化**。

**理由**：

- HTTP 分段与既有 Speech Provider 的分段调用形状一致（PoC 一段一请求）；30s 粒度已满足「逐段展示、等待时显示转写中」的第二轮验收。
- 分段 HTTP 的重试是字节级重放，幂等键 `(sessionId, segmentIndex)`，断网重发简单可测；WS 需要连接管理、断线重连与流式半包语义，复杂度与第二轮验收不对价。
- 实时路径的价值主要在直播与低延迟展示；第二轮验收对象是录播课程（小鹅通、B 站、YouTube、小红书的可定位视频），延迟不敏感。
- base64/JSON 而非 multipart/二进制：见 contract-r2.md §3.4 的传输编码理由（全 JSON 约定、vanilla Node 零解析器、与腾讯云/Qwen 的 base64 形态同构）。

**影响**：后续引入实时转写（qwen3-asr-flash-realtime）时需要新的会话级流契约——连接建立、utterance 形态、与分段归档的合并规则——不影响本契约端点；PoC 的 realtime 模式同样留在 PoC。

## D12 · 插件轮询转写结果：一个读端点服务插件与 Web

**决策**：转写结果没有推送通道。插件按自定节奏轮询 `GET /v1/sessions/{id}/transcript`（TranscriptView），Web 回查用同一端点、同一形态；轮询间隔与退避由插件实现票决定，服务端只保证幂等读与状态单调（done/failed 终态不回退）。

**理由**：

- 「约 30 秒一段陆续展示」的验收天然适配轮询：完成的段到达即出现在 `records`，等待中的段在 `pending`（「转写中」），失败的段在 `failed`。
- 与 D11 一致：不引入 WS/长连接基建，三端与 Worker 都只用 HTTP。
- 一个读端点一种形态（TranscriptView），避免插件进度与 Web 回查各养一套结果结构。

**影响**：轮询节奏由插件自律（建议随 pending 数量退避）；服务端读幂等，轮询不影响其他端点。

## D13 · Worker 是独立发布单元，pull 模型领取任务

**决策**：apps/worker 是 pull 模型的独立单元（#49 的第四个发布单元），首个可运行版本起 0.1.0。API 与 Worker 之间是 pull 模型：Worker 以自有凭据 `POST /v1/worker/tasks/claim` 领取 pending 任务（音频 base64 内联，≤10MB），`POST /v1/worker/tasks/{id}/result` 回写 done/failed；API 不推送、不维护 Worker 心跳。

**理由**：

- pull 把调度解耦为「任务表 + 领取」：API 无需感知 Worker 实例数，Worker 可独立部署、独立发版、横向扩缩——这是它作为独立版本单元的前提。
- 音频内联让一次交接完成，省去第二个取流端点与第二套鉴权语义；段级别积小（约 30s opus，数十 KB），JSON 载荷不构成负担。
- Worker 崩溃恢复（租约过期重排）收敛为 API 内部机制，对契约只表现为「任务可再次被领取」，三端无需额外状态。

**影响**：Worker 凭据签发属运维约定（不在三端契约内）；第三轮总结类任务可复用 claim/result 形态扩展任务类型，无需新调度通道。

## D14 · 临时音频保留：成功即删，失败段保留至 Session 结束 + 宽限期

**决策**：采集音频是临时数据，不出现在任何 GET 响应中（唯一出口是 claim 内联）。任务 `done`（含静音段 `records: []`）后 API 立即删除该段音频，只保留逐字稿文本；任务 `failed` 时音频保留至所属 Session 结束加宽限期（宽限时长是部署配置，不是契约常量），供排查与后续重试类增强使用；`transcribing` 中音频随任务保留。上传先落库再入队，重发永不覆盖已存音频。

**理由**：

- 采集的是用户课程音频，最小化留存是隐私默认；成功段的文本已落库，音频没有第二次消费场景。
- 失败段保留是「失败反馈可排查」与将来「失败段重转」的前提；绑定 Session 生命周期避免孤儿音频。
- 保留策略与幂等总则互洽：首存为准意味着重试不可能改写已存内容。

**影响**：done 之后音频不可恢复——本契约无音频读取端点，删除不可观测也无需观测；失败段宽限期内可诊断；宽限期后的清理是 API 部署侧职责。

## D15 · 字幕直归档 + 同区间单一路径；缺口只收显式跳过

**决策**：

- 字幕直接归档：`POST /v1/sessions/{id}/captions` 按原样存插件读到的字幕段，字幕不全不补全、不推断缺口（用户故事 23 的「原样」分支）。
- 同区间单一路径：同一 Session 内字幕与音频互斥，首次提交锁定 `origin`，反向提交 409 `transcript_origin_conflict`；跨 Session 可换路径（本次字幕、下次 ASR），Web 按 Session 的 origin 标注来源。强制转写（字幕不全时对整个选定区间走 ASR）在客户端完成路径切换——插件在任何归档提交前决定路径，服务端不提供「切换路径」操作。
- 缺口语义：`gaps[]` 只收「播放中被跳过且至归档仍未取得文本」的显式范围（finish 上报，`reason: "skipped"`，对齐 PoC #48 的 `[已跳过 …]` 标记）。字幕自带的空缺表现为「无记录」，转写失败表现为 `failed[]`——都不进 `gaps[]`。

**理由**：

- 同区间双源会产生重叠/冲突文本，归档与展示语义复杂化；单路径让每条记录的 origin 无歧义，也让「字幕不全按原样归档」与「强制转写」两个用户故事有清晰的分界：前者发生在 captions 路径内，后者是提交前的路径选择。
- 强制转写是「还没归档时的选择」：PoC 流程里用户看到字幕不全才决定，此时字幕尚未提交，客户端切换即可，无需服务端撤销已归档数据。
- 缺口三态分开（记录 / gap / failed）让「跳过」与「未取得文本」显式可区分（#49 第二轮要求），且每态有单一产生者：gap 只来自 finish 上报，failed 只来自 Worker 回写，缺记录只能是字幕不全或静音——三端不需要猜。

**影响**：字幕提交时机由插件实现票定（建议路径承诺后、finish 前提交一次，使强制转写永远不需要撤销）；回看补录成功的跳过范围不再上报 gap；静音段（done 但无文本）不产生记录也不标记缺口。

**演进（第二轮 review）**：初稿曾把「`finished` 后 `pending` 必为空」当作 TranscriptView 的不变量。实现落点与之不符：插件的常规收尾是先 finish 再 drain——`endActiveSession` 结束 Session 后继续以有限预算（15 拍）轮询，等尾段 `pending` 渐进清空；而 Worker 领取的租约（lease）重排未做，worker 停机且无租约时滞留任务不会被重排，`pending` 因此可在 `finished` 视图里滞留。契约（§2.5 / §3.5）据此改为「`finished` 后 `pending` 随尾段 drain 渐进清空」，客户端按 `sessionStatus` 把滞留段标注为排队而非终态；租约重排仍属 API 内部机制（§3.7），后续补上时该措辞可自然收敛回「必为空」。

---

第三轮决策（Ticket 3.1，issue #73；结构与端点见 [contract-r3.md](contract-r3.md)）：

## D16 · 课程总结服务端生成：AI Provider 凭据收归 API，与 Worker 的 Speech Provider seam 并列独立

**决策**：总结生成只发生在服务端——`POST /v1/resources/{id}/summaries` 由 API 聚合材料、调用 AI Provider、落库并同步返回 201。插件与 Web 不持有 AI Provider 凭据、不直连模型服务（D10 同款理由：凭据随客户端分发等于公开；服务端持有才可控用量、可替换 Provider、可注入测试替身）。AI Provider 的身份只在 Summary 的 `generation` 元数据中以不透明字符串记录（`provider` / `model`），不暴露凭据或端点。

**归属与理由（ASR 在 Worker、AI 在 API）**：两个 Provider seam 并列但归属不同单元，由输入性质决定——

- 转写的输入是**音频字节**：重负载、长任务，需要 pull 模型把音频交接给独立进程（D13），Worker 因此持有 Speech Provider 凭据与音频。
- 总结的输入是**已落库的结构化材料**（transcript records / gaps + notes，D17）：无音频字节、无流水线，生成是单请求-单产物，同步完成即可。材料本来就在 API 手里（逐字稿轮询、资料详情都由 API 出），在 API 内调用 AI Provider 免去二次交接——不需要总结任务下发 Worker，也不需要第三条 claim/result 通道。
- 演进预留：若未来总结需要异步化（超长上下文、重试预算、批量回补），可按 D13 预留的形态在 Worker 增加任务类型，本契约端点不因此改变。

**双 Provider**：默认部署 `qwen`（产品路径），测试注入 stub（Testing Decisions「替代 AI Provider 使测试可重复」）；`provider`/`model` 是不透明字符串，不构成三端约定的枚举。

**生成语义**：

- **每次主动生成 = 一条新记录**（历史保留可回查）：POST 永远创建新 Summary，不做首存去重——是否值得重新归纳由用户判断（用户故事 28/29），服务端无法替用户决定；防抖是 Web 实现票的职责。
- **同步生成**：组装 → AI Provider → 落库 → 201 在同一请求内完成。总结无渐进产出，不设轮询面（与 D12 的逐字稿轮询不同构）。
- **失败反馈形态：不落脏数据**——AI Provider 调用失败、超时或返回不可解析时返回 502 `summary_generation_failed`，不产生 Summary 记录，列表与用量都不出现本次尝试（D18 同口径）；重试即用户再次发起。对比逐字稿的 `failed[]`：那是段级进行时状态（音频已入库、失败可排查、将来可重转），而总结是原子产物——要么完整存在，要么不存在；失败条目没有可回查的正文，只会污染回查列表。

**影响**：API 部署配置新增 AI Provider 凭据（与 Worker 的 Speech Provider 凭据相互独立）；插件与 Web 无任何 Provider 感知；无逐字稿可生成时返回 409 `no_transcript_to_summarize`，不发起 AI 调用。

## D17 · 生成输入 = 全部 Sessions 的 transcripts(records/gaps) + notes；prompt 外移 prompts/course-summary.md

**决策**：生成范围固定为该 Resource **当前全部已归档材料**，不接受客户端裁剪（请求体为空对象 `{}`）：

- 每个 Session（`active` 与 `finished` 均计入——未学完可生成）的 TranscriptView：`records` 全文按 `startMs` 升序，行首带 `[sessionId 起点–终点]` 来源标记（毫秒，来源视频时间轴）；`gaps` 以「已跳过，该范围未取得文本」标记进入输入。
- 该 Resource 全部 notes：时间戳笔记带 Source 与位置，普通网页笔记按序。
- **不进输入**：`pending` 与 `failed` 段（没有文本）、静音段（done 无记录——没有文本）。空缺信息只以跳过标记与字幕缺失的自然断点呈现，模型不编造缺失内容。
- **prompt 外移** [prompts/course-summary.md](../prompts/course-summary.md)：系统提示、用户模板与变量（`{resourceTitle}` / `{transcriptLines}` / `{gapLines}` / `{noteLines}`）都在该文件，实现票加载模板填变量，不把 prompt 散落进代码。先例是仓库 prompts/ 目录的 `topic-tick.md` / `session-report.md`（PoC #48 的纪要 prompt 形态）；PoC D4 的原则不变——prompt 是纯模板，代码只做变量填充。
- **引用清洗**：模型返回的 citations 在落库前逐条对账——`segmentRef` 必须命中该 Resource 某 Session 的真实归档记录（sessionId 归属该 Resource、区间对上记录、quote 是记录文本的逐字摘句），对不上的引用丢弃。引用是回查锚点（spec #49「通过原文和时间戳回查实际来源」），落库死链等于给用户坏的回查入口。
- **`inputChars` 口径**：提交给 AI Provider 的完整输入字符数（组装后的 prompt 全文，含模板与来源标记），与用量的 `summaryInputChars` 同源（D18）。

**理由**：材料只会累积（契约无删除逐字稿的端点），「当前全部已归档」是服务端可独立判定的范围；逐字稿行带来源标记让模型产出的引用可回指真实记录，是引用清洗可机械执行的前提；输入含 notes 与跳过标记是「归纳学习者的理解、不编造缺失」的输入基础。

**影响**：补学后再次生成自然覆盖新增材料（聚合范围随归档增长）；同资料多 Session 的来源与时间轴在输入中分别保留，citations 可跨 Session 指回各自记录。

**多 Source 资料后果**：一个 Resource 可挂多个 Source（D5 预留的 1:N——分集、直播回放各自成 Source），而本决策的聚合把全部 Sessions 的记录按裸毫秒合并进单一时间轴：不同 Source 的行会按时间互相穿插，且模型输入只见 sessionId、不见 Source 身份（模型无法区分「第几集」）。回查不受影响——citations 的 sessionId 在服务端可解析回所属 Source（引用清洗按 Session 归属对账，Web 回跳锚定到具体记录）。按 Source 分节聚合（每集一节、分别归纳）留作后续演进；当前一轮验收样本以单 Source 为主。

## D18 · 用量口径：只记录不计费；两个记录时点都是产物落库时刻

**决策**：`GET /v1/usage` 返回账号级累计：`audioSeconds`（转写时长，秒）、`summaryCount`（总结生成次数）、`summaryInputChars`（总结输入字符累计）、`updatedAt`（最后一次计数写入时间）。**只记录不计费**——价格、账单、付款与配额执行全部 out of scope（#49 Out of Scope）；本端点是 Web 查询入口的数据源，无时间窗与资源维度参数（后续计费口径若需要维度扩展，加端点或参数，不改本形态）。

**记录时点**：

- `audioSeconds`：音频段任务**首次 done 时**（Worker 回写 done 落库时刻）按段时长（`endMs − startMs`）累加；`audioSeconds` = 累计毫秒 ÷ 1000 向下取整。失败段不计（没有产出文本）、转写中不计；静音段（done + `records: []`）**计入**——音频真实转写过；同段至多计一次（回写首存为准天然保证，重试类增强引入后也不重复计数）。
- `summaryCount` / `summaryInputChars`：总结**成功落库时**（201 响应的同一时刻）记录——`summaryCount` +1，`summaryInputChars` += 该次 `generation.inputChars`。生成失败不落库也不计数（与 D16「不落脏数据」一致）。

**理由**：两个时点都是「产物诞生」的时刻——文本产物（逐字稿记录 / 总结）落库才计用量，与 D14「done 即删音频」的产物观一致；进行中与失败态都不代表已交付的成果。字符量用 Unicode 码点数而非 token 数：token 计数随各 Provider 的 tokenizer 不同，字符数三端可一致复现，且与 Summary 元数据的「输入规模」同源可对账。

**影响**：用量单调递增，无扣减路径（契约无删除端点）；`updatedAt` 只在计数写入时前进。样例链（`summary-examples.json` 的 `api-usage`）固定了整条口径：done 段求和 120 秒、2 次生成、1876+2264=4140 字符。

## D19 · 管理员标记：邀请即标记，CLI 是唯一标记入口；管理面对非管理员 404

**决策**：账号对象增加 `isAdmin`（boolean，缺省 false）。本轮唯一标记入口是邀请 CLI：`python -m app.invites add --admin <email>`（`--admin` 位置灵活）——**邀请即标记**：新邀请直接带标记；对已存在的邀请/已开户的账号补打标记则原样升级（邀请行与账号行都写 `isAdmin: true`）。经 `--admin` 邀请开出的账号即管理员账号。没有翻转 `isAdmin` 的 API——管理面是消费方，不是标记方。GET /v1/me 的 `account` 追加 `isAdmin` 键，三端据此分支。

管理面（本轮 `/v1/admin/*`）守卫 = 有效凭据 + `account.isAdmin`，实现为 fastapi Depends：未携带凭据 401（与一切受保护端点一致）；**已认证的非管理员一律 404**（`接口不存在或无权访问`）——D2 的「不透露存在性」从资源隔离延伸到端点隔离，非管理员无法区分「端点不存在」与「端点存在但你不是管理员」。

**理由**：试用制下账号由邀请开通（决策 3），管理员天然是「被邀请的运营者」——邀请时刻就是标记时刻，不需要独立的账号管理 UI；CLI 直接写服务端 state 文件，与 invite 的 round-1 形态一致。404 而非 403 的理由同 D2：403 确认端点存在。

**影响**：首轮注册表的使用样例是「CLI 标记 → 开户 → 访问管理面」；已开户账号的提升在服务端下次读盘后生效（CLI 与服务端共享 state 文件的既有纪律）。后续轮次若引入更多管理面端点，直接复用同一守卫语义。

## D20 · 站点能力注册表：服务端唯一写入方，种子只补缺失行，注册表不由 API 扩张

**决策**：站点能力是服务端数据，存于 store 的 `siteCapabilities` 集合，按 platformId 一行 `{platformId, captions, asr, enabled}`（全布尔）。启动时对种子平台（bilibili/youtube：captions true；xiaoe/xiaohongshu：captions false；asr/enabled 全 true）**只补缺失行**——已有行（含管理员修改）永不被启动覆写。普通用户 GET /v1/site-capabilities 读全表（插件据此决定字幕/ASR/禁用行为）；管理员经 `/v1/admin/site-capabilities` 读全表、PUT 单行（请求体是 `{captions?, asr?, enabled?}` 的任意布尔子集，未提及字段保持原值）。种子外的 platformId 无行且不可经 PUT 创建（404）——**注册表的生长只发生在服务端代码/种子里**，API 只翻转布尔位，不创建平台。

**理由**：插件内置能力假设会随平台改版腐化，服务端化让「这个平台现在怎么采」成为一次部署可纠正的运营参数（本轮的地基，后续面板轮次消费）；「只补缺失行」让管理员修改在重启后存活，种子更新只对新增平台生效；PUT 子集语义让运营只说「改什么」，不说「整行是什么」。

**影响**：能力行无时间戳/历史版本面（当前值即全部事实）；未知平台的 PUT 404 与 D19 的管理面 404 语义不同层——管理员已过守卫，404 表达「平台不存在」。400 文案（非布尔/子集外字段/非对象体）由错误样例固定，三端共享。

---

第六轮决策（面板 AI 服务端化 I，Ticket 6.4，issue #89；结构与端点见 [contract-r4.md](contract-r4.md) §6）：

## D21 · 滚动摘要服务端化：幂等 tick + append-only Topic 时间轴；usage 追加滚动摘要两键

**决策**：面板的滚动摘要（Rolling Summary，ADR 0002 的 append-only Topic 时间轴）收归服务端：`POST /v1/sessions/{id}/rolling-summary` 与 `GET /v1/sessions/{id}/overview`（任何登录用户，Bearer 即可）。服务端存 `sessionInsights` 集合，按 Session 一份概览文档（`topics` / `lastCoveredMs` / `generation` / `generatedAt`）。tick 输入由服务端自己从该 Session 已归档 records 组装（覆盖游标 = 最后一个 Topic 终点，游标之后的新记录 + 游标前 120 秒仅上下文重叠尾 + 既有 Topic 标题；prompt 外移 [prompts/topic-tick.md](../prompts/topic-tick.md)，自 PoC `apps/extension/prompts/topic-tick.md` 迁移，时间轴从会话相对秒改为来源时间轴毫秒）；**append-only**：新 tick 只追加 Topic，既有 Topic 永不改写，index 跨 tick 延续，整份文档落库为最新版。**幂等**：游标之后没有新记录时返回 200 与当前概览原样（幂等回放）——不调 AI、不推进 generatedAt、不计数；PoC 的防抖（≥15 分钟覆盖且 ≥10 条记录——AND，PoC isTopicTickDue 语义——的内容驱动节奏）与定时器留在调用方，服务端不设节奏。201 = 概览首次落库，200 = 追加或幂等回放。面板 AI 与课程总结共用同一 AI Provider seam（LD_AI_PROVIDER / LD_AI_API_KEY 不变；seam 增加 Topic 数组形态）。GET /v1/usage 的 Usage 追加 `rollingSummaryCount` / `rollingSummaryInputChars` 两键（D18 同构：tick 产物落库时计数，失败 tick 与幂等回放不计；既有四键语义零改动）。

**理由**：防抖留在调用方，因为「何时值得总结一次」是内容驱动的产品节奏（PoC #48 的既定语义），服务端重复实现定时器只会造成两套节奏；服务端幂等重算让重复触发与重试安全——同样的已归档材料永远得到同样的概览。append-only 对齐 ADR 0002：逐步改写既有内容会累积漂移、丢失细节（PoC 否决的合并链），追加 + 编号延续既保住时间轴的回查锚点又让游标推进可判定。服务端时间轴用毫秒与 transcript records、course-summary citations 的单一时间轴一致，三端渲染无需换算。tick 无记录即 409、AI 失败即 502 且概览与用量零写入（D16 不落脏数据），沿用第三轮的反馈形态。

**影响**：新增三个错误码——409 `no_session_transcript_to_summarize`（无已归档 records，409 在 AI 调用前判定）、502 `rolling_summary_failed`、404 `overview_not_generated`（会话存在但概览未生成，与 D2 的 not_found 分码）；404 封套自此不止 `not_found` 一个码。Seam 扩展为双形态（`generate` / `generate_topics`），stub 与 qwen 两个实现都提供；测试注入点不变。插件接线（面板轮询 GET overview、tick 触发时机）在 6.6；插件本地的 session-summary 实现与 prompts/topic-tick.md 副本本轮不动、届时退役。Session Digest（单次学习结束的全局 pass）不受影响——它与 Rolling Summary 的分工仍是 ADR 0002。

## D22 · Session Digest 与选中文本解释服务端化：整节一次性覆盖（与 rolling 相反）+ 无状态 explain；usage 追加四键

**决策**：面板的整节学习纪要（Session Digest，GLOSSARY 术语：已完成 Session 的按话题组织的汇总）与选中文本解释收归服务端：`POST /v1/sessions/{id}/digest` 与 `GET /v1/sessions/{id}/digest`、`POST /v1/ai/explain`（任何登录用户，Bearer 即可，explain 无状态不落存储）。服务端存 `sessionDigests` 集合，按 Session 一份纪要文档（五个 report 键 `overview` / `topics` / `categories` / `quotes` / `todos` 固定恒在，空段即空数组 + `generation` / `generatedAt`）。digest 输入由服务端自己从该 Session 的**全量** transcript 组装（已归档 records 与 finish 上报的 skipped gaps 合并在单一来源时间轴上，`[startMs–endMs]` 戳；该 Session 的 Rolling Summary Topics 作为 liveTopics 合并提示随行；prompt 外移 [prompts/session-report.md](../prompts/session-report.md)，自 PoC `apps/extension/prompts/session-report.md` 迁移，时间轴从会话相对秒改为来源时间轴毫秒——D21 同一适配；PoC 内联的 `[语音转录失败]` 失败标记对应服务端的 gap 标记行）。**整节一次性**：每次成功 POST 都对全量逐字稿重新生成并把整份纪要覆盖落库（topics 从 1 起重新编号，旧纪要不保留历史）——与 Rolling Summary 的 append-only 相反；201 = 首次落库，200 = 覆盖重生成。**仅限已结束的 Session**（未 finish 409 `session_not_finished`：整节语义的前提是材料定型）。模型回复按 PoC parseGlobalPass 移植清洗（逐条再校验 + 截断），解析成功但全部五段皆空视为生成失败。explain：请求 `{text 必填非空 ≤8000 码点, context? 可选 ≤8000}`，无状态回答 `{explanation}`，prompt 外移 [prompts/explain.md](../prompts/explain.md)（自 PoC 迁移；无状态请求不携带视频标题，VIDEO 行删除，context 缺省填 `None` 沿 PoC）。GET /v1/usage 的 Usage 追加 `digestCount` / `digestInputChars` / `explainCount` / `explainInputChars` 四键（D18 同构：digest 落库时计数——**覆盖重生成同样计数，因为覆盖就是一次真实 AI 调用，digest 没有幂等回放形态**；explain 200 应答时计数；失败尝试一概不计；既有六键语义零改动）。

**理由**：覆盖而非追加，因为两种产物的生命周期不同——Rolling Summary 是课中过程（材料持续增长，游标推进、话题追加是学习过程的回查锚点，ADR 0002），而 Digest 是已结束会话的最终交付物：材料定型后重新生成只可能是用户主动要求换一版，历史版本没有回查价值，PoC 亦如此（重跑 global pass 即覆写 `report_<sessionId>`）。「仅限已结束」是这个语义的前提：进行中的会话材料未定型，整节生成既昂贵又会立刻过时。五键固定恒在是把 PoC 渲染器的「空节省略」翻译成 API 的固定形态（渲染方判空即可，不必探测键是否存在）；全空即 502 沿用 rolling 的「零可用话题」家族规则——落库的纪要至少有一个非空段，web 渲染永不出现空壳。explain 保持无状态，因为解释是即用即弃的阅读辅助（PoC 就不持久化），落库只会制造无人回查的数据；8000 码点上限覆盖最长的逐字稿选段 + 上下文，D18 计数单位一致。

**影响**：新增错误码——409 `session_not_finished`、502 `digest_failed`、404 `digest_not_generated`、502 `explain_failed`（explain 的 400 沿用 `validation_failed`，文案由样例固定：`text 必须是非空字符串` / `text 不能超过 8000 字符` / `context 必须是字符串` / `context 不能超过 8000 字符`）；409 `no_session_transcript_to_summarize` 沿用 §6.4 的码与文案。Seam 再扩展（`generate_digest` / `explain`），stub 与 qwen 两个实现都提供；测试注入点不变。Usage 形态自 r3 的四键经 §6.3 的六键至此十键（追加键不破坏既有消费者）。插件接线（结束后触发 digest、选中即请求 explain）在 6.6；插件本地的 global pass 与 prompts/session-report.md、prompts/explain.md 副本本轮不动、届时退役。

---

第七轮决策（删除能力，Ticket 5.5，issue #94；端点与级联清单见 [contract-r4.md](contract-r4.md) §8）：

## D23 · 删除级联语义：Resource 级整档删除，usage 账目保留；删除即终态，一次快照落盘

**决策**：学习资料的删除以 **Resource 为粒度**——`DELETE /v1/resources/{id}` 删除该 Resource 名下**全部**数据：`sources`（其名下全部 Source）、`progress`（按 sourceId）、`notes`（按 resourceId）、`sessions`（按 resourceId 归属）、`transcripts` / `sessionInsights` / `sessionDigests`（三者都按 sessionId 键，待删键 = 该 Resource 名下全部 Session 的 id）、`summaries`（按 resourceId）；**`usage` 集合不动**——账目不随删除消失。成功 200 `{"deleted": true}`，不逐项回执；**删除即终态**：重复 DELETE、未知 id、跨账号 id 是同一个 404（D2 封套，复用 `error-cross-account-resource`，不新增错误样例），不设墓碑、无幂等保留。持久化原子性：服务端先收集全部待删键，再一次性删除（store 的批量删除原语），最后**单次快照落盘**——多集合级联不产生中间态文件。Source 级单删（同一资料多来源时只删某一集）延后：当前删除动作的产品语义是「这条资料我不要了」，按整档清理；逐来源粒度等出现真实需求再扩展端点。

**理由**：**usage 保留**是因为账目的口径是「已发生且已计过的真实消耗」（D18 只记录不计费、单调递增无扣减路径）——删除资料是整理学习库，不是否认消耗发生过；同 URL 重新收藏会新建 Resource，其后续用量继续累进同一账号账目，保留账目才保得住账号的真实成本历史，回滚账目反而制造与计费/审计口径的分裂。**删除即终态**是因为账号对一条资料只有「在」与「不在」两态：引入「刚删除」墓碑就要让 list/detail/resolve 全链路过滤它，而客户端的「已被另一端删除」场景用 404 呈现即可，两态语义让删除后的 resolve「无匹配」与重新收藏「新建」（D3 去重只作用于存活 Source）自然成立。**Resource 级粒度**是因为逐字稿/笔记/总结/概览/纪要全部挂在 Resource（或其 Sessions）下，单删 Resource 而留下任何一份衍生产物都会成为不可达的死数据。

**影响**：级联清单把 `sessionDigests`（D22 的集合）与 `sessionInsights` 一并纳入——票面清单点名了 rolling 概览，digest 同为按 Session 键的派生产物，按「删全档」原则同批清除。插件零改动：对已删除资源的 resolve/开课按既有「无匹配」语义自然工作。Web 侧两步确认（列表与详情两入口，详情确认文案明示级联范围）与本决策的实现票落地；DELETE 404 在 Web 呈现为「资料已不存在」并从列表移除。
