# 直接从 YouTube 页面获取字幕,移除 Supadata

> 2026-11-04 更新：当前字幕优先级改为 `zh-Hans` → `zh-Hant` → 自动翻译中文 → 英文 → 自动翻译英文；同一语言的直接字幕仍按原生优先于自动生成。空响应、请求失败或解析后为空都会继续尝试下一候选。五类候选都没有可用内容时返回 `NO_SUITABLE_CAPTION`（“抓取不到合适的字幕”），不进入语音转录。本文其余部分保留为原始设计记录，与此次更新冲突的旧规则以本段为准。
>
> 2026-11-05 更新：直接中文字幕包含 YouTube 的地区语言代码，其中 `zh`/`zh-CN`/`zh-SG` 归入简体组，`zh-TW`/`zh-HK`/`zh-MO` 归入繁体组，不再把 `zh-CN` 这类原生中文字幕误当成自动翻译来源。YouTube 可能对缺少播放器 PO Token 的 timedtext 请求返回 HTTP 200 空响应。所有直接候选失败后，扩展会在 MAIN world 临时捕获当前视频播放器自己发出的授权字幕请求，只合并授权和客户端参数，再按同一优先级重试全部候选。捕获结束后恢复网络函数及用户原有的字幕开关状态；无法捕获时保留直接抓取的原始可读错误。扩展重载后，如果已打开的 YouTube 标签页缺少 content script，抓取开始时会自动补注入并恢复 Digest 按钮。

## Problem Statement

用户想用 YouTube Digest 学习一个视频,但必须先去 Supadata 注册账号、拿到 API key、粘贴进设置页,之后每次获取 Transcript 都消耗 Supadata 的额度(免费档每月约 100 次)。这违背了"视频页面上本来就有字幕"这个直觉:播放器已经拿到了 Caption Track,扩展却绕道第三方服务再取一遍。

这条路径带来几个具体问题:

- 多一个账号、一把密钥、一份隐私条款,首次上手成本高。
- 视频内容的 URL 被发送给第三方,与"没有开发者服务器、数据尽量留在本地"的定位不一致。
- 额度用完或服务异常时,即使视频明明有字幕也无法使用。
- 设置页保存时要额外校验 Supadata 连接,增加了失败面。

## Solution

扩展直接在 YouTube 观看页读取该视频的 Caption Track,按 Caption Selection 规则选出一条,请求带时间戳的字幕数据,转换成现有格式的 Transcript。用户只需要配置 AI 的 key。

Supadata 整套移除:密钥输入框、保存时校验、host 权限、请求代码、文档中的相关说明。

选轨规则:Native Caption 优先于 Auto-generated Caption;在各自分组内,中文优先于英文,英文优先于其他语言。侧边栏用状态文本告知用户加载了哪种字幕,例如"已加载中文字幕(原生)"或"已加载英文字幕(自动生成)"。

No-Caption Video 明确提示"本视频没有字幕",不提供元数据或手动粘贴之类的替代方案,也不做音频转录。

## User Stories

