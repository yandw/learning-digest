# 通用实时 AI 会议纪要引擎 — 技术设计 v0.1

> 状态：PoC 技术设计 / 待真实会议数据验证  
> 日期：2026-11-08  
> 目标：支持线上与线下会议的音频接入、流式转写、语义分段、会议事件识别、实时摘要、最终纪要与证据追溯。  
> 约束：优先中文会议；可替换 ASR 与 LLM；首版单机运行、单场会议、单用户操作；保留原始音频与版本历史。

## 0. 核心设计判断

1. **采集与总结解耦**：采集链路不能因 LLM 超时而停止；先保存音频，再做语义处理。
2. **四类窗口不同**：音频帧 20–40ms；话语 1–15 秒为常见目标；语义段 3–5 分钟为目标（2–8 分钟软约束）；阶段总结每 10–15 分钟或议题结束触发。
3. **不做随机文本采样**：全量归档，全部稳定话语进入事件检测；总结阶段根据证据价值选取上下文。
4. **事件先于摘要**：会议数据的真相层为音频、转写、带证据的事件；摘要只是可重建视图。
5. **时间与归属独立**：每条话语只有一个正式段归属；后续分段可引用重叠上下文，但不重复提取。
6. **修订是常态**：支持转写、说话人、话题、事件、摘要的版本修订和局部重建。
7. **AI 不负责最终状态提交**：LLM 只返回候选事件与解释；由规则验证证据和操作合法性，再写入事件日志。

## 1. 系统边界与采集架构

### 1.1 输入模式

| Adapter | 使用场景 | 输入 | 风险与降级策略 |
| --- | --- | --- | --- |
| `MicrophoneCapture` | 线下会议、用户本地讲话 | 单/多麦克风 | 房间回声与多人串话；优先录音质量 |
| `BrowserCapture` | 浏览器内会议 | `getDisplayMedia` + `getUserMedia` | 系统音轨因平台不同可能缺失；必须检查实际 tracks |
| `DesktopCapture` | Zoom/腾讯会议/Teams 等桌面软件 | macOS ScreenCaptureKit 或平台原生音频接口 | 权限与平台兼容性；不是所有 App 都保证能捕获 |
| `FileReplay` | 离线评估与重演 | WAV/FLAC/MP4 | **PoC 首先实现**，通过同一事件总线模拟流式输入 |

线上模式应保留本地麦克风与远端系统音频的**独立轨道**，不要在录制时永久混成唯一音轨。若因同一人声音在两轨重复造成双重识别，优先依据轨道源、时间对齐及回声特征过滤；不要仅凭文字相似性盲删。线下单麦克风模式的说话人识别仅做概率性标注。

### 1.2 音频标准化

- 本地优先以设备原生采样率采集（例如 48kHz、16-bit PCM），保留声道和原始音频；压缩存档可另存 FLAC。
- 单独建立 `ASRResampler` 与 `VADResampler`：如果选 OpenAI `gpt-live-transcribe`，Realtime PCM 输入是 **24kHz**；Silero VAD 使用 **16kHz 或 8kHz**。不得把 16kHz PCM 错报为 24kHz。
- 帧长度 20–40ms；网络可聚合为 100–200ms 包。保存端与识别端均有独立有界缓冲区。
- 使用 `meeting_elapsed_ms` 作为统一业务时间轴，映射关系来源于采集开始时的单调时钟 + 音频 sample offset。网络到达时间只用于监控，不等同于发言时间。
- `audio_chunks` 可每 5 分钟滚动文件，不参与语义段切分。每片写入校验和，先写后 ACK。
- 未获得明确录音权限或会议录音同意时不启动采集；提供暂停、结束、删除和可配置保留期。

### 1.3 供应商适配器接口（概念）

```python
class AudioSourceAdapter(Protocol):
    async def start(self, meeting_id: str) -> None: ...
    async def frames(self) -> AsyncIterator[AudioFrame]: ...
    async def stop(self) -> None: ...

class TranscriberAdapter(Protocol):
    async def start(self, config: ASRConfig) -> None: ...
    async def send_audio(self, frame: AudioFrame) -> None: ...
    async def events(self) -> AsyncIterator[TranscriptProviderEvent]: ...
    async def commit_turn(self, provider_turn_id: str) -> None: ...
    async def close(self) -> None: ...

class DiarizerAdapter(Protocol):
    async def assign_speakers(self, audio_refs: list[str], utterances: list[dict]) -> list[dict]: ...

class StructuredLLMAdapter(Protocol):
    async def generate(self, task_type: str, input_data: dict, schema_name: str) -> dict: ...
```

适配器负责将供应商特有的 interim/final、endpoint/commit、会话关闭、重试与时戳格式转成内部统一事件。

