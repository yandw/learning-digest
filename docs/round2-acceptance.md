# 第二/三轮联调验收清单与发布记录

对应 [#72](https://github.com/yandw/learning-digest/issues/72)（spec #49 第二轮）与 [#76](https://github.com/yandw/learning-digest/issues/76)（spec #49 第三轮）。第一轮清单见 [round1-acceptance.md](round1-acceptance.md)；本文档是二/三轮的统一验收入口与发布记录模板（历史清单只加指针不改内容），统一发布时两份清单一起走，发布记录模板以本文档 §5 为准（版本矩阵已含 apps/worker、契约 v2/v3 面与 AI Provider 配置）。

验收门槛原文见 [docs/productization-four-part-plan-v0.1.md](productization-four-part-plan-v0.1.md)「集成门槛」表。第二轮行：**验证字幕全文显示与直归档、ASR「转写中」提示与约 30 秒一段的结果展示、字幕不全时的整段强制转写。同一区间只采用一种方式。两类结果都能在 Web 回查，并验证选定标签页、来源、账号和 Session 归属。** 第三轮行：**用户在课程未学完时主动生成总结，成功后可回查原文和时间戳。补学后主动再次生成，覆盖新增内容，另一门课程的内容保持独立。** spec #49 第二轮相关节：字幕全文/约 30s 分段/转写中/强制转写/双路径同区间单源/Web 回查；第三轮相关节：未学完可生成/再生成/引用回查原文与时间戳/双课内容隔离/用量查询入口（计量收费 out of scope）；「Testing Decisions」：完整字幕路径验收零 ASR 调用、替代 AI Provider 使测试可重复。

- 可自动化的部分（契约样例、接口边界、三端回归）已在集成分支 `productization/integration` 全绿，见 §1。
- 需要真实环境的部分（四站字幕/ASR 样本、worker 停启）是 §2 的人工步骤清单；tabCapture 后台标签页授权实测沿用第一轮记录（[round1-acceptance.md](round1-acceptance.md) §2.6 / §3.5）。
- 第三轮（课程总结与用量）人工步骤在 §3：默认 stub AI Provider 即可走通；真实 qwen provider 联调是 §5.5 占位（`LD_AI_API_KEY` 配置后）。
- 已知限制与契约决策（D9–D15 第二轮、D16–D18 第三轮）映射见 §4，细节在 [contracts/decisions.md](../contracts/decisions.md)。
- §5 是发布记录模板（版本矩阵 / env 配置 / 真实 ASR 与真实 AI 总结链路联调占位）。

使用方式：逐项勾选。自动化项只需在合入时重跑一次；人工项按编号步骤走，把观察结果记到 §5.6 的汇总表。

## 1. 自动化验收（本分支已绿）

实测分支 tip：第四轮 ticket 4.6（#82）服务层切换后（apps/api、apps/worker 仅保留 Python 实现，命令为 pytest/uv），日期 2026-11-13，全部通过，合计 **1145 pass / 0 fail**：

- [x] **契约** — `node --test contracts/` → **52 pass / 0 fail**
  v1 全量（32 项）+ contract-r2（Session/Transcript/音频任务 fixture、error-examples 二轮 10 例、D9–D15 形态断言）之上叠加 contract-r3：Summary/Citation/Usage fixture（`summary-examples.json` 两次生成故事：未学完时首次生成 → 补学 Session `ses_01JABC0034` 归档后再生成 → 列表/详情/另一门资料空列表独立计数 → usage 口径样例）、error-examples 三轮 7 例（409 `no_transcript_to_summarize`、502 `summary_generation_failed`、生成/列表/详情/用量 401/404）、D16–D18 形态全量断言。
- [x] **API 边界** — `cd apps/api && uv run pytest tests/ -q` → **214 pass / 0 fail**（Python/FastAPI 实现，4.6 起为唯一服务层实现）
  一/二轮全量回归之外，三轮新增：AI Provider seam（stub 确定性、qwen 无 key 启动即抛 fail closed、未知 provider fail fast）、POST 同步生成（聚合全部 Sessions records/gaps + notes → 外移 prompt 组装 → 生成 → **引用清洗**：sessionId 归属/区间精确命中/quote 逐字摘句逐条对账，不合规丢弃，全无效 citations=[] 仍落正文）、GET 列表（倒序 + citationCount，seq tie-break 防同毫秒乱序）与详情、409 不发起 AI 调用、502 不落库不计数（失败不落脏数据）、用量口径（audioSeconds 段首次 done 累加且重放不重复、静音段计入、失败/转写中不计；summaryCount/summaryInputChars 落库时记；全新账号 `updatedAt=null`）、uvicorn keep-alive 抬到 max(10s, aiTimeoutMs+5s)。
- [x] **Worker** — `cd apps/worker && uv run pytest tests/ -q` → **28 pass / 0 fail**（Python 实现，4.6 起为唯一服务层实现）
  pull 主循环（串行 + 空轮询退避）、stub/qwen provider seam、静音段 = done 空 records、回写重放与终态、config fail fast（qwen 无 key 启动即失败）；含 loopback 真链路用例（真 client + 真 API 子进程）。4.6 切换零行为变化，零回归。
- [x] **Web 逻辑** — `cd apps/web && npm test` → **156 pass / 0 fail**
  二轮逐字稿区块全量回归之外，三轮新增：markdown.js 安全渲染（解析为纯文本 view model、`createElement`+`textContent` 建 DOM、**从不产出 HTML 字符串、零 innerHTML 路径**，注入测试钉住；支持面刻意最小——标题/列表/粗体/段落，其余字面降级）、生成总结（飞行期「生成中…」禁用 + 防抖、409/502 契约文案逐字透传、跨资源导航守卫）、历史 pills（倒序 + citationCount、按需拉取缓存）、引用块（quote 文本节点 + 区间 stamp + Session 归属，回跳复用 SEEK_PARAM_BUILDERS，不可回跳仅展示）、用量面板（`updatedAt=null` → 「从未产生用量」，无价格措辞）。
- [x] **插件纯模块与接线** — `npm test`（根，`node --test tests/*.test.js`）→ **695 pass / 0 fail**
  bilibili/youtube 字幕 reader、session-archive 契约客户端、transcript-pipeline、强制转写决策流、anchor/seek/hole-fill 全量回归。三轮无行为变化（课程总结只在 Web/API，插件零感知，D16），零回归。
- [x] `npm run check` → Release checks passed（45 allowlist 文件）。

## 2. 人工验收步骤（第二轮）

### 2.0 环境准备（一次）

第一轮环境照旧（API/Web 启动、邀请邮箱登记、验证码 outbox、扩展加载——见 [round1-acceptance.md](round1-acceptance.md) §2.0）。第二轮新增：

1. [ ] 扩展卡片显示版本 **0.2.13**；API/Web/Worker 均为集成分支 tip
2. [ ] **API 启动前**设置 worker 服务凭据（默认空 = fail closed，任何 worker 都领不到任务）并重启：

   ```bash
   cd apps/api && LD_API_WORKER_TOKEN=<随机串> uv run python -m app.main
   ```

3. [ ] 启动 Worker（第三个终端，token 与 API 侧同值）：

   ```bash
   cd apps/worker && LD_WORKER_TOKEN=<同 LD_API_WORKER_TOKEN> uv run python -m worker.main
   # [worker] provider=stub api=http://127.0.0.1:8787 poll=5000ms
   ```

   默认 **stub provider**（确定性样例文本）即可完成 §2.3–§2.5、§2.7 与 §3 的链路验收；真实语音转写见 §5.4（`LD_WORKER_PROVIDER=qwen` + `QWEN_API_KEY`，待用户配置）。插件 options 的 AI Provider key 沿用 PoC 配置，只影响结束学习时的 AI 纪要 pass，不影响逐字稿归档与课程总结（课程总结的 AI Provider 在 API 侧，D16）。
4. [ ] 样本登记（可复用第一轮 §3.3 的四站样本，逐项补字幕/ASR 属性）：
   - B 站**有字幕**视频一（CC 或 AI 轨均可，CC 优先）＋ B 站**无字幕**视频一
   - YouTube **有字幕**视频一 ＋ YouTube **无字幕**视频一
   - 小鹅通回放一（直播可选）＋ 小红书视频一
5. [ ] 验证码与第一轮同（dev mailer：API stdout + `apps/api/data/outbox.jsonl`）
6. [ ] 第三轮样本（§3 用）：课程 A = 一门**学一段能归档逐字稿**的资料（B 站/YouTube 视频，或小鹅通/小红书视频走 ASR）；课程 B = 一门**只收藏不学习**的资料（普通网页，或不学习的视频）

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

## 3. 人工验收步骤（第三轮：课程总结与用量）

门槛：未学完生成 / 引用回查原文与时间戳 / 补学再生成覆盖新增内容 / 另一门课内容独立 / 用量查询入口。契约面见 [contracts/contract-r3.md](../contracts/contract-r3.md)（D16–D18）；课程总结只在 Web/API，插件零感知（D16）。默认 **stub AI Provider**（确定性输出，同输入同总结）即可走通本节全部步骤；真实 qwen 联调见 §5.5。

### 3.0 环境准备（一次）

1. [ ] 版本核对：扩展卡片 **0.2.13**、Web **0.1.5**、API **0.2.0**、Worker **0.2.0**（4.6 切换：API/Worker 实现重写为 Python 唯一服务层实现，契约代际 `/v1` 不变；版本矩阵见 §5.1）
2. [ ] API/Web/worker 照 §2.0 启动；AI Provider 不需额外配置——API 默认 `LD_AI_PROVIDER` 空 = 确定性 stub（`LD_AI_API_KEY` 只在走真实 qwen 时需要，见 §5.3 / §5.5）
3. [ ] §2.0 第 6 条的两门课样本已登记：课程 A（可学习、有逐字稿）与课程 B（只收藏不学习）
4. [ ] 双账号配置沿用第一轮（round1 §2.0 第 2 条：两个邮箱、两个 Chrome profile）

### 3.1 两门课准备（A 有逐字稿 / B 无逐字稿）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 1.1 | 受邀账号已登录 Web（round1 §2.1） | 学习库里收藏课程 A 与课程 B（两门不同平台，或其中一门是普通网页） | 列表两条独立资料，平台徽标各自正确（D5：收藏即一条 Resource + Source） |
| 1.2 | 课程 A 的标签页 | 插件面板「开始学习」→ 学习/播放一段（字幕或 ASR 路径均可，以 §2.1–§2.4 的实测结论为准）→「结束学习」 | Session 归档；Web 详情页课程 A「逐字稿」区出现该 Session 的记录（origin 徽标为「字幕」或「语音转写」）；课程 B 全程不学习，详情页无 Session |
| 1.3 | 1.2 完成 | 两门课详情页的「课程总结」区 | 都显示空态「还没有课程总结；点击「生成总结」生成第一份。」；B 从未产生逐字稿（为 §3.4 的 409 做准备） |

- [ ] 两门课准备：______

### 3.2 未学完生成 + 引用回查（门槛：未学完可生成 / 回查原文与时间戳）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 2.1 | 课程 A 只学了部分（进度未满、Session 已结束；Session 进行中同样可生成——active 与 finished 都计入生成范围，D17） | 课程 A 详情页点「**生成总结**」 | 按钮立即变「**生成中…**」并禁用（同步生成在 POST 内完成，飞行期可见；stub 数秒内返回，真实 provider 可达数十秒且不假超时，状态只由 201/失败回落） |
| 2.2 | 2.1 完成 | 观察总结区 | 201 落库：历史 pills 出现「第 1 次 · <时间> · N 条引用」并默认聚焦最新；meta 行「生成于 <时间> · N 条引用」；正文按 Markdown 渲染（标题/列表/粗体），无 HTML 注入面 |
| 2.3 | 2.2 完成 | 检查「**原文引用**」块 | 每条引用 = 「quote 逐字摘句」（文本节点）+ 区间 stamp + 「来自 <学习时间> 的学习」Session 归属 + origin 徽标；B 站/YouTube 的 stamp 是**回跳按钮**，点击新标签页打开原平台对应时间点（`t=` / `t=…s`，保留 `p=` 分集）；小鹅通/小红书仅展示时间戳 |
| 2.4 | 2.3 完成 | 引用与详情页逐字稿对照 | 引用所指文本能在详情页逐字稿的对应 Session 记录里逐字找到、区间对得上（引用清洗保证：对不上真实归档记录的引用落库前已丢弃，不落死链，D17） |

- [ ] 未学完生成 + 引用回查：______

### 3.3 补学后再生成（门槛：补学后主动再次生成，覆盖新增内容）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 3.1 | §3.2 完成 | 课程 A 再学一段（新 Session，覆盖此前未学的范围）→「结束学习」 | 详情页「逐字稿」区新增该 Session（倒序并列，D9） |
| 3.2 | 3.1 完成 | 再点「生成总结」 | 生成成功；历史 pills 变**两条**，倒序（第 2 次在前，同毫秒双击也不乱序）；默认显示最新一次 |
| 3.3 | 3.2 完成 | 对照新旧两次总结 | 新总结**覆盖补学新增材料**：引用含新 Session 的记录（「来自 …」归属能看到新学习时间，引用可跨 Session 指回各自记录，D17）；点旧 pill 可回查第 1 次总结，内容不变（历次生成全部保留，POST 每次生成 = 新记录，契约幂等例外） |
| 3.4 | （可选）补学期间写一条时间戳笔记 | 再生成一次 | notes 进生成输入（D17），总结可体现；历史变三条 |

- [ ] 补学再生成：______

### 3.4 无逐字稿课程 B → 409（契约负路径）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 4.1 | 课程 B 从未学习（无任何归档逐字稿；只有笔记或纯收藏同样算无文本） | 课程 B 详情页点「生成总结」 | **409 `no_transcript_to_summarize`**，错误文案与契约样例逐字一致：「这门资料还没有可总结的逐字稿，先学习并归档后再生成」；总结区不变，历史仍空（服务端**不发起 AI 调用**） |
| 4.2 | 4.1 完成 | 账号「用量」面板 | 总结次数与输入字符不变（409 不落库不计数，D18） |

- [ ] 无逐字稿 409：______

### 3.5 双课隔离 + 双账号隔离（门槛：另一门课的内容保持独立）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 5.1 | 课程 A 已有总结；课程 B 也学一段并生成自己的总结 | 对照 A/B 两个详情页的总结与引用 | 两门课引用只指向**各自**资料的 Session 记录，互不引用对方材料；A/B 历史计数独立（fixture `api-summaries-list-empty` 钉住「另一门资料独立计数」） |
| 5.2 | （若课程 B 保持无逐字稿） | 课程 A 有总结 + 课程 B 空列表 | B 的空列表即隔离的边界情形：普通网页无逐字稿、从未生成，A 的内容不泄漏到 B |
| 5.3 | 双账号配置（round1 §2.8） | 账号 B 打开账号 A 的课程 A（含带 resourceId 直访 / 打开账号 A 的某条总结 id） | 404（不透露存在性，D2）；总结与资料/笔记/逐字稿一样按账号隔离 |
| 5.4 | 账号 B 登录自己的资料 | 账号 B 打开「用量」 | 账号 B 的用量独立计数，与账号 A 互不影响（用量是账号级累计，D18） |

- [ ] 双课/双账号隔离：______

### 3.6 用量面板（门槛：用量入口；D18 口径对账）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 6.1 | 本账号产生过 done 音频段（ASR 学习）与 ≥1 次成功生成 | 账号区点「用量」展开面板 | 显示「累计用量：转写 X 秒 · 总结 N 次 · 输入 M 字符 · 更于 <时间>」；面板无价格/账单/付款措辞（D18 只记录不计费） |
| 6.2 | 6.1 完成 | 逐项对账实际值 | 转写 X = 已 done 音频段时长（`endMs − startMs`）毫秒总和 ÷ 1000 **向下取整**（静音段计入；失败/转写中段不计；同段重放不重复计）；总结 N = 成功生成次数（409/502 尝试不计）；输入 M = 历次 `generation.inputChars` 之和（每次生成详情的输入规模，prompt 全文码点数） |
| 6.3 | 全新账号（或本账号产生任何用量之前） | 打开「用量」 | 显示「**从未产生用量**」（契约 `updatedAt=null` 形态），不显示一排零 |
| 6.4 | （可选）人工制造一次失败尝试后再看 | 在 §5.5 真实 provider 下指向不可达端点点「生成总结」 | 502 `summary_generation_failed` 文案（「总结生成失败，请稍后重试；本次尝试不产生总结记录」）；列表无新条目、用量不变（失败不落脏数据，D16） |

- [ ] 用量面板对账：______

## 4. 已知限制与决策映射

契约级裁量完整记录在 [contracts/decisions.md](../contracts/decisions.md)（D1–D8 第一轮、D9–D15 第二轮、D16–D18 第三轮），与实现一致：

### 4.1 第二轮（D9–D15）

- **D9 · Session 归档，进度不动**：逐字稿/音频/缺口挂 Session（多 Session 并存），进度仍是（账号， Source）单条——§2.8.2 按此验收。
- **D10 · 转写服务端化**：插件不再持有 Speech Provider 凭据、不直连转写；PoC 本地直连路径随 2.4 物理删除（options 的 Speech Provider 区块已移除）。key 只在服务端（`QWEN_API_KEY`），**待用户配置，dev/stub 先行**（§5.4 占位）。
- **D11 · 音频 = HTTP 约 30s 分段上传**：JSON + base64、幂等键 `(sessionId, segmentIndex)`、网络失败字节级重放（2s/8s/30s）；实时 WS 不做进二轮（PoC realtime 一并退役）。直播样本无定位、无 gaps 属预期（§2.4.3）。
- **D12 · 轮询 TranscriptView**：无推送通道。ASR 路径 4s 拍 + 失败退避封顶 30s；字幕路径 15s 慢拍；终态 stand-down 不复活。Web 回查用同一端点同一形态。
- **D13 · Worker pull 模型**：独立发布单元 0.1.0，claim 领取（音频 base64 内联 ≤10MB）、result 回写终态；API 无心跳/推送。**worker 串行并发（concurrency 1）+ 5s 空轮询**：吞吐上限人工可感，横向扩缩 = 多起 worker 进程（§2.7）。
- **D14 · 临时音频**：done 即删、failed 保留至 Session 结束 + 宽限期（宽限清理是 API 部署侧职责，未实现——failed 段音频目前会在 `LD_API_AUDIO_DIR` 留存）；上传先落库再入队，重发永不覆盖。
- **D15 · 字幕直归档 + 同区间单一路径**：字幕不全不补全；首次提交锁 origin、反向 409 `transcript_origin_conflict`（服务端第二道保险，插件决策面已在前置避免，人工验收不触发）；强制转写由客户端在归档前切路径（§2.5）；gaps 只收显式跳过。**演进（第二轮 review）**：`finished` 后 `pending` 不再承诺「必为空」——插件 `endActiveSession` 先 finish 后 drain（预算 15 拍），`pending` 随尾段渐进清空；worker 停机且无租约时可滞留，Web 详情页把滞留段标注为「转写排队中（会话已结束）」而非终态（§2.5 / §3.5）。

### 4.2 第三轮（D16–D18）

- **D16 · 课程总结服务端生成，AI Provider 凭据收归 API**：生成只发生在服务端（聚合材料 → 调 AI Provider → 落库 → 201 同一请求）；插件与 Web 无任何 Provider 感知（与 worker 的 Speech Provider seam 并列独立——转写输入是音频字节所以归 Worker，总结输入是已落库结构化材料所以归 API；key `LD_AI_API_KEY` 与 Worker 的 `QWEN_API_KEY` 分属两个 seam，凭据/生命周期互不相干）。provider/model 只以不透明字符串出现在 Summary 的 `generation` 元数据。默认部署 qwen（产品路径），测试/裸启动注入 stub。
- **同步生成数十秒**：总结无渐进产出、不设轮询面（与 D12 的逐字稿轮询不同构）；真实 provider 下 POST 可长时间挂起（`LD_AI_TIMEOUT_MS` 默认 120s，API `server.timeout` 随之抬到 max(10s, aiTimeoutMs+5s)），Web 侧「生成中…」禁用等待、**不假超时**——状态只由 201/失败回落。异步化（任务下发 Worker）是 D16 预留演进，端点形态不因此改变。
- **失败不落脏数据**：AI Provider 调用失败/超时/不可解析 → 502 `summary_generation_failed`，**不产生 Summary 记录、列表与用量都不出现本次尝试**；重试 = 用户再次发起。对比逐字稿的 `failed[]`：那是段级进行时状态（音频已入库、失败可排查），总结是原子产物——要么完整存在，要么不存在（§3.6.4 按此验收）。409 `no_transcript_to_summarize` 同样不发起 AI 调用、不计数。
- **D17 · 生成输入与引用清洗**：生成范围 = 该 Resource **当前全部已归档材料**（全部 Sessions 的 records 全文 + gaps 跳过标记 + notes；active 与 finished 都计入；pending/failed/静音段不进输入），不接受客户端裁剪；prompt 外移 [prompts/course-summary.md](../prompts/course-summary.md)（D4 先例，代码只做变量填充）。**引用清洗丢弃策略**：模型返回的 citations 落库前逐条对账——sessionId 归属该 Resource、区间精确命中该 Session 的真实归档记录、quote 是记录文本的逐字摘句，对不上的引用**丢弃不落死链**（宁可少引用）；全部无效时 `citations=[]` 仍落正文。补学后再生成自然覆盖新增材料（聚合范围随归档增长）。
- **多 Source 聚合**：一个 Resource 挂多个 Source（分集/直播回放，D5 的 1:N）时，聚合按裸毫秒合并排序、不同 Source 的行互相穿插，模型输入只见 sessionId 不见 Source 身份；回查仍正确（sessionId→sourceId 服务端可解析），按 Source 分节聚合留作后续演进（decisions.md D17「多 Source 资料后果」）；当前验收样本以单 Source 为主。
- **D18 · 用量只记录不计费**：无价格、账单、付款与配额执行（#49 Out of Scope）；账号级累计、无时间窗与资源维度参数。`audioSeconds` 在音频段**首次 done 时**累加（静音段计入、失败/转写中不计、回写首存为准天然防重复）；`summaryCount`/`summaryInputChars` 在总结**成功落库时**记录；用量单调递增、契约无扣减路径。**全新账号 usage null**：从未产生用量时 `updatedAt=null`，Web 显示「从未产生用量」而非一排零（§3.6.3）。
- **Markdown 渲染支持面刻意最小**（第三轮 review 裁量）：支持标题/列表/粗体/段落，其余 Markdown 语法字面降级展示；渲染路径**从不产出 HTML 字符串**（解析为纯文本 view model、`createElement`+`textContent` 建 DOM、零 innerHTML），quote 等用户可控文本只落文本节点——注入面在测试里钉住。
- **worker lease 未做（沿用第二轮现状）**：claimed-but-unfinished 任务不会被重新排队（§2.7.5）；第三轮只读消费归档产物、不改变逐字稿管线语义，租约/重排仍属后续票。
- **真实 AI key 待配置**：总结生成的真实 qwen 联调是 §5.5 占位（`LD_AI_API_KEY` 配置后执行）；未配置时默认 stub，功能可验收但总结正文是确定性样例文本、引用清洗按契约照常工作。
- 二轮其余限制（SPA 软导航不注入、回跳尽力、小红书图文纯文本、YouTube PO-token 字幕轨、AI 纪要 pass 的 PoC options key、详情页 busy 粒度）不变，见上节与 [contracts/decisions.md](../contracts/decisions.md)。

## 5. 发布记录模板

发布前逐项填写。统一发布条件（计划文档）：三轮验收全部通过 + 真实服务联调 + 四站浏览器验收形成发布记录。第一轮的样本登记（round1 §3.3）与 tabCapture 授权实测结论（round1 §3.5）继续沿用。

### 5.1 版本矩阵

| 发布单元 | 版本 | 备注 |
| --- | --- | --- |
| 浏览器插件 | 0.2.13 | 根 `manifest.json` / `package.json` / `tests/release.test.js` 三处同步；0.2.9 B 站字幕（2.5）→ 0.2.10 YouTube 字幕（2.6）→ 0.2.11 ASR 路径切换 + D10 退役（2.4）→ 0.2.12 强制转写（2.7）→ 0.2.13 二轮 review 修正（词汇统一 + transcript-shapes 共享模块）。**第三轮零行为变化（课程总结只在 Web/API，D16），零 bump** |
| Web 学习库 | 0.1.5 | `apps/web/package.json`；0.1.3 = 逐字稿回查（2.8）→ 0.1.4 = finished 后 pending 段标注排队 → **0.1.5 = 课程总结生成/历史/引用回跳 + 安全 Markdown 渲染（markdown.js，零 innerHTML）+ 用量入口（§3）** |
| 后端 API | 0.2.0 | `apps/api/pyproject.toml`（4.6 切换后即权威元数据）；0.1.2 = Session/字幕端点（2.2）→ 0.1.3 = 音频接收 + worker 端点（2.3）→ 0.1.4 = requireSession 去重 + 崩溃窗口自愈 → 0.1.5 = AI Provider seam（stub/qwen）+ 总结端点（同步生成 + 引用清洗）+ 用量端点（§3）→ 0.1.6 = 三轮 review 修正（qwen 超时信号按 generate 调用新建 + 系统提示补 [sourceId 位置] 标记说明）→ **0.2.0 = 4.6 切换：Python/FastAPI 实现重写为唯一服务层实现（Node 版删除）；对外代际 `/v1` 不变** |
| 录播转写 Worker | 0.2.0 | `apps/worker/pyproject.toml`（4.6 切换后即权威元数据）；0.1.0 = 首个可运行版本（2.3）：pull 循环 + stub/qwen provider seam → **0.2.0 = 4.6 切换：Python 实现重写为唯一服务层实现（Node 版删除）** |
| 契约 | v1 + v2 + v3 | `contracts/contract-v1.md`（D1–D8）+ `contracts/contract-r2.md`（D9–D15）+ **`contracts/contract-r3.md`（D16–D18，三轮契约面：Summary/Citation/generation/Usage + 4 端点 + 409/502，已落地）**；prompt 外移 [prompts/course-summary.md](../prompts/course-summary.md)（D17） |

### 5.2 自动化结果（随分支更新）

| 套件 | 命令 | 结果 | 日期 |
| --- | --- | --- | --- |
| contracts | `node --test contracts/` | 52 pass / 0 fail | 2026-11-13（第四轮 4.6 服务层切换后；合计 1145 pass / 0 fail） |
| apps/api | `cd apps/api && uv run pytest tests/ -q` | 214 pass / 0 fail | 同上 |
| apps/worker | `cd apps/worker && uv run pytest tests/ -q` | 28 pass / 0 fail | 同上 |
| apps/web | `cd apps/web && npm test` | 156 pass / 0 fail | 同上 |
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
| `LD_AI_PROVIDER` | API | 空 = `stub` | 课程总结 AI Provider（D16）：`stub`（确定性样例文本）\| `qwen`（Bailian compatible-mode，产品路径）；未知值启动即失败 |
| `LD_AI_API_KEY` | API | 未配置 | **真实总结生成必需（qwen），待用户配置**；`LD_AI_PROVIDER=qwen` 且无 key → 启动即抛（fail closed）。与 Worker 的 `QWEN_API_KEY` 分属两个 seam（不同凭据与生命周期，D16），不可混用 |
| `LD_AI_MODEL` | API | `qwen3.8-flash` | qwen 模型覆盖（一个模型在配置后，三轮产品决策） |
| `LD_AI_BASE_URL` | API | Bailian compatible-mode | qwen 端点覆盖 |
| `LD_AI_TIMEOUT_MS` | API | 120000 | 单次生成 fetch 超时；API `server.timeout` 随之抬到 max(10s, aiTimeoutMs+5s)（同步生成期间 socket 空闲等待 AI，固定 10s 会让真实调用必然断连） |
| `LD_WORKER_API_BASE` | Worker | `http://127.0.0.1:8787` | API base |
| `LD_WORKER_TOKEN` | Worker | 必填 | worker 服务凭据（空则 claim 恒 401） |
| `LD_WORKER_PROVIDER` | Worker | `stub` | `stub` \| `qwen`；未知值启动即失败 |
| `LD_WORKER_POLL_INTERVAL_MS` | Worker | 5000 | 空轮询间隔（也是错误退避默认值） |
| `LD_WORKER_ERROR_BACKOFF_MS` | Worker | 同 poll interval | cycle 失败退避 |
| `LD_WORKER_QWEN_BASE_URL` | Worker | dashscope compatible-mode | qwen provider 端点 |
| `LD_WORKER_QWEN_MODEL` | Worker | `qwen3-asr-flash` | qwen 转写模型 |
| `QWEN_API_KEY` | Worker | 未配置 | **真实 ASR 必需，待用户配置**；`LD_WORKER_PROVIDER=qwen` 且无 key → 启动即失败（fail fast） |

插件侧：AI Provider key 在 options 页本地配置（沿用 PoC，仅影响结束学习时的 AI 纪要 pass，**不影响课程总结**——总结的 AI Provider 在 API 侧，D16）；Speech Provider 配置已随 D10 退役。

### 5.4 真实 ASR 链路联调（发布前要求，占位）

计划文档「发布前真实服务联调」：用一份授权课程跑至少一次**真实 ASR** 完整链路（`LD_WORKER_PROVIDER=qwen` + 真实 `QWEN_API_KEY`），连同四站浏览器验收和字幕路径一起形成发布记录。样本可复用 §2.3/§2.4 步骤，仅替换 provider。

- [ ] Speech Provider 与 key 来源：______（服务端 env，不再经插件分发——D10）
- [ ] 授权课程：______（可复用 round1 §3.3 样本）
- [ ] 联调日期与结果：______
- [ ] 段级延迟 / 失败率观察：______

### 5.5 真实 AI 总结链路联调（发布前要求，占位）

同上「发布前真实服务联调」：配置 `LD_AI_PROVIDER=qwen` + 真实 `LD_AI_API_KEY` 后，把 §3 的课程总结链路在真实 provider 上再走一遍（§3 步骤不变，仅替换 provider；联调同时覆盖真实输出规模下的用量对账）。

- [ ] AI Provider 与 key 来源：______（服务端 env，不经插件/Web 分发——D16；与 Worker 的 ASR key 互相独立）
- [ ] 联调样本：______（复用 §3.1 课程 A，已有归档逐字稿；真实 provider 下「生成中…」为数十秒量级属预期）
- [ ] 联调日期与结果：______
- [ ] 观察项：`generation.provider/model` 元数据 = `qwen` / 实际模型；真实输出上的引用清洗行为（对不上真实归档的引用被丢弃，不落死链）；502 失败路径演示（如临时指向不可达端点 → 502 文案、列表与用量均不出现本次尝试，D16 不落脏数据）；用量 `summaryInputChars` 与真实 prompt 规模对账
- [ ] 生成延迟 / 失败率观察：______

### 5.6 二/三轮人工验收结果汇总

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
| §3.1 | 两门课准备（A 有逐字稿 / B 无逐字稿） | ☐ 通过 ☐ 不通过 | |
| §3.2 | 未学完生成 + 引用回查（生成中 / 引用块 / 回跳） | ☐ 通过 ☐ 不通过 | |
| §3.3 | 补学后再生成（历史两条 + 覆盖新增材料） | ☐ 通过 ☐ 不通过 | |
| §3.4 | 无逐字稿 409（no_transcript_to_summarize） | ☐ 通过 ☐ 不通过 | |
| §3.5 | 双课隔离 + 双账号隔离 | ☐ 通过 ☐ 不通过 | |
| §3.6 | 用量面板口径对账（含全新账号 null 形态） | ☐ 通过 ☐ 不通过 | |
| §5.5 | 真实 qwen 总结链路联调 | ☐ 占位（key 配置后） | |

### 5.7 遗留项

- **真实 ASR 链路联调**（§5.4）：发布前要求，key 待用户配置。
- **真实 AI 总结链路联调**（§5.5）：发布前要求，`LD_AI_API_KEY` 待用户配置；当前默认 stub（确定性样例文本），功能与口径已按契约验收。
- **failed 段音频宽限清理未实现**（D14 影响）：`LD_API_AUDIO_DIR` 里 failed 段音频在 Session 结束 + 宽限后不会被自动清扫；清理 sweeper 属 API 部署侧后续工作。
- **lease 机制未做**（§4）：claimed-but-unfinished 任务不重排；「转写中」段在 worker 停启后可能永久滞留，直至租约/重排票落地。第三轮不改此现状。
- **worker 逐任务日志缺失**：worker stdout 只有启动横幅与 cycle 失败行，成功领取/完成任务无逐行日志——§2.1 的零 ASR 断言依赖「无输出 + 无采集指示 + 无 pending」组合证据；逐任务日志可随真实 ASR 联调一并补。
- **整理/删除入口**（第一轮遗留延续）：重复收藏的整理入口仍无落点。
- **计量/收费/账单 out of scope**（第三轮）：用量入口已随三轮落地（§3.6），但计量口径扩展、价格、付款、配额执行仍 out of scope（D18）——后续计费口径若需要维度扩展，加端点或参数，不改本形态。
- **Markdown 渲染支持面最小**（第三轮 review 裁量）：标题/列表/粗体/段落之外的字面降级；渲染从不产出 HTML（§4.2），扩展渲染面属后续增强，不阻塞发布。
