const test = require("node:test");
const assert = require("node:assert/strict");

// Ticket 6.3 (issue #88): the extension's site-capability layer. The pure
// module (site-capabilities.js) owns the built-in default table, the
// GET /v1/site-capabilities response parsing (the 6.1 contract shape:
// [{platformId, captions, asr, enabled}]), the merge of server rows over the
// defaults, and the cached capability store with the failure fallback.
// The registry seam (adapter captionsReader declarations) and the start
// gating seam (learning-start.js) ride the same file: together they are the
// gating data source — 能力表 ∪ 适配器自身声明.

const YTD_SITE_CAPABILITIES = require("../site-capabilities.js");
const YTD_SOURCE_PLATFORMS = require("../source-platforms.js");

// ============================================================
// BUILT-IN DEFAULT TABLE (the failure/fallback capability source)
// ============================================================

test("default table: bilibili/youtube captions+asr+enabled, xiaoe/xiaohongshu asr-only", () => {
  const table = YTD_SITE_CAPABILITIES.DEFAULT_TABLE;
  assert.deepEqual(table.bilibili, { captions: true, asr: true, enabled: true });
  assert.deepEqual(table.youtube, { captions: true, asr: true, enabled: true });
  assert.deepEqual(table["xiaoe-tech"], { captions: false, asr: true, enabled: true });
  assert.deepEqual(table.xiaohongshu, { captions: false, asr: true, enabled: true });
});

test("default row for unknown platforms: asr-only, enabled (never disables an unlisted site)", () => {
  const row = YTD_SITE_CAPABILITIES.capabilityFor(
    YTD_SITE_CAPABILITIES.DEFAULT_TABLE,
    "some-future-platform",
  );
  assert.deepEqual(row, { captions: false, asr: true, enabled: true });
  // Garbage platform ids read as unknown, never throw.
  assert.deepEqual(
    YTD_SITE_CAPABILITIES.capabilityFor(YTD_SITE_CAPABILITIES.DEFAULT_TABLE, null),
    YTD_SITE_CAPABILITIES.capabilityFor(YTD_SITE_CAPABILITIES.DEFAULT_TABLE, ""),
  );
});

test("capabilityFor returns the table's own row for a known platform", () => {
  assert.equal(
    YTD_SITE_CAPABILITIES.capabilityFor(YTD_SITE_CAPABILITIES.DEFAULT_TABLE, "bilibili")
      .captions,
    true,
  );
});

// ============================================================
// API URL (api-client.js joining rule, GET /v1/site-capabilities)
// ============================================================

test("buildSiteCapabilitiesApiUrl joins the configured API origin with /v1/site-capabilities", () => {
  assert.equal(
    YTD_SITE_CAPABILITIES.buildSiteCapabilitiesApiUrl("https://api.example.com/"),
    "https://api.example.com/v1/site-capabilities",
  );
  assert.equal(
    YTD_SITE_CAPABILITIES.buildSiteCapabilitiesApiUrl("not a url"),
    null,
  );
});

// ============================================================
// GET /v1/site-capabilities RESPONSE PARSING (contract-r4 §3.1: the body
// is { capabilities: [...] } — api-site-capabilities-list is the authority)
// ============================================================

test("parseSiteCapabilitiesResponse: 200 with the full table → ok rows, malformed entries dropped", () => {
  const verdict = YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({
    status: 200,
    data: {
      capabilities: [
        { platformId: "bilibili", captions: false, asr: true, enabled: true },
        { platformId: "youtube", captions: true, asr: true, enabled: false },
        { platformId: "" }, // no usable platformId — dropped
        "garbage", // not an object — dropped
        null, // dropped
      ],
    },
  });
  assert.equal(verdict.kind, "ok");
  assert.deepEqual(verdict.rows, [
    { platformId: "bilibili", captions: false, asr: true, enabled: true },
    { platformId: "youtube", captions: true, asr: true, enabled: false },
  ]);
});

test("parseSiteCapabilitiesResponse: the registry's xiaoe row answers the extension's xiaoe-tech adapter", () => {
  // contract-r4 §2.1 seeds the row as platformId "xiaoe"; the extension's
  // Source Platform adapter id (and Source.platformId) is "xiaoe-tech".
  // The boundary alias keeps one canonical id inside the extension.
  const verdict = YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({
    status: 200,
    data: {
      capabilities: [{ platformId: "xiaoe", captions: false, asr: true, enabled: false }],
    },
  });
  assert.equal(verdict.kind, "ok");
  assert.deepEqual(verdict.rows[0], {
    platformId: "xiaoe-tech",
    captions: false,
    asr: true,
    enabled: false,
  });
});

