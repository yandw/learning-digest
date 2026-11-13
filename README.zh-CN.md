# Learning Digest

[English](README.md) | [简体中文](README.zh-CN.md)

把课程音频逐段转写成学习资料：分段转写、滚动摘要和整节 Digest。

Learning Digest 是一个个人学习库，加上一个用于在课程平台上学习长课程的 Chrome 侧边栏扩展。你在 Web 学习库收藏课程链接或从插件保存当前页，开始一个 Session，扩展就会按固定时长把课程音频切成 Segment 并交给你的后端，由配置的 Speech Provider 把每个 Segment 只转写一次。Web 学习库统一保存你的收藏、播放位置、带时间戳的笔记、每次 Session 的 Transcript，以及按需生成的课程总结。

- 在支持的课程平台（第一个平台：xiaoe-tech.com）和任意网页收藏课程链接，一键打开原页面。
- 从上次记录的位置继续学习，或从头开始；插件按 Source 记录播放位置，支持带时间戳的笔记。
- Session 进行中跟随 Segment 转写；B 站等视频平台有可用字幕时直接归档，其余走后端转写 Worker。
- 任意时点基于已归档的材料生成课程总结，每条引用都可回查原文与时间戳。
- 用原文、简体中文或双语对照的方式学习；用自己的 AI 密钥解释选中的术语。

产品化分支（0.2.x）在冻结的概念验证扩展（0.1.x）之上增加了 Web 学习库、后端 API、转写 Worker 和账号关联。这是一个自带密钥（bring-your-own-key）、从 GitHub 本地安装的项目。它不在 Chrome 应用商店上架。

## 四个发布单元

| 单元 | 位置 | 职责 |
| --- | --- | --- |
| 浏览器插件 | 仓库根（`manifest.json`） | 账号关联、收藏、课程标签页选择、播放位置、笔记、字幕/音频采集（Chrome MV3 侧边栏） |
| Web 学习库 | `apps/web/` | 邀请登录、收藏、学习列表与详情、逐字稿、课程总结、用量 |
| 后端 API | `apps/api/` | 身份、资料与来源、Session、进度、笔记、逐字稿、总结生成、用量 |
| 转写 Worker | `apps/worker/` | 从 API 领取转写任务，运行 Speech Provider，回写带时间戳的记录 |

`contracts/` 存放三端共享的 `/v1` 接口契约、平台视频 ID 提取规则和 JSON 样例，各单元的测试直接消费。领域词汇见 [GLOSSARY.md](GLOSSARY.md)，数据流向见 [PRIVACY.md](PRIVACY.md)，契约决策见 [contracts/decisions.md](contracts/decisions.md)。

