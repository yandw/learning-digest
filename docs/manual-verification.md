# Manual Verification Checklist — PoC first run

照着本清单逐步操作即可完成的 Learning Digest 首次实测。开始前请确认：

- 本仓库当前在 `poc/integration` 分支（`git -C /Users/atom/Workspace/learning-digest branch --show-current`）
- 你有一个 Groq API key（三家服务商里目前只有 Groq 能直接跑通——腾讯/阿里云受 #22 阻塞：默认 2 分钟分段超过它们 60 秒的接口上限）
- 你有小鹅通上一节**录播回放课**（1 分钟以上的片段即可，不必真的听完 2–3 小时）

## 1. 加载扩展（约 2 分钟）

1. Chrome 打开 `chrome://extensions`，右上角开启**开发者模式**
2. 点**加载已解压的扩展程序**（Load unpacked），选择 `/Users/atom/Workspace/learning-digest`
3. 扩展列表中出现 **Learning Digest** 即成功； pin 到工具栏方便开 side panel
4. 若之后 `git pull` 过代码：在扩展卡片上点**重新加载**，并刷新已打开的小鹅通标签页

## 2. 配置 Speech Provider（约 2 分钟）

1. 点扩展卡片上的**选项 / Options**（或右键工具栏图标 → Options）
2. 在 **Speech Provider** 卡片选择 **Groq**，填入 API key
   - Base URL 保持默认 `https://api.groq.com/openai/v1` 即可
   - key 只存在浏览器本地，不要贴给任何人或任何聊天窗口
3. 保存。AI Provider（DeepSeek 默认）如未配置也可先不配——本次验证只测转写，不测总结
4. 如果你用自定义/本地 OpenAI 兼容端点：先把它的域名加进 `manifest.json` 的 `host_permissions`（D15 限制，见 #26），重新加载扩展后再填 Base URL

## 3. 录播课转写实测（约 10 分钟）

1. 打开一节小鹅通**录播回放课**的播放页（URL 形如 `*.xiaoe-tech.com/...`）
2. 点开扩展 side panel，应出现**「开始学习 / Start learning」**按钮；点击开始
3. 浏览器会请求音频捕获权限，**允许**
4. 观察 side panel：音频按 ~2 分钟分段，**逐段出现转写文本**（第一段约 2 分钟 + 接口延迟后出现）
5. 对照播放器核对：时间戳应跟随**视频播放位置**；暂停视频，分段调度应暂停，不产生空转写
6. 切到别的标签页几分钟再切回：转写应**持续累积**，不中断
7. 点**「结束学习 / End learning」**：会话结束，状态归整

**预期之外时的排查**：转写不出现 → 检查 options 里 Groq key 是否保存、扩展是否重新加载、side panel 报错信息（缺字段会点名缺什么）。

## 4. 断点恢复实测（约 5 分钟）

1. 重新点「开始学习」，让 1–2 个分段完成
2. **直接关闭小鹅通标签页**（模拟崩溃/误关）
3. 重新打开同一节课页面，点 side panel 的「开始学习」：应**恢复到关闭前的状态**，已完成分段不会重转
4. 恢复后中断期间的那个未完成分段，应显示「语音转录失败」标注而不是静默消失（code-review 修复项，重点验证）

## 5. 为评估报告采集数据（对照 docs/poc-evaluation.md 的 TODO(manual) 行）

每测完一家服务商，把数据填回 `docs/poc-evaluation.md` §2.2 的表格：

| 数据 | 怎么测 |
|---|---|
| 单分段延迟 | 从音频到达分段边界到该行文本出现，手表计时 5 段取中位数 |
| 转写质量 | 抽 10 个分段，对照回放音频记录错字率感受（中文课程口语） |
| 单课时费用 | 按服务商官网当日单价 × 课时音频总时长估算；Groq 可直接看控制台余额变化 |
| 成功率 | side panel 里「语音转录失败」标注数 ÷ 总分段数 |

腾讯/阿里云：等 #22（分段长度适配）合并后重复第 2–5 步。

## 6. 直播课验证（可选，等录播通过后）

按 `docs/poc-evaluation.md` §3.3 的 10 步清单执行。核心观察点：

- 时间戳显示为**距开始学习的经过时间**（wall-clock），不是视频位置
- 直播**没有自动结束**——必须手动点「结束学习」
- 记录**首行转写延迟**：开始学习到第一段文本出现的时间（go/no-go 框架的输入之一）

## 7. 测完以后

1. 把数据填进 `docs/poc-evaluation.md`，按 §4 的 go/no-go 框架得出结论
2. 结论写进 #20 的评论区，关掉 #20
3. 合并 [PR #21](https://github.com/yandw/learning-digest/pull/21)（会自动关闭 #1、#11–#19）
4. 过程中发现的新问题，开新 issue 并关联 #22–#26 中相关的 follow-up
