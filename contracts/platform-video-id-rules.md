# Platform Video ID 提取规则（第一轮 · 四站）

状态：契约 v1 的一部分。为四站 Source Platform 适配器（后续票据）定义 `Platform Video ID` 与分集标识的提取规则。现有 `source-platforms.js` 的 `recognizePage` 只返回 `{ platformId, kind, timestampKind }`，不含 ID 提取；本表即扩展目标。

上游决策 1（#49，已确认）：

1. 能识别视频时，在同一账号内用「平台 + Platform Video ID + 必要的分集标识」匹配来源。
2. 可忽略已知的分享和追踪参数，保留能区分分集的参数。
3. 分享短链只有在能确认对应网页和媒体标识时才按视频身份匹配。
4. 无法识别视频身份时，按相同（归一化后的）网页地址匹配；疑似同一视频无法确认时允许分别收藏。

样例：`fixtures/source-matching.json`（每条含期望匹配结果）。

## 0. 统一归一化规则（用于 url-exact 匹配与比较）

对任意收藏/解析地址，比较前先归一化：

1. 取 scheme + host（host 小写）+ path + query；**丢弃 fragment（`#…`）**。
2. 丢弃下表各站「忽略参数」中列出的参数，以及所有 `utm_*`（通用追踪参数）。
3. 剩余 query 参数按名称排序后重组。

归一化地址即 url-exact 样例中的 `normalizedUrl`。**存储不受影响**：Source.url 始终保存首次收藏的原始完整地址。

## 1. 各站提取规则

| 平台 `platformId` | 识别 host | Platform Video ID 提取 | 分集 `episodeId` | 忽略参数（分享/追踪） | 保留参数 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `xiaoe-tech` | `*.xiaoe-tech.com` | 路径中的资源 token：`p_`（专栏/产品）`v_`（视频）`a_`（音频）`i_`（图文）`l_`（直播/回放），格式 `<前缀>_<至少 4 位字母数字>`；`platformVideoId` **含前缀**整体作为 ID | 无（一个 token 即一个可播放资源） | `app_id` 等分发参数 | 无需保留 query | 商店子域（如 `appdemo`）提取为 `platformScopeId` 并参与身份匹配（决策 D7）。`term_`（专题页）与 `goods_..._detail`（课程详情）是容器页，**不提取为视频身份**，按 url-exact 匹配；同页出现 `term_` + `v_` 时取 `v_` 为身份，`term_` 仅作上下文。直播广播页 `kind=live`（墙钟），回放页 `kind=replay` |
| `bilibili` | `www.bilibili.com`、`m.bilibili.com`、`b23.tv` | `/video/<BV>` 路径段或 `b23.tv/<BV>` 短链路径，格式 `BV` + 10 位字母数字 | query `p` 的十进制值，**缺省视为 `"1"`**（显式 p=1 与不带 p 匹配同一 Source） | `spm_id_from` `vd_source` `share_medium` `share_source` `share_plat` `share_tag` `share_session_id` `share_token` `unique_k` `buvid` `is_story_h5` `from_spmid` `up_id` `mid` `pop_share` `bsource` `broadcast_type` `plat_id` | `p`（分集，必须保留） | `b23.tv/<BV>`（含 BV 的分享链）可直接确认媒体标识 → 按视频身份匹配；`b23.tv/<短码>`（如 `xy9Kz2a`）无法本地确认 → 不提取身份，按 url-exact 匹配（决策 D8）。同 BV 不同 p 为独立 Source，各自保存进度（样例 `match-bilibili-multi-episode-p2/p3`） |
| `youtube` | `www.youtube.com`、`m.youtube.com`、`music.youtube.com`、`youtu.be` | `/watch` 页取 query 参数 `v=`；`youtu.be/<id>` 取路径首段，格式 11 位 `[0-9A-Za-z_-]` | 无（第一轮无分集概念） | `si` `t` `start` `time_continue` `list` `index` `feature` `pp` `app` `persist_app` `redir_token` `html5_redirect` | 无需保留（`v=` 已进身份） | watch 页与 youtu.be 短链互为等价地址，匹配同一 Source（样例 `match-youtube-video-watch/-short-link`）。`list=` 播放列表容器忽略；播放列表内独立分集视频由 `v=` 区分 |
| `xiaohongshu` | `www.xiaohongshu.com`、`xhslink.com` | 视频笔记取路径中的 note id（`/explore/<id>` 或 `/discovery/item/<id>`），格式 24 位十六进制 | 无 | `xsec_token` `xsec_source` `share_token` `app_platform` `app_id` `share_plat` `share_from` `share_session_id` | 无需保留 | **视频笔记**按 note id 匹配身份（可播放、有进度与时间戳笔记）。**图文笔记**不是可播放视频，第一轮不提取身份，按归一化地址匹配；因 `xsec_token` 等在忽略清单中，同一图文换 token 分享仍匹配同一条（样例 `match-xiaohongshu-image-text-note*`，决策 D6）。`xhslink.com/<短码>` 无法本地确认 → url-exact |

## 2. 匹配顺序（决策 1 的契约化）

1. 请求带 `identity` 且按上表提取成功 → 在账号内按（`platformId`, `platformScopeId`（仅小鹅通）, `platformVideoId`, `episodeId`）匹配；命中即同一 Source。
2. 无法提取或未提取 → 按第 0 节归一化地址在账号内匹配（`url-exact`）。
3. 两条地址疑似指向同一视频但无法确认（如不可解析短链、同页不同参数形态）→ 允许分别收藏，由用户整理（决策 1 第 4 条；#49 用户故事 11）。

## 3. 与现有 `source-platforms.js` 的衔接

- 现有 `kind`（`course` / `live` / `replay` / `none`）与 `timestampKind`（`video` / `wallclock`）语义保持不变；本表新增的是各站 **ID 提取**与**参数取舍**。
- 契约 `Source.kind` 取值 `webpage` / `video` / `audio` / `live` / `replay`，与适配器 `kind` 的映射：`course`→按资源 token 映射（`v_`→`video`、`a_`→`audio`、`i_`/`p_` 容器→`webpage`）、`live`→`live`、`replay`→`replay`、未识别→`webpage`。
- 提取必须是**全函数**：任何输入（含垃圾 URL）返回「无法识别」，不抛错；与现有 `recognizePage` 的总性约定一致。
