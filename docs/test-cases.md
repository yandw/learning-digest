# 测试用例清单

状态:一期平台整合(spec #49)三轮完成时点,tip `fee2329`(2026-11-12);第四轮 ticket 4.6(#82)起服务层(apps/api、apps/worker)仅保留 Python 实现,测试命令为 pytest(Node 版已删除)。
配套验收步骤文档:[docs/round1-acceptance.md](round1-acceptance.md)(第一轮时点快照)、[docs/round2-acceptance.md](round2-acceptance.md)(第二/三轮统一入口)。

## 0. 如何运行与分层定义

```bash
npm test                 # 浏览器插件(根 tests/)+ 发布检查引用的套件入口
node --test contracts/   # 三端共享契约样例校验
cd apps/api   && uv run pytest tests/ -q   # 或 uv run python -m app.main 启动服务(默认 127.0.0.1:8787)
cd apps/worker && uv run pytest tests/ -q  # uv run python -m worker.main 启动转写 Worker
cd apps/web   && npm test   # npm start 启动 Web 学习库(默认 127.0.0.1:8080)
npm run check            # 发布形状检查(manifest/allowlist/importScripts/content_scripts)
npm run package          # 打包扩展 zip
```

分层标识:

- **U1 单元**:纯函数/状态机,node:test + stub,无网络。
- **U2 集成**:单进程内 HTTP(loopback ephemeral 端口)或跨模块接线。
- **U3 端到端**:多进程真实链路(本地 stub upstream / 子进程启动),无外部网络。
- **M 人工**:真实浏览器 + 真实平台/服务,步骤在验收文档(§ 引用)。

统计(tip fee2329 + 第四轮 4.6 切换后):contracts 52 · api 214(pytest) · worker 28(pytest) · web 156 · 插件(根)695,合计 **1145 pass / 0 fail**。

---

## 1. 契约层 contracts/

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-C-01 | 契约 fixtures 可解析且符合结构定义(r1:数据结构/端点/错误码) | U1 | `contract-fixtures.test.js` |
| TC-C-02 | 六组 r1 端点 + §3.7 PATCH 的 endpointTemplate 与状态→错误码映射 | U1 | `contract-fixtures.test.js` |
| TC-C-03 | 四站 Platform Video ID 提取:小鹅通 token(p_/v_/a_/i_/l_/term_)、B站 BV+p、YouTube v=、小红书 note id(含大写 hex) | U1 | `platform-video-id.test.js`(全量对照 source-matching.json) |
| TC-C-04 | URL 归一化:追踪参数忽略、分集参数保留、url-exact 兜底 | U1 | `platform-video-id.test.js` |
| TC-C-05 | r2 契约:Session 生命周期/captions 直归档/audio-segments 上传/任务状态机/TranscriptView 四数组/gap 语义样例跨文件一致 | U1 | `contract-r2-fixtures.test.js` |
| TC-C-06 | r2 错误样例(session_already_finished、origin conflict、段重复)形态固定 | U1 | `contract-r2-fixtures.test.js` + `error-examples.json` |
| TC-C-07 | r3 契约:Summaries 端点/Citation 结构/usage 样例;引用必须命中 r2/r3 真实归档记录、quote 逐字摘句、补学生成引用新 Session | U1 | `contract-r3-fixtures.test.js` |
| TC-C-08 | r3 错误样例(no_transcript_to_summarize、summary_generation_failed) | U1 | `contract-r3-fixtures.test.js` |

## 2. 后端 API apps/api/(214,pytest)

### 2.1 账号与凭据(决策 3)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-A-01 | 受邀邮箱 request-code→verify 全流程开通并签发凭据;二次登录不重复开通 | U2 | `test_auth_request_code.py`、`test_auth_verify.py` |
| TC-A-02 | 未受邀/错误/过期验证码统一 401 防枚举文案;字段缺失 400 | U2 | `test_auth_verify_failures.py` |
| TC-A-03 | 防爆破:6 位码 SHA-256+timingSafeEqual、10 分钟有效期、60s 重发冷却(冷却内 200 不重发)、5 次尝试作废 | U2 | `test_auth_request_code.py` |
| TC-A-04 | 凭据组:同账号登录入同组;组 revokedAt 整组失效;revokeCredentialGroup 原语 | U2 | `test_credentials_group.py` |
| TC-A-05 | logout=整组撤销(Web+插件全灭);重复退出 200 幂等;从未存在的 token 401(P7 接管) | U2 | `test_auth_logout.py` |
| TC-A-06 | link-requests(一次型 code,10min TTL,用后即废,组撤销拒发)/link(兑换入同组);CORS 预检与回显 | U2 | `test_auth_link.py` |
| TC-A-07 | GET /v1/me Bearer 守卫;无凭据/坏凭据 401 形态与契约逐字一致 | U2 | `test_auth_me.py` |
| TC-A-08 | dev mailer:验证码落 outbox JSONL+stdout,可被测试读取 | U2 | `test_dev_mailer.py` |
| TC-A-09 | 邀请登记 CLI(add/list,seed 文件;须 API 启动前登记) | U2 | `test_invite_script.py` |
| TC-A-10 | 服务入口:PORT=0 ephemeral 真实子进程启动 | U3 | `test_server_entry.py` |

### 2.2 收藏与来源匹配(决策 1)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-A-11 | POST /v1/resources:identity 命中优先→归一化地址;无 identity 服务端共享模块兜底;201/200 同构,原始 URL 保留首次 | U2 | `test_resources_create.py` |
| TC-A-12 | 匹配语义:B站多分集独立 Source、等价分享链同一条、同名分别收藏、identity 命中失败不回退地址匹配 | U2 | `test_resources_matching.py` |
| TC-A-13 | 畸形 identity 400 validation_failed(未知平台/格式不符/小鹅通缺 scopeId 等) | U2 | `test_resources_create.py`、`test_resources_matching.py` |
| TC-A-14 | GET 列表(createdAt 倒序+progress 投影)/详情(resource+sources+notes);跨账号 404(D2) | U2 | `test_resources_list_detail.py` |
| TC-A-15 | POST /v1/sources/resolve 只读不写;matched true/false;identity 优先否则 URL | U2 | `test_sources_resolve.py` |
| TC-A-16 | PATCH title:仅 {title} 非空、多余字段拒绝、校验先于存在性;跨账号 404 | U2 | `test_resources_retitle.py` |
| TC-A-17 | 双账号并发收藏同 URL 各自独立(隔离) | U2 | `test_resources_matching.py` |

### 2.3 进度与笔记

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-A-18 | PUT progress 乐观并发:首写 rev1/更新 rev2/409+current(无进度 current={null,0});回拖合法;四 fixture 逐字断言 | U2 | `test_sources_progress.py` |
| TC-A-19 | 进度幂等重发:同 rev 同 pos 200 不 bump;同 rev 不同 pos 正常 bump | U2 | `test_sources_progress.py` |
| TC-A-20 | POST notes:clientRequestId 全域幂等(跨 resource 重用同 id 返回原笔记);sourceId+positionMs 成对且须指向该 Resource 名下来源 | U2 | `test_resources_notes.py` |
| TC-A-21 | notes 校验顺序 400→404(D2)→400 指针;GET 详情 notes 升序接真数据 | U2 | `test_resources_notes.py` |

### 2.4 Session / 字幕归档 / 音频与任务(决策 D9–D15)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-A-22 | POST sessions(201 open)/finish(重复 409 幂等语义)/跨账号 404;同 Source 多 Session 互不串 | U2 | `test_sessions_lifecycle.py` |
| TC-A-23 | POST captions 直归档:origin=captions 锁定,反向提交 409 transcript_origin_conflict 双向 | U2 | `test_session_transcripts.py` |
| TC-A-24 | GET transcript TranscriptView 四数组恒在场;轮询幂等、终态单调 | U2 | `test_session_transcripts.py` |
| TC-A-25 | GET /v1/resources/{id} 携带历次 Sessions 摘要;进度端点零改动(D9) | U2 | `test_sessions_lifecycle.py`、`test_session_transcripts.py` |
| TC-A-26 | POST audio-segments:base64+segmentIndex 首存为准、乱序归位、11MB cap;校验顺序与 captions 对齐 | U2 | `test_audio_segments_upload.py` |
| TC-A-27 | 任务状态机 pending→transcribing→done|failed 终态不回退;pending 回写 400 | U2 | `test_worker_tasks.py` |
| TC-A-28 | worker claim/result 端点:LD_API_WORKER_TOKEN timing-safe、空值 fail closed、用户凭据 401;claim limit≤10 钳制 | U2 | `test_worker_tasks.py` |
| TC-A-29 | **崩溃窗口自愈**:存了段但任务丢失→重发以新音频补建入队;再重发不重复入队 | U2 | `test_audio_segments_upload.py`(r2-review) |
| TC-A-30 | D14:done 即删音频文件、failed 保留 | U2 | `test_worker_tasks.py`、`test_audio_chain.py` |
| TC-A-31 | 完整链路:收藏→Session→上传→worker→GET transcript 可见(含双账号隔离) | U2 | `test_audio_chain.py` |

### 2.5 课程总结与用量(决策 D16–D18)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-A-32 | AI Provider seam:stub 确定性(同输入同输出);qwen 请求形状/不可解析→throw;**AbortSignal 每次 generate 新建**(构造期单次创建缺陷回归钉) | U2 | `test_ai_providers.py` |
| TC-A-33 | POST summaries:聚合全部 Sessions transcripts+notes;prompt 组装按 prompts/course-summary.md 四变量逐字;inputChars=全文码点 | U2 | `test_summaries.py` |
| TC-A-34 | 引用清洗 reconcileCitations:session 归属/区间精确命中/quote 逐字,不合规丢弃;全无效 citations=[] 仍落正文 | U2 | `test_summaries.py` |
| TC-A-35 | 409 no_transcript_to_summarize(gap-only、未归档 active session,provider 未被调用);502 不落任何记录、usage 不动、可重试 | U2 | `test_summaries.py` |
| TC-A-36 | 补学再生成故事:引用 ses_33/32/34 verbatim、citationCount 3→4、inputChars 增长、历史保留 | U2 | `test_summaries_story.py` |
| TC-A-37 | GET /v1/usage:audioSeconds 段 done 首存累加(重放不重复、静音 done 计入);summaryCount/Chars 落库时记;全新账号 updatedAt=null | U2 | `test_usage_audio.py` |
| TC-A-38 | server 入口:LD_AI_* env、server.timeout=max(10s, aiTimeoutMs+5s) | U3 | `test_server_entry.py` |
| TC-A-39 | 发布元数据 0.2.0 独立 pin(pyproject.toml;4.6 切换后即权威元数据);受邀 seed 文件为 JSON 数组 | U2 | `test_release.py` |

## 3. 转写 Worker apps/worker/(28,pytest)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-W-01 | loadWorkerConfig env 默认与覆盖;unknown provider/qwen 无 key 启动即抛(fail fast) | U1 | `test_config.py` |
| TC-W-02 | stub provider:确定性记录;零字节音频=静音段([]) | U1 | `test_stub_provider.py` |
| TC-W-03 | qwen provider:base64 Data URI 请求形状、HTTP 失败抛 providerHttpError、缺 key 构造期失败(注入 fetch,不真连) | U1 | `test_qwen_provider.py` |
| TC-W-04 | runOnce:claim→转写→回写;静音段 done;provider 失败提交 transcription_failed(契约形态);claim 失败传播到 cycle 级 | U2 | `test_run_once.py` |
| TC-W-05 | runLoop:串行多任务按 claim 序;provider 级失败计任务级;空 claim 空转 | U2 | `test_loop.py` |
| TC-W-06 | client:claim/result 请求形态与服务凭据头 | U2 | `test_client.py` |
| TC-W-07 | 发布元数据 0.2.0 独立 pin(pyproject.toml;4.6 切换后即权威元数据);运行时仅 httpx | U2 | `test_release.py` |

## 4. Web 学习库 apps/web/(156)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-B-01 | 登录流状态机:邮箱→code→verify→壳;错误文案与契约逐字;request-code/verify 的 401 不清凭据(表单错误) | U1 | `login-flow.test.js` |
| TC-B-02 | api-client:Bearer 注入、auth:false 不带、已认证 401→清凭据 onUnauthorized(P7 挂钩) | U1 | `api-client.test.js` |
| TC-B-03 | /v1 反代:方法/头/body/错误逐字透传;upstream 不可达 502 契约形封套;PATCH 转发 | U2 | `proxy.test.js` |
| TC-B-04 | 静态与 vendor:/vendor/platform-video-id.js 与 contracts 源字节相等;link.html 服务 | U2 | `static.test.js` |
| TC-B-05 | 收藏流:identity 客户端提取→POST→201/200 去重呈现;列表徽标+「上次学到 mm:ss」;详情 | U1 | `library-flow.test.js` |
| TC-B-06 | PATCH title 编辑保存 | U1/U2 | `library-flow.test.js` |
| TC-B-07 | 笔记读回:mm:ss、回跳 URL(B站 t=/YouTube t=..s 保留 p=)、不可回跳仅展示 | U1 | `library-flow.test.js` |
| TC-B-08 | 逐字稿回查:多 Session 倒序、origin 徽标、pending/failed/gaps 呈现;二次拉取与单块失败降级 | U1 | `library-flow.test.js` |
| TC-B-09 | link-flow 授权确认页状态机(checking→login→confirm→issuing→issued) | U1 | `link-flow.test.js` |
| TC-B-10 | session-revalidate:visibility/focus 静默 /v1/me,401 清凭据;30s 冷却;并发去重 | U1 | `session-revalidate.test.js` |
| TC-B-11 | Markdown 安全渲染:**从不产出 HTML 字符串**、零 innerHTML;`<script>`/`<img onerror>` 字面化;支持面最小(降级字面) | U1 | `markdown.test.js` |
| TC-B-12 | 生成总结:飞行期禁用+防抖、201 聚焦新记录、历史切换缓存、跨资源导航守卫、409/502 呈现、引用回跳(sessionId→sourceId 映射) | U1 | `library-flow.test.js` |
| TC-B-13 | 用量面板:口径格式化、updatedAt=null→「从未产生用量」 | U1 | `library-flow.test.js` |
| TC-B-14 | 服务入口真实子进程;发布元数据 0.1.5 pin | U3/U2 | `server-entry.test.js`、`release.test.js` |

## 5. 浏览器插件(根 tests/,695)

### 5.1 账号门槛与关联(P6)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-P-01 | auth-gate 纯模块:凭据解析、/v1/me 探测、extractLinkCode、code 兑换;unreachable 不误杀凭据 | U1 | `auth-gate.test.js` |
| TC-P-02 | 四态:未登录引导(功能入口全隐藏)/已登录未确认/确认后解锁原 PoC 序列不变/失效回引导 | U2 | `plugin-auth-flow.test.js`、`panel-ia.test.js` |
| TC-P-03 | 图标点击路径授权缓存快判(手势不可过 await,0.1.22 教训) | U2 | `plugin-auth-flow.test.js` |

### 5.2 收藏与来源(P8)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-P-04 | collect.js:请求构建(201/200 映射)、§3.4 resolve 解析、http(s) 守卫 | U1 | `collect.test.js` |
| TC-P-05 | 收藏流:bridge 标题优先、点击前权威 checkAuthNow、resolve 本地短路不打 API、401→authState | U2 | `plugin-collect-flow.test.js` |

### 5.3 开课/进度/续学(P10/P10b/P11)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-P-06 | 课程标签页列表与目标锁定状态机;选择/锁定/解锁;焦点切换不改记录目标 | U1 | `learning-start.test.js` |
| TC-P-07 | 进度写入客户端:10s 节流合并+关键事件立即写;409 采纳 current.revision 重试(上限 3);退避 2s/8s/30s 重发同 rev+pos | U1 | `learning-start.test.js` |
| TC-P-08 | 续学/从头:seekMedia 定位不写进度;paused 首拍立即写;恢复同 Session(id 不变) | U1 | `learning-start.test.js` |
| TC-P-09 | 收尾触发矩阵:手动/播完 media-end/关标签页 tabs.onRemoved/换视频分集(identity 比对,?t= 不误杀);flush+解锁;分集切换换 Source 隔离 | U2 | `plugin-learning-start-flow.test.js` |
| TC-P-10 | 三站 Source Platform 适配器(never throw,防御式)+ startable 判定扩展 | U1 | `source-platforms.test.js` |
| TC-P-11 | page-bridge 工厂:位置流/getMediaPosition/seekMedia(clamp+play 不判失败);B站 ?p=N pageUrl 可检测;xiaoe 零回归 | U2 | `page-bridge.test.js` |

### 5.4 逐字稿管线与字幕路径(二轮)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-P-12 | transcript-pipeline:POST sessions→30s 分段 base64 上传(幂等键字节级重放 2s/8s/30s)→轮询(4s 拍,退避封顶 30s)→逐段渲染;终态 stand-down(transcriptPollDone);409 origin 停传;401→P7;start 失败关孤儿 Session | U1 | `transcript-pipeline.test.js` |
| TC-P-13 | 管线接线:开始学习→上传→「转写中」→逐段出现→四类收尾 flush+finish;双 finish 缺陷回归钉(tail flush 先于 finish) | U2 | `plugin-transcript-pipeline-flow.test.js` |
| TC-P-14 | bilibili-captions:双探针(`__INITIAL_STATE__`→player.getVideoDetail)、CC 优先、aisubtitle JSON 映射毫秒、available:false+reason 不误报、fetch 失败换轨、**无 fetch 短路不真连** | U1 | `bilibili-captions.test.js` |
| TC-P-15 | youtube-captions:上游移植(selection/fallthrough verbatim)、隔离世界 ytInitialPlayerResponse 提取、帧所有权 videoId 匹配、SPA 陈旧静默 | U1 | `youtube-captions.test.js`、`youtube-captions-upstream.test.js` |
| TC-P-16 | 字幕归档流:capturePath:"captions" 零 provider gate、session-archive 客户端、三态渲染、origin 从服务端视图取(409 后不显示已锁) | U2 | `plugin-bili-captions-flow.test.js`、`plugin-yt-captions-flow.test.js` |
| TC-P-17 | session-archive 客户端:isValidSegment/computeCaptionCoverage(经 transcript-shapes 共享,含防御 re-check)、轮询首拍+15s 慢拍 | U1 | `session-archive.test.js` |
| TC-P-18 | 强制转写:覆盖不全→推迟归档决策态(跨重启恢复);未归档→同 Session 切 ASR 不提交字幕(409 双保险 verbatim);已归档→新 Session;endActiveSession 未决策默认原样归档 | U1/U2 | `plugin-force-transcribe-flow.test.js`、`session-pipeline.test.js` |

### 5.5 笔记/联动退出/设置(一轮+二轮)

| ID | 用例 | 层级 | 验证位置 |
|---|---|---|---|
| TC-P-19 | notes.js:请求构建/幂等键稳定/草稿保留复用原 clientRequestId/毒草稿清除;时间戳=媒体位置,读不到落纯文本 | U1 | `notes.test.js`、`plugin-note-timestamp.test.js` |
| TC-P-20 | 联动退出:登出撤组+清凭据+停采;断网仍登出;401 中途失效停采保留 records/breadcrumbs;重登→重新关联解锁;Web visibility 校验在插件侧的对应探测 | U2 | `plugin-logout.test.js` |
| TC-P-21 | settings v4 迁移:speechProvider/stt* 输出清除、存量 ASR key 读写即清;apiBaseUrl/webAppBaseUrl;面板 IA(授权态/欢迎态/学习态) | U1/U2 | `settings.test.js`、`panel-ia.test.js`、`options-check.test.js` |
| TC-P-22 | #48 回归:anchor/seek/hole-fill 61 测试全部重接到上传+轮询缝(echo transcript stub + pollTranscriptForTest) | U2 | `session-timeline.test.js`、`session-segmenter.test.js` 等 |
| TC-P-23 | 发布形状:三处版本 pin 一致、allowlist/importScripts/content_scripts 形状、manifest 权限(tabs,无 host_permissions 放宽) | U2 | `release.test.js` + `npm run check` |

## 6. 人工验收用例(M)

> 步骤全文见验收文档;此处为用例索引。**带 ⚑ 的需要真实外部资源(平台样本/真实 key/邮件账号)。**

### 第一轮(收藏与续学)→ docs/round1-acceptance.md §2/§3

| ID | 用例 | 文档引用 |
|---|---|---|
| TC-M-R1-01 ⚑ | 邀请登记(API 启动前)→Web 验证码登录→授权页关联插件(四态:未登录/未确认/确认/失效) | round1 §2.1–2.2 |
| TC-M-R1-02 ⚑ | 四站各一条可播放视频:收藏→面板选标签页(含后台)→开始学习→进度落库→拖拽/暂停→结束 | round1 §2.3 |
| TC-M-R1-03 ⚑ | B站多分集独立进度;换视频/分集自动收尾 | round1 §2.3 |
| TC-M-R1-04 | 普通网页/小红书图文收藏与纯文本笔记;重复收藏返回同一条 | round1 §2.4 |
| TC-M-R1-05 | 联动退出:Web 退出→插件回引导+停采;插件退出→Web 回登录页;旧凭据 401 | round1 §2.5 |
| TC-M-R1-06 | 双账号隔离:收藏/进度/笔记互不可见;过期进度 409 | round1 §2.6 |
| TC-M-R1-07 ⚑ | tabCapture 后台标签页授权实测(计划文档明文须实测;结论占位待填) | round1 §2.7 |

### 第二/三轮(字幕或 ASR 与归档 + 课程总结)→ docs/round2-acceptance.md §2/§3

| ID | 用例 | 文档引用 |
|---|---|---|
| TC-M-R2-01 ⚑ | B站有字幕:全文展示+直归档,**零 ASR 三信号断言**(无采集指示/TranscriptView 无 pending/worker 无任务) | round2 §2.1 |
| TC-M-R2-02 ⚑ | YouTube 有字幕:同上 | round2 §2.2 |
| TC-M-R2-03 ⚑ | B站/YouTube 无字幕:ASR 接管(「转写中」+约 30s 分段逐段出现) | round2 §2.3 |
| TC-M-R2-04 ⚑ | 小鹅通回放/直播 + 小红书视频:采集→上传→逐段转写 | round2 §2.4 |
| TC-M-R2-05 | 强制转写三分支:覆盖不全原样归档/未归档切 ASR/已归档开新 Session | round2 §2.5 |
| TC-M-R2-06 | Web 回查:历次 Session、origin 徽标、gaps、时间戳回跳 | round2 §2.6 |
| TC-M-R2-07 | worker 停启韧性:停 worker→任务 pending 排队→恢复后处理;lease 未做的滞留现状记录(可选) | round2 §2.7 |
| TC-M-R2-08 | 归属复核:选定标签页/来源/账号/Session 归属抽查 | round2 §2.8 |
| TC-M-R3-01 | 两门课准备(A 有逐字稿,B 空) | round2 §3.1 |
| TC-M-R3-02 | A 未学完→生成总结→成功展示+引用回跳 | round2 §3.2 |
| TC-M-R3-03 | 补学 A→再生成→历史两条,新总结覆盖新增材料 | round2 §3.3 |
| TC-M-R3-04 | B 生成→409 无逐字稿文案 | round2 §3.4 |
| TC-M-R3-05 | 双课/双账号隔离:A/B 总结互不引用 | round2 §3.5 |
| TC-M-R3-06 | 用量对账:转写时长/总结次数/输入字符 | round2 §3.6 |
| TC-M-R3-07 ⚑ | 真实 Qwen ASR 链路(发布前至少一次,LD_AI_API_KEY 同场联调;含可选 502 演示) | round2 §5.4/§5.5 |

## 7. 已知限制相关的观察用例(非缺陷,验收时按现状记录)

| ID | 现象 | 出处 |
|---|---|---|
| TC-L-01 | worker 停机时 finished 会话的 pending 段在 Web 显示「转写排队中(会话已结束)」,lease 落地前滞留为预期 | D15 演进、round2 §4 |
| TC-L-02 | B站/YouTube 站内 SPA 软导航进入播放页不触发 content script 注入(学习库入口=新标签页,主路径不受影响) | P10b |
| TC-L-03 | 笔记/总结引用回跳:B站/YouTube 带参,小鹅通/小红书仅展示时间戳 | P12/#75 |
| TC-L-04 | 小红书图文笔记无时间戳(图文不提取身份,D6) | D6 |
| TC-L-05 | 多 Source 资料的总结聚合按裸毫秒合并穿插(回查可解析,分节留作演进) | D17 多 Source 记录 |
| TC-L-06 | 慢 API 时 Web 详情页整体 busy(并发拉取全部 session transcript) | r2-review 记录 |
| TC-L-07 | 收集/删除重复收藏无入口(用户故事 11 延期,决策 1 第 4 条) | #49 记录 |
