const test = require("node:test");
const assert = require("node:assert/strict");
const YTD_AUTH_GATE = require("../auth-gate.js");

// P6: the authorization gate's pure core. The extension treats a valid
// linked credential as the precondition of every feature; these tests pin
// the credential parsing, URL building, link-code extraction from the tab
// URL, the /v1/me probe, and the code exchange against the API contract.

const API_BASE = "http://127.0.0.1:8787";
const WEB_BASE = "http://127.0.0.1:8080";

// --- stored credential parsing ------------------------------------------------

test("parseStoredCredential keeps well-formed credentials and drops the rest", () => {
  const parsed = YTD_AUTH_GATE.parseStoredCredential({
    token: "tok",
    credentialGroupId: "grp_1",
    accountId: "acc_1",
    email: "l@e.com",
    linkedAt: 123,
  });
  assert.deepEqual(parsed, {
    token: "tok",
    credentialGroupId: "grp_1",
    accountId: "acc_1",
    email: "l@e.com",
    linkedAt: 123,
  });

  for (const broken of [
    null,
    undefined,
    "tok",
    [],
    {},
    { token: "" },
    { token: "   " },
    { noToken: true },
  ]) {
    assert.equal(
      YTD_AUTH_GATE.parseStoredCredential(broken),
      null,
      `a corrupted credential behaves like "not linked": ${JSON.stringify(broken)}`,
    );
  }
});

// --- URL building -------------------------------------------------------------

test("buildApiUrl joins the base and /v1 paths, rejecting unusable bases", () => {
  assert.equal(YTD_AUTH_GATE.buildApiUrl(API_BASE, "/v1/me"), `${API_BASE}/v1/me`);
  assert.equal(
    YTD_AUTH_GATE.buildApiUrl(`${API_BASE}/`, "/v1/me"),
    `${API_BASE}/v1/me`,
    "trailing slashes collapse",
  );
  assert.equal(YTD_AUTH_GATE.buildApiUrl(WEB_BASE, "/link.html"), `${WEB_BASE}/link.html`);
  assert.equal(YTD_AUTH_GATE.buildApiUrl("  https://api.example.com ", "/v1/me"), "https://api.example.com/v1/me");

  for (const broken of [null, undefined, "", "not a url", "ftp://x", 42]) {
    assert.equal(YTD_AUTH_GATE.buildApiUrl(broken, "/v1/me"), null, String(broken));
  }
});

// --- link code extraction (the extension's own tab) ---------------------------

test("extractLinkCode reads the code only from the success address", () => {
  assert.equal(
    YTD_AUTH_GATE.extractLinkCode(`${WEB_BASE}/link.html?link=abc123`),
    "abc123",
  );
  assert.equal(
    YTD_AUTH_GATE.extractLinkCode(`${WEB_BASE}/link.html?link=a%2Bb`),
    "a+b",
    "percent-encoded codes survive",
  );
  // Extra params are fine; the confirmation page before redirect is not.
  assert.equal(
    YTD_AUTH_GATE.extractLinkCode(`${WEB_BASE}/link.html?source=extension`),
    null,
  );
  assert.equal(YTD_AUTH_GATE.extractLinkCode(`${WEB_BASE}/index.html?link=abc`), null);
  assert.equal(YTD_AUTH_GATE.extractLinkCode(`${WEB_BASE}/`), null);
  assert.equal(YTD_AUTH_GATE.extractLinkCode(""), null);
  assert.equal(YTD_AUTH_GATE.extractLinkCode(null), null);
  assert.equal(YTD_AUTH_GATE.extractLinkCode("::::not a url"), null);
});

// --- the /v1/me authorization probe -------------------------------------------

function fakeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (typeof status === "function") return status(url, init);
    return {
      status,
      json: async () => body,
    };
  };
  return { fetchImpl, calls };
}

