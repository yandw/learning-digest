const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const PREVIEW_STORAGE_PREFIX = "learningDigestPreview:";
  const SUPPORTED_LANGUAGES = new Set(["zh-CN"]);

  const COPY = {
    "zh-CN": {
      pageTitle: "Learning Digest 设置",
      languageGroupLabel: "界面语言",
      heading: "使用你自己的 API 密钥",
      lede:
        "密钥仅保存在当前 Chrome 个人资料中，只会发送给你配置的 AI 服务。本开源扩展没有开发者服务器，也不使用分析服务。",
      aiProvider: "AI 服务",
      providerSummaryLabel: "支持的 AI 服务",
      providerBadge: "当前版本支持",
      deepseekApiKeyLabel: "AI API 密钥",
      deepseekHelp:
        "Learning Digest 通过 OpenAI 兼容接口调用大模型（默认阿里云百炼 qwen3.8-flash），生成话题时间轴、学习纪要、翻译和润色笔记。",
      deepseekLink: "创建百炼 API 密钥",
      deepseekHelpSuffix: "。",
      aiBaseUrlLabel: "API 基础 URL",
      aiModelLabel: "模型",
      customEndpointHelp:
        "两个字段都留空则保持默认值（阿里云百炼）。自定义端点必须兼容 OpenAI chat-completions API。如果其域名不是 dashscope.aliyuncs.com，需要把该域名加入 manifest.json 的 host_permissions 并重新加载扩展。",
      invalidBaseUrl:
        "API 基础 URL 不是合法的 https 地址（仅 localhost 允许使用 http）。",
      privacyNote:
        "使用 AI 功能时，你配置的 AI 服务会收到逐字稿及相关会话上下文（默认为阿里云百炼）。保存前请查看该服务的服务条款和价格。",
      sessionSettings: "会话",
      summaryIntervalLabel: "话题段触发的最小新内容时长（分钟）",
      summaryIntervalHelp:
        "会话进行中，每当新产生的 Transcript 达到该时长（且至少 10 条记录），AI 服务就会总结出新的话题段并追加到时间轴（每分钟检查一次）。内容阈值越短费用越高；一般课程 15 分钟即可。",
      segmentLengthLabel: "分段长度（秒）",
      segmentLengthHelp:
        "分段转写模式下每段采集的音频时长，改小可更快看到逐字稿（默认 30 秒）；可填范围 5～60 秒；拖拽落点会对齐到该时长的整数倍边界，时长越短，拖拽可能放弃的音频也越少。",
      learningService: "学习服务",
      apiBaseUrlLabel: "学习服务 API 地址",
      apiBaseUrlHelp:
        "插件用这个地址校验关联授权（默认指向本地开发服务 apps/api，端口 8787）。两个字段都留空则保持默认值。",
      webAppBaseUrlLabel: "授权页地址",
      webAppBaseUrlHelp:
        "侧边栏的「打开授权页」按钮会打开这个地址的关联确认页（默认指向本地 Web 应用 apps/web，端口 8080）。",
      apiBaseUrlInvalid:
        "学习服务 API 地址不是合法的 https 地址（仅 localhost 允许使用 http）。",
      webAppBaseUrlInvalid:
        "授权页地址不是合法的 https 地址（仅 localhost 允许使用 http）。",
      saveSettings: "保存设置",
      localRemix: "本地改造",
      customizationTitle: "想使用其他 AI 模型？",
      customizationPurpose: "编辑并复制一段可安全交给编程 Agent 的提示词",
      agentBadge: "可交给编程 Agent",
      customizationIntro: "你可以直接编辑提示词。复制前完成以下三步：",
      customizationStepFolder:
        "在编程 Agent 中打开 Learning Digest 解压后的项目文件夹。",
      customizationStepReplace:
        "把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationStepKeys:
        "不要在提示词或聊天中加入 API 密钥。代码准备好后，请自行填写。",
      customizationPromptLabel: "可编辑的自定义提示词",
      customizationReminderLabel: "提示词提醒",
      customizationReminder:
        "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationPrompt:
        "请把当前本地 Learning Digest 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 Learning Digest。如果验证失败，请停止，并让我在编程 Agent 中打开 Learning Digest 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。现有服务专用的请求参数和重试逻辑继续只用于现有服务。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，以及如何在 Learning Digest 侧边栏中验证修改。",
      copyCustomizationPrompt: "复制编辑后的提示词",
      localData: "本地数据",
      localDataHelp:
        "摘要、翻译和笔记仅保存在当前 Chrome 个人资料中。你可以随时删除。",
      clearCache: "清除缓存的摘要",
      deleteNotes: "删除全部笔记",
      resetData: "重置扩展数据",
      footer:
        '完整数据流说明请参阅仓库中的 <a href="PRIVACY.md" target="_blank">PRIVACY.md</a>。',
      migrationWarning:
        "已安全移除自定义服务设置。AI 密钥已清除。请输入 AI API 密钥以继续使用。",
      saving: "正在保存…",
      verifying: "已保存。正在校验 API 连接…",
      savedVerified:
        "已保存，AI 连接校验通过。请重新打开 Learning Digest 以使用这些设置。",
      verifyFailed: ({ detail }) => `已保存，但连接校验未通过：${detail}`,
      aiKeyRejected: "AI API 密钥被拒绝",
      aiNotFound: "找不到 AI 端点或模型（请检查基础 URL 和模型名称）",
      aiHttpError: ({ status }) => `AI 端点返回 HTTP ${status}`,
      aiUnreachable:
        "无法连接 AI 端点（请检查基础 URL 和 manifest 的 host_permissions）",
      addDeepseekKey: "请添加 AI API 密钥。",
      saveFailed: "无法保存设置，请重试。",
      copying: "正在复制…",
      promptCopied: "已复制编辑后的提示词。",
      copyFailed: "无法复制提示词。请选中提示词文本并手动复制。",
      clearedDigests: ({ count }) => `已清除 ${count} 条缓存摘要。`,
      notesDeleted: "已删除全部已保存的笔记。",
      resetConfirm:
        "要从当前 Chrome 个人资料中删除 API 密钥、缓存摘要、翻译和已保存的笔记吗？",
      allDataDeleted: "已删除全部 Learning Digest 数据。",
      settingsLoadFailed: "无法加载已保存的设置，但你仍可预览此页面。",
    },
  };

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : "zh-CN";
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = COPY[normalizedLanguage][key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  function createStorageAdapter(chromeApi, fallbackStorage) {
    const chromeStorage = chromeApi?.storage?.local;
    const memoryStorage = new Map();

    function fallbackKeys() {
      const keys = [];
      if (!fallbackStorage) return keys;
      try {
        for (let index = 0; index < fallbackStorage.length; index += 1) {
          const key = fallbackStorage.key(index);
          if (key?.startsWith(PREVIEW_STORAGE_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return [];
      }
      return keys;
    }

    function readFallbackValue(key) {
      try {
        const rawValue = fallbackStorage?.getItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
        );
        if (rawValue !== null && rawValue !== undefined) {
          return JSON.parse(rawValue);
        }
      } catch (_error) {
        // Fall through to memory when localStorage is unavailable or malformed.
      }
      return memoryStorage.get(key);
    }

    function writeFallbackValue(key, value) {
      memoryStorage.set(key, value);
      try {
        fallbackStorage?.setItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch (_error) {
        // The in-memory copy keeps a restricted preview functional.
      }
    }

    return {
      async get(keys) {
        if (chromeStorage) return chromeStorage.get(keys);

        const requestedKeys =
          keys === null
            ? [
                ...new Set([
                  ...memoryStorage.keys(),
                  ...fallbackKeys().map((key) =>
                    key.slice(PREVIEW_STORAGE_PREFIX.length),
                  ),
                ]),
              ]
            : Array.isArray(keys)
              ? keys
              : [keys];

        return Object.fromEntries(
          requestedKeys
            .map((key) => [key, readFallbackValue(key)])
            .filter(([, value]) => value !== undefined),
        );
      },

      async set(items) {
        if (chromeStorage) return chromeStorage.set(items);
        for (const [key, value] of Object.entries(items)) {
          writeFallbackValue(key, value);
        }
      },

      async remove(keys) {
        if (chromeStorage) return chromeStorage.remove(keys);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryStorage.delete(key);
          try {
            fallbackStorage?.removeItem(`${PREVIEW_STORAGE_PREFIX}${key}`);
          } catch (_error) {
            // Memory removal is sufficient for this preview session.
          }
        }
      },

      async clear() {
        if (chromeStorage) return chromeStorage.clear();
        memoryStorage.clear();
        for (const key of fallbackKeys()) {
          try {
            fallbackStorage.removeItem(key);
          } catch (_error) {
            // Continue clearing any remaining preview keys.
          }
        }
      },
    };
  }

  async function readPreferredLanguage(storage) {
    const stored = await storage.get(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored[LANGUAGE_STORAGE_KEY]);
  }

  async function persistPreferredLanguage(storage, language) {
    const normalizedLanguage = normalizeLanguage(language);
    await storage.set({ [LANGUAGE_STORAGE_KEY]: normalizedLanguage });
    return normalizedLanguage;
  }

  function updateLanguageButtonState(buttons, language) {
    const normalizedLanguage = normalizeLanguage(language);
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === normalizedLanguage),
      );
    }
  }

  function updateLocalizedPrompt(textarea, prompt) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    textarea.value = prompt;

    if (
      Number.isInteger(selectionStart) &&
      Number.isInteger(selectionEnd) &&
      typeof textarea.setSelectionRange === "function"
    ) {
      textarea.setSelectionRange(
        Math.min(selectionStart, prompt.length),
        Math.min(selectionEnd, prompt.length),
        selectionDirection || "none",
      );
    }
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  }

  function createPromptDrafts() {
    return {
      "zh-CN": translate("zh-CN", "customizationPrompt"),
    };
  }

  function switchPromptDraft(
    drafts,
    currentLanguage,
    nextLanguage,
    currentValue,
  ) {
    const normalizedCurrentLanguage = normalizeLanguage(currentLanguage);
    const normalizedNextLanguage = normalizeLanguage(nextLanguage);
    drafts[normalizedCurrentLanguage] = String(currentValue ?? "");
    if (typeof drafts[normalizedNextLanguage] !== "string") {
      drafts[normalizedNextLanguage] = translate(
        normalizedNextLanguage,
        "customizationPrompt",
      );
    }
    return {
      language: normalizedNextLanguage,
      prompt: drafts[normalizedNextLanguage],
    };
  }

  async function copyPromptValue(clipboard, value) {
    await clipboard.writeText(value);
  }

  const VERIFY_TIMEOUT_MS = 15000;

  /**
   * Minimal chat completion that proves base URL, key, and model all work.
   * Returns { ok: true } or { ok: false, reason, status? }.
   */
  async function checkAiConnection(fetchImpl, { baseUrl, apiKey, model }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: controller.signal,
      });
      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: "aiKeyRejected" };
      }
      if (response.status === 404) return { ok: false, reason: "aiNotFound" };
      return { ok: false, reason: "aiHttpError", status: response.status };
    } catch (_error) {
      return { ok: false, reason: "aiUnreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  function getSafeLocalStorage(root) {
    try {
      return root.localStorage;
    } catch (_error) {
      return null;
    }
  }

  function initialize(root = globalThis) {
    const doc = root.document;
    const settingsApi = root.YTD_SETTINGS;
    if (!doc || !settingsApi) return;

    const storage = createStorageAdapter(
      root.chrome,
      getSafeLocalStorage(root),
    );
    const form = doc.getElementById("settingsForm");
    const aiApiKeyInput = doc.getElementById("aiApiKey");
    const aiBaseUrlInput = doc.getElementById("aiBaseUrl");
    const aiModelInput = doc.getElementById("aiModel");
    const summaryIntervalInput = doc.getElementById("summaryIntervalMinutes");
    const segmentLengthInput = doc.getElementById("segmentLengthSeconds");
    // Learning service origins (P6): the API the linked credential talks to
    // and the Web app origin whose confirmation page authorizes the link.
    const apiBaseUrlInput = doc.getElementById("apiBaseUrl");
    const webAppBaseUrlInput = doc.getElementById("webAppBaseUrl");
    const customizationPrompt = doc.getElementById("customizationPrompt");
    const copyCustomizationPromptBtn = doc.getElementById(
      "copyCustomizationPromptBtn",
    );
    const copyStatus = doc.getElementById("copyStatus");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const statusStates = new Map();
    const promptDrafts = createPromptDrafts();
    let currentLanguage = "zh-CN";

    function renderStatus(element) {
      const state = statusStates.get(element);
      element.textContent = state
        ? translate(currentLanguage, state.key, state.params)
        : "";
    }

    function setStatus(element, key, params = {}) {
      statusStates.set(element, { key, params });
      renderStatus(element);
    }

    function applyLanguage(language) {
      const nextDraft = switchPromptDraft(
        promptDrafts,
        currentLanguage,
        language,
        customizationPrompt.value,
      );
      currentLanguage = nextDraft.language;
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        element.textContent = translate(
          currentLanguage,
          element.dataset.i18n,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(
          currentLanguage,
          element.dataset.i18nHtml,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute(
          "aria-label",
          translate(currentLanguage, element.dataset.i18nAriaLabel),
        );
      }

      updateLocalizedPrompt(
        customizationPrompt,
        nextDraft.prompt,
      );
      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const migration = settingsApi.migrateLegacyCustom(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;

        aiApiKeyInput.value = settings.aiApiKey;
        aiBaseUrlInput.value = settings.aiBaseUrl;
        aiModelInput.value = settings.aiModel;
        if (summaryIntervalInput) {
          summaryIntervalInput.value = settings.summaryIntervalMinutes;
        }
        if (segmentLengthInput) {
          segmentLengthInput.value = settings.segmentLengthSeconds;
        }
        if (apiBaseUrlInput) {
          apiBaseUrlInput.value = settings.apiBaseUrl;
        }
        if (webAppBaseUrlInput) {
          webAppBaseUrlInput.value = settings.webAppBaseUrl;
        }

        if (migration.migrated) {
          await storage.set({ [settingsApi.STORAGE_KEY]: settings });
          setStatus(saveStatus, "migrationWarning");
        }
      } catch (error) {
        setStatus(saveStatus, "settingsLoadFailed");
      }
    }

    async function loadOptions() {
      try {
        applyLanguage(await readPreferredLanguage(storage));
      } catch (_error) {
        applyLanguage("zh-CN");
      }
      await loadSettings();
    }

    async function saveSettings(event) {
      event.preventDefault();
      saveStatus.classList.remove("error");
      setStatus(saveStatus, "saving");

      const baseUrlValue = aiBaseUrlInput.value.trim();
      if (baseUrlValue && !settingsApi.isValidAiBaseUrl(baseUrlValue)) {
        setStatus(saveStatus, "invalidBaseUrl");
        return;
      }

      // Learning service origins (P6): same https/loopback-http rule as the
      // other base URLs; a typo must fail the save, not silently fall back.
      for (const [input, errorKey] of [
        [apiBaseUrlInput, "apiBaseUrlInvalid"],
        [webAppBaseUrlInput, "webAppBaseUrlInvalid"],
      ]) {
        if (input && input.value.trim() && !settingsApi.isValidBaseUrl(input.value.trim())) {
          setStatus(saveStatus, errorKey);
          return;
        }
      }

      const settings = settingsApi.normalize({
        aiApiKey: aiApiKeyInput.value,
        aiBaseUrl: baseUrlValue,
        aiModel: aiModelInput.value,
        summaryIntervalMinutes: summaryIntervalInput?.value,
        segmentLengthSeconds: segmentLengthInput?.value,
        // Left empty means "keep the default" (normalizeBaseUrl's fallback).
        apiBaseUrl: apiBaseUrlInput ? apiBaseUrlInput.value.trim() : undefined,
        webAppBaseUrl: webAppBaseUrlInput ? webAppBaseUrlInput.value.trim() : undefined,
      });

      if (!settings.aiApiKey) {
        setStatus(saveStatus, "addDeepseekKey");
        return;
      }

      try {
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
        return;
      }

      // Settings are already persisted; now verify the AI API works.
      saveStatus.classList.remove("error");
      setStatus(saveStatus, "verifying");
      const aiResult = await checkAiConnection(root.fetch.bind(root), {
        baseUrl: settings.aiBaseUrl,
        apiKey: settings.aiApiKey,
        model: settings.aiModel,
      });

      if (!aiResult.ok) {
        saveStatus.classList.add("error");
        setStatus(saveStatus, "verifyFailed", {
          detail: translate(currentLanguage, aiResult.reason, {
            status: aiResult.status,
          }),
        });
      } else {
        setStatus(saveStatus, "savedVerified");
      }
    }

    async function copyCustomizationPrompt() {
      setStatus(copyStatus, "copying");
      try {
        await copyPromptValue(
          root.navigator.clipboard,
          customizationPrompt.value,
        );
        setStatus(copyStatus, "promptCopied");
      } catch (_error) {
        setStatus(copyStatus, "copyFailed");
      }
    }

    async function clearCachedDigests() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith("digest_"));
      if (keys.length) await storage.remove(keys);
      setStatus(dataStatus, "clearedDigests", { count: keys.length });
    }

    async function clearNotes() {
      await storage.remove("ytd_notes");
      setStatus(dataStatus, "notesDeleted");
    }

    async function resetAllData() {
      const confirmed = root.confirm(
        translate(currentLanguage, "resetConfirm"),
      );
      if (!confirmed) return;

      await storage.clear();
      await persistPreferredLanguage(storage, currentLanguage);
      await loadSettings();
      setStatus(dataStatus, "allDataDeleted");
    }

    form.addEventListener("submit", saveSettings);
    copyCustomizationPromptBtn.addEventListener(
      "click",
      copyCustomizationPrompt,
    );
    doc
      .getElementById("clearCacheBtn")
      .addEventListener("click", clearCachedDigests);
    doc.getElementById("clearNotesBtn").addEventListener("click", clearNotes);
    doc.getElementById("resetBtn").addEventListener("click", resetAllData);

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", loadOptions, { once: true });
    } else {
      void loadOptions();
    }
  }

  return {
    COPY,
    LANGUAGE_STORAGE_KEY,
    checkAiConnection,
    copyPromptValue,
    createPromptDrafts,
    createStorageAdapter,
    normalizeLanguage,
    persistPreferredLanguage,
    readPreferredLanguage,
    translate,
    updateLanguageButtonState,
    updateLocalizedPrompt,
    switchPromptDraft,
    initialize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

if (typeof document !== "undefined") {
  YTD_OPTIONS.initialize();
}
