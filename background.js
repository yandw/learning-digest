/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Calling the AI Provider to analyze transcripts, explain selections,
 *    translate content, clean up saved notes, and run the Topic timeline
 *    ticks / Session Digest of an active learning Session
 * 3. Note storage
 * 4. Sending results back to the side panel
 *
 * Source Platform capture (xiaoe-tech.com) and the Session pipeline land in a
 * later ticket; the Session state machine and Speech Provider registry are
 * already loaded here and ready to be driven by that capture layer.
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
// report-render.js is the one pure module shared by all three contexts: the
// worker reads its REPORT_STORAGE_KEY_PREFIX to persist the artifact.
importScripts("settings.js", "speech-transcription.js", "speech-providers.js", "session-pipeline.js", "session-timeline.js", "session-persistence.js", "source-platforms.js", "session-segmenter.js", "session-summary.js", "report-render.js", "auth-gate.js", "collect.js", "learning-start.js", "contracts/platform-video-id.js");

const DEBUG = false;
// Startup marker: opening the service worker console must show this line
// immediately. If it is absent after a reload, the DevTools window is
// attached to a stale worker and every later "no logs" reading is bogus.
console.log(
  "[Learning Digest] background started, version:",
  chrome.runtime.getManifest().version,
);
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Keep storage limited to trusted extension contexts.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[Learning Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  const normalized = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
  // Persist the (possibly migrated) blob once so the version stamp lands in
  // storage and every later read stays on the fast path.
  if (stored[YTD_SETTINGS.STORAGE_KEY]?.settingsVersion !== normalized.settingsVersion) {
    await chrome.storage.local
      .set({ [YTD_SETTINGS.STORAGE_KEY]: normalized })
      .catch((error) =>
        console.error(
          "[Learning Digest] settings migration persist failed:",
          error?.message || error,
        ),
      );
  }
  return normalized;
}

const promptFileCache = new Map();

// ============================================================
// AUTHORIZATION GATE (P6, decision 3 of #49)
// ============================================================
//
// A valid linked credential is the precondition of every feature. The
// credential is presented to GET /v1/me (the API's credential probe); only
// a 401 counts as "authorization died" — a network failure reports
// "unreachable" so a dev server blip never logs the learner out.

// Snapshot of the last auth verdict, so the icon-click path can skip
// capture without an await (the click's capture gesture cannot survive
// one; see the ordering notes in handleActionClicked).
let authCache = { authorized: null, checkedAtMs: 0 };
const AUTH_CACHE_TTL_MS = 60_000;

// Tabs this worker opened for linking: the only tab URLs the gate ever
// reads, and only for the one-time link code in the success address.
const pendingLinkTabs = new Set();

function readStoredAuthCredential() {
  return chrome.storage.local
    .get(YTD_AUTH_GATE.CREDENTIAL_STORAGE_KEY)
    .then(
      (stored) =>
        YTD_AUTH_GATE.parseStoredCredential(
          stored[YTD_AUTH_GATE.CREDENTIAL_STORAGE_KEY],
        ),
      () => null,
    );
}

function recordAuthBreadcrumb(key, payload) {
  chrome.storage.local
    .set({ [key]: { at: Date.now(), ...payload } })
    .catch(() => {});
}

/**
 * Full probe: stored credential + configured API base -> GET /v1/me.
 * Every verdict lands in the storage breadcrumbs (the extension's main
 * debug channel) and refreshes the click-path cache.
 */
async function checkAuthNow() {
  const settings = await getSettings();
  const credential = await readStoredAuthCredential();
  let verdict;
  try {
    verdict = await YTD_AUTH_GATE.checkAuthorization({
      fetchImpl: fetch,
      apiBaseUrl: settings.apiBaseUrl,
      credential,
    });
  } catch (error) {
    verdict = { authorized: false, reason: "unreachable" };
    console.error("[Learning Digest] auth probe crashed:", error?.message || error);
  }
  authCache = { authorized: verdict.authorized, checkedAtMs: Date.now() };
  recordAuthBreadcrumb("ytd_last_auth_check", {
    authorized: verdict.authorized,
    reason: verdict.reason || null,
    hasCredential: !!credential,
  });
  return verdict;
}

/**
 * The icon-click fast path: true unless the last probe said unauthorized.
 * Unknown (cold worker) fails open here — handleStartLearning runs the
 * authoritative await-based check before any capture starts.
 */
function isAuthorizedCached() {
  if (authCache.authorized === null) return true;
  if (authCache.authorized !== true) return false;
  // A stale "authorized" is still fine: the hard gate re-checks.
  return true;
}

/**
 * Open the Web confirmation page (apps/web link.html) in a tab this worker
 * owns and remember it: the link flow reads that tab's final URL for the
 * one-time code. chrome.tabs URL visibility needs the "tabs" permission —
 * host_permissions stay untouched (ticket #26 stays open).
 */
async function handleOpenAuthPage() {
  const settings = await getSettings();
  const pageUrl = YTD_AUTH_GATE.buildLinkPageUrl(settings.webAppBaseUrl);
  if (!pageUrl) {
    return { success: false, error: "授权页地址无效，请在设置中检查 Web 应用地址。" };
  }
  recordAuthBreadcrumb("ytd_last_auth_link_opened", { url: pageUrl });
  const tab = await chrome.tabs.create({ url: pageUrl });
  if (typeof tab?.id === "number") {
    pendingLinkTabs.add(tab.id);
  }
  return { success: true, tabId: tab?.id ?? null };
}

/**
 * Deliver one message to the panel with brief retries: the panel may still
 * be loading when the link flow finishes. The first attempt goes out
 * immediately; the waits sit BETWEEN attempts, so a no-op setTimeout (test
 * sandbox) cannot park this promise forever.
 */
async function notifyPanel(payload) {
  for (const delayMs of [0, 900, 2400]) {
    try {
      await chrome.runtime.sendMessage(payload);
      return true;
    } catch (_error) {
      // Panel not ready (or closed); wait, then retry.
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/**
 * The extension read `?link=<code>` from its own tab: exchange the code for
 * a live extension credential and store it. The issued credential joins the
 * confirming Web session's credential group server-side (P7 linked logout).
 */
async function handleLinkCodeCaptured(tabId, code) {
  pendingLinkTabs.delete(tabId);
  chrome.tabs.remove(tabId).catch(() => {});
  const settings = await getSettings();
  const result = await YTD_AUTH_GATE.exchangeLinkCode({
    fetchImpl: fetch,
    apiBaseUrl: settings.apiBaseUrl,
    code,
  });
  if (!result.ok || !result.credential) {
    recordAuthBreadcrumb("ytd_last_auth_link", {
      outcome: "exchangeFailed",
      detail: result.message || "unknown",
    });
    console.error("[Learning Digest] link exchange failed:", result.message);
    await notifyPanel({
      action: "authState",
      authorized: false,
      reason: "linkFailed",
      message: result.message,
    });
    return { success: false, error: result.message };
  }
  await chrome.storage.local.set({
    [YTD_AUTH_GATE.CREDENTIAL_STORAGE_KEY]: result.credential,
  });
  authCache = { authorized: true, checkedAtMs: Date.now() };
  recordAuthBreadcrumb("ytd_last_auth_link", {
    outcome: "linked",
    email: result.credential.email,
  });
  console.log(
    `[Learning Digest] 插件已关联学习库账号: ${result.credential.email || "(unknown email)"}`,
  );
  await notifyPanel({ action: "authAuthorized", email: result.credential.email });
  return { success: true };
}

// The link completion watcher: only tabs this worker opened for linking are
// inspected, and only the success address's ?link= parameter is extracted.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!pendingLinkTabs.has(tabId)) return;
  const url = changeInfo.url || tab?.url;
  if (!url) return;
  const code = YTD_AUTH_GATE.extractLinkCode(url);
  if (!code) return; // confirmation page still loading, or an unrelated nav
  void handleLinkCodeCaptured(tabId, code).catch((error) =>
    console.error("[Learning Digest] link handling failed:", error?.message || error),
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingLinkTabs.delete(tabId);
});

// ============================================================
// COLLECT CURRENT PAGE (P8, issue #58)
// ============================================================
//
// The side panel's 收藏当前页 entry turns the learner's active tab into a
// favorite: POST /v1/resources with the tab URL, the page title and the
// platform video identity extracted client-side by the shared
// contracts/platform-video-id.js module. The read-only sibling POST
// /v1/sources/resolve answers "is this source already in the library"
// without writing (contract §3.4).

/**
 * The page bridge's real document titles per tab, collected session-less:
 * the bridge reports document.title on every xiaoe page it is injected
 * into, whether or not a Session is running. The collect path prefers
 * this over chrome.tabs' tab title; entries die with their tab.
 */
const bridgePageTitles = new Map();

function recordBridgePageTitle(sender, message) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const title = message && typeof message.title === "string" ? message.title.trim() : "";
  if (typeof tabId !== "number" || title === "") return;
  bridgePageTitles.set(tabId, title);
}

/** The collect target: url + best title + identity for the active tab. */
function collectTargetFromTab(tab) {
  if (!tab || typeof tab.url !== "string" || tab.url === "") return null;
  const bridgeTitle = bridgePageTitles.get(tab.id);
  const title =
    typeof bridgeTitle === "string" && bridgeTitle !== ""
      ? bridgeTitle
      : typeof tab.title === "string"
        ? tab.title.trim()
        : "";
  return {
    tabId: typeof tab.id === "number" ? tab.id : null,
    url: tab.url,
    title,
    identity: YTD_PLATFORM_VIDEO_ID.extractVideoIdentity(tab.url),
  };
}

/**
 * POST /v1/resources for one tab target (contract §3.1) — the shared core
 * of the P8 收藏当前页 entry (the active tab) and P10's 一键收藏 for a
 * chosen course tab. Authoritative gate first (a collect click is a
 * deliberate action, same shape as handleStartLearning); a 401 from the API
 * routes the panel back through the P6 authorization guide. Every outcome
 * lands in the ytd_last_collect breadcrumb.
 */
async function collectTabTarget(target) {
  const auth = await checkAuthNow();
  if (!auth.authorized) {
    void notifyPanel({
      action: "authState",
      authorized: false,
      reason: auth.reason || "unauthorized",
    });
    return {
      ok: false,
      message: "学习库账号未关联或授权已失效：请先在侧边栏完成账号关联，再收藏当前页。",
    };
  }
  if (!target || !YTD_COLLECT.isCollectableUrl(target.url)) {
    return { ok: false, message: "当前标签页没有可收藏的网页地址。" };
  }
  const request = YTD_COLLECT.buildCollectRequest(target);
  if (!request) {
    return { ok: false, message: "当前标签页没有可收藏的网页地址。" };
  }
  const settings = await getSettings();
  const credential = await readStoredAuthCredential();
  const apiUrl = YTD_AUTH_GATE.buildApiUrl(settings.apiBaseUrl, YTD_COLLECT.RESOURCES_PATH);
  if (!apiUrl || !credential) {
    recordAuthBreadcrumb("ytd_last_collect", { outcome: "failed", url: target.url, detail: "unconfigured" });
    return {
      ok: false,
      message: "学习服务地址未配置或账号未关联，请在设置中检查后重试。",
    };
  }
  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch (_error) {
    recordAuthBreadcrumb("ytd_last_collect", { outcome: "unreachable", url: target.url });
    return { ok: false, message: "无法连接学习服务，请稍后重试。" };
  }
  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }
  const result = YTD_COLLECT.parseCollectResponse({ status: response.status, data });
  if (result.ok) {
    recordAuthBreadcrumb("ytd_last_collect", {
      outcome: result.outcome,
      url: target.url,
      resourceId: result.resource.id,
      sourceId: result.source.id,
    });
    return {
      ok: true,
      outcome: result.outcome,
      resource: result.resource,
      source: result.source,
    };
  }
  recordAuthBreadcrumb("ytd_last_collect", {
    outcome: "failed",
    url: target.url,
    status: response.status,
    detail: result.message,
  });
  if (response.status === 401) {
    void notifyPanel({
      action: "authState",
      authorized: false,
      reason: "unauthorized",
    });
  }
  return { ok: false, message: result.message };
}

/**
 * POST /v1/resources for the learner's active tab (contract §3.1) — the
 * panel's 收藏当前页 entry.
 */
async function handleCollectCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return collectTabTarget(collectTargetFromTab(tab));
}

/**
 * Read-only resolve probe for the active tab (contract §3.4). Only pages
 * with a confirmable identity (extractVideoIdentity non-null, the four
 * round-1 stations) reach the API; everything else is a local miss so an
 * ordinary panel open never calls the service. A 401 routes the panel
 * back through the authorization guide, like collect.
 */
async function handleResolveCurrentSource() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const target = collectTargetFromTab(tab);
  const identityPresent = !!(
    target &&
    YTD_COLLECT.isCollectableUrl(target.url) &&
    target.identity
  );
  const miss = { ok: true, matched: false, identityPresent, resource: null, source: null };
  if (!identityPresent) return miss;
  const settings = await getSettings();
  const credential = await readStoredAuthCredential();
  if (!credential) return miss;
  const apiUrl = YTD_AUTH_GATE.buildApiUrl(settings.apiBaseUrl, YTD_COLLECT.RESOLVE_PATH);
  if (!apiUrl) return miss;
  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(YTD_COLLECT.buildCollectRequest(target)),
    });
  } catch (_error) {
    return { ...miss, ok: false, message: "无法连接学习服务，请稍后重试。" };
  }
  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }
  const result = YTD_COLLECT.parseResolveResponse({ status: response.status, data });
  if (!result.ok) {
    recordAuthBreadcrumb("ytd_last_collect_resolve", {
      matched: false,
      url: target.url,
      status: response.status,
      detail: result.message,
    });
    if (response.status === 401) {
      void notifyPanel({
        action: "authState",
        authorized: false,
        reason: "unauthorized",
      });
    }
    return { ok: false, matched: false, identityPresent, message: result.message };
  }
  recordAuthBreadcrumb("ytd_last_collect_resolve", {
    matched: result.matched,
    url: target.url,
    resourceId: result.resource ? result.resource.id : null,
  });
  return {
    ok: true,
    matched: result.matched,
    identityPresent,
    resource: result.resource,
    source: result.source,
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  bridgePageTitles.delete(tabId);
});

// ============================================================
// LEARNING START (P10, issue #59) — 决策 4 的开始侧
// ============================================================
//
// The panel's course tab list and 开始学习 flow, on top of the PoC capture
// machinery: list the open http(s) tabs (video pages first), choose a
// target, resolve it against the library (contract §3.4), and only the
// explicit 开始学习 click opens the local Session and starts recording
// progress to PUT /v1/sources/{id}/progress (contract §3.5). While a
// Session records, the target is LOCKED (decision 4 of #49): browser focus
// and tab switches cannot change it, and the list unlocks only when the
// Session ends. All contract logic lives in learning-start.js (pure, Node-
// tested); this section is the thin browser wiring around it.

const LEARNING_TARGET_KEY = "ytd_learning_target";
// In-memory target state + the active Session's progress writer. Both
// rebuild from storage after a service-worker restart (see
// rebuildProgressTracking), so a restart never drops the recording target
// or the optimistic-concurrency revision.
let learningTargetState = YTD_LEARNING_START.createTargetState();
let learningTargetLoaded = false;
let learningProgressWriter = null;
let learningProgressTicker = null;