### 1.4 已核实的备选技术

- **ASR**：OpenAI `gpt-live-transcribe` 用于实时转写；需客户端管理话语提交；不会直接返回词级时间戳、说话人标签及置信度。可比较 Azure Speech 的实时 speaker diarization 能力。
- **VAD**：Silero VAD，8/16kHz 本地推理；区分语音活动与语义句终点。
- **Diarization**：pyannote `speaker-diarization-community-1`，更适合先作为后台修订/最终校验任务，而非假设它天然是低延迟在线服务。只产生 `speaker_01` 等聚类标签；真实身份需后续确认或音轨/参会者映射。
- **结构化输出**：优先用支持严格 JSON Schema 的模型/调用方式；仍要做本地业务验证，结构合法不代表事实可信。

## 2. 状态机

### 2.1 Meeting 主状态

```text
CREATED -> READY -> RECORDING -> STOPPING -> FINALIZING -> COMPLETED
                     |    ^
                     v    |
                   PAUSED

READY / RECORDING / PAUSED / FINALIZING -> FAILED / CANCELLED
```

`DEGRADED`、`RECOVERING` 是并行的 health 状态，不阻塞本地音频采集。

- `READY` 前：设备授权、写盘、ASR 接口预检；如果暂时没有 ASR，可提供“仅录音/后处理”模式。
- `STOPPING`：结束新帧输入，flush 本地缓冲，关闭当前 ASR turn，等待尾部结果或标注补处理区间。
- `FINALIZING`：补齐漏转写、关闭话语、补做 diarization、重新合并事件、生成纪要、核验关键事实。
- `COMPLETED`：汇总产物可检索，仍允许人工编辑并生成新 revision。

### 2.2 Utterance（话语）

`PARTIAL -> STABILIZING -> COMMITTED -> NORMALIZED -> (REVISED -> NORMALIZED)*`

- `PARTIAL`：可被供应商覆盖，前端只展示、不抽取正式事件。
- `COMMITTED`：音频与转写的稳定锚点已有，但并不保证内容识别正确。
- `NORMALIZED`：标点、专有名词和口语处理完成，不改变事实与否定语义。
- `REVISED`：离线重识别或人工修订，创建新版本，并生成 `UpstreamChanged` 通知。

### 2.3 Segment（语义段）

`OPEN -> CUT_CANDIDATE -> SEALED -> EXTRACTED -> SUMMARIZED -> PUBLISHED`

切分失败时由 `CUT_CANDIDATE -> OPEN`。后续任何依赖数据修订触发 `PUBLISHED -> DIRTY -> EXTRACTED -> SUMMARIZED -> PUBLISHED(revision+1)`。不回退旧 revision；只更新 `current_revision` 指针。

### 2.4 ProcessingJob

`QUEUED -> RUNNING -> SUCCEEDED`；异常可 `RUNNING -> RETRY_WAIT -> QUEUED`；多次失败后 `DEAD_LETTER` 并显示受影响范围。必要字段 `idempotency_key`、`source_revision`、`attempts`、`last_error`、`lease_until`。

## 3. 核心数据模型

### 3.1 实体及依赖图

```text
Meeting
 |- AudioSource[] -> AudioChunk[]
 |- TranscriptRevision[] -> Utterance[]
 |- SemanticSegment[] -> UtteranceRef[]
 |- Topic[] -> MeetingEvent[] -> EvidenceRef[]
 |- EventJournal[] -> MeetingStateSnapshot[]
 |- SummaryRevision[]
 `- ProcessingJob[]