test("checkAuthorization authorizes on a live /v1/me answer", async () => {
  const { fetchImpl, calls } = fakeFetch(200, { account: { id: "acc_1", email: "l@e.com" } });
  const result = await YTD_AUTH_GATE.checkAuthorization({
    fetchImpl,
    apiBaseUrl: API_BASE,
    credential: { token: "tok" },
  });
  assert.deepEqual(result, {
    authorized: true,
    reason: null,
    account: { id: "acc_1", email: "l@e.com" },
  });
  assert.equal(calls[0].url, `${API_BASE}/v1/me`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
});

test("checkAuthorization treats 401 as a dead credential, network loss as unreachable", async () => {
  const dead = await YTD_AUTH_GATE.checkAuthorization({
    fetchImpl: fakeFetch(401, { error: { code: "unauthorized", message: "x" } }).fetchImpl,
    apiBaseUrl: API_BASE,
    credential: { token: "tok" },
  });
  assert.deepEqual(dead, { authorized: false, reason: "unauthorized" });

  const unreachable = await YTD_AUTH_GATE.checkAuthorization({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    apiBaseUrl: API_BASE,
    credential: { token: "tok" },
  });
  assert.deepEqual(unreachable, { authorized: false, reason: "unreachable" });

  // An unexpected but answered status is not a verdict against the token.
  const weird = await YTD_AUTH_GATE.checkAuthorization({
    fetchImpl: fakeFetch(500, null).fetchImpl,
    apiBaseUrl: API_BASE,
    credential: { token: "tok" },
  });
  assert.deepEqual(weird, { authorized: false, reason: "unreachable" });
});

test("checkAuthorization without a credential or a usable base is unconfigured", async () => {
  const noCredential = await YTD_AUTH_GATE.checkAuthorization({
    fetchImpl: fakeFetch(200, {}).fetchImpl,
    apiBaseUrl: API_BASE,
    credential: null,
  });
  assert.deepEqual(noCredential, { authorized: false, reason: "unconfigured" });

  const noBase = await YTD_AUTH_GATE.checkAuthorization({
    fetchImpl: fakeFetch(200, {}).fetchImpl,
    apiBaseUrl: "",
    credential: { token: "tok" },
  });
  assert.deepEqual(noBase, { authorized: false, reason: "unconfigured" });
});

// --- the link code exchange ---------------------------------------------------

test("exchangeLinkCode stores the issued extension credential", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 201,
      json: async () => ({
        account: { id: "acc_1", email: "l@e.com" },
        credential: {
          token: "ext-token",
          kind: "extension",
          credentialGroupId: "grp_1",
        },
      }),
    };
  };
  const result = await YTD_AUTH_GATE.exchangeLinkCode({
    fetchImpl,
    apiBaseUrl: API_BASE,
    code: "link_code_1",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.credential, {
    token: "ext-token",
    credentialGroupId: "grp_1",
    accountId: "acc_1",
    email: "l@e.com",
    linkedAt: result.credential.linkedAt,
  });
  assert.ok(typeof result.credential.linkedAt === "number");
  assert.equal(calls[0].url, `${API_BASE}/v1/auth/link`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: "link_code_1" });
  assert.equal(calls[0].init.headers.Authorization, undefined, "no Bearer: the extension has none yet");
});

test("exchangeLinkCode surfaces the contract envelope message on failure", async () => {
  const rejected = await YTD_AUTH_GATE.exchangeLinkCode({
    fetchImpl: fakeFetch(401, {
      error: { code: "unauthorized", message: "关联码无效或已过期，请在网页上重新发起关联" },
    }).fetchImpl,
    apiBaseUrl: API_BASE,
    code: "stale",
  });
  assert.deepEqual(rejected, {
    ok: false,
    status: 401,
    message: "关联码无效或已过期，请在网页上重新发起关联",
  });

  const network = await YTD_AUTH_GATE.exchangeLinkCode({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    apiBaseUrl: API_BASE,
    code: "x",
  });
  assert.equal(network.ok, false);
  assert.match(network.message, /无法连接学习服务/);

  const unparseable = await YTD_AUTH_GATE.exchangeLinkCode({
    fetchImpl: async () => ({
      status: 502,
      json: async () => {
        throw new SyntaxError("not json");
      },
    }),
    apiBaseUrl: API_BASE,
    code: "x",
  });
  assert.equal(unparseable.ok, false);
  assert.equal(unparseable.status, 502);
});