async function loadLearningTargetState() {
  if (learningTargetLoaded) return;
  learningTargetLoaded = true;
  const stored = await chrome.storage.local.get(LEARNING_TARGET_KEY);
  learningTargetState =
    YTD_LEARNING_START.parseTarget(stored[LEARNING_TARGET_KEY]) ||
    YTD_LEARNING_START.createTargetState();
}

async function saveLearningTargetState() {
  const snapshot = YTD_LEARNING_START.serializeTarget(learningTargetState);
  if (snapshot) {
    await chrome.storage.local.set({ [LEARNING_TARGET_KEY]: snapshot });
  } else {
    await chrome.storage.local.remove(LEARNING_TARGET_KEY);
  }
}

/** Video pages sort first in the list: identity pages + registered platforms. */
function learningVideoPageChecker() {
  return (url) =>
    !!YTD_PLATFORM_VIDEO_ID.extractVideoIdentity(url) ||
    YTD_SOURCE_PLATFORMS.recognizePage(url).kind !== "none";
}

/**
 * Full-fidelity §3.4 resolve for one tab target: the identity when the URL
 * carries one, the plain (normalized) URL otherwise — the contract accepts
 * both, unlike the passive panel-open probe which stays identity-only so
 * ordinary browsing never calls the service.
 */
async function resolveSourceForTarget(target) {
  if (!target || !YTD_COLLECT.isCollectableUrl(target.url)) {
    return { ok: false, matched: false, identityPresent: false, resource: null, source: null };
  }
  const request = YTD_COLLECT.buildCollectRequest(target);
  if (!request) {
    return { ok: false, matched: false, identityPresent: false, resource: null, source: null };
  }
  const settings = await getSettings();
  const credential = await readStoredAuthCredential();
  const apiUrl = YTD_AUTH_GATE.buildApiUrl(settings.apiBaseUrl, YTD_COLLECT.RESOLVE_PATH);
  if (!apiUrl || !credential) {
    return { ok: false, matched: false, identityPresent: !!target.identity, resource: null, source: null };
  }
  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch (_error) {
    return {
      ok: false,
      matched: false,
      identityPresent: !!target.identity,
      resource: null,
      source: null,
      message: "无法连接学习服务，请稍后重试。",
    };
  }
  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }
  const result = YTD_COLLECT.parseResolveResponse({ status: response.status, data });
  if (!result.ok) {
    if (response.status === 401) {
      void notifyPanel({
        action: "authState",
        authorized: false,
        reason: "unauthorized",
      });
    }
    return {
      ok: false,
      matched: false,
      identityPresent: !!target.identity,
      resource: null,
      source: null,
      message: result.message,
    };
  }
  return {
    ok: true,
    matched: result.matched,
    identityPresent: !!target.identity,
    resource: result.resource,
    source: result.source,
  };
}

async function handleGetCourseTabs() {
  await loadLearningTargetState();
  const tabs = await chrome.tabs.query({});
  // The page bridge's real document titles win over chrome.tabs' own, the
  // same preference the collect path applies.
  const withTitles = (Array.isArray(tabs) ? tabs : []).map((tab) => ({
    id: tab?.id,
    url: tab?.url,
    title:
      typeof bridgePageTitles.get(tab?.id) === "string" && bridgePageTitles.get(tab?.id) !== ""
        ? bridgePageTitles.get(tab?.id)
        : tab?.title,
  }));
  const info = YTD_LEARNING_START.targetInfo(learningTargetState);
  const list = YTD_LEARNING_START.buildCourseTabList({
    tabs: withTitles,
    lockedTabId: info ? info.target.tabId : null,
    isVideoPage: learningVideoPageChecker(),
  });
  const chosen =
    learningTargetState.status === "chosen" ? learningTargetState.target : null;
  return {
    ok: true,
    tabs: list,
    locked: YTD_LEARNING_START.isLocked(learningTargetState),
    target: info ? { ...info.target, sourceId: info.sourceId, sessionId: info.sessionId } : null,
    chosenTabId: chosen ? chosen.tabId : null,
  };
}

/**
 * The panel picked one course tab: store the choice, then resolve it so the
 * panel can show 在你的学习库 + the resume position, or the 先收藏 prompt.
 * Refused outright while a Session records — the locked target cannot be
 * switched (decision 4).
 */
async function handleChooseLearningTarget({ tabId } = {}) {
  await loadLearningTargetState();
  if (YTD_LEARNING_START.isLocked(learningTargetState)) {
    return {
      ok: false,
      reason: "locked",
      target: YTD_LEARNING_START.targetInfo(learningTargetState),
    };
  }
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    return { ok: false, reason: "tabNotFound" };
  }
  const target = collectTargetFromTab(tab);
  const chosen = YTD_LEARNING_START.chooseTarget(
    learningTargetState,
    target ? { tabId: target.tabId, url: target.url, title: target.title } : null,
  );
  if (!chosen.ok) return { ok: false, reason: chosen.reason };
  learningTargetState = chosen.state;
  await saveLearningTargetState();
  const resolution = await resolveSourceForTarget(target);
  return {
    ok: true,
    target: learningTargetState.target,
    // Capture starts on registered Source Platform pages only; other
    // stations (and plain pages) stay listable/resolvable/favoritable.
    startable: YTD_SOURCE_PLATFORMS.recognizePage(target.url).kind !== "none",
    resolve: resolution,
  };
}

/**
 * The panel's 一键收藏 for the chosen course tab (the P8 collect POST, but
 * for an explicit tab instead of the active one).
 */
async function handleCollectLearningTarget({ tabId } = {}) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    return { ok: false, message: "目标标签页已关闭。" };
  }
  return collectTabTarget(collectTargetFromTab(tab));
}

/**
 * The 开始学习 click for the chosen course tab: resolve first (fresh
 * expectedRevision at start time), refuse to capture an unresolved page
 * (progress needs a Source — the panel offers 一键收藏 first), then hand
 * over to the PoC capture flow, whose success path locks the target and
 * arms the progress writer.
 */
async function handleStartLearningForTarget({ tabId } = {}) {
  await loadLearningTargetState();
  if (YTD_LEARNING_START.isLocked(learningTargetState)) {
    return { success: false, error: "已有进行中的学习会话，请先结束本次学习。" };
  }
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    return { success: false, error: "目标标签页已关闭。" };
  }
  const target = collectTargetFromTab(tab);
  if (!target || !YTD_COLLECT.isCollectableUrl(target.url)) {
    return { success: false, error: "目标标签页没有可学习的网页地址。" };
  }
  const resolution = await resolveSourceForTarget(target);
  if (!resolution.ok) {
    return {
      success: false,
      error: resolution.message || "来源解析失败，请稍后重试。",
    };
  }
  if (!resolution.matched) {
    return {
      success: false,
      needsFavorite: true,
      error: "该页面还没有收藏到学习库：先收藏才能记录学习进度。",
    };
  }
  const started = await handleStartLearning({ url: target.url, tabId: target.tabId });
  if (!started.success) return started;
  return { ...started, resource: resolution.resource, source: resolution.source };
}

/**
 * Locks the target for a running Session and arms the progress writer.
 * Runs on EVERY successful start (panel flow and toolbar-icon flow alike):
 * the resolve is re-issued here so expectedRevision is fresh at write time.
 * An unmatched page still locks (capture is running; the list shows the
 * target) — progress simply has nowhere to write and says so in the
 * breadcrumb.
 */
async function beginProgressTracking(context) {
  const settings = await getSettings();
  const credential = await readStoredAuthCredential();
  const target = {
    tabId: context.tabId,
    url: typeof context.sourceUrl === "string" ? context.sourceUrl : "",
    title: typeof context.pageTitle === "string" ? context.pageTitle : "",
  };
  let sourceId = null;
  let expectedRevision = 0;
  if (credential && YTD_COLLECT.isCollectableUrl(target.url)) {
    const resolution = await resolveSourceForTarget(
      collectTargetFromTab({ id: target.tabId, url: target.url, title: target.title }),
    );
    if (resolution.ok && resolution.matched && resolution.source) {
      sourceId = resolution.source.id;
      expectedRevision = Number.isInteger(resolution.source.progress?.revision)
        ? resolution.source.progress.revision
        : 0;
    } else {
      recordAuthBreadcrumb("ytd_last_learning_progress", {
        outcome: "noSource",
        url: target.url,
        matched: resolution.matched,
      });
    }
  }
  const lock = YTD_LEARNING_START.lockTarget(learningTargetState, {
    ...target,
    sessionId: context.sessionId,
    sourceId,
    expectedRevision,
  });
  if (!lock.ok) {
    // "locked" means a Session is already recording — the double-start guard
    // in handleStartLearning makes this unreachable in practice.
    return;
  }
  learningTargetState = lock.state;
  await saveLearningTargetState();
  if (sourceId && credential) {
    startProgressWriter(context, { settings, credential, sourceId, expectedRevision });
  }
  void notifyPanel({
    action: "learningTargetChanged",
    target: YTD_LEARNING_START.targetInfo(learningTargetState),
  });
}

function startProgressWriter(context, { settings, credential, sourceId, expectedRevision }) {
  if (!YTD_LEARNING_START.buildProgressApiUrl(settings.apiBaseUrl, sourceId)) return;
  learningProgressWriter = YTD_LEARNING_START.createProgressWriter({
    fetchImpl: fetch,
    apiBaseUrl: settings.apiBaseUrl,
    token: credential.token,
    sourceId,
    expectedRevision,
    onUnauthorized: () => void handleProgressAuthLoss(),
  });
  // Live (wallclock) sources record elapsed session time as positionMs
  // (contract §2.3); recorded sources ride the bridge's position stream.
  // The ticker stands down the moment the Session anchors to video time.
  if (context.timestampKind === "wallclock") {
    learningProgressTicker = setInterval(() => {
      if (!learningProgressWriter || context.ended) {
        stopProgressTicker();
        return;
      }
      if (context.timestampKind !== "wallclock") return;
      learningProgressWriter.reportPosition(
        Math.max(0, Date.now() - context.startedAtMs),
      );
    }, 5_000);
  }
}

function stopProgressTicker() {
  if (learningProgressTicker !== null) {
    clearInterval(learningProgressTicker);
    learningProgressTicker = null;
  }
}

/**
 * The bridge's position stream (bound to the SAME capture tabId the Session
 * records) feeds the writer with media-position milliseconds. Focus and tab
 * switches never reroute this: the stream is sender-checked by
 * handleMediaPosition, and the writer only knows its source.
 */
function feedLearningPosition(context, positionSeconds) {
  if (!learningProgressWriter || !context || context.ended) return;
  if (context.timestampKind !== "video") return;
  const positionMs = Math.round(Number(positionSeconds) * 1000);
  if (!Number.isFinite(positionMs) || positionMs < 0) return;
  learningProgressWriter.reportPosition(positionMs);
}

/**
 * Session end (explicit 结束学习 or media-end): one final flush of the
 * latest position — bounded by design (throttle-bypassing cycles never wait
 * on the network) — then the writer stops and the list unlocks (决策 4:
 * 结束本次学习后列表恢复可选).
 */
async function releaseLearningTarget(context) {
  stopProgressTicker();
  if (learningProgressWriter) {
    try {
      await learningProgressWriter.flush();
    } catch (_error) {
      // The final write already deferred internally; nothing to recover.
    }
    learningProgressWriter.stop();
    learningProgressWriter = null;
  }
  await loadLearningTargetState();
  const info = YTD_LEARNING_START.targetInfo(learningTargetState);
  if (info && (!context || info.sessionId === context.sessionId)) {
    learningTargetState = YTD_LEARNING_START.endTarget(learningTargetState);
    await saveLearningTargetState();
    void notifyPanel({ action: "learningTargetChanged", target: null });
  }
}

/**
 * 401 from a progress write: the credential died mid-recording. Stop the
 * writer, route the panel back through the authorization gate and end the
 * Session (capture included) — the P7 linked-logout path takes over the
 * stop-capture semantics from here.
 */
async function handleProgressAuthLoss() {
  stopProgressTicker();
  if (learningProgressWriter) {
    learningProgressWriter.stop();
    learningProgressWriter = null;
  }
  await notifyPanel({
    action: "authState",
    authorized: false,
    reason: "unauthorized",
  });
  const context = await ensureCaptureResumed();
  if (context && !context.ended) {
    await endActiveSession(context, { reason: "authInvalidated", report: false });
  }
}

/**
 * Service-worker restart with a recording Session: rebuild the progress
 * writer from the persisted target so the optimistic-concurrency revision
 * survives (no manufactured 409s), and release locks whose Session died.
 */
async function rebuildProgressTracking(context) {
  await loadLearningTargetState();
  const info = YTD_LEARNING_START.targetInfo(learningTargetState);
  if (!info) return;
  if (info.sessionId !== context.sessionId) {
    learningTargetState = YTD_LEARNING_START.endTarget(learningTargetState);
    await saveLearningTargetState();
    return;
  }
  if (!info.sourceId) return;
  const settings = await getSettings();
  const credential = await readStoredAuthCredential();
  if (!credential) return;
  startProgressWriter(context, {
    settings,
    credential,
    sourceId: info.sourceId,
    expectedRevision: info.expectedRevision,
  });
}

// Warm the click-path cache on every worker start; the breadcrumb trail
// records the verdict (storage breadcrumbs are the main debug channel).
void checkAuthNow();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  // One substitution convention for all prompt files, shared with the pure
  // prompt builders in session-summary.js.
  return YTD_SESSION_SUMMARY.fillPromptTemplate(prompt, variables);
}

/**
 * Loads the section bundle of one session prompt template (Topic tick or
 * global pass, #33). These templates carry no load-time variables: the pure
 * builders in session-summary.js fill their placeholders from Session state.
 * A missing or unreadable file is a permanent misconfiguration that would
 * fail every tick or end-of-session pass, so it is logged loudly here (a
 * failed tick would otherwise only hit the quiet retry log) and rethrown
 * with a clear Chinese message for the panel payloads.
 *
 * @param {string} fileName - prompts/ file, e.g. "topic-tick.md"
 * @param {Record<string, string>} headings - template key -> "## " heading
 * @returns {Promise<Record<string, string>>} the loaded sections
 */
