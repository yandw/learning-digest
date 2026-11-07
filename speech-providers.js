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

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SPEECH_PROVIDERS;
}
