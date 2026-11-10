const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const AI_CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "example-model",
};

function fakeFetch(status) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status };
  };
  return { fetchImpl, calls };
}

test("checkAiConnection posts a minimal completion to baseUrl + /chat/completions", async () => {
  const { fetchImpl, calls } = fakeFetch(200);
  const result = await options.checkAiConnection(fetchImpl, AI_CONFIG);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(JSON.parse(calls[0].init.body).model, "example-model");
});

test("checkAiConnection classifies failure statuses", async () => {
  for (const [status, reason] of [
    [401, "aiKeyRejected"],
    [403, "aiKeyRejected"],
    [404, "aiNotFound"],
    [500, "aiHttpError"],
  ]) {
    const { fetchImpl } = fakeFetch(status);
    const result = await options.checkAiConnection(fetchImpl, AI_CONFIG);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    if (reason === "aiHttpError") assert.equal(result.status, 500);
  }

  const networkError = await options.checkAiConnection(
    async () => {
      throw new TypeError("fetch failed");
    },
    AI_CONFIG,
  );
  assert.deepEqual(networkError, { ok: false, reason: "aiUnreachable" });
});

// --- Speech Provider fields render + save (mock-document, panel-ia style) ----

function makeElement(id = "") {
  const element = {
    id,
    tagName: "",
    dataset: {},
    style: {},
    children: [],
    listeners: {},
    disabled: false,
    hidden: false,
    href: "",
    type: "",
    name: "",
    value: "",
    checked: false,
    placeholder: "",
    textValue: "",
    set textContent(value) {
      element.textValue = String(value);
      element.children.length = 0;
    },
    get textContent() {
      return element.textValue;
    },
    className: "",
    classList: {
      add(name) {
        if (!element.className.includes(name)) {
          element.className = `${element.className} ${name}`.trim();
        }
      },
      remove(name) {
        element.className = element.className
          .split(/\s+/)
          .filter((part) => part && part !== name)
          .join(" ");
      },
      contains(name) {
        return element.className.split(/\s+/).includes(name);
      },
    },
    setAttribute(name, value) {
      element[`attr_${name}`] = String(value);
    },
    getAttribute(name) {
      return element[`attr_${name}`];
    },
    append(...kids) {
      element.children.push(...kids);
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    replaceChildren() {
      element.children.length = 0;
    },
    addEventListener(type, handler) {
      element.listeners[type] = handler;
    },
  };
  return element;
}

/**
 * Loads options.js in a mock-document sandbox (the same seam style as
 * tests/panel-ia.test.js) and returns the storage backing plus helpers to
 * flush the async load and drive the settings form.
 */
function loadOptionsPage({ stored = {} } = {}) {
  const elements = {};
  const elementById = (id) => elements[id] || (elements[id] = makeElement(id));
  const createdElements = [];

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => ({ ok: true }),
    document: {
      readyState: "complete",
      title: "",
      documentElement: makeElement("html"),
      body: makeElement("body"),
      getElementById: elementById,
      createElement: (tag) => {
        const el = makeElement();
        el.tagName = tag;
        createdElements.push(el);
        return el;
      },
      querySelectorAll: () => [],
      addEventListener() {},
    },
    chrome: {
      storage: {
        local: {
          get: async (key) => {
            if (key === null) return { ...stored };
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, stored[item]]));
            }
            return { [key]: stored[key] };
          },
          set: async (values) => Object.assign(stored, values),
        },
      },
    },
    YTD_SETTINGS: require("../settings.js"),
    YTD_SPEECH_PROVIDERS: require("../speech-providers.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("options.js"), sandbox);

  const flush = async () => {
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  return {
    elements,
    createdElements,
    stored,
    flush,
    async submit() {
      const form = elementById("settingsForm");
      assert.ok(form.listeners.submit, "the form has a submit handler");
      form.listeners.submit({ preventDefault() {} });
      await flush();
    },
    // Radio inputs currently rendered in the Speech Provider field container.
    radios() {
      const found = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (typeof child !== "object" || child === null) continue;
          if (child.type === "radio") found.push(child);
          walk(child);
        }
      };
      walk(elementById("speechProviderFields"));
      return found;
    },
  };
}