SummaryClaim -> Event -> EvidenceRef -> Utterance -> AudioChunk + audio_time_range
```

### 3.2 主表定义（PoC）

| 表名 | 必备字段 |
| --- | --- |
| `meetings` | `id,status,title,started_at,ended_at,config_json,config_version` |
| `audio_sources` | `id,meeting_id,kind,channels,sample_rate,clock_offset_ms` |
| `audio_chunks` | `id,source_id,start_sample,end_sample,path,sha256,created_at` |
| `utterances` | `id,meeting_id,source_id,start_ms,end_ms,timestamp_quality,speaker_id,raw_text,normalized_text,revision,segment_id` |
| `segments` | `id,meeting_id,start_ms,end_ms,owned_utterance_ids,status,revision,primary_topic_id` |
| `topics` | `id,meeting_id,title,status,parent_topic_id,created_at` |
| `meeting_events` | `id,meeting_id,topic_id,type,content,status,owner_id,due_date,supersedes_id,revision` |
| `evidence_refs` | `id,event_id,utterance_id,start_ms,end_ms,quote` |
| `event_journal` | `sequence,meeting_id,operation,entity_id,payload,source_revision,occurred_at` |
| `state_snapshots` | `id,meeting_id,revision,last_sequence,state_json,created_at` |
| `summaries` | `id,meeting_id,scope,target_id,revision,source_revision,status,content_json,created_at` |
| `processing_jobs` | `id,meeting_id,type,status,source_revision,idempotency_key,retry_count,error` |

### 3.3 数据对象示例

```json
{
  "utterance_id": "utt_0088",
  "meeting_id": "mtg_001",
  "source_id": "remote_audio",
  "start_ms": 125800,
  "end_ms": 134600,
  "timestamp_quality": "audio_aligned_approx",
  "speaker_id": "spk_02",
  "raw_text": "支付这个还是先不做吧",
  "normalized_text": "支付功能第一期暂时不做。",
  "revision": 2,
  "asr_status": "committed",
  "audio_refs": ["audio_004"],
  "segment_id": "seg_003"
}
```

```json
{
  "event_id": "evt_0021",
  "meeting_id": "mtg_001",
  "topic_id": "topic_payment",
  "type": "decision",
  "content": "第一期暂不接入支付功能",
  "status": "confirmed",
  "owner_id": null,
  "due_date": null,
  "evidence": [
    {"utterance_id": "utt_0088", "quote": "支付这个还是先不做吧"},
    {"utterance_id": "utt_0090", "quote": "好，那就按这个范围走"}
  ],
  "supersedes_id": "evt_0015",
  "needs_review": false,
  "revision": 1
}
```

**完整性不变量**：事件没有证据不得变为 `confirmed`；`owner_id` 不能凭发言人自动推定；`due_date` 未被明确提及就为 `null`；引用的 utterance 需属于该会议且存在；每个 utterance 只归属于一个正式 segment；跨段上下文只读；输入版本更新后受影响的摘要必须变 `DIRTY`。

## 4. 采样、话语重建与分段算法

### 4.1 三类采样区分

| 类型 | 策略 | 备注 |
| --- | --- | --- |
| 声学采样 | 连续音频，不随机丢帧 | 原始音轨可追溯 |
| 转写采样 | 稳定话语全部进入微批处理 | 30–60 秒汇集一次；重要事件可提前触发 |
| 摘要内容选择 | 事件优先 + 议题相关原文检索 | 压缩背景，保留数字、否定、决策与条件 |

不要将 30–60 秒微批处理误解为 30–60 秒语义切分。批处理只是异步任务调度粒度。

### 4.2 话语重建

维护两层缓冲区：

- `provider_final_buffer`：供应商已定稿但语义上尚未构成完整话语的片段。
- `utterance_builder`：当前说话人连续表达及约 2–3 个前序话语提供的只读上下文。

候选句终点来自 VAD、说话人变化、语法终止信号与最大时长；为避免“虽然……但是……”被截断，需要支持句末等待与跨候选边界合并。口语自我纠正（“支付先做，不对，先不做”）应保留最终表达及其修订关系。

### 4.3 语义段混合切分（初始参数）

```yaml
vad:
  sample_rate: 16000
  candidate_silence_ms: 700
  pre_roll_ms: 250
utterance:
  soft_max_duration_sec: 20
  context_previous_count: 3
micro_batch:
  interval_sec: 45
semantic_segment:
  target_sec: 300
  soft_min_sec: 120
  soft_max_sec: 480
  context_overlap_sec: 30
  topic_change_threshold: 0.75   # 校准前仅为启发式占位值
checkpoint:
  interval_sec: 900
```

`topic_change_threshold` 如果来自模型判断，必须明确其含义；未校准前绝不能当成跨模型可比概率。

**优先级**：明确议题闭合/新议题（可以低于 2 分钟） > 当前话语完整与否 > 目标时长 > 软最大时长。若已达到 8 分钟仍讨论同议题，则允许输出同一个 Topic 下的两个 `subsegment`，而不是强制标记议题结束。

```python
def decide_cut(window, new_utterance, topic_signal):
    elapsed = window.duration_sec
    if not new_utterance.is_complete:
        return "KEEP"
    if topic_signal.explicit_topic_closed or topic_signal.explicit_topic_switched:
        return "CUT"
    if elapsed < 120:
        return "KEEP"
    if elapsed < 300:
        return "CUT" if topic_signal.strong_boundary else "KEEP"
    if elapsed < 480:
        return "CUT" if topic_signal.safe_boundary else "KEEP"
    return "CUT_AS_SUBSEGMENT"  # 继续同一 Topic，不强迫议题结束
