const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
// Shared docs live at the repository root; the extension unit carries no
// copies of them, so release pins read them two levels up.
const repoRoot = path.resolve(root, "..", "..");
const readRepo = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");

test("manifest uses minimized install-time permissions", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.options_ui.page, "options.html");
  assert.ok(!manifest.permissions.includes("activeTab"));
  // Capture plumbing: tabCapture feeds the offscreen recorder; the bridge
  // content script reads media position on xiaoe-tech pages only.
  for (const permission of ["tabCapture", "offscreen"]) {
    assert.ok(
      manifest.permissions.includes(permission),
      `permissions must include ${permission}`,
    );
  }
  // Ticket 5.7 (issue #96): the PO-token retry injects
  // capturePlayerCaptionRequest into the watch tab's MAIN world. Content
  // script matches alone do NOT grant programmatic chrome.scripting access
  // — that comes from host_permissions (0.2.20 review fix): the two caption
  // collection sites are pinned below.
  assert.ok(
    manifest.permissions.includes("scripting"),
    "permissions must include scripting (MAIN-world caption capture injection)",
  );
  for (const host of ["https://www.youtube.com/*", "https://www.bilibili.com/*"]) {
    assert.ok(
      manifest.host_permissions.includes(host),
      `host_permissions must include ${host} (MAIN-world caption capture injection)`,
    );
  }
  // Narrow domain: only the caption-collection sites — the m./music.
  // mirrors and the redirect hosts stay content-script-only (no
  // programmatic injection there), and the API/AI host set is untouched
  // (issue #26 semantics: no user-configured endpoints).
  assert.ok(
    !manifest.host_permissions.some((host) =>
      /youtu\.be|m\.youtube\.com|music\.youtube\.com|m\.bilibili\.com/i.test(host),
    ),
    "host_permissions stay narrow: mirrors and redirect hosts are out",
  );
  // P6 link flow: chrome.tabs URL visibility for the link confirmation tab
  // the extension itself opens (no host_permissions for the web origin —
  // ticket #26 stays open). The worker only ever reads the URL of a tab in
  // its pending-link set.
  assert.ok(
    manifest.permissions.includes("tabs"),
    "permissions must include tabs (P6 link tab URL visibility)",
  );
  assert.deepEqual(manifest.content_scripts, [
    {
      // P10b (#63): the same page bridge on all four round-1 stations.
      // Playback-page paths only — no whole-site matches: xiaoe stays
      // site-wide (its shops use arbitrary resource paths), bilibili /video,
      // youtube /watch (www / m / music), xiaohongshu note pages. The
      // redirect hosts (b23.tv, youtu.be, xhslink.com) need no injection —
      // their redirects land on the matched playback pages.
      matches: [
        "https://*.xiaoe-tech.com/*",
        "https://www.bilibili.com/video/*",
        "https://m.bilibili.com/video/*",
        "https://www.youtube.com/watch*",
        "https://m.youtube.com/watch*",
        "https://music.youtube.com/watch*",
        "https://www.xiaohongshu.com/explore/*",
        "https://www.xiaohongshu.com/discovery/item/*",
      ],
      // Tickets 2.5/2.6 (#68/#69): the caption readers load before the
      // bridge so the getBilibiliCaptions/getYouTubeCaptions commands have
      // their factory globals. transcript-shapes.js (round-2 review fix)
      // loads before both readers — they destructure its shared §2.2
      // Segment check and coverage helper.
      js: [
        "transcript-shapes.js",
        "bilibili-captions.js",
        "youtube-captions.js",
        "page-bridge.js",
      ],
      run_at: "document_idle",
      // 0.1.64: xiaoe players can live inside iframes — the bridge must
      // reach them or position reporting and playback control both fail.
      all_frames: true,
    },
  ]);
  for (const host of [
    "https://api.deepseek.com/*",
    "https://openrouter.ai/*",
    "https://dashscope.aliyuncs.com/*",
    "https://*.xiaoe-tech.com/*",
  ]) {
    assert.ok(
      manifest.host_permissions.includes(host),
      `host_permissions must include ${host}`,
    );
  }
  assert.ok(
    !manifest.host_permissions.some((host) => /groq/i.test(host)),
    "no Speech Provider host remains (ticket 2.4, D10: the Worker holds the ASR keys)",
  );
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
  // 0.2.15 (ticket 6.3, issue #88): the extension consumes the site
  // capability registry — GET /v1/site-capabilities with the built-in
  // default-table fallback, the enabled=false start gating (站点未开放
  // 学习) and the data-driven captions/ASR path decision (server switch
  // AND the adapter's captionsReader declaration).
  // 0.2.16 (ticket 6.6, issue #91): the panel AI is wired server-side
  // (rolling-summary/overview/digest/explain) and the local AI provider
  // config is retired (settings v5).
  // 0.2.17 (ticket 5.4, issue #93): the authorization guide gains a 打开设置
  // entry, and an unrecognized-page icon click degrades to a neutral panel
  // notice plus a storage breadcrumb — nothing on the error list.
  // 0.2.18 (ticket 5.6, issue #95): 开始学习 = 收藏 + 开始一体化 — the
  // start-flow auto-favorites an unmatched target (P8 collect core), the
  // 先收藏 blocker copy and the secondary collect button are retired.
  // 0.2.19 (ticket 5.7, issue #96): the captions path gains the PO-token
  // retry — the worker injects the MAIN-world capture (scripting
  // permission) and re-reads gate-emptied timedtext with the player's own
  // authorization.
  // 0.2.20 (review fix): the MAIN-world injection gains its programmatic
  // host access — host_permissions adds www.youtube.com and
  // www.bilibili.com (narrow: the caption-collection sites only), so the
  // timedtext retry chain is reachable in production.
  // 0.2.21 (issue #98): automatic-only tracks are fetched in the specified
  // language order instead of being skipped before the authorized retry.
  // 0.2.22 (issue #99): collecting re-resolves the same tab, target refreshes
  // preserve their verdict, and a credential-free Web detail entry is available.
  // 0.2.23: YouTube tracks follow SPA navigation through the live MAIN-world
  // player response, and the side panel adopts the Web library visual system.
  // 0.2.24: the content-script listener forwards Chrome's three-argument
  // message signature, restoring caption reads and playback-position replies.
  // 0.2.25: a missing page bridge is restored in the top frame and the
  // caption read retries once, so an extension reload needs no page refresh.
  // 0.2.26: archived source captions follow the validated playback-position
  // stream with a current-row highlight, without adding click-to-seek.
  // 0.2.27: reopening an active Session restores its invalidated page bridge.
  // 0.2.28: a distinct caption-read timeout retries with player authorization.
  // 0.2.29: Bilibili native CC tracks cross the MAIN/isolated-world boundary.
  // 0.2.30: Bilibili's protobuf web/view supplies signed body URLs, and the
  // worker reads the caption CDN without the watch page's CORS restriction.
  // 0.2.31: signed-in protobuf responses unwrap their data envelope, and the
  // signed body URL is rebuilt with the player's XOR keys before the CDN read.
  // 0.2.32: the panel's 重新获取字幕 recheck — a side-effect-free captions
  // probe (probeCaptionsForTab shared with the start flow) behind the header
  // button, with the verdict carried on the button itself.
  // 0.2.33: caption coverage treats sub-5s pauses as speech cadence, not
  // holes — the strict any-gap rule had parked fully-captioned auto-caption
  // videos in the empty 强制转写 decision (measured: 4 gaps / 2.0s on a 56-min
  // VOD's 1454 segments).
  // 0.2.34: the header 挂载页面 dropdown — a passive learning-page list
  // (the ACTIVE_CAPTURE pointer marks the mount) plus a jump / confirmed
  // course-switch that reuses the 0.1.57 end-without-report semantics.
  // 0.2.38: the course tab list becomes empty-state guidance — hidden whenever
  // loaded content (报告/概览/逐字稿) owns the panel, restored on 清除记录.
  for (const host of [
    "https://api.bilibili.com/*",
    "https://subtitle.bilibili.com/*",
    "https://aisubtitle.hdslb.com/*",
  ]) {
    assert.ok(manifest.host_permissions.includes(host), `caption transport requires ${host}`);
  }
  assert.equal(manifest.version, "0.2.38");
  assert.equal(manifest.name, "Learning Digest");
  assert.equal(packageJson.name, "learning-digest");
  assert.equal(manifest.optional_permissions, undefined);
});

