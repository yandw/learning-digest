# 视频时间轴逐字稿排序与拖拽补转 — 实施计划

## Goal

实现已确认的规格（`docs/superpowers/specs/2026-11-09-video-seek-transcript-timeline-design.md`）：

- 拖拽进度条（向前或倒回）后，逐字稿按视频时间轴统一排序显示与投喂 AI，而不是按识别结果返回顺序追加。
- 向前拖拽：提交已录内容，未覆盖区间标记“已跳过”；之后重新播放该区间可补转，补转成功才缩小跳过范围，补转失败保留空洞与失败标记。
- 倒回已覆盖区间：不重复 ASR，保留原稿。
- 倒回空洞/失败区间：从实际落点补转，结果按时间插入原顺序。
- 分段识别与百炼实时识别两种方式都支持。
- 静默（无文字）播放区间视为已覆盖。

## Architecture

统一时间轴视图（纯函数派生层）：

- 原始 `transcriptRecords` / `segments` 持久化结构不变，不迁移旧 Session 快照。
- 新增纯模块 `session-timeline.js`，从 session snapshot 派生“按视频时间排序的逐字稿”和“覆盖/空洞/失败区间图”。
- 侧边栏、Topic 摘要输入、学习纪要输入全部消费派生视图。
- 背景层采集决策（倒回到哪里、是否补转、是否 hold）基于同一派生视图 + 实时播放窗口（playbackWindows）。
- 页面桥接层监听 `seeking`/`seeked` 事件即时上报，3 秒规则仅作为事件丢失兜底。

## Tech Stack

Chrome MV3 扩展，纯 HTML/CSS/JavaScript，无构建。Node 内置 `node:test` 跑测试（`npm run check`）。

## Global Constraints

- 不提交 Git（除非用户明确授权）。
- 不创建 worktree、不用子代理。
- 不破坏 ADR 0002：Topic 追加策略不变，只改输入排序。
- 每次任务完成后跑相关测试；最后跑 `npm run check` 全量。
- 版本号 `0.1.53 → 0.1.54`（manifest.json + package.json + tests/release.test.js）。

## Task 1: 新增 session-timeline.js 纯模块与测试

### Files

- Create: `session-timeline.js`
- Create: `tests/session-timeline.test.js`

### API

```js
orderedTranscriptEntries(state)  // [{record, index}] 按 record.start 升序，同 start 按下标稳定
orderedTranscriptRecords(state)
buildTimelineView(state, playbackWindows = [])
// view = { entries, covered: [{start,end}], holes: [{start,end,kind}], failed: [...] }
isCoveredAt(view, position)
nextCaptureStart(view, position)
```

### buildTimelineView 分类规则

- `segments` 中 `status === "done"`：成功覆盖（无文字也算）。
- 普通 `transcriptRecords`（非 gap marker、非 failed）：成功覆盖。
- `playbackWindows`：实时模式播放并采集过的区间 → 覆盖。
- `segments` 中 `status === "failed"`：失败区间（可补转）。
- `record.failed === true` 且非 gap marker：失败区间。
- `YTD_SESSION_PIPELINE.isGapSkippedRecord(record)`：空洞（可补转）。
- 同一位置同时成功与失败/空洞：失败/空洞优先（保证可补转）。

### Implementation notes

- 纯函数，无 IO、无全局依赖（isGapSkippedRecord 由调用方以参数或全局注入——测试里 mock）。
- interval 合并时把 failed/hole 作为减法区间从 covered 中扣除。

### Test plan（`tests/session-timeline.test.js`）

- records 乱序输入 → 输出按 start 升序，同 start 稳定。
- done segment（无文字）算覆盖。
- gap marker 产出 hole，可补转。
- failed segment / failed record 产出 failed 区间。
- covered 与 hole 重叠时 hole 优先，`nextCaptureStart` 落在 hole 起点。
- playbackWindows 覆盖静音区间。
- 空 state 不抛错。

### Verification

- `node --test tests/session-timeline.test.js` 全绿。

## Task 2: AI 输入统一排序（session-summary.js）

### Files