```

### 4.4 重叠上下文与去重

正式归属采用半开区间 `[start_ms,end_ms)` 与唯一 `segment_id`。下一段可以读取前段末尾约 30 秒 **上下文引用**，但事件提取只对 `owned_utterance_ids` 产生新事件。若某事件跨段成立，可以把前段和本段话语都列为证据，但只创建一次业务事件。使用事件规范化键 + 近似重复检测 + topic_id，而不是通过原文 substring 做唯一判断。

## 5. 事件抽取与增量状态

### 5.1 事件类型

- `topic_opened` / `topic_closed` / `topic_reopened`
- `proposal`（方案建议）
- `objection`（反对与限制条件）
- `decision`（明确结论）
- `action_item`（任务、责任人、期限）
- `risk`（风险）
- `open_question`（未解决问题）
- `fact`（重要时间、预算、数量、约束）
- `correction`（纠正之前表达）

`decision.status` 推荐 `proposed | tentative | confirmed | superseded | retracted`；`action_item.status` 推荐 `proposed | assigned | completed | cancelled`。不要将所有 event 类型硬塞到一个状态 enum。

### 5.2 追加事件日志、重建当前状态

```text
12:01  evt_10  proposal   第一阶段加入支付功能
12:08  evt_14  objection 支付测试成本会拖延发布
12:15  evt_18  decision  第一阶段暂不加入支付功能
                        supersedes=evt_10 (如果 evt_10 被错误标为暂定方案)
