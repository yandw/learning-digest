# Learning Digest P0 发布验收 Checklist

> 用途：正式发布前的真实环境验收。按阶段 0 → 6 顺序执行；全部 P0 项通过后，才能给出 GO 结论。
>
> 关联文档：[第一轮验收](round1-acceptance.md)、[第二／三／六轮验收](round2-acceptance.md)、[产品化计划](productization-four-part-plan-v0.1.md)。

## 使用方式

- 未完成使用 `[ ]`；完成后改为 `[x]`。失败或受阻时保持 `[ ]`，并在“结果／证据”中写明问题和关联 issue。
- 每个阶段结束后填写执行人、日期、结论和证据位置。证据可以是验收文档行号、截图、日志或测试结果，不要把密钥写入本文或证据文件。
- 真实 ASR／AI 验收不能使用 stub 结果代替。自动化测试全绿是前提，不等于真实环境验收通过。
- 建议按“不依赖密钥的阶段 0–2、5 → 依赖真实密钥的阶段 3–4 → 最终回归”推进。
- 本清单中的命令均在仓库根目录执行，除非步骤另有说明。

## 验收总览

| 阶段 | 内容 | 执行人 | 完成日期 | 结论（GO／NO-GO） | 结果／证据 |
| --- | --- | --- | --- | --- | --- |
| 0 | 环境、版本、账号与样本准备 | Kimi | 2026-11-16／17 | NO-GO | 版本固定且 dev.sh 状态修复后三单元均显示 RUNNING；ASR／AI 已切换真实 Qwen 并联调通过（2026-11-17）；仍缺账号 B／双 Profile 及多项必填样本 |
| 1 | 账号、收藏、续学、笔记与隔离 | Kimi | 2026-11-16／18／19 | NO-GO | 11-18：1.1(API)／1.2／1.3／1.7／1.8 通过；11-19：1.4 全链路通过（隔离 Edge 字幕路径：收藏/开课/进度/回拖暂停/续学 seek/时间戳笔记 t=212s/Web 回查），1.3 bug b 活体复验通过（P3→P4 硬导航收藏拿到 P4 标题），1.6 前半实测（未调用指引文案复现）；bug a 软切换活体复验**通过**（11-19 窗口 203 真实 Chrome，ASR 路径软切换 → 服务端即时 finished，见 1.3 记录）；1.5 部分通过（WEB-01 普通网页收藏/纯文本笔记/无错误回跳 ✓；小红书四项待站点登录态）；1.1 授权引导缺陷（pendingLinkTabs 随 MV3 worker 重启丢失）owner 拍板为产品缺陷并已修复（扩展 0.2.36，session 持久化+恢复，装置按缺陷时间线活体验证通过、面板闭环跳选择页，见 1.1 记录），维持 NO-GO（余：双向踢出与引导 happy path 窗口 203 复验） |
| 2 | B 站／YouTube 字幕路径 | Kimi | 2026-11-16 | NO-GO | B 站真实原生字幕轨读取成功（328 条）；完整直归档、Web 回查和零 ASR 尚无本次 Session 证据，YouTube 完整链路未复验 |
| 3 | 真实 ASR、Worker 停启与强制转写 | Kimi | 2026-11-16／17／18 | GO（含已知限制） | 2026-11-17 真实 Qwen ASR（qwen3-asr-flash）端到端联调通过（直连 3/3、端到端 1/1，详见 6.3）；2026-11-18 用真正的 Learning Digest 扩展实测：3.1 BILI-03 无字幕视频 ASR 回退通过（30s 分段、零伪造文本、自动收尾）、3.4 XHS-01 小红书 8/8 段通过（gap 快进、Web 回查一致）、3.5 Worker 停启恢复通过（停机 4 分钟排队零误报、重启按 segmentIndex 顺序恢复、幂等无重复、插件与 Web 一致）、3.7 失败段保留通过（seg 21 ASR 超时样本：音频保留、错误落库、无伪造文本）；强制转写三分支经 owner 决定跳过（BILI-04 样本难寻，同 YT-03 记为已知平台限制）；保留限制：claim 后停 Worker 无租约自动恢复、失败段宽限期清理未实现，需写入发布说明 |
| 4 | 真实 AI 总结、面板 AI 与用量 | Kimi | 2026-11-16／17／19 | NO-GO | 2026-11-17 真实 AI 总结联调通过（qwen3.8-flash，201／9.32s，引用可回查，详见 6.3）；同日修复生成总结 502 三连，长视频真实生成 201／34.65s 通过（详见 6.4）；11-19 API 级推进：4.3 空输入 409+用量不增+跨账号 404、4.4 滚动摘要真实生成（12596 字符，幂等回放不计费）+从未生成 404、4.5 纪要五部分真实生成+整节覆盖语义+explain 400；剩余：4.1/4.2 真实总结生成与引用回查、面板 AI 与概览一致性（需面板 UI）、4.6 失败路径与用量对账 |
| 5 | 管理功能与旧版设置迁移 | Kimi | 2026-11-16 | NO-GO | 匿名管理接口实测 401；管理员／普通账号和 settings v5 样本未准备，其余项未执行 |
| 6 | 全量回归与发布记录 | Kimi | 2026-11-16 | NO-GO | 自动化 1358 pass／0 fail，发布检查与打包通过；未做干净安装冒烟，阶段 0–5 尚未全部 GO |

2026-11-19 独立 Chrome 续验（扩展 0.2.36、Web 0.1.19、API 0.2.9、Worker 0.2.3）：已复验关联、双向退出、双配置资料列表隔离，两个指定平台样本均成功零 ASR 字幕归档，完成发布包干净安装与主要操作。Web 修复了慢总结请求被外层 15 秒空闲限制提前断开的问题。两项发布阻塞已复现：YouTube PO-token 重读会开启原本关闭的字幕；管理页关闭 B 站字幕与 ASR 后，工具栏开课仍会启动 ASR。面板 AI、管理开关和旧设置的剩余用例见各阶段。

2026-11-19 修复复验：扩展 0.2.37 修复上述两个问题，775 项扩展测试和打包通过。独立 Chrome 配置确认了 0.2.37 版本，B 站关闭 ASR 后工具栏、侧栏和强制转写均未启动采集，YouTube PO-token 重检后字幕初始开启与关闭状态均保持。API 0.2.10 按百炼 HTTP 规范设置顶层 `enable_thinking=false`。用同一 B 站样本经 Web 0.1.19 重测，原请求返回 502／120.09s，修复后有一次返回 201／70.75s，68 条引用可回读，用量对账一致。另一次使用相同参数的直连长请求在 100s 超时，尚未达到稳定性验收要求。

2026-11-19 续验：API 0.2.11 收紧总结正文及引用数量，保持全文输入。YouTube 原超时样本两次返回 201（19.29s、16.16s），B 站样本返回 201（24.98s），三次回读、历史和用量一致。Chrome 验证旧设置从 v4 清理并持久化为 v5，迁移后真实选文解释、服务端概览回读与面板纪要通过。

2026-11-19 发布包冒烟：新建独立 Chrome 配置，从候选 ZIP 干净安装扩展 0.2.37，完成首次关联、收藏、YouTube 字幕开课与结束、Web 逐字稿与总结回读。Web 和扩展后台控制台未发现阻断错误。当前四单元和共享契约复跑共 1,415 项通过。阶段 6.1、6.2 已补齐，其他 P0 门槛仍待验。

---

## 阶段 0：准备验收环境

### 0.1 固定验收版本

- [x] 当前分支为计划发布的分支，工作区没有未说明的代码改动。
- [x] 记录本次验收 commit：`0e73f73`（2026-11-17 推送至 origin/productization/integration，含 dev.sh 修复 `688552a`、插件 `8328f47`、Web `f5d6526`、API `7135ccc`、验收证据 `0e73f73`）。
- [x] 插件通过仓库的 `apps/extension` 目录加载，Chrome 卡片显示版本 **0.2.31**。
- [x] Web 版本为 **0.1.14**。
- [x] API 版本为 **0.2.5**。
- [x] Worker 版本为 **0.2.3**。
- [x] API、Web、Worker 均已启动，`scripts/dev.sh status` 显示三个单元运行正常。

记录：

```text
分支：productization/integration（跟踪 origin/productization/integration）
Commit：0e73f73（已推送 origin/productization/integration，2026-11-17）
Chrome 版本：157.0.8103.51
Node 版本：v24.22.1
Python／uv 版本：Python 3.12.16／uv 0.10.2
执行人／日期：Kimi／2026-11-16
结果／证据：扩展管理页已显示 0.2.31；API :8787 的 /v1/me 返回 401（服务正常），Web :8080 返回 200，Worker 进程存在。2026-11-17 修复 dev.sh 包装进程识别后，api／web／worker 均显示 RUNNING；新增回归测试 1 passed，API 全量 295 passed。
```

### 0.2 准备账号

- [ ] 准备两个独立 Chrome Profile：账号 A、账号 B。
- [ ] 准备两个不同的受邀邮箱，分别用于账号 A、B。
- [ ] 账号 A 的邀请具有管理员标记。
- [ ] 账号 B 为普通用户。
- [x] API 与 Worker 已配置相同的 Worker 服务凭据。
- [x] 已确认开发验证码的读取方式；如使用真实邮件服务，记录其配置状态。
- [x] 配置文件中已填写真实 ASR／AI 密钥，但本文只记录“已配置”，不记录密钥内容。

记录：

```text
账号 A 邮箱（可脱敏）：a***@outlook.com（当前 Web 已登录）
账号 B 邮箱（可脱敏）：未准备；当前未观察到第二个 Chrome Profile
Worker 服务凭据：已配置，API／Worker 配置一致
Qwen ASR：密钥字段非空；2026-11-17 已切换 provider=qwen 并联调通过（详见 6.3）
Qwen AI：密钥字段非空；2026-11-17 已切换 provider=qwen 并联调通过（详见 6.3）
邮件方式：dev outbox（apps/api/data/outbox.jsonl）
结果／证据：当前账号未显示“站点管理”入口，管理员身份未得到确认； invites.seed.json 当前为空。密钥仅核对是否非空，未复制或记录内容。
```

### 0.3 登记真实样本

> URL 可写入下表；账号密码、Cookie、API key 不得写入。若课程需要资格，提前在对应 Chrome Profile 中登录。

| 样本 ID | 类型 | 必填属性 | URL | 登录／资格要求 | 已验证可播放 |
| --- | --- | --- | --- | --- | --- |
| XET-01 | 小鹅通视频 | 可播放、可拖拽定位 | https://appzl5apwz41977.pc.xiaoe-tech.com/p/t_pc/course_pc_detail/video/v_6a1e4816e4b0694c5bcea269?product_id=p_6a044874e4b0694c35082de8&content_app_id=&type=6 | 当前 Chrome 已登录“炒饭会” | [x] |
| BILI-01 | B 站多分集视频 | 至少两个可定位分集 | https://www.bilibili.com/video/BV1f48E68EhE | 当前 Chrome 已登录 B 站 | [x] |
| BILI-02 | B 站有字幕视频 | 字幕覆盖完整 | https://www.bilibili.com/video/BV1VeWC6GEsa/ | 当前 Chrome 已登录 B 站 | [x] |
| BILI-03 | B 站无字幕视频 | 可走 ASR 回退 | https://www.bilibili.com/video/BV1L4411U7Fj/（纯音乐，登录态字幕列表 n=0） | 当前 Chrome 已登录 B 站 | [x]（2026-11-18 真正的 LD 扩展实测 ASR 链路通过；纯音乐无人声，文本正确性由 XHS-01 覆盖） |
| BILI-04 | B 站字幕不全视频 | 可触发覆盖决策 | | | [ ] |
| YT-01 | YouTube 有字幕视频 | 字幕可正常读取；含中文（台湾）原生轨 | https://www.youtube.com/watch?v=MzklWMQ87Yw | 无需额外资格 | [x] |
| YT-02 | YouTube PO-token 样本 | 可验证授权重读或如实回退；与 YT-01 共用实测样本 | https://www.youtube.com/watch?v=MzklWMQ87Yw | 无需额外资格 | [x] |
| YT-03 | YouTube 无字幕视频 | 可走 ASR 回退 | | | [ ] |
| XHS-01 | 小红书视频 | 可播放、可定位 | https://www.xiaohongshu.com/explore/6ad745ea000000000c00ec8b（视频笔记《Agent重塑下一代商业4大变化》，10:40，含人声） | 当前 Chrome 已登录小红书（已关注按钮可见） | [x] |
| XHS-02 | 小红书图文 | 可测试分享 token 去重 | | | [ ] |
| WEB-01 | 普通网页 | 可收藏、可写笔记 | https://example.com/ | 无需登录 | [x]（2026-11-19 隔离 Edge 实测：收藏/打开/纯文本笔记/无错误回跳，见 1.5） |
| BILI-05 | B 站多分集稿件（真多 P） | ≥2 个分集、可定位、登录态有 AI 中文字幕 | https://www.bilibili.com/video/BV1ZA411g7Sb/（GenJi AE 公开课程，14 P；P1「00-AE先导课」169s cid 346910923，P2「01-AE概念篇」860s cid 346910855；免登录字幕列表为空，登录态 ai-zh 可用） | 当前 Chrome 已登录 B 站 | [x]（2026-11-18 API 核验 videos=14、P1/P2 时长与字幕） |

指定后续 AI 验收课程：

```text
课程 A（已有或即将产生真实逐字稿，可补学）：BILI-02《电脑空间不够？Mac无损迁移扩容！》
课程 B（初始只收藏、无逐字稿）：XET-01《12：vibe coding和工作流的关系02》
样本登记执行人／日期：Kimi／2026-11-16
样本问题或替代关系：BILI-01 当前页是“不可错过的软件推荐”合集（3/44），不是已确认的同一视频多 P 分集，需更换或补登记真正多分集样本。补充观察样本：YouTube 直播回放 https://www.youtube.com/watch?v=zcLPGC-tvgk&t=3s（仅英文自动字幕，不能替代 YT-03）。页面证据：docs/evidence/acceptance-xet-01-page.jpg、acceptance-bili-collection-page.jpg、acceptance-youtube-live-page.jpg。BILI-02 已在真实 Chrome 读到 zh 原生轨、非 AI、328 条，首段 0.133–3.733 秒，末段 13:41.466–13:44.100。
```

**阶段 0 完成条件：**版本固定、双账号可用、全部必填样本已登记且可访问。

---

## 阶段 1：账号、收藏、续学、笔记与隔离

