# Learning Digest 跨端 UI 实现交接

2026-11-21 · Demo 设计讨论稿。用户同时认可网格和列表，目前更喜欢标题列表，本稿以列表为首页起点。正式默认视图仍可在评审后调整。首页保留继续学习和全部收纳，笔记必须归属于课程。

[跨端设计 Page](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=17-26) · [桌面标题列表原型](https://www.figma.com/proto/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-26) · [上一轮真实资料网格对照](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=13-26)

本地 PNG 按 Figma 原尺寸导出。Web 视觉稿位于 `apps/web/design-reference/`，插件视觉稿位于 `apps/extension/design-reference/`，子目录编号对应下方的 Figma 分区。画板索引提供逐张 PNG 和 Figma 链接。Figma 更新后，请重新导出受影响的画板。

## 视觉规则

| 用途 | 实现参考 |
|---|---|
| 页面与文字 | 主背景白色 #FFFFFF，正文近黑 #222422，次要文字 #62665F。用 #E4E6E0 的 1px 分隔线、对齐与段间距划分区域。 |
| 课程上下文 | 续学、引用与已保存反馈使用灰绿底 #F4F5EF，强调文字 #405B49。颜色旁保留时间、选中下划线或明确的状态词。危险操作用暗红 #A03332。 |
| 字体 | 界面文字 Noto Sans SC，正文 15–17px，辅助信息 13–14px；阅读页大标题 Noto Serif SC，约 25–32px；英文品牌字 Lora。可用系统中文黑体、宋体、Georgia 回退，避免等待网络字体才显示正文。 |
| 间距与表面 | 从 8、12、16、22、32px 选择相邻元素的间距。桌面页主区按宽度居中；侧栏画板宽 396px，左右各 24px，实际宽度跟随宿主。卡片只用于需要明显聚合的内容，圆角约 12px。 |
| 控件 | 主动作用近黑实底、白字；次操作用浅底或文字。输入框细边、8px 圆角。保留键盘焦点、字段标签、禁用态及提交中反馈。 |
| 资料列表 | 桌面左侧约 104 × 64px 缩略图，右侧依次是原标题、来源图标及名称。无图网页以域名与类型占位。中文、英文长标题允许换行；窄屏先保证标题可读，再缩减或省略缩略图。 |

## 页面与行为

- **Web 首页。** 上方呈现上次未学完课程及可恢复位置。下方学习资料与笔记汇总共用同一位置。资料搜索针对全库标题，笔记搜索针对正文与课程名。自然滚动到批次末尾显示已展示数量和加载更多；清空搜索回到原浏览位置。首次收藏、无匹配结果和请求失败分别呈现。没有续学目标时直接进入收藏区。
- **课程与笔记。** W07、W08 是同一课程详情的两种阅读状态。保留来源、学习位置、笔记、历次总结、引用和逐字稿。笔记汇总按课程分组，手写笔记不伪造时间，选文摘记仅在有来源位置时提供回跳。普通网页可收藏；插件欢迎页没有写笔记入口。
- **账号与管理。** Web 使用受邀邮箱和六位验证码；插件从 Web 完成账号关联。站点管理仅管理员可见，保留字幕、ASR、启用和逐行保存。用量展示转写、总结次数、输入字符及更新时间。W10 展示账号功能内容，实际可沿用现有用量浮层。删除资料须确认并告知级联删除影响。
- **插件侧栏。** 区分未关联、普通页、可学习课程、学习中和会话结束。未收藏课程沿用“收藏并开始学习”，已收藏课程按已有状态开始或续学。学习中保留课程上下文、切换挂载页面及结束会话入口。逐字稿搜索不改变播放位置；选文浮条提供笔记和解释。收到持久化成功后才显示“已保存到《课程名》”，失败保留草稿并支持重试。
- **概览与纪要。** 概览展示话题、金句及可定位时间；纪要属于一次学习会话，支持生成中、失败重试、独立页、打印与 HTML/Markdown 导出。课程详情的课程总结保留独立的历史与原文引用。长文总结算法和响应速度另见 Issue #105，本次只涉及呈现。
- **设置与异常。** 保留既有校验、国际化、设置持久化、账号退出语义和本地数据清理确认。无字幕、无采集授权、站点禁用 ASR 应展示各自实际原因及可执行操作。首次加载和局部请求失败仅影响对应区域。

## 给实现 agent

| 工作入口 | 源文件 |
|---|---|
| Web 登录、首页、收藏、删除确认、账号用量 | [App.tsx](../apps/web/src/App.tsx)、[styles.css](../apps/web/src/styles.css) |
| 课程详情、插件关联、管理 | [ResourceDetail.tsx](../apps/web/src/ResourceDetail.tsx)、[LinkApp.tsx](../apps/web/src/LinkApp.tsx)、[AdminSurface.tsx](../apps/web/src/AdminSurface.tsx) |
| 插件侧栏与 UI 状态 | [sidepanel.html](../apps/extension/sidepanel.html)、[sidepanel.css](../apps/extension/sidepanel.css)、[sidepanel.js](../apps/extension/sidepanel.js) |
| 设置及独立纪要 | [options.html](../apps/extension/options.html)、[options.css](../apps/extension/options.css)、[report-render.js](../apps/extension/report-render.js)、[report.js](../apps/extension/report.js) |

先核对运行时能否提供封面、跨课程笔记、全库搜索、续学目标及批次计数，再接入首页。以上为设计目标；Figma 内的数量、进度、管理开关及纪要文字是展示数据。界面仍须兼容已有记录缺少封面、时长或引用的情形。W06、W10、W11 表示任务状态，可以沿用现有表单、浮层或弹窗。W09 的开关须使用可访问的 switch 控件。插件设置的默认值、单位和范围以现有代码为准。

实现后检查真实中英文长标题、缺图、无可续学课程、窄屏、键盘切换、笔记保存后 Web 回查、引用回跳、打印和导出。Web 与插件独立发版，运行时代码修改按仓库 AGENTS.md 维护相应版本。本次文档及画板不改变发布版本。

## 画板索引

W 为 Web，P 为 Chrome 学习侧栏，X 为插件独立页面。各编号表示页面或状态，不能据此推断需要新建 URL。首页与若干核心流程已连原型；按钮及输入框的外观不代表已接入服务。

### 01 · Web｜登录与插件关联

[打开 Figma 分区](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=23-26)

| 画板 | 尺寸（px） | 本地视觉稿 |
|---|---|---|
| [W03 · 登录 / 邮箱](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-160) | 1080 × 680 | [PNG](../apps/web/design-reference/01/W03-登录-邮箱.png) |
| [W04 · 登录 / 验证码](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-181) | 1080 × 680 | [PNG](../apps/web/design-reference/01/W04-登录-验证码.png) |
| [W05 · 关联浏览器插件](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-205) | 1080 × 680 | [PNG](../apps/web/design-reference/01/W05-关联浏览器插件.png) |
| [W14 · 关联完成](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-320) | 780 × 500 | [PNG](../apps/web/design-reference/01/W14-关联完成.png) |

### 02 · Web｜学习库与收藏

[打开 Figma 分区](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=23-27)

| 画板 | 尺寸（px） | 本地视觉稿 |
|---|---|---|
| [W12 · 学习库 / 首次收藏](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-380) | 1080 × 620 | [PNG](../apps/web/design-reference/02/W12-学习库-首次收藏.png) |
| [W06 · 收藏新资料](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-224) | 1080 × 680 | [PNG](../apps/web/design-reference/02/W06-收藏新资料.png) |
| [W01 · 学习库 / 标题列表](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-26) | 1240 × 1150 | [PNG](../apps/web/design-reference/02/W01-学习库-标题列表.png) |
| [W02 · 学习库 / 笔记汇总](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-102) | 1240 × 1150 | [PNG](../apps/web/design-reference/02/W02-学习库-笔记汇总.png) |
| [W13 · 移动 Web / 标题列表](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-296) | 390 × 815 | [PNG](../apps/web/design-reference/02/W13-移动-Web-标题列表.png) |

### 03 · Web｜课程详情与资料管理

[打开 Figma 分区](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=23-28)

| 画板 | 尺寸（px） | 本地视觉稿 |
|---|---|---|
| [W07 · 课程详情 / 来源与笔记](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-242) | 1080 × 875 | [PNG](../apps/web/design-reference/03/W07-课程详情-来源与笔记.png) |
| [W08 · 课程详情 / 总结与引用](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-274) | 1080 × 860 | [PNG](../apps/web/design-reference/03/W08-课程详情-总结与引用.png) |
| [W11 · 删除资料 / 确认](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-366) | 1080 × 550 | [PNG](../apps/web/design-reference/03/W11-删除资料-确认.png) |

### 04 · Web｜账号与站点管理

[打开 Figma 分区](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=23-29)

| 画板 | 尺寸（px） | 本地视觉稿 |
|---|---|---|
| [W10 · 账号与用量](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-348) | 1080 × 650 | [PNG](../apps/web/design-reference/04/W10-账号与用量.png) |
| [W09 · 管理员 / 站点管理](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=18-306) | 1080 × 860 | [PNG](../apps/web/design-reference/04/W09-管理员-站点管理.png) |

### 05 · 插件｜关联、收藏与开始学习

[打开 Figma 分区](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=23-30)

| 画板 | 尺寸（px） | 本地视觉稿 |
|---|---|---|
| [P01 · 欢迎 / 待关联](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-26) | 396 × 810 | [PNG](../apps/extension/design-reference/05/P01-欢迎-待关联.png) |
| [P02 · 欢迎 / 普通网页](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-37) | 396 × 810 | [PNG](../apps/extension/design-reference/05/P02-欢迎-普通网页.png) |
| [P10 · 普通页 / 已收藏](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-213) | 396 × 810 | [PNG](../apps/extension/design-reference/05/P10-普通页-已收藏.png) |
| [P03 · 课程就绪 / 开始或续学](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-49) | 396 × 810 | [PNG](../apps/extension/design-reference/05/P03-课程就绪-开始或续学.png) |

### 06 · 插件｜逐字稿、解释与笔记

[打开 Figma 分区](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=23-31)

| 画板 | 尺寸（px） | 本地视觉稿 |
|---|---|---|
| [P04 · 逐字稿 / 搜索与选文](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-65) | 396 × 810 | [PNG](../apps/extension/design-reference/06/P04-逐字稿-搜索与选文.png) |
| [P08 · 字幕不可用 / 状态反馈](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-176) | 396 × 810 | [PNG](../apps/extension/design-reference/06/P08-字幕不可用-状态反馈.png) |
| [P11 · 逐字稿 / 选文解释](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-331) | 396 × 810 | [PNG](../apps/extension/design-reference/06/P11-逐字稿-选文解释.png) |
| [P06 · 笔记 / 课程手写与摘记](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-125) | 396 × 810 | [PNG](../apps/extension/design-reference/06/P06-笔记-课程手写与摘记.png) |

### 07 · 插件｜概览与学习纪要

[打开 Figma 分区](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=23-32)

| 画板 | 尺寸（px） | 本地视觉稿 |
|---|---|---|
| [P05 · 概览 / 话题与金句](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-100) | 396 × 810 | [PNG](../apps/extension/design-reference/07/P05-概览-话题与金句.png) |
| [P12 · 纪要 / 生成中](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-344) | 396 × 810 | [PNG](../apps/extension/design-reference/07/P12-纪要-生成中.png) |
| [P09 · 纪要 / 生成失败](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-195) | 396 × 810 | [PNG](../apps/extension/design-reference/07/P09-纪要-生成失败.png) |
| [P07 · 纪要 / 生成结果](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-151) | 396 × 810 | [PNG](../apps/extension/design-reference/07/P07-纪要-生成结果.png) |

### 08 · 插件｜独立阅读与设置

[打开 Figma 分区](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=23-33)

| 画板 | 尺寸（px） | 本地视觉稿 |
|---|---|---|
| [X02 · 独立学习纪要 / 阅读与打印](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-270) | 1050 × 1020 | [PNG](../apps/extension/design-reference/08/X02-独立学习纪要-阅读与打印.png) |
| [X01 · 插件设置](https://www.figma.com/design/GUEwJpXVxIvk0vUPs8hmRf/learning-digest?node-id=19-224) | 1050 × 1260 | [PNG](../apps/extension/design-reference/08/X01-插件设置.png) |
