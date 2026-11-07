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
   * providerId. Extra arguments are passed through to the provider, so
   * tests can inject a mocked fetch as the third argument.
   *
   * @returns {Promise<Array<{text: string, start: number, duration: number, language?: string}>>}
   */
  async function transcribeSegment(providerId, segmentAudio, credentials, ...rest) {
    const provider = getSpeechProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown Speech Provider: ${providerId}`);
    }
    return provider.transcribe(segmentAudio, credentials, ...rest);
  }

  return {
    registerSpeechProvider,
    getSpeechProvider,
    listSpeechProviders,
    transcribeSegment,
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

  const nodeCrypto = (() => {
    if (typeof require !== "function") return null;
    try {
      return require("node:crypto");
    } catch (_error) {
      return null;
    }
  })();

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
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const subtle = crypto.subtle;
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
    const trimmed = typeof region === "string" ? region.trim() : "";
    return trimmed || DEFAULTS.region;
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
    const type = `${segmentAudio?.type || ""} ${segmentAudio?.name || ""}`.toLowerCase();
    if (type.includes("wav")) return "wav";
    if (type.includes("pcm")) return "pcm";
    if (type.includes("mp3") || type.includes("mpeg")) return "mp3";
    if (type.includes("m4a") || type.includes("mp4")) return "m4a";
    if (type.includes("aac")) return "aac";
    if (type.includes("amr")) return "amr";
    if (type.includes("silk")) return "silk";
    if (type.includes("speex")) return "speex";
    if (type.includes("ogg") || type.includes("opus") || type.includes("webm")) {
      return "ogg-opus";
    }
    return "wav";
  }

  async function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString("base64");
    }
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SPEECH_PROVIDERS;
}
