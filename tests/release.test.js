const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

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
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ["https://*.xiaoe-tech.com/*"],
      js: ["page-bridge.js"],
      run_at: "document_idle",
    },
  ]);
  for (const host of [
    "https://api.deepseek.com/*",
    "https://openrouter.ai/*",
    "https://api.groq.com/*",
    "https://dashscope.aliyuncs.com/*",
    "https://*.xiaoe-tech.com/*",
  ]) {
    assert.ok(
      manifest.host_permissions.includes(host),
      `host_permissions must include ${host}`,
    );
  }
  assert.ok(
    !manifest.host_permissions.some((host) => /youtube|youtu\.be/i.test(host)),
    "host_permissions must not include YouTube",
  );
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
  assert.equal(manifest.version, "0.1.27");
  assert.equal(manifest.name, "Learning Digest");
  assert.equal(packageJson.name, "learning-digest");
  assert.equal(manifest.optional_permissions, undefined);
});

test("no YouTube-specific runtime code remains", () => {
  const runtime = [
    "manifest.json",
    "background.js",
    "sidepanel.js",
    "options.js",
    "settings.js",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(runtime, /youtube|youtu\.be|timedtext|movie_player/i);
  assert.doesNotMatch(runtime, /captionTrack|caption track/i);
  for (const removed of ["captions.js", "content.js"]) {
    assert.equal(
      fs.existsSync(path.join(root, removed)),
      false,
      `${removed} must be removed`,
    );
  }
});

test("release copy documents current scope without em dashes", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
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
    [readme, chineseReadme, read("PRIVACY.md"), read("SECURITY.md")].join("\n"),
    /\bYT Digest\b/,
  );
  assert.doesNotMatch(
    [readme, chineseReadme, read("PRIVACY.md"), read("SECURITY.md")].join("\n"),
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

  // Bring-your-own-key spirit: DeepSeek key setup docs stay.
  assert.match(readme, /openrouter\.ai\/keys/i);
  assert.match(readme, /openrouter\.ai\/docs/i);
  assert.match(readme, /openrouter\.ai\/models\/deepseek\/deepseek-v4\.1-flash-1017/i);
  assert.match(readme, /\$0\.007[\s\S]*\$0\.014/);
  assert.match(readme, /\$0\.22[\s\S]*\$0\.44/);
  assert.match(readme, /\$0\.66[\s\S]*\$1\.32/);
  assert.match(chineseReadme, /openrouter\.ai\/keys/i);
  assert.match(chineseReadme, /\$0\.007[\s\S]*\$0\.014/);
  assert.match(chineseReadme, /\$0\.22[\s\S]*\$0\.44/);
  assert.match(chineseReadme, /\$0\.66[\s\S]*\$1\.32/);
  assert.match(readme, /published version uses OpenRouter with the DeepSeek V4\.1 Flash model as its AI provider/i);
  assert.match(chineseReadme, /发布版本通过 OpenRouter 使用 DeepSeek V4\.1 Flash 模型/);
  assert.match(readme, /bring-your-own-key/i);

  const optionsPage = read("options.html");
  const optionsStyles = read("options.css");
  const optionsScript = read("options.js");
  assert.match(optionsPage, /openrouter\.ai\/keys/i);
  assert.doesNotMatch(optionsPage, /<select\b[^>]*\bid="provider"/);
  assert.doesNotMatch(optionsPage, /id="provider"/);
  assert.match(optionsPage, /id="aiBaseUrl"/);
  assert.match(optionsPage, /id="aiModel"/);
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
  assert.match(optionsScript, /migration\.migrated[\s\S]*storage\.set/);

  assert.ok(optionsPage.includes(">请把当前本地 Learning Digest 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 Learning Digest。如果验证失败，请停止，并让我在编程 Agent 中打开 Learning Digest 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。DeepSeek 专用的请求参数和重试逻辑继续只用于 DeepSeek。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，以及如何在 Learning Digest 侧边栏中验证修改。</textarea>"));
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
    read("PRIVACY.md"),
    read("SECURITY.md"),
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
    /id="notesFilterThis"[\s\S]*?aria-pressed="true"[\s\S]*?>[\s\S]*?本课程/,
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
  assert.match(js, /setNotesFilter\(false\)/);
  assert.match(js, /setNotesFilter\(true\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(!showAll\)\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(showAll\)\)/);
});

test("runtime has no source-file credential dependency or retired model", () => {
  const runtime = [
    "background.js",
    "sidepanel.js",
    "options.js",
    "settings.js",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(runtime, /\bCONFIG\./);
  assert.doesNotMatch(runtime, /importScripts\(["']config\.js/);
  assert.doesNotMatch(runtime, /\bdeepseek-chat\b/);
  assert.match(runtime, /deepseek\/deepseek-v4\.1-flash-1017/);
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
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test("published prompt files contain runtime sections", () => {
  const expectedSections = {
    "prompts/analysis.md": ["System prompt", "User prompt"],
    "prompts/explain.md": ["System prompt", "User prompt"],
  };

  for (const [file, sections] of Object.entries(expectedSections)) {
    const markdown = read(file);
    for (const section of sections) {
      assert.match(markdown, new RegExp(`^## ${section}$`, "m"));
    }
  }
});

test("core Learning Digest modules ship in the release and load in the service worker", () => {
  const checkRelease = read("scripts/check-release.sh");
  for (const module of [
    "speech-transcription.js",
    "speech-providers.js",
    "session-pipeline.js",
    "session-persistence.js",
    "source-platforms.js",
    "session-segmenter.js",
    "session-summary.js",
    "page-bridge.js",
    "offscreen.js",
    "offscreen.html",
  ]) {
    assert.match(checkRelease, new RegExp(`"${module}"`), module);
  }
  assert.match(
    read("background.js"),
    /importScripts\("settings\.js", "speech-transcription\.js", "speech-providers\.js", "session-pipeline\.js", "session-persistence\.js", "source-platforms\.js", "session-segmenter\.js", "session-summary\.js"\)/,
  );
});
