/**
 * Site-capability flow (ticket 6.3, issue #88): the worker orchestration of
 * the capability layer, in the plugin-bili-captions-flow harness pattern.
 *
 * - Panel startup (getCourseTabs) refreshes the capability table
 *   (GET /v1/site-capabilities, Bearer — contract-r4 §3.1's
 *   { capabilities: [...] } body, ticket 6.1's endpoint), cached with a
 *   TTL;
 * - 开始学习 refuses a server-disabled site with 「站点未开放学习」 and
 *   never opens a Session; 收藏 is untouched (任何网页可收藏);
 * - the captions path decision is data-driven: the server switch AND the
 *   adapter's reader declaration — captions=false skips the probe entirely
 *   and hands the start straight to the ASR pipeline (先站点开关，再选轨
 *   策略: the 5.3 only_auto_generated short-circuit lives inside the
 *   reader and stays untouched);
 * - a capability fetch failure serves the built-in default table (the
 *   bilibili/youtube captions path keeps working offline);
 * - a 401 on the capability fetch is a definitive dead credential: the P7
 *   linked-logout path re-gates the panel and the start fails honestly.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

const BILI_P2 = "https://www.bilibili.com/video/BV1ab411L78c?p=2";
const XIAOE_LESSON = "https://app12345.xiaoe-tech.com/v_5f0abc123";

const CREDENTIAL_STORE = {
  ytd_auth_credential: { token: "ext-token", credentialGroupId: "grp_1", email: "l@e.com" },
};

const RESOLVED_SOURCE = {
  id: "src_01JABC0002",
  resourceId: "res_01JABC0001",
  kind: "video",
  url: BILI_P2,
  platformId: "bilibili",
  platformVideoId: "BV1ab411L78c",
  episodeId: "2",
  platformScopeId: null,
  progress: null,
};
const RESOLVE_MATCHED_BODY = {
  matched: true,
  resource: {
    id: "res_01JABC0001",
    title: "注意力机制详解 P2：自注意力",
    kind: "video",
    createdAt: "2026-11-10T08:00:00Z",
  },
  source: RESOLVED_SOURCE,
};
const SESSION_CREATED_BODY = {
  id: "ses_01JABC0033",
  sourceId: "src_01JABC0002",
  resourceId: "res_01JABC0001",
  status: "active",
  startedAt: "2026-11-10T09:00:00Z",
  finishedAt: null,
  origin: null,
};
const COLLECT_CREATED_BODY = {
  resource: RESOLVE_MATCHED_BODY.resource,
  source: { ...RESOLVED_SOURCE, progress: null },
};

function baseSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.example.com/ai",
    aiModel: "test-model",
    apiBaseUrl: "https://api.example.com",
    segmentLengthSeconds: 60,
    summaryIntervalMinutes: 30,
    ...overrides,
  };
}

/** The bridge answers a captions-available bilibili page (and a disabled one). */
function captionsTabMessage() {
  return (message) => {
    if (message.action === "getBilibiliCaptions") {
      return {
        success: true,
        available: true,
        segments: [{ startMs: 10000, endMs: 40000, text: "欢迎来到本节课。" }],
        track: { lan: "zh-CN", ai: false },
      };
    }
    return { success: true };
  };
}

/**
 * One fetch seam for the whole capability flow, recorded per /v1 call. The
 * site-capabilities route scripts the 6.1 contract shape
 * [{platformId, captions, asr, enabled}]; every other route falls through
 * to the collections the callers script.
 */