test("parseSiteCapabilitiesResponse: missing flags default to the unknown-platform seed", () => {
  const verdict = YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({
    status: 200,
    data: { capabilities: [{ platformId: "bilibili" }] },
  });
  assert.equal(verdict.kind, "ok");
  assert.deepEqual(verdict.rows[0], {
    platformId: "bilibili",
    captions: false,
    asr: true,
    enabled: true,
  });
});

test("parseSiteCapabilitiesResponse: 401 → unauthorized (the P7 signal)", () => {
  const verdict = YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({
    status: 401,
    data: { error: { code: "unauthorized", message: "凭据已失效" } },
  });
  assert.equal(verdict.kind, "unauthorized");
});

test("parseSiteCapabilitiesResponse: non-wrapper 200 body, 5xx, network → error", () => {
  assert.equal(
    YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({ status: 200, data: { nope: true } })
      .kind,
    "error",
  );
  assert.equal(
    YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({
      status: 200,
      data: { capabilities: "garbage" },
    }).kind,
    "error",
  );
  // A bare array is NOT the contract shape (contract-r4 §3.1 wraps the
  // table) — it falls back to the defaults like any other malformed body.
  assert.equal(
    YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({ status: 200, data: [] }).kind,
    "error",
  );
  assert.equal(
    YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({ status: 500, data: null }).kind,
    "error",
  );
  assert.equal(
    YTD_SITE_CAPABILITIES.parseSiteCapabilitiesResponse({ network: true }).kind,
    "error",
  );
});

// ============================================================
// MERGE: server rows over the built-in defaults (pure, non-mutating)
// ============================================================

test("applyServerRows overrides the default table per platformId and keeps unknown rows", () => {
  const merged = YTD_SITE_CAPABILITIES.applyServerRows(
    [
      { platformId: "bilibili", captions: false, asr: true, enabled: true },
      { platformId: "future-platform", captions: false, asr: true, enabled: true },
    ],
    YTD_SITE_CAPABILITIES.DEFAULT_TABLE,
  );
  // Server switch wins where it speaks...
  assert.equal(merged.bilibili.captions, false);
  // ...and the defaults stand where it does not.
  assert.equal(merged.youtube.captions, true);
  assert.deepEqual(merged["xiaoe-tech"], { captions: false, asr: true, enabled: true });
  // A platform the client has no adapter for is kept — the table is the
  // server's registry view, unknown ids are harmless lookups.
  assert.deepEqual(
    merged["future-platform"],
    { platformId: "future-platform", captions: false, asr: true, enabled: true },
  );
});

test("applyServerRows never mutates the default table; enabled=false merges through", () => {
  const merged = YTD_SITE_CAPABILITIES.applyServerRows(
    [{ platformId: "youtube", captions: true, asr: true, enabled: false }],
    YTD_SITE_CAPABILITIES.DEFAULT_TABLE,
  );
  assert.equal(merged.youtube.enabled, false);
  assert.equal(YTD_SITE_CAPABILITIES.DEFAULT_TABLE.youtube.enabled, true);
  assert.deepEqual(
    YTD_SITE_CAPABILITIES.DEFAULT_TABLE.youtube,
    { captions: true, asr: true, enabled: true },
  );
});

test("applyServerRows with empty/null rows is exactly the default table", () => {
  const merged = YTD_SITE_CAPABILITIES.applyServerRows([], YTD_SITE_CAPABILITIES.DEFAULT_TABLE);
  assert.deepEqual(merged.bilibili, YTD_SITE_CAPABILITIES.DEFAULT_TABLE.bilibili);
  assert.deepEqual(
    YTD_SITE_CAPABILITIES.applyServerRows(null, YTD_SITE_CAPABILITIES.DEFAULT_TABLE).xiaohongshu,
    { captions: false, asr: true, enabled: true },
  );
});

// ============================================================
// THE CAPABILITY STORE: fetch + cache + fallback
// ============================================================
//
// The store is the seam the background wiring consumes: ensureFresh fetches
// GET /v1/site-capabilities when the cache is stale (or absent, or forced),
// a verdict other than ok falls back to the built-in default table, and
// captionsEnabledFor applies the adapter declaration AND
// (服务端开关 AND reader 可用). Fetch/clock/timers are injected so tests
// drive the schedule deterministically.