12:23  evt_22  action    产品经理更新第一期功能清单，负责人待确认
```

事件日志追加不可变 `EventCreated / EventStatusChanged / EventSuperseded / TranscriptRevised / SummaryInvalidated`；投影器根据 sequence 形成 `MeetingStateSnapshot`。`MeetingState` 是派生视图，任何时候都可从 journal + 当前证据版本恢复。

对 `confirmed` 的业务要求：必须有明确确认信号、可定位的证据；仅有“我建议……”不够。存在冲突但尚未解决，则保持 `tentative` 或提示人工审核。

### 5.3 阶段摘要

触发：议题闭合 / 关键决策落地 / 最长 15 分钟尚无阶段摘要。输入是**上一状态快照 + 本次新增事件 + 原文证据 + 主题上下文**；输出为 `state_delta` + 面向用户的阶段摘要。增量摘要只作为可视化，不作为下一轮 LLM 唯一事实输入。

### 5.4 最终摘要

1. 对所有 topic 聚合关联事件，处理被重新打开的议题。
2. 重放事件日志，生成决策最终状态；保留关键改变过程，而非所有重复争论。
3. 按 `executive_summary`、`topics`、`decisions`、`actions`、`risks`、`open_questions` 组织正式纪要。
4. 对每一条决策、任务、日期、金额进行 `Claim -> Evidence` 回查；缺失证据标记需复核；不能伪造时间戳。
5. 对不完整音频区间、ASR 低质量区间生成覆盖警告；允许部分纪要输出，但不可冒充完整。

## 6. 可直接用于 PoC 的四套 Prompt

提示词均要求：输入含已存在的 stable utterance IDs 和 speaker IDs；输出只能引用已提供的 utterance ID；业务状态由服务端规则最终确定。建议使用严格 JSON Schema / Pydantic 验证模型响应，而不是靠提示词文字要求 JSON。

### 6.1 P1：话语完整性判定与轻度整理

**System**

```text
你是中文会议转写整理器，不是会议总结器。
只处理当前稳定 ASR 片段，并参考上下文判断是否组成完整话语。
禁止补充未出现的事实、数字、人名、时间、责任人及因果关系。
保留否定、条件、模糊性、犹豫、提议与自我修正。
允许补标点、常见口语整理；如果无法无损改写，就原样保留。
绝不把前序只读上下文重复输出为新话语。
如果当前句未完整，设置 is_complete=false；不得强行补齐。
输出字段必须满足指定结构化 Schema。
```

**User 输入模板**

```json
{
  "previous_context": [
    {"utterance_id": "utt_20", "speaker_id": "spk_1", "text": "我们先看交付范围。"}
  ],
  "stable_fragments": [
    {"fragment_id": "asr_41", "speaker_id": "spk_2", "text": "支付这个先做 不对先不做 第一阶段先做预约"}
  ],
  "next_context": [],
  "domain_keywords": ["支付", "预约"]
}
```

**预期输出（演示）**

```json
{
  "is_complete": true,
  "normalized_text": "支付功能先不做，第一阶段先完成预约。",
  "source_fragment_ids": ["asr_41"],
  "semantic_warnings": ["说话者纠正了先前关于支付功能的表述"]
}
```

### 6.2 P2：语义边界判断

**System**

```text
你是会议主题边界判定器。
你只能根据已有稳定话语判断当前讨论是否出现自然的议题边界。
不要仅因说话人更换、停顿或经过五分钟就认为议题结束。
区分“同一议题的子讨论”和“切换到新议题”。
若边界不明确，倾向 KEEP；如果已达到时间软上限，可以选择 CUT_AS_SUBSEGMENT。
返回 boundary=KEEP|CUT|CUT_AS_SUBSEGMENT、reason、topic_hint、support_utterance_ids。
```

**User 输入模板**

```json
{
  "current_topic": "第一期功能范围",
  "current_duration_sec": 322,
  "recent_utterances": [
    {"id":"utt_71", "text":"那第一阶段就先做课程和预约。"},
    {"id":"utt_72", "text":"好。接下来讨论报价和付款节点。"}
  ]
}
```

**预期输出（演示）**

```json
{
  "boundary": "CUT",
  "reason": "明确结束第一期功能讨论并切换到报价议题",
  "topic_hint": "报价和付款节点",
  "support_utterance_ids": ["utt_71", "utt_72"]
}
```

### 6.3 P3：会议事件提取（最重要）

**System**

```text
你是高精度会议事件提取器。你的任务是识别证据，而不是创作顺畅的故事。
只分析 owned_utterances；context_utterances 仅用于理解，不得单独生成本段新事件。
识别提议、反对意见、已明确决策、行动项、风险、未决问题、事实与纠正。
“建议”“可能”“之后再定”“原则上”不等于已确认决策。
没有明确负责人时 owner_id=null；没有明确截止日期时 due_date=null。
不得猜测参会者真实姓名；保留 speaker_id。
每个候选事件必须引用至少一个出现于输入中的 utterance_id，并尽量包含证据短引文。
对于矛盾或证据不完整的内容，设置 needs_review=true、status=tentative。
若本段没有新事件，返回空数组，不要为了满足格式生成事件。
严格输出结构化数据，不添加格式说明。
```

**User 输入模板**

```json
{
  "topic_id": "topic_scope",
  "existing_active_events": [
    {"id":"evt_10","type":"proposal","content":"第一期加入支付功能"}
  ],
  "context_utterances": [
    {"id":"utt_80","text":"我们刚才提到支付。"}
  ],
  "owned_utterances": [
    {"id":"utt_88","speaker_id":"spk_2","text":"支付第一期先不做吧，先跑通预约。"},
    {"id":"utt_90","speaker_id":"spk_1","text":"好，那第一期就按这个范围定。"},
    {"id":"utt_91","speaker_id":"spk_3","text":"我把功能清单更新一下。"}
  ]
}
```

**预期输出（演示）**

```json
{
  "events": [
    {
      "candidate_id":"c1",
      "type":"decision",
      "content":"第一期不包含支付功能，优先完成预约流程",
      "status":"confirmed",
      "owner_id":null,
      "due_date":null,
      "evidence_utterance_ids":["utt_88","utt_90"],
      "supersedes_event_id":null,
      "needs_review":false
    },
    {
      "candidate_id":"c2",
      "type":"action_item",
      "content":"更新第一期功能清单",
      "status":"proposed",
      "owner_id":"spk_3",
      "due_date":null,
      "evidence_utterance_ids":["utt_91"],
      "supersedes_event_id":null,
      "needs_review":true
    }
  ]
}
```

`c2` 是否可转为 `assigned` 需由服务端依据“我把……更新一下”的语境规则判断或提示用户确认。`candidate_id` 是 LLM 局部 ID，不能当数据库最终 event ID。

### 6.4 P4：阶段摘要与最终纪要（分开任务）

**阶段摘要 System**

```text
你是会议状态更新与阶段摘要助手。
输入包括上一状态、变更事件和可引用证据。
禁止从上一轮自然语言摘要中推测未发生的事实。
必须显式识别 superseded/retracted 决策，不得同时把新旧冲突方案写成当前有效决策。
输出 state_delta 与 brief_summary，保留未解决问题，不猜测截止日期。
若出现矛盾且无法从证据判断最终状态，保留冲突并标记 needs_review。
```

**最终纪要 System**

```text
你是会议纪要总编辑，负责把全量议题状态、事件及证据整理成准确、简洁、可执行的会议纪要。
必须以本次提供的 evidence 和事件最终状态为依据；不沿用已撤销的旧决策。
分别输出：executive_summary、topics、confirmed_decisions、action_items、risks、open_questions、review_flags。
每条关键决策和行动项必须带 evidence_utterance_ids；未确认责任人、期限、金额时明确写“待确认”，不能补齐。
不要写成逐字稿；对同一议题跨时间段讨论要聚合，对重要结论改变给出简短过程说明。
输出完成后执行自检：证据 ID 是否存在？所有确认中的决策有没有证据？是否错误地把提案写成决策？是否遗漏会议最后的修订？
只返回指定 Schema 数据。
```

### 6.5 服务端校验（比 Prompt 更重要）

```python
def validate_candidate(event, input_utterance_ids, active_events):
    assert event["type"] in ALLOWED_TYPES
    assert set(event["evidence_utterance_ids"]).issubset(input_utterance_ids)
    assert len(event["evidence_utterance_ids"]) >= 1
    if event["type"] == "decision" and event["status"] == "confirmed":
        assert has_explicit_confirmation_evidence(event)
    if event.get("owner_id") is not None:
        assert has_owner_assignment_evidence(event)
    if event.get("due_date") is not None:
        assert has_explicit_date_evidence(event)
    if event.get("supersedes_event_id"):
        assert event["supersedes_event_id"] in active_events