async function loadPromptTemplate(fileName, headings) {
  try {
    const template = {};
    for (const [key, heading] of Object.entries(headings)) {
      template[key] = await loadPromptSection(fileName, heading);
    }
    return template;
  } catch (error) {
    console.error(
      `[Learning Digest] 提示词文件加载失败（prompts/${fileName}）：`,
      error?.message || error,
    );
    throw new Error(`提示词文件缺失或不可读：prompts/${fileName}`);
  }
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "AI provider API key not configured. Open Learning Digest Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning
  // traces. `thinking` is a DeepSeek-specific body field — only send it to
  // DeepSeek endpoints so other OpenAI-compatible providers (e.g. Bailian
  // Qwen) never receive an unknown parameter.
  if (/deepseek\.com/i.test(settings.aiBaseUrl)) {
    body.thinking = { type: "disabled" };
  }

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(settings.aiBaseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves the provider is still making progress. It may
    // then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `AI provider error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("The AI provider returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    // OpenAI-compatible finish reason ("stop", "length", ...). Callers that
    // need to distinguish a truncated completion (the report pass) read it
    // from here; existing callers ignore the extra field.
    return { text, finishReason: choice?.finish_reason ?? null, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "The AI request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "The AI request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including the provider's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("The AI provider response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("The AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * Icon click is the single capture entry point. Chrome only allows
 * tabCapture after the user has INVOKED the extension on the target tab,
 * and a click inside the side panel does not count — so the toolbar icon
 * click must carry both the invocation and the gesture that authorizes
 * capture. From Chrome 116 the action click can also open the side panel
 * programmatically, so one click does both: open the panel, and when the
 * active tab is a recognized learning page, start the Session immediately.
 */
// The icon click MUST reach chrome.action.onClicked: it is the single
// capture entry, opening the panel AND starting the Session. Chrome
// persists the open-panel-on-action-click behavior per extension, and the
// seed-era code (≤0.1.11) set it true — with the pref stuck, clicks open
// the panel natively instead of firing onClicked, so no Session ever
// starts. Reset it on every worker start; the handler opens the panel
// itself via chrome.sidePanel.open().
try {
  const behaviorSet = chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: false,
  });
  // Chrome returns a promise; test stubs may return undefined.
  if (behaviorSet && typeof behaviorSet.catch === "function") {
    behaviorSet.catch((error) =>
      console.error(
        "[Learning Digest] setPanelBehavior failed:",
        error?.message || error,
      ),
    );
  }
} catch (error) {
  console.error(
    "[Learning Digest] setPanelBehavior failed:",
    error?.message || error,
  );
}

chrome.action.onClicked.addListener((tab) => {
  // Log BEFORE any await: if this line never appears, the click never
  // reached the extension and the problem is outside this code path.
  console.log("[Learning Digest] icon clicked:", tab?.url || "(no url)");
  // Storage breadcrumb for the same purpose: console attachment has proven
  // unreliable in the field, so the click itself is recorded in storage.
  chrome.storage.local
    .set({ ytd_last_icon_click: { at: Date.now(), url: tab?.url ?? null } })
    .catch(() => {});
  void handleActionClicked(tab);
});

async function openPanelQuietly(tab) {
  try {
    await chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
  } catch (_error) {
    // The panel may already be open for this tab; opening is best-effort.
  }
}

/**
 * True when the active Session already belongs to the page the icon was
 * clicked on. Prefers the URL persisted with the 0.1.57+ pointer (exact
 * course identity); pre-0.1.57 pointers carry no sourceUrl, so the tab id is
 * the only available signal — same tab means same course there.
 */
function isSameCourse(context, url, tabId) {
  if (context.sourceUrl) return context.sourceUrl === url;
  return context.tabId === tabId;
}

async function handleActionClicked(tab) {
  // Without the "tabs" permission tab.url is only populated when the
  // extension has host access to the page; on unrecognized hosts it is
  // simply absent and we only open the panel.
  if (!tab?.url) {
    console.error("[Learning Digest] icon click ignored: tab.url is empty", tab);
    await recordStartAttempt("tab.url is empty");
    await openPanelQuietly(tab);
    return;
  }
  const recognition = YTD_SOURCE_PLATFORMS.recognizePage(tab.url);
  if (recognition.kind === "none") {
    console.error("[Learning Digest] icon click ignored: page not recognized:", tab.url);
    await recordStartAttempt(`page not recognized: ${tab.url}`);
    await openPanelQuietly(tab);
    return;
  }

  // Both privileged calls are issued in the click's task, before ANY await:
  // the panel open needs the live gesture (sidePanel.open validates the
  // gesture when CALLED), and the streamId fetch needs the fresh invocation
  // (0.1.22). The 0.1.22 ordering awaited the fetch first, which let the
  // gesture unwind — the panel then silently failed to open whenever the
  // fetch threw (e.g. an already-active capture on this tab).
  const panelOpening = openPanelQuietly(tab);

  // P6 gate fast path: a cached "unauthorized" verdict means capture cannot
  // start — skip the streamId fetch (it exists only for capture) and leave
  // the learner at the panel, which shows the authorization guide. Unknown
  // verdicts fall through; handleStartLearning runs the authoritative check.
  if (!isAuthorizedCached()) {
    console.log("[Learning Digest] icon click: not authorized, opening the panel only");
    await recordStartAttempt("not authorized: capture blocked (P6 gate)");
    await panelOpening;
    return;
  }

  let streamId = null;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    const message = error?.message || String(error);
    // Re-clicking while this tab is already being captured is an EXPECTED
    // state (the flow continues into "a Session is already active"), not a
    // failure — keep it off the extension error page. Everything else stays
    // loud: handleStartLearning retries and maps real failures to the
    // actionable instruction the panel shows.
    if (/active stream/i.test(message)) {
      console.log(
        "[Learning Digest] early streamId fetch skipped — this tab is already being captured by the active Session.",
      );
    } else {
      console.error(
        "[Learning Digest] early streamId fetch failed:",
        message,
      );
    }
  }
  await panelOpening;

  const existing = await ensureCaptureResumed();
  if (existing) {
    if (isSameCourse(existing, tab.url, tab.id)) {
      console.log("[Learning Digest] icon click: a Session is already active");
      await recordStartAttempt(
        `a Session is already active (${existing.sessionId})`,
      );
      return; // Session already running on this course; the panel shows its state.
    }
    // 0.1.57 course switch: the still-active Session belongs to another
    // lesson (its tab/URL no longer matches). End it WITHOUT the AI report
    // pass and fall through to start a fresh Session for this course below —
    // before this, the stale Session shadowed every new course (its
    // transcript reappeared and the new lesson was never captured).
    console.log(
      "[Learning Digest] icon click on a new course while a Session is active: ending",
      existing.sessionId,
      "and starting fresh for",
      tab.url,
    );
    await recordStartAttempt(
      `course switch: ended ${existing.sessionId} (was active)`,
    );
    await endActiveSession(existing, { reason: "course-switch", report: false });
  }

  const result = await handleStartLearning({ url: tab.url, tabId: tab.id, streamId });
  if (result && !result.success) {
    // The panel just opened but may still be loading; retry briefly so the
    // failure reason is visible instead of a silently empty session view.
    const payload = { action: "sessionUpdate", startError: result.error };
    for (const delayMs of [0, 600, 1800]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await chrome.runtime.sendMessage(payload);
        return;
      } catch (_error) {
        // Panel not ready yet; next retry.
      }
    }
    console.error(
      "[Learning Digest] startLearning failed and the panel never received it:",
      result.error,
    );
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "explainSelection") {
    // Explain selected text using the AI Provider.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save exact selected transcript text as a timestamped note.
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.selectedText,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  // --- Authorization gate (P6) ---

  if (message.action === "checkAuth") {
    checkAuthNow()
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ authorized: false, reason: "unreachable", error: error.message }),
      );
    return true;
  }

  if (message.action === "openAuthPage") {
    handleOpenAuthPage()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // --- Collect current page (P8, #58) ---

  if (message.action === "collectCurrentPage") {
    handleCollectCurrentPage()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: err.message }));
    return true;
  }

  if (message.action === "resolveCurrentSource") {
    handleResolveCurrentSource()
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, matched: false, message: err.message }),
      );
    return true;
  }

  // --- Learning start (P10, #59): course tab list + 开始学习 ---

  if (message.action === "getCourseTabs") {
    handleGetCourseTabs()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: err.message }));
    return true;
  }

  if (message.action === "chooseLearningTarget") {
    handleChooseLearningTarget(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: err.message }));
    return true;
  }

  if (message.action === "collectLearningTarget") {
    handleCollectLearningTarget(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: err.message }));
    return true;
  }

  if (message.action === "startLearningForTarget") {
    handleStartLearningForTarget(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // --- Session capture (xiaoe-tech Source Platform, #16) ---

  if (message.action === "startLearning") {
    handleStartLearning(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "endLearning") {
    handleEndLearning()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "regenerateReport") {
    // Retry path for a truncated or failed end-of-session global pass (#29).
    handleRegenerateReport(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getSessionState") {
    handleGetSessionState()
      .then(sendResponse)
      .catch((err) => sendResponse({ active: false, error: err.message }));
    return true;
  }

  if (message.action === "clearSessionRecord") {
    handleClearSessionRecord(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "restartFromBeginning") {
    // From the panel's 从头开始 button (0.1.63): forward to the capture tab's
    // page bridge, which rewinds the lesson video to 0:00 and plays.
    handleRestartFromBeginning()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "mediaPosition") {
    // From the xiaoe page bridge: drives replay/course Segments and the
    // media-end auto-stop. No response needed.
    handleMediaPosition(message, sender).catch((error) =>
      debugLog("[Learning Digest BG] mediaPosition error:", error),
    );
    return false;
  }

  if (message.action === "pageTitle") {
    // From the xiaoe page bridge (#32): the lesson title for the report
    // header. Sent once at page load and again on pagehide, live pages
    // included. No response needed.
    handlePageTitle(message, sender).catch((error) =>
      debugLog("[Learning Digest BG] pageTitle error:", error),
    );
    return false;
  }

  if (message.action === "captureChunk") {
    // Backstop self-cut from the offscreen recorder (worker was asleep).
    handleBackstopChunk(message).catch((error) =>
      // Loud on purpose: a dropped live chunk is otherwise invisible.
      console.error("[Learning Digest] captureChunk handling failed:", error?.message || error),
    );
    return false;
  }

  if (message.action === "captureEnded") {
    // Unsolicited one-shot notice from the offscreen recorder: the capture
    // stream went inactive mid-Session (course tab closed or navigated
    // away). Fire-and-forget, like captureChunk.
    handleCaptureEnded(message, sender).catch((error) =>
      console.error(
        "[Learning Digest] captureEnded handling failed:",
        error?.message || error,
      ),
    );
    return false;
  }

  // --- Realtime transcription events (qwen3-asr-flash-realtime, #46) ---
  //
  // The offscreen WebSocket client streams server findings unsolicited.
  // One shared dispatch: the handlers differ, the plumbing (loud catch,
  // no response held open) is identical for every realtime action.

  const realtimeHandler = REALTIME_EVENT_HANDLERS[message.action];
  if (realtimeHandler) {
    realtimeHandler(message).catch((error) =>
      console.error(
        `[Learning Digest] ${message.action} handling failed:`,
        error?.message || error,
      ),
    );
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[Learning Digest BG] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using the AI Provider.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Session title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI provider API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[Learning Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note for the current Session. The side panel supplies the exact
 * selected transcript text, which is stored directly without an AI cleanup
 * request.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  selectedText,
) {
  try {
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));
    const exactSelectedText =
      typeof selectedText === "string"
        ? selectedText.replace(/\s+/g, " ").trim().slice(0, 3000)
        : "";

    // A selected transcript note is already the exact text the user wants.
    // Save it directly without asking the AI to rewrite the text.
    if (!exactSelectedText) {
      return {
        success: false,
        error: "NO_SELECTED_TEXT",
        message: "Select transcript text in the side panel to save a note.",
      };
    }

    const note = {
      id: `note_${Date.now()}`,
      videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Session",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: YTD_SPEECH_TRANSCRIPTION.formatTimestamp(safeTimestamp),
      timestampSeconds: safeTimestamp,
      text: exactSelectedText,
      rawText: exactSelectedText,
      createdAt: Date.now(),
    };

    await saveNoteToStorage(note);
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
    return { success: true, note };
  } catch (error) {
    console.error("[Learning Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by session ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}


// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  handleSaveNote,
  generateSessionReport,
  produceSessionReport,
  handleRegenerateReport,
  // Session capture orchestration (provider-aware start gate, resume
  // settlement of interrupted Segments) — see tests/background-capture.test.js.
  handleStartLearning,
  handleEndLearning,
  handleGetSessionState,
  handleClearSessionRecord,
  handleRestartFromBeginning,
  handleActionClicked,
  handlePageTitle,
  // Authorization gate (P6): the probe, the authorization-page opener and
  // the link code exchange — see tests/plugin-auth-flow.test.js.
  checkAuthNow,
  handleOpenAuthPage,
  handleLinkCodeCaptured,
  // Collect current page (P8, #58): the favorite POST and the read-only
  // resolve probe for the learner's active tab — see
  // tests/plugin-collect-flow.test.js.
  handleCollectCurrentPage,
  handleResolveCurrentSource,
  // Learning start (P10, #59): the course tab list, the locked learning
  // target and the real-time progress writes — see
  // tests/plugin-learning-start-flow.test.js.
  handleGetCourseTabs,
  handleChooseLearningTarget,
  handleCollectLearningTarget,
  handleStartLearningForTarget,
  handleProgressAuthLoss,
  // Timeline anchoring + seek-awareness (#48): the bridge's position stream
  // drives the probe window, the anchor transition, seek cuts and the
  // Plan A re-listen retries — see tests/background-capture.test.js.
  handleMediaPosition,
  // Capture death (#captureEnded): the offscreen recorder's one-shot notice
  // that its stream went inactive; see tests/background-capture.test.js.
  handleCaptureEnded,
  // Realtime forwarding (#46): offscreen's unsolicited WebSocket findings;
  // see tests/background-capture.test.js.
  handleRealtimePartial,
  handleRealtimeUtterance,
  handleRealtimeError,
  handleRealtimeGaveUp,
  readLastStartFailure: () => chrome.storage.local.get("ytd_last_start_failure"),
};

// ============================================================
// SESSION CAPTURE ORCHESTRATION (xiaoe-tech Source Platform)
// ============================================================
//
// The thin browser layer in front of the pure pieces:
// session-pipeline.js (state machine), session-segmenter.js (timing math),
// source-platforms.js (URL recognition), speech-providers.js (transcription),
// session-persistence.js (incremental snapshots). Everything timed or
// browser-bound lives here so the core modules stay pure and unit-tested.
//
// Shape: one active capture at a time. The capture context lives in memory
// and is mirrored to storage under ACTIVE_CAPTURE_KEY so a service-worker
// restart (or browser restart) can rebuild mid-Session without
// re-transcribing done Segments.

const ACTIVE_CAPTURE_KEY = "ytd_active_capture";
const LIVE_TICK_MS = 1000;

/**
 * #48 timeline anchoring: a wallclock Session probes for a bridged media
 * position for this long after its start. The first valid position anchors
 * the Session to the video timeline; a lapsed window stays wallclock for
 * the whole Session (the timeline never switches mid-Session).
 */
const PROBE_WINDOW_MS = 10_000;

/**
 * Forward-drag threshold: a position jump larger than this within one bridge
 * report is a drag (cut at the seek point, jump the cursor, mark the gap).
 * The page bridge's seeking/seeked events are the primary detector and fire
 * for any drag size; this constant is only the fallback for a lost event.
 * Backward moves always count as drags. 3s: shorter than any lesson
 * Segment, long enough to swallow ordinary player jitter.
 */
const FORWARD_DRAG_THRESHOLD_SECONDS = 3;

/** @type {object|null} in-memory capture context, rebuilt from storage on wake. */
let captureContext = null;

/**
 * The Session that ended last, kept for the regenerateReport fast path. A
 * service-worker restart loses it; the storage scan in
 * resolveReportTargetSessionId is the durable fallback.
 */
let lastEndedSessionId = null;

function dataUrlToBlob(dataUrl, fallbackMime = "audio/webm") {
  const [header, base64] = String(dataUrl).split(",");
  const mime = /data:([^;]+)/.exec(header)?.[1] || fallbackMime;
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function sendOffscreen(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    // USER_MEDIA for the getUserMedia recorder; AUDIO_PLAYBACK so the
    // offscreen loopback that keeps the captured lesson audible is allowed
    // without a user gesture (autoplay policy exemption for offscreen docs).
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Records the course tab's audio and plays it back so the learner can still hear the lesson while it is being captured.",
  });
}

function broadcastSession(state, extra = {}) {
  try {
    chrome.runtime
      .sendMessage({ action: "sessionUpdate", sessionId: state.sessionId, state, ...extra })
      .catch(() => {});
  } catch (_error) {
    // Side panel closed; the snapshot in storage is the durable record.
  }
}

async function persistContextPointer(context) {
  // Session metadata only — Speech Provider credentials are re-read from
  // settings on rebuild and are never duplicated here. cursorSeconds (#48)
  // carries the segmenter cursor across a restart for the two cases where
  // it runs ahead of the persisted Segments: the mid-video anchor and the
  // seek-forward jump (the skipped range produces no Segment records).
  await chrome.storage.local.set({
    [ACTIVE_CAPTURE_KEY]: {
      sessionId: context.sessionId,
      tabId: context.tabId,
      platformId: context.platformId,
      kind: context.kind,
      timestampKind: context.timestampKind,
      startedAtMs: context.startedAtMs,
      segmentLengthSeconds: context.segmentLengthSeconds,
      transcribeMode: context.transcribeMode,
      pageTitle: context.pageTitle,
      sourceUrl: context.sourceUrl ?? null,
      cursorSeconds: context.segmenter ? context.segmenter.emittedUpTo : 0,
      // Realtime timeline state (#50), so a worker restart rebuilds the
      // hold/resume and covered-range bookkeeping instead of re-recognizing
      // what the windows already cover.
      playbackWindows: context.playbackWindows || [],
      playbackWindowStart: context.playbackWindowStart ?? null,
      realtimeOriginSeconds: context.realtimeOriginSeconds ?? 0,
      realtimeHoldUntilSeconds: context.realtimeHoldUntilSeconds ?? null,
    },
  });
}

async function readContextPointer() {
  const stored = await chrome.storage.local.get(ACTIVE_CAPTURE_KEY);
  return stored[ACTIVE_CAPTURE_KEY] || null;
}

async function clearContextPointer() {
  await chrome.storage.local.remove(ACTIVE_CAPTURE_KEY);
}

/**
 * The Session timeline position (seconds from Session start) that capture
 * has reached: the end of the last persisted Segment. This is where a
 * rebuilt segmenter resumes, so a Segment still pending whose range ends at
 * or before this cursor can never be dispatched again.
 */
function segmentsEndSeconds(state) {
  return state.segments.reduce(
    (end, segment) => Math.max(end, segment.start + segment.duration),
    0,
  );
}

/**
 * The Session timeline position (seconds from Session start) the Transcript
 * records have reached: the end of the last record. For a realtime Session
 * (#49) this is the playback position — video-kind utterances stamp at
 * video positions — and it bounds where seek detection resumes after a
 * worker restart, the same job segmentsEndSeconds does for segment mode.
 */
function lastUtteranceEndSeconds(state) {
  return state.transcriptRecords.reduce(
    (end, record) => Math.max(end, Number(record?.start) + Number(record?.duration) || 0),
    0,
  );
}

/**
 * Transcription mode (#45, widened by #49): realtime streaming engages for
 * the Qwen provider explicitly configured 实时转写, on ANY Session kind —
 * replay/course Sessions stamp their utterances at video positions (see
 * mapUtteranceStart), live Sessions keep stream time. This is distinct from
 * the cut-cadence `mode` ("wallclock"|"video") below.
 *
 * @param {string} providerId - selected Speech Provider id
 * @param {object} providerConfig - that provider's stored credentials
 * @returns {"segment"|"realtime"}
 */
function resolveTranscribeMode(providerId, providerConfig) {
  return providerId === "qwen" && providerConfig?.mode === "realtime"
    ? "realtime"
    : "segment";
}

/**
 * The in-memory capture context, one shape for both creation sites. The
 * factory owns every field's default so handleStartLearning (fresh Session)
 * and ensureCaptureResumed (rebuilt from storage) cannot drift apart.
 *
 * @param {object} parts - the per-site values
 * @param {string} parts.sessionId
 * @param {number} parts.tabId
 * @param {string} parts.platformId
 * @param {string} parts.kind
 * @param {string} parts.timestampKind
 * @param {number} parts.startedAtMs - wall-clock Session start
 * @param {number} parts.segmentLengthSeconds
 * @param {"segment"|"realtime"} [parts.transcribeMode] - resolved at start;
 *   pre-0.1.43 pointers without the field fall back to "segment" (#45)
 * @param {string} [parts.pageTitle] - page title reported by the bridge (#32)
 * @param {string} [parts.sourceUrl] - URL of the page the Session was started
 *   on (0.1.57): the icon-click flow compares it to detect a course switch
 *   and auto-end the stale Session; absent on pre-0.1.57 pointers
 * @param {object} parts.state - Session state from session-pipeline.js
 * @param {object} parts.segmenter - scheduler from session-segmenter.js
 * @param {object[]} [parts.playbackWindows] - closed captured playback ranges
 *   (#50), from the pointer on a rebuild
 * @param {number|null} [parts.playbackWindowStart] - the open range's start
 * @param {number} [parts.realtimeOriginSeconds] - the recognition origin the
 *   utterance offsets count from (#50)
 * @param {number|null} [parts.realtimeHoldUntilSeconds] - non-null while a
 *   re-watch of covered audio suppresses forwarding
 * @param {string} parts.providerId - selected Speech Provider id
 * @param {object} parts.credentials - that provider's credentials
 */
function createCaptureContext({
  sessionId,
  tabId,
  platformId,
  kind,
  timestampKind,
  startedAtMs,
  segmentLengthSeconds,
  transcribeMode,
  pageTitle,
  sourceUrl,
  playbackWindows,
  playbackWindowStart,
  realtimeOriginSeconds,
  realtimeHoldUntilSeconds,
  state,
  segmenter,
  providerId,
  credentials,
}) {
  return {
    sessionId,
    tabId,
    platformId,
    kind,
    timestampKind,
    startedAtMs,
    segmentLengthSeconds,
    transcribeMode: transcribeMode === "realtime" ? "realtime" : "segment",
    // Absent until the bridge reports the page title; first write wins.
    pageTitle,
    // 0.1.57: the page URL the Session was started on, persisted with the
    // pointer so a worker restart can still tell course-switch from re-click.
    sourceUrl: typeof sourceUrl === "string" ? sourceUrl : null,
    state,
    segmenter,
    // The last position seen on the active timeline. A rebuilt context
    // resumes at the segmenter cursor (which already includes a #48 anchor
    // or seek jump carried by the pointer), so the first tick after a
    // restart never reads as a seek from 0.
    lastPosition: segmenter.emittedUpTo,
    // Drag-detection baseline: false until the first bridged position arms
    // it, so a Session opened mid-video never reads its first report as a
    // drag from 0 (the 3s fallback threshold would fire on any start
    // position). A rebuilt context resumes from the persisted cursor (> 0
    // once anything was captured), so restarts arm immediately.
    seekBaselineArmed: segmenter.emittedUpTo > 0,
    // Realtime timeline state (#50): playbackWindows are the CLOSED ranges
    // the player traversed while capturing (they cover silent stretches a
    // done Segment would cover in segment mode); playbackWindowStart is the
    // open one. realtimeOriginSeconds is the video position the live
    // recognition session counts its utterance offsets from (re-based on
    // every drag); realtimeHoldUntilSeconds is non-null while a re-watch of
    // covered audio suppresses forwarding, and names the position where
    // capture resumes.
    playbackWindows: Array.isArray(playbackWindows) ? playbackWindows : [],
    playbackWindowStart: playbackWindowStart ?? null,
    realtimeOriginSeconds: Number(realtimeOriginSeconds) || 0,
    realtimeHoldUntilSeconds: realtimeHoldUntilSeconds ?? null,
    // The last VIDEO position the page bridge reported (#49), updated on
    // every bridged report. Realtime video-kind Sessions stamp finalized
    // utterances from this (mapUtteranceStart); null until the first
    // report lands — never persisted, a rebuilt context re-learns it
    // within one bridge tick.
    lastVideoPosition: null,
    pendingChunks: [],
    providerId,
    credentials,
    liveTimer: null,
    summaryTimer: null,
    // #48 probe window deadline (ms): set only for a FRESH wallclock Session
    // (in handleStartLearning). A resumed wallclock Session never probes —
    // its wallclock Segments are already on the timeline and anchoring would
    // mix timelines. Anchoring (or lapsing) sets it back to null.
    probeDeadlineMs: null,
    // #48 Plan A re-listen state: non-null while playback is below the
    // segmenter cursor (re-watching covered ranges). frontier is the cursor
    // where new content resumes; attempted holds the failed Segment ids
    // already retried during this pass so each retries at most once.
    relisten: null,
    // #48 retry watch: the failed Segment whose range playback is currently
    // re-covering, {segmentId, start, end}; the retry cut fires at end.
    retryWatch: null,
    // #48 hole-fill watch: the gapSkipped hole playback is currently
    // re-watching, {filledStart, windowStart, windowEnd, holeEnd} — the fill
    // Segment over [windowStart, windowEnd] dispatches when playback crosses
    // windowEnd, and holeEnd rides the watch because the marker shrinks as
    // fills land and no longer reports the hole's extent. Memory-only like
    // retryWatch: a rebuilt context re-arms on the next below-cursor
    // position inside the (shrunken) marker.
    fillWatch: null,
    // True while a fill Segment's cut/transcription is in flight; bridge
    // ticks arriving meanwhile must not arm an overlapping fill pass.
    fillInFlight: false,
    // One Topic tick at a time; a fresh or resumed Session simply waits for
    // the first timer fire, where the content-driven trigger decides.
    summaryInFlight: false,
    ended: false,
  };
}

/**
 * The captureStart payload for the offscreen document, one builder for both
 * call sites (handleStartLearning's fresh Session and
 * ensureCaptureResumed's mid-Session restart) so a resumed realtime Session
 * can never drift from a fresh one. The Qwen key rides the message only in
 * realtime mode (spec #44: message-only transport, never persisted); the
 * segment recorder ignores it.
 */
function buildCaptureStartMessage(context, streamId) {
  return {
    action: "captureStart",
    streamId,
    segmentLengthSeconds: context.segmentLengthSeconds,
    mode: context.timestampKind === "wallclock" ? "wallclock" : "video",
    // Consumed by the offscreen realtime path (spec #44); the segment
    // recorder ignores it.
    transcribeMode: context.transcribeMode,
    // The realtime WebSocket handshake needs the Qwen key (spec #44:
    // message-only transport, never persisted); the segment recorder
    // ignores it. originSeconds (#50) re-bases a resumed Session's
    // recognition at its persisted resume point.
    ...(context.transcribeMode === "realtime"
      ? {
          apiKey: context.credentials.apiKey,
          originSeconds: Number(context.realtimeOriginSeconds) || 0,
        }
      : {}),
  };
}

/**
 * Rebuilds the in-memory capture context after a service-worker restart.
 * Resume is exactly the #12 contract: load the snapshot, resumeFromSnapshot,
 * keep feeding events — done Segments are never re-transcribed.
 */
async function ensureCaptureResumed() {
  if (captureContext) return captureContext;
  const pointer = await readContextPointer();
  if (!pointer) return null;
  const snapshot = await YTD_SESSION_PERSISTENCE.loadSessionSnapshot(
    chrome.storage.local,
    pointer.sessionId,
  );
  if (!snapshot) {
    await clearContextPointer();
    return null;
  }
  const state = YTD_SESSION_PIPELINE.resumeFromSnapshot(snapshot);
  if (state.status !== "active") {
    await clearContextPointer();
    return null;
  }

  // Segments captured but never transcribed when the previous worker died
  // were in flight; the rebuilt segmenter starts past them, so settle them
  // as failed here. Each one emits its [语音转录失败] marker record, closing
  // the transcript hole with a visible annotation instead of a silent gap.
  let resumedState = YTD_SESSION_PIPELINE.settleInterruptedSegments(state);
  if (resumedState !== state) {
    await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(
      chrome.storage.local,
      resumedState,
    );
  }

  const settings = await getSettings();
  const context = createCaptureContext({
    ...pointer,
    state: resumedState,
    segmenter: YTD_SEGMENTER.createSegmenter({
      segmentLengthSeconds: pointer.segmentLengthSeconds,
      // The cursor can run ahead of the persisted Segments after a #48
      // mid-video anchor or seek-forward jump (the skipped range produces
      // no Segment records); the pointer carries it across the restart.
      startAt: Math.max(
        segmentsEndSeconds(resumedState),
        Math.floor(Number(pointer.cursorSeconds) || 0),
      ),
      startIndex: resumedState.segments.length,
    }),
    providerId: settings.speechProvider,
    credentials: settings.speechProviders[settings.speechProvider] || {},
  });
  // Realtime Sessions have no Segments bounding the cursor, so seek
  // detection (#49) rebuilds its baseline from the last Transcript record's
  // end: without it, the first post-restart report reads as a seek from 0
  // and falsely marks the already-transcribed head as skipped.
  if (context.transcribeMode === "realtime") {
    context.lastPosition = Math.max(
      context.lastPosition,
      lastUtteranceEndSeconds(resumedState),
    );
    // The offscreen document restarts its recognition session on the fresh
    // captureStart, so the origin re-bases at the resume point: never below
    // the last persisted record's end (utterance offsets would re-stamp
    // already-covered ranges).
    if (context.timestampKind === "video") {
      context.realtimeOriginSeconds = Math.max(
        context.realtimeOriginSeconds,
        lastUtteranceEndSeconds(resumedState),
      );
    }
  }
  // A resumed context always carries a meaningful drag-detection baseline
  // (the persisted cursor, plus the last utterance's end above): the first
  // post-restart report must detect drags, not arm the baseline.
  context.seekBaselineArmed = true;
  captureContext = context;
  // P10: a recording Session that survived a worker restart keeps its
  // progress writer (and its optimistic-concurrency revision) — the
  // persisted learning target is the durable state.
  await rebuildProgressTracking(context);

  // The offscreen recorder survives a worker restart but not a browser
  // restart; only the latter needs a fresh capture stream.
  if (!(await chrome.offscreen.hasDocument())) {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: context.tabId,
      });
      await ensureOffscreen();
      const started = await sendOffscreen(
        buildCaptureStartMessage(context, streamId),
      );
      if (!started?.success) throw new Error(started?.error || "capture restart failed");
    } catch (error) {
      // Without the tab (closed or navigated away) capture cannot restart;
      // the Session stays resumable the moment the learner returns. Loud on
      // purpose: this is also the zombie-Session path — the pointer stays
      // active while nothing records, and every icon click then hits
      // "already active" with no visible reason.
      console.error(
        "[Learning Digest] capture restart failed (Session stays active without audio):",
        error?.message || error,
      );
    }
  }
  // The live tick exists to feed the scheduler on the wallclock timeline;
  // realtime Sessions (#47) schedule nothing, so their tick is not armed.
  if (context.timestampKind === "wallclock" && context.transcribeMode !== "realtime") {
    startLiveTimer(context);
  }
  startSummaryTimer(context);
  console.log(`[Learning Digest] 采集已恢复: session=${context.sessionId} kind=${context.kind}`);
  return context;
}

/**
 * The panel's 从头开始 button (0.1.63): rewinds the lesson to 0:00 so an
 * autoplay-started course transcribes from the true beginning instead of
 * losing its first grid cell to the mid-video anchor's upward snap. The
 * rewind itself rides the existing bridge (seek events report the new
 * position immediately); the re-listen path keeps covered ranges free of
 * duplicates when the button is pressed mid-Session.
 */
async function handleRestartFromBeginning() {
  const context = await ensureCaptureResumed();
  if (!context || context.ended) {
    return { success: false, error: "当前没有进行中的转写会话" };
  }
  if (context.kind === "live") {
    return { success: false, error: "直播没有时间轴，无法从头播放" };
  }
  try {
    // 0.1.65: a late-detected live replay may have anchored at 0:15 (or any
    // later grid point) while still having no captured Segments. Merely
    // rewinding the player leaves the scheduler at that anchor, so playback
    // from 0:00 is treated as re-listening and the prefix is never captured.
    // For a genuinely empty segment Session, reopen the prefix at zero before
    // the bridge's seek events arrive. Sessions with existing coverage keep
    // the normal re-listen/no-duplicate behavior.
    if (
      context.transcribeMode !== "realtime" &&
      context.state.segments.length === 0 &&
      context.state.transcriptRecords.length === 0
    ) {
      await discardRecordedAudio(context);
      context.segmenter = YTD_SEGMENTER.createSegmenter({
        segmentLengthSeconds: context.segmentLengthSeconds,
        startAt: 0,
        startIndex: 0,
      });
      context.lastPosition = 0;
      context.relisten = null;
      context.retryWatch = null;
      context.fillWatch = null;
      context.fillInFlight = false;
      context.seekBaselineArmed = false;
      await persistContextPointer(context);
    }
    const result = await chrome.tabs.sendMessage(context.tabId, {
      action: "restartFromBeginning",
    });
    if (result?.success) return { success: true };
    return {
      success: false,
      error: result?.error || "页面上没有找到可控制的视频，请刷新课程页后重试",
    };
  } catch (_error) {
    // No bridge on the tab (closed, navigated, or an iframe-only player):
    // the honest failure tells the learner what to do next.
    return { success: false, error: "课程页桥接不可用，请刷新课程页后重试" };
  }
}

function startLiveTimer(context) {
  context.liveTimer = setInterval(() => {
    feedPosition(context, (Date.now() - context.startedAtMs) / 1000);
  }, LIVE_TICK_MS);
}

// ============================================================
// TOPIC TICK + SESSION DIGEST (#18 / #28, ADR 0002)
// ============================================================
//
// While a Session is active, a summary CHECK fires on a fixed 60-second
// cadence; whether a tick is actually due is a content-driven decision
// (isTopicTickDue): the Transcript coverage since the last Topic must have
// reached the configured interval — the CONTENT threshold, not the timer
// period — AND at least 10 new records must exist. All assembly/trigger/
// parsing decisions are pure functions in session-summary.js; this layer
// only owns the check timer, the AI call, and feeding the parsed Topics
// back as a topicsAppended event.
//
// The coverage cursor derives from the persisted Topics (not timer state),
// so a resumed Session continues appending from exactly where the snapshot
// left off. A failed tick leaves the Topics untouched, so the next check
// retries; summaryInFlight keeps one tick at a time.

/** The fixed cadence at which the content-driven tick decision is re-run. */
const SUMMARY_CHECK_INTERVAL_MS = 60_000;

function startSummaryTimer(context) {
  // The callback returns the tick promise: setInterval ignores it, and the
  // tick body catches its own errors, so nothing can turn unhandled — but
  // tests can await one check through the captured callback.
  context.summaryTimer = setInterval(() => {
    return maybeRunTopicTick(context);
  }, SUMMARY_CHECK_INTERVAL_MS);
}

async function maybeRunTopicTick(context) {
  if (context.ended || context.summaryInFlight) return;
  const settings = await getSettings();
  const due = YTD_SESSION_SUMMARY.isTopicTickDue({
    state: context.state,
    intervalMinutes: settings.summaryIntervalMinutes,
  });
  if (!due) return;

  context.summaryInFlight = true;
  try {
    const input = YTD_SESSION_SUMMARY.assembleTopicTickInput(context.state);
    // The prompt copy lives in prompts/topic-tick.md (#33); a load failure
    // throws before any AI call and lands in the quiet retry path below.
    const template = await loadPromptTemplate("topic-tick.md", {
      systemPrompt: "System prompt",
      userPrompt: "User prompt",
      firstBatchUserPrompt: "First batch user prompt",
    });
    const { text } = await requestAiCompletion({
      maxTokens: 4096,
      messages: YTD_SESSION_SUMMARY.buildTopicTickMessages(template, {
        existingTopicTitles: input.existingTopicTitles,
        contextTranscriptText: YTD_SESSION_SUMMARY.formatTranscriptForPrompt(
          input.overlapTail,
        ),
        newTranscriptText: YTD_SESSION_SUMMARY.formatTranscriptForPrompt(
          input.newTranscript,
        ),
      }),
    });
    // Tolerant parse: malformed output yields an empty list, which the state
    // machine ignores — the state and its cursor stay untouched.
    const topics = YTD_SESSION_SUMMARY.parseTopicTick(text);
    if (topics.length > 0) {
      context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
        type: "topicsAppended",
        topics,
      });
      await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(
        chrome.storage.local,
        context.state,
      );
      broadcastSession(context.state);
    }
  } catch (error) {
    // A failed tick leaves the timeline untouched; the next check retries.
    debugLog("[Learning Digest BG] Topic tick failed:", error);
  } finally {
    context.summaryInFlight = false;
  }
}