function okResponse(rows) {
  return { status: 200, json: async () => rows };
}

function makeStore(overrides = {}) {
  const requests = [];
  let responses = [];
  const store = YTD_SITE_CAPABILITIES.createCapabilityStore({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("no scripted response");
      if (next.network) throw new Error("network down");
      return next;
    },
    now: overrides.now || (() => 1_000_000),
    // The real adapter-declaration seam, the same one the worker wiring
    // passes (overridable via overrides for a narrower unit test).
    declaresCaptionsReader: YTD_SOURCE_PLATFORMS.captionsReaderFor,
    ...overrides,
    responses: undefined,
  });
  return {
    store,
    requests,
    script: (list) => {
      responses = list;
    },
  };
}

test("store before any fetch: the built-in default table serves every lookup", async () => {
  const { store, script } = makeStore();
  assert.equal(store.capabilityFor("bilibili").captions, true);
  assert.equal(store.capabilityFor("xiaoe-tech").captions, false);
  assert.equal(store.capabilityFor("unknown-platform").enabled, true);
  assert.equal(store.snapshot().hasServerRows, false);
});

test("store ensureFresh ok: server rows merge over the defaults, Bearer header rides the GET", async () => {
  const { store, requests, script } = makeStore();
  script([okResponse({ capabilities: [{ platformId: "bilibili", captions: false, asr: true, enabled: true }] })]);
  const verdict = await store.ensureFresh({
    apiBaseUrl: "https://api.example.com",
    token: "tok-123",
  });
  assert.equal(verdict.kind, "ok");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.example.com/v1/site-capabilities");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, "Bearer tok-123");
  assert.equal(store.capabilityFor("bilibili").captions, false);
  assert.equal(store.capabilityFor("youtube").captions, true);
  assert.equal(store.snapshot().hasServerRows, true);
});

test("store TTL: a fresh cache is not refetched; a stale one (or force) is", async () => {
  let now = 1_000_000;
  const { store, requests, script } = makeStore({ now: () => now });
  script([
    okResponse({ capabilities: [{ platformId: "bilibili", captions: false, asr: true, enabled: true }] }),
    okResponse({ capabilities: [{ platformId: "bilibili", captions: true, asr: true, enabled: true }] }),
  ]);
  await store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  // Within the TTL: no second request.
  now += YTD_SITE_CAPABILITIES.DEFAULT_TTL_MS - 1;
  await store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  assert.equal(requests.length, 1);
  assert.equal(store.capabilityFor("bilibili").captions, false);
  // TTL elapsed: the refresh happens.
  now += 1;
  await store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  assert.equal(requests.length, 2);
  assert.equal(store.capabilityFor("bilibili").captions, true);
  // force=true bypasses a fresh cache (the pre-start refresh).
  await store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t", force: true });
  assert.equal(requests.length, 3);
});

test("store: concurrent ensureFresh calls share one in-flight fetch (panel open + start race)", async () => {
  const { store, requests, script } = makeStore();
  script([okResponse({ capabilities: [] })]);
  const [a, b] = [
    store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" }),
    store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" }),
  ];
  await Promise.all([a, b]);
  assert.equal(requests.length, 1);
});

test("store failure fallback: network error / 5xx / garbage body serve the defaults", async () => {
  // Network failure.
  const networkCase = makeStore();
  networkCase.script([{ network: true }]);
  await networkCase.store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  assert.equal(networkCase.store.capabilityFor("bilibili").captions, true);
  assert.equal(networkCase.store.snapshot().hasServerRows, false);

  // 5xx.
  const serverCase = makeStore();
  serverCase.script([{ status: 503, json: async () => null }]);
  await serverCase.store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  assert.equal(serverCase.store.capabilityFor("youtube").captions, true);
  assert.equal(serverCase.store.snapshot().hasServerRows, false);

  // 200 with a non-array body.
  const garbageCase = makeStore();
  garbageCase.script([{ status: 200, json: async () => ({ rows: [] }) }]);
  await garbageCase.store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  assert.equal(garbageCase.store.capabilityFor("bilibili").captions, true);
  assert.equal(garbageCase.store.snapshot().hasServerRows, false);
});