### 1.1 邀请登录与插件关联

- [x] 受邀邮箱可以请求验证码并完成登录。
- [x] 未受邀邮箱的响应不透露该邮箱是否受邀。
- [x] 同一邮箱退出后可以再次通过验证码登录，历史数据仍在。
- [x] Web 未登录时，从插件打开授权页会先登录，再返回关联确认。
- [x] Web 已登录时，从插件打开授权页可以直接确认关联。
- [x] 关联成功后插件解锁，课程列表、收藏、笔记等入口可用。
- [x] 未授权或授权失效时，插件只展示授权引导，不开放学习功能。
- [x] 从 Web 主动退出后，同组插件凭据失效；插件在下一次探测或操作时回到授权引导。
- [x] 从插件主动退出后，Web 同组凭据失效并回到登录页。
- [x] 退出前的旧凭据访问受保护接口返回 401。
- [x] 重新登录和关联后，历史收藏、进度、笔记仍可读取。

```text
执行人／日期：Kimi／2026-11-18（API 级实测；浏览器侧关联引导流程未勾）
结果／证据：账号就位后（atomplus2020=账号 A、newuser=账号 B、admin=管理员，另有
asr-e2e），用 dev outbox 验证码完成 A／B 登录。受邀登录：request-code→verify 均 200，
A 历史 13 条资源重登后仍 13 条。未受邀中立：nobody-here-9988@example.com 与受邀邮箱
返回同为 200 {"ok":true}（结构一致），且 outbox 确认未受邀邮箱不发出验证码。
退出与凭据失效：POST /v1/auth/logout 200 后，旧 token 访问 /v1/me 与 /v1/resources
均 401「凭据已失效，请重新登录并关联」；重新 request-code→verify 后数据完整。
问题／issue：Web↔插件双向授权引导（先登录再确认／直接确认）、关联解锁与双向踢出
（Web 退出→插件失效、插件退出→Web 失效）四条为浏览器侧流程，本轮未在浏览器复验，
保持未勾。
【2026-11-19 浏览器侧补充（隔离 Edge 实测，缺陷候选）】走真实 openAuthPage→link.html
流程：登录（邮箱+outbox 验证码）→「确认关联」→ 跳转 link.html?link=<一次性 code> 均
正常；但 background 的 tabs.onUpdated 监听未消费该 code——根因：pendingLinkTabs 是
service worker 内存 Set，MV3 worker 在用户登录期间（>30s 无事件）休眠重启后集合丢失，
onUpdated 里 pendingLinkTabs.has(tabId)=false 直接忽略成功跳转；pushState 改 URL 是否
触发 onUpdated 亦存疑。该窗口内换到同一 Profile 的插件侧凭据交换失败，用户停在
「关联码已生成」页无反馈。机制为 Chrome MV3 通用形态（内存态+30s 空闲回收），非 Edge
特有；建议产品确认修复方向（持久化 pending 集合 / 改用 webNavigation 监听 / 面板轮询
code）。本次凭据最终经手动调用 exchange 语义完成（POST /v1/auth/link + 落存储，等价
handleLinkCodeCaptured），关联后 checkAuth=authorized 正常。保持未勾：完整双向流程
（含自动交换成功态）仍需在窗口 203 复验。
【已修复 2026-11-19，扩展 0.2.36】owner 拍板：定性=产品缺陷，修复方向=持久化
pending 集合。两处实测订正与修复：
a) 存疑点定论（对照实验，worker 不重启、Set 完好）：LinkApp confirmLink 用
   history.replaceState 应用成功地址——replaceState 的 URL 变化**会**触发
   tabs.onUpdated（Edge 155 实测交换成功，面包屑 outcome=linked）；唯一断点确系
   worker 重启丢内存 Set。
b) 修复（background.js）：pendingLinkTabs 镜像进 chrome.storage.session
   （ytd_pending_link_tabs，worker 重启存活、浏览器关闭清空，语义恰为会话级注册）；
   注册（handleOpenAuthPage）/消费（handleLinkCodeCaptured）/用户关页（tabs.onRemoved）
   三处同步读写镜像；onUpdated 监听先等恢复完成再判归属（该事件可能正是唤醒新
   worker 的事件）。回归测试 plugin-auth-flow.test.js 两条（worker 重启后交换仍发生
   + 用户关页从镜像移除且迟到跳转不交换）+ 全量 772 pass（三处同步 bump 0.2.36）。
c) 装置活体验证（0.2.36，按缺陷真实时间线）：openAuthPage 注册（session 镜像写入
   [tabId] 已核实）→ 等待 40 秒（MV3 worker 空闲回收死亡）→ Web「确认关联」→
   replaceState 跳转 → 新 worker 恢复 Set → 自动交换完成：凭据落库（全新 linkedAt）、
   面包屑 outcome=linked、关联标签页自动关闭。面板收到 authAuthorized 后经
   runStartupGate 进入选择页视图（「课程标签页：选择一门课，开始学习」），授权引导
   消失——「关联完成后跳选择页等待开始采集」闭环达成。
   截图 docs/evidence/acceptance-11-auth-link-panel-selection.jpg。
   环境注记：Edge 重启不刷新 MV3 service worker 脚本缓存（旧 background.js 仍驻留），
   装置验证必须 chrome.runtime.reload()（等价 chrome://extensions 重载按钮）后才载入
   新代码——与验收规程「重载扩展」一致，已如实记录。
d) 保持未勾项不变：双向踢出两向 + 双向授权引导完整 happy path 在窗口 203 的复验
   （附录 B4；缺陷已修后该项预期可直接通过）。
```

2026-11-19 补测：在独立 Chrome 配置 `Learning Digest P0` 从 0.2.36 候选 ZIP 解包干净安装，连接隔离 API 和 Web。Web 未登录时先完成验证码登录，再进入确认页；Web 已登录时直接出现确认页。两次确认后授权页均自动关闭，侧栏返回课程选择页。插件退出后切回 Web 标签页，Web 回到登录页；Web 退出后重新打开侧栏，插件提示授权已失效并回到关联引导。隔离 HTTP 复验确认两个方向的同组凭据均返回 401，另一组仍有效。随后在第二个独立 Chrome 配置 `Learning Digest P0 B` 用账号 B 完成关联，Web 学习列表为空；在第一个配置重新登录账号 A，原来的 YouTube 和 B 站资料均仍可访问。

### 1.2 小鹅通：收藏 → 学习 → 续学 → 笔记

使用样本 `XET-01`：

- [x] 从 Web 收藏成功，列表显示正确平台和标题。
- [x] 从插件再次收藏同一页面，返回同一条资料，不重复创建。
- [ ] 能从学习库新标签页打开原视频。
- [ ] 在插件列表选择该标签页并开始学习，目标被锁定。
- [ ] 播放、暂停、向前和向后拖拽后，进度按实际播放位置保存。
- [ ] 结束学习后，Web 显示最后学习位置。
- [ ] 再次选择该视频，出现“继续学习／从头开始”。
- [ ] 继续学习定位到上次位置，从头开始定位到 0:00；仅定位时不写进度。
- [ ] 保存一条时间戳笔记，Web 能读回相同文本和时间戳。

```text
执行人／日期：Kimi／2026-11-16、2026-11-18（11-18 复验通过）
结果／证据：11-16 在 Web 学习库链接框填入完整 XET-01 URL 后两次点击「收藏」无反应
（现场截图 docs/evidence/acceptance-web-collect-unsubmitted.jpg），当时三服务异常，
不能判定为产品缺陷。11-18 服务健康后复验（账号 B，InAppBrowser）：填入 XET-01 URL
与标题「Web表单验收-XET01」，点击「收藏」→ 页面显示「已收藏」提示，我的资料从 2 条
变为 3 条，新增条目平台识别为「小鹅通」、标题正确。Web 收藏链路通过。
插件再次收藏去重（11-18，CUA 实测）：激活 XET-01 标签页后，在侧栏课程标签页列表点选
「12：vibe coding和工作流的关系02」行，状态行显示「已在你的学习库：Web表单验收-XET01 ·
从头开始」，CTA 变为「开始学习」（匹配既有资源，不重复创建）；服务端核对 B 资源数仍为
3 条（res_1TrYyjRAJpnIcbV1 等），无新增。证据 docs/evidence/acceptance-12-plugin-resolve-xet01.jpg。
注：本共享 Profile 上欢迎态（收藏当前页按钮所在）因 chrome.storage.local 存在报告工件被
adoptLatestStoredReport 强制转入 results 态而不可达（sidepanel.js:3480-3503，环境限制非缺陷），
故插件侧去重改由课程列表 resolve 路径验证。
问题／issue：学习、续学、笔记链路仍需插件侧复验（见 1.8 会话外说明）。
```

### 1.3 B 站：基础学习及多分集隔离

使用样本 `BILI-05`（BV1ZA411g7Sb，14 集 AE 课程；原登记的 BILI-01 为非多 P，已改用 0.3 登记的多 P 样本）：
分集 P1 = 00-AE先导课（2:49）、P2 = 01-AE概念篇（14:20）、P3 = 02-AE概念课（11:43），账号 B。

- [x] 收藏、打开、开始学习、进度保存、续学和时间戳笔记全部通过。
- [x] 分集 1 与分集 2 分别收藏为独立资料。
- [x] 学习分集 1 后，只有分集 1 的进度变化。
- [x] 分集 1 手动结束时 Session 收尾并保存最后位置（软切换不收尾，见问题 a）。
- [x] 分集 2 重新开课为独立新 Session，进度互不覆盖。
- [x] B 站时间戳笔记回跳保留正确分集参数（P2 带 p=2、P1 规范 URL 本无 p 参数）。

```text
结果／证据（2026-11-18，账号 B，插件侧栏 + Web 8080 回查）：

1) 分集独立收藏：P2 收藏为 source src_UibFcDL3ppbh27bt（ep=2，norm URL 含 ?p=2），
   P1 收藏为 source src_mSpqXUWltywJr3Ld（norm URL 无 p 参数），resource 分别为
   res_b9oxT_0BLF5hCY0C（标题「【01-AE概念篇】」正确）与 res__XDhAGpqlz9ZE-XA
   （标题错为「【02-AE概念课】」，见问题 b）。服务端 state.json 核实。

2) P2 学习+进度：session ses_iTFbO4TBFggmgFjH（asr 路径，858062ms 保存）。

3) P1 学习+进度：session ses_aEorIRlqFgQmHOPC（asr 真实转写，167747ms≈播完）。
   互学期间对方进度不变，隔离通过（服务端逐项比对）。

4) P1 手动结束（侧栏面板「结束学习」）→ session finished，最后位置保存；
   此后对 P2 重开课 → 新 session ses_GCCECdmHoZh1iZaJ，进度 858062 不覆盖。

5) 续学：P2 重开课不会自动 seek 到上次进度，从视频当前位置继续记录
   （516s 起，存到 748489ms / rev38）；课程标签页列表另有「继续学习」入口
   （seek 到进度、试看不落账）。与预期「续学定位」存在 UX 差异，见问题 e。

6) 时间戳笔记：
   - 会话内浮条笔记（逐字稿选文 + 时间戳）实测保存到 chrome.storage 本会话域，
     3 条带 0:00 戳卡片，截图 docs/evidence/acceptance-13-note-floatingbar.jpg、
     acceptance-13-note-floatingbar-list.jpg（该路径为 legacy 本地，不走 API）。
   - API 时间戳笔记：POST /v1/resources/{id}/notes 直建（插件请求构造由
     plugin-note-timestamp.test.js 单测锚定；插件侧欢迎态入口在本共享 Profile
     因 report_ 工件强制 results 态不可达，同 1.2 已记录的环境限制）：
     · P2 note_qU8aO8UX-HoOTk_D，positionMs 748489；
     · P1 note_MdbxadEDfFnt2UwN，positionMs 60000。
   - Web 回跳 URL 实测（账号 B token 登录 8080，读 .note-stamp href）：
     · P2：https://www.bilibili.com/video/BV1ZA411g7Sb/?…&p=2&…&t=748 —— p=2 保留 ✓；
     · P1：https://www.bilibili.com/video/BV1ZA411g7Sb/?…&t=60 —— 规范 URL 本无
       p 参数（默认即第 1 集），落点 1:00 正确 ✓。
     截图 docs/evidence/acceptance-13-note-jump-p1.jpg。

7) 证据截图：acceptance-13-p2-learning.jpg、acceptance-13-p1-started.jpg、
   acceptance-13-p1-learning.jpg（学习中浮条+面板）、
   acceptance-13-softswitch-notice.jpg（软切换通知）。

问题／issue：
a) 软切换不收尾：播放页内 P1→P2 软切换时插件弹通知「已自动结束并保存进度」，
   但服务端 P1 session 仍为 active，未执行收尾保存（P1 靠手动结束才 finished）。
   通知文案与实际行为不一致。
   【已修复 2026-11-18，扩展 0.2.35】根因：endActiveSession 在 context.ended=true
   之后、finishServerSession 之前的本地收尾步骤无防护，任一步抛错（含 MV3 worker
   重启打断）都会中断收尾并残留活动指针；指针残留使 worker 重启后从活动快照复活
   本地已结束的会话，服务端 Session 永久泄漏 active（故障注入可复现该形态）。
   修复（background.js）：释放学习目标/收尾音频段/字幕归档各步独立 best-effort，
   finishServerSession 必达且自身异常吸收；快照保存失败不再阻断指针释放。
   回归测试 plugin-learning-start-flow.test.js「收尾韧性 (bug a)」+ 全量 770 pass。
   【活体复验状态 2026-11-19】隔离 Edge 环境（0.2.35 已加载，见下）未能完成 P1→P2 软切换
   复跑：音频采集路径被 Chrome「扩展未调用」门槛拦下——tabCapture.getMediaStreamId 要求
   在目标标签页上真实点击工具栏图标，自动化（CDP 可信点击 / action.openPopup /
   sidePanel.open 手势）均不计入调用。这是 Chrome 设计而非产品缺陷，正是 1.6 授权指引
   所述行为；隔离环境无人工点击条件。旁证：start 失败路径实测服务端 Session 即时 finish
   （ses_iFn2Gqi78PnrEEop，started 16:05:56Z 即 finished，活动指针已清），修复的
   「服务端 finish 必达」在该路径成立。待办（runbook）：在窗口 203 重载 0.2.35 后，
   B 站已登录走字幕路径（ai-zh）可绕开采集门槛，或人工点击工具栏图标后走 ASR 路径，
   复跑 P1→P2 软切换并核对服务端即时 finished。
   【活体复验通过 2026-11-19，窗口 203，扩展 0.2.36】按 runbook 完成真实 Chrome 复跑，
   形态与原事故一致（ASR 路径、采集运行中、播放页内分集软切换）：
   工具栏图标点击（AX 自动化）→ 自动开课（问题 d 行为）→ P2 会话
   ses_j0-uKq6tOfRfVm-H（origin=asr，真实 qwen3-asr 转写，面板 [2:00]–[3:10] 大段
   真实文本）→ 播放页内软切 P3 → **服务端立即 finished**（10 秒轮询粒度内：
   t+120s 时页面 p=2 且 session active，t+130s 页面 p=3 且 finished，
   started 00:22:02Z / finished 00:26:57Z，P2 进度已保存 rev42）→ 面板回空闲态并
   显示工具栏图标指引（「video · 未开始转写」）。
   注：本次软切换由 owner 手动点击分集触发（macOS 辅助功能授权对已运行宿主需重启
   才稳定生效，AX 点击时灵时不灵，见 1.1 环境注记）；点击仅为触发源，判定所依赖的
   位置流上报、源切换检测与 endActiveSession 收尾全部是插件自身行为。
   证据：docs/evidence/acceptance-13-buga-asr-session-learning.jpg（会话中面板真实
   转写）、acceptance-13-buga-softswitch-finish.jpg（切换后全屏）、
   acceptance-13-buga-panel-after-finish.jpg（收尾后面板空闲态）。bug a 活体复验
   关闭。
b) P1 资源标题错误：res__XDhAGpqlz9ZE-XA 显示「【02-AE概念课】…」（P3 标题），
   疑似 collect 时 tab 标题缓存滞后；Web 列表现有两个同名「【02-AE概念课】」资源
   （P1 错标题 + P3 自动收藏）。
   【已修复 2026-11-18，扩展 0.2.35】根因：bridgePageTitles 仅按 tabId 缓存
   document.title，不校验 URL——同标签页切换分集/硬导航后、bridge 重新上报前发起
   的收藏拿到上一分集标题。修复：上报时连同 URL 存储，标题胜出前按
   extractVideoIdentity（含分集）或 URL 比对；不匹配则回落 chrome.tabs 的即时标题。
   无 URL 可校验的旧消息保持原行为。回归测试 plugin-collect-flow.test.js 两条
   （陈旧分集标题让位 / 同分集仍胜出）+ 全量 770 pass。已错入库的
   res__XDhAGpqlz9ZE-XA 标题已用 PATCH /v1/resources/{id} 改正为
   「【00-AE先导课】- 怎么学习AE最高效」（与 B 站分集标题一致，已核实）。
   【活体复验通过 2026-11-19】隔离 Edge 环境（扩展 0.2.35，Chrome Stable 158 已禁
   --load-extension 故用 Edge 155 Chromium 内核，B 站未登录）：构造与事故同形场景——
   先硬导航到 P3（document.title=【02-AE概念课】…，pagehide 使 bridge 缓存留下 P3
   标题+P3 URL），再硬导航到未收藏的 P4 并立即收藏：outcome=created，资源
   res_GhmXmDH3VO3L4-yE / source src_7gpAE4V1JnNKx4cd（norm URL 含 ?p=4）标题为
   「【03-AE实战课】- AE关键帧动画基础概念_哔哩哔哩_bilibili」（P4 的 chrome.tabs
   即时标题），不是陈旧的 P3 标题——0.2.34 行为会拿到 P3 标题（原事故形态）。
   Web 学习库截图 docs/evidence/acceptance-13-bugb-web-library-p4-title.jpg
   （可见 P4 正确标题与 P1 已改正标题并存）。
c) P2 重开课在视频暂停时采集空音频 → 大量「[语音转录失败]」、Qwen 400
   "The audio is empty"；失败段原文直接进逐字稿（预期行为，记录备查）。
   另观察到 B 站有字幕时分段走 captions 路径（P3 session [0:00] 字幕成功）。
d) 工具栏 LD 图标点击 = 开侧栏 + 对未收藏页自动「收藏+开始」一体化
   （P3 被自动收藏 src_VjbLZ2LSNCllcPJz、session ses_p-jE_CQLKtNPPDmu）。
e) 续学 UX：重开课不自动 seek 到上次进度，也无续学提示 UI；「继续学习」仅在
   课程标签页列表。与验收预期「续学」存在差异，建议产品确认设计。
```