test("YouTube caption internals stay in the reader and MAIN-world bridge", () => {
  // Panel and settings code never parse caption tracks. The worker may route
  // live player responses and authorized timedtext retries; track selection
  // and parsing remain in youtube-captions.js, which is tested in isolation.
  const panelRuntime = ["sidepanel.js", "options.js", "settings.js"]
    .map(read)
    .join("\n");
  const background = read("background.js");
  const manifest = read("manifest.json");

  assert.doesNotMatch(panelRuntime, /timedtext|movie_player|captionTrack|caption track/i);
  assert.doesNotMatch(panelRuntime, /youtu\.be/i);
  assert.match(background, /readYouTubeLiveCaptionSource/);
  assert.match(background, /readYouTubePlayerCaptionTracks/);
  assert.doesNotMatch(manifest, /timedtext|movie_player|captionTrack|caption track/i);
  for (const removed of ["captions.js", "content.js"]) {
    assert.equal(
      fs.existsSync(path.join(root, removed)),
      false,
      `${removed} must be removed`,
    );
  }
});

test("release copy documents current scope without em dashes", () => {
  const readme = readRepo("README.md");
  const chineseReadme = readRepo("README.zh-CN.md");
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.doesNotMatch(readme, /—/);
  assert.doesNotMatch(chineseReadme, /—/);
  assert.doesNotMatch(manifest.description, /—/);
  assert.doesNotMatch(packageJson.description, /—/);

  assert.equal(manifest.name, "Learning Digest");
  assert.equal(packageJson.name, "learning-digest");
  assert.match(
    read("scripts/package-extension.sh"),
    /learning-digest-v\$version\.zip/,
  );
  assert.doesNotMatch(
    [readme, chineseReadme, readRepo("PRIVACY.md"), readRepo("SECURITY.md")].join("\n"),
    /\bYT Digest\b/,
  );
  assert.doesNotMatch(
    [readme, chineseReadme, readRepo("PRIVACY.md"), readRepo("SECURITY.md")].join("\n"),
    /youtube/i,
  );
  assert.match(readme, /^# Learning Digest$/m);
  assert.match(
    readme,
    /Turn live course audio into a learning resource with segment-by-segment transcription, rolling summaries, and a full-session digest\./,
  );
  assert.match(chineseReadme, /^# Learning Digest$/m);
  assert.match(
    chineseReadme,
    /把课程音频逐段转写成学习资料：分段转写、滚动摘要和整节 Digest。/,
  );

  // New scope: course platforms, Session/Segment pipeline, first platform.
  for (const doc of [readme, chineseReadme]) {
    assert.match(doc, /Session/);
    assert.match(doc, /Segment/);
    assert.match(doc, /xiaoe-tech\.com/);
    assert.match(doc, /Speech Provider/);
  }

  // Install-from-GitHub, agent-assisted flow with explicit path choice.
  assert.match(readme, /^## Install with your coding agent$/m);
  assert.match(
    readme,
    /permanent folder I choose[\s\S]*tell me its exact full path[\s\S]*If I need a suggestion during this first installation[\s\S]*`~\/Documents\/learning-digest`[\s\S]*`%USERPROFILE%\\Documents\\learning-digest`[\s\S]*do not assume either path/,
  );
  assert.match(
    readme,
    /Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location\./,
  );
  assert.match(
    readme,
    /selecting the exact project folder you chose in Chrome with \*\*Load unpacked\*\*/,
  );
  assert.match(
    readme,
    /Select the exact project folder you chose, which must contain `manifest\.json`/,
  );
  assert.match(readme, /upstream issues and pull requests are not accepted/i);
  assert.doesNotMatch(readme, /^## Contributing$/m);
  assert.match(chineseReadme, /^## 让你的编程 Agent 帮你安装$/m);
  assert.match(
    chineseReadme,
    /我选择的长期保留文件夹[\s\S]*告诉我准确的完整路径[\s\S]*第一次安装时需要位置建议[\s\S]*`~\/Documents\/learning-digest`[\s\S]*`%USERPROFILE%\\Documents\\learning-digest`[\s\S]*不要假设我一定使用这些路径/,
  );
  assert.match(
    chineseReadme,
    /如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。/,
  );
  assert.match(
    chineseReadme,
    /“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹/,
  );
  assert.match(
    chineseReadme,
    /选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest\.json`/,
  );
  assert.match(chineseReadme, /不接受上游 Issue 或 Pull Request/);

  // Bring-your-own-key spirit: AI key setup docs stay, now pointing at the
  // Bailian default (0.1.51) with tiered pricing per the official price page.
  assert.match(readme, /bailian\.console\.aliyun\.com/i);
  assert.match(readme, /help\.aliyun\.com\/zh\/model-studio/i);
  assert.match(readme, /qwen3\.8-flash/);
  assert.match(readme, /tiered pricing/i);
  assert.match(
    readme,
    /help\.aliyun\.com\/zh\/model-studio\/model-pricing/i,
  );
  assert.match(chineseReadme, /bailian\.console\.aliyun\.com/i);
  assert.match(chineseReadme, /qwen3\.8-flash/);
  assert.match(chineseReadme, /阶梯计价/);
  assert.match(
    chineseReadme,
    /help\.aliyun\.com\/zh\/model-studio\/model-pricing/i,
  );
  assert.match(readme, /published version uses Alibaba Cloud Bailian with the qwen3\.8-flash model as its AI provider/i);
  assert.match(chineseReadme, /发布版本通过阿里云百炼使用 qwen3\.8-flash 模型/);
  assert.match(readme, /bring-your-own-key/i);

  const optionsPage = read("options.html");
  const optionsStyles = read("options.css");
  const optionsScript = read("options.js");
  assert.doesNotMatch(optionsPage, /<select\b[^>]*\bid="provider"/);
  assert.doesNotMatch(optionsPage, /id="provider"/);
  // (Ticket 6.6) The AI provider card is gone: the panel AI runs on the
  // learning service, so no key/endpoint/model fields remain.
  assert.doesNotMatch(optionsPage, /id="aiApiKey"/);
  assert.doesNotMatch(optionsPage, /id="aiBaseUrl"/);
  assert.doesNotMatch(optionsPage, /id="aiModel"/);
  assert.doesNotMatch(optionsPage, /bailian\.console\.aliyun\.com/i);
  const detailsTag = optionsPage.match(
    /<details\b[^>]*class="card customization-card"[^>]*>/,
  );
  assert.ok(detailsTag, "Expected a native Local remix details disclosure");
  assert.doesNotMatch(detailsTag[0], /\sopen(?:\s|=|>)/i);
  assert.match(
    optionsPage,
    /<summary class="customization-summary">[\s\S]*想使用其他 AI 模型？[\s\S]*编辑并复制一段可安全交给编程 Agent 的提示词[\s\S]*<\/summary>/,
  );
  assert.match(
    optionsPage,
    /class="customization-steps"[\s\S]*在编程 Agent 中打开 Learning Digest 解压后的项目文件夹。[\s\S]*把 \[PROVIDER\] 和 \[MODEL\] 替换成你想使用的服务和模型。[\s\S]*不要在提示词或聊天中加入 API 密钥[\s\S]*<\/ol>/,
  );
  assert.match(
    optionsPage,
    /class="prompt-reminder"[\s\S]*复制前，请先把 \[PROVIDER\] 和 \[MODEL\] 替换成你想使用的服务和模型。/,
  );
  assert.doesNotMatch(optionsPage, /~\/Documents\/youtube-digest/);
  assert.doesNotMatch(optionsPage, /%USERPROFILE%\\Documents\/youtube-digest/);
  assert.match(optionsPage, /id="copyCustomizationPromptBtn"/);
  // normalize() reads YTD_SEGMENTER at call time; the options page must
  // load the segmenter before settings.js or the browser falls into the
  // Node-only require() path (\u201crequire is not defined\u201d).
  assert.match(
    optionsPage,
    /<script src="session-segmenter\.js"><\/script>\s*<script src="settings\.js">/,
  );
  assert.match(optionsStyles, /\.customization-summary:hover\s*\{/);
  assert.match(optionsStyles, /\.customization-summary:focus-visible\s*\{/);
  assert.match(optionsStyles, /\.data-card\s*\{[^}]*margin-top:\s*36px;/);
  assert.match(optionsScript, /clipboard\.writeText/);
  assert.match(optionsScript, /已复制编辑后的提示词。/);
  // (Ticket 6.6) The v5 migration is normalize() on load: the stamped blob
  // is persisted on first read, dropping the retired AI fields.
  assert.match(optionsScript, /settingsApi\.normalize[\s\S]*storage\.set/);

  assert.ok(optionsPage.includes(">请把当前本地 Learning Digest 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 Learning Digest。如果验证失败，请停止，并让我在编程 Agent 中打开 Learning Digest 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。现有服务专用的请求参数和重试逻辑继续只用于现有服务。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，以及如何在 Learning Digest 侧边栏中验证修改。</textarea>"));
  assert.doesNotMatch(optionsPage, /Documents|USERPROFILE/);

  assert.match(readme, /^## Remix it with your coding agent$/m);
  assert.match(readme, /more translation languages/i);
  assert.match(readme, /customized summary templates/i);
  assert.match(readme, /vocabulary notebook/i);
  assert.match(
    readme,
    /first open the exact Learning Digest project folder that Chrome loaded through \*\*Load unpacked\*\* in your coding agent/,
  );
  assert.match(
    chineseReadme,
    /先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 Learning Digest 项目文件夹/,
  );

  const publishedDocs = [
    readme,
    chineseReadme,
    readRepo("PRIVACY.md"),
    readRepo("SECURITY.md"),
  ].join("\n");
  assert.doesNotMatch(publishedDocs, /custom OpenAI-compatible/i);
  assert.doesNotMatch(publishedDocs, /optional custom-origin/i);
  assert.doesNotMatch(publishedDocs, /chosen AI provider/i);
  assert.doesNotMatch(publishedDocs, /configure a different OpenAI-compatible/i);
});

test("product UI contains no emoji or emoji-like pictographs", () => {
  const productUi = [
    read("sidepanel.html"),
    read("sidepanel.js"),
    read("options.html"),
    read("options.js"),
  ].join("\n");

  assert.doesNotMatch(
    productUi,
    /\p{Extended_Pictographic}|[✓✕⧉▶]/u,
  );
  assert.doesNotMatch(productUi, /&#(?:9655|9888);/);
});

test("selection actions use two equal edge-to-edge hover areas", () => {
  const css = read("sidepanel.css");

  assert.match(
    css,
    /\.explain-tooltip\s*\{[^}]*padding:\s*0;[^}]*overflow:\s*hidden;/,
  );
  assert.match(
    css,
    /\.explain-btn,\s*\.selection-note-btn\s*\{[^}]*flex:\s*1 1 50%;[^}]*border-radius:\s*0;/,
  );
  assert.match(
    css,
    /\.explain-tooltip\s*\{[^}]*animation:\s*selectionToolbarIn/,
  );
  assert.match(
    css,
    /@keyframes selectionToolbarIn\s*\{[\s\S]*transform:\s*translate\(-50%, 4px\);[\s\S]*transform:\s*translate\(-50%, 0\);/,
  );
});

test("note delete is an accessible SVG action at the end of the action row", () => {
  const js = read("sidepanel.js");
  const css = read("sidepanel.css");

  assert.match(
    js,
    /<div class="note-actions">[\s\S]*class="[^"]*note-copy-text[^"]*"[\s\S]*class="note-delete"[\s\S]*aria-label="删除笔记"[\s\S]*<svg viewBox="0 0 24 24" aria-hidden="true">/,
  );
  assert.doesNotMatch(js, /class="note-delete"[^>]*>Delete<\/button>/);
  assert.match(
    css,
    /\.note-delete\s*\{[^}]*place-items:\s*center;[^}]*margin-left:\s*auto;/,
  );
  assert.match(css, /\.note-delete:focus-visible\s*\{[^}]*outline:/);
});

test("notes filters preserve selected contrast and expose pressed state", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");

  assert.match(
    html,
    /id="notesFilterThis"[\s\S]*?aria-pressed="true"[\s\S]*?>[\s\S]*?本会话/,
  );
  assert.match(
    html,
    /id="notesFilterAll"[\s\S]*?aria-pressed="false"[\s\S]*?>[\s\S]*?全部笔记/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn\.active:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-hover\);[^}]*color:\s*white;/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn:hover:not\(:disabled\)\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-secondary\);/,
  );
  assert.match(css, /\.notes-filter \.enhance-btn:focus-visible\s*\{[^}]*outline:/);
  assert.match(js, /applyNotesFilter\(false\)/);
  assert.match(js, /applyNotesFilter\(true\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(!showAll\)\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(showAll\)\)/);
});

test("side panel shares the Web library visual tokens", () => {
  const css = read("sidepanel.css");
  const webCss = readRepo("apps/web/src/styles.css");

  for (const token of [
    "--bg: oklch(97.5% 0.008 210)",
    "--surface: oklch(99% 0.004 210)",
    "--text: oklch(25% 0.025 210)",
    "--text-secondary: oklch(48% 0.025 210)",
    "--accent: oklch(48% 0.085 174)",
    "--accent-hover: oklch(41% 0.075 174)",
  ]) {
    assert.ok(css.includes(token), `side panel is missing ${token}`);
  }
  assert.ok(webCss.includes("--ld-accent-600: oklch(48% 0.085 174)"));
  assert.ok(webCss.includes("--ld-accent-700: oklch(41% 0.075 174)"));
  assert.match(css, /--r-md:\s*12px;/);
  assert.doesNotMatch(css, /rgba\(200, 103, 79/);
});

test("welcome library entries and primary controls use a compact aligned layout", () => {
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");

  assert.match(
    css,
    /\.welcome-container\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*48px minmax\(0, 1fr\);[^}]*text-align:\s*left;/,
  );
  assert.match(
    css,
    /\.collect-entry,\s*\.note-entry\s*\{[^}]*border:\s*1px solid var\(--border\);[^}]*border-radius:\s*var\(--r-md\);/,
    "library entries should share the same card treatment",
  );
  assert.match(
    css,
    /\.course-tabs\s*\{[^}]*border:\s*1px solid var\(--border\);[^}]*border-radius:\s*var\(--r-md\);/,
    "course selection should use the shared card treatment",
  );
  assert.match(css, /\.note-input\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/);
  assert.match(css, /\.session-btn\s*\{[^}]*min-height:\s*40px;[^}]*border-radius:\s*var\(--r-sm\);/);
  assert.match(js, /state === "welcome" \? "grid" : "none"/);
  assert.match(js, /state === "authGate" \? "grid" : "none"/);
});

test("runtime has no source-file credential dependency or retired model", () => {
  const runtime = [
    "background.js",
    "sidepanel.js",
    "options.js",
    "settings.js",
    "panel-ai.js",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(runtime, /\bCONFIG\./);
  assert.doesNotMatch(runtime, /importScripts\(["']config\.js/);
  assert.doesNotMatch(runtime, /\bdeepseek-chat\b/);
  // (Ticket 6.6) The local AI Provider config is retired — no model string
  // remains in the runtime, and no chat-completions call either.
  assert.doesNotMatch(runtime, /qwen3\.8-flash/);
  assert.doesNotMatch(runtime, /chat\/completions/);
});

test("retired files are absent", () => {
  for (const file of [
    "reader.html",
    "reader.js",
    "remix-prompts.js",
    "config.example.js",
    "captions.js",
    "content.js",
    "prompts/note-cleanup.md",
    "prompts/analysis.md",
    // Ticket 6.6 (issue #91): the local AI computation and its prompts are
    // retired — the panel AI runs on the learning service.
    "session-summary.js",
    "prompts/topic-tick.md",
    "prompts/session-report.md",
    "prompts/explain.md",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test("core Learning Digest modules ship in the release and load in the service worker", () => {
  const checkRelease = read("scripts/check-release.sh");
  for (const module of [
    "speech-transcription.js",
    "session-pipeline.js",
    "session-timeline.js",
    "session-persistence.js",
    // Ticket 6.6 (#91): the panel AI's server-side client (contract-r4
    // §6/§7) behind the rolling-summary tick, the digest pass and explain.
    "panel-ai.js",
    "source-platforms.js",
    "session-segmenter.js",
    "page-bridge.js",
    // P6 authorization gate: the pure module behind the auth check and the
    // link code exchange.
    "auth-gate.js",
    // P8 collect-current-page: the pure favorite/resolve state machine, and
    // the shared four-station identity extractor it rides on (contracts/,
    // same file the API tests pin).
    "collect.js",
    // P10 learning-start: the course tab list, the locked-target state
    // machine and the progress write client.
    "learning-start.js",
    // P12 library notes: the pure note state machine (request build,
    // idempotent resend, draft policy).
    "notes.js",
    // Ticket 2.5 (#68): the Session archive client (contract-r2 §3.1/§3.2/
    // §3.3/§3.5) and the page-side bilibili caption reader behind the
    // zero-ASR captions path.
    "session-archive.js",
    "bilibili-captions.js",
    // Ticket 2.6 (#69): the youtube caption reader — the ported
    // youtube-digest captions mechanism over the watch page's embedded
    // player response.
    "youtube-captions.js",
    // Ticket 2.4 (#67): the D11 audio-segment upload client behind the ASR
    // archive path.
    "transcript-pipeline.js",
    // Round-1 review fix: the shared §1 envelope + base-URL helpers behind
    // auth-gate/collect/learning-start/notes.
    "api-client.js",
    // Ticket 6.3 (#88): the site-capability layer — the built-in default
    // table, the GET /v1/site-capabilities client and the cached store
    // behind the start gating and the captions path decision.
    "site-capabilities.js",
    // Round-2 review fix: the shared §2.2 Segment check + coverage helper
    // behind bilibili-captions/youtube-captions/session-archive.
    "transcript-shapes.js",
    "contracts/platform-video-id.js",
    "offscreen.js",
    "offscreen.html",
    // The report surfaces (#30): the pure renderer, the full report page and
    // its controller.
    "report-render.js",
    "report.html",
    "report.js",
  ]) {
    assert.match(checkRelease, new RegExp(`"${module}"`), module);
  }
  assert.match(
    read("background.js"),
    /importScripts\("api-client\.js", "site-capabilities\.js", "transcript-shapes\.js", "settings\.js", "speech-transcription\.js", "session-pipeline\.js", "session-timeline\.js", "session-persistence\.js", "source-platforms\.js", "session-segmenter\.js", "panel-ai\.js", "report-render\.js", "auth-gate\.js", "collect\.js", "learning-start\.js", "notes\.js", "session-archive\.js", "transcript-pipeline\.js", "bilibili-captions\.js", "youtube-captions\.js", "contracts\/platform-video-id\.js"\)/,
  );
});