1. 作为新用户,我想只配置一个 AI key 就能使用全部功能,以便更快开始学习
2. 作为新用户,我想在设置页看不到 Supadata 相关内容,以便不被已废弃的配置项困惑
3. 作为学习者,我想在打开一个有字幕的视频时直接得到 Transcript,以便不依赖第三方额度
4. 作为学习者,我想在视频同时有中文和英文 Native Caption 时优先拿到中文,以便直接阅读母语内容
5. 作为学习者,我想在视频只有英文 Native Caption 时拿到英文,以便进行英文学习和翻译
6. 作为学习者,我想在视频有 Native Caption 时永远不被 Auto-generated Caption 取代,以便获得质量更高的文本
7. 作为学习者,我想在视频只有 Auto-generated Caption 时仍能使用,以便覆盖更多视频
8. 作为学习者,我想在只有 Auto-generated Caption 时按中文、英文、其他语言的顺序选轨,以便得到最可读的一条
9. 作为学习者,我想在只有其他语言的字幕时也能得到 Transcript,以便再用翻译功能读懂
10. 作为学习者,我想在加载完成后看到字幕的语言和来源,以便判断文本质量
11. 作为学习者,我想看到 Auto-generated Caption 被明确标注"自动生成",以便知道断句和标点可能不准
12. 作为学习者,我想在打开 No-Caption Video 时看到"本视频没有字幕",以便立刻知道不是我的配置出了问题
13. 作为学习者,我想在字幕数据返回为空时被提示"请在播放器里打开字幕后重试",以便知道下一步该做什么
14. 作为学习者,我想扩展不要擅自点击播放器的字幕按钮,以便我的播放器状态不被改变
15. 作为学习者,我想拿到的 Transcript 与以前格式一致(时间戳、文本、语言),以便搜索、翻译、笔记、总结都照常工作
16. 作为学习者,我想字幕中的说话人切换标记被清理掉,以便文本读起来干净
17. 作为学习者,我想在切换视频后获取的是新视频的字幕而不是上一个视频的,以便内容不串
18. 作为学习者,我想在单页应用内导航到另一个视频后仍能正确获取字幕,以便不必刷新页面
19. 作为老用户,我想以前缓存过的 Transcript 升级后依然可用,以便不用重新获取
20. 作为老用户,我想旧的 Supadata key 在升级后被自动清除,以便废弃的密钥不继续留在本地
21. 作为老用户,我想升级后不会因为缺少 Supadata key 而被提示配置不完整,以便直接继续使用
22. 作为注重隐私的用户,我想视频 URL 不再发送给 Supadata,以便数据流向更少
23. 作为注重隐私的用户,我想隐私文档如实说明字幕改为从 YouTube 直接读取,以便我了解数据去向
24. 作为注重安全的用户,我想扩展移除对 Supadata 域名的访问权限,以便权限面更小
25. 作为用户,我想在保存设置时不再等待 Supadata 校验,以便保存更快、失败更少
26. 作为用户,我想在字幕获取失败时看到可理解的错误而不是原始异常文本,以便知道该怎么处理
27. 作为用户,我想在记录时间戳笔记时优先使用已缓存的 Transcript,以便不重复发起字幕请求
28. 作为用户,我想长视频也能一次拿到完整 Transcript,而不需要等待异步任务,以便响应更快
29. 作为维护者,我想 Caption Selection 是一段可以脱离浏览器单独测试的逻辑,以便规则变更有保障
30. 作为维护者,我想字幕数据的解析是可单独测试的逻辑,以便 YouTube 返回格式变化时能快速定位
31. 作为维护者,我想中英文 README、PRIVACY、SECURITY 与功能保持一致,以便文档不再与实现矛盾
32. 作为维护者,我想发布检查能发现残留的 Supadata 引用,以便清理彻底

## Implementation Decisions

### Caption Track 获取(background.js)

`handleFetchTranscript(videoId)` 通过 `chrome.scripting.executeScript` 向 watch 页注入 `world: "MAIN"` 脚本,读取页面变量 `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`。每条轨道包含 `baseUrl`(timedtext 端点)、`languageCode`、`kind`(值为 `asr` 表示 Auto-generated Caption),以及 `name.simpleText`(显示名)。

如果没有找到 `captionTracks` 或列表为空,返回 `{ success: false, error: "NO_TRANSCRIPT", message: "本视频没有字幕" }`。

### Caption Selection 规则(background.js)

从轨道列表中选出一条,顺序如下:

1. 所有 Native Caption(不带 `kind: "asr"`)按语言排序:中文(`zh`、`zh-Hans`、`zh-Hant`)、英文(`en`)、其他
2. 所有 Auto-generated Caption(带 `kind: "asr"`)按同样语言顺序排序
3. 返回排序后的第一条

这部分是纯函数,输入是轨道列表,输出是被选中的轨道对象。

### 请求 timedtext 数据(background.js)

对选中轨道的 `baseUrl` 发起 GET,追加参数 `&fmt=json3`。返回 JSON 格式:

```json
{
  "events": [
    {
      "tStartMs": 0,
      "dDurationMs": 3000,
      "segs": [{ "utf8": "Hello world" }]
    }
  ]
}
```

每个 event 对应一个时间段,`segs` 包含该段的文本片段,拼接成一句。

如果返回空内容或 200 但 body 为空,返回 `{ success: false, error: "EMPTY_TIMEDTEXT", message: "字幕数据为空。请在播放器里打开字幕后重试。" }`。

如果返回 HTTP 错误,包装成通用错误返回。

### 解析 json3 成 Transcript(background.js)

遍历 `events`,每个 event 生成一条 Transcript 记录:

- `text`:拼接 `segs[].utf8`,清理 `>> ` 说话人切换标记
- `start`:将 `tStartMs` 转换成秒
- `duration`:将 `dDurationMs` 转换成秒
- `language`:来自轨道的 `languageCode`

同时构建 `transcriptTextPlain`(无时间戳)和 `transcriptTextTimestamped`(格式:`[MM:SS] text\n`)供 AI 使用。

这部分也是纯函数,输入是 json3 响应和轨道的语言信息,输出是现有格式的 Transcript 数组。

### 字幕来源和语言的状态显示(sidepanel.js)

在加载完成后,调用 `setStatus` 显示:

- Native Caption:「已加载{语言}字幕(原生)」,例如"已加载中文字幕(原生)"
- Auto-generated Caption:「已加载{语言}字幕(自动生成)」,例如"已加载英文字幕(自动生成)"

语言名通过轨道的 `languageCode` 映射:`zh*` → "中文",`en` → "英文",其他 → 语言代码原文。

`handleFetchTranscript` 返回值添加两个字段:`captionKind`(值为 `"native"` 或 `"asr"`)和 `captionLanguageName`(映射后的语言名)。

### 删除 Supadata(所有相关文件)

- **settings.js**:删除 `supadataApiKey` 的 default 和 normalize 逻辑,删除 `canonicalYouTubeUrl`(不再需要)
- **options.html**:删除 Supadata API key 输入框及其 label、placeholder、帮助链接
- **options.js**:删除 `supadataApiKeyLabel`、`supadataApiKeyPlaceholder`、`supadataKeyLink` 等文案 key,删除 `checkSupadataKey` 函数,`saveSettings` 不再校验 Supadata
- **sidepanel.js**:删除 `NO_SUPADATA_KEY` 的错误处理分支,删除 `hasSupadataKey` 检查
- **background.js**:删除 `handleFetchTranscript` 内的 Supadata 请求逻辑和 `pollTranscriptJob`,删除所有 Supadata 相关常量和注释
- **manifest.json**:`host_permissions` 删除 `https://api.supadata.ai/*`
- **tests/settings.test.js**:删除 `canonicalYouTubeUrl` 测试
- **tests/options-check.test.js**:删除 Supadata 校验测试

### 旧密钥清理(background.js)

在 service worker 启动时(或 `chrome.runtime.onInstalled`)执行一次迁移:

```javascript
const settings = await chrome.storage.local.get("supadataApiKey");
if (settings.supadataApiKey) {
  await chrome.storage.local.remove("supadataApiKey");
}
```

不提示用户,静默清理。

### 缓存兼容(background.js)

现有 `digest_${videoId}` 缓存的 Transcript 格式不变,继续复用。`handleFetchTranscript` 返回的新字段(`captionKind`、`captionLanguageName`)不写入缓存,只用于当次的状态显示。

### 文档同步

- **README.md**:删除"Get a Supadata API key"整个小节,删除"YouTube Digest needs two keys"改为"YouTube Digest needs one key",删除 Supadata 的定价和额度说明,修改"Privacy and data flow"中"It sends a canonical YouTube watch URL to Supadata"部分为"It reads Caption Tracks from the YouTube watch page"
- **README.zh-CN.md**:对应中文版本的同样修改
- **PRIVACY.md**:删除 Supadata 数据流描述,说明字幕从 YouTube 页面直接读取
- **SECURITY.md**:删除 Supadata key 相关内容
- **tests/release.test.js**:删除断言 `manifest.host_permissions` 包含 `api.supadata.ai` 的行,删除断言文档中出现 Supadata 相关表述的检查

## Testing Decisions

### 测什么

测试覆盖外部行为,不测实现细节:

1. **Caption Selection 规则**:给定一组轨道,选出符合规则的那一条
2. **json3 解析**:给定 timedtext 的 json3 响应,转换成正确格式的 Transcript
3. **错误场景**:没有轨道、timedtext 返回空、HTTP 错误时,返回正确的错误码和消息
4. **文档一致性**:manifest、README、PRIVACY 不包含 Supadata 引用

不测注入脚本的具体实现(如何读 `ytInitialPlayerResponse`),不测 `chrome.scripting.executeScript` 的调用细节,因为这些是浏览器行为。边界处注入测试替身。

### 测在哪

新建 `tests/caption-selection.test.js`,覆盖:

- 中文 Native > 英文 Native > 其他 Native > 中文 Auto > 英文 Auto > 其他 Auto
- 空轨道列表返回 NO_TRANSCRIPT
- 只有一条轨道时返回该轨道

新建 `tests/caption-parsing.test.js`,覆盖:

- 标准 json3 响应解析成 Transcript
- 多 segments 拼接
- 说话人标记清理(`>> ` 被移除)
- 空 events 返回 EMPTY_TRANSCRIPT

`tests/release.test.js` 添加:

- `manifest.host_permissions` 不包含 `api.supadata.ai`
- README、PRIVACY、SECURITY 不包含 `Supadata`(大小写不敏感)

`tests/settings.test.js` 删除 `canonicalYouTubeUrl` 测试。

`tests/options-check.test.js` 删除 Supadata 校验测试。

### 什么是好的测试

- 只测函数签名和返回值,不测内部变量或调用顺序
- 给定真实结构的输入(轨道对象、json3 响应),不 mock 无关部分
- 错误消息包含用户可读文本,不只是 error code
- 用 Node.js 的 `node:test` 和 `assert/strict`,与项目现有风格一致

### 测试的前例

参考现有的 `tests/settings.test.js`(纯函数测试)和 `tests/release.test.js`(文档一致性断言),都是用 `require` 引入模块直接调用。

## Out of Scope

以下内容明确不在本 spec 范围:

- **音频转录**:No-Caption Video 不做音频转录,留待后续独立任务
- **拦截播放器请求的降级路径**:第一版只做主路径(注入 + timedtext 请求),如果后续监测到 `pot` 失效导致大面积空内容,再加拦截降级
- **多字幕轨道并存**:只选一条,不支持用户手动切换或同时加载多条
- **字幕编辑**:Transcript 只读,用户不能手动修正错误或补充缺失
- **离线缓存字幕文件**:不预下载或持久化 timedtext 响应,每次打开视频都重新获取(有 `digest_` 缓存作为中间层)
- **自定义 Caption Selection 规则**:语言优先级固定为中文 > 英文 > 其他,用户不可配置
- **向 YouTube 提交字幕**:只读取,不修改或上传
- **支持 Shorts、直播、嵌入页**:仍限定在标准 `/watch` 页
- **Supadata 作为 fallback**:彻底移除,不保留备用路径

## Further Notes

### Caption Track 数据的稳定性

`ytInitialPlayerResponse` 和 timedtext 端点都不是 YouTube 的公开 API,可能随时变化。`pot`(PO token)机制已在部分请求上生效,当前实现不带 `pot` 参数,可能返回空内容。如果上线后发现空内容比例过高,后续可以:

1. 加拦截降级路径:在 content script 里 patch `fetch`/`XMLHttpRequest`,读取播放器自己的 timedtext 响应(带有效 `pot`)
2. 该降级路径要求用户已在播放器开启字幕,空内容时提示用户先打开字幕

这两条放在本 spec 外,作为监控和响应策略。

### 与 Supadata 模式的对比

| 维度 | Supadata 模式 | 直接读取模式 |
|---|---|---|
| 前置依赖 | AI key + Supadata key | AI key |
| 字幕覆盖率 | 原生字幕,不含自动生成 | 原生 + 自动生成 |
| 请求额度 | 免费档每月约 100 次 | 无限制(浏览器 same-origin) |
| 数据流向 | YouTube URL → Supadata | 仅在浏览器与 YouTube 间 |
| 维护风险 | 依赖第三方服务稳定性 | 依赖 YouTube 非公开 API |
| 长视频 | 可能异步(>20 分钟) | 同步,一次返回 |

直接模式把"额度"和"第三方账号"的成本换成了"API 稳定性"的维护成本。符合项目的 bring-your-own-key 定位,但需要对 YouTube 结构变化保持响应能力。

### 实现顺序建议

1. 写并通过 Caption Selection 和 json3 解析的测试(纯函数,快速反馈)
2. 在 background.js 实现注入和 timedtext 请求,手工在几个真实视频验证
3. 删除 Supadata:settings、options、sidepanel 的相关代码和测试
4. 更新 manifest、文档,跑 `npm test` 和 `npm run check`
5. 增补 release.test.js 的 Supadata 清理检查
6. 在多个视频(中文原生、英文原生、英文自动、无字幕)上完整测试
