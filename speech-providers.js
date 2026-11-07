/**
 * Speech Provider registry and the Groq Speech Provider.
 *
 * A Speech Provider turns one Segment's audio into Transcript records
 * ({ text, start, duration, language? }) — the same record shape
 * captions.js and speech-transcription.js produce, so downstream code
 * cannot tell providers apart.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts. Future providers
 * (Tencent Cloud ASR, Aliyun ASR) register themselves with
 * registerSpeechProvider and plug into the same seam.
 */
var YTD_SPEECH_PROVIDERS = (() => {
  const registry = new Map();

  function registerSpeechProvider(definition) {
    if (!definition || typeof definition.id !== "string" || !definition.id) {
      throw new Error("Speech Provider requires an id");
    }
    if (typeof definition.transcribe !== "function") {
      throw new Error(`Speech Provider ${definition.id} requires transcribe`);
    }
    registry.set(definition.id, definition);
    return definition;
  }

  function getSpeechProvider(id) {
    return registry.get(id);
  }

  function listSpeechProviders() {
    return [...registry.values()];
  }

  /**
   * Transcribes one Segment through the registered Speech Provider matching
   * providerId.
   *
   * @returns {Promise<Array<{text: string, start: number, duration: number, language?: string}>>}
   */
  async function transcribeSegment(providerId, segmentAudio, credentials) {
    const provider = getSpeechProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown Speech Provider: ${providerId}`);
    }
    return provider.transcribe(segmentAudio, credentials);
  }

  /**
   * The credential fields a Speech Provider requires before it can run:
   * every field declared with type "password" (the same rule the options
   * page enforces at save time). Returns the keys whose trimmed value is
   * missing from the given credentials.
   *
   * @param {string} providerId
   * @param {object} [credentials]
   * @returns {string[]} missing field keys, in declaration order
   */
  function missingProviderCredentials(providerId, credentials = {}) {
    const provider = getSpeechProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown Speech Provider: ${providerId}`);
    }
    return (provider.credentialFields || [])
      .filter((field) => field.type === "password")
      .filter(
        (field) =>
          typeof credentials?.[field.key] !== "string" ||
          !credentials[field.key].trim(),
      )
      .map((field) => field.key);
  }

  return {
    registerSpeechProvider,
    getSpeechProvider,
    listSpeechProviders,
    transcribeSegment,
    missingProviderCredentials,
  };
})();

// --- Groq Speech Provider (OpenAI-compatible audio transcription) ---------
//
// The configurable base URL also covers local faster-whisper-style servers
// that speak the same /audio/transcriptions endpoint.

var YTD_SPEECH_PROVIDER_GROQ = (() => {
  // Shared pure helpers live in speech-transcription.js; in Node tests we
  // require them, in the service worker both globals arrive via importScripts.
  const speechTranscription =
    typeof YTD_SPEECH_TRANSCRIPTION !== "undefined"
      ? YTD_SPEECH_TRANSCRIPTION
      : require("./speech-transcription.js");

  const ID = "groq";
  const LABEL = "Groq Whisper";

  const CREDENTIAL_FIELDS = [
    { key: "apiKey", type: "password" },
    { key: "baseUrl", type: "text" },
    { key: "model", type: "text" },
  ];

  const DEFAULTS = Object.freeze({
    apiKey: "",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
  });

  function normalizeBaseUrl(baseUrl) {
    const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
    return (trimmed || DEFAULTS.baseUrl).replace(/\/+$/, "");
  }

  function normalizeModel(model) {
    const trimmed = typeof model === "string" ? model.trim() : "";
    return trimmed || DEFAULTS.model;
  }

  /**
   * Transcribes one Segment's audio through the OpenAI-compatible audio
   * transcription endpoint (Groq, or any compatible host such as a local
   * faster-whisper server).
   *
   * @param {Blob} segmentAudio - the Segment's audio
   * @param {{apiKey?: string, baseUrl?: string, model?: string}} credentials
   * @param {typeof fetch} [fetchImpl] - injectable for tests; defaults to fetch
   * @returns {Promise<Array<{text: string, start: number, duration: number, language?: string}>>}
   */
  async function transcribe(segmentAudio, credentials = {}, fetchImpl = fetch) {
    const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey.trim() : "";
    if (!apiKey) {
      throw new Error("Groq Speech Provider requires an API key");
    }

    const formData = new FormData();
    const fileName = segmentAudio?.name || "segment.webm";
    formData.append("file", segmentAudio, fileName);
    formData.append("model", normalizeModel(credentials.model));
    formData.append("response_format", "verbose_json");
    // Chinese-only product: force Whisper's output language so an
    // English-heavy lesson cannot come back as English Transcript records.
    formData.append("language", "zh");

    const response = await fetchImpl(
      `${normalizeBaseUrl(credentials.baseUrl)}/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Groq Speech Provider request failed with HTTP ${response.status}`,
      );
    }

    const verboseJson = await response.json();
    // Reuse the shared pure helper so verbose_json segments always become
    // Transcript records the same way, whichever provider produced them.
    return speechTranscription.alignChunkSegments(verboseJson, 0, verboseJson?.language);
  }

  return { id: ID, label: LABEL, credentialFields: CREDENTIAL_FIELDS, defaults: DEFAULTS, transcribe };
})();