- Modify: `session-summary.js`
- Modify: `background.js`（importScripts 加 `session-timeline.js`，约 line 24）
- Modify: `tests/helpers/load-background.js`（sandbox 注入 `YTD_SESSION_TIMELINE`）

### Steps

1. `assembleTopicTickInput`（约 line 130）和 `assembleGlobalPassInput`：改用 `orderedTranscriptRecords(state)`。
2. `formatTranscriptForPrompt`（约 line 299）支持按传入的有序数组输出（保持签名向后兼容，内部不再假设调用方顺序）。
3. Topic 追加策略不变。

### Test plan

- 现有 topic/global pass 测试仍通过（顺序对它们不变的影响 = 输入排序变化，需更新期望值如果有依赖原始顺序的断言）。
- 新增：records 乱序 snapshot → prompt 中逐字稿按 start 升序。

### Verification

- `node --test tests/` 中相关测试通过。

## Task 3: 侧边栏按时间插入渲染

### Files

- Modify: `sidepanel.html`（script 引用）
- Modify: `sidepanel.js`
- Modify: 相关测试 helper（如 `tests/report-panel.test.js` 的 `makeElement` 补 `insertBefore(child, ref)`）

### Steps

1. `sidepanel.html` 引入 `session-timeline.js`（在 sidepanel.js 之前）。
2. `sessionUi` 增加 `recordRows: new Map()`、`transcriptSessionId`。
3. `renderSessionTranscript`（约 sidepanel.js:1668）重写为 reconcile：
   - 用 `orderedTranscriptEntries(state)` 得有序 entry；
   - 每条原始记录（按 index 作 key）对应一个 DOM row（不存在则创建，appendChild 到容器）；
   - 更新已有 row 的时间、文本、失败样式；
   - 用 `insertBefore` 按有序顺序同步 DOM 位置；
   - state 中已消失的记录 → 删除对应 row；
   - sessionId 变化或 session 结束 → 清空 recordRows。
4. 保留现有 pending spinner 逻辑。

### Test plan

- mock 环境补 `insertBefore`。
- 新测试：乱序 records → DOM 行按时间顺序；补转记录插入到已有记录之前；sessionId 切换清空。

### Verification

- 侧边栏相关测试全绿。

## Task 4: 页面 seek 事件即时上报 + 3 秒兜底

### Files

- Modify: `page-bridge.js`
- Modify: `background.js`

### Steps

1. `page-bridge.js`：跟踪当前 `bridgedMedia`，找到主视频时添加 `seeking`/`seeked` listener；换主视频时移除旧 listener；seek 触发立即发送现有 `mediaPosition` 消息。每秒轮询保留为兜底。
2. `background.js`：
   - 新常量 `FORWARD_DRAG_THRESHOLD_SECONDS = 3`，删除/替换 `SEEK_JUMP_TOLERANCE_SECONDS`。
   - 向前拖拽判断改为 `position - previous > FORWARD_DRAG_THRESHOLD_SECONDS`（不再加 segmentLengthSeconds）。
   - 更新所有使用 `segmentLengthSeconds + SEEK_JUMP_TOLERANCE_SECONDS` 的位置：`handleSeekForward`、`updateRelisten` 深跳判断、realtime seek 判断。

### Test plan

- 背景层 seek 判断单测：jump 2.9s 不算拖拽、3.1s 算、倒回算。
- page-bridge 事件路径至少源码级验证（浏览器 API mock 过重的话做行为级 smoke）。

### Verification

- 相关测试全绿。

## Task 5: 分段补洞失败不能吞掉空洞

### Files

- Modify: `background.js`（`dispatchSegment` 约 line 1404、`dispatchFillSegment` 约 line 1941）

### Steps

1. `dispatchSegment(...)` 成功路径（`transcribeOk` 后）返回 `true`，失败路径（`transcribeFailed` 后）返回 `false`；普通调用方忽略返回值。
2. `dispatchFillSegment` 仅在返回 `true` 时应用 `gapFilled`；失败时保留原 gap marker 并写入失败标记。

### Test plan

- 现有 hole-fill 测试（#48）仍通过。
- 新增：补转失败 → gap 范围不缩小、存在 failed 标记。