test("the Qwen section renders the 转写模式 radio and saves the choice into the provider config", async () => {
  const stored = {
    ytd_settings: {
      aiApiKey: "sk-ai",
      speechProvider: "qwen",
      speechProviders: { qwen: { apiKey: "sk-qwen" } },
    },
  };
  const page = loadOptionsPage({ stored: JSON.parse(JSON.stringify(stored)) });
  await page.flush();

  // The radio group renders with the definition's two options, defaulting to
  // 分段转写, under the 转写模式 group label.
  const radios = page.radios();
  assert.deepEqual(radios.map((radio) => radio.id), [
    "speech-qwen-mode-segment",
    "speech-qwen-mode-realtime",
  ]);
  assert.deepEqual(radios.map((radio) => radio.value), ["segment", "realtime"]);
  assert.equal(
    radios.find((radio) => radio.value === "segment").checked,
    true,
    "segment is preselected when no stored mode exists",
  );
  assert.equal(radios.find((radio) => radio.value === "realtime").checked, false);
  const groupLabel = page.elements.speechProviderFields.children.find(
    (child) => child?.textContent === "转写模式",
  );
  assert.ok(groupLabel, "the 转写模式 group label renders");

  // Choosing 实时转写 persists into speechProviders.qwen.mode on save,
  // alongside the untouched credentials.
  radios.find((radio) => radio.value === "realtime").listeners.change();
  await page.submit();
  const saved = page.stored.ytd_settings;
  assert.equal(saved.speechProviders.qwen.mode, "realtime");
  assert.equal(saved.speechProviders.qwen.apiKey, "sk-qwen");

  // Reopening the page reloads with the stored value preselected.
  const reloaded = loadOptionsPage({ stored: page.stored });
  await reloaded.flush();
  const reloadedRealtime = reloaded
    .radios()
    .find((radio) => radio.value === "realtime");
  assert.equal(
    reloadedRealtime.checked,
    true,
    "the stored realtime choice preselects the radio",
  );
});

// --- Segment length field (#22): render, save, and migration survival -------

test("the Segment length field renders the stored value", async () => {
  const stored = {
    ytd_settings: {
      aiApiKey: "sk-ai",
      settingsVersion: 2,
      segmentLengthSeconds: 45,
    },
  };
  const page = loadOptionsPage({ stored: JSON.parse(JSON.stringify(stored)) });
  await page.flush();

  assert.equal(
    page.elements.segmentLengthSeconds.value,
    45,
    "the stored Segment length pre-fills the field",
  );
});

test("saving persists a clamped Segment length", async () => {
  // A complete provider config keeps the save gate open; only the Segment
  // length varies.
  const stored = {
    ytd_settings: {
      aiApiKey: "sk-ai",
      speechProvider: "qwen",
      speechProviders: { qwen: { apiKey: "sk-qwen" } },
    },
  };
  const page = loadOptionsPage({ stored: JSON.parse(JSON.stringify(stored)) });
  await page.flush();

  // Below the segmenter minimum (5) the value clamps up to the minimum.
  page.elements.segmentLengthSeconds.value = "1";
  await page.submit();
  assert.equal(page.stored.ytd_settings.segmentLengthSeconds, 5);

  // Above the segmenter maximum (60) the value clamps down to the maximum.
  page.elements.segmentLengthSeconds.value = "300";
  await page.submit();
  assert.equal(page.stored.ytd_settings.segmentLengthSeconds, 60);
});

test("a stamped blob's tuned Segment length survives an options save", async () => {
  const stored = {
    ytd_settings: {
      aiApiKey: "sk-ai",
      settingsVersion: 2,
      segmentLengthSeconds: 45,
      speechProvider: "qwen",
      speechProviders: { qwen: { apiKey: "sk-qwen" } },
    },
  };
  const page = loadOptionsPage({ stored: JSON.parse(JSON.stringify(stored)) });
  await page.flush();

  // The load shows the user's tuned value; the save then builds a FRESH
  // (unstamped) payload from the form. migrateSegmentLength must pass a
  // non-legacy value through so a save never resets it to the default.
  assert.equal(page.elements.segmentLengthSeconds.value, 45);
  await page.submit();
  assert.equal(page.stored.ytd_settings.segmentLengthSeconds, 45);
  assert.equal(page.stored.ytd_settings.settingsVersion, 3);
});