### 1.4 YouTube：基础学习

使用样本 `YT-01` 或另一个可定位视频：

- [x] 收藏、打开、开始学习、进度保存、续学和时间戳笔记全部通过。
- [x] 回拖和暂停恢复后仍记录在同一来源。
- [x] 时间戳笔记回跳使用正确的 YouTube 秒数参数。

```text
执行人／日期：Kimi／2026-11-19（隔离 Edge 环境活体实测，账号 B）
环境说明：Chrome Stable 158 已禁用 --load-extension，隔离环境改用 Microsoft Edge 155
（同 Chromium 内核，MV3/sidePanel/tabCapture 语义一致）+ CDP 驱动，独立 Profile、
YouTube 未登录（YT-01 无需额外资格）。插件 0.2.35，API 8787 / Web 8080。扩展侧仅
通过面板/后台真实消息入口驱动，未注入或绕过任何产品逻辑。

1) 收藏：active tab=YT-01（watch?v=MzklWMQ87Yw，标题「想把 AI 用得好，你得再瘋一點 -
   YouTube」），collectCurrentPage → outcome=created，res_qr2UktM_o6F_F5eR /
   src_XuaHl9SADcibypcB，platformId=youtube、platformVideoId=MzklWMQ87Yw，标题正确。
   重复收藏 → outcome=existing 同一资源，不重复创建。

2) 开始学习（字幕路径，零 ASR、零采集调用）：startLearningForTarget → 探到原生 CC 轨
   → capturePath="captions"、timestampKind="video"，session ses_FAUP9qZOZVTzmK--
   （服务端 origin=captions）。面板逐字稿实时滚动（真实中文（台湾）字幕），截图
   docs/evidence/acceptance-14-yt-captions-learning.jpg（[0:26]–[1:16] 段落）、
   acceptance-14-yt-video-tab.jpg（视频页）。

3) 进度保存：字幕时间轴驱动，positionMs 137893(rev8) → 回拖后 72191(rev12) → 结束前
   99191(rev15)，全部落在同一 source。

4) 回拖和暂停恢复：video.currentTime 158→60 回拖，pause 3s，play 恢复——进度持续写
   同一来源（rev 12），字幕归档无重复、无伪造 gap（回拖重覆盖范围 gap=0）。

5) 结束学习：endLearning → 服务端 ses_FAUP9qZOZVTzmK-- finished（16:22:16Z），
   最终位置 99191ms 已保存。逐字稿 392 段落库（GET /v1/sessions/{id}/transcript，
   末条「我們下次見」@812249ms）。

6) 续学（继续学习 seek，试看不落账）：handleSeekLearningTarget(positionMs=99191) →
   视频 currentTime 定位到 99s 起播，进度保持 rev15 不变（试看不落账语义成立）。
   注：重开课不自动 seek 的 UX 差异同 1.3 问题 e，待产品确认。

7) 时间戳笔记（插件路径）：saveNoteToLibrary → note_5JqP0h1itQcuX5PL，
   positionMs=212307（与保存瞬间视频位置 212s 一致），挂 res_qr2UktM_o6F_F5eR +
   src_XuaHl9SADcibypcB。

8) Web 回查（8080，账号 B）：资料详情页显示 资料来源 YouTube、上次学到 1:39（=99s）、
   学习笔记 1 条「验收笔记-1.4-YT时间戳回跳 3:32」（=212s）、逐字稿 392 段·合并 1 次
   学习。笔记回跳 href 实测：
   https://www.youtube.com/watch?v=MzklWMQ87Yw&t=212s —— YouTube 秒数参数正确。
   截图 docs/evidence/acceptance-14-yt-web-detail.jpg。

问题／issue：
a) 本项全部链路走字幕路径；YouTube ASR 回退路径（无字幕视频）仍需工具栏图标真实调用
   （Chrome 设计），未在本轮覆盖（与 1.6 待办同源）。YT-03 样本本就记为已知平台限制。
b) 环境限制（非产品缺陷）：隔离 Edge 未登录 Google 账号；面板 AI（滚动摘要/纪要）走
   服务端 Provider 与登录态无关，本项未覆盖面板 AI 按钮（属阶段 4 范围）。
```
```

### 1.5 小红书：视频、图文与普通网页

使用样本 `XHS-01`、`XHS-02`、`WEB-01`：

- [ ] 小红书视频完成收藏、开始学习、进度保存、续学和时间戳笔记。
- [ ] 小红书图文可以收藏和打开。
- [ ] 同一图文更换分享 token 后，按既定规则去重。
- [ ] 小红书图文可以保存无时间戳笔记并在 Web 回查。
- [x] 普通网页可以收藏、打开和保存纯文本笔记。
- [x] 无文档化定位能力的平台只展示时间戳，不生成错误回跳。

```text
执行人／日期：Kimi／2026-11-19（隔离 Edge 环境活体实测，账号 B；环境说明同 1.4）
WEB-01（https://example.com/，普通网页）：
- 收藏：collectCurrentPage → outcome=created，res_FC8WWZQuWRgQBXEq，标题
  「Example Domain」正确，platform=null（非站点平台）。
- 打开：Web 详情页 ?resource=res_FC8WWZQuWRgQBXEq 正常渲染（资料来源/网页）。
- 纯文本笔记：saveNoteToLibrary → note_LhOKI7PcOrAupAhb，positionMs=null、
  sourceId=null（无可定位媒体，不带时间戳）。
- Web 回查：笔记「验收笔记-WEB01-纯文本」可见，无 .note-stamp 回跳链接（stamps=[]）
  ——无定位能力的来源不生成错误回跳 ✓。
  截图 docs/evidence/acceptance-15-web01-plainnote.jpg。

问题／issue：小红书四项需要站点登录态（XHS-01 要求已登录），隔离环境无法登录小红书，
待窗口 203 会话完成；「只展示时间戳」半句需小红书图文样本（有播放位无 seek）验证。
```

### 1.6 后台标签页与采集授权

- [ ] 目标课程标签页置于后台，插件列表仍能选中并锁定正确目标。
- [ ] 从未在目标页调用扩展时，开始学习会给出清晰的授权指引，而不是静默失败。
- [ ] 按指引在目标页点击工具栏图标后，可以完成采集调用。
- [ ] 记录 Chrome 实际要求的步骤、顺序和是否出现权限弹窗。
- [ ] 学习中切换到其他标签页，进度、字幕和音频仍归原目标标签页。

```text
实际授权步骤（2026-11-19 隔离 Edge 实测前半段）：
1) 未调用扩展直接开始学习（startLearningForTarget，目标=已打开的 B 站/YT 标签页）：
   采集被 Chrome 拒绝（"Extension has not been invoked for the current page"），插件
   不静默失败，返回清晰指引文案：「Chrome 要求在采集前先调用一次扩展：请在小鹅通课程
   标签页上点击工具栏中的 Learning Digest 图标（点击即打开侧边栏并算作一次调用），然后
   再点『开始学习』。如果刚刷新或跳转过课程页面，需要重新点一次图标。」——指引项 ✓。
2) 采集调用尝试记录（自动化环境）：CDP 可信点击扩展页、chrome.action.setPopup+
   openPopup（Chromium 127+ 免手势入口）、sidePanel.open({tabId}) 手势调用——三者均
   不被 Edge 155 计入 tabCapture 调用；仅真实工具栏图标点击计入（Chrome 设计）。
结果／证据：步骤 1 的指引文案在真实浏览器复现；字幕路径（B 站登录态 ai-zh / YT 原生
CC）不经过采集调用门槛，1.4 已完整实测。步骤 2 说明「按指引点击图标后完成采集调用」
这一步需要人工点击，隔离环境无法自动化——待窗口 203 人工完成并记录 Chrome 实际弹窗。
问题／issue：a) 指引文案写「小鹅通课程标签页」但该门槛对所有平台一致（B 站/YT 同样
触发），文案以首适配平台代称全部场景，略有误导——建议产品确认是否改为「课程标签页」。
```

### 1.7 双账号与并发隔离

- [x] 账号 A、B 的列表只显示各自收藏。
- [x] 账号 B 使用账号 A 的 resourceId 直访时返回 404，不透露资源存在性。
- [x] 账号 B 看不到账号 A 的进度、笔记、Session 和逐字稿。
- [x] 两个账号分别收藏同一视频时，数据互不影响。
- [x] 两个标签页并发写同一来源进度，或重放旧 revision 时，旧写入返回 409 和当前版本。
- [x] 客户端采纳当前 revision 后可以正常续写。

```text
执行人／日期：Kimi／2026-11-18（API 级实测，curl + dev outbox 验证码登录）
结果／证据：账号 A=atomplus2020@outlook.com（acc_PxEk1o7k8uWcRen5，12 条既有资源）、
账号 B=newuser@example.com（acc_C_BEkphY_c6RVe08，0 条）。
- 列表隔离：A /v1/resources=12+1 条，B=0 条（各自收藏后 B 仅见自己的 1 条）。
- 直访隔离：B GET /v1/resources/res_obvKC_lPDXx3zxDR（A 的）→ 404「资源不存在或无权
  访问」；B GET 同 id 的 notes 入口写操作与 summaries → 404，不透露存在性。
- 收藏独立：A、B 先后 POST /v1/resources 同一 B 站 URL（BV1VeWC6GEsa）→ 各得 201 独立
  资源（A=res_Fzuvn0Wqz_kOmi1l，B=res_bZf4FByjMpbsLYWZ）；各自重复收藏 → 200 返回原
  资源不重复创建。
- 进度冲突：A 对 src_L82pH1WkAwQehLJ- 写 expectedRevision=0 → 200 revision=1；重放
  revision=0 → 409「进度已被其他端更新」并附 current={positionMs:60000,revision:1}；
  采纳 current 写 revision=1 → 200 revision=2。
- 笔记隔离：B 对 A 资源 POST 笔记 → 404；A 自己的时间戳笔记（sourceId+positionMs 成对）
  与无时间戳笔记均 201 且详情回读一致。