### Verification

- 相关测试全绿。

## Task 6: 背景层实时时间轴上下文

### Files

- Modify: `background.js`（capture context、`persistContextPointer` 约 line 885、realtime message 处理、`mapUtteranceStart`）

### Steps

1. context/pointer 新增字段并持久化：`playbackWindows`、`playbackWindowStart`、`lastObservedPosition`、`realtimeOriginSeconds`、`realtimeHoldUntilSeconds`。
2. 连续播放：维护当前 playbackWindow。
3. 任何有效拖拽（向前阈值或倒回）：关闭旧 playbackWindow、以落点开启新窗口；向前拖拽按落点判断添加 `gapSkipped`（用 `buildTimelineView`）。
4. 倒回落点判断：
   - 空洞/失败区间 → `nextCaptureStart` 得补转起点，分段模式从该点 dispatch；实时模式以该点为 origin 重新上送（Task 7）。
   - 已覆盖区间 → hold：不上送音频，记录 `realtimeHoldUntilSeconds = nextCaptureStart`；播放到该点后 resume。
5. utterance 绝对时间：`absoluteStart = context.realtimeOriginSeconds + message.start`，替代 `mapUtteranceStart` 的“最后位置 - 句子长”估算；保留下界保护（不小于 origin）。
6. Worker 重启：从 pointer 恢复 realtimeOrigin 与 playbackWindows。
7. 向后拖拽再向前拖拽：丢弃未落定缓冲，防跨拖拽点拼接。

### Test plan

- 用户场景走查测试（mock time/ASR）：
  - 0→10 拖拽：gap 0–10；10 起转录。
  - 20→40 拖拽：提交已录；gap 20–40；40 起转录；记录到 45。
  - 倒回 30：gap 20–40 缩为 20–30；30 起补转；结果插入 40–45 之前；播过 40 不重复；45 后继续。
  - 倒回已覆盖区间：无 ASR 调用，hold→resume。
  - 静音区间倒回：视为覆盖，hold。
  - 补转失败：gap 不缩小。

### Verification

- 新增 + 现有测试全绿。

## Task 7: Offscreen 实时重基与 hold/resume

### Files

- Modify: `offscreen.js`

### Steps

1. `startRealtimeSession(apiKey)`（约 line 201）改为 `startRealtimeSession(apiKey, { originSeconds = 0, hold = false } = {})`。
2. `realtimeUtterance` 消息（约 line 364 处理）带当前 session `originSeconds`。
3. 新 actions（message router 约 line 674 注册）：
   - `captureRebase { originSeconds, hold }`：旧 session 发 `session.finish` → 等 `session.finished` 或超时 → 关旧 WebSocket（防止 close 触发自动重连）→ 保留 tab capture stream（不能复用 `stopRealtimeCapture`，它会 `shutdownCapture()`）→ 同 API key 开新 session。
   - `captureRealtimeResume { originSeconds }`：清 hold、更新 origin、清 accumulator、重置 utterance tracker 与 stream base、启动 PCM pump。
4. `captureStart` realtime 分支（约 line 651）传 `{ originSeconds }`。

### Test plan

- offscreen 是 browser-only：做源码级/轻量行为测试，锁定 action 名称、finish-before-rebase 顺序、origin 透传；背景层消息编排测试（mock offscreen 端口）覆盖 rebase/resume 发送时机。
- `stopRealtimeCapture`（约 line 483）现有测试不回归。

### Verification

- 相关测试全绿。

## Task 8: 发布检查与版本

### Files

- Modify: `scripts/check-release.sh`
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `tests/release.test.js`

### Steps

1. allowlist 和 required public files 加 `session-timeline.js`。
2. 版本 `0.1.53 → 0.1.54`（三处同步）。
3. `npm run check` 全量：420+ 测试全绿 + 发布检查通过。

### Verification

- `npm run check` 全绿。

## Checkpoint policy（替代 commit）

每个 Task 完成后：跑该 Task 相关测试 + `git diff --stat` 自查改动范围，再继续下一 Task。全部完成后向用户汇报 diff 摘要，等待是否提交的指示。