/**
 * Runs the end-of-session global pass (ADR 0002, #29): one AI request over
 * the full Transcript producing the report JSON (Topics with summaries,
 * quotes, todos). Input assembly and parsing live in session-summary.js;
 * this function only adds the AI call and normalizes the outcome:
 *
 * - { report }                 parsed report artifact
 * - { report: null, truncated: true }  finish reason "length" or null parse
 * - { report: null, skipped: "noTranscript" }
 * - { report: null, error }    AI provider failure
 *
 * Failures never throw: the caller decides persistence and the payload the
 * panel renders.
 *
 * @returns {Promise<{report: object|null, truncated?: boolean, skipped?: string, error?: string}>}
 */
async function generateSessionReport(state) {
  const records = state?.transcriptRecords || [];
  if (records.length === 0 || YTD_SESSION_PIPELINE.allSegmentsFailed(state)) {
    return { report: null, skipped: "noTranscript" };
  }
  try {
    const { transcriptRecords, liveTopics } =
      YTD_SESSION_SUMMARY.assembleGlobalPassInput(state);
    // The prompt copy lives in prompts/session-report.md (#33); a load
    // failure becomes { report: null, error } below, never a broken prompt.
    const template = await loadPromptTemplate("session-report.md", {
      systemPrompt: "System prompt",
      userPrompt: "User prompt",
      userPromptWithoutTopics: "User prompt without topics",
    });
    const { text, finishReason } = await requestAiCompletion({
      maxTokens: 8192,
      messages: YTD_SESSION_SUMMARY.buildGlobalPassMessages(template, {
        transcriptText: YTD_SESSION_SUMMARY.formatTranscriptForPrompt(
          transcriptRecords,
        ),
        liveTopics,
      }),
    });
    const report = YTD_SESSION_SUMMARY.parseGlobalPass(text);
    if (!report || finishReason === "length") {
      // A truncated or unparseable output must never land as the artifact:
      // the caller persists nothing and offers the retry action instead.
      return { report: null, truncated: true };
    }
    return { report };
  } catch (error) {
    debugLog("[Learning Digest BG] global pass failed:", error);
    return { report: null, error: error?.message || String(error) };
  }
}