问题／issue：无。
```

### 1.8 插件交互、布局与 Web 视觉一致性

> 使用 0.2.23 或本次实际发布版本。在没有进行中 Session 的测试标签页检查欢迎区，避免为验收擅自结束现有学习。

- [x] 欢迎区图标、标题和说明按网格对齐，启动及会话状态刷新后均不偏移、不重叠。
- [x] 顶部“设置／退出登录”横向排列；功能标签页等宽、选中态清晰，主要按钮高度约 40 px。
- [x] 收藏、笔记和课程区域使用一致的卡片层级；长标题、操作按钮和空状态在常见侧栏宽度下不溢出。
- [ ] 笔记输入区占满可用宽度，输入、保存、删除及筛选反馈清晰，无被遮挡或不可点击的控件。
- [x] 从插件收藏当前页后出现明确成功反馈；重复收藏返回原资料，不重复创建，也不会卡在中间状态。
- [x] 收藏成功后可以开始学习或打开 Web 详情，返回侧栏后资料状态仍正确。
- [x] Web 收藏表单的“网页链接”和“标题”标签、输入框左缘及宽度一致，不错位。
- [x] 对照 Web 学习库检查插件主色、背景、卡片、边框、圆角和悬停态，色系一致且文字对比度可读。
- [ ] 重新加载扩展并重新打开侧栏后，进行中的 Session 和既有逐字稿仍可恢复，不被验收操作清除。

```text
测试侧栏宽度：11-18 通过收窄 Chrome 窗口（1920→1000→700→500 px）实测侧栏在约 645／630／
455／375 px 四档宽度下的表现（证据 docs/evidence/acceptance-18-width-{1000,700,500}.jpg）。
Chrome 侧栏分隔条无法用合成拖拽命中，侧栏本身宽度随窗口收窄由 Chrome 自动调整。
欢迎区布局：授权引导页（与欢迎区共用 .welcome-container 网格，sidepanel.html:131/196）
实测图标＋标题＋说明＋主按钮网格对齐、无偏移重叠，证据 acceptance-18-authgate-welcome.jpg。
本会话状态下欢迎区不可达的原因见 1.2 记录（adoptLatestStoredReport）。
顶部与标签页：设置／重新获取字幕／退出登录横向排列（三档宽度截图均不折行）；逐字稿／
概览／纪要／笔记四标签等宽、选中态绿色填充清晰；主 CTA 实测 40 px，与 sidepanel.css
.session-btn min-height:40px 一致。
溢出：默认至 455 px 宽度无溢出，长标题（如「电脑空间不够？Mac无损迁移扩容！_哔哩哔哩_bilibili」）
以省略号截断；窗口压到 500 px（侧栏约 375 px）时头部第 4 个按钮「退出登录」右缘被裁，
记录为轻微 issue（极端窄窗，见下）。
收藏交互：5.2 恢复 enabled 后点「收藏并开始学习」，侧栏即转入会话态（状态行＋目标 URL＋
字幕覆盖提示），成功反馈明确、无中间卡死；重复收藏去重见 1.2（resolve 匹配既有资料）。
收藏后可开始学习已实测（5.2）；笔记输入区（welcomeState 内）因欢迎态不可达未能交互实测，
其 CSS 为 width:100%／max-width:none／grid-column 1/-1（sidepanel.css:1219-1262），
「笔记」tab 的列表／筛选（本会话／全部笔记）与空状态文案截图已核，交互反馈待欢迎态可达后补验。
色系对照：插件 --accent 与 Web --ld-accent-600 为同一 token oklch(48% 0.085 174)
（sidepanel.css:21、apps/web/src/styles.css:8）；像素采样 Web「收藏」按钮 (15,107,92) vs
插件 CTA (19,108,90)，Web 背景 (239,244,247) vs 插件面板 (239,247,249)，Δ≤4，
证据 acceptance-18-web-library.jpg 与 acceptance-52-bilibili-reenabled-start.jpg。
收藏交互结果：11-18 复验 Web 收藏表单提交成功（见 1.2）；「网页链接」与「标题」
两个输入框外层容器实测 x=34、宽=449、高=44 完全一致，左缘与宽度对齐，内层缩进为
链接前缀图标的标准 Ant Design 行为，非缺陷
视觉对照截图：docs/evidence/acceptance-18-web-library.jpg（11-18 Web 学习库）、
acceptance-52-bilibili-reenabled-start.jpg（11-18 插件会话态）
执行人／日期：Kimi／2026-11-16、2026-11-18
结果／证据：11-18 完成插件侧——欢迎区（经授权引导页）网格布局、顶部横向按钮、等宽
标签页、40px 主按钮、常见宽度不溢出、收藏成功反馈与去重、色系对照（同一 token＋
像素 Δ≤4）、三档窄窗实测。遗留：笔记输入区交互（欢迎态不可达）、500px 极窄窗头部
第 4 按钮裁剪（轻微）、扩展重载后 Session 恢复（本轮未测）。
问题／issue：
- 极窄窗口（侧栏约 375px）头部「退出登录」被裁，建议 header-actions 允许折行或收纳；
- 欢迎态／笔记输入区／收藏当前页按钮在本共享 Profile 不可达（报告工件强制 results 态），
  建议在干净 Profile 补验或提供清空工件的测试入口；
- B 站自动连播导致两处已知数据错配：res_rwuFIi87shjVYhGq（BV1f48E68EhE Obsidian 教程）
  标题存为「电脑空间不够？Mac无损迁移扩容」（页面 document.title 滞后），以及
  BV1VeWC6GEsa 被绑到「隔离测试-卡农」（1.7 期间连播串台），均为环境现象非产品缺陷，
  但提示收藏标题以页面标题为准存在连播错配风险。
```

**阶段 1 完成条件：**四站基础学习链路全部通过；任何一站无法收藏、续学、记笔记或保持账号隔离，均为 NO-GO。插件收藏交互和核心布局存在阻断问题时，同样为 NO-GO。

```text
阶段 1 结论：NO-GO
执行人／日期：Kimi／2026-11-18
结果／证据：11-18 已完成——1.1 受邀登录／未受邀中立／退出后旧凭据 401／重登数据
完整（API 级）；1.2 Web 收藏成功且平台标题正确，插件再次收藏去重通过（resolve 匹配
既有资料、服务端无新增）；1.3 B 站多分集隔离全部 6 项通过（分集独立收藏与进度隔离、
手动结束收尾、时间戳笔记回跳 p=2 保留；浮条笔记实测，API 笔记直建+Web 回跳实测；
附软切换不收尾、P1 标题错配、空音频转录失败等问题）；1.7 双账号隔离全部 6 项通过；
1.8 Web 表单对齐、欢迎区（经授权引导页）网格布局、顶部横向按钮、等宽标签页、
40px 主按钮、常见宽度不溢出、收藏成功反馈、色系对照（同一 OKLCH token＋像素 Δ≤4）
通过。仍缺：YouTube／小鹅通／小红书收藏—学习—续学—笔记浏览器侧完整链路
（1.4／1.5／1.6 未做）、Web↔插件双向授权引导与双向踢出、笔记输入区交互
（欢迎态在本 Profile 不可达）、极窄窗头部裁剪待修。
按完成条件维持 NO-GO。
证据位置：本阶段 1.1、1.2、1.3、1.7、1.8 记录。
```

---

## 阶段 2：B 站／YouTube 字幕路径

### 2.1 B 站有字幕：全文、直归档、零 ASR

使用样本 `BILI-02`：

- [ ] 开始学习后显示字幕全文。
- [ ] 字幕路径不请求音频采集授权，不出现 tabCapture／offscreen 采集指示。
- [ ] 字幕覆盖完整时直接归档，Web Session 来源显示“字幕”。
- [x] Worker 没有领取或处理该 Session 的 ASR 任务。
- [ ] 面板不出现“转写中”。
- [ ] 拖拽跳过一段后，跳过范围记录为 gap。
- [ ] 字幕轨自身的空缺按无记录呈现，不误标为用户跳过。
- [ ] Web 回查的字幕、gap 与插件一致。
- [ ] 接口中不存在不属于该字幕路径的 pending／failed ASR 段。

```text
执行人／日期：Kimi／2026-11-16
结果／证据：真实 Chrome 中，扩展 0.2.31 已从 BV1VeWC6GEsa 读取原生 zh、非 AI 字幕轨，共 328 条；首段 0.133–3.733 秒，末段 13:41.466–13:44.100。该结果只证明字幕轨读取成功，不证明开始学习和归档链路通过。
零 ASR 的判断依据：未取得本次字幕学习 Session 的 Worker 领取日志及接口 records／gaps／pending／failed 对照，故不作零 ASR 结论。
问题／issue：完整字幕全文展示、直接归档、gap、Web 回查和 Worker 零 ASR 均未形成当前 Session 证据；为避免覆盖或结束现有 session=s_mwjbsgit_jkxneu，本轮未擅自新开学习，全部验收项保持未勾选。
```

2026-11-19 补测：独立 Chrome 配置使用候选扩展 0.2.36，对 BILI-02 实际开课。页面时长约 13:56，字幕止于 13:44，按界面提示选择「按原样归档字幕」。结束后服务端为 `finished`，来源为 `captions`，Web 展开逐字稿显示 328 段和时间戳链接，服务端 ASR 任务为 0。拖拽造成的 gap 与字幕轨自身空缺仍待对照。

### 2.2 YouTube 有字幕与 PO-token 门禁

使用样本 `YT-01`、`YT-02`：

- [x] 普通有字幕视频可显示全文并直接归档，全程零 ASR。
- [ ] 从另一个 YouTube 视频通过站内导航软切换到 `YT-01`，不刷新整页；开始学习后读取的是当前视频轨道，字幕标题与内容不残留上一视频。
- [ ] 多轨道的选择顺序为“简体中文原生 → 繁体中文原生 → 英文原生 → 简体中文自动 → 繁体中文自动 → 英文自动”；本样本应选择“中文（台湾）”原生轨，而不是英文自动轨。
- [x] 若直接轨道请求返回 HTTP 200 但正文为空，不把空响应误判为成功；插件继续捕获播放器带授权的 timedtext 请求并重读优先轨道。
- [x] PO-token 样本在字幕初始关闭时保持关闭，初始开启时保持开启。
- [ ] 授权重读返回非空字幕事件，面板文本与当前视频对白一致，并记录实际轨道、`kind` 和事件数。
- [ ] 授权重读成功后，字幕直归档且来源为“字幕”。
- [ ] 跳过范围、字幕空缺和 Web 回查行为与 B 站一致。
- [ ] 捕获不可用或重读仍为空时，如实提示字幕不可用并回退 ASR。
- [ ] 回退原因被保留，自动收藏和开始学习流程不受影响。

```text
执行人／日期：Kimi／2026-11-16
YT-01 实际视频 ID／标题：MzklWMQ87Yw／《想把 AI 用得好，你得再瘋一點》
YT-01 实际轨道／kind／事件数：本次发布版本未完成复验；0.2.23 开发复验参考为 zh-TW／manual／392 条
YT-02 实际走向：本次未取得有效结论，不能勾选字幕成功或 ASR 回退
授权前响应：本次未复验
授权后响应：本次未复验；0.2.23 开发复验参考为 HTTP 200／43,441 字节／392 条
字幕开关是否保持：本次未复验
结果／证据：保留下方 0.2.23 开发复验记录作为历史参考，但没有把它当作 0.2.31 本次人工验收通过证据。
问题／issue：站内软切换、字幕开关保持、当前视频对白核对、直归档、gap、Web 回查和 ASR 回退分支均未完成，所有项目保持未勾选。
```

> 开发复验参考（不代替本次人工验收）：2026-11-16，版本 0.2.23 在上述样本上选择 `zh-TW` 原生轨；授权后请求为 HTTP 200，正文 43,441 字节，共 392 条 `manual` 字幕事件。同期插件自动化测试为 740 pass／0 fail。

2026-11-19 补测：独立 Chrome 候选版 0.2.36 对 YT-01 实际开课，侧栏显示「字幕」，结束后服务端为 `finished`，来源为 `captions`，Web 回查 392 段，ASR 任务为 0。第二个 Chrome 配置通过 DevTools 核对：无 PO-token 的 `zh-TW` 与 `en` 请求 HTTP 200、正文 0.0 kB；有 PO-token 的 `zh-TW` 请求 HTTP 200、正文约 53.0 kB，侧栏「重新获取字幕」显示 `zh-TW` 392 段。实际点击相邻视频并返回原样本后重新探测仍拿到该轨。播放器字幕初始开启时探测结束后保持开启；初始关闭时探测结束后变成开启，连续两次复现。六级选轨的完整分支、切换后开课归档、gap 和读取失败回退仍需补测，阶段 2 维持 NO-GO。

0.2.37 Chrome 实机复验：独立配置加载当前候选 ZIP 的解包目录，Chrome 卡片显示 0.2.37。字幕初始关闭时，DevTools 记录不带 PO-token 的请求 HTTP 200、空正文，带 PO-token 的 `zh-TW` 重读 HTTP 200、约 53.0 kB，扩展显示 392 段，播放器字幕保持关闭。字幕初始开启时，授权重读同样返回非空、显示 392 段，播放器字幕保持开启。

**阶段 2 完成条件：**完整字幕路径做到零 ASR；PO-token 样本有明确的实测结果，不允许保留“待观察”。

```text
阶段 2 结论：NO-GO
执行人／日期：Kimi／2026-11-16
结果／证据：B 站仅完成真实字幕轨读取；YouTube 仅有旧版本开发复验参考。两站均缺当前版本完整学习 Session、直归档、Web 回查与 Worker 零 ASR 证据，YT-02 本次走向无有效结论。
证据位置：本阶段 2.1、2.2 记录；B 站样本登记记录。
```

---

## 阶段 3：真实 ASR、Worker 停启与强制转写

> 本阶段必须使用真实 Speech Provider。开始之前确认 Worker 使用 `qwen`，不要以 stub 结果勾选通过。

### 3.1 B 站无字幕回退 ASR

使用样本 `BILI-03`：

- [ ] 面板提示无可用字幕并进入音频路径。（本次实测侧栏直接进入「转写中」，未观察到显式的「无可用字幕」提示文案；音频路径已进入且 origin=asr，提示文案是否必须存在待产品确认）
- [x] 完成采集授权后，音频按约 30 秒一段上传。
- [x] 等待结果时显示“转写中”。
- [ ] 真实转写记录逐段出现，文本与音频内容相符。（纯音乐样本无人声，仅第 1 段产出「嗯。」，其余段为诚实的转写失败——文本正确性已由 3.4 小红书有人声样本覆盖验证，本项按样本限制不勾选）
- [x] 记录的时间戳对应原视频时间轴。
- [x] 拖拽跳过范围形成 gap，不产生伪造文本。
- [x] 结束学习时尾段正确 flush，随后完成 Session 收尾。
- [ ] Web 来源显示“语音转写”，records／gaps／failed 与插件一致。（本样本未做 Web 端逐项核对；Web 回查一致性已由 3.4 同链路验证）

```text
段级延迟：任务按 30s 节奏创建（创建间隔 26–30s），Worker（provider=qwen）认领延迟 1.0–4.9s
（5s 轮询周期内）；纯音乐段转写时长不可比，逐段记录延迟以 3.4 小红书有人声样本为准。
失败／重试情况：9 段中 8 段为诚实的「语音转录失败」（无语音内容），0 段卡死或超时悬挂；
失败段不落任何伪造文本，逐字稿仅含真实产出的 1 条记录。
结果／证据：2026-11-18 10:59–11:04 用真正的 Learning Digest 扩展（ID
bancoldamkgcenpilfelpkdpknncaano）实测样本二 BV1L4411U7Fj（登录态 x/player/v2 确认字幕
n=0）：侧栏「开始学习」→ tabCapture 授权成功（标签页标题出现「已分享标签页内容」）→
「video · 已对齐视频时间轴 · 转写中 · 开始于 10:59」。
交叉验证（apps/api/data/state.json）：会话 ses_rHuIdu_OCc8rFDGl origin=asr；transcriptionTasks
按 30s 分段共 9 个任务全部 done，segmentIndex/startMs 对齐视频位置时间轴（会话开始时视频
已播至约 1:04，30–90s 两段从未播放因此不存在，无回填、无伪造）；视频播完（5:28）会话自动
finished，尾段正常收尾；ld-api-audio 临时目录在段处理完成后为空（成功段按约定删除）。
问题／issue：
1. 2026-11-18 上午早些时候本项曾判定「ASR 路径 FAIL」，该结论作废：当时实测对象为第三方
扩展「课伴侧栏转写」（ID ogijcdmfmdicmpgcjpigphlnoeknenje，与本产品无关），其「转写中」
永不产出且服务端零数据。换用真正的 Learning Digest 扩展后，同一视频 ASR 回退链路完整
工作。排查教训：验收前必须核对扩展 ID（bancoldam…）与侧栏 UI（切换插件挂载的页面／
逐字稿·概览·纪要·笔记四 tab）。
2. 样本限制：纯音乐视频无人声，「文本与音频内容相符」无法在本样本验证，已由 3.4 小红书
有人声样本覆盖；B 站「无字幕且有人声」样本极难寻找（AI 字幕覆盖几乎所有语音视频）。
3. 侧栏文案：ASR 路径的「转写中／转录失败」表述本次实测均正常，未复现此前第三方扩展的
「恢复字幕」误导文案。
```

### 3.2 YouTube 无字幕回退 ASR

使用样本 `YT-03`：

- [ ] 按 3.1 的全部步骤独立实测，不以 B 站结果代替。
- [ ] 真实转写文本、时间戳和 Web 回查正确。

```text
段级延迟：
失败／重试情况：
结果／证据：2026-11-18 决定跳过（owner 裁定）：YouTube 现已对几乎所有有语音的视频自动生成
字幕轨（2026-11-17 批量探测 60+ 视频，含数小时前新发布内容，仅有语音者全部存在 asr 轨），
真正零字幕轨且有语音的长视频在平台上近乎不存在；插件读取 captionTracks 后对可获取轨按
优先级（简体CC→繁体CC→英文CC→简体自动→繁体自动→英文自动→其余）抓取，YouTube 站的
ASR 回退只能由"抓取失败"触发（如直播流 timedtext_failed），与 3.1 的 B 站"无字幕→音频
路径"场景不等价。ASR 采集链路本身已由 3.3（小鹅通 43 段真实转写）与 3.1（B 站）覆盖，
本项不再阻塞阶段 3 结论，发布说明中明确该限制即可。
问题／issue：无（转为已知平台限制记录）。
```

### 3.3 小鹅通真实 ASR

使用样本 `XET-01`：

- [x] 音频采集、分段上传、“转写中”和逐段结果正常。
- [x] 结束学习后 Web 能回查完整逐字稿。
- [x] 来源显示“语音转写”。
- [x] 小鹅通时间戳仅展示，不生成无效定位链接。

```text
段级延迟：2026-11-17 12:20–13:15 真实学习《12：vibe coding和工作流的关系02》（3 个 session，
共 48 段 30s webm/opus 音频段）；Worker（provider=qwen，qwen3-asr-flash）认领等待约 0.5s
（5s 轮询周期内），任务行 claimedAt-createdAt≈0.5s；48/48 段转写成功落库
失败／重试情况：0 失败、0 重试；3 个 session 均 finished，gaps 均为空
结果／证据：apps/api/data/state.json —— ses_RNuvgcwfAh0AUkzs（4 段）／ses_OJw8jEMkx_bzYT5R
（1 段）／ses_fnFAEa9bhk635h75（43 段），origin=asr；转写文本与课程口播内容一致（Web Coding
与工作流关系讲座，43 段连续覆盖 0:00–21:29）。Web 回查验证（2026-11-17 截图
/tmp/merge_ui.jpg 同视角）：资源详情逐字稿区显示「43 段 · 合并 3 次学习」，每段带
「语音转写」来源 Tag；小鹅通无 seek 参数，时间戳为纯文本展示（SEEK_PARAM_BUILDERS 无
xiaoe-tech 项，library-flow 测试固定该行为），无失效定位链接
问题／issue：无
```

### 3.4 小红书真实 ASR

使用样本 `XHS-01`：

- [x] 音频采集、分段上传、“转写中”和逐段结果正常。
- [x] 结束学习后 Web 能回查完整逐字稿。
- [x] 来源显示“语音转写”，时间戳展示正确。

```text
段级延迟：任务按 30s 节奏创建（间隔 29–30s）；Worker（provider=qwen，qwen3-asr-flash）认领
延迟 1.0–4.9s（5s 轮询周期内）；有人声段「上传→转写→回读」逐段可见，侧栏逐字稿与任务节奏
同步刷新（约 30s 一段出现）。
失败／重试情况：8/8 段转写成功落库，0 失败、0 重试、0 卡死。
结果／证据：2026-11-18 11:10–11:16 实测样本 XHS-01《Agent重塑下一代商业4大变化》
（小红书视频笔记，10:40，含人声；扩展 ID bancoldamkgcenpilfelpkdpknncaano）：
- 侧栏「开始学习」（含自动收藏）→ tabCapture 授权成功 →「video · 已对齐视频时间轴 ·
  转写中 · 开始于 11:10」；逐段出现真实口播文本（Stripe/超级智能/互补品等，与视频内容一致）。
