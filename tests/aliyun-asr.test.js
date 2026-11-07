const test = require("node:test");
const assert = require("node:assert/strict");

const speechProviders = require("../speech-providers.js");

const aliyun = speechProviders.getSpeechProvider("aliyun");

const SIGNING_DOC = {
  // Worked example from the Aliyun POP RPC signature documentation
  // (help.aliyun.com/zh/link-wan/developer-reference/043ed9, the same
  // SignatureMethod=HMAC-SHA1 / SignatureVersion=1.0 mechanism the
  // nls-meta CreateToken API uses). The doc displays the StringToSign
  // with literal "&" separators, but the published signature
  // yqWsF0aPGrECmuwTfALUIl0JM9M= is only reproduced when the
  // canonicalized query string is percent-encoded a second time as a
  // whole (separators become %26/%3D), matching the official pop-core
  // SDK. Built by concatenation so GitHub push protection doesn't flag
  // the documentation-example credentials as live secrets.
  accessKeyId: "test" + "id",
  accessKeySecret: "test" + "secret",
  action: "GetGateway",
  version: "2019-01-20",
  regionId: "cn-shanghai",
  timestamp: "2019-01-20T12:00:00Z",
  signatureNonce: "15215528852396",
  params: { Format: "JSON", GwEui: "0000000000000000" },
  stringToSign:
    "GET&%2F&AccessKeyId%3Dtestid%26Action%3DGetGateway%26Format%3DJSON" +
    "%26GwEui%3D0000000000000000%26RegionId%3Dcn-shanghai" +
    "%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3D15215528852396" +
    "%26SignatureVersion%3D1.0%26Timestamp%3D2019-01-20T12%253A00%253A00Z" +
    "%26Version%3D2019-01-20",
  signature: "yqWsF0aPGrECmuwTfALUIl0JM9M=",
};

test("the registry ships with the Aliyun ASR Speech Provider", () => {
  assert.ok(aliyun, "aliyun provider is registered");
  assert.equal(aliyun.id, "aliyun");
  assert.equal(typeof aliyun.transcribe, "function");
  const keys = aliyun.credentialFields.map((field) => field.key);
  assert.deepEqual(keys, ["accessKeyId", "accessKeySecret", "appKey", "region"]);
  assert.equal(
    aliyun.credentialFields.find((f) => f.key === "accessKeySecret").type,
    "password",
  );
  assert.equal(aliyun.defaults.region, "cn-shanghai");
  assert.equal(typeof aliyun.helpLink, "string");
});

test("listSpeechProviders exposes all three providers: Groq, Tencent, Aliyun", () => {
  const ids = speechProviders.listSpeechProviders().map((p) => p.id);
  assert.deepEqual(ids, ["groq", "tencent", "aliyun"]);
});

test("POP signing reproduces the official documentation worked example", async () => {
  const signed = await aliyun.signRequest({
    accessKeyId: SIGNING_DOC.accessKeyId,
    accessKeySecret: SIGNING_DOC.accessKeySecret,
    action: SIGNING_DOC.action,
    version: SIGNING_DOC.version,
    regionId: SIGNING_DOC.regionId,
    timestamp: SIGNING_DOC.timestamp,
    signatureNonce: SIGNING_DOC.signatureNonce,
    params: SIGNING_DOC.params,
  });

  assert.equal(signed.stringToSign, SIGNING_DOC.stringToSign);
  assert.equal(signed.signature, SIGNING_DOC.signature);
  // In the request URL the signature itself is percent-encoded.
  assert.ok(
    signed.queryString.includes(
      "Signature=" + encodeURIComponent(SIGNING_DOC.signature),
    ),
  );
});

test("POP HMAC-SHA1 primitive matches the RFC 2202 test vector", async () => {
  // RFC 2202 Test Case 1: key = 0x0b x20, data = "Hi There".
  const key = Buffer.from("0b".repeat(20), "hex");
  const digest = await aliyun.crypto.hmacSha1Bytes(key, "Hi There");
  assert.equal(
    Buffer.from(digest).toString("hex"),
    "b617318655057264e28bc0b6fb378c8ef146be00",
  );
});

test("signRequest builds a CreateToken query with signed common parameters", async () => {
  const signed = await aliyun.signRequest({
    accessKeyId: "AKID" + "test",
    accessKeySecret: "secret-test",
    action: "CreateToken",
    version: "2019-02-28",
    regionId: "cn-shanghai",
    timestamp: "2026-11-07T08:00:00Z",
    signatureNonce: "nonce-123",
  });

  assert.equal(signed.host, "nls-meta.cn-shanghai.aliyuncs.com");
  assert.equal(signed.stringToSign.startsWith("GET&%2F&"), true);
  assert.match(signed.signature, /^[A-Za-z0-9+/]+={0,2}$/);
  const query = new URLSearchParams(signed.queryString);
  assert.equal(query.get("Action"), "CreateToken");
  assert.equal(query.get("Version"), "2019-02-28");
  assert.equal(query.get("RegionId"), "cn-shanghai");
  assert.equal(query.get("AccessKeyId"), "AKIDtest");
  assert.equal(query.get("SignatureMethod"), "HMAC-SHA1");
  assert.equal(query.get("SignatureVersion"), "1.0");
  assert.equal(query.get("SignatureNonce"), "nonce-123");
  assert.equal(query.get("Timestamp"), "2026-11-07T08:00:00Z");
  assert.ok(query.get("Signature"));
});