```

其中 `has_explicit_confirmation_evidence` / `has_owner_assignment_evidence` 是**待实现的业务校验器**：首版可将模型判断标记为候选，并以人审或二次证据判断处理灰区；不能将此伪代码当成已经解决语义准确率问题。

## 7. 异步编排、幂等和重建

### 7.1 事件总线消息

```json
{
  "message_id":"msg_0371",
  "meeting_id":"mtg_001",
  "type":"UtteranceCommitted",
  "entity_id":"utt_0088",
  "entity_revision":2,
  "meeting_elapsed_ms":134600,
  "sequence":371,
  "payload":{}
}
```

推荐 PoC 第一版使用单进程 asyncio 队列 + SQLite（WAL）保证写盘和重启后任务恢复；不必先上 Kafka。若后续出现多会议并发和多实例，再升级 PostgreSQL + Redis Streams/消息队列。必须区分**内存事件通知**与**持久化任务/事件日志**；单纯 asyncio.Queue 在进程退出时会丢失未消费消息。

### 7.2 任务链路

```text
AudioCaptured
 -> AudioPersisted
 -> ASRProviderPartial / ASRProviderFinal
 -> UtteranceCommitted
 -> UtteranceNormalized
 -> SegmentSealed
 -> ExtractEventsJob
 -> EventsValidatedAndApplied
 -> SummaryJob
 -> SummaryPublished
```

### 7.3 失效传播规则

若 `utt_088 revision=1 -> 2`：

1. 记录 `UtteranceRevised`。
2. 找到引用此 utterance 的 segment 和 evidence refs。
3. 将关联 `event` 候选重新验证；影响 event 的才触发 topic state 修订。
4. 将相关 segment/phase/final summary 标记 DIRTY；按依赖顺序重算。
5. 前端通过 `summary_id + revision` 替换旧版展示；旧版保留历史。

避免每次修订都重算整场：高频更新聚合 2–5 秒后按最小受影响子图重建。最终全量核验仍覆盖所有 active decisions/actions。

### 7.4 幂等键建议

`job_type + meeting_id + entity_id + source_revision + prompt_version + model_config_hash`。在数据库对 idempotency_key 建立唯一约束；写入应采用事务和乐观并发检查，防止乱序结果覆盖较新 revision。

## 8. 交互与用户界面（最小 PoC）

**录音视图**：当前输入源、时间、录制状态、ASR 延迟、音量条、暂停/结束。**实时转写**：临时灰字、已稳定文本、说话人标签、点击跳转音频。**右侧智能面板**：当前议题、最近阶段摘要、决策、待办、待确认。**会后纪要**：可编辑 Markdown + 每条结论的证据引用和播放定位。

设计上要把“AI 估计的当前结论”与“已确认会议决策”使用不同状态标签，而非仅靠字体颜色。

## 9. 技术选型

| 层 | v0.1 推荐 | 备选/演进 |
| --- | --- | --- |
| 前端 | React + TypeScript + Vite | Next.js |
| 实时通信 | WebSocket | SSE（仅服务端推送时） |
| 后端 | Python FastAPI + asyncio | 服务拆分 |
| 数据库 | SQLite WAL（单机） | PostgreSQL |
| 录音文件 | 本地 FLAC/WAV | S3/兼容对象存储 |
| VAD | Silero VAD (16kHz) | WebRTC VAD |
| Streaming ASR | OpenAI `gpt-live-transcribe` (24kHz PCM) | Azure Speech/Deepgram 自定义适配器 |
| Speaker diarization | 最初可关闭；最终后处理 pyannote community-1 | Azure 实时 diarization 或商用模型 |
| LLM | 支持结构化输出的云端模型 | 自建模型接口 |
| 队列 | 持久化 Job 表 + asyncio Worker | Redis Streams |
| 环境与测试 | uv、pytest、ruff | Docker Compose |

**依赖兼容注意**：pyannote/PyTorch/torchcodec 与当前 Python 版本兼容性需在单独虚拟环境验证；不建议为了 diarization 影响核心 ASR 服务。已在 2026-11-08 核查官方文档：部分旧的 OpenAI transcription 模型公布了 2027-02-26 的停用时间，首版不应以旧 diarization 模型为长期主依赖。

## 10. 项目结构（建议）

```text
meeting-intelligence/
├── README.md
├── docs/
│   ├── architecture.md
│   ├── event-schemas.md
│   ├── prompts.md
│   └── evaluation-plan.md
├── apps/
│   └── web/                     # 实时字幕及纪要 UI
├── services/
│   └── api/
│       ├── app/main.py
│       ├── capture/             # FileReplay、麦克风、桌面适配器
│       ├── audio/               # 时钟、缓冲、音轨、重采样
│       ├── asr/                 # Provider 统一协议
│       ├── diarization/
│       ├── utterances/
│       ├── segmentation/
│       ├── extraction/
│       ├── meeting_state/
│       ├── summarization/
│       ├── verification/
│       ├── jobs/
│       ├── db/
│       └── schemas/
├── prompts/
│   ├── utterance_normalizer.md
│   ├── boundary_detector.md
│   ├── event_extractor.md
│   ├── phase_summarizer.md
│   └── final_minutes.md
├── tests/
│   ├── fixtures/
│   ├── test_time_alignment.py
│   ├── test_replay_stream.py
│   ├── test_segmentation.py
│   ├── test_event_revision.py
│   └── test_recovery.py
└── evals/
    ├── annotations/
    ├── evaluation_runner.py
    └── reports/