YTD_SPEECH_PROVIDERS.registerSpeechProvider(YTD_SPEECH_PROVIDER_GROQ);

// --- Tencent Cloud ASR (一句话识别 / SentenceRecognition) ------------------
//
// Tencent's one-sentence recognition REST API accepts a recorded audio
// segment over HTTP POST (JSON body, base64 audio), which fits the Speech
// Provider seam: one Segment's audio becomes exactly one signed request.
// Limits per the published API contract (cloud.tencent.com/document/
// product/1093/35646, updated 2025-12-30): audio ≤ 60 s and ≤ 3 MB after
// base64 — shorter than the default Segment length, so the capture layer
// must slice smaller Segments for this provider (Segment length is
// provider-dependent per the glossary). Documented VoiceFormat values:
// wav, pcm, ogg-opus, speex, silk, mp3, m4a, aac, amr.
//
// Requests are signed with TC3-HMAC-SHA256 (signature method v3,
// cloud.tencent.com/document/product/213/30654). The signing core below is
// a pure function over strings plus an injectable SHA-256/HMAC seam so it
// runs on both node:crypto (tests, Node) and Web Crypto (service worker).

var YTD_SPEECH_PROVIDER_TENCENT = (() => {
  // Shared pure helpers (crypto loader, base64, region, audio-format
  // cascade) live in speech-transcription.js; in Node tests we require
  // them, in the service worker both globals arrive via importScripts.
  const speechTranscription =
    typeof YTD_SPEECH_TRANSCRIPTION !== "undefined"
      ? YTD_SPEECH_TRANSCRIPTION
      : require("./speech-transcription.js");

  const ID = "tencent";
  const LABEL = "Tencent Cloud ASR";

  const HOST = "asr.tencentcloudapi.com";
  const SERVICE = "asr";
  const ACTION = "SentenceRecognition";
  const VERSION = "2019-06-14";
  const CONTENT_TYPE = "application/json; charset=utf-8";

  const CREDENTIAL_FIELDS = [
    // Both halves of the Tencent key pair are masked and required on save;
    // see the options page's password-field requirement.
    { key: "secretId", type: "password" },
    { key: "secretKey", type: "password" },
    { key: "region", type: "text" },
    { key: "engineModelType", type: "text" },
  ];

  const DEFAULTS = Object.freeze({
    secretId: "",
    secretKey: "",
    region: "ap-guangzhou",
    engineModelType: "16k_zh",
  });

  // --- crypto seam ---------------------------------------------------------

  const nodeCrypto = speechTranscription.loadNodeCrypto();

  function bytesToHex(bytes) {
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }

  /**
   * Platform SHA-256/HMAC-256 primitives. The HMAC signature is
   * hmacSha256Bytes(key, message) — key first, message second, matching the
   * TC3 pseudocode (and RFC 4231). Keys may be strings or byte arrays, so
   * the derived-key chain can feed one digest into the next.
   */
  const crypto = (() => {
    if (nodeCrypto) {
      return {
        sha256Hex(string) {
          return nodeCrypto
            .createHash("sha256")
            .update(string, "utf8")
            .digest("hex");
        },
        hmacSha256Bytes(key, string) {
          return nodeCrypto
            .createHmac("sha256", key)
            .update(string, "utf8")
            .digest();
        },
      };
    }
    // globalThis.crypto, NOT the bare name `crypto`: this IIFE is the
    // initializer of `const crypto` below, so a bare reference here would
    // hit the temporal dead zone in the service worker (node:crypto exists
    // in Node tests and masks it — the SW load path is what must work).
    const webCrypto = globalThis.crypto;
    if (webCrypto && webCrypto.subtle) {
      const subtle = webCrypto.subtle;
      const encoder = new TextEncoder();
      return {
        async sha256Hex(string) {
          const digest = await subtle.digest(
            "SHA-256",
            encoder.encode(string),
          );
          return bytesToHex(new Uint8Array(digest));
        },
        async hmacSha256Bytes(key, string) {
          const keyBytes =
            typeof key === "string" ? encoder.encode(key) : key;
          const cryptoKey = await subtle.importKey(
            "raw",
            keyBytes,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const signature = await subtle.sign(
            "HMAC",
            cryptoKey,
            encoder.encode(string),
          );
          return new Uint8Array(signature);
        },
      };
    }
    throw new Error(
      "Tencent Speech Provider needs node:crypto or Web Crypto (crypto.subtle)",
    );
  })();

  // --- TC3-HMAC-SHA256 signing (pure composition over the crypto seam) -----

  /** UTC calendar date (yyyy-MM-dd) for a UNIX timestamp. */
  function tc3Date(timestamp) {
    const date = new Date(Number(timestamp) * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * CanonicalRequest per signature method v3: method, URI ("/"), query
   * string (empty for POST), canonical headers (lowercased names, trimmed
   * values, ASCII-sorted, "name:value\n"), signed header list, and the
   * lowercase hex SHA-256 of the payload.
   */
  function buildCanonicalRequest({ payloadHash, signedHeaders }) {
    const canonicalHeaders = signedHeaders.names
      .map((name) => `${name}:${signedHeaders.values[name]}\n`)
      .join("");
    return [
      "POST",
      "/",
      "",
      // canonicalHeaders already ends with "\n"; the separator before the
      // signed-header list supplies the required blank line.
      `${canonicalHeaders}\n${signedHeaders.names.join(";")}`,
      payloadHash,
    ].join("\n");
  }

  /**
   * StringToSign per signature method v3.
   */
  function buildStringToSign({ timestamp, credentialScope, canonicalRequestHash }) {
    return [
      "TC3-HMAC-SHA256",
      String(timestamp),
      credentialScope,
      canonicalRequestHash,
    ].join("\n");
  }

  /**
   * Signs one Tencent Cloud API 3.0 JSON POST request with
   * TC3-HMAC-SHA256. Pure composition: every stage is observable in the
   * returned object, and the official documentation's worked example is
   * pinned in tests/tencent-asr.test.js. NOTE: the doc's published final
   * signature uses a masked key, so the HMAC chain is verified via RFC 4231
   * vectors instead — re-verify end to end (e.g. with API Explorer 签名串
   * 生成) against live Tencent docs before a real release.
   *
   * By default only content-type and host are signed, matching the ASR API
   * call examples; pass signAction: true to also sign x-tc-action (the
   * style of the signature-method doc's own worked example).
   *
   * @param {object} options
   * @param {string} options.secretId
   * @param {string} options.secretKey
   * @param {string} options.service - product name, e.g. "asr"
   * @param {string} options.host - product endpoint, e.g. "asr.tencentcloudapi.com"
   * @param {string} options.action - e.g. "SentenceRecognition"
   * @param {string} options.version - API version, e.g. "2019-06-14"
   * @param {string} options.region - e.g. "ap-guangzhou"
   * @param {string} [options.payload] - exact JSON body that will be sent
   * @param {number} [options.timestamp] - UNIX seconds; defaults to now
   * @param {boolean} [options.signAction] - include x-tc-action in the signature
   * @returns {Promise<object>} signing stages plus the headers to send
   */
  async function signRequest(options) {
    const {
      secretId,
      secretKey,
      service,
      host,
      action,
      version,
      region,
      payload = "",
      timestamp = Math.floor(Date.now() / 1000),
      signAction = false,
    } = options;

    const values = {
      "content-type": CONTENT_TYPE,
      host,
    };
    if (signAction) values["x-tc-action"] = String(action).toLowerCase();
    const names = Object.keys(values).sort();
    const signedHeaders = { names, values };

    const date = tc3Date(timestamp);
    const credentialScope = `${date}/${service}/tc3_request`;
    const payloadHash = await crypto.sha256Hex(payload);
    const canonicalRequest = buildCanonicalRequest({ payloadHash, signedHeaders });
    const canonicalRequestHash = await crypto.sha256Hex(canonicalRequest);
    const stringToSign = buildStringToSign({
      timestamp,
      credentialScope,
      canonicalRequestHash,
    });

    // Derived signing key: TC3+SecretKey → date → service → "tc3_request".
    const secretDate = await crypto.hmacSha256Bytes(`TC3${secretKey}`, date);
    const secretService = await crypto.hmacSha256Bytes(secretDate, service);
    const secretSigning = await crypto.hmacSha256Bytes(secretService, "tc3_request");
    const signature = bytesToHex(
      await crypto.hmacSha256Bytes(secretSigning, stringToSign),
    );

    const authorization =
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=${names.join(";")}, Signature=${signature}`;

    return {
      date,
      credentialScope,
      hashedRequestPayload: payloadHash,
      canonicalRequest,
      hashedCanonicalRequest: canonicalRequestHash,
      stringToSign,
      signature,
      authorization,
      headers: {
        Authorization: authorization,
        "Content-Type": CONTENT_TYPE,
        Host: host,
        "X-TC-Action": action,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": version,
        "X-TC-Region": region,
      },
    };
  }

  // --- audio helpers -------------------------------------------------------

  function normalizeRegion(region) {
    return speechTranscription.normalizeRegion(region, DEFAULTS.region);
  }

  function normalizeEngineModelType(engineModelType) {
    const trimmed = typeof engineModelType === "string" ? engineModelType.trim() : "";
    return trimmed || DEFAULTS.engineModelType;
  }

  /**
   * Maps the Segment audio's MIME type / file name to a documented
   * VoiceFormat value (wav, pcm, ogg-opus, speex, silk, mp3, m4a, aac,
   * amr). MediaRecorder's default webm/opus output is an EBML container
   * that is NOT in Tencent's documented list; it is optimistically labeled
   * "ogg-opus" here, and the capture layer must produce a documented
   * container for real calls (needs validation against the live API).
   */
  function detectVoiceFormat(segmentAudio) {
    return speechTranscription.detectCloudAudioFormat(segmentAudio, {
      opusFormat: "ogg-opus",
      fallback: "wav",
    });
  }

  async function bytesToBase64(bytes) {
    return speechTranscription.bytesToBase64(bytes);
  }

  /**
   * Transcribes one Segment's audio through Tencent Cloud SentenceRecognition
   * (one sentence per request, so one Segment becomes one request). The
   * single Transcript record starts at 0 (segment-relative, like Groq
   * records) and its duration covers the Segment: the capture layer may set
   * `ytdSegmentDuration` (seconds) on the audio Blob; otherwise the
   * provider-reported AudioDuration (ms) is used; otherwise 0. The #11
   * interface has no way to pass the Segment duration explicitly — this
   * Blob-property convention is documented here rather than changing the
   * frozen seam. Tencent's response carries no language, so records omit it.
   *
   * @param {Blob} segmentAudio - the Segment's audio
   * @param {{secretId?: string, secretKey?: string, region?: string, engineModelType?: string}} credentials
   * @param {typeof fetch} [fetchImpl] - injectable for tests; defaults to fetch
   * @returns {Promise<Array<{text: string, start: number, duration: number}>>}
   */
  async function transcribe(segmentAudio, credentials = {}, fetchImpl = fetch) {
    const secretId =
      typeof credentials.secretId === "string" ? credentials.secretId.trim() : "";
    const secretKey =
      typeof credentials.secretKey === "string" ? credentials.secretKey.trim() : "";
    if (!secretId || !secretKey) {
      throw new Error("Tencent Speech Provider requires SecretId and SecretKey");
    }

    const audioBytes = new Uint8Array(await segmentAudio.arrayBuffer());
    const payload = JSON.stringify({
      ProjectId: 0,
      SubServiceType: 2,
      EngSerViceType: normalizeEngineModelType(credentials.engineModelType),
      SourceType: 1,
      VoiceFormat: detectVoiceFormat(segmentAudio),
      Data: await bytesToBase64(audioBytes),
      DataLen: audioBytes.byteLength,
    });

    const signed = await signRequest({
      secretId,
      secretKey,
      service: SERVICE,
      host: HOST,
      action: ACTION,
      version: VERSION,
      region: normalizeRegion(credentials.region),
      payload,
    });

    const response = await fetchImpl(`https://${HOST}/`, {
      method: "POST",
      headers: signed.headers,
      body: payload,
    });
    if (!response.ok) {
      throw new Error(
        `Tencent Speech Provider request failed with HTTP ${response.status}`,
      );
    }

    const json = await response.json();
    const error = json?.Response?.Error;
    if (error) {
      throw new Error(
        `Tencent Speech Provider error ${error.Code}: ${error.Message}`,
      );
    }

    const text = String(json?.Response?.Result || "").trim();
    if (!text) return [];

    const segmentHint = Number(segmentAudio?.ytdSegmentDuration);
    const audioDurationMs = Number(json?.Response?.AudioDuration);
    const duration =
      Number.isFinite(segmentHint) && segmentHint > 0
        ? Math.floor(segmentHint)
        : Number.isFinite(audioDurationMs) && audioDurationMs > 0
          ? Math.floor(audioDurationMs / 1000)
          : 0;

    return [{ text, start: 0, duration }];
  }

  return {
    id: ID,
    label: LABEL,
    credentialFields: CREDENTIAL_FIELDS,
    defaults: DEFAULTS,
    helpLink: "https://console.cloud.tencent.com/cam/capi",
    transcribe,
    // Exposed for unit tests and debugging: the pure TC3 signing stages.
    signRequest,
    crypto,
  };
})();

YTD_SPEECH_PROVIDERS.registerSpeechProvider(YTD_SPEECH_PROVIDER_TENCENT);

// --- Aliyun (Alibaba Cloud) NLS ASR (一句话识别 RESTful API) ---------------
//
// Aliyun's one-sentence recognition REST API accepts a recorded audio
// segment over a single HTTP POST (binary body), which fits the Speech
// Provider seam: one Segment's audio becomes exactly one request. Limits
// per the published API contract (help.aliyun.com/zh/isi/user-guide/
// restful-api-2): audio ≤ 1 minute, mono 16-bit, formats pcm / wav /
// opus / speex / amr / mp3 / aac, sample rate 8000 or 16000 Hz — shorter
// than the default Segment length, so the capture layer must slice
// smaller Segments for this provider (Segment length is
// provider-dependent per the glossary).
//
// Auth is two-step, mirroring the Tencent provider's credential model:
// the long-term AccessKey ID/Secret pair signs a CreateToken RPC request
// (nls-meta.<region>.aliyuncs.com, Action CreateToken, Version
// 2019-02-28) with the POP RPC signature (SignatureMethod HMAC-SHA1,
// SignatureVersion 1.0); the returned short-lived Token is then sent as
// the X-NLS-Token header on the audio request. The token is cached per
// AccessKey until the provider-reported ExpireTime, per the token
// documentation — no fixed lifetime is assumed.
//
// The signing core below is a pure function over strings plus an
// injectable HMAC-SHA1 seam so it runs on both node:crypto (tests, Node)
// and Web Crypto (service worker). The official documentation's worked
// example is pinned in tests/aliyun-asr.test.js.

var YTD_SPEECH_PROVIDER_ALIYUN = (() => {
  // Shared pure helpers (crypto loader, base64, region, audio-format
  // cascade) live in speech-transcription.js; in Node tests we require
  // them, in the service worker both globals arrive via importScripts.
  const speechTranscription =
    typeof YTD_SPEECH_TRANSCRIPTION !== "undefined"
      ? YTD_SPEECH_TRANSCRIPTION
      : require("./speech-transcription.js");

  const ID = "aliyun";
  const LABEL = "Aliyun ASR (NLS)";

  const TOKEN_ACTION = "CreateToken";
  const TOKEN_VERSION = "2019-02-28";
  const GATEWAY_PATH = "/stream/v1/asr";
  const SUCCESS_STATUS = 20000000;

  const CREDENTIAL_FIELDS = [
    // The AccessKey pair is masked and required on save, like Tencent's
    // SecretId/SecretKey; see the options page's password-field check.
    { key: "accessKeyId", type: "password" },
    { key: "accessKeySecret", type: "password" },
    // The AppKey is a per-project identifier, not a secret, but typing it
    // as a password reuses the save-time required-field check — it is
    // mandatory for every ASR request.
    { key: "appKey", type: "password" },
    { key: "region", type: "text" },
  ];

  const DEFAULTS = Object.freeze({
    accessKeyId: "",
    accessKeySecret: "",
    appKey: "",
    region: "cn-shanghai",
  });

  // --- crypto seam ---------------------------------------------------------

  const nodeCrypto = speechTranscription.loadNodeCrypto();

  /**
   * Platform HMAC-SHA1 primitive. hmacSha1Bytes(key, message) — key
   * first, message second, matching the POP signing pseudocode and
   * RFC 2202. Keys may be strings or byte arrays.
   */
  const crypto = (() => {
    if (nodeCrypto) {
      return {
        async hmacSha1Bytes(key, string) {
          return nodeCrypto.createHmac("sha1", key).update(string, "utf8").digest();
        },
      };
    }
    // globalThis.crypto, NOT the bare name `crypto`: this IIFE is the
    // initializer of `const crypto` below, so a bare reference here would
    // hit the temporal dead zone in the service worker (node:crypto exists
    // in Node tests and masks it — the SW load path is what must work).
    const webCrypto = globalThis.crypto;
    if (webCrypto && webCrypto.subtle) {
      const subtle = webCrypto.subtle;
      const encoder = new TextEncoder();
      return {
        async hmacSha1Bytes(key, string) {
          const keyBytes = typeof key === "string" ? encoder.encode(key) : key;
          const cryptoKey = await subtle.importKey(
            "raw",
            keyBytes,
            { name: "HMAC", hash: "SHA-1" },
            false,
            ["sign"],
          );
          const signature = await subtle.sign(
            "HMAC",
            cryptoKey,
            encoder.encode(string),
          );
          return new Uint8Array(signature);
        },
      };
    }
    throw new Error(
      "Aliyun Speech Provider needs node:crypto or Web Crypto (crypto.subtle)",
    );
  })();

  // --- POP RPC signing (pure composition over the crypto seam) -------------

  /**
   * POP percent-encoding: UTF-8 percent-encoding where space becomes
   * %20 (not "+"), "*" becomes %2A, and "~" stays unescaped
   * (help.aliyun.com/zh/link-wan/developer-reference/043ed9 and the
   * official pop-core SDK).
   */
  function percentEncode(value) {
    return encodeURIComponent(String(value))
      .replace(/\+/g, "%20")
      .replace(/\*/g, "%2A")
      .replace(/%7E/g, "~");
  }

  function bytesToBase64(bytes) {
    return speechTranscription.bytesToBase64(bytes);
  }

  function isoTimestamp(date) {
    // 2019-01-20T12:00:00Z — the POP contract has no fractional seconds.
    return date.toISOString().replace(/\.\d+Z$/, "Z");
  }

  function randomNonce() {
    const globalCrypto = globalThis.crypto;
    if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
      return globalCrypto.randomUUID();
    }
    return `nonce-${Date.now()}-${Math.floor(Math.random() * 1e12)}`;
  }

  /**
   * Signs one Aliyun POP RPC GET request (the shape CreateToken uses).
   * Pure composition: every stage is observable in the returned object,
   * and the official documentation's worked example is pinned in
   * tests/aliyun-asr.test.js. NOTE: the doc renders StringToSign with
   * literal "&" separators, but the published signature is only
   * reproduced when the canonicalized query string — separators
   * included — is percent-encoded a second time as a whole (matching the
   * official pop-core SDK), so that rendering is not followed.
   *
   * @param {object} options
   * @param {string} options.accessKeyId
   * @param {string} options.accessKeySecret
   * @param {string} options.action - RPC action, e.g. "CreateToken"
   * @param {string} options.version - API version, e.g. "2019-02-28"
   * @param {string} options.regionId - e.g. "cn-shanghai"
   * @param {Object<string, string>} [options.params] - extra RPC parameters
   * @param {string} [options.timestamp] - ISO 8601 UTC; defaults to now
   * @param {string} [options.signatureNonce] - defaults to a random UUID
   * @returns {Promise<object>} signing stages plus the request URL
   */
  async function signRequest(options) {
    const {
      accessKeyId,
      accessKeySecret,
      action,
      version,
      regionId,
      params = {},
      timestamp = isoTimestamp(new Date()),
      signatureNonce = randomNonce(),
    } = options;

    const host = `nls-meta.${regionId}.aliyuncs.com`;
    const allParams = {
      AccessKeyId: accessKeyId,
      Action: action,
      RegionId: regionId,
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: signatureNonce,
      SignatureVersion: "1.0",
      Timestamp: timestamp,
      Version: version,
      ...params,
    };
    const names = Object.keys(allParams).sort();
    const canonicalizedQueryString = names
      .map((name) => `${percentEncode(name)}=${percentEncode(allParams[name])}`)
      .join("&");
    const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonicalizedQueryString)}`;
    const signature = bytesToBase64(
      await crypto.hmacSha1Bytes(`${accessKeySecret}&`, stringToSign),
    );

    const signedParams = { ...allParams, Signature: signature };
    const queryString = Object.keys(signedParams)
      .sort()
      .map((name) => `${percentEncode(name)}=${percentEncode(signedParams[name])}`)
      .join("&");

    return {
      host,
      timestamp,
      signatureNonce,
      canonicalizedQueryString,
      stringToSign,
      signature,
      queryString,
      url: `https://${host}/?${queryString}`,
    };
  }

  // --- audio + region helpers ----------------------------------------------

  function normalizeRegion(region) {
    return speechTranscription.normalizeRegion(region, DEFAULTS.region);
  }

  /**
   * Maps the Segment audio's MIME type / file name to a documented
   * format value (pcm, wav, opus, speex, amr, mp3, aac). MediaRecorder's
   * default webm/opus output is an EBML container that is NOT in the
   * documented list; it is optimistically labeled "opus" here, and the
   * capture layer must produce a documented container for real calls
   * (same deviation as the Tencent provider; needs validation against
   * the live API).
   */
  function detectAudioFormat(segmentAudio) {
    return speechTranscription.detectCloudAudioFormat(segmentAudio, {
      opusFormat: "opus",
      fallback: "pcm",
    });
  }

  // --- token handling ------------------------------------------------------

  // Single-entry cache, keyed by AccessKey ID + region, holding the
  // provider-reported ExpireTime (Unix seconds). Reused until one minute
  // before expiry, per the token documentation ("根据返回的 ExpireTime 判断
  // 有效期", no fixed lifetime assumed).
  let tokenCache = null;

  async function fetchToken(accessKeyId, accessKeySecret, regionId, fetchImpl) {
    const now = Math.floor(Date.now() / 1000);
    if (
      tokenCache &&
      tokenCache.accessKeyId === accessKeyId &&
      tokenCache.regionId === regionId &&
      tokenCache.expireTime - 60 > now
    ) {
      return tokenCache.token;
    }

    const signed = await signRequest({
      accessKeyId,
      accessKeySecret,
      action: TOKEN_ACTION,
      version: TOKEN_VERSION,
      regionId,
    });
    const response = await fetchImpl(signed.url, { method: "GET" });
    if (!response.ok) {
      throw new Error(
        `Aliyun Speech Provider token request failed with HTTP ${response.status}`,
      );
    }
    const json = await response.json();
    const token = json?.Token?.Id;
    if (!token) {
      throw new Error(
        `Aliyun Speech Provider token response missing Token.Id (Code: ${json?.Code || "none"})`,
      );
    }
    const expireTime = Number(json?.Token?.ExpireTime);
    tokenCache = {
      accessKeyId,
      regionId,
      token,
      expireTime: Number.isFinite(expireTime) ? expireTime : 0,
    };
    return token;
  }

  /**
   * Transcribes one Segment's audio through Aliyun NLS one-sentence
   * recognition (one sentence per request, so one Segment becomes one
   * request, preceded when needed by one CreateToken request). The
   * single Transcript record starts at 0 (segment-relative, like Groq
   * and Tencent records) and its duration covers the Segment: the
   * capture layer may set `ytdSegmentDuration` (seconds) on the audio
   * Blob; otherwise 0 — unlike Tencent's SentenceRecognition, the NLS
   * response carries no audio duration. The #11 interface has no way to
   * pass the Segment duration explicitly — this Blob-property convention
   * is documented here rather than changing the frozen seam. The NLS
   * response carries no language, so records omit it.
   *
   * @param {Blob} segmentAudio - the Segment's audio
   * @param {{accessKeyId?: string, accessKeySecret?: string, appKey?: string, region?: string}} credentials
   * @param {typeof fetch} [fetchImpl] - injectable for tests; defaults to fetch
   * @returns {Promise<Array<{text: string, start: number, duration: number}>>}
   */
  async function transcribe(segmentAudio, credentials = {}, fetchImpl = fetch) {
    const accessKeyId =
      typeof credentials.accessKeyId === "string" ? credentials.accessKeyId.trim() : "";
    const accessKeySecret =
      typeof credentials.accessKeySecret === "string"
        ? credentials.accessKeySecret.trim()
        : "";
    const appKey = typeof credentials.appKey === "string" ? credentials.appKey.trim() : "";
    if (!accessKeyId || !accessKeySecret) {
      throw new Error(
        "Aliyun Speech Provider requires AccessKey ID and AccessKey Secret",
      );
    }
    if (!appKey) {
      throw new Error("Aliyun Speech Provider requires an AppKey");
    }
    const regionId = normalizeRegion(credentials.region);

    const token = await fetchToken(accessKeyId, accessKeySecret, regionId, fetchImpl);
    const audioBytes = new Uint8Array(await segmentAudio.arrayBuffer());

    const host = `nls-gateway-${regionId}.aliyuncs.com`;
    const query = [
      `appkey=${percentEncode(appKey)}`,
      `format=${detectAudioFormat(segmentAudio)}`,
      "sample_rate=16000",
      "enable_punctuation_prediction=true",
      "enable_inverse_text_normalization=true",
    ].join("&");
    const response = await fetchImpl(`https://${host}${GATEWAY_PATH}?${query}`, {
      method: "POST",
      headers: {
        "X-NLS-Token": token,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(audioBytes.byteLength),
      },
      body: audioBytes,
    });
    if (!response.ok) {
      throw new Error(
        `Aliyun Speech Provider request failed with HTTP ${response.status}`,
      );
    }

    const json = await response.json();
    if (json?.status === undefined) {
      throw new Error("Aliyun Speech Provider returned an unrecognized response");
    }
    if (json.status !== SUCCESS_STATUS) {
      throw new Error(
        `Aliyun Speech Provider error ${json?.status}: ${json?.message || "unknown"}`,
      );
    }

    const text = String(json?.result || "").trim();
    if (!text) return [];

    const segmentHint = Number(segmentAudio?.ytdSegmentDuration);
    const duration =
      Number.isFinite(segmentHint) && segmentHint > 0 ? Math.floor(segmentHint) : 0;

    return [{ text, start: 0, duration }];
  }

  return {
    id: ID,
    label: LABEL,
    credentialFields: CREDENTIAL_FIELDS,
    defaults: DEFAULTS,
    helpLink: "https://nls-portal.console.aliyun.com/applist",
    transcribe,
    // Exposed for unit tests and debugging: the pure POP signing stages.
    signRequest,
    crypto,
  };
})();

YTD_SPEECH_PROVIDERS.registerSpeechProvider(YTD_SPEECH_PROVIDER_ALIYUN);

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SPEECH_PROVIDERS;
}