function v1Fetch({ capabilities = [], resolve = [], resources = [], sessions = [] } = {}) {
  const v1Calls = [];
  let resolveIndex = 0;
  let resourcesIndex = 0;
  let sessionsIndex = 0;
  const fetchImpl = async (url, init) => {
    const pathName = String(url).replace(/^https:\/\/api\.example\.com/, "");
    if (pathName === "/v1/site-capabilities") {
      v1Calls.push({ path: pathName, method: init.method, auth: init.headers.Authorization });
      if (capabilities.length === 0) {
        // No rows scripted: the default fallback drives the verdict shape.
        return { status: 503, ok: false, json: async () => null };
      }
      const scripted = capabilities.shift();
      return {
        status: scripted.status,
        ok: scripted.status < 400,
        json: async () => scripted.body,
      };
    }
    if (pathName === "/v1/sources/resolve") {
      v1Calls.push({ path: pathName, method: init.method });
      const scripted = resolve[resolveIndex++] ?? resolve[resolve.length - 1];
      return { status: 200, ok: true, json: async () => scripted };
    }
    if (pathName === "/v1/resources") {
      v1Calls.push({ path: pathName, method: init.method });
      const scripted = resources[resourcesIndex++] ?? resources[resources.length - 1];
      return { status: 201, ok: true, json: async () => scripted };
    }
    if (/^\/v1\/sources\/[^/]+\/sessions$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method });
      const scripted = sessions[sessionsIndex++] ?? sessions[sessions.length - 1];
      return { status: 201, ok: true, json: async () => ({ session: scripted }) };
    }
    if (/^\/v1\/sessions\/[^/]+\/captions$/.test(pathName)) {
      v1Calls.push({ path: pathName, method: init.method });
      return {
        status: 201,
        ok: true,
        json: async () => ({
          transcript: {
            sessionId: SESSION_CREATED_BODY.id,
            sourceId: "src_01JABC0002",
            resourceId: "res_01JABC0001",
            sessionStatus: "active",
            origin: "captions",
            records: [],
            gaps: [],
            pending: [],
            failed: [],
          },
        }),
      };
    }
    return { status: 200, ok: true, json: async () => ({}) };
  };
  return { v1Calls, fetchImpl };
}

const capabilityFlowHelpers = ({ fetchImpl, tabMessageImpl, ...rest } = {}) =>
  loadBackgroundHelpers({
    settings: baseSettings(),
    stored: CREDENTIAL_STORE,
    tabsGet: async (tabId) => ({
      id: tabId,
      url: String(tabId) === "7" ? XIAOE_LESSON : BILI_P2,
      title: "课程页",
    }),
    fetchImpl,
    tabMessageImpl: tabMessageImpl || captionsTabMessage(),
    sendMessageImpl: (message) =>
      message.action === "captureCut"
        ? { dataUrl: "data:audio/webm;base64,SGk=", mimeType: "audio/webm", durationSeconds: 60 }
        : { success: true },
    ...rest,
  });

// --- panel startup refresh -----------------------------------------------------

test("panel startup (getCourseTabs) refreshes the capability table with the linked Bearer token", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    capabilities: [
      { status: 200, body: { capabilities: [{ platformId: "bilibili", captions: true, asr: true, enabled: true }] } },
    ],
  });
  const helpers = capabilityFlowHelpers({ fetchImpl });

  const result = await helpers.handleGetCourseTabs();
  assert.equal(result.ok, true, "the list renders regardless of the capability fetch");
  // The refresh is fire-and-forget: give its microtasks the chance to reach
  // the fetch seam before the assertions read the recorded calls.
  await new Promise((resolve) => setImmediate(resolve));

  const capabilityCall = v1Calls.find((call) => call.path === "/v1/site-capabilities");
  assert.ok(capabilityCall, "GET /v1/site-capabilities went out at panel startup");
  assert.equal(capabilityCall.method, "GET");
  assert.equal(capabilityCall.auth, "Bearer ext-token");
});

// --- start gating ----------------------------------------------------------------

test("开始学习 on a server-disabled site is refused with 「站点未开放学习」 and creates no Session", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    capabilities: [
      {
        status: 200,
        body: { capabilities: [{ platformId: "xiaoe", captions: false, asr: true, enabled: false }] },
      },
    ],
    resolve: [RESOLVE_MATCHED_BODY],
  });
  const helpers = capabilityFlowHelpers({ fetchImpl, tabMessageImpl: () => ({ success: true }) });

  const started = await helpers.handleStartLearning({ url: XIAOE_LESSON, tabId: 7 });

  assert.equal(started.success, false);
  assert.equal(started.siteDisabled, true, "the panel can tell the gating refusal apart");
  assert.equal(started.error, "站点未开放学习");
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/sessions")),
    false,
    "no server Session on a disabled site",
  );
  assert.equal(helpers.readStored("ytd_active_capture"), undefined, "nothing is left running");
});

test("collecting a server-disabled site still works (收藏不受影响)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    capabilities: [
      {
        status: 200,
        body: { capabilities: [{ platformId: "xiaoe", captions: false, asr: true, enabled: false }] },
      },
    ],
    resources: [COLLECT_CREATED_BODY],
  });
  const helpers = capabilityFlowHelpers({ fetchImpl, tabMessageImpl: () => ({ success: true }) });

  const collected = await helpers.handleCollectLearningTarget({ tabId: 7 });

  assert.equal(collected.ok, true, collected.message || "");
  assert.equal(
    v1Calls.some((call) => call.path === "/v1/resources"),
    true,
    "the collect POST is untouched by gating",
  );
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/sessions")),
    false,
    "gating still blocks the start, only the favorite went out",
  );
});