插件与 Web 学习库是无构建步骤的纯 HTML、CSS 和 JavaScript。服务层（后端 API 与转写 Worker）为 Python 3.12+，用 [uv](https://docs.astral.sh/uv/) 运行（`uv sync` 在首次运行时装好各单元依赖）。Node 20 或更高版本只需用于 Web 学习库的 dev server 与插件工具链（全局 `fetch`、`AbortSignal.timeout`）。

## 运行四个单元（开发）

四个进程，四个终端。先安装 [uv](https://docs.astral.sh/uv/)；下文的 `uv sync` 幂等，可重复执行。

1. 登记受邀邮箱（启动 API 之前）：

```bash
cd apps/api
uv sync
uv run python -m app.invites add you@example.com   # 可重复；`list` 查看
```

2. 启动 API（端口 8787）：

```bash
cd apps/api
uv run python -m app.main   # uvicorn 入口；状态存 data/state.json，dev mailer 写 data/outbox.jsonl
```

3. 启动转写 Worker（pull 模型；默认为确定性 stub provider）：

```bash
cd apps/worker
uv sync
LD_WORKER_TOKEN=dev-worker-token uv run python -m worker.main
```

该 token 必须与 API 侧的 `LD_API_WORKER_TOKEN` 一致（API 未设置则 worker 端点一律 401）。真实 ASR：百炼云端（`LD_WORKER_PROVIDER=qwen QWEN_API_KEY=sk-...`）或自建服务（`LD_WORKER_PROVIDER=local LD_WORKER_LOCAL_BASE_URL=...`，见下方「自建/局域网 ASR」）。

4. 启动 Web 学习库（端口 8080，`/v1` 反代到 API）：

```bash
cd apps/web
npm start          # LD_API_UPSTREAM 默认 http://127.0.0.1:8787
```

5. 加载插件：打开 `chrome://extensions`，开启开发者模式，点击「加载已解压的扩展程序」，选择仓库根目录（含 `manifest.json` 的文件夹）。插件设置页的「学习服务」是账号关联用的 base URL，默认值已指向本地开发服务器。

6. 走一遍流程：打开 `http://127.0.0.1:8080`，用受邀邮箱登录，从 dev outbox（`apps/api/` 旁的 `data/outbox.jsonl`，API 的 stdout 也会打印）取验证码，然后打开插件侧边栏按授权引导操作。关联完成后，打开课程页，从面板收藏，开始 Session，观看播放位置、逐字稿和总结落到 Web 学习库。

真实邮件、真实 ASR、真实 AI 生成在配置前均为 stub：dev mailer 把验证码写进 outbox 文件，worker 默认 stub Speech Provider，API 默认 stub AI Provider。真实 provider 需要配置环境变量表中的密钥。

## 测试

```bash
npm test                              # 浏览器插件（根 tests/）, 695 条用例
node --test contracts/                # 共享契约样例, 52 条用例
cd apps/api    && uv run pytest tests/ -q  # API, 214 条用例
cd apps/worker && uv run pytest tests/ -q  # worker, 28 条用例
cd apps/web    && npm test            # web, 156 条用例
npm run check               # 发布形状检查（manifest、allowlist、importScripts、content_scripts）
npm run package             # 打包扩展 zip
```

全部套件通过（当前 tip 共 1145 条），且不访问外部网络：HTTP 测试绑定 loopback 临时端口，ASR/AI 测试使用确定性 stub provider 或注入 `fetch`，CI 不需要任何密钥。

完整的测试用例清单（按单元和功能域分组、每条自动化用例的验证文件，以及人工验收用例与已知限制观察项）见 [docs/test-cases.md](docs/test-cases.md)。人工验收清单（真实平台、真实密钥、tabCapture 授权）见 [docs/round1-acceptance.md](docs/round1-acceptance.md) 与 [docs/round2-acceptance.md](docs/round2-acceptance.md)。

## 环境变量

### apps/api（`app/main.py`）

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口（`0` = 临时端口） |
| `LD_API_STATE_FILE` | `data/state.json` | 内嵌存储（启动时一次性读入） |
| `LD_API_INVITE_SEED` | `data/invites.seed.json` | 受邀邮箱 seed |
| `LD_API_OUTBOX_FILE` | `data/outbox.jsonl` | dev mailer outbox（验证码） |
| `LD_API_WORKER_TOKEN` | 未设置（worker 端点 401） | `/v1/worker/tasks/*` 的 worker 服务凭据 |
| `LD_API_AUDIO_DIR` | 系统临时目录 | 上传分段的临时音频（成功即删） |
| `LD_AI_PROVIDER` | `stub` | `qwen` = 百炼 compatible-mode（课程总结） |
| `LD_AI_API_KEY` | 未设置 | `LD_AI_PROVIDER=qwen` 时的百炼密钥，与 worker 的转写密钥分开 |
| `LD_AI_MODEL` | `qwen3.8-flash` | 模型覆盖 |
| `LD_AI_BASE_URL` | 百炼 compatible-mode | 端点覆盖 |
| `LD_AI_TIMEOUT_MS` | `120000` | 单次生成 fetch 超时 |

### apps/worker（`worker/main.py`）

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `LD_WORKER_API_BASE` | `http://127.0.0.1:8787` | API base |
| `LD_WORKER_TOKEN` | 未设置 | worker 服务凭据（须与 API 的 `LD_API_WORKER_TOKEN` 一致） |
| `LD_WORKER_PROVIDER` | `stub` | `qwen` = 百炼 qwen3-asr-flash；`local` = 自建 OpenAI 兼容 transcription 服务 |
| `QWEN_API_KEY` | 未设置 | 百炼转写密钥（provider 为 `qwen` 时必填，启动即校验） |
| `LD_WORKER_POLL_INTERVAL_MS` | `5000` | 空闲轮询间隔 |
| `LD_WORKER_ERROR_BACKOFF_MS` | 轮询间隔 | 失败周期后的退避 |
| `LD_WORKER_QWEN_BASE_URL`、`LD_WORKER_QWEN_MODEL` | 百炼、`qwen3-asr-flash` | 端点/模型覆盖 |
| `LD_WORKER_LOCAL_BASE_URL` | 未设置 | 自建/局域网 ASR 端点(`local` provider,选中即必填) |
| `LD_WORKER_LOCAL_MODEL`、`LD_WORKER_LOCAL_LANGUAGE`、`LD_WORKER_LOCAL_TOKEN`、`LD_WORKER_LOCAL_MIME_TYPE`、`LD_WORKER_LOCAL_RESPONSE_FORMAT` | `whisper-1`、`zh`、未设置、未设置、`verbose_json` | local provider 调优 |
| `LD_WORKER_LOCAL_BASE_URL` | 未设置 | 自建 ASR 服务地址（provider 为 `local` 时必填，缺失启动即失败） |
| `LD_WORKER_LOCAL_MODEL`、`LD_WORKER_LOCAL_LANGUAGE` | `whisper-1`、`zh` | local 转写模型与语言 |
| `LD_WORKER_LOCAL_TOKEN`、`LD_WORKER_LOCAL_MIME_TYPE` | 未设置 | local 服务可选 Bearer 凭据与音频 MIME 覆盖 |

### apps/web（`server.js`）

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `LD_API_UPSTREAM` | `http://127.0.0.1:8787` | `/v1` 代理目标 |

### 浏览器插件（设置页）

插件只保留属于设备本地的配置：面板内 AI 功能的 AI API 密钥、Session 与 Segment 设置，以及账号关联用的「学习服务」base URL。Session 转写与课程总结在服务端运行，密钥由服务端配置；插件不存任何 Speech Provider 密钥，设置迁移会在首次读取时清除旧的 ASR 密钥。密钥和设置保存在本机 Chrome 的本地扩展存储中。发布版本不包含也不使用 `config.js`。

## 让你的编程 Agent 帮你安装

你不需要看懂代码，也不需要使用命令行。把这条消息发给你的编程 Agent：

> 把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并在 Chrome“加载已解压的扩展程序”时使用同一个文件夹。如果第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/learning-digest`，或 Windows 上的 `%USERPROFILE%\Documents\learning-digest`，但不要假设我一定使用这些路径。请用简单的语言带我完成安装和设置。https://github.com/yandw/learning-digest

你的 Agent 应该：

1. 询问你想把项目保存在哪里，把它下载或克隆到那里，并告诉你准确的完整路径。如果你需要建议，它可以推荐 macOS 或 Linux 上的 `~/Documents/learning-digest`，或 Windows 上的 `%USERPROFILE%\Documents\learning-digest`，你也可以使用其他文件夹。
2. 打开下面的阿里云百炼页面，帮你创建自己的账号。
3. 带你完成在 Chrome 中通过“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹。
4. 告诉你如何在扩展的 **Settings** 页面输入 API 密钥。
5. 说明侧边栏、Session 流水线和 Speech Provider 设置如何配合工作。

安装后请把文件夹保持在原位置。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

永远不要把 API 密钥粘贴到 AI 聊天、源代码文件、截图或公开信息中。请直接在 Learning Digest 设置页面自行输入密钥。你的编程 Agent 可以指出正确的输入位置，但不需要看到密钥本身。

## 手动安装

如果你更喜欢自己动手：

1. 打开 [github.com/yandw/learning-digest](https://github.com/yandw/learning-digest)。
2. 选择 **Code**，然后 **Download ZIP**。
3. 选择一个长期保留文件夹，把项目解压到那里。可选建议是 macOS 或 Linux 上的 `~/Documents/learning-digest`，或 Windows 上的 `%USERPROFILE%\Documents\learning-digest`，你也可以使用其他文件夹。
4. 在 Chrome 中打开 `chrome://extensions`。
5. 打开 **开发者模式**。
6. 点击 **加载已解压的扩展程序**。
7. 选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest.json`。
8. 如果需要快速访问，可以在 Chrome 的扩展菜单中固定 Learning Digest。

因为这是已解压的扩展，它不会自动更新。下载更新或修改本地文件后，请在 `chrome://extensions` 的 Learning Digest 卡片上点击 **重新加载**，然后刷新打开的课程标签页。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

## 设置 API 密钥

Learning Digest 使用你自己的 AI 服务密钥（默认阿里云百炼）驱动面板内的 AI 功能：解释内容、翻译和笔记辅助。Session 转写与课程总结在你的后端运行，Speech Provider 密钥（worker）与 AI 密钥（API）通过环境变量配置，不在插件里。

### 获取 AI 服务 API 密钥

1. 打开官方 [阿里云百炼控制台](https://bailian.console.aliyun.com/)。
2. 按提示登录或创建阿里云账号，并按需开通百炼（Model Studio）服务。
3. 创建 API Key，起一个容易识别的名字，例如 `Learning Digest`。
4. 立即复制密钥，完整密钥可能只显示一次。
5. 把密钥粘贴到 Learning Digest 设置的 **AI API 密钥** 字段中。
6. 如果百炼提示额度不足，请在百炼账号中充值后重试。

当前账号和 API 详情以 [阿里云百炼官方文档](https://help.aliyun.com/zh/model-studio/) 为准。

从侧边栏打开 **Settings**。你也可以在 `chrome://extensions` 的扩展卡片上打开 Learning Digest 的 **Options** 页面，或右键点击工具栏图标。请只在这些设置字段中粘贴密钥，永远不要把密钥粘贴到 AI 聊天、仓库文件、截图或公开信息中。

发布版本通过阿里云百炼使用 qwen3.8-flash 模型作为 AI 服务：

```text
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen3.8-flash
```

Learning Digest 所有 AI 请求都以非思考模式发送，保证响应迅速、行为可预期。端点和模型在设置中固定，因此你需要输入的 AI 凭证只有百炼 API 密钥。如果想换其他服务或模型，请复制设置页中安全自定义提示词，交给编程 Agent 修改你的本地副本。永远不要把 API 密钥加入这段提示词或聊天。

### Speech Provider 密钥（后端）

Session 转写默认使用阿里云百炼 Qwen ASR，在转写 Worker 中通过环境变量配置：

```text
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen3-asr-flash
```

在 worker 上设置 `LD_WORKER_PROVIDER=qwen` 和 `QWEN_API_KEY`，并给 API 与 worker 配一对共享的 `LD_API_WORKER_TOKEN`/`LD_WORKER_TOKEN`。课程总结使用 API 侧独立的 `LD_AI_PROVIDER=qwen` 加 `LD_AI_API_KEY`。配置之前，worker 与 API 运行确定性 stub provider，整条流程无需密钥即可跑通。

### 自建/局域网 ASR

转写也可以完全跑在自己的硬件上，不触碰任何云端 API：把 worker 指向一个自建的 OpenAI 兼容 transcription 服务（faster-whisper-server、LocalAI、whisper.cpp server 都是这个形状），设置 `LD_WORKER_PROVIDER=local` 和 `LD_WORKER_LOCAL_BASE_URL=http://<host>:<port>`。worker 以 multipart 把音频 POST 到 `{base}/v1/audio/transcriptions`，携带 model 与 language（默认 `whisper-1` 与 `zh`），配置了 `LD_WORKER_LOCAL_TOKEN` 时附带 Bearer 凭据。`LD_WORKER_LOCAL_MIME_TYPE` 可覆盖音频 MIME 类型（本机服务常要 wav/webm）。`local` 选择缺 BASE_URL 时启动即失败，与 `qwen` 缺 key 的 fail-fast 规则一致。

## 使用 Learning Digest

1. 用受邀邮箱登录 Web 学习库，并在授权页关联插件。
2. 收藏课程链接（在 Web 学习库粘贴，或从面板保存当前页）。
3. 打开课程页，在面板里选择它的标签页，开始一个 Session。
4. 随着 Segment 转写完成阅读带时间戳的 Transcript，或选择 **Original**、**中文**、**双语**。
5. 滚动摘要会随 Session 进度自动刷新；暂停或拖拽都可以，保存的是最后播放位置。
6. 选中 Transcript 文本获取 AI 解释，或直接把它保存为带时间戳的笔记。
7. 结束 Session，生成 Session Digest；每次 Session 的逐字稿都归档，可在 Web 学习库回查。
8. 任意时点生成课程总结（未学完也可以），补学后再生成。

## 目前可用的功能

- Google Chrome 116 或更高版本，使用 Side Panel API。
- Web 学习库的受邀邮箱+验证码登录，插件作为同组凭据关联，任一端退出两端同时失效。
- 平台感知的来源匹配收藏、按 Source 的播放位置（乐观并发）与带时间戳的笔记。
- 经后端 Worker 的 Session 转写：B 站等平台有字幕时直接归档，其余采集音频走配置的 Speech Provider，约 30 秒一个 Segment。
- 基于全部已归档逐字稿与笔记的按需课程总结（引用可回查原文与时间戳）和用量面板。
- 面板内 AI 功能通过阿里云百炼使用 qwen3.8-flash。其他服务需要你自行修改本地代码，发布版本不提供支持。

真实课程上的 Provider 评估见 [docs/poc-evaluation.md](docs/poc-evaluation.md)。Firefox、Safari、移动端浏览器和其他 Chromium 浏览器目前未做测试和支持。

## AI 费用

阿里云百炼对 `qwen3.8-flash` 采用阶梯计价，单价取决于单次请求的输入 token 总量；当前费率以[官方模型价格页](https://help.aliyun.com/zh/model-studio/model-pricing)为准。

Session 转写由你的 Speech Provider 计费。按当前 flash 模型费率，一节课的音频转写通常只需几分之一美分。

## 人工验收

自动化套件按契约与 stub 验证逻辑。一期验收还需要真实平台走查（四站样本视频、后台标签页 tabCapture 授权、至少一次真实 ASR 端到端）。清单见 [docs/round1-acceptance.md](docs/round1-acceptance.md) 与 [docs/round2-acceptance.md](docs/round2-acceptance.md)。

## 用编程 Agent 做本地改造

这是一个个人改造项目，不接受上游 Issue 或 Pull Request。如果出了问题或想要新功能，请下载或 fork 自己的副本，让编程 Agent 帮你修复、改造或定制。

Learning Digest 使用纯 HTML、CSS 和 JavaScript，没有构建步骤，很适合作为 Agent 辅助项目的起点。可以试试这些想法：

- 增加更多翻译语言，让每个人自由选择。
- 为不同课程或主题定制总结模板。
- 把保存的笔记做成间隔重复的词汇笔记本。
- 增加新的 Source Platform 适配器（注册表接口已经就绪）。
- 把来源归组成课程；契约中的 Resource 与 Source 模型已预留这一关系。

改造时，先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 Learning Digest 项目文件夹。在猜测的或复制的文件夹上操作，不会改动 Chrome 实际运行的扩展。

完整的数据流向说明见 [PRIVACY.md](PRIVACY.md)，领域词汇（Session、Segment、Transcript、Rolling Summary、Session Digest、Source Platform、Speech Provider、AI Provider）见 [GLOSSARY.md](GLOSSARY.md)。