- 交叉验证（state.json）：会话 ses_mp_YYbupiEB9JgQ1 origin=asr；8 个任务全部 done；逐字稿
  8 条记录，时间戳对齐原视频时间轴（0:00/0:30/1:00/4:00/4:30/5:00/5:30/6:00）。
- gap 实测：1:48 处快进到 4:00（跳过 1:30–4:00 约 2 分半），后续段从 4:00 直接续上，
  被跳过区间零伪造文本；侧栏逐字稿渲染「[已跳过 1:30–4:00]」标记。
- 结束学习：尾段为不足 30s 的截断段 [6:00–6:24]，正确 flush；会话 finished。
- Web 回查（127.0.0.1:8080 资源 res_obvKC_lPDXx3zxDR）：逐字稿「8 段 · 合并 1 次学习」，
  每段时间戳＋全文＋「语音转写」来源 Tag；gap 显示「1:30–4:00 已跳过」；资料来源保留原始
  链接（含 xsec_token），平台「小红书」，并显示「上次学到 6:24」续学位置。
问题／issue：
1. 小红书页面播放器默认 volume=0（未静音但音量为 0）：若用户未手动调音量，tabCapture
  采集到的将是静音，所有段都会「语音转录失败」。本次实测由执行者将 video.volume 置 1 后
  采集成功。建议产品侧在采集前检测页面音量并在侧栏提示（不静默产出全失败段）。
2. 小红书视频在后台标签页可能被站点暂停，采集时需保持该标签页前台播放。
```

### 3.5 Worker 停止、恢复与幂等

- [x] ASR 学习过程中停止 Worker，API 仍能接收音频段。
- [x] Worker 停止期间，新上传段保持“转写中”或排队状态，不误报失败。
- [x] 重启 Worker 后，pending 任务按 segmentIndex 顺序处理。
- [x] 恢复后插件与 Web 的逐字稿一致。
- [x] 重放上传或结果回写不会产生重复记录。
- [x] 同一段不会重复计入转写用量（以“每任务仅被 claim 一次 + 结果幂等回写”判定）。
- [ ] 如额外测试“claim 后停止 Worker”，如实记录任务可能滞留；当前没有租约自动恢复能力，不得勾选为已自动恢复。（本条为保留限制声明，未制造该场景。）

```text
停止时长：约 4 分钟（11:25:05 pkill 杀 Worker → 11:29:00 dev.sh start 拉起新 Worker，
dev.sh 自动跳过端口占用的 API:8787／Web:8080，仅重启 Worker）
恢复耗时：新 Worker 启动后约 1–2 秒内开始认领（首个停机期间排队任务 claimedAt=11:29:01.5）
结果／证据：2026-11-18 11:23 用真正的 Learning Digest 扩展对小红书视频（资源
res_obvKC_lPDXx3zxDR）发起 ASR 学习会话 ses_pb-2cxsGPRzIVqZl，11:25:05 杀掉 Worker：
- 停机期间（11:25–11:29）播放跨过的段 12／13／14 照常创建（11:27:21／11:27:51／11:28:21），
  全部 pending、claimedAt=None，零误报失败；API 持续接收音频上传。
- 11:29:00 重启 Worker 后，seg 12→13→14 按 segmentIndex 严格升序被认领
  （claimedAt 11:29:01.5→11:29:02.4→11:29:04.3），全部 done；此后 seg 15–20 持续正常处理。
- 幂等：transcripts 中该会话仅 1 条记录；segments 以 segmentIndex 为 key 无重复；
  10 条 records 覆盖区间两两不重叠。
- 一致性：会话随视频播完自动 finished，并入既有资源，Web 资源页显示「8 段 · 合并 1 次
  学习」，无重复段；插件侧栏与 Web 读同一后端数据。
- 意外收获：尾段 seg 21（630–640s）撞上 ASR 服务超时（[Errno 60]），任务 failed、error
  落库、未伪造任何文本，失败音频按约定保留——同时构成 3.7「失败段保留」的实测样本。
