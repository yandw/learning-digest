# 第二轮联调验收清单与发布记录

对应 [#72](https://github.com/yandw/learning-digest/issues/72)（spec #49 第二轮）。第一轮清单见 [round1-acceptance.md](round1-acceptance.md)；统一发布时两份清单一起走，发布记录模板以本文档 §5 为准（版本矩阵已含 apps/worker 与契约 v2 面）。

验收门槛原文见 [docs/productization-four-part-plan-v0.1.md](productization-four-part-plan-v0.1.md)「集成门槛」表第二轮行：**验证字幕全文显示与直归档、ASR「转写中」提示与约 30 秒一段的结果展示、字幕不全时的整段强制转写。同一区间只采用一种方式。两类结果都能在 Web 回查，并验证选定标签页、来源、账号和 Session 归属。** spec #49 第二轮相关节：字幕全文/约 30s 分段/转写中/强制转写/双路径同区间单源/Web 回查；「Testing Decisions」第二轮用户行为：完整字幕路径验收零 ASR 调用、失败反馈、逐字稿 Web 可回查。

- 可自动化的部分（契约样例、接口边界、三端回归）已在集成分支 `productization/integration` 全绿，见 §1。
- 需要真实环境的部分（四站字幕/ASR 样本、worker 停启）是 §2 的人工步骤清单；tabCapture 后台标签页授权实测沿用第一轮记录（[round1-acceptance.md](round1-acceptance.md) §2.6 / §3.5）。
- 第三轮（课程总结）门槛条目在 §3 占位：票据进行中，落地后补步骤。
- 已知限制与契约决策（D9–D15）映射见 §4，细节在 [contracts/decisions.md](../contracts/decisions.md)。
- §5 是发布记录模板（版本矩阵 / env 配置 / 真实 ASR 链路联调占位）。

使用方式：逐项勾选。自动化项只需在合入时重跑一次；人工项按编号步骤走，把观察结果记到 §5.5 的汇总表。

## 1. 自动化验收（本分支已绿）

实测分支 tip `121b9ee`（二轮功能票全部落地），日期 2026-11-12，全部通过，合计 **1038 pass / 0 fail**：

- [x] **契约** — `node --test contracts/` → **43 pass / 0 fail**
  v1 全量（32 项）之上叠加 contract-r2：Session/Transcript/音频任务 fixture（跨文件故事一致性被测试钉住）、error-examples 二轮 10 例（origin conflict、session_already_finished 等）、D9–D15 形态全量断言。
- [x] **API 边界** — `cd apps/api && npm test` → **158 pass / 0 fail**
  Session 生命周期（create/finish，重复 finish 409）、captions 直归档（首存为准、origin 锁定、反向 409）、audio-segments（幂等键 `(sessionId,segmentIndex)`、乱序归位、11MB per-route cap）、TranscriptView 四数组恒在场、worker claim/result（静态凭据 timing-safe、空 token fail closed、pending→transcribing→done|failed 终态不回退、done 即删音频）；一轮全部套件零回归。
- [x] **Worker** — `cd apps/worker && npm test` → **25 pass / 0 fail**
  pull 主循环（串行 + 空轮询退避）、stub/qwen provider seam、静音段 = done 空 records、回写重放与终态、config fail fast（qwen 无 key 启动即失败）。
- [x] **Web 逻辑** — `cd apps/web && npm test` → **117 pass / 0 fail**
  详情页逐字稿区块：多 Session 倒序、origin 徽标、四数组合并成单一 startMs 时间线（record/gap/pending/failed 渲染）、按 Session 二次拉取 §3.5、单块失败降级不拖垮详情页、SEEK_PARAM_BUILDERS 时间戳回跳；断言锚定 session-examples.json。
- [x] **插件纯模块与接线** — `npm test`（根，`node --test tests/*.test.js`）→ **695 pass / 0 fail**
  bilibili/youtube 字幕 reader（双探针、轨选择、坏体不误报）、session-archive 契约客户端、transcript-pipeline（30s 分段、上传重试 2s/8s/30s、4s 轮询退避封顶 30s）、强制转写决策流（覆盖 probe、两分支、跨 Session 新区间）、#48 的 61 个 anchor/seek/hole-fill 测试改接上传+轮询缝全量回归。
- [x] `npm run check` → Release checks passed（44 allowlist 文件）。

## 2. 人工验收步骤

### 2.0 环境准备（一次）

第一轮环境照旧（API/Web 启动、邀请邮箱登记、验证码 outbox、扩展加载——见 [round1-acceptance.md](round1-acceptance.md) §2.0）。第二轮新增：

1. [ ] 扩展卡片显示版本 **0.2.12**；API/Web/Worker 均为集成分支 tip
2. [ ] **API 启动前**设置 worker 服务凭据（默认空 = fail closed，任何 worker 都领不到任务）并重启：

   ```bash
   LD_API_WORKER_TOKEN=<随机串> npm start --prefix apps/api
   ```

3. [ ] 启动 Worker（第三个终端，token 与 API 侧同值）：

   ```bash
   cd apps/worker && LD_WORKER_TOKEN=<同 LD_API_WORKER_TOKEN> npm start
   # [worker] provider=stub api=http://127.0.0.1:8787 poll=5000ms
   ```

   默认 **stub provider**（确定性样例文本）即可完成 §2.3–§2.5、§2.7 的链路验收；真实语音转写见 §5.4（`LD_WORKER_PROVIDER=qwen` + `QWEN_API_KEY`，待用户配置）。插件 options 的 AI Provider key 沿用 PoC 配置，只影响结束学习时的 AI 纪要 pass，不影响逐字稿归档。
4. [ ] 样本登记（可复用第一轮 §3.3 的四站样本，逐项补字幕/ASR 属性）：
   - B 站**有字幕**视频一（CC 或 AI 轨均可，CC 优先）＋ B 站**无字幕**视频一
   - YouTube **有字幕**视频一 ＋ YouTube **无字幕**视频一
   - 小鹅通回放一（直播可选）＋ 小红书视频一
5. [ ] 验证码与第一轮同（dev mailer：API stdout + `apps/api/data/outbox.jsonl`）

### 2.1 字幕路径 · B 站有字幕视频（全文展示 + 直归档 + 零 ASR）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 1.1 | §2.0 完成、B 站有字幕视频已收藏 | 打开视频页 → 工具栏图标开侧边栏 → 选中该标签页 →「开始学习」 | Session 开启；面板逐字稿区出现**字幕全文**（双探针读取：CC/AI 轨同列，CC 优先）；**全程无采集授权请求、无 tabCapture/offscreen 指示**（capturePath=captions，不进入 ASR 管线） |
| 1.2 | 1.1 进行中 | 观察 Web 详情页该 Session | 开场覆盖 probe 判定覆盖完整时字幕即直归档；详情页块头 origin 徽标为「字幕」 |
| 1.3 | 学习中拖拽跳过一段 →「结束学习」 | 观察面板与归档 | 字幕按原样归档（不补全）；本次跳过的范围落 `gaps`（「已跳过 m:ss–m:ss」）；字幕轨自带空缺表现为**无记录**、不标缺口（D15） |
| 1.4 | 1.3 完成 | **零 ASR 断言**：worker 终端 | worker stdout 除启动横幅外无任何输出（无 cycle failure、无回写错误）；面板全程未出现「转写中」；`GET /v1/sessions/{id}/transcript` 无 `pending`/`failed` |
| 1.5 | 1.4 通过 | Web 详情页回查该 Session | origin「字幕」徽标、全文与面板一致、跳过范围显示为 gap |

- [ ] B 站有字幕：______（样本见 §2.0 第 4 条）

### 2.2 字幕路径 · YouTube 有字幕视频

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 2.1 | YouTube 有字幕视频已收藏 | 开始学习 | 字幕全文展示（读嵌入 ytInitialPlayerResponse、json3 解析为段级毫秒）；无采集指示 |
| 2.2 | 2.1 完成 | 重复 1.3–1.5 | 同 B 站：原样归档、gaps 只收显式跳过、零 ASR、Web origin「字幕」 |
| 2.3 | 样本为无字幕视频（或字幕轨需 PO token 授权不可读） | 开始学习 | 面板如实提示字幕不可用 → 按 §2.3 走 ASR 回退（属预期路径而非缺陷） |

- [ ] YouTube 有字幕：______

### 2.3 无字幕回退 · ASR 接管（B 站 / YouTube 分别实测）

对两站各走一遍（spec 明确此组**分别实测**）：

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 3.1 | 无字幕样本已收藏 | 开始学习 | 面板提示无可用字幕、可转写（captionsUnavailable 事件 + 转写提示） |
| 3.2 | 首次采集 | 按提示完成采集授权 | 授权形态以第一轮 §2.6 实测结论为准（目标标签页上点一次工具栏图标完成调用） |
| 3.3 | 采集进行中 | 连续播放 ≥ 1 分钟 | 逐字稿区先见「**转写中**」（pending）；段记录按**约 30 秒一段**陆续出现（stub provider 数秒内翻正） |
| 3.4 | 中途拖拽跳过一段 | 继续播放 | 跳过范围不产生记录；结束后随 finish 上报 gaps |
| 3.5 | 「结束学习」 | 观察收尾 | 尾段 flush 后 finish；面板最终视图 records/gaps/failed 三态分明 |
| 3.6 | 3.5 完成 | Web 详情页回查 | origin「语音转写」徽标；记录/gap/failed 与插件一致 |

- [ ] B 站无字幕 → ASR：______
- [ ] YouTube 无字幕 → ASR：______

### 2.4 ASR 平台 · 小鹅通回放/直播 + 小红书视频

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 4.1 | 小鹅通回放已收藏 | 采集授权 → 开始学习 → 播放 | 采集 → 分段上传 →「转写中」→ 逐段出现；流程同 §2.3 |
| 4.2 | 4.1 完成 | 结束学习 → Web 回查 | origin「语音转写」；时间戳回跳仅展示（小鹅通无定位参数） |
| 4.3 | （可选）小鹅通直播样本 | 开始学习 → 播放 | 无拖拽定位 → 无 gaps 上报（预期）；分段照常 |
| 4.4 | 小红书视频已收藏 | 同 §2.3 流程 | 采集 → 上传 → 逐段；Web 回查同上 |

- [ ] 小鹅通：______　- [ ] 小红书：______

### 2.5 强制转写 · 字幕覆盖不全的三个分支

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 5.1 | 字幕覆盖不全的 B 站样本（如从中间开始续学） | 开始学习 | 覆盖 probe 判定不全 → **推迟归档**，出现决策面：「字幕覆盖 x–y，缺口将不转写，或选择强制转写整个区间」+ 两个入口 |
| 5.2 | 分支 A（未归档） | 点「强制转写整个区间」→ 两步确认 | **同一 Session** 整段切 ASR（字幕不提交）；自切换点起逐段转写；切换前已播未转写的头部 = 无记录、不进 gaps；Web origin「语音转写」 |
| 5.3 | 分支 B（未归档） | 点「按原样归档字幕」 | 字幕原样入库、缺口不补不转写；Web origin「字幕」 |
| 5.4 | 分支 C（已归档） | 已按原样归档的 Session 结束后，再选该视频 → 面板保留「强制转写（新的学习区间）」入口 → 确认 | 结束当前（若有）学习 → **开新 Session** 直走 ASR（D15 跨 Session 换路径，契约无撤销、显式记录）；Web 详情两个 Session 并列、origin 各自标注 |
| 5.5 | 5.2–5.4 各完成后 | 复核同一区间单源 | 每个 Session 内字幕与 ASR 记录不混排；origin 单值 |

- [ ] 分支 A 同区间整段 ASR：______　- [ ] 分支 B 原样归档：______　- [ ] 分支 C 已归档 → 新 Session：______

### 2.6 Web 逐字稿回查

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 6.1 | §2.1–§2.5 留下的历次 Session | 打开 Web 详情页「逐字稿」区块 | 多 Session 倒序并列；块头 = 学习时间 / 状态 / origin 徽标（字幕 / 语音转写）；无逐字稿的 Session 显示「本次学习未产生逐字稿」 |
| 6.2 | 混合三态的 Session | 检查段级时间线 | record = mm:ss + 文本；gap = 「已跳过 m:ss–m:ss」；pending = 「转写中」；failed = 契约 error.message 原样 |
| 6.3 | 任一 record | 点时间戳回跳 | B 站带 `t=`、YouTube 带 `t=…s`（保留 `p=` 分集）打开原平台定位；小鹅通/小红书仅展示时间戳 |
| 6.4 | 双账号（第一轮 §2.8 配置） | 账号 B 打开账号 A 的资源 | 404（不透露存在性）；逐字稿与其他数据一样按账号隔离 |

- [ ] Web 回查：______

### 2.7 Worker 独立性（服务端韧性感知）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 7.1 | ASR 学习进行中 | Ctrl-C 停掉 worker 进程 | API 不受影响照常收段（pull 模型，D13：API 不推送、不维护心跳） |
| 7.2 | worker 停止期间 | 继续学习、上传若干段 | 面板这些段保持「转写中」，无失败误报；任务在服务端 pending 排队 |
| 7.3 | 重启 worker | 观察几分钟 | pending 任务按 segmentIndex 升序逐个领取完成；「转写中」逐段翻成记录 |
| 7.4 | 7.3 完成 | Web 回查 | 与插件视图一致；无重复记录（幂等键首存为准） |
| 7.5 | （可选，记录现状） | worker 在某段 claim 后再次 Ctrl-C | 该任务停 transcribing、对应段保持「转写中」，不会被重新领取——租约机制未做（见 §4），预期语义 |

- [ ] Worker 停启韧性：______

### 2.8 归属复核（选定标签页 / 来源 / 账号 / Session）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 8.1 | 目标课程标签页置于后台 | 从面板列表选中后台标签页 → 开始学习 → 切走浏览器焦点 | 记录/采集目标仍锁定原标签页（授权步骤沿用第一轮 §2.6 实测结论） |
| 8.2 | 同一视频学习两次（一次字幕、一次 ASR 均可） | 结束两次 | 两个 Session 各自归档、Web 倒序并列；进度仍单条覆盖（D9：逐字稿按 Session 累积，进度按 账号+Source） |
| 8.3 | 双账号 | 账号 B 检查账号 A 的视频 | 看不到任何 Session/逐字稿（404） |

- [ ] 归属复核：______

## 3. 第三轮占位（课程总结——票据进行中，落地后补步骤）

门槛条目（计划文档「集成门槛」表第三轮行 + spec #49 第三轮节）。**以下均为占位：对应实现票未落地，落地后在此补编号步骤与预期。**

- [ ] 未学完生成：课程未学完时在 Web 课程页主动点「生成总结」，成功后可看
- [ ] 引用回查：总结可回查原文与时间戳（原文、原来源）
- [ ] 再生成：补学后再次主动生成，覆盖新增材料（多次 Session 材料合并、来源与时间轴分别保留）
- [ ] 双课隔离：切换到另一门课，总结内容互不串
- [ ] 用量入口：用量由后端记录，Web 提供查询入口（计量/收费/账单实现仍 out of scope）

契约预留：D16–D18 将由第三轮契约票补入 [contracts/decisions.md](../contracts/decisions.md)；本节步骤待对应票落地后补全。

## 4. 已知限制与决策映射

契约级裁量完整记录在 [contracts/decisions.md](../contracts/decisions.md)（D1–D8 第一轮、D9–D15 第二轮），与实现一致：

- **D9 · Session 归档，进度不动**：逐字稿/音频/缺口挂 Session（多 Session 并存），进度仍是（账号， Source）单条——§2.8.2 按此验收。
- **D10 · 转写服务端化**：插件不再持有 Speech Provider 凭据、不直连转写；PoC 本地直连路径随 2.4 物理删除（options 的 Speech Provider 区块已移除）。key 只在服务端（`QWEN_API_KEY`），**待用户配置，dev/stub 先行**（§5.4 占位）。
- **D11 · 音频 = HTTP 约 30s 分段上传**：JSON + base64、幂等键 `(sessionId, segmentIndex)`、网络失败字节级重放（2s/8s/30s）；实时 WS 不做进二轮（PoC realtime 一并退役）。直播样本无定位、无 gaps 属预期（§2.4.3）。
- **D12 · 轮询 TranscriptView**：无推送通道。ASR 路径 4s 拍 + 失败退避封顶 30s；字幕路径 15s 慢拍；终态 stand-down 不复活。Web 回查用同一端点同一形态。
- **D13 · Worker pull 模型**：独立发布单元 0.1.0，claim 领取（音频 base64 内联 ≤10MB）、result 回写终态；API 无心跳/推送。**worker 串行并发（concurrency 1）+ 5s 空轮询**：吞吐上限人工可感，横向扩缩 = 多起 worker 进程（§2.7）。
- **D14 · 临时音频**：done 即删、failed 保留至 Session 结束 + 宽限期（宽限清理是 API 部署侧职责，未实现——failed 段音频目前会在 `LD_API_AUDIO_DIR` 留存）；上传先落库再入队，重发永不覆盖。
- **D15 · 字幕直归档 + 同区间单一路径**：字幕不全不补全；首次提交锁 origin、反向 409 `transcript_origin_conflict`（服务端第二道保险，插件决策面已在前置避免，人工验收不触发）；强制转写由客户端在归档前切路径（§2.5）；gaps 只收显式跳过。**演进（第二轮 review）**：`finished` 后 `pending` 不再承诺「必为空」——插件 `endActiveSession` 先 finish 后 drain（预算 15 拍），`pending` 随尾段渐进清空；worker 停机且无租约时可滞留，Web 详情页把滞留段标注为「转写排队中（会话已结束）」而非终态（§2.5 / §3.5）。
- **SPA 软导航不注入**（沿用第一轮 P10b 限制）：站内软导航进入播放页不触发内容脚本注入；从学习库打开原地址（新标签页全量加载）不受影响。
- **回跳尽力**（沿用第一轮 P12）：B 站 `t=`、YouTube `t=…s` 可带参定位；小鹅通、小红书仅展示时间戳（§2.6.3）。
- **小红书图文纯文本笔记**：图文无逐字稿路径（无媒体可采集），只有小红书**视频**走 ASR（§2.4.4）；图文笔记行为沿用第一轮。
- **YouTube PO-token 字幕轨**：需要 MAIN-world PO-token 授权的字幕轨未移植（2.6 明确不移植）——此类视频字幕不可读，走 ASR 回退（§2.2.3），属预期路径。
- **lease 机制未做**（2.3 头注释）：claimed-but-unfinished 任务（worker 在 transcribing 中崩溃/被停）不会被重新排队——任务停 transcribing、对应段保持「转写中」，直到租约机制落地（API 侧，后续票）。§2.7.5 按现状记录。
- **AI Provider key 待配置**：结束学习后的 AI 纪要 pass 沿用 PoC 本地 options 配置；未配置时纪要生成失败提示，不影响字幕/ASR 归档与回查。
- **详情页 busy 粒度**（第二轮 review 裁量）：慢 API 下 `openDetail` 持锁使详情页整体 busy（加载态覆盖整页），分区加载留后续票优化。

## 5. 发布记录模板

发布前逐项填写。统一发布条件（计划文档）：三轮验收全部通过 + 真实服务联调 + 四站浏览器验收形成发布记录。第一轮的样本登记（round1 §3.3）与 tabCapture 授权实测结论（round1 §3.5）继续沿用。

### 5.1 版本矩阵

| 发布单元 | 版本 | 备注 |
| --- | --- | --- |
| 浏览器插件 | 0.2.13 | 根 `manifest.json` / `package.json` / `tests/release.test.js` 三处同步；0.2.9 B 站字幕（2.5）→ 0.2.10 YouTube 字幕（2.6）→ 0.2.11 ASR 路径切换 + D10 退役（2.4）→ 0.2.12 强制转写（2.7）→ 0.2.13 二轮 review 修正（词汇统一 + transcript-shapes 共享模块） |
| Web 学习库 | 0.1.4 | `apps/web/package.json`；0.1.3 = 逐字稿回查（2.8）→ 0.1.4 = finished 后 pending 段标注排队而非「转写中」 |
| 后端 API | 0.1.4 | `apps/api/package.json`；0.1.2 = Session/字幕端点（2.2）→ 0.1.3 = 音频接收 + worker 端点（2.3）→ 0.1.4 = requireSession 去重 + 崩溃窗口自愈（重发补建任务）；对外代际 `/v1` 不变 |
| 录播转写 Worker | 0.1.0 | `apps/worker/package.json`；首个可运行版本（2.3）：pull 循环 + stub/qwen provider seam（二轮 review 仅修 run-once 头注释，无运行时行为变化，不 bump） |
| 契约 | v1 + v2 | `contracts/contract-v1.md`（D1–D8）+ `contracts/contract-r2.md`（D9–D15，即二轮契约面）；第三轮 D16–D18 由三轮契约票补 |

### 5.2 自动化结果（随分支更新）

| 套件 | 命令 | 结果 | 日期 |
| --- | --- | --- | --- |
| contracts | `node --test contracts/` | 43 pass / 0 fail | 2026-11-12（tip 4ff0023，r2 review fixes） |
| apps/api | `cd apps/api && npm test` | 159 pass / 0 fail | 同上 |
| apps/worker | `cd apps/worker && npm test` | 25 pass / 0 fail | 同上 |
| apps/web | `cd apps/web && npm test` | 118 pass / 0 fail | 同上 |
| 插件（根） | `npm test` | 695 pass / 0 fail | 同上 |
| 发布检查 | `npm run check` | passed（45 allowlist） | 同上 |

### 5.3 环境配置清单（部署/联调）

| 变量 | 单元 | 默认 | 说明 |
| --- | --- | --- | --- |
| `LD_API_WORKER_TOKEN` | API | 空 = fail closed | `/v1/worker/tasks/*` 服务凭据（timing-safe 比对）；与 Worker 侧 `LD_WORKER_TOKEN` 同值 |
| `LD_API_STATE_FILE` | API | `apps/api/data/state.json` | 内嵌存储文件 |
| `LD_API_INVITE_SEED` | API | `apps/api/data/invites.seed.json` | 受邀邮箱种子（启动前登记） |
| `LD_API_OUTBOX_FILE` | API | `apps/api/data/outbox.jsonl` | dev 邮件验证码 outbox |
| `LD_API_AUDIO_DIR` | API | `os.tmpdir()/ld-api-audio` | 临时音频目录（D14：done 即删；failed 段保留至 Session 结束 + 宽限，宽限清理未实现） |
| `LD_WORKER_API_BASE` | Worker | `http://127.0.0.1:8787` | API base |
| `LD_WORKER_TOKEN` | Worker | 必填 | worker 服务凭据（空则 claim 恒 401） |
| `LD_WORKER_PROVIDER` | Worker | `stub` | `stub` \| `qwen`；未知值启动即失败 |
| `LD_WORKER_POLL_INTERVAL_MS` | Worker | 5000 | 空轮询间隔（也是错误退避默认值） |
| `LD_WORKER_ERROR_BACKOFF_MS` | Worker | 同 poll interval | cycle 失败退避 |
| `LD_WORKER_QWEN_BASE_URL` | Worker | dashscope compatible-mode | qwen provider 端点 |
| `LD_WORKER_QWEN_MODEL` | Worker | `qwen3-asr-flash` | qwen 转写模型 |
| `QWEN_API_KEY` | Worker | 未配置 | **真实 ASR 必需，待用户配置**；`LD_WORKER_PROVIDER=qwen` 且无 key → 启动即失败（fail fast） |

插件侧：AI Provider key 在 options 页本地配置（沿用 PoC，仅影响 AI 纪要 pass）；Speech Provider 配置已随 D10 退役。

### 5.4 真实 ASR 链路联调（发布前要求，占位）

计划文档「发布前真实服务联调」：用一份授权课程跑至少一次**真实 ASR** 完整链路（`LD_WORKER_PROVIDER=qwen` + 真实 `QWEN_API_KEY`），连同四站浏览器验收和字幕路径一起形成发布记录。样本可复用 §2.3/§2.4 步骤，仅替换 provider。

- [ ] Speech Provider 与 key 来源：______（服务端 env，不再经插件分发——D10）
- [ ] 授权课程：______（可复用 round1 §3.3 样本）
- [ ] 联调日期与结果：______
- [ ] 段级延迟 / 失败率观察：______

### 5.5 二轮人工验收结果汇总

| 清单节 | 内容 | 结果 | 执行人 / 日期 |
| --- | --- | --- | --- |
| §2.1 | B 站字幕路径（全文 + 直归档 + 零 ASR） | ☐ 通过 ☐ 不通过 | |
| §2.2 | YouTube 字幕路径 | ☐ 通过 ☐ 不通过 | |
| §2.3 | B 站 / YouTube 无字幕 ASR 回退（分别实测） | ☐ 通过 ☐ 不通过 | |
| §2.4 | 小鹅通回放/直播 + 小红书 ASR | ☐ 通过 ☐ 不通过 | |
| §2.5 | 强制转写三分支 + 同区间单源 | ☐ 通过 ☐ 不通过 | |
| §2.6 | Web 逐字稿回查（origin / gaps / 回跳 / 隔离） | ☐ 通过 ☐ 不通过 | |
| §2.7 | Worker 独立性（pending 排队 → 恢复处理） | ☐ 通过 ☐ 不通过 | |
| §2.8 | 归属复核（标签页 / 来源 / 账号 / Session） | ☐ 通过 ☐ 不通过 | |
| §3 | 第三轮占位 | ☐ 未开始 | |

### 5.6 遗留项

- **真实 ASR 链路联调**（§5.4）：发布前要求，key 待用户配置。
- **failed 段音频宽限清理未实现**（D14 影响）：`LD_API_AUDIO_DIR` 里 failed 段音频在 Session 结束 + 宽限后不会被自动清扫；清理 sweeper 属 API 部署侧后续工作。
- **lease 机制未做**（§4）：claimed-but-unfinished 任务不重排；「转写中」段在 worker 停启后可能永久滞留，直至租约/重排票落地。
- **worker 逐任务日志缺失**：worker stdout 只有启动横幅与 cycle 失败行，成功领取/完成任务无逐行日志——§2.1 的零 ASR 断言依赖「无输出 + 无采集指示 + 无 pending」组合证据；逐任务日志可随真实 ASR 联调一并补。
- **整理/删除入口**（第一轮遗留延续）：重复收藏的整理入口仍无落点。
- **用量/账单**（第三轮）：用量入口随三轮落地；计量口径、价格、付款仍 out of scope。
- **D16–D18**：第三轮契约决策占位，由三轮契约票补入 decisions.md。
