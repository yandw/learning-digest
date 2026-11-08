# Learning Digest

[English](README.md) | [简体中文](README.zh-CN.md)

把课程音频逐段转写成学习资料：分段转写、滚动摘要和整节 Digest。

Learning Digest 是一个 Chrome 侧边栏扩展，用来在课程平台上学习时长较长的课程。你打开一节课、开始一个 Session，扩展就会按固定时长把课程音频切成 Segment，每个 Segment 只通过你选择的 Speech Provider 转写一次，并持续维护滚动摘要，Session 结束后再生成整节的 Session Digest。Session 指一次连续的学习行为，通常对应一节两到三小时的课。

- 在支持的课程平台上采集课程音频（第一个平台：xiaoe-tech.com），转成可搜索、带时间戳的 Transcript。
- 通过滚动摘要（Rolling Summary）跟进最新内容，新 Segment 转写完成后自动刷新。
- Session 结束时生成基于滚动摘要和完整 Transcript 的 Session Digest。
- 用原文、简体中文或双语对照的方式学习。
- 从选中的 Transcript 文本保存带时间戳的笔记，或用自己的 AI 密钥解释选中的术语。

Learning Digest 是一个自带密钥（bring-your-own-key）、从 GitHub 本地安装的项目。它不在 Chrome 应用商店上架，不包含 API 额度，也没有开发者运营的服务器。

## 项目现状

这个仓库目前是一个早期概念验证。平台和服务的扩展接口已经就位：

- Session 流水线状态机和按 Session 的持久化存储；
- Speech Provider 注册表，内置三个 Provider：Groq、腾讯云 ASR、阿里云 ASR；
- 从种子项目继承的 AI 服务功能（分析、解释、翻译、笔记）。

xiaoe-tech.com 的 Source Platform 采集和三个 Speech Provider（Groq、腾讯云 ASR、阿里云 ASR）均已实现。真实课程上的转写质量、延迟和成本尚未测量；PoC 评估报告（[docs/poc-evaluation.md](docs/poc-evaluation.md)）列出了代码已验证的内容和 go/no-go 决策所需的 TODO(manual) 测量项。

## 让你的编程 Agent 帮你安装

你不需要看懂代码，也不需要使用命令行。把这条消息发给你的编程 Agent：

> 把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并在 Chrome“加载已解压的扩展程序”时使用同一个文件夹。如果第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/learning-digest`，或 Windows 上的 `%USERPROFILE%\Documents\learning-digest`，但不要假设我一定使用这些路径。请用简单的语言带我完成安装和设置。https://github.com/yandw/learning-digest

你的 Agent 应该：

1. 询问你想把项目保存在哪里，把它下载或克隆到那里，并告诉你准确的完整路径。如果你需要建议，它可以推荐 macOS 或 Linux 上的 `~/Documents/learning-digest`，或 Windows 上的 `%USERPROFILE%\Documents\learning-digest`。
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

Learning Digest 使用你自己的 AI 服务密钥（默认阿里云百炼）生成摘要、解释内容、翻译和笔记功能。Session 转写使用 Speech Provider（默认为阿里云百炼 Qwen ASR），需要单独的密钥。

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

### Speech Provider 密钥

Session 转写默认使用阿里云百炼 Qwen ASR：

```text
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen3-asr-flash
```

请在设置的 Speech Provider 区域填写百炼 API 密钥（在[百炼控制台](https://bailian.console.aliyun.com/)创建）。Groq Whisper 和腾讯云 ASR 也已内置，可在同一区域直接选择；各 Provider 的限制和评估状态见 [docs/poc-evaluation.md](docs/poc-evaluation.md)。

密钥和设置保存在本机 Chrome 的本地扩展存储中。发布版本不包含也不使用 `config.js`。

## 使用 Learning Digest

1. 在支持的课程平台（目前为 xiaoe-tech.com）打开一节课。
2. 从侧边栏开始一个 Session。
3. 随着 Segment 转写完成阅读带时间戳的 Transcript，或选择 **Original**、**中文**、**双语**。
4. 滚动摘要会随 Session 进度自动刷新。
5. 打开 **Overview** 查看 AI 生成的章节和关键引文。
6. 选中 Transcript 文本获取 AI 解释，或直接把它保存为带时间戳的笔记。
7. 结束 Session，生成 Session Digest。

## 目前可用的功能

- Google Chrome 116 或更高版本，使用 Side Panel API。
- Session 流水线状态机，带按 Session 的持久化（课程中途关闭标签页后可以继续）。
- Speech Provider 注册表，内置 Groq、腾讯云 ASR、阿里云 ASR。
- 针对缓存 Transcript 的 AI 概览、选中文本解释、翻译和本地笔记。
- 本地笔记，以及近期 Transcript 和 Digest 结果的本地缓存。
- 所有已发布的 AI 功能都通过阿里云百炼使用 qwen3.8-flash。其他服务需要你自行修改本地代码，发布版本不提供支持。

xiaoe-tech.com 的 Source Platform 采集已实现；真实课程上的 Provider 评估见 [docs/poc-evaluation.md](docs/poc-evaluation.md)。Firefox、Safari、移动端浏览器和其他 Chromium 浏览器目前未做测试和支持。

## AI 费用

阿里云百炼对 `qwen3.8-flash` 采用阶梯计价，单价取决于单次请求的输入 token 总量；当前费率以[官方模型价格页](https://help.aliyun.com/zh/model-studio/model-pricing)为准。

Session 转写由你的 Speech Provider 计费。Groq 当前的 Whisper 定价见 Groq 官方定价页面；一节课的音频转写通常只需几分之一美分。

## 用编程 Agent 做本地改造

这是一个个人改造项目，不接受上游 Issue 或 Pull Request。如果出了问题或想要新功能，请下载或 fork 自己的副本，让编程 Agent 帮你修复、改造或定制。

Learning Digest 使用纯 HTML、CSS 和 JavaScript，没有构建步骤，很适合作为 Agent 辅助项目的起点。可以试试这些想法：

- 增加更多翻译语言，让每个人自由选择。
- 为不同课程或主题定制摘要模板。
- 把保存的笔记做成间隔重复的词汇笔记本。
- 增加新的 Source Platform 适配器（注册表接口已经就绪）。
- 按 Provider 调整 Segment 时长和摘要节奏（从 [docs/poc-evaluation.md](docs/poc-evaluation.md) 入手）。

改造时，先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 Learning Digest 项目文件夹。在猜测的或复制的文件夹上操作，不会改动 Chrome 实际运行的扩展。

完整的数据流向说明见 [PRIVACY.md](PRIVACY.md)，领域词汇（Session、Segment、Transcript、Rolling Summary、Session Digest、Source Platform、Speech Provider、AI Provider）见 [GLOSSARY.md](GLOSSARY.md)。