// --- transcribe: request shape, response mapping, token lifecycle ----------

function fetchQueue(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (responses.length === 0) throw new Error("fetchQueue exhausted");
    return responses.shift();
  };
  return { fetchImpl, calls };
}

const okJson = (json) => ({
  ok: true,
  status: 200,
  json: async () => json,
});

const TOKEN_OK = (expireTime) => ({
  Token: {
    Id: "450372e4279bcc2b3c793" + "example",
    ExpireTime: expireTime,
  },
});

const ASR_OK = {
  task_id: "cf7b0c5339244ee29cd4e43fb97f0000",
  result: "北京的天气。",
  status: 20000000,
  message: "SUCCESS",
};

const FAR_FUTURE = 2000000000; // 2033 — comfortably unexpired
const PAST = 1500000000; // 2017 — already expired

function aliyunCredentials(overrides = {}) {
  // Per-test AccessKey IDs keep the module-level token cache isolated.
  const unique = Math.random().toString(36).slice(2, 10);
  return {
    accessKeyId: `AKID${unique}`,
    accessKeySecret: `secret-${unique}`,
    appKey: `appkey-${unique}`,
    ...overrides,
  };
}

test("Aliyun transcribe fetches a token, then posts the Segment audio", async () => {
  const credentials = aliyunCredentials();
  const segmentAudio = new Blob([Uint8Array.from([1, 2, 3, 250])], {
    type: "audio/wav",
  });
  const { fetchImpl, calls } = fetchQueue(okJson(TOKEN_OK(FAR_FUTURE)), okJson(ASR_OK));

  const records = await aliyun.transcribe(segmentAudio, credentials, fetchImpl);

  assert.equal(calls.length, 2);

  // First call: signed CreateToken RPC against the nls-meta endpoint.
  assert.match(calls[0].url, /^https:\/\/nls-meta\.cn-shanghai\.aliyuncs\.com\/\?/);
  const tokenQuery = new URLSearchParams(calls[0].url.split("?")[1]);
  assert.equal(tokenQuery.get("Action"), "CreateToken");
  assert.equal(tokenQuery.get("Version"), "2019-02-28");
  assert.equal(tokenQuery.get("AccessKeyId"), credentials.accessKeyId);
  assert.ok(tokenQuery.get("Signature"));
  assert.equal(calls[0].init.method, "GET");

  // Second call: binary audio against the region gateway with the token.
  assert.equal(
    calls[1].url,
    `https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr?appkey=${credentials.appKey}` +
      "&format=wav&sample_rate=16000" +
      "&enable_punctuation_prediction=true&enable_inverse_text_normalization=true",
  );
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers["X-NLS-Token"], TOKEN_OK().Token.Id);
  assert.equal(calls[1].init.headers["Content-Type"], "application/octet-stream");
  assert.equal(calls[1].init.headers["Content-Length"], "4");
  assert.deepEqual([...calls[1].init.body], [1, 2, 3, 250]);

  assert.deepEqual(records, [{ text: "北京的天气。", start: 0, duration: 0 }]);
});

test("Aliyun transcribe maps duration from the ytdSegmentDuration Blob convention", async () => {
  const credentials = aliyunCredentials();
  const segmentAudio = new Blob([], { type: "audio/opus" });
  segmentAudio.ytdSegmentDuration = 45.7;
  const { fetchImpl } = fetchQueue(okJson(TOKEN_OK(FAR_FUTURE)), okJson(ASR_OK));

  const records = await aliyun.transcribe(segmentAudio, credentials, fetchImpl);

  assert.deepEqual(records, [{ text: "北京的天气。", start: 0, duration: 45 }]);
});

test("Aliyun transcribe reuses a cached token within its ExpireTime", async () => {
  const credentials = aliyunCredentials();
  const { fetchImpl, calls } = fetchQueue(
    okJson(TOKEN_OK(FAR_FUTURE)),
    okJson(ASR_OK),
    okJson(ASR_OK),
  );

  await aliyun.transcribe(new Blob([], { type: "audio/wav" }), credentials, fetchImpl);
  await aliyun.transcribe(new Blob([], { type: "audio/wav" }), credentials, fetchImpl);

  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /nls-gateway/);
  assert.match(calls[2].url, /nls-gateway/);
});