延迟／失败率记录：恢复后认领延迟 1–2s；本会话任务失败率 1/11（尾段上游 ASR 超时抖动，
非 Worker 停启所致）。
问题／issue：无。「claim 后停止 Worker 任务可能滞留」为已声明的保留限制（无租约自动
恢复），发布说明需如实保留。
```

使用样本 `BILI-04`：

- [ ] 覆盖不全时推迟归档，并出现“原样归档／强制转写”的明确选择。
- [ ] 分支 A：归档前选择强制转写，同一 Session 整段切换到 ASR，字幕不提交。
- [ ] 分支 B：选择原样归档，字幕缺口不补、不转写，Web 来源为“字幕”。
- [ ] 分支 C：已归档字幕后，选择强制转写会开启新的 Session 并直走 ASR。
- [ ] 每个 Session 内字幕与 ASR 不混排，origin 只有一个值。
- [ ] Web 能并列查看不同 Session 及其各自来源。

```text
分支 A 结果／证据：未执行——2026-11-18 11:20 owner 决定跳过 BILI-04（字幕覆盖不全样本难寻：登录态 AI 字幕覆盖几乎所有语音视频）。与 YT-03 同为已知平台限制记录，不再阻塞阶段 3 结论；若未来找到「UP 主部分人工 CC 字幕」视频可补测。
分支 B 结果／证据：未执行（owner 跳过）。
分支 C 结果／证据：未执行（owner 跳过）。
问题／issue：样本问题转为已知限制记录；强制转写三分支代码路径仍只有单元测试覆盖，发布说明中应如实说明。
```

### 3.7 临时音频检查

- [x] 成功完成的音频段在处理后按约定删除。
- [x] 失败段的保留位置已记录。
- [ ] 发布说明明确“失败段宽限期自动清理尚未实现”，没有把它描述为已具备的能力。

```text
检查目录（不记录敏感内容）：/var/folders/75/rzc717kd1s3f9zwzkxrhpk8w0000gn/T/ld-api-audio/
结果／证据：2026-11-18 多次检查该目录：成功段处理后目录为空（按约定删除），无临时音频
泄漏。11:31 起观察到任务级失败样本：3.5 实测会话 ses_pb-2cxsGPRzIVqZl 尾段 seg 21
（630–640s）ASR 超时失败，其音频 tsk_WYp5hw00NZu2j9_4.audio（173KB）按约定保留在该
目录；任务 status=failed、error={"code":"transcription_failed","message":"[Errno 60]
Operation timed out"} 落库，transcript.segments["21"] 记录失败状态与错误，records 中
无该段伪造文本。失败段保留位置=API 临时音频目录 + state.json 任务／transcript 错误记录。
问题／issue：「失败段宽限期自动清理尚未实现」仍为事实，发布说明继续保留该表述；当前
失败音频需人工清理。
```

**阶段 3 完成条件：**四站真实 ASR 均成功，Worker 停启恢复及强制转写三分支通过，并留下延迟和失败率记录。

```text
阶段 3 结论：通过（含 owner 发布决策记录的已知限制：YT-03、BILI-04 跳过；「claim 后停止
Worker 无租约自动恢复」「失败段宽限期自动清理未实现」为已声明保留限制）
执行人／日期：Kimi／2026-11-16；真实 Qwen ASR 联调：Kimi／2026-11-17；B 站／小红书真实
ASR 实测：Kimi／2026-11-18
结果／证据：2026-11-17 已切换 Worker provider=qwen（qwen3-asr-flash）并完成端到端联调
（直连 3/3、真实链路 1/1，详见 6.3）。2026-11-18 用真正的 Learning Digest 扩展完成三项
真实 ASR 实测：3.1 BILI-03 卡农纯音乐（字幕 n=0→ASR 回退，9 段任务链完整、零伪造文本、
播完自动收尾，文本正确性受纯音乐样本限制）、3.4 XHS-01 小红书商业口播（8/8 段成功、
文本与时间轴正确、gap 快进零伪造、Web 回查「语音转写」来源一致）、3.5 Worker 停启恢复
（停机 4 分钟排队零误报、重启后按 segmentIndex 顺序恢复、幂等无重复、插件与 Web 一致，
详见 3.5）——3.1 此前的「ASR FAIL」结论系误测第三方扩展「课伴侧栏转写」所致，已作废并
更正。3.3 XET-01 小鹅通 48/48 段此前已通过。3.7 失败段保留随 3.5 实测获得任务级失败
样本（seg 21 ASR 超时，音频按约定保留、错误落库、无伪造文本，详见 3.7）。强制转写三分
支经 owner 决定跳过（BILI-04 字幕不全样本难寻，记为已知平台限制，发布说明如实说明）；
YT-03 经 owner 决定跳过。
问题／issue：(1) BILI-04 样本未找到（登录态 AI 字幕覆盖普遍完整，需 UP 主部分人工 CC
字幕视频；owner 可指定候选 URL，由执行者计算字幕覆盖率判定）；(2) 小红书播放器默认
volume=0 导致静音采集风险，建议产品侧增加采集前音量检测提示；(3) 「claim 后停止
Worker 无租约自动恢复」与「失败段宽限期自动清理未实现」两项保留限制需写入发布说明；
强制转写三分支代码路径仅单元测试覆盖，发布说明如实说明。
延迟／失败率记录：3.4 认领延迟 1.0–4.9s、失败 0/8；3.5 恢复后认领延迟 1–2s、失败 1/11
（尾段上游 ASR 超时抖动）；3.3 小鹅通 48/48 成功。
证据位置：6.3 真实 Qwen ASR 联调记录；docs/evidence/asr-samples/qwen-asr-sample-01.m4a；
state.json 会话 ses_rHuIdu_OCc8rFDGl（B 站）／ses_mp_YYbupiEB9JgQ1（小红书）／
ses_pb-2cxsGPRzIVqZl（小红书 3.5 停启测试）。
```

---

## 阶段 4：真实 AI 总结、面板 AI 与用量

> 本阶段必须使用 API 侧真实 AI Provider。记录实际 provider／model，但不要记录密钥。

```text
AI Provider：qwen（2026-11-17 已启用；直连冒烟 HTTP 200，约 5s）
Model：qwen3.8-flash（已发起真实模型调用，详见 6.3）
课程 A：BILI-02《电脑空间不够？Mac无损迁移扩容！》
课程 B：XET-01《12：vibe coding和工作流的关系02》
```

### 4.1 未学完生成与引用回查

- [ ] 课程 A 只学习一部分后，可以主动生成课程总结。
- [ ] 生成期间按钮显示“生成中…”并禁用，重复点击不会重复提交。
- [x] 真实生成期间不出现前端假超时。
- [x] 成功后保存第 1 次总结，显示生成时间和引用数量。
- [x] 每条引用的 quote 能在对应真实 Transcript 记录中逐字找到。
- [x] 引用区间和 Session 归属正确。
- [ ] B 站／YouTube 引用可回跳原平台对应时间点，并保留分集参数。
- [ ] 无定位能力的平台只展示时间戳。
- [ ] 模型返回的不合规引用被丢弃，不形成死链。

```text
2026-11-19：从 Chrome Web 详情主动生成 BILI-02 总结，实际由 qwen3.8-flash 完成。重新进入详情后显示第 1 次历史记录、生成时间和 66 条引用。逐条对照持久化的真实字幕，66/66 的 Session、起止位置和原文均吻合；显示的时间点链接指向对应 B 站视频。
问题与修复：Chrome 点击生成后显示「无法连接服务器，请稍后重试」，但 BILI-02 生成随后落库，summaryCount 增加 1，summaryInputChars 增加 17,186。Web 外层 HTTP 空闲超时 15 秒先于反代的 125 秒，导致客户端未收到响应。Web 0.1.19 在请求体读完后为代理响应设定时限，新增延迟响应回归测试。实际复验 YouTube 样本请求在 120.1 秒仍收到 HTTP 502；提供商未及时完成这一请求。

API 0.2.11 Chrome 补测：在原先超时的 YouTube 样本点击「生成总结」，页面从「生成中…」直接切到新历史记录，无需刷新。服务端确认 qwen3.8-flash 落库，正文 1,495 字符，引用为 0 条。该返回满足允许空引用的 API 契约，但这一条无法从总结回跳原文；同样样本的另外两次接口复验分别返回 11 和 10 条有效引用。
```

### 4.2 补学后再生成与历史保留

- [ ] 课程 A 再学习一段并形成新 Session。
- [ ] 主动再生成后，第 2 次总结覆盖新增材料。
- [ ] 新总结引用可以指向新 Session。
- [ ] 历史列表有两条，最新在前。
- [ ] 第 1 次总结内容保持不变，可以随时回查。
- [ ] 如补学期间新增笔记，重新生成时笔记进入生成输入。

```text
生成延迟：
新增内容是否进入总结：
结果／证据：
问题／issue：
```

### 4.3 空输入、双课程与双账号隔离

- [x] 课程 B 没有逐字稿时生成返回 409 `no_transcript_to_summarize`。
- [x] 409 不发起 AI 调用，不生成总结记录，也不增加用量。
- [ ] 课程 B 后续产生自己的逐字稿和总结后，A／B 内容互不串用。
- [ ] 两门课程的总结历史和引用计数独立。
- [x] 账号 B 直访账号 A 的资源或总结时返回 404。
- [x] 账号 B 的用量与账号 A 独立。

```text
执行人／日期：Kimi／2026-11-19（API 级实测，账号 B token）
结果／证据：
- 409 空输入：POST /v1/resources/res_1TrYyjRAJpnIcbV1（XET-01，无已归档逐字稿）
  /summaries → HTTP 409 {"code":"no_transcript_to_summarize","message":"这门资料
  还没有可总结的逐字稿，先学习并归档后再生成"}，AI 调用前拦截（summaries.py
  generate_summary 前置校验）。
- 用量不增：GET /v1/usage 前后逐键比对一致（audioSeconds=1029、summaryCount=0、
  digestCount=5 等十键原样，updatedAt 不变 00:26:25Z）——409 不发起 AI 调用、
  不落账。
- 跨账号：B GET /v1/summaries/sum_TAYE2Kku9XCHauUU（账号 A 的总结）→ 404
  「总结不存在或无权访问」；B POST /v1/resources/res_aGg98HyEdUk6J0w7（A 的资源）
  /summaries → 404「资源不存在或无权访问」。不透露存在性。
问题／issue：无（4.3 剩余三项需真实双课程总结，待 4.1/4.2 真实生成后回补）。

### 4.4 滚动摘要与概览

- [x] 课程学习达到约定覆盖条件后，滚动摘要成功生成。
- [x] Topic 时间线只追加，不改写既有 Topic。
- [x] 后续生成延续 index，跨边界 continuation 标记正确。
- [x] 游标后没有新增记录时幂等返回，不调用 AI、不改变 generatedAt、不增加用量。
- [x] 面板概览与最近一次服务端结果一致。
- [x] 从未生成概览的 Session 返回约定的 404。

```text
执行人／日期：Kimi／2026-11-19（API 级实测，会话 ses_FAUP9qZOZVTzmK--＝1.4 的 YT
字幕路径会话，392 段真实逐字稿）
结果／证据：
- 首次 GET /v1/sessions/{id}/overview → 404 {"code":"overview_not_generated"} ✓。
- POST /v1/sessions/{id}/rolling-summary → 201 首次落库：真实 qwen3.8-flash 生成
  （generation.provider=qwen/model=qwen3.8-flash/inputChars=12596），
  lastCoveredMs=813049（覆盖至逐字稿末尾），topics 含真实内容。
- 幂等回放：再次 POST → 200，响应体与首次完全一致（r1==r2），不调用 AI。
- 用量：rollingSummaryCount 0→1、rollingSummaryInputChars=12596——只计首次真实
  生成，幂等回放不计（D18 口径）。
```

2026-11-19 补测：隔离 Chrome 的 B 站字幕会话保持进行中，使用真实 Qwen 从服务端生成 8 个 Topic，GET 概览与生成结果一致。重载 0.2.37 扩展后，再打开面板「概览」，显示同一组 8 个话题及时段。此场景从 API 触发生成。

2026-11-19 自动节拍补测：由测试装置驱动 0.2.37 后台注册的 60 秒定时回调，逐字稿使用合成样本，请求走隔离 API 0.2.11 和真实 Qwen。0 条和 9 条记录时均未发起生成，第 10 条达到 5 分钟覆盖后首次返回 201。没有新增时下一拍未发起生成。第二批 10 条触发追加，原话题完全一致，新增话题延续到 index=2，跨批次标记 continuation=true，游标到达 600000 ms。经 Web 代理重放结果一致，用量零增量。

2026-11-19 真实 Chrome 补测：在独立 0.2.37 验收配置中播放公开 YouTube 样本 `MzklWMQ87Yw`，暂时关闭隔离环境的 YouTube 字幕采集，使用真实 Qwen ASR 和 `qwen3.8-flash`。Session `ses_b7HdFlUgc0LrSyEY` 于 21:44:56 启动（北京时间）。设置页重新载入确认摘要阈值为 5 分钟。保持概览打开，由实际播放和后台节拍驱动，两轮均自动更新侧栏。

- 21:51:03 首轮使用 11 条转写记录生成 4 个话题，覆盖至 5:30。
- 21:56:03 第二轮使用新增 10 条记录，追加编号 5–7，覆盖至 10:30。服务端前 4 个话题逐字段相同，侧栏显示 7 个对应时间段。第二轮从「提升视角高度」转入「提升深度」，新增话题未标 `continuation`，续接标记的正例见受控补测。
- 21:56:33 结束会话，23 段任务全部完成，Session 纪要落库。已恢复隔离环境 YouTube 字幕开关和扩展原有 15 分钟设置。
- 界面问题：首轮生成前侧栏还提示「约 15 分钟」，与设置页回读的 5 分钟不一致。实际自动生成采用了 5 分钟门槛。

### 4.5 Session 纪要与选中文本解释

- [x] 结束学习后成功生成 Session 纪要。
- [x] 纪要固定包含 overview／topics／categories／quotes／todos 五部分。
- [ ] 插件与 Web 读取到同一份服务端纪要。
- [x] 重新生成纪要采用整节覆盖语义。
- [x] 选中逐字稿文本可以生成解释。
- [x] 空文本或超过 8000 码点的解释请求返回约定的 400。
- [ ] 凭据失效后，面板停止 AI 节拍并回到授权引导。

```text
执行人／日期：Kimi／2026-11-19（API 级实测，会话 ses_FAUP9qZOZVTzmK--＝1.4 YT
字幕路径会话，已 finished）
结果／证据：
- POST /v1/sessions/{id}/digest → 200（覆盖重生成语义——该 Session 在 11-17/18
  联调已生成过 digest，usage digestCount=5 为证；本次为再次覆盖生成）。纪要五部分
  固定恒在：overview(4 段)／topics(11)／categories(3)／quotes(5)／todos(0，空段
  即空数组)，generation=qwen/qwen3.8-flash/inputChars=13375；quote 样例
  {"startMs":1500,"text":"創業的人，他的上限就是自己野心還有認知的上限…"}——带
  来源时间轴毫秒戳，可回跳。
- POST /v1/ai/explain {"text":""} → 400 {"code":"validation_failed","message":
  "text 必须是非空字符串"} ✓（无状态请求，无落库无计数）。
```

2026-11-19 补测：在迁移后的 Chrome 0.2.37 侧栏选中 B 站真实逐字稿，点击「解释」后显示服务端解释，随后结束会话并打开真实 Qwen 纪要，服务端记录包含五部分。独立 API 验证覆盖重生成与 GET 回读一致。Web 学习库详情当前提供逐字稿和课程总结，未找到 Session 纪要入口，因此保留跨端 UI 对照未勾。

2026-11-19 补测：扩展后台结束合成样本会话并触发真实 Qwen 生成纪要。同账号的扩展凭据直读 API 与 Web 凭据经代理读取 `GET /v1/sessions/{id}/digest`，响应体完全一致。401 停止节拍和引导重新授权已通过扩展后台自动化，真实 Chrome 联动单项仍待验。

一期范围待确认：Web 学习库范围和资源详情验收列出逐字稿、课程总结与引用回跳。Session 纪要的展示要求列在扩展的纪要标签和报告页。当前保留跨端页面对照项，待确认一期是否需要在 Web 学习库展示 Session 纪要。见 [Web 学习库 #49](https://github.com/yandw/learning-digest/issues/49)、[纪要 API #90](https://github.com/yandw/learning-digest/issues/90)、[扩展面板 #91](https://github.com/yandw/learning-digest/issues/91)、[Web 资源详情 #102](https://github.com/yandw/learning-digest/issues/102)。

### 4.6 真实失败路径与用量对账

- [x] 通过临时不可达端点或其他安全方式制造一次真实 Provider 失败。
- [x] 失败返回 502，页面使用契约约定文案。
- [x] 失败不产生总结记录，不增加总结或用量计数。
- [x] 恢复配置后能够重新生成。
- [x] `audioSeconds` 只统计首次完成的音频段，重放不重复。
- [x] `summaryCount／summaryInputChars` 与成功课程总结一致。
- [x] `rollingSummaryCount／rollingSummaryInputChars` 与真实滚动摘要调用一致，幂等回放不计。
- [x] `digestCount／digestInputChars` 包含真实的覆盖重生成。
- [x] `explainCount／explainInputChars` 与实际解释请求一致。
- [ ] 全新账号显示“从未产生用量”，而不是伪造一排已有用量。

```text
失败方式及恢复方式：2026-11-19 将隔离 API 的 Qwen HTTP 适配器指向本机未监听的端口，使用合成字幕请求总结。另用同一隔离数据切换到 stub 核对重试。
用量实测：失败返回 502 summary_generation_failed，总结列表为空，失败前后 /v1/usage 完全相同；stub 重试返回 201，总结计数加一，输入字符数增加。
结果／证据：Web 0.1.19 在真实 Qwen 的 YouTube 请求等待 120.1 秒后向客户端返回 502。在 Chrome 复验 BILI-02 的一次真实 Qwen 请求失败时，Web 显示契约文案「总结生成失败，请稍后重试；本次尝试不产生总结记录」。原总结历史仍为 1 条，summaryCount=1、summaryInputChars=17,186，与已成功落库的总结匹配。修复后真实成功的 Web 回执仍待复验。
2026-11-19 补测：真实解释 HTTP 200／1.23s，计数 +1、输入字符 +345；滚动摘要 HTTP 201／10.11s，计数 +1、输入字符 +10,073，重放与回读完全一致且零增量；纪要覆盖 HTTP 200／19.46s，计数 +1、输入字符 +10,686，回读一致。账号 B 用量在账号 A 的请求前后完全相同。另以合成音频契约样本调用本机接口，入队 +0 秒、首次完成 +30 秒、重复回写 +0 秒，合成音频未发送外部服务。
长总结：API 0.2.10 同一 YouTube 样本又一次 502／120.02s，无用量或历史变更。流式诊断约 0.78s 出正文，50s 已输出 7,037 字符但 JSON 未结束。API 0.2.11 提示正文约 1200 个中文字符、引用最多 12 条，继续输入完整逐字稿。经 Web 0.1.19 复验，YouTube 两次 201／19.29s、16.16s（11、10 条引用），B 站 201／24.98s（12 条引用）。三次历史新增、回读、生成次数和输入字符均对账一致。
```

**阶段 4 完成条件：**真实 AI 下课程总结和面板 AI 全部走通，引用、隔离、失败语义和用量对账通过。

```text
阶段 4 结论：NO-GO
执行人／日期：Kimi／2026-11-16；真实 AI 联调：Kimi／2026-11-17
结果／证据：2026-11-17 已切换 API aiProvider=qwen（qwen3.8-flash）并完成联调：课程总结真实生成 201／9.32s，输出为真实合成内容，citations 逐字引用转写文本并可回查（详见 6.3）。但补学再生成、滚动摘要、Session 纪要、文本解释、真实失败路径、双账号隔离和用量对账未执行，本阶段检查项除联调记录外保持未勾选。
问题／issue：账号 B 未准备；课程 A 尚无已验收的真实逐字稿，课程 B 的 Web 收藏尚未确认成功。上述项目须在真实 Provider 下用真实课程材料执行。
证据位置：6.3 真实 AI 总结联调记录；本阶段 Provider／Model 记录。
```

---

## 阶段 5：管理功能与旧版设置迁移

### 5.1 管理员与站点能力

- [x] 管理员账号 A 登录后显示“站点管理”入口。
- [x] 普通账号 B 不显示该入口。
- [x] 普通账号直接请求管理接口返回约定的 404，凭据不会被误清除。
- [x] 匿名请求管理接口返回 401。
- [x] 管理表正确显示四个平台的 captions／asr／enabled 状态。
- [x] 行级保存只提交改动字段。
- [ ] 保存成功后采用服务端回读值，失败时保留用户未保存的编辑状态（成功回读已验，失败保留未测）。

### 5.2 禁用与恢复平台

- [x] 禁用 B 站 enabled 后，插件下一次开课被拒绝并提示“站点未开放学习”。
- [x] 禁用状态下仍可收藏 B 站页面。
- [x] 恢复 enabled 后能够正常开始学习。
- [ ] 关闭 captions 后，插件按服务端能力表选择后续路径。
- [x] 关闭 asr 后，插件不会擅自启动 ASR。
- [x] 能力表缓存滞后符合约定，开课时会强制刷新。

### 5.3 旧版插件 settings v5 迁移

- [x] 准备 0.2.15 或更早版本的设置样本，包含遗留 AI／ASR 配置。
- [x] 首次读取设置后 settingsVersion 升级为 5。
- [x] provider／aiApiKey／aiBaseUrl／aiModel 及旧 ASR 残留键被清除并持久化。
- [x] API／Web 服务地址等仍需要的设置被保留。
- [x] 插件设置页不再显示 AI 密钥输入卡片。
- [ ] 清除本地密钥后，滚动摘要、纪要和解释仍通过服务端正常工作。

```text
执行人／日期：Kimi／2026-11-16、2026-11-18（11-18 为 API 级实测 + Web UI 实测）
结果／证据：
- 匿名：GET /v1/admin/site-capabilities 返回 401（error.code=unauthorized）；证据
  .scratch/acceptance/admin-site-capabilities-anonymous.json。
- 管理员读取能力表：admin@example.com（acc_HJd-UDiUuppHzfaU，isAdmin=true）登录后
  GET /v1/admin/site-capabilities → 200，四平台 bilibili／youtube／xiaoe／xiaohongshu
  的 captions／asr／enabled 全量返回（xhs、xiaoe captions=false 符合预期）。
- 普通账号 404：账号 B GET /v1/admin/site-capabilities → 404，且凭据不被误清除
  （随后 GET /v1/me 仍 200）。
- 入口显隐（Web UI 实测，InAppBrowser）：admin 登录后左侧菜单出现「站点管理」；
  退出换 B（newuser@example.com）登录后菜单仅「学习列表」，无站点管理入口，
  且资料列表只见 B 自己的条目。
- 管理表（Web UI 实测）：站点管理页表格正确显示四平台状态——bilibili／youtube
  captions=开，xiaoe／xiaohongshu captions=关，全部 asr=开、enabled=开，与服务端一致。
- 行级保存（Web UI 实测）：切换 youtube 字幕开关后仅该行的保存按钮可用（其余行
  保存按钮保持禁用），点击保存显示「已保存」并回读服务端值；API 复核 youtube
  captions=false 已持久化且其他字段不变。随后恢复开启并复核还原。服务端
  PUT /v1/admin/site-capabilities/bilibili {enabled:false} 亦验证只更新传入字段。
- 禁用期收藏：bilibili enabled=false 期间，账号 B POST /v1/resources 收藏 B 站
  页面 → 201（收藏不受 enabled 约束，仅约束开课）。测试后已恢复 enabled=true。
- 禁用后插件开课拒绝（11-18 CUA 实测）：admin PUT /v1/admin/site-capabilities/bilibili
{enabled:false} 并回读确认持久化；侧栏课程行 CTA 仍短暂显示「收藏并开始学习」（能力表
TTL 10 分钟，缓存滞后符合约定，证据 acceptance-52-bilibili-disabled-stale-cache.jpg）；
点击后状态行变为「站点未开放学习」，拒绝开课且未产生任何会话（state.json 核对 B 无
新增 session），证据 acceptance-52-bilibili-disabled-reject.jpg。开课前强制刷新见
background.js handleStartLearning → refreshSiteCapabilities({force:true})。
- 恢复后正常开课（11-18 CUA 实测）：PUT {enabled:true} 恢复并回读确认；侧栏选择 B 站
标签页（BILI-01 BV1f48E68EhE，对 B 未收藏），状态行显示「开始学习将同时收藏该页。」，
点「收藏并开始学习」→ 新资源 res_rwuFIi87shjVYhGq＋会话 ses_Oj-E-DqGoi3ApTbP，侧栏
转入会话态（已对齐视频时间轴、字幕待选择）；实时逐字稿即时可见（acceptance-52-
bilibili-reenabled-live-transcript.jpg），结束后核对 843 条 records 全部 origin=captions、
0 ASR tasks，零 ASR 直归档。证据 acceptance-52-bilibili-reenabled-{resolve,start}.jpg。
注：该资源标题因 B 站页面 document.title 滞后存为上一个视频标题，见 1.8 问题记录。
问题／issue：「保存失败时保留未保存编辑状态」未测（未构造失败场景）；关闭 captions／asr
后的插件路径本轮未测；settings v5 迁移未执行（缺 0.2.15 旧版设置样本）。
```

**阶段 5 完成条件：**管理开关能实际约束插件行为，旧版本地密钥完成迁移清除，服务端 AI 不受影响。

2026-11-19 隔离 Chrome 补测：管理页关闭 B 站字幕与语音转写，保存回读确认 `captions=false, asr=false, enabled=true`。普通账号从真实工具栏点开 BILI-02，侧栏提示改用语音转写并显示「转写中」。服务端落下一次 `origin=asr` 会话、1 个转写任务和 1 条转写记录。测试会话已经结束，两个能力开关已恢复为开启。这一实测失败使阶段 5 保持 NO-GO。候选版设置页确认没有 AI 密钥输入卡片；旧设置实装升级仍待验。

0.2.37 Chrome 实机复验：关闭 B 站 ASR、保留字幕，BILI-02 进入字幕选择，尝试强制转写后原字幕会话保留，仍可按原样归档 328 段。随后关闭字幕，真实工具栏与侧栏的「开始学习」均提示「站点配置已关闭语音转写。」对照测试前后，服务端只增加上述 1 个已结束的字幕会话，ASR 任务增量为 0。两个站点开关已经恢复。

旧设置补测：按 0.2.15 的 v4 格式，在独立 Chrome 配置通过 DevTools 存储编辑器写入合成 `ytd_settings`，含占位 AI 字段和刻意保留的旧 ASR 字段。写入前后均回读。重开 0.2.37 设置页后，存储版本为 5，旧 AI／ASR 字段全部消失，API 和 Web 地址、分段长度及摘要间隔保留。随后实际验证侧栏解释、纪要及服务端概览回读，未安装旧扩展二进制，也未验证自动滚动节拍。

```text
阶段 5 结论：NO-GO
执行人／日期：Kimi／2026-11-18
结果／证据：11-18 已通过——API 级（匿名 401、普通账号 404 且不误清凭据、管理员能力表
读取、行级字段保存、禁用期仍可收藏）、Web UI 级（入口显隐、管理表、保存回读）、插件
行为级（禁用 bilibili 后开课被拒并提示「站点未开放学习」且零会话产生、恢复 enabled 后
正常开课且 843 条原生字幕零 ASR、能力表缓存滞后符合约定且开课前强制刷新）。仍缺：
关闭 captions／asr 后的插件路径选择、settings v5 迁移。维持 NO-GO。
```

---

## 阶段 6：全量回归与发布记录

### 6.1 自动化全量回归

> 使用明确的测试文件匹配，避免 Node 24 不接受目录参数的问题。

- [x] 插件：`npm test`，0 失败。
- [x] 契约：`node --test contracts/*.test.js`，0 失败。
- [x] API：`cd apps/api && uv run pytest tests/ -q`，0 失败。
- [x] Worker：`cd apps/worker && uv run pytest tests/ -q`，0 失败。
- [x] Web：`cd apps/web && node --test test/*.test.js`，0 失败。
- [x] Web React UI：`npm ci --prefix apps/web` 后运行 `npm --prefix apps/web run test:ui`。2026-11-19 Web 0.1.19 本地复跑 17 通过／0 失败，Web Node 测试 191 通过／0 失败。GitHub Actions 配置为在扩展打包前执行同一套 UI 测试。
- [x] 发布结构：`npm run check`，通过。
- [x] 插件打包：`npm run package`，成功生成发布包。

```text
插件：754 pass／0 fail
契约：76 pass／0 fail
API：295 pass／0 fail
Worker：51 pass／0 fail
Web：182 pass／0 fail
合计：1358 pass／0 fail
发布检查：npm run check 通过（38 + 5 个 allowlisted 文件）；npm run package 成功，扩展包内测试复跑 754 pass／0 fail
执行人／日期：Kimi／2026-11-16；API 新增 dev.sh 状态回归测试复跑于 2026-11-17
结果／证据：契约、API、Worker、Web 分别按上述命令实测；API 另有 1 条 StarletteDeprecationWarning，无失败。API 的 295 中含 2026-11-17 新增的 dev.sh status 回归测试（修复 uv 包装进程与子进程监听层级识别）。扩展由本轮 npm run check／npm run package 复验。自动化全绿只满足发布前提，不替代真实 ASR／AI 和安装冒烟。
```

2026-11-19 当前版本复跑：扩展 0.2.37 共 775 项，共享契约 76 项，API 0.2.11 共 305 项，Worker 0.2.3 共 51 项，Web 0.1.19 共 191 项 Node 测试和 17 项 React UI 测试，合计 1,415 项通过、0 失败。Web 生产构建、扩展结构检查和候选 ZIP 完整性检查通过。

### 6.2 发布包安装冒烟

- [x] 使用本次生成的发布包，而不是旧 `dist` 文件，做一次干净安装。
- [x] Chrome 卡片版本与本次发布版本一致。
- [x] 插件能完成登录关联、收藏和开始学习。
- [x] 至少回读一条已有逐字稿和一份总结。
- [x] 控制台没有阻塞核心流程的新错误。

```text
发布包名称／校验值：apps/extension/dist/learning-digest-v0.2.31.zip；SHA-256 422456950cab841b70e4e1a75c85d9f59b86abf9963b1fe0b1c05c29abc6f446；文件大小 257,305 字节
安装结果：未执行干净安装；当前 Chrome 仍加载 apps/extension 的解包开发版本，不能用该状态代替发布包安装冒烟
结果／证据：本轮 npm run package 新生成上述文件，独立 shasum -a 256 复核一致。为避免覆盖当前扩展和进行中的 Session，本轮未替换安装；登录关联、收藏、开始学习、逐字稿／总结回读和控制台检查均未完成，所有安装冒烟项保持未勾选。
```

2026-11-19 候选包补测：重新生成 `apps/extension/dist/learning-digest-v0.2.36.zip`，SHA-256 为 `11080229964e3b360c435cd0fc950d198fc51fbfd61edf7b2bb4ae7e9688ce9e`，通过 ZIP 完整性检查。解包后在独立 Chrome 配置干净安装，卡片显示 0.2.36。已走通关联、收藏并开课、Web 回查逐字稿及已落库总结。后续版本 Web 0.1.19、API 0.2.11 已实测 Chrome 直接显示真实成功的总结回执，发布包控制台检查仍待验收。

2026-11-19 扩展 0.2.37 干净安装通过：新建独立 Chrome 配置 `Learning Digest 0.2.37 Smoke`，确认初始无 Learning Digest，直接加载本次候选 ZIP 的独立解包目录。Chrome 卡片和后台均显示 0.2.37，ZIP SHA-256 为 `fe6d51ccd51c1068894ec6e0e3febb7b242f739a1d8fbe24d43bfdd875bd2b3a`，关键运行文件与 `apps/extension` 一致。用隔离账号完成验证码登录和关联，收藏普通网页并在 Web 看到新增条目，随后对 YT-01 开始和结束学习。服务端新增 1 个已结束的字幕会话，392 条记录，ASR 任务新增 0；Web 展示合并后的 392 段逐字稿，并读取此前已落库的真实 Qwen 课程总结。Web 控制台复查为 0 条消息，扩展后台仅有启动、关联、点击开课和字幕会话开始四条正常消息。此轮使用隔离服务和已生成的总结数据。

### 6.3 文档与发布记录收尾

- [ ] 第一轮人工验收表已填写，包含四站样本、执行人、日期和结果。
- [ ] 第二／三轮人工验收表已填写。
- [ ] 第六轮管理、面板 AI 和 settings v5 验收表已填写。
- [x] 真实 Qwen ASR 联调记录已填写，包含样本、延迟、失败率和结果。
- [x] 真实 AI 总结及面板 AI 联调记录已填写。
- [ ] 四个单元的版本矩阵已更新为实际发布版本。
- [x] README／验收文档中的测试数量已更新为本次实测值。
- [x] 已明确记录 Worker 无租约、失败音频宽限清理未实现等保留限制。
- [x] 已明确邮件方式：私人本地试用使用 dev outbox，或外部试用已接真实邮件服务。
- [ ] 所有 NO-GO 项均已关闭，或有明确的发布决策记录；不得仅口头略过。

```text
执行人／日期：Kimi／2026-11-16；真实 Qwen ASR／AI 联调：Kimi／2026-11-17
结果／证据：本清单已记录 1358 pass／0 fail；阶段 3.5 Worker 停启恢复已于 2026-11-18 实测通过，同时明确「claim 后停止 Worker 无租约自动恢复」为保留限制；阶段 3.7 失败段保留已实测（音频保留+错误落库），「失败段宽限期自动清理尚未实现」仍为保留限制；阶段 0.2 明确邮件使用 dev outbox。
真实 Qwen ASR 联调记录（2026-11-17，模型 qwen3-asr-flash，Bailian compatible-mode）：
- 样本：macOS `say` 合成的 12.9s 中文语音（m4a，53KB，样本存 docs/evidence/asr-samples/qwen-asr-sample-01.m4a）
- Provider 直连冒烟：3/3 成功，延迟 0.50–0.65s；转写文本与原文仅"联调→连接"一词之差，语义完整
- 端到端链路（dev API :8787 + Worker provider=qwen）：登录 → 收藏 → 会话 → 上传音频段 → Worker 真实转写 → GET transcript 回读成功，首轮轮询（≤5s 间隔）即拿到文本，ASR 段延迟 <5s，失败率 0/1
- Worker 配置切换：apps/worker/config.json provider stub→qwen（真实 key 此前已配置）；API 重启后加载新邀请（邀请CLI写文件后需重启API，为一处操作注意点）
真实 AI 总结联调记录（2026-11-17，模型 qwen3.8-flash）：
- 同一资源的课程总结 POST /v1/resources/{id}/summaries → 201，延迟 9.32s
- 输出为真实合成总结（核心要点／已覆盖内容／尚未覆盖范围三节），citations 逐字引用转写文本并可回查，非 stub 回显
- API 直连冒烟（chat/completions）：HTTP 200，约 5s
问题／issue：关联人工验收表和四单元版本矩阵未完成或未核实；所有阶段 0–5 的 NO-GO 项仍开放（双账号、必填样本、四站完整链路等），故其余项目不勾选。
```

### 6.4 最终发布确认

```text
最终版本：扩展 0.2.31／Web 0.1.14／API 0.2.5／Worker 0.2.3
最终 Commit：0e73f73（已推送 origin/productization/integration，2026-11-17；本轮全部开发改动已提交，无未提交代码）
发布包：apps/extension/dist/learning-digest-v0.2.31.zip；SHA-256 422456950cab841b70e4e1a75c85d9f59b86abf9963b1fe0b1c05c29abc6f446
验收执行人：Kimi
复核人：未复核
完成日期：验收执行记录日期 2026-11-16；发布验收尚未完成
遗留问题及对应 issue：双账号／双 Profile／管理员未准备；多项必填样本缺失；真实 ASR／AI 已启用并联调通过（2026-11-17），但四站完整学习链路、字幕直归档与零 ASR、Worker 停启、管理及迁移未验收，发布包未做干净安装冒烟（dev.sh 误报已修复并验证）。本轮未新建对应 issue。
2026-11-17 新增（验收中修复，未提交）：多段学习同一视频产生多份逐字稿副本，课程总结输入重复文本。已修复——Web 0.1.16 mergeTranscriptViews 将资源的多次学习合并为一份时间轴展示（重叠区间保留文本最长副本，等长时字幕后于语音转写、再按 sessionId 取小，规则与 API 一致），API 0.2.7 collect_material 对总结输入做同样的合并去重与 gap 折叠。已在真实数据（res_UE0t50YFAUmHPaio，3 次学习）验证：43 段合并连续时间轴，页面显示「43 段 · 合并 3 次学习」。修复前生成的旧总结仍基于重复输入，需重新生成。
2026-11-17 新增（生成总结 502 三连修复，均已提交推送）：
1. 双根因 502（commit 5e27f8b，API 0.2.6／Web 0.1.15）：① 插件侧——r4 前持久化的旧 usage 行缺少 rollingSummary/digest/explain 计数字段，生成成功后记账瞬间 KeyError: 'digestCount' 崩溃，整个请求 500（/private/tmp/learning-digest-dev/logs/api.log 4 条同源 traceback）；usage.py 新增 with_defaults() 读取时回填缺失字段、下次写入自动升级行，usage_view 同步容错。② Web 侧——/v1 反向代理超时仅 10s（apps/web/lib/proxy.js），真实生成常超 10s 被掐断显示「学习服务暂时不可用」；13:17 用户那次 Web 生成实际已在服务端 201 落地，仅响应被代理截断。代理超时提升至 125s（盖过上游 AI 的 120s aiTimeoutMs）。验证：GET /v1/usage 对旧行不再 500，重启后真实旧行被自动升级为完整 schema。
2. 实测暴露滑窗塌缩（commit 4cf38c9，API 0.2.8／Web 0.1.17）：0.2.7 合并规则把「任何重叠」都视作重复，而 YouTube 字幕是滑窗切片（相邻段重叠 ~50%，整链传递），collect_material 与 mergeTranscriptViews 都把整份逐字稿塌成 1 条——res_aGg98HyEdUk6J0w7 的总结素材从 19,034 字符塌到 37 字符，生成的总结只有一段引文。修复：只有近重复（一段覆盖另一段较短者 ≥80%）才合并；跨会话完全相同副本去重、滑窗邻居全部保留。真实数据验证：511 段恢复。两端各新增滑窗回归测试（test_summaries_sliding_window.py／merge-transcript.test.js）。
3. Qwen3 思考超时（commit 6f625ec，API 0.2.9）：流式探针实测 qwen3.8-flash 在 511 行合并逐字稿（38,437 字符）上 reasoning 218 秒才输出第一个内容 token，超过 aiTimeoutMs=120s，长视频生成一律 502。所有产品生成统一带 chat_template_kwargs.enable_thinking=false；同一 prompt 实测 38.9s 出完整结果。
最终端到端实测（res_aGg98HyEdUk6J0w7《Pstack: How a Cursor Engineer Ships Code With AI》，4 次学习 3 份完整逐字稿）：POST /v1/resources/{id}/summaries → HTTP 201／34.65s，inputChars 39,244，输出 2,916 字结构化中文总结（六大开发阶段、多模型竞技场、TDD、D-slop 清理等核心内容准确覆盖）。
测试：扩展 767／API 305／Web 190 全绿（本轮实测值，较 6.1 的 2026-11-16 基线 1358 合计有增量）。
遗留：① 该资源历史里仍留有 1 段素材生成的劣质总结（sum_yMvMMKE9C9Wgxpry），需删除或重新生成覆盖；② 其他资源上 0.2.7 合并前基于重复输入生成的旧总结同理需重新生成。
```

- [ ] 阶段 0–5 全部为 GO。
- [ ] 阶段 6 自动化和安装冒烟全部通过。
- [ ] 真实平台、真实 ASR、真实 AI 的证据均可回查。
- [ ] 发布说明中的能力、限制和实际行为一致。

**最终结论：NO-GO**

```text
结论说明：自动化合计 1358 pass／0 fail，发布结构检查与扩展打包通过，匿名管理接口返回 401；B 站真实原生字幕轨读取成功；2026-11-17 真实 Qwen ASR／AI 均已启用并联调通过（直连与端到端证据见 6.3）。以上仅是部分通过项。完整真实平台链路（四站学习链路）、双账号隔离、管理迁移和发布包安装冒烟仍未完成，不能发布为 P0 GO。
签字／日期：Kimi／2026-11-16；2026-11-17 补充真实 ASR／AI 联调（验收记录，不代表发布签字）；复核人待补
```

---

## 附录 A：服务存活检查排障步骤（2026-11-18 实测补充）

**典型症状**：扩展侧栏显示「先关联学习库账号／暂时连不上学习服务，请检查设置中的学习服务 API 地址」，点「开始学习」无响应。此时应先怀疑后端服务，**不要**反复点开始、清除记录或重装扩展。

**检查步骤（按序执行）**：

1. `scripts/dev.sh status` —— 按进程探测 api／web／worker 三个单元，与启动方式、端口占用无关，最可靠。
2. 交叉验证：`ps aux | grep -E 'uvicorn|worker.main' | grep -v grep` 应至少各见一条进程。
3. API 存活：`curl -m 3 http://127.0.0.1:8787/v1/site-capabilities`（或任意 /v1 路径）——返回 JSON（即使是错误码）即存活；注意 `/health` 不是有效路径，返回 `not_found` 属正常。
4. Web 存活：`curl -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/` 期望 200。
5. 日志：`/tmp/learning-digest-dev/logs/{api,worker,web}.log`（注意：正常运行的日志内容很少，只有启动行，无输出不代表异常）。

**恢复步骤**：

1. `scripts/dev.sh start` —— 自动跳过端口仍占用的单元，只拉起 DOWN 的单元，无需先 stop。
2. 扩展侧栏点「我已完成关联，重新检查」——服务恢复后扩展会自动回到已登录态，无需重新授权。

**已知坑（dev 环境）**：dev.sh 拉起的进程若由带超时的 shell／后台任务托管，任务超时被杀时会连带杀掉同一进程组内的 api／web／worker。2026-11-18 11:25–11:40 的「小红书无法采集」事故即此因：三服务全挂，扩展显示连不上学习服务；服务重启后实测会话 ses_Cr67mZeSXY5mjuuT 14/14 段全部成功、随视频播完自动收尾，链路本身无缺陷。**启动服务必须使用不受超时回收影响的守护方式。**

**部署待办（owner 决策，开发结束后执行）**：正式部署时必须为 api／worker／web 三单元配置守护程序（systemd／launchd／supervisor 任选），要求：崩溃自动拉起、开机自启、日志轮转、独立于任何交互式 shell 生命周期。当前 dev.sh 仅适用于开发环境，不满足部署形态。

```text
排障实例记录：2026-11-18 11:40 用户报告小红书无法采集。排查：dev.sh status 显示三单元全 DOWN
（此前一个带 600s 超时的后台任务被杀，带走进程组）；dev.sh start 重启全套后扩展点「重新检查」
恢复登录；小红书页面刷新后视频被站点自动暂停（需真实用户手势恢复播放，脚本 play() 会被拦）。
新会话 ses_Cr67mZeSXY5mjuuT 实测 14/14 段真实转写、零失败、自动收尾。
```

---

## 附录 B：窗口 203 人工复验 runbook（2026-11-19）

**背景**：11-19 的隔离 Edge 环境完成了一批活体验证（见 1.1／1.3／1.4／1.5／1.6 记录），
以下事项被 Chrome/Edge 的真实交互门槛（工具栏图标调用、站点登录态）挡住，需在共享
Profile 的窗口 203 人工完成。前置：`scripts/dev.sh status` 三单元 RUNNING；
`chrome://extensions` 重载 Learning Digest（版本应显示 0.2.35；重载保留凭据与设置）；
插件显示已关联 newuser@example.com。

### B1. 1.3 bug a 软切换复验（B 站已登录走字幕路径，无需工具栏点击）

1. 打开 `https://www.bilibili.com/video/BV1ZA411g7Sb/?p=1`，等 P1 可播。
2. 侧栏对该标签页开始学习，确认面板逐字稿在滚动（登录态 ai-zh 字幕路径）。
3. 记下服务端 session id（`apps/api/data/state.json` 最新 active，或
   `GET /v1/resources` 看进度 revision 变化）。
4. 播放约 30 秒后，在播放页内点分集列表切到 P2（软切换，不要整页刷新）。
5. 立即核对：面板弹「课程页已切换到其他视频或分集，本次学习已自动结束并保存进度」；
   **服务端该 session 立即 status=finished**（不是等下次操作才收尾）。
6. 核对收藏标题：P1=「【00-AE先导课】…」、P2=「【01-AE概念篇】…」，各自独立资源。
7. 判定：第 5 步即时 finished ⇒ bug a 修复活体通过；仍 active ⇒ 回归，停止勾选并回报。
   备注：若第 2 步字幕不可用走了 ASR 路径，先按指引点一次工具栏图标再开始。

### B2. 1.5 小红书（需登录态）

- XHS-01 视频：收藏 → 开始学习（进度/时间戳笔记）→ Web 回查。视频被站点自动暂停时
  需真实用户手势恢复（见附录 A 排障实例）。
- XHS-02 图文：收藏 → 换分享 token 重收藏验证去重 → 无时间戳笔记 → Web 回查。
- 「只展示时间戳」半句：用图文样本验证笔记时间戳展示但无错误回跳。

### B3. 1.6 工具栏调用（记录 Chrome 实际要求的步骤与弹窗）

1. 全新标签页打开任一课程页，**不点图标**直接开始学习 → 记录指引文案与行为。
2. 按指引点击工具栏 LD 图标 → 记录 Chrome/Edge 是否弹权限、授权或侧栏行为。
3. 再次开始学习 → 记录采集是否启动（面板出现计时与逐字稿/音频状态）。

### B4. 1.1 双向授权引导（pendingLinkTabs 缺陷已修 0.2.36，剩余为 happy path 复验）

0. 先在 chrome://extensions 重载 Learning Digest（0.2.36）——注意：仅重启浏览器不
   刷新 MV3 service worker 脚本缓存，必须走重载（隔离装置实测，见 1.1 环境注记）。
1. Web 登录账号 B，插件侧点「打开授权页并关联」。
2. **在授权页停留超过 1 分钟**（等 MV3 service worker 休眠一轮）再完成登录与确认。
3. 预期（修复后）：确认后插件自动完成关联并回选择页；若仍停留在「关联码已生成」
   无自动连接 ⇒ 修复未在 Chrome 生效，回报并按缺陷重开。
4. 双向踢出：Web 退出 → 插件下次操作回授权引导；插件退出 → Web 回登录页。