/**
 * Panel copy for the one failure mode the learner can fix by re-running:
 * the model hit the output limit (or produced nothing parseable) and the
 * artifact was therefore not persisted.
 */
const REPORT_LENGTH_LIMIT_MESSAGE = "报告长度受限，生成未完成，请重试。";

/**
 * Runs the global pass for an ended Session and lands the result. A
 * successful pass persists `report_<sessionId>` (with the artifact meta when
 * the caller captured it, #30) and returns the artifact; a truncated/failed
 * pass persists nothing and returns the error payload the panel renders
 * (with the retry action). Never throws — every failure mode becomes a
 * renderable payload.
 *
 * @param {object} state - ended Session state
 * @param {object|null} [meta] - { startedAtMs, endedAtMs, kind, platformId? }
 * @returns {Promise<{report: object, persisted: boolean}>}
 */
async function produceSessionReport(state, meta = null) {
  try {
    const outcome = await generateSessionReport(state);
    if (outcome.report) {
      const artifact = {
        sessionId: state.sessionId,
        report: outcome.report,
        generatedAtMs: Date.now(),
      };
      // Meta rides along when known (#30): the report header needs it, and
      // the generated-at stamp (0.1.38) joins it so the header shows when
      // the pass ran. A failed pass persists nothing, so a retry
      // reconstructs instead.
      if (meta) artifact.meta = { ...meta, generatedAtMs: artifact.generatedAtMs };
      const storageKey = `${YTD_REPORT_RENDER.REPORT_STORAGE_KEY_PREFIX}${state.sessionId}`;
      await chrome.storage.local.set({ [storageKey]: artifact });
      return { report: outcome.report, persisted: true };
    }
    if (outcome.skipped === "noTranscript") {
      return { report: { skipped: "noTranscript" }, persisted: false };
    }
    return {
      report: {
        error: outcome.truncated
          ? REPORT_LENGTH_LIMIT_MESSAGE
          : outcome.error || REPORT_LENGTH_LIMIT_MESSAGE,
      },
      persisted: false,
    };
  } catch (error) {
    // Persistence or an unexpected failure must never break the end flow:
    // the panel still gets a renderable payload.
    console.error("[Learning Digest] landing the report failed:", error?.message || error);
    return { report: { error: error?.message || String(error) }, persisted: false };
  }
}


/**
 * Feeds the scheduler one position reading (video position for replay and
 * course pages, wall-clock elapsed for live) and dispatches whatever
 * Segments completed. Feeding is idempotent: the scheduler's cursor only
 * moves forward. Realtime Sessions (#47) never schedule: they have no
 * recorder to cut from, so a dispatched Segment could only ever fail.
 */
function feedPosition(context, positionSeconds) {
  if (context.ended || context.transcribeMode === "realtime") return;
  context.lastPosition = Math.max(context.lastPosition, positionSeconds);
  for (const segment of context.segmenter.recordPosition(positionSeconds)) {
    void dispatchSegment(context, segment);
  }
}

/**
 * One Segment end to end: append it to the Session, cut its audio from the
 * recorder (consuming any backstop chunk first), transcribe exactly once,
 * then feed the result back into the state machine. Every transition is
 * persisted and broadcast so a close at any point loses at most the
 * in-flight Segment. Retry dispatches (#48) pass an explicit segmentId —
 * the FAILED Segment's own id — so the result replaces that Segment's
 * failure marker instead of appending a new entry.
 *
 * @returns {Promise<boolean>} true when the Segment transcribed cleanly —
 * hole-fill callers shrink the skipped marker only on this outcome, so a
 * failed fill never swallows the hole it was filling.
 */
async function dispatchSegment(context, segment, segmentId = `seg-${segment.index}`) {
  context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
    type: "segmentCaptured",
    segment: { id: segmentId, start: segment.start, duration: segment.duration },
  });
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
  broadcastSession(context.state);

  try {
    const queued = context.pendingChunks.shift();
    const cut = queued || (await sendOffscreen({ action: "captureCut" }));
    if (!cut || cut.error) throw new Error(cut?.error || "no audio chunk");
    const blob = dataUrlToBlob(cut.dataUrl, cut.mimeType);
    const records = await YTD_SPEECH_PROVIDERS.transcribeSegment(
      context.providerId,
      blob,
      context.credentials,
    );
    // Provider records are Segment-relative; the Transcript needs absolute
    // Session timestamps.
    const absoluteRecords = records.map((record) => ({
      ...record,
      start: record.start + segment.start,
    }));
    context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
      type: "transcribeOk",
      segmentId,
      records: absoluteRecords,
    });
    await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
    broadcastSession(context.state);
    return true;
  } catch (error) {
    // Loud on purpose: a failed Segment shows up in the panel only as an
    // anonymous [语音转录失败] marker, so this console.error is the only
    // place the reason (provider error body, audio shape, credentials)
    // ever surfaces. Not gated by DEBUG.
    console.error(
      `[Learning Digest] Segment ${segmentId} transcription failed:`,
      error?.message || error,
    );
    context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
      type: "transcribeFailed",
      segmentId,
    });
    await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
    broadcastSession(context.state);
    return false;
  }
}

/**
 * Persisted breadcrumb for every reason a click did not produce a running
 * capture: ignored clicks, already-active, and start failures all land in
 * ytd_last_start_failure, so one storage read reconstructs the outcome even
 * when the console and panel are attached to dead contexts. The first
 * parameter is `reason` because it carries non-error outcomes too (an
 * already-active Session is not a failure); the persisted field stays
 * `error` for the diagnostics shape.
 */
async function recordStartAttempt(reason, sessionId = null) {
  try {
    await chrome.storage.local.set({
      ytd_last_start_failure: { at: Date.now(), sessionId, error: reason },
    });
  } catch (_error) {
    // Storage unavailable (context invalidated); nothing to do.
  }
}

