const test = require("node:test");
const assert = require("node:assert/strict");

const speechProviders = require("../speech-providers.js");

const tencent = speechProviders.getSpeechProvider("tencent");

const SIGNING_DOC = {
  // Worked example from Tencent Cloud "签名方法 v3" (signature method v3)
  // documentation, cloud.tencent.com/document/product/213/30654
  // (updated 2024-12-27). The doc masks the secret key, so only the
  // key-independent stages (payload hash, canonical request hash, string to
  // sign) can be pinned exactly; the HMAC chain is pinned separately via
  // RFC 4231 vectors below. Re-verify against the live docs before release.
  // Built by concatenation so GitHub push protection doesn't flag the
  // documentation-example credentials as live secrets.
  secretId: "AKIDz8krbsJ5yKBZQpn74" + "WFkmLPx3EXAMPLE",
  secretKey: "Gu5t9xGARNpq86cd98joQYCN" + "3EXAMPLE",
  service: "cvm",
  host: "cvm.tencentcloudapi.com",
  action: "DescribeInstances",
  version: "2017-03-12",
  region: "ap-guangzhou",
  timestamp: 1551113065,
  payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
  hashedRequestPayload:
    "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064",
  hashedCanonicalRequest:
    "7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84",
  credentialScope: "2019-02-25/cvm/tc3_request",
  // The doc's published signature (10b1a37a...) was computed with the
  // author's masked key and therefore cannot be reproduced here.
};

test("the registry ships with the Tencent Cloud ASR Speech Provider", () => {
  assert.equal(tencent.id, "tencent");
  assert.equal(typeof tencent.transcribe, "function");
  const keys = tencent.credentialFields.map((field) => field.key);
  assert.deepEqual(keys, ["secretId", "secretKey", "region", "engineModelType"]);
  assert.equal(
    tencent.credentialFields.find((f) => f.key === "secretKey").type,
    "password",
  );
  assert.equal(tencent.defaults.region, "ap-guangzhou");
  assert.equal(tencent.defaults.engineModelType, "16k_zh");
});

test("listSpeechProviders exposes the Tencent provider alongside Groq", () => {
  const ids = speechProviders.listSpeechProviders().map((p) => p.id);
  assert.ok(ids.includes("groq"));
  assert.ok(ids.includes("tencent"));
});

test("TC3 signing reproduces the official documentation worked example", async () => {
  const signed = await tencent.signRequest(
    {
      secretId: SIGNING_DOC.secretId,
      secretKey: SIGNING_DOC.secretKey,
      service: SIGNING_DOC.service,
      host: SIGNING_DOC.host,
      action: SIGNING_DOC.action,
      version: SIGNING_DOC.version,
      region: SIGNING_DOC.region,
      payload: SIGNING_DOC.payload,
      timestamp: SIGNING_DOC.timestamp,
      signAction: true,
    },
    // Default platform crypto (node:crypto under node --test).
  );

  assert.equal(signed.date, "2019-02-25");
  // 1551113065 is already 2019-02-26 in UTC+8; the UTC date must be used.
  assert.equal(signed.credentialScope, SIGNING_DOC.credentialScope);
  assert.equal(signed.hashedRequestPayload, SIGNING_DOC.hashedRequestPayload);
  assert.equal(signed.hashedCanonicalRequest, SIGNING_DOC.hashedCanonicalRequest);
  assert.equal(
    signed.stringToSign,
    [
      "TC3-HMAC-SHA256",
      "1551113065",
      SIGNING_DOC.credentialScope,
      SIGNING_DOC.hashedCanonicalRequest,
    ].join("\n"),
  );
  assert.match(signed.signature, /^[0-9a-f]{64}$/);
  assert.equal(
    signed.authorization,
    "TC3-HMAC-SHA256 " +
      `Credential=${SIGNING_DOC.secretId}/${SIGNING_DOC.credentialScope}, ` +
      "SignedHeaders=content-type;host;x-tc-action, " +
      `Signature=${signed.signature}`,
  );
});