test("store timeout: a hung fetch resolves to the default-table fallback", async () => {
  const timeouts = [];
  const { store, script } = makeStore({
    fetchImpl: () => new Promise(() => {}), // never settles
    setTimeoutImpl: (fn, delay) => {
      timeouts.push(delay);
      fn(); // fire immediately: the race resolves to the timeout verdict
      return 1;
    },
    clearTimeoutImpl: () => {},
  });
  const verdict = await store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  assert.equal(verdict.kind, "error");
  assert.deepEqual(timeouts, [YTD_SITE_CAPABILITIES.DEFAULT_TIMEOUT_MS]);
  assert.equal(store.capabilityFor("bilibili").captions, true);
  assert.equal(store.snapshot().hasServerRows, false);
});

test("store 401: onUnauthorized fires (P7 routing) and the defaults serve", async () => {
  let unauthorizedCalls = 0;
  const { store, script } = makeStore({
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
  });
  script([{ status: 401, json: async () => ({ error: { code: "unauthorized" } }) }]);
  const verdict = await store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  assert.equal(verdict.kind, "unauthorized");
  assert.equal(unauthorizedCalls, 1);
  assert.equal(store.capabilityFor("bilibili").captions, true);
  assert.equal(store.snapshot().hasServerRows, false);
});

test("store captionsEnabledFor: 服务端开关 AND reader 可用", () => {
  const { store, script } = makeStore();
  // Defaults + declarations: bilibili/youtube readers exist, xiaoe/xiaohongshu do not.
  assert.equal(store.captionsEnabledFor("bilibili"), true);
  assert.equal(store.captionsEnabledFor("youtube"), true);
  assert.equal(store.captionsEnabledFor("xiaoe-tech"), false);
  assert.equal(store.captionsEnabledFor("xiaohongshu"), false);
  assert.equal(store.captionsEnabledFor("unknown-platform"), false);
});

test("store captionsEnabledFor: a server captions:true cannot outrun a missing reader; a server false kills the path everywhere", async () => {
  const { store, script } = makeStore();
  script([
    okResponse({
      capabilities: [
        // The registry's own id for the xiaoe platform (contract-r4 §2.1).
        { platformId: "xiaoe", captions: true, asr: true, enabled: true },
        { platformId: "bilibili", captions: false, asr: true, enabled: true },
      ],
    }),
  ]);
  await store.ensureFresh({ apiBaseUrl: "https://api.example.com", token: "t" });
  // Server says captions:true but the xiaoe adapter has no captions reader.
  assert.equal(store.captionsEnabledFor("xiaoe-tech"), false);
  // Server switch off on bilibili kills the captions path despite the reader.
  assert.equal(store.captionsEnabledFor("bilibili"), false);
});

// ============================================================
// ADAPTER-OWNED DECLARATIONS (source-platforms.js registry seam)
// ============================================================
//
// The gating data source's second half: each Source Platform adapter
// declares whether it carries a captions reader. bilibili/youtube do; the
// xiaoe/xiaohongshu adapters have none, so the captions path can never be
// entered there whatever the server table says.

test("registry declarations: bilibili/youtube declare a captions reader; xiaoe/xiaohongshu do not", () => {
  assert.equal(YTD_SOURCE_PLATFORMS.captionsReaderFor("bilibili"), true);
  assert.equal(YTD_SOURCE_PLATFORMS.captionsReaderFor("youtube"), true);
  assert.equal(YTD_SOURCE_PLATFORMS.captionsReaderFor("xiaoe-tech"), false);
  assert.equal(YTD_SOURCE_PLATFORMS.captionsReaderFor("xiaohongshu"), false);
  // Unknown / garbage ids read as "no reader" and never throw.
  assert.equal(YTD_SOURCE_PLATFORMS.captionsReaderFor("future-platform"), false);
  assert.equal(YTD_SOURCE_PLATFORMS.captionsReaderFor(null), false);
});

test("adapters carry the declaration on their public shape", () => {
  const adapters = YTD_SOURCE_PLATFORMS.listSourcePlatforms();
  const byId = Object.fromEntries(adapters.map((a) => [a.id, a]));
  assert.deepEqual(byId.bilibili.capabilities, { captionsReader: true });
  assert.deepEqual(byId.youtube.capabilities, { captionsReader: true });
  assert.deepEqual(byId["xiaoe-tech"].capabilities, { captionsReader: false });
  assert.deepEqual(byId.xiaohongshu.capabilities, { captionsReader: false });
});