async function handleStartLearning(message) {
  const recognition = YTD_SOURCE_PLATFORMS.recognizePage(message.url);
  if (recognition.kind === "none") {
    return { success: false, error: "This page is not a recognized learning page." };
  }
  const existing = await ensureCaptureResumed();
  if (existing) {
    return { success: false, error: "A learning Session is already active.", sessionId: existing.sessionId };
  }

  // P6 authorization gate (authoritative, await-based): no linked credential
  // that /v1/me accepts, no capture. The panel is told to show the guide.
  const auth = await checkAuthNow();
  if (!auth.authorized) {
    void notifyPanel({
      action: "authState",
      authorized: false,
      reason: auth.reason || "unauthorized",
    });
    return {
      success: false,
      error:
        "学习库账号未关联或授权已失效：请先在侧边栏完成账号关联，再开始学习。",
    };
  }

  const settings = await getSettings();
  const providerId = settings.speechProvider;
  const credentials = settings.speechProviders[providerId] || {};
  // The gate follows the SELECTED Speech Provider's declared credential
  // fields (the password-typed ones, same rule the options page enforces on
  // save), not a hard-coded apiKey check: Tencent has no apiKey.
  const missingFields =
    YTD_SPEECH_PROVIDERS.missingProviderCredentials(providerId, credentials);
  if (missingFields.length) {
    const provider = YTD_SPEECH_PROVIDERS.getSpeechProvider(providerId);
    return {
      success: false,
      error:
        `Add ${missingFields.join(", ")} for ${provider?.label || providerId} ` +
        "in Settings first.",
    };
  }

  const state = YTD_SESSION_PIPELINE.createSession({
    sessionId: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  });
  const context = createCaptureContext({
    sessionId: state.sessionId,
    tabId: message.tabId,
    platformId: recognition.platformId,
    kind: recognition.kind,
    timestampKind: recognition.timestampKind,
    startedAtMs: Date.now(),
    sourceUrl: message.url,
    segmentLengthSeconds: settings.segmentLengthSeconds,
    transcribeMode: resolveTranscribeMode(providerId, credentials),
    state,
    segmenter: YTD_SEGMENTER.createSegmenter({
      segmentLengthSeconds: settings.segmentLengthSeconds,
    }),
    providerId,
    credentials,
  });
  captureContext = context;
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, state);
  await persistContextPointer(context);
  // #48: a fresh wallclock Session probes for a bridged media position for
  // the first 10 seconds; anchoring re-aligns the whole timeline to the
  // video position (the pointer above still says wallclock — the anchor
  // persists its own pointer). Resumed wallclock Sessions never probe, so
  // their recorded wallclock timeline can never be mixed with video
  // timestamps.
  if (context.timestampKind === "wallclock") {
    context.probeDeadlineMs = Date.now() + PROBE_WINDOW_MS;
  }

  try {
    // The icon-click path supplies a streamId fetched while the click's
    // gesture was still fresh (see handleActionClicked); direct callers
    // fetch here, which outside a user gesture fails with Chrome's
    // not-invoked error and surfaces the actionable instruction below.
    const streamId =
      message.streamId ||
      (await chrome.tabCapture.getMediaStreamId({ targetTabId: context.tabId }));
    await ensureOffscreen();
    const started = await sendOffscreen(
      buildCaptureStartMessage(context, streamId),
    );
    if (!started?.success) throw new Error(started?.error || "capture start failed");
  } catch (error) {
    captureContext = null;
    await clearContextPointer();
    const message = error?.message || String(error);
    console.error("[Learning Digest] startLearning failed:", message);
    await recordStartAttempt(message, context.sessionId);
    // Chrome only allows tabCapture after the user has INVOKED the extension
    // on the target tab (a toolbar icon click); a side-panel button click
    // does not count. Turn the raw English API error into an actionable
    // instruction instead of leaving the learner stranded.
    if (/not been invoked/i.test(message)) {
      return {
        success: false,
        error:
          "Chrome 要求在采集前先调用一次扩展：请在小鹅通课程标签页上点击工具栏中的 Learning Digest 图标（点击即打开侧边栏并算作一次调用），然后再点「开始学习」。如果刚刷新或跳转过课程页面，需要重新点一次图标。",
      };
    }
    return {
      success: false,
      error: `无法开始音频采集：${message}`,
    };
  }

  // Realtime Sessions (#47) schedule nothing (see feedPosition): no live
  // tick, and the wallclock timeline stands for the whole Session.
  if (context.timestampKind === "wallclock" && context.transcribeMode !== "realtime") {
    startLiveTimer(context);
  }
  startSummaryTimer(context);
  broadcastSession(context.state, { transcribeMode: context.transcribeMode });
  // P10 (decision 4): the Session is recording — lock the learning target
  // and arm the progress writer (the resolve re-issued here keeps
  // expectedRevision fresh at write time). Awaited so the persisted lock
  // lands before the panel learns the Session started.
  await beginProgressTracking(context);
  // The one-line "capture is live" marker: when this is absent after an
  // icon click, the Session never started and the reason is in the
  // startLearning failure log above.
  console.log(
    `[Learning Digest] 采集已开始: session=${context.sessionId} ` +
      `mode=${context.timestampKind === "wallclock" ? "直播(墙钟)" : "录播(媒体位置)"} ` +
      `segment=${context.segmentLengthSeconds}s provider=${context.providerId}`,
  );
  chrome.storage.local.remove("ytd_last_start_failure").catch(() => {});
  return {
    success: true,
    sessionId: context.sessionId,
    kind: context.kind,
    timestampKind: context.timestampKind,
    transcribeMode: context.transcribeMode,
    state: context.state,
  };
}

async function handleMediaPosition(message, sender) {
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  if (sender.tab?.id !== context.tabId) {
    // One-time (per context) diagnostic: a position stream from another tab
    // is the stale-Session signature — every message below would otherwise
    // be dropped silently and the learner sees "drag does nothing".
    if (!context.warnedForeignPosition) {
      context.warnedForeignPosition = true;
      console.warn(
        `[Learning Digest] 忽略来自标签页 ${sender.tab?.id} 的播放位置：` +
          `当前会话属于标签页 ${context.tabId}（可能是未结束的旧会话）`,
      );
    }
    return;
  }
  const position = Number(message.position);
  // The video position every consumer below reads: realtime video-kind
  // Sessions stamp finalized utterances from it (#49), the segment-mode
  // seek/anchor logic follows the same stream as before.
  if (Number.isFinite(position) && position >= 0) {
    context.lastVideoPosition = position;
    // P10: the same stream feeds the progress writer for the recorded
    // source — bound to this Session's tab, so focus/tab switches cannot
    // reroute it (decision 4).
    feedLearningPosition(context, position);
  }
  // Realtime Sessions (#47, #49) run no Segment schedule: no scheduler
  // feeds, no re-listen retries (there is no recorder to re-cut from). What
  // still rides the position stream: the #48 probe (a wallclock Session
  // anchors to the video timeline so utterances stamp at video positions
  // from the anchor on), the #48 seek-forward hole marker, and media-end
  // auto-stop. A wallclock Session whose probe lapsed stays on stream-time
  // stamps for its whole life, exactly as pre-#49.
  if (context.transcribeMode === "realtime") {
    if (context.timestampKind !== "video") {
      // 0.1.64 live-replay recovery, same as the segment path below.
      if (!(await convertLiveRecordingIfReplay(context, message, position))) {
        await probeForAnchor(context, position);
        if (context.timestampKind !== "video") return;
      }
    }
    if (Number.isFinite(position)) {
      await handleRealtimeDrag(context, position);
      // Drag detection compares against the last REPORTED position (not a
      // monotonic frontier): after a backward drag the baseline is the
      // landing point, so the next drag measures from there.
      context.lastPosition = position;
    }
    // Media end auto-ends replay/course Sessions; live ends only via the
    // explicit end action.
    if (message.ended && (context.kind === "replay" || context.kind === "course")) {
      await endActiveSession(context, { reason: "mediaEnded" });
    }
    return;
  }
  if (context.timestampKind !== "video") {
    // 0.1.64: a live-kind Session whose probe lapsed still converts when a
    // FINITE-duration recording shows up (直播回放), before the warn path.
    if (await convertLiveRecordingIfReplay(context, message, position)) {
      // Converted: fall through to the video-timeline handling below.
    } else {
      // #48 probe window: a wallclock Session anchors to the video timeline
      // when the bridge reports a valid position in time. While it stays
      // wallclock (no probe, lapsed window, or not-yet-valid position), the
      // position stream is ignored exactly as before.
      await probeForAnchor(context, position);
      if (context.timestampKind !== "video") return;
    }
  }
  if (!Number.isFinite(position)) return;
  // #48 seek-awareness, in order: a forward seek cuts at the seek point and
  // jumps the cursor; re-listening below the cursor cuts at the range
  // boundaries (failed-Segment retries, Plan A); only then does the
  // scheduler see the position.
  await handleSeekForward(context, position);
  await updateRelisten(context, position);
  feedPosition(context, position);
  // Media end auto-ends replay/course Sessions; live ends only via the
  // explicit end action.
  if (message.ended && (context.kind === "replay" || context.kind === "course")) {
    await endActiveSession(context, { reason: "mediaEnded" });
  }
}

/**
 * The #48 probe: within the 10s window from Session start, the first valid
 * bridged position (a finite number ≥ 0 — the bridge only reports when a
 * media element exists) anchors the Session to the video timeline. A lapsed
 * window stays wallclock for the whole Session.
 *
 * @param {object} context - the active capture context
 * @param {number} position - the bridged position, unvalidated
 */
/**
 * 0.1.66 live-replay detection: a live-kind Session converts whenever the
 * bridge reports a FINITE-duration video, both inside and after the initial
 * probe window. The old lapse-only gate let the early probe flip the timeline
 * to video while leaving kind=live forever (直播 · 已对齐视频时间轴). A finite
 * duration is a recording (直播回放), so kind flips to "replay" and every
 * replay behavior follows (grid timeline, media-end auto-stop, 从头开始).
 * True broadcasts (infinite/no duration) keep the existing probe behavior.
 *
 * @returns {Promise<boolean>} true when the Session converted and anchored
 */
async function convertLiveRecordingIfReplay(context, message, position) {
  if (context.kind !== "live") return false;
  if (!Number.isFinite(position) || position < 0) return false;
  const duration = Number(message.duration);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  context.kind = "replay";
  await anchorSessionToVideo(context, position);
  console.log(
    `[Learning Digest] 直播页检测到录像（时长 ${Math.round(duration)}s），已按回放转写`,
  );
  return true;
}

async function probeForAnchor(context, position) {
  if (context.probeDeadlineMs === null) {
    // One-time diagnostic: positions keep arriving but this Session can never
    // anchor (probe lapsed at start, or a resumed wallclock Session): every
    // consumer below ignores the stream, which otherwise looks like "drag
    // does nothing / nothing transcribes on the video timeline".
    if (
      !context.warnedLapsedProbe &&
      Number.isFinite(position) &&
      position >= 0
    ) {
      context.warnedLapsedProbe = true;
      console.warn(
        `[Learning Digest] 会话保持墙钟计时，播放位置流被忽略 ` +
          `(会话=${context.sessionId})；拖拽与视频时间轴转写不可用`,
      );
    }
    return; // resumed Session: no probe
  }
  if (Date.now() > context.probeDeadlineMs) {
    context.probeDeadlineMs = null;
    return;
  }
  if (!Number.isFinite(position) || position < 0) return;
  await anchorSessionToVideo(context, position);
}

/**
 * Anchors a wallclock Session to the video timeline (#48): the timestamp
 * kind flips to "video" (persisted in the pointer so a restart keeps it),
 * the wallclock live tick stops, and a fresh scheduler is seeded at the
 * bridged position — records before the anchor point produce nothing (no
 * backfill of the skipped head), and Segment indices stay continuous.
 *
 * The probe window's audio (already recorded, ≤ 10s of it) is consumed by
 * the first anchored cut rather than discarded, so no lesson audio is lost.
 */
async function anchorSessionToVideo(context, position) {
  // 0.1.60: the anchor snaps up to the next Segment-length boundary, same
  // grid rule as seek landings — records before it produce nothing either
  // way (no backfill of the skipped head).
  const anchor = snapToSegmentGrid(context, position);
  context.timestampKind = "video";
  context.probeDeadlineMs = null;
  if (context.liveTimer) {
    clearInterval(context.liveTimer);
    context.liveTimer = null;
  }
  context.segmenter = YTD_SEGMENTER.createSegmenter({
    segmentLengthSeconds: context.segmentLengthSeconds,
    startAt: anchor,
    startIndex: context.state.segments.length,
  });
  context.lastPosition = Math.max(context.lastPosition, anchor);
  // The recorder's regular wall-clock cut cadence (armed at captureStart)
  // belongs to the wallclock timeline; the anchored Session cuts following
  // the media position, like any replay Session.
  await sendOffscreen({ action: "captureCadence", mode: "video" });
  await persistContextPointer(context);
  broadcastSession(context.state, { timestampKind: context.timestampKind });
  console.log(
    `[Learning Digest] 会话已对齐视频时间轴: session=${context.sessionId} ` +
      `position=${YTD_SPEECH_TRANSCRIPTION.formatTimestamp(anchor)}`,
  );
}

/**
 * 0.1.60 grid alignment: the segmenter steps SegmentLength from 0, so grid
 * points are multiples of the configured length. Snapping a drag/fill
 * landing position UP to the next boundary keeps every transcript record
 * starting on the same grid — the audio between the landing point and the
 * boundary is deliberately not transcribed (the learner's call: a tidy
 * timeline outweighs at most one Segment of audio per landing). Positions
 * already on a boundary pass through unchanged.
 */
function snapToSegmentGrid(context, position) {
  const length = Number(context.segmentLengthSeconds) || 30;
  const grid = Math.max(5, Math.min(60, Math.floor(length)));
  return Math.ceil((Number(position) || 0) / grid) * grid;
}

/**
 * Seek-forward: a position jump larger than the forward-drag threshold
 * within one report DISCARDS the in-flight partial Segment (0.1.62: the
 * not-yet-full tail is never transcribed — the gap marker owns its range),
 * jumps the scheduler cursor emitting nothing for the skipped range, and
 * appends one visible gap marker so the Digest is honest about the hole.
 * The landing point snaps UP to the next Segment-length boundary (0.1.60),
 * so every transcribed Segment is a full grid cell. Backward moves and
 * small advances return without touching anything.
 */
async function handleSeekForward(context, position) {
  if (!context.seekBaselineArmed) {
    // The first bridged position arms the drag-detection baseline; it is
    // never itself a drag (a Session can open at any video position).
    context.seekBaselineArmed = true;
    return;
  }
  const previous = context.lastPosition;
  if (!Number.isFinite(previous) || position <= previous) return;
  if (position - previous <= FORWARD_DRAG_THRESHOLD_SECONDS) {
    return;
  }
  // A seek invalidates any in-progress re-listen pass: the buffered audio
  // no longer maps to what playback covered, so the retry watch re-arms on
  // the next position if the seek landed inside a failed range — and any
  // hole-fill pass stops (the marker keeps its shrunken remainder; the
  // seek machinery owns the new hole/jump).
  context.retryWatch = null;
  context.fillWatch = null;
  // (a) 0.1.62: the in-flight partial Segment is discarded, not transcribed.
  // The buffered audio since the last completed boundary is cut and dropped;
  // its range folds into the gap marker below, so the Transcript holds only
  // full grid cells.
  await discardRecordedAudio(context);
  const gapStart = context.segmenter.emittedUpTo;
  // (b) The cursor jumps to the snapped landing point; the skipped range
  // (the discarded partial included) emits nothing. The pointer is
  // persisted BEFORE the gap marker lands: a worker death mid-seek must
  // never resume below the jumped cursor and backfill the skipped range.
  const aligned = snapToSegmentGrid(context, position);
  context.segmenter.jumpTo(aligned);
  context.lastPosition = Math.max(context.lastPosition, aligned);
  await persistContextPointer(context);
  // (c) One visible gap marker over the whole uncovered range — from the
  // last completed boundary (not the raw drag position) to the snapped
  // landing point.
  const gapDuration = aligned - gapStart;
  if (gapDuration > 0) {
    console.log(
      `[Learning Digest] 检测到向前拖拽: ` +
        `${YTD_SPEECH_TRANSCRIPTION.formatTimestamp(previous)} → ` +
        `${YTD_SPEECH_TRANSCRIPTION.formatTimestamp(position)}，` +
        `对齐到 ${YTD_SPEECH_TRANSCRIPTION.formatTimestamp(aligned)} 后开始转写，` +
        `跳过 ${YTD_SPEECH_TRANSCRIPTION.formatTimestamp(gapDuration)}`,
    );
    context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
      type: "gapSkipped",
      start: gapStart,
      duration: gapDuration,
    });
    await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
    broadcastSession(context.state);
  }
}

/**
 * #48 Plan A re-listen bookkeeping, run on every video position BEFORE the
 * scheduler sees it. Below the cursor nothing new is ever recorded (the
 * no-backward rule keeps one record set per position range), with on-demand
 * cuts at the range boundaries:
 *
 * - entering the re-listen (or a failed Segment's range): the buffered
 *   audio is first-pass material that must not duplicate or smear into the
 *   next record, so it is cut and discarded;
 * - playback re-covering a failed Segment's full range: the buffered
 *   re-watched audio is dispatched as that Segment's retry, replacing its
 *   [语音转录失败] marker exactly once;
 * - playback inside a gapSkipped hole (#48 hole-fill): the hole has no
 *   Segments to retry, so the re-watched audio is dispatched as fresh fill
 *   Segments at Segment-length boundaries, each shrinking the hole's
 *   marker via gapFilled;
 * - playback passing the old cursor frontier again: the re-watched buffer
 *   is discarded so the next Segment's cut holds only new audio.
 */