```

## 11. PoC 实施路径与验收门槛

### Phase 0 — 基准语料与人工标注（优先）

- 准备至少 3 场经授权的中文会议（短会、多人、决策反转），形成最小黄金标准；理想范围 10–20 场。
- 标注议题边界、明确/暂定决策、行动项及负责人/截止期、证据 utterance 时间范围。
- 定义错误类别：ASR 漏字、否定词错、说话人错、边界错、事件遗漏、幻觉、责任人错误、全局矛盾。

**验收**：能按固定输入重复跑出评估报告；人为标注的 ID 和播放位置正确。

### Phase 1 — 离线录音按流式时序回放（优先做）

- `FileReplay` 读取录音，按录音时间重演音频帧。
- 完成音频持久化、ASR Adapter 或离线分块转写适配、Utterance 构建、动态语义切分。
- 用无噪声场景和可控句界测试 2/5/8 分钟策略。

**验收**：时间线无乱序；文本没有因窗口重叠重复；连续重播同一录音产生相同结构（固定模型输出的测试模式）。

### Phase 2 — 实时事件/阶段摘要

- 引入事件提取 Prompt、EvidenceRef、EventJournal、TopicState。
- 前端实时字幕与侧栏结论、待办展示。
- 同一议题先建议后推翻的场景，最后状态正确。

**验收**：候选提议不误判为 confirmed；每条有效决策有证据；修订不会丢失历史。

### Phase 3 — 真实采集与异常恢复

- 完成麦克风采集；至少接通一个线上会议声音采集入口并验证录音权限。
- 模拟 ASR 断线 40 秒、LLM 超时、重复消息、乱序 completion、进程意外退出。
- 录音和待补转写任务落盘，重启能恢复。

**验收**：ASR/LLM 故障期间原始音频没有静默丢失；补处理能够将话语放回正确位置；下游摘要按版本重建。

### Phase 4 — 最终纪要与质量对照

- 对照四组：固定 5 分钟+直接摘要；动态分段+直接摘要；动态分段+EventState；动态分段+EventState+证据校验。
- 对比关键决策召回、行动项召回、证据支持率、责任人/日期准确率、主题边界、延迟、成本。
- 生成最终 Markdown/JSON 输出，支持音频定位。

**验收**：至少 3 场样本通过人工审核；最终所有确认决策、任务拥有可打开的证据引用；覆盖缺失会明确提示。

### 初始评估目标（假设目标，非已达成成绩）

| 指标 | 目标 | 计算方式 |
| --- | --- | --- |
| 决策召回率 | ≥95% | 匹配人工 gold decision 的系统决策数 / gold 总数 |
| 行动项召回率 | ≥95% | 匹配人工 gold action 的系统行动项数 / gold 总数 |
| 已确认决策准确率 | ≥95% | 正确有效 confirmed decision 数 / 系统 confirmed 总数 |
| 关键事实准确率 | ≥98% | 正确的负责人/金额/日期等事实 / 系统提取事实数 |
| 无证据断言率 | ≤2% | 无有效原文证据的重要断言 / 全部重要断言 |
| 段后摘要延迟 | P95 ≤15s | SegmentSealed 至 SummaryPublished |
| 会后纪要延迟 | 初期目标 ≤60s | STOPPING 完成至最终发布（需按硬件/模型实测调整） |
| 恢复能力 | 必须 | 断线/重启后原音频完整，能重建正确顺序 |

单份会议样本量很小，95% 只作为中期目标，不应宣称 3 场会议就可统计证明泛化性能。

## 12. 测试用例（必须覆盖）

| ID | 场景 | 预期行为 |
| --- | --- | --- |
| T01 | 说话人在 05:00 句中停顿 | 不截断未完成的语义话语 |
| T02 | 00:30 即明确结束议题 | 允许早于常规 2 分钟切段 |
| T03 | 单议题持续 11 分钟 | 切为多个子段，topic_id 相同 |
| T04 | 两条音轨重复同一远端声音 | 尽可能避免重复转写，无法识别则提示 |
| T05 | 说“先做支付，不对，先不做” | 最终结论正确、保留纠正证据 |
| T06 | 10 分钟提出，40 分钟否定 | 最终状态不保留过期 confirmed 决策 |
| T07 | “有空谁做一下” | 不推断负责人和日期 |
| T08 | “李工来做，下周三前” | 关联语音发言；解析日期需会议日期与上下文 |
| T09 | ASR partial 多次覆盖 | 不重复写入 utterance 与事件 |
| T10 | provider completion 乱序 | 使用 item_id 与音频时间轴排序 |
| T11 | ASR 服务断线 40 秒 | 录音不断、补转写、下游失效重算 |
| T12 | 旧事件的依据被人工修订 | 相关事件/摘要标记 DIRTY 并重算 |
| T13 | 远端声音和本地麦克风串音 | 不混淆自讲话语与回声（尽力） |
| T14 | 会议结尾突然推翻核心结论 | 最终纪要以最后有效决策为准 |
| T15 | 没人回应的方案建议 | 不能写为 confirmed decision |
| T16 | 音频某段损坏 | 最终输出显式 coverage_warning |

## 13. 风险与决策待确认

1. **时间戳精度**：第一版以话语级可播放跳转为目标；词级精确时间戳需要额外 alignment 组件，不应假装 ASR 已提供。
2. **说话人准确度**：线下单麦克风多人重叠讲话难度很大。首版优先 `speaker_01` 等聚类标签，会后再修正；在线双轨只能区分本地/远端音源，不能等同远端多人身份。
3. **会议录音合规**：录制前取得适用的授权/同意，考虑跨地域存储与云服务数据处理规则。
4. **模型费用**：ASR 以音频时长估算，摘要以输入/输出 tokens + 重算次数估算。必须埋点，不要在没有实际报价和调用计量时推断成本。
5. **摘要完整性**：判断质量应以事件/证据召回和事实准确为主，不以生成文字长度或流畅程度为主。
6. **首版规模**：单机先保证 1 路会议稳定运行；并发扩展属于第二阶段需求。

## 14. 推荐的最小开发顺序

`FileReplay + 数据库 + 时间轴` → `ASR Adapter` → `Utterance` → `Segmenter` → `Event Extractor + Evidence` → `MeetingState` → `阶段摘要` → `最终纪要 + Verifier` → `麦克风` → `线上音频适配器` → `恢复与性能评估`。

**原因**：先用可重播录音确定算法效果，才有可能在真实实时采集链路中定位问题。否则音频故障、ASR 问题、分段问题和 LLM 问题会混在一起。

## 15. 参考资料（2026-11-08 核查）

- [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) — 流式转写接口与模型能力限制。
- [OpenAI Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad) — VAD 模式及模型兼容限制。
- [OpenAI File transcription](https://developers.openai.com/api/docs/guides/speech-to-text) — 文件转写、旧模型停用信息。
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) — 严格 JSON Schema 的支持与限制。
- [Deepgram endpointing](https://developers.deepgram.com/docs/understand-endpointing-interim-results) — interim、is_final 和 speech_final 的区别。
- [Silero VAD](https://github.com/snakers4/silero-vad) — 轻量本地 VAD。
- [pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) — 说话人 diarization 与本地部署。
- [Microsoft Azure real-time diarization](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/conversation-transcription) — 实时说话人分离替代路径。
- [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) — 浏览器音频采集边界。
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) — macOS 原生采集路径。
- [MeetingBank Dataset](https://meetingbank.github.io/) — 会议摘要及结构化评估数据。

---

**文档版本约定**：`v0.1` 为技术方案初稿，后续实验优化分段阈值、状态模型、Prompt 和技术选型时保留旧版本并新增 `v0.2`，不覆盖历史结论。
