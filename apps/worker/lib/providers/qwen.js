/**
 * Qwen Speech Provider — Aliyun Bailian qwen3-asr-flash, OpenAI-compatible
 * (ticket 2.3; ported from the PoC speech-providers.js YTD_SPEECH_PROVIDER_QWEN,
 * rewritten for plain Node: no Blob, no importScripts, the audio arrives
 * already base64-encoded from the claim handover).
 *
 * Per the published API contract: one audio segment per chat-completions
 * call, audio rides as a base64 Data URI content part, auth is a single
 * service-scoped Bailian key (Authorization: Bearer). One segment becomes
 * one request; the single transcript record is segment-relative and spans
 * the whole segment (the worker's segment bounds replace the PoC's
 * ytdSegmentDuration Blob hint). Language is pinned to zh per the
 * product's Chinese-only contract.
 */

const DEFAULTS = Object.freeze({
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3-asr-flash",
});

function normalizeBaseUrl(baseUrl) {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  return (trimmed || DEFAULTS.baseUrl).replace(/\/+$/, "");
}

function normalizeModel(model) {
  const trimmed = typeof model === "string" ? model.trim() : "";
  return trimmed || DEFAULTS.model;
}

/** Port of the PoC's providerHttpError: status + a body slice for triage. */
async function providerHttpError(response) {
  const body =
    typeof response?.text === "function"
      ? await response.text().catch(() => "")
      : "";
  const detail = body ? `: ${body.slice(0, 500)}` : "";
  return new Error(`Qwen Speech Provider request failed with HTTP ${response.status}${detail}`);
}

function createQwenProvider({ apiKey, baseUrl, model, fetchImpl } = {}) {
  const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmedKey) {
    throw new Error("Qwen Speech Provider requires a Bailian API key");
  }
  const doFetch = fetchImpl || fetch;

  async function transcribe({ audioBase64, audioMimeType, segment }) {
    const mediaType = audioMimeType || "audio/mpeg";
    const dataUri = `data:${mediaType};base64,${audioBase64}`;

    const response = await doFetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: normalizeModel(model),
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: dataUri } }],
          },
        ],
        asr_options: { language: "zh", enable_itn: true },
      }),
    });
    if (!response.ok) {
      throw await providerHttpError(response);
    }

    const json = await response.json();
    const message = json?.choices?.[0]?.message;
    const text = String(message?.content || "").trim();
    if (!text) {
      return [];
    }
    return [
      {
        startMs: 0,
        endMs: segment.endMs - segment.startMs,
        text,
      },
    ];
  }

  return { id: "qwen", transcribe };
}

module.exports = { createQwenProvider, DEFAULTS };