async function updateRelisten(context, position) {
  const cursor = context.segmenter.emittedUpTo;
  if (context.retryWatch) {
    const watch = context.retryWatch;
    if (position < watch.start) {
      // Sought away from the range mid-pass; the next entry re-arms.
      context.retryWatch = null;
      return;
    }
    if (position >= watch.end) {
      context.retryWatch = null;
      await dispatchRetrySegment(context, watch.segmentId);
      // A retry cut at (or past) the frontier already flushed the buffer:
      // the re-listen pass is over.
      if (position >= context.segmenter.emittedUpTo) context.relisten = null;
    }
    return;
  }
  // #48 hole-fill: a pending fill Segment dispatches at its window
  // boundary — which can BE the frontier (a hole may end exactly at the
  // cursor), so the fill check runs before the below-cursor gate.
  if (context.fillWatch && !context.fillInFlight) {
    const watch = context.fillWatch;
    if (position < watch.windowStart) {
      // Sought backward out of the hole mid-fill: stop filling — the
      // marker keeps its shrunken remainder, and a re-entry arms a fresh
      // pass from wherever playback landed.
      context.fillWatch = null;
    } else if (
      position - watch.windowEnd >
      FORWARD_DRAG_THRESHOLD_SECONDS
    ) {
      // Playback jumped deep past the window's boundary within one tick (a
      // drag below the cursor is invisible to the seek cut): the buffered
      // audio no longer maps to the window, so its fill is skipped and the
      // buffer discarded before the pass re-arms at the new position.
      context.fillWatch = null;
      await discardRecordedAudio(context);
      armFillWatch(context, position);
    } else if (position >= watch.windowEnd) {
      await dispatchFillSegment(context, watch);
    }
  }
  if (position < cursor) {
    if (!context.relisten) {
      context.relisten = { frontier: cursor, attempted: new Set() };
      // Entry boundary: the buffer holds first-pass audio since the last
      // real cut (including any queued backstop chunks) — discard it.
      await discardRecordedAudio(context);
    }
    const failed = findFailedSegmentAt(context, position);
    if (failed && !context.relisten.attempted.has(failed.id)) {
      context.retryWatch = {
        segmentId: failed.id,
        start: failed.start,
        end: failed.start + failed.duration,
      };
      // Range-entry boundary: drop the covered audio buffered since the
      // last cut so the retry cut holds only this range's re-watched audio.
      await discardRecordedAudio(context);
    }
    // #48 hole-fill: a position inside a gapSkipped marker's range is
    // fill-eligible — the hole has no Segments, so the failed-retry check
    // above never fires for it. Arm the first fill window at the entry
    // position; the discard keeps pre-entry audio out of the fill cut.
    if (!context.fillWatch && !context.fillInFlight && !context.retryWatch) {
      if (armFillWatch(context, position)) {
        await discardRecordedAudio(context);
      }
    }
    return;
  }
  if (context.relisten) {
    // Playback passed the old cursor frontier: new content resumes.
    context.relisten = null;
    context.retryWatch = null;
    context.fillWatch = null;
    await discardRecordedAudio(context);
  }
}

function findFailedSegmentAt(context, position) {
  return context.state.segments.find(
    (segment) =>
      segment.status === "failed" &&
      position >= segment.start &&
      position < segment.start + segment.duration,
  );
}

/**
 * Cuts and discards everything recorded since the last real Segment cut —
 * queued backstop chunks included. Used at the #48 re-listen boundaries,
 * where the buffered audio is already transcribed first-pass material
 * (Plan A: one record set per position range, no duplicates).
 */
async function discardRecordedAudio(context) {
  context.pendingChunks.length = 0;
  await sendOffscreen({ action: "captureCut" });
}

/**
 * Dispatches the re-watched audio for one failed Segment (#48 Plan A): the
 * cut is taken on demand at the range boundary and transcribed under the
 * FAILED Segment's own id, so transcribeOk replaces its marker in place.
 * The outcome (done or still failed) is whatever the transcription returns;
 * the id is marked attempted for this pass either way.
 */
async function dispatchRetrySegment(context, segmentId) {
  const segment = context.state.segments.find(
    (candidate) => candidate.id === segmentId,
  );
  if (!segment || segment.status !== "failed") return;
  if (context.relisten) context.relisten.attempted.add(segmentId);
  await dispatchSegment(
    context,
    { start: segment.start, duration: segment.duration },
    segmentId,
  );
}

/**
 * The gapSkipped marker whose skipped range contains the position, derived
 * from the transcript records at check time (#48 hole-fill) — no extra
 * state: the marker record IS the hole.
 */
function findGapSkippedMarkerAt(context, position) {
  return context.state.transcriptRecords.find(
    (record) =>
      YTD_SESSION_PIPELINE.isGapSkippedRecord(record) &&
      position >= record.start &&
      position < record.start + record.duration,
  );
}

/**
 * Arms the #48 hole-fill watch when the position sits inside a gapSkipped
 * marker's range: the pass fills [entry, entry + segmentLength] first
 * (capped at the hole's end) and that Segment dispatches when playback
 * crosses the boundary. The hole's end rides the watch because the marker
 * shrinks as fills dispatch and no longer reports the hole's extent.
 *
 * @returns {boolean} true when a fill watch was armed
 */
function armFillWatch(context, position) {
  const marker = findGapSkippedMarkerAt(context, position);
  if (!marker) return false;
  // 0.1.60: the fill starts at the next Segment-length boundary, never at
  // the raw landing point, so filled records sit on the same grid as
  // everything else. A hole whose remaining tail is shorter than one grid
  // step cannot host a grid-aligned fill — it stays a hole.
  const entry = snapToSegmentGrid(context, position);
  const holeEnd = marker.start + marker.duration;
  if (entry >= holeEnd) return false;
  context.fillWatch = {
    filledStart: entry,
    windowStart: entry,
    windowEnd: Math.min(entry + context.segmentLengthSeconds, holeEnd),
    holeEnd,
  };
  return true;
}

/**
 * Dispatches one hole-fill Segment (#48): the re-watched audio buffered
 * since the window's entry cut is transcribed as a NORMAL Segment over
 * [windowStart, windowEnd] — real hole audio, stamped at its in-hole
 * positions — and the covering gapSkipped marker shrinks via gapFilled so
 * it never coexists with the fill records. A FAILED fill shrinks nothing:
 * the hole marker keeps its full remainder and the failed Segment's marker
 * carries the retry outcome, so a later re-watch can retry the range. The next window re-arms at this
 * one's end until the hole is fully filled. fillInFlight keeps concurrent
 * bridge ticks from arming an overlapping pass while the transcription is
 * in the air; the marker lookup for the shrink tolerates the shapes every
 * shrink leaves behind (head remainder, advancing tail, removal).
 */
async function dispatchFillSegment(context, watch) {
  context.fillWatch = null;
  context.fillInFlight = true;
  try {
    const transcribed = await dispatchSegment(
      context,
      {
        start: watch.windowStart,
        duration: watch.windowEnd - watch.windowStart,
      },
      `seg-fill-${watch.windowStart}`,
    );
    // A failed fill must not shrink the skipped marker: the hole stays
    // visible (its head still uncovered) and the failed Segment's marker
    // shows the retry outcome, so a later re-watch can retry the range.
    if (!transcribed) return;
    context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
      type: "gapFilled",
      filledStart: watch.filledStart,
      filledEnd: watch.windowEnd,
    });
    await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(
      chrome.storage.local,
      context.state,
    );
    broadcastSession(context.state);
    if (watch.windowEnd < watch.holeEnd) {
      context.fillWatch = {
        filledStart: watch.filledStart,
        windowStart: watch.windowEnd,
        windowEnd: Math.min(
          watch.windowEnd + context.segmentLengthSeconds,
          watch.holeEnd,
        ),
        holeEnd: watch.holeEnd,
      };
    }
  } finally {
    context.fillInFlight = false;
  }
}

/**
 * Stores the lesson title the page bridge reported (#32). Unlike positions,
 * the title arrives on live pages too, and only the first message counts:
 * the startup report fixes the title for the whole Session, so the pagehide
 * re-report and SPA renames never overwrite it. The pointer is persisted
 * before the state event, so a worker dying in between still rebuilds with
 * the title (the meta then falls back from context.pageTitle to
 * state.title).
 */
async function handlePageTitle(message, sender) {
  // The bridge's real document title is also the collect path's preferred
  // title (P8): record it session-less, latest report wins, then let the
  // session-scoped logic below keep its first-report-wins rule.
  recordBridgePageTitle(sender, message);
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  if (sender.tab?.id !== context.tabId) return;
  const title = typeof message.title === "string" ? message.title.trim() : "";
  if (!title || context.pageTitle) return;
  context.pageTitle = title;
  await persistContextPointer(context);
  context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
    type: "titleCaptured",
    title,
  });
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(
    chrome.storage.local,
    context.state,
  );
}

async function handleBackstopChunk(message) {
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  context.pendingChunks.push({ dataUrl: message.dataUrl, durationSeconds: message.durationSeconds, mimeType: message.mimeType });
  // Keep the position stream moving even if the live tick was suspended.
  // Wallclock Sessions only (#48): an anchored Session's timeline is the
  // video position — wall-clock elapsed must never feed it.
  if (context.timestampKind === "wallclock") {
    feedPosition(context, (Date.now() - context.startedAtMs) / 1000);
  }
}

/**
 * The offscreen recorder's one-shot death notice: the capture stream went
 * inactive (course tab closed or navigated away) and no further recording
 * is possible. Auto-end the Session honestly — the digest is produced from
 * whatever Transcript exists (the noTranscript skip covers the empty case)
 * — instead of zombie-ing as "active" with a dead stream. The notice
 * broadcast goes out first so the panel learns the reason immediately;
 * the ended state and report follow in endActiveSession's own broadcast.
 * A repeated notice finds the context ended (or the pointer cleared) and
 * is a no-op.
 */
async function handleCaptureEnded(message, _sender) {
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  const reason =
    typeof message?.reason === "string" && message.reason
      ? message.reason
      : "unknown reason";
  console.error("[Learning Digest] capture stream ended, auto-ending session:", reason);
  broadcastSession(context.state, {
    captureNotice: "音频采集已中断（标签页已关闭或已离开课程页），会话自动结束。",
  });
  await endActiveSession(context, { reason: "captureEnded" });
}

/**
 * The realtime client's one-shot give-up notice: every reconnect backoff
 * attempt failed, the offscreen document already released the WebSocket and
 * the capture, and no further transcription is possible this Session.
 * Handled like captureEnded — loud log, notice broadcast first, honest
 * auto-end — so the learner keeps the transcript collected so far and the
 * digest built from it, instead of a zombie Session with a dead stream.
 * A repeated notice finds the context ended (or the pointer cleared) and
 * is a no-op.
 */
async function handleRealtimeGaveUp(_message) {
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  console.error(
    "[Learning Digest] realtime WebSocket gave up after repeated reconnect failures, auto-ending session",
  );
  broadcastSession(context.state, {
    realtimeNotice: { message: "实时转写连接失败，会话自动结束。" },
  });
  await endActiveSession(context, { reason: "realtimeGaveUp" });
}

// ============================================================
// REALTIME TRANSCRIPTION PIPELINE (#46 offscreen client, #47 handling)
// ============================================================
//
// The offscreen document owns the realtime WebSocket and streams the
// server's findings as unsolicited messages. The worker turns them into
// pipeline activity: a partial is a lightweight panel-only broadcast (the
// panel owns the draft display), a finalized utterance feeds the state
// machine as an utteranceCaptured event — a plain Transcript record, no
// Segment, failed: true for a failed utterance so it lands as the segment
// path's failure-marker record — an error surfaces loudly, and a final
// give-up (every reconnect attempt failed) auto-ends the Session honestly
// like captureEnded does. Topic ticks run on the same content thresholds
// as segment mode: isTopicTickDue reads transcriptRecords coverage, which
// utterance records grow like any other, and a check runs right after each
// utterance (the 60s summary timer stays armed as the backstop). Without
// an active capture the events are dropped: the offscreen document cannot
// outlive its Session.

async function handleRealtimePartial(message) {
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  // Lightweight and state-free on purpose: partials stream at speaking
  // pace, and the full state would ship the whole Transcript every time.
  // The panel replaces its draft with this text; no state churn here.
  try {
    chrome.runtime
      .sendMessage({
        action: "sessionUpdate",
        sessionId: context.sessionId,
        realtimePartial: { text: String(message?.text || "") },
      })
      .catch(() => {});
  } catch (_error) {
    // Side panel closed; the next state broadcast re-syncs it.
  }
}

/**
 * The Session-timeline start second for one finalized realtime utterance
 * (#49): a wallclock Session keeps the offscreen stream time as today; a
 * video-kind Session (replay/course, or a live Session that anchored via
 * the #48 probe) stamps at the VIDEO position the speech belongs to. The
 * utterance finalizes ~0.4s after its speech ended, so the last bridged
 * video position minus the utterance duration approximates where the
 * speech began. Clamped to ≥ 0 and ≥ the segmenter cursor — the anchor or
 * seek target — so a record never lands before the Session's video
 * timeline begins (the cursor only moves there via #48's anchor/seek).
 * Before the first bridged report there is no position to read and the
 * stream time stands in: a ≤1s window at Session start, stamped
 * approximately (a D7-class corner, accepted).
 *
 * @param {object} context - the active capture context
 * @param {{start?: number, duration?: number}} message - the offscreen event
 * @returns {number} the record's start second (NaN passes through: the
 *   pipeline drops a record without a finite start, as before)
 */
function mapUtteranceStart(context, message) {
  const start = Number(message?.start);
  if (context.timestampKind !== "video") return start;
  // Absolute video time = the recognition session's origin (re-based on
  // every drag, #50) plus the utterance's offset inside that session. The
  // old "last bridged position minus duration" heuristic smeared stamps
  // across seeks; the origin makes every stamp tied to the session that
  // heard the audio.
  const origin = Number(context.realtimeOriginSeconds) || 0;
  return Math.max(origin, origin + (Number.isFinite(start) ? start : 0));
}

/**
 * Realtime drag handling (#50), the video-timeline twin of the segment
 * path's seek/re-listen logic: every drag closes the open playback window
 * at the pre-drag position and re-bases recognition at the landing point.
 * A forward drag marks the skipped range; a backward drag consults the
 * timeline view — landing on covered audio (success records or silent
 * playback windows alike) enters a hold that suppresses forwarding until
 * playback reaches the next capture point, while landing on a hole or
 * failure captures from the landing point and shrinks the hole's tail the
 * new session will actually cover. Wallclock Sessions never get here (the
 * caller gates on timestampKind).
 *
 * @param {object} context - the active capture context
 * @param {number} position - the bridged position
 */