test("chooseLearningTarget reports the disabled site so the panel can disable 开始学习", async () => {
  const { fetchImpl } = v1Fetch({
    capabilities: [
      {
        status: 200,
        body: { capabilities: [{ platformId: "xiaoe", captions: false, asr: true, enabled: false }] },
      },
    ],
    resolve: [RESOLVE_MATCHED_BODY],
  });
  const helpers = capabilityFlowHelpers({ fetchImpl, tabMessageImpl: () => ({ success: true }) });

  const disabled = await helpers.handleChooseLearningTarget({ tabId: 7 });
  assert.equal(disabled.ok, true, "the choice itself succeeds — 收藏 must stay available");
  assert.equal(disabled.startable, false);
  assert.equal(disabled.siteDisabled, true);

  const enabled = await helpers.handleChooseLearningTarget({ tabId: 2 });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.startable, true);
  assert.equal(enabled.siteDisabled, false);
});

// --- the data-driven captions path decision ----------------------------------------

test("server captions=false on bilibili skips the captions probe and hands the start straight to ASR", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    capabilities: [
      {
        status: 200,
        body: { capabilities: [{ platformId: "bilibili", captions: false, asr: true, enabled: true }] },
      },
    ],
    resolve: [RESOLVE_MATCHED_BODY],
    sessions: [SESSION_CREATED_BODY],
  });
  const tabMessages = [];
  const helpers = capabilityFlowHelpers({ fetchImpl, tabMessages });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true, started.error || "");

  assert.deepEqual(
    tabMessages.filter((message) => message.action === "getBilibiliCaptions"),
    [],
    "the captions probe never runs when the site switch is off",
  );
  const pointer = helpers.readStored("ytd_active_capture");
  assert.equal(pointer.capturePath, "asr", "the start went straight to the ASR pipeline");
  const snapshot = helpers.readStored(`ytd_session_${pointer.sessionId}`);
  assert.deepEqual(snapshot.captionsProbe, {
    available: false,
    reason: "captions_disabled_by_site",
  });
  assert.equal(
    v1Calls.some((call) => call.path.endsWith("/captions")),
    false,
    "no captions archive on the switched-off site",
  );

  await helpers.handleEndLearning();
});

test("server captions=true on bilibili keeps the captions path (site switch first, track policy second)", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    capabilities: [
      {
        status: 200,
        body: { capabilities: [{ platformId: "bilibili", captions: true, asr: true, enabled: true }] },
      },
    ],
    resolve: [RESOLVE_MATCHED_BODY],
    sessions: [SESSION_CREATED_BODY],
  });
  const helpers = capabilityFlowHelpers({ fetchImpl });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true, started.error || "");
  assert.equal(started.capturePath, "captions", "the captions path stays the default");

  await helpers.handleEndLearning();
});

// --- the fallback and the P7 path ----------------------------------------------------

test("a capability fetch failure serves the built-in default table: bilibili keeps probing captions", async () => {
  const { v1Calls, fetchImpl } = v1Fetch({
    capabilities: [], // every refresh answers 503 → the default table
    resolve: [RESOLVE_MATCHED_BODY],
    sessions: [SESSION_CREATED_BODY],
  });
  const helpers = capabilityFlowHelpers({ fetchImpl });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });
  assert.equal(started.success, true, started.error || "");
  assert.equal(started.capturePath, "captions", "the default table keeps bilibili on captions");

  await helpers.handleEndLearning();
});

test("a 401 on the capability fetch routes P7: the panel re-gates and the start refuses", async () => {
  const { fetchImpl } = v1Fetch({
    capabilities: [{ status: 401, body: { error: { code: "unauthorized", message: "凭据已失效" } } }],
  });
  const sentMessages = [];
  const helpers = capabilityFlowHelpers({ fetchImpl, sentMessages });

  const started = await helpers.handleStartLearning({ url: BILI_P2, tabId: 2 });

  assert.equal(started.success, false, "a dead credential cannot start a Session");
  assert.match(started.error, /授权已失效/);
  const authState = sentMessages.find(
    (message) => message.action === "authState" && message.authorized === false,
  );
  assert.ok(authState, "the P7 re-gate reached the panel");
});