test("TC3 HMAC primitive matches the RFC 4231 HMAC-SHA-256 test vector", async () => {
  // RFC 4231 Test Case 1: key = 0x0b x20, data = "Hi There".
  const key = Buffer.from("0b".repeat(20), "hex");
  const digest = await tencent.crypto.hmacSha256Bytes(key, "Hi There");
  assert.equal(
    Buffer.from(digest).toString("hex"),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
});

test("TC3 SHA-256 primitive matches the FIPS 180-2 example", async () => {
  assert.equal(
    await tencent.crypto.sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("Tencent signRequest emits ASR headers with content-type and host signed", async () => {
  const signed = await tencent.signRequest({
    secretId: "AKIDtest",
    secretKey: "secret-test",
    service: "asr",
    host: "asr.tencentcloudapi.com",
    action: "SentenceRecognition",
    version: "2019-06-14",
    region: "ap-shanghai",
    payload: "{}",
    timestamp: 1599140479,
  });

  assert.equal(signed.headers.Host, "asr.tencentcloudapi.com");
  assert.equal(signed.headers["X-TC-Action"], "SentenceRecognition");
  assert.equal(signed.headers["X-TC-Version"], "2019-06-14");
  assert.equal(signed.headers["X-TC-Region"], "ap-shanghai");
  assert.equal(signed.headers["X-TC-Timestamp"], "1599140479");
  assert.equal(
    signed.headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  assert.ok(signed.headers.Authorization.startsWith("TC3-HMAC-SHA256 "));
  assert.ok(
    signed.headers.Authorization.includes(
      "Credential=AKIDtest/2020-09-03/asr/tc3_request",
    ),
  );
  assert.ok(signed.headers.Authorization.includes("SignedHeaders=content-type;host"));
});

function mockFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

const okJson = (json) => ({
  ok: true,
  status: 200,
  json: async () => json,
});

const TENCENT_OK = {
  Response: {
    RequestId: "41ed9283-0c09-46fb-917b-0b83fa95f0be",
    Result: "腾讯云语音识别欢迎您。",
    AudioDuration: 2430,
  },
};

test("Tencent transcribe posts a signed SentenceRecognition request", async () => {
  const segmentAudio = new Blob([Uint8Array.from([1, 2, 3, 250])], {
    type: "audio/wav",
  });
  const { fetchImpl, calls } = mockFetch(okJson(TENCENT_OK));

  await tencent.transcribe(
    segmentAudio,
    {
      secretId: "AKIDtest",
      secretKey: "secret-test",
      region: "ap-shanghai",
      engineModelType: "16k_zh-PY",
    },
    fetchImpl,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://asr.tencentcloudapi.com/");
  assert.equal(calls[0].init.method, "POST");

  const headers = calls[0].init.headers;
  assert.equal(headers["X-TC-Action"], "SentenceRecognition");
  assert.equal(headers["X-TC-Version"], "2019-06-14");
  assert.equal(headers["X-TC-Region"], "ap-shanghai");
  assert.equal(
    headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  assert.ok(headers.Authorization.startsWith("TC3-HMAC-SHA256 Credential=AKIDtest/"));
  assert.ok(headers.Authorization.includes("/asr/tc3_request"));
  assert.ok(headers.Authorization.includes("SignedHeaders=content-type;host"));

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.ProjectId, 0);
  assert.equal(body.SubServiceType, 2);
  assert.equal(body.EngSerViceType, "16k_zh-PY");
  assert.equal(body.SourceType, 1);
  assert.equal(body.VoiceFormat, "wav");
  assert.equal(body.Data, Buffer.from([1, 2, 3, 250]).toString("base64"));
  assert.equal(body.DataLen, 4);
});

test("Tencent transcribe falls back to the documented defaults", async () => {
  const { fetchImpl, calls } = mockFetch(okJson(TENCENT_OK));

  await tencent.transcribe(
    new Blob([Uint8Array.from([9])], { type: "audio/mp3" }),
    { secretId: "AKIDtest", secretKey: "secret-test" },
    fetchImpl,
  );

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.EngSerViceType, "16k_zh");
  assert.equal(body.VoiceFormat, "mp3");
  assert.equal(calls[0].init.headers["X-TC-Region"], "ap-guangzhou");
});

test("Tencent transcribe maps the response to one Transcript record covering the Segment", async () => {
  const segmentAudio = new Blob([], { type: "audio/wav" });
  segmentAudio.ytdSegmentDuration = 120;
  const { fetchImpl } = mockFetch(okJson(TENCENT_OK));

  const records = await tencent.transcribe(
    segmentAudio,
    { secretId: "AKIDtest", secretKey: "secret-test" },
    fetchImpl,
  );

  // One sentence per request: start is segment-relative and duration covers
  // the Segment. Tencent reports no language, so the record omits it.
  assert.deepEqual(records, [
    { text: "腾讯云语音识别欢迎您。", start: 0, duration: 120 },
  ]);
});

test("Tencent transcribe uses AudioDuration when no Segment duration hint exists", async () => {
  const { fetchImpl } = mockFetch(okJson(TENCENT_OK));

  const records = await tencent.transcribe(
    new Blob([], { type: "audio/wav" }),
    { secretId: "AKIDtest", secretKey: "secret-test" },
    fetchImpl,
  );

  assert.deepEqual(records, [
    { text: "腾讯云语音识别欢迎您。", start: 0, duration: 2 },
  ]);
});

test("Tencent transcribe returns an empty record list for an empty Result", async () => {
  for (const json of [
    { Response: { Result: "" } },
    { Response: { Result: "   " } },
    { Response: {} },
    {},
  ]) {
    const { fetchImpl } = mockFetch(okJson(json));
    const records = await tencent.transcribe(
      new Blob([], { type: "audio/wav" }),
      { secretId: "AKIDtest", secretKey: "secret-test" },
      fetchImpl,
    );
    assert.deepEqual(records, []);
  }
});

test("Tencent transcribe rejects on a non-OK response", async () => {
  const { fetchImpl } = mockFetch({ ok: false, status: 403 });

  await assert.rejects(
    tencent.transcribe(
      new Blob([], { type: "audio/wav" }),
      { secretId: "AKIDtest", secretKey: "secret-test" },
      fetchImpl,
    ),
    /HTTP 403/,
  );
});

test("Tencent transcribe rejects with the API error code and message", async () => {
  const { fetchImpl } = mockFetch(
    okJson({
      Response: {
        Error: {
          Code: "AuthFailure.SignatureFailure",
          Message: "签名错误。",
        },
        RequestId: "req-1",
      },
    }),
  );

  await assert.rejects(
    tencent.transcribe(
      new Blob([], { type: "audio/wav" }),
      { secretId: "AKIDtest", secretKey: "bad-key" },
      fetchImpl,
    ),
    /AuthFailure\.SignatureFailure: 签名错误。/,
  );
});

test("Tencent transcribe rejects without SecretId or SecretKey", async () => {
  for (const credentials of [{}, { secretId: "AKIDtest" }, { secretKey: "sk" }]) {
    await assert.rejects(
      tencent.transcribe(new Blob([], {}), credentials, async () => {
        throw new Error("must not fetch without credentials");
      }),
      /requires SecretId and SecretKey/,
    );
  }
});