async function handleRealtimeDrag(context, position) {
  if (!context.seekBaselineArmed) {
    // The first bridged position arms detection and is never itself a
    // drag. A non-zero start position (mid-video open) re-bases recognition
    // there so utterance offsets count from the real position.
    context.seekBaselineArmed = true;
    openPlaybackWindow(context, position);
    if (position - context.realtimeOriginSeconds > FORWARD_DRAG_THRESHOLD_SECONDS) {
      await rebaseRealtimeCapture(context, position, false);
      await persistContextPointer(context);
    }
    return;
  }
  const previous = context.lastPosition;
  const forwardDrag =
    Number.isFinite(previous) &&
    position - previous > FORWARD_DRAG_THRESHOLD_SECONDS;
  const backwardDrag = Number.isFinite(previous) && position < previous;

  // Hold bookkeeping runs before drag handling: advancing onto the resume
  // point ends the hold; a drag supersedes it either way.
  if (context.realtimeHoldUntilSeconds !== null && !forwardDrag && !backwardDrag) {
    extendPlaybackWindow(context, position);
    if (position >= context.realtimeHoldUntilSeconds) {
      const resumeAt = context.realtimeHoldUntilSeconds;
      context.realtimeHoldUntilSeconds = null;
      context.realtimeOriginSeconds = resumeAt;
      await sendOffscreen({ action: "captureRealtimeResume", originSeconds: resumeAt });
      await persistContextPointer(context);
    }
    return;
  }

  if (!forwardDrag && !backwardDrag) {
    extendPlaybackWindow(context, position);
    return;
  }

  // Any drag closes the open window at the pre-drag position and opens a
  // fresh one at the landing: everything played from here counts as captured
  // coverage (silent stretches included), however the landing is handled.
  closePlaybackWindow(context, Number.isFinite(previous) ? previous : position);
  context.realtimeHoldUntilSeconds = null;
  openPlaybackWindow(context, position);

  if (forwardDrag) {
    // The pointer is persisted BEFORE the gap marker lands: a worker death
    // mid-drag must never resume below the jumped position.
    context.segmenter.jumpTo(position);
    await persistContextPointer(context);
    if (position - previous > 0) {
      context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
        type: "gapSkipped",
        start: previous,
        duration: position - previous,
      });
      await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(
        chrome.storage.local,
        context.state,
      );
      broadcastSession(context.state);
    }
  }

  const view = YTD_SESSION_TIMELINE.buildTimelineView(
    context.state,
    context.playbackWindows,
  );
  const captureFrom = YTD_SESSION_TIMELINE.nextCaptureStart(view, position);
  if (captureFrom > position) {
    // Landing on covered audio: hold — no audio is forwarded (no duplicate
    // recognition, no double billing) until playback reaches the resume
    // point.
    context.realtimeHoldUntilSeconds = captureFrom;
    await rebaseRealtimeCapture(context, position, true);
    await persistContextPointer(context);
    return;
  }
  // Capture from the landing point. Backward into a hole: its tail is about
  // to be covered by the new session, so shrink the marker now; a later
  // drag away from the hole re-marks what actually stays unwatched.
  if (backwardDrag && YTD_SESSION_TIMELINE.isCoveredAt(view, position) === false) {
    await shrinkHoleTail(context, position);
  }
  await rebaseRealtimeCapture(context, position, false);
  await persistContextPointer(context);
}

/**
 * Applies gapFilled for the part of the covering gapSkipped marker that
 * starts at the landing position: the new recognition session covers
 * [position, markerEnd) live, so the marker keeps only its unwatched head.
 * No-op when no marker covers the position.
 */
async function shrinkHoleTail(context, position) {
  const marker = context.state.transcriptRecords.find(
    (record) =>
      YTD_SESSION_PIPELINE.isGapSkippedRecord(record) &&
      position >= record.start &&
      position < record.start + record.duration,
  );
  if (!marker) return;
  const markerEnd = marker.start + marker.duration;
  context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
    type: "gapFilled",
    filledStart: position,
    filledEnd: markerEnd,
  });
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(
    chrome.storage.local,
    context.state,
  );
  broadcastSession(context.state);
}

/**
 * Re-bases the realtime recognition session at the landing point (#50):
 * the offscreen document finishes the half-sentence on the old connection,
 * closes it, and opens a new one counting its utterance offsets from
 * `originSeconds` (held, when asked, so covered re-watches are not
 * forwarded). The context origin only moves once the rebase lands.
 */
async function rebaseRealtimeCapture(context, originSeconds, hold) {
  const result = await sendOffscreen({
    action: "captureRebase",
    originSeconds,
    hold: hold === true,
  });
  if (result && result.error) {
    // #50 error handling: keep the transcript, surface the failure, and do
    // not move the origin — no plausible-looking stamps from an unknown
    // base. The session keeps running; the next drag retries the rebase.
    console.error(
      "[Learning Digest] realtime rebase failed:",
      result.error,
    );
    return;
  }
  context.realtimeOriginSeconds = originSeconds;
}

function openPlaybackWindow(context, position) {
  context.playbackWindowStart = position;
}

function extendPlaybackWindow(context, position) {
  if (context.playbackWindowStart === null) {
    context.playbackWindowStart = position;
  }
}

function closePlaybackWindow(context, end) {
  if (context.playbackWindowStart === null) return;
  const start = context.playbackWindowStart;
  context.playbackWindowStart = null;
  if (end > start) {
    context.playbackWindows.push({ start, end });
  }
}

async function handleRealtimeUtterance(message) {
  const context = await ensureCaptureResumed();
  // A trailing utterance after the Session ended is dropped: the offscreen
  // client finishes its session.finish handshake after the end broadcast.
  if (!context || context.ended) {
    debugLog("[Learning Digest BG] realtimeUtterance dropped: no active Session");
    return;
  }
  // #50: utterances carry the origin of the recognition session that heard
  // them; a frame from a superseded (pre-rebase) connection stamps against
  // an origin the context no longer has and is dropped. Frames without the
  // field predate the rebase protocol and are accepted as-is.
  if (
    message?.originSeconds !== undefined &&
    Number(message.originSeconds) !== Number(context.realtimeOriginSeconds)
  ) {
    debugLog(
      "[Learning Digest BG] stale realtimeUtterance dropped:",
      message.originSeconds,
      "!== current origin",
      context.realtimeOriginSeconds,
    );
    return;
  }
  const next = YTD_SESSION_PIPELINE.applyEvent(context.state, {
    type: "utteranceCaptured",
    text: message?.text,
    start: mapUtteranceStart(context, message),
    duration: message?.duration,
    failed: message?.failed === true,
  });
  // An invalid payload is a pipeline no-op: nothing to persist or broadcast.
  if (next === context.state) return;
  context.state = next;
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
  broadcastSession(context.state);
  // Same content thresholds as segment mode: the record may have completed
  // the coverage the tick was waiting for.
  await maybeRunTopicTick(context);
}

async function handleRealtimeError(message) {
  // Loud regardless of Session state: a realtime failure is otherwise only
  // visible as a silently dead transcript stream.
  console.error(
    "[Learning Digest] realtime transcription error:",
    message?.message || "(no reason given)",
  );
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  broadcastSession(context.state, {
    realtimeNotice: { message: String(message?.message || "实时转写出现错误") },
  });
}

// The router's dispatch map for the offscreen realtime events: unsolicited,
// fire-and-forget. Connection-level failures alert (realtimeError); a final
// give-up auto-ends the Session (realtimeGaveUp).
const REALTIME_EVENT_HANDLERS = {
  realtimePartial: handleRealtimePartial,
  realtimeUtterance: handleRealtimeUtterance,
  realtimeError: handleRealtimeError,
  realtimeGaveUp: handleRealtimeGaveUp,
};

async function endActiveSession(context, { reason, report = true } = {}) {
  if (context.ended) return { success: true, reason, state: context.state };
  context.ended = true;
  if (context.liveTimer) clearInterval(context.liveTimer);
  if (context.summaryTimer) clearInterval(context.summaryTimer);
  // P10 (decision 4): the final progress write of the latest position (the
  // flush is bounded — throttle-bypassing cycles never wait on the network),
  // the writer stops, and the course tab list unlocks.
  await releaseLearningTarget(context);

  const finalPosition =
    context.timestampKind === "wallclock"
      ? (Date.now() - context.startedAtMs) / 1000
      : context.lastPosition;
  // Realtime Sessions (#47) have no Segments to flush: their Transcript is
  // already complete (every finalized utterance landed as a record).
  const tail =
    context.transcribeMode === "realtime"
      ? null
      : context.segmenter.flush(finalPosition);
  if (tail) await dispatchSegment(context, tail);

  context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, { type: "sessionEnd" });
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
  await clearContextPointer();
  // The retry action targets "the most recent ended Session"; remember it
  // for the live-worker fast path (storage scan is the durable fallback).
  lastEndedSessionId = context.state.sessionId;

  // Both end paths (explicit action and media-end auto-stop) run the global
  // pass from the ended state. A failed or truncated pass never blocks
  // ending: the panel gets the retry error instead of the artifact.
  // Artifact meta (#30): the ending capture context is the only place kind,
  // platform and the wall-clock range are all known at once. The title
  // (#32) prefers the capture context's pageTitle and falls back to the
  // snapshot's, so a resumed Session still names the lesson; absent means
  // the renderers fall back to their default header title.
  //
  // report: false (the 0.1.57 course-switch auto-end) skips the AI pass: the
  // stale lesson's digest is not worth the tokens or the wait, the snapshot
  // is ended and durable, and the panel's 开始总结 retry can still run the
  // pass later (resolveReportTargetSessionId scans ended snapshots).
  let reportPayload = null;
  if (report) {
    const reportMeta = {
      startedAtMs: context.startedAtMs,
      endedAtMs: Date.now(),
      kind: context.kind,
      platformId: context.platformId,
    };
    const reportTitle = context.pageTitle || context.state.title;
    if (reportTitle) reportMeta.title = reportTitle;
    reportPayload = (
      await produceSessionReport(context.state, reportMeta)
    ).report;
    broadcastSession(context.state, { report: reportPayload });
  } else {
    broadcastSession(context.state);
  }

  await sendOffscreen({ action: "captureStop" });
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
  if (captureContext?.sessionId === context.sessionId) captureContext = null;
  return { success: true, reason, state: context.state, report: reportPayload };
}

async function handleEndLearning() {
  const context = await ensureCaptureResumed();
  if (!context) return { success: false, error: "No active learning Session." };
  return endActiveSession(context, { reason: "explicit" });
}

/**
 * The start wall-clock ms encoded in a Session id (`s_<base36 start
 * ms>_<random>`), or 0 when the id carries none (test doubles, hand-made
 * ids). Both resolveReportTargetSessionId (largest start = most recent end)
 * and reconstructReportMeta (the retry's meta timestamps) read this.
 *
 * @param {string} sessionId
 * @returns {number}
 */
function parseSessionId(sessionId) {
  return (
    parseInt(String(sessionId || "").replace(/^s_/, "").split("_")[0], 36) || 0
  );
}

/**
 * Resolves which ended Session the retry action should re-run. Priority:
 * an explicit sessionId from the panel, then the last Session this worker
 * ended, then the most recent ended snapshot in storage (the durable path
 * that survives a service-worker restart between end and retry).
 *
 * @param {{sessionId?: string}} message
 * @returns {Promise<string|null>}
 */
async function resolveReportTargetSessionId(message) {
  const candidates = [];
  if (typeof message?.sessionId === "string" && message.sessionId) {
    candidates.push(message.sessionId);
  }
  if (lastEndedSessionId) candidates.push(lastEndedSessionId);
  for (const sessionId of candidates) {
    const snapshot = await YTD_SESSION_PERSISTENCE.loadSessionSnapshot(
      chrome.storage.local,
      sessionId,
    );
    if (snapshot) return sessionId;
  }
  // Scan every persisted snapshot for the ended Session that started last.
  // Session ids are `s_<base36 start ms>_<random>`, and only one capture
  // runs at a time, so the largest start timestamp is the most recent end.
  const all = await chrome.storage.local.get(null);
  let best = null;
  let bestStart = -1;
  for (const [key, value] of Object.entries(all || {})) {
    if (!key.startsWith("ytd_session_") || value?.status !== "ended") continue;
    const start = parseSessionId(value.sessionId);
    if (start > bestStart) {
      bestStart = start;
      best = value.sessionId;
    }
  }
  return best;
}

/**
 * Rebuilds artifact meta for a retry that has no prior artifact to copy it
 * from: the Session id encodes the start (s_<base36 start ms>_<random>, the
 * same encoding resolveReportTargetSessionId relies on) and the Transcript's
 * last record estimates the wall-clock end. kind/platformId are not stored
 * with the snapshot, so they stay absent and the renderers omit those parts
 * of the meta line.
 *
 * @param {string} sessionId
 * @param {object} state - Session state rebuilt from the snapshot
 * @returns {{startedAtMs: number, endedAtMs: number}}
 */
function reconstructReportMeta(sessionId, state) {
  const parsed = parseSessionId(sessionId);
  // Session ids carry a real start timestamp; anything else (test doubles,
  // hand-made ids) parses to an implausible value and falls back to now.
  const startedAtMs =
    Number.isFinite(parsed) && parsed > 0 && parsed <= Date.now()
      ? parsed
      : Date.now();
  const contentEndSeconds = (state?.transcriptRecords || []).reduce(
    (end, record) =>
      Math.max(
        end,
        (Number(record?.start) || 0) + (Number(record?.duration) || 0),
      ),
    0,
  );
  const meta = {
    startedAtMs,
    endedAtMs: startedAtMs + Math.round(contentEndSeconds * 1000),
  };
  // The snapshot kept the page title (#32) through the failed first pass.
  if (state?.title) meta.title = state.title;
  return meta;
}

/**
 * The regenerateReport message action: re-runs the end-of-session global
 * pass for the most recent ended Session (or the one the panel names),
 * persists a successful artifact and broadcasts it again. Used when the
 * original pass was truncated or failed.
 *
 * @param {{sessionId?: string}} [message]
 * @returns {Promise<{success: boolean, sessionId?: string, report?: object, error?: string}>}
 */
async function handleRegenerateReport(message) {
  const sessionId = await resolveReportTargetSessionId(message);
  if (!sessionId) {
    return { success: false, error: "没有可重新生成的已结束会话。" };
  }
  const snapshot = await YTD_SESSION_PERSISTENCE.loadSessionSnapshot(
    chrome.storage.local,
    sessionId,
  );
  if (!snapshot) {
    return { success: false, error: "找不到该会话的逐字稿，无法重新生成。" };
  }
  const state = YTD_SESSION_PIPELINE.resumeFromSnapshot(snapshot);
  // Meta (#30): a prior artifact's meta is the true one; a retry after a
  // failed pass (nothing persisted) reconstructs the best available.
  const storageKey = `${YTD_REPORT_RENDER.REPORT_STORAGE_KEY_PREFIX}${sessionId}`;
  const stored = await chrome.storage.local.get(storageKey);
  const meta =
    stored?.[storageKey]?.meta ||
    reconstructReportMeta(sessionId, state);
  const { report } = await produceSessionReport(state, meta);
  broadcastSession(state, { report });
  return { success: true, sessionId, report };
}

async function handleGetSessionState() {
  const context = await ensureCaptureResumed();
  if (!context) return { active: false, state: null };
  return {
    active: true,
    sessionId: context.sessionId,
    kind: context.kind,
    timestampKind: context.timestampKind,
    transcribeMode: context.transcribeMode,
    startedAtMs: context.startedAtMs,
    state: context.state,
  };
}

/**
 * Removes one ended Session's persisted state — snapshot plus the
 * `report_<sessionId>` artifact — so its transcript and 纪要 stop surfacing
 * (the panel's 清除记录 button). The report artifact must go with the
 * snapshot: without it the D7 startup scan would re-adopt the report and
 * repopulate the panel on the next open.
 *
 * The ACTIVE Session is refused: the learner ends that one with 结束学习
 * first, so an accidental click can never tear down a running capture.
 */
async function handleClearSessionRecord(message) {
  const sessionId =
    typeof message?.sessionId === "string" ? message.sessionId : "";
  if (!sessionId) return { success: false, error: "sessionId is required" };
  const context = await ensureCaptureResumed();
  if (context?.sessionId === sessionId) {
    return { success: false, error: "SESSION_ACTIVE" };
  }
  await YTD_SESSION_PERSISTENCE.deleteSessionSnapshot(
    chrome.storage.local,
    sessionId,
  );
  await chrome.storage.local.remove(`report_${sessionId}`);
  if (lastEndedSessionId === sessionId) lastEndedSessionId = null;
  return { success: true };
}
