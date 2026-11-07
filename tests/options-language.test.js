const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function createLocalStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("Settings copy is Chinese-only", () => {
  assert.equal(options.translate("zh-CN", "pageTitle"), "Learning Digest 设置");
  assert.equal(options.translate("zh-CN", "saveSettings"), "保存设置");
  assert.equal(
    options.translate("zh-CN", "clearedDigests", { count: 2 }),
    "已清除 2 条缓存摘要。",
  );

  // Any non-Chinese request falls back to Chinese; there is no English copy.
  assert.equal(options.translate("en", "pageTitle"), "Learning Digest 设置");
  assert.deepEqual(Object.keys(options.COPY), ["zh-CN"]);

  const html = read("options.html");
  const referencedKeys = [
    ...html.matchAll(/data-i18n(?:-html|-aria-label)?="([^"]+)"/g),
  ].map((match) => match[1]);
  for (const key of referencedKeys) {
    assert.ok(options.COPY["zh-CN"][key], `Missing Chinese copy for ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(options.COPY), /—/);
  assert.doesNotMatch(html, /—/);
});

test("language preference persists through extension-compatible storage", async () => {
  const storedValues = {};
  const chromeApi = {
    storage: {
      local: {
        async get(key) {
          return Object.hasOwn(storedValues, key)
            ? { [key]: storedValues[key] }
            : {};
        },
        async set(items) {
          Object.assign(storedValues, items);
        },
        async remove() {},
        async clear() {},
      },
    },
  };
  const storage = options.createStorageAdapter(chromeApi);

  await options.persistPreferredLanguage(storage, "zh-CN");

  assert.equal(storedValues[options.LANGUAGE_STORAGE_KEY], "zh-CN");
  assert.equal(await options.readPreferredLanguage(storage), "zh-CN");
});

test("non-extension preview safely persists language in localStorage", async () => {
  const localStorage = createLocalStorage();
  const firstSession = options.createStorageAdapter(null, localStorage);

  await options.persistPreferredLanguage(firstSession, "zh-CN");

  const reopenedSession = options.createStorageAdapter(null, localStorage);
  assert.equal(await options.readPreferredLanguage(reopenedSession), "zh-CN");
  assert.equal(options.normalizeLanguage("unsupported"), "zh-CN");
  assert.equal(options.normalizeLanguage("en"), "zh-CN");
});

test("options page has no language switcher", () => {
  const html = read("options.html");
  assert.doesNotMatch(html, /language-switch/);
  assert.doesNotMatch(html, /data-language=/);
});

test("customization guidance is concise and has a visible placeholder reminder", () => {
  const html = read("options.html");
  const steps = html.match(
    /<ol class="customization-steps">([\s\S]*?)<\/ol>/,
  );

  assert.ok(steps, "Expected a numbered customization guide");
  assert.equal((steps[1].match(/<li\b/g) || []).length, 3);
  assert.match(html, /class="prompt-reminder"/);
  assert.match(html, /role="note"/);
  assert.equal(
    options.translate("zh-CN", "customizationReminder"),
    "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
  );
  assert.equal(
    options.translate("zh-CN", "customizationStepFolder"),
    "在编程 Agent 中打开 Learning Digest 解压后的项目文件夹。",
  );
  assert.doesNotMatch(html, /~\/Documents\/learning-digest/);
  assert.doesNotMatch(html, /%USERPROFILE%\\Documents\\learning-digest/);
});

test("customization prompt is prefilled in Chinese", () => {
  const html = read("options.html");
  const chinesePrompt = options.translate("zh-CN", "customizationPrompt");

  assert.doesNotMatch(html, /supadata/i);
  assert.match(html, /placeholder="Paste your OpenRouter key"/);
  assert.match(html, /https:\/\/openrouter\.ai\/keys/);
  assert.ok(html.includes(`>${chinesePrompt}</textarea>`));
  assert.match(chinesePrompt, /^请把当前本地 Learning Digest 工作区改为使用/);
  assert.match(
    chinesePrompt,
    /DeepSeek 专用的请求参数和重试逻辑继续只用于 DeepSeek。新服务的专属规则请单独处理，避免相互影响。/,
  );

  assert.match(chinesePrompt, /\[PROVIDER\]/);
  assert.match(chinesePrompt, /\[MODEL\]/);
  assert.match(chinesePrompt, /manifest\.json/);
  assert.match(chinesePrompt, /README\.md/);
  assert.match(chinesePrompt, /README\.zh-CN\.md/);
  assert.match(chinesePrompt, /PRIVACY\.md/);
  assert.match(chinesePrompt, /SECURITY\.md/);
  assert.match(chinesePrompt, /npm test/);
  assert.match(chinesePrompt, /npm run check/);
  assert.match(chinesePrompt, /npm run package/);
  assert.doesNotMatch(chinesePrompt, /—/);

  const textareaTag = html.match(/<textarea id="customizationPrompt"[^>]*>/);
  assert.ok(textareaTag, "Expected the customization prompt textarea");
  assert.doesNotMatch(textareaTag[0], /\sreadonly(?:\s|=|>)/);
  assert.match(
    textareaTag[0],
    /aria-describedby="customizationPromptReminder"/,
  );
  assert.doesNotMatch(html, /<textarea id="customizationPrompt"[^>]*data-i18n/);
});

test("edited prompt drafts survive a same-language round trip", () => {
  const drafts = options.createPromptDrafts();
  const chineseDefault = drafts["zh-CN"];
  assert.equal(typeof chineseDefault, "string");

  const edited = options.switchPromptDraft(
    drafts,
    "zh-CN",
    "zh-CN",
    "已编辑 [PROVIDER] [MODEL]",
  );
  assert.equal(edited.prompt, "已编辑 [PROVIDER] [MODEL]");
  assert.equal(edited.language, "zh-CN");

  // Unknown languages normalize to Chinese instead of falling back to English.
  const normalized = options.switchPromptDraft(
    drafts,
    "fr",
    "en",
    "ignored",
  );
  assert.equal(normalized.language, "zh-CN");
});

test("copy helper writes the current edited textarea value", async () => {
  const writes = [];
  const clipboard = {
    async writeText(value) {
      writes.push(value);
    },
  };

  await options.copyPromptValue(
    clipboard,
    "My edited prompt for [PROVIDER] and [MODEL]",
  );

  assert.deepEqual(writes, ["My edited prompt for [PROVIDER] and [MODEL]"]);
});

test("localized prompt updates preserve the textarea selection and scroll", () => {
  const chinesePrompt = options.translate("zh-CN", "customizationPrompt");
  const textarea = {
    value: chinesePrompt,
    selectionStart: 12,
    selectionEnd: 48,
    selectionDirection: "forward",
    scrollTop: 90,
    scrollLeft: 7,
    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    },
  };

  options.updateLocalizedPrompt(textarea, chinesePrompt);

  assert.equal(textarea.value, chinesePrompt);
  assert.equal(textarea.selectionStart, 12);
  assert.equal(textarea.selectionEnd, 48);
  assert.equal(textarea.selectionDirection, "forward");
  assert.equal(textarea.scrollTop, 90);
  assert.equal(textarea.scrollLeft, 7);
});