test("the Segment length field markup matches the segmenter clamp and copy guidance", () => {
  const input = read("options.html").match(
    /<input\s+id="segmentLengthSeconds"[\s\S]*?\/>/,
  );
  assert.ok(input, "the Segment length number input renders");
  assert.match(input[0], /type="number"/);
  assert.match(input[0], /min="5"/);
  assert.match(input[0], /max="60"/);
  assert.match(input[0], /step="5"/);

  // 0.1.61: the supported range is 5-60 seconds; the help copy says so and
  // points at the drag-grid coupling (shorter lengths skip less per drag).
  const help = options.translate("zh-CN", "segmentLengthHelp");
  assert.match(help, /分段转写模式下每段采集的音频时长/);
  assert.match(help, /默认 30 秒/);
  assert.match(help, /可填范围 5～60 秒/);
  assert.match(help, /实时转写模式下此字段不生效/);
  assert.match(help, /拖拽落点会对齐到该时长的整数倍边界/);
});

test("other providers are unaffected: the Groq section renders no radio", async () => {
  const stored = {
    ytd_settings: {
      aiApiKey: "sk-ai",
      speechProvider: "groq",
      speechProviders: { groq: { apiKey: "gsk-x" } },
    },
  };
  const page = loadOptionsPage({ stored });
  await page.flush();

  assert.deepEqual(page.radios(), []);
  await page.submit();
  assert.deepEqual(page.stored.ytd_settings.speechProviders.groq, {
    apiKey: "gsk-x",
  });
});

// --- Learning service fields (P6): load + save -------------------------------

test("the learning service fields load the stored URLs and save edits", async () => {
  const stored = {
    ytd_settings: {
      aiApiKey: "sk-ai",
      speechProvider: "groq",
      speechProviders: { groq: { apiKey: "gsk-x" } },
      apiBaseUrl: "https://api.example.com",
      webAppBaseUrl: "https://learn.example.com",
    },
  };
  const page = loadOptionsPage({ stored: JSON.parse(JSON.stringify(stored)) });
  await page.flush();

  assert.equal(page.elements.apiBaseUrl.value, "https://api.example.com");
  assert.equal(page.elements.webAppBaseUrl.value, "https://learn.example.com");

  page.elements.apiBaseUrl.value = "http://127.0.0.1:8787";
  page.elements.webAppBaseUrl.value = "";
  await page.submit();

  const saved = page.stored.ytd_settings;
  assert.equal(saved.apiBaseUrl, "http://127.0.0.1:8787");
  assert.equal(
    saved.webAppBaseUrl,
    "http://127.0.0.1:8080",
    "an empty field keeps the default",
  );
});

test("an invalid learning service URL fails the save with the field's error", async () => {
  const stored = {
    ytd_settings: {
      aiApiKey: "sk-ai",
      speechProvider: "groq",
      speechProviders: { groq: { apiKey: "gsk-x" } },
    },
  };
  const page = loadOptionsPage({ stored: JSON.parse(JSON.stringify(stored)) });
  await page.flush();

  page.elements.apiBaseUrl.value = "ftp://nope.example.com";
  await page.submit();
  assert.match(page.elements.saveStatus.textContent, /学习服务 API 地址/);

  page.elements.apiBaseUrl.value = "https://api.example.com";
  page.elements.webAppBaseUrl.value = "not a url";
  await page.submit();
  assert.match(page.elements.saveStatus.textContent, /授权页地址/);
});

test("the options page renders the 学习服务 card with both URL fields", () => {
  const html = read("options.html");
  assert.match(html, /id="apiBaseUrl"/);
  assert.match(html, /id="webAppBaseUrl"/);
  assert.match(html, /data-i18n="learningService"/);
});