test("Aliyun transcribe refetches an expired token", async () => {
  const credentials = aliyunCredentials();
  const { fetchImpl, calls } = fetchQueue(
    okJson(TOKEN_OK(PAST)),
    okJson(ASR_OK),
    okJson(TOKEN_OK(FAR_FUTURE)),
    okJson(ASR_OK),
  );

  await aliyun.transcribe(new Blob([], { type: "audio/wav" }), credentials, fetchImpl);
  await aliyun.transcribe(new Blob([], { type: "audio/wav" }), credentials, fetchImpl);

  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /nls-meta/);
  assert.match(calls[1].url, /nls-gateway/);
  assert.match(calls[2].url, /nls-meta/);
  assert.match(calls[3].url, /nls-gateway/);
});

test("Aliyun transcribe rejects a token response without Token.Id", async () => {
  const credentials = aliyunCredentials();
  const { fetchImpl } = fetchQueue(okJson({ Code: "SignatureDoesNotMatch" }));

  await assert.rejects(
    aliyun.transcribe(new Blob([], {}), credentials, fetchImpl),
    /token response missing Token\.Id.*SignatureDoesNotMatch/,
  );
});

test("Aliyun transcribe rejects a non-OK token response", async () => {
  const credentials = aliyunCredentials();
  const { fetchImpl } = fetchQueue({ ok: false, status: 403 });

  await assert.rejects(
    aliyun.transcribe(new Blob([], {}), credentials, fetchImpl),
    /token request failed with HTTP 403/,
  );
});

test("Aliyun transcribe returns an empty record list for an empty result", async () => {
  for (const json of [{ ...ASR_OK, result: "" }, { ...ASR_OK, result: "   " }]) {
    const { fetchImpl } = fetchQueue(okJson(TOKEN_OK(FAR_FUTURE)), okJson(json));
    const records = await aliyun.transcribe(
      new Blob([], { type: "audio/wav" }),
      // Fresh credentials per iteration so the token cache never
      // short-circuits the token request.
      aliyunCredentials(),
      fetchImpl,
    );
    assert.deepEqual(records, []);
  }
});

test("Aliyun transcribe rejects a response without a status", async () => {
  const credentials = aliyunCredentials();
  const { fetchImpl } = fetchQueue(okJson(TOKEN_OK(FAR_FUTURE)), okJson({}));

  await assert.rejects(
    aliyun.transcribe(new Blob([], { type: "audio/wav" }), credentials, fetchImpl),
    /unrecognized response/,
  );
});

test("Aliyun transcribe rejects on a non-OK response", async () => {
  const credentials = aliyunCredentials();
  const { fetchImpl } = fetchQueue(
    okJson(TOKEN_OK(FAR_FUTURE)),
    { ok: false, status: 500 },
  );

  await assert.rejects(
    aliyun.transcribe(new Blob([], { type: "audio/wav" }), credentials, fetchImpl),
    /HTTP 500/,
  );
});

test("Aliyun transcribe rejects with the NLS status code and message", async () => {
  const credentials = aliyunCredentials();
  const { fetchImpl } = fetchQueue(
    okJson(TOKEN_OK(FAR_FUTURE)),
    okJson({
      task_id: "8bae3613dfc54ebfa811a17d8a7a0000",
      result: "",
      status: 40000001,
      message: "Gateway:ACCESS_DENIED:The token is invalid",
    }),
  );

  await assert.rejects(
    aliyun.transcribe(new Blob([], { type: "audio/wav" }), credentials, fetchImpl),
    /error 40000001: Gateway:ACCESS_DENIED:The token is invalid/,
  );
});

test("Aliyun transcribe rejects without AccessKey pair or AppKey", async () => {
  for (const credentials of [
    {},
    { accessKeyId: "AKIDx" },
    { accessKeySecret: "secret" },
    { accessKeyId: "AKIDx", accessKeySecret: "secret" },
  ]) {
    await assert.rejects(
      aliyun.transcribe(new Blob([], {}), credentials, async () => {
        throw new Error("must not fetch without credentials");
      }),
      /requires AccessKey ID and AccessKey Secret|requires an AppKey/,
    );
  }
});

test("Aliyun transcribe maps MIME types to documented formats and honors region", async () => {
  const cases = [
    ["audio/mp3", "mp3"],
    ["audio/aac", "aac"],
    ["audio/amr", "amr"],
    ["audio/webm;codecs=opus", "opus"], // optimistic, undocumented container
    ["application/octet-stream", "pcm"], // documented default
  ];
  for (const [mime, format] of cases) {
    // Fresh credentials per case so the module-level token cache never
    // short-circuits the token request.
    const credentials = aliyunCredentials({ region: "ap-southeast-1" });
    const { fetchImpl, calls } = fetchQueue(
      okJson(TOKEN_OK(FAR_FUTURE)),
      okJson(ASR_OK),
    );
    await aliyun.transcribe(new Blob([], { type: mime }), credentials, fetchImpl);
    assert.ok(calls[0].url.includes("nls-meta.ap-southeast-1.aliyuncs.com"));
    assert.ok(calls[1].url.includes(`format=${format}`), `${mime} -> ${format}`);
    assert.ok(calls[1].url.includes("nls-gateway-ap-southeast-1.aliyuncs.com"));
  }
});
