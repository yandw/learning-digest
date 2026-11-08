/**
 * Realtime WebSocket protocol layer (qwen3-asr-flash-realtime, spec #44 /
 * #46). Pure and require()-able: no chrome or DOM dependencies, so the
 * Node tests cover it fully and offscreen.js consumes it as a plain script.
 *
 * The protocol follows the OpenAI Realtime event style documented for
 * DashScope ("Real-time speech recognition" guide):
 * - client: session.update -> input_audio_buffer.append* -> session.finish
 *   (finish BEFORE closing, or the trailing utterance is discarded)
 * - server: session.created/updated, input_audio_buffer.speech_started/
 *   stopped (absolute stream ms), input_audio_buffer.committed,
 *   conversation.item.input_audio_transcription.text (confirmed `text` +
 *   draft `stash`), ...completed (final `transcript`), ...failed, error,
 *   session.finished.
 *
 * WS frames are hostile input: parsing never throws, anything unmappable
 * becomes { type: "unknown" }.
 */
var YTD_REALTIME_PROTOCOL = (() => {
  // Legacy DashScope domain (spec #44): workspace-specific domains are not
  // in the extension's host_permissions.
  const REALTIME_WS_BASE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
  const REALTIME_MODEL = "qwen3-asr-flash-realtime";

  /**
   * event_id for client events: crypto.randomUUID where it exists (browser
   * contexts), a timestamped counter fallback elsewhere (older Node).
   */
  let eventCounter = 0;
  function nextEventId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    eventCounter += 1;
    return `evt_${Date.now().toString(36)}_${eventCounter}`;
  }

  const KNOWN_EVENT_TYPES = new Set([
    "session.created",
    "session.updated",
    "conversation.item.input_audio_transcription.text",
    "conversation.item.input_audio_transcription.completed",
    "conversation.item.input_audio_transcription.failed",
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.committed",
    "session.finished",
    "error",
  ]);

  /**
   * Parses one raw server frame (a JSON string, or an already-parsed object)
   * into a typed result. Returns { type: "unknown" } for anything it cannot
   * map — malformed JSON, non-objects, absent or non-string types — instead
   * of throwing.
   *
   * @param {string|object|null|undefined} raw
   * @returns {object} a discriminated result carrying the event's fields
   */
  function parseServerEvent(raw) {
    let event = raw;
    if (typeof raw === "string") {
      if (!raw.trim()) return { type: "unknown" };
      try {
        event = JSON.parse(raw);
      } catch (_error) {
        return { type: "unknown" };
      }
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return { type: "unknown" };
    }
    if (typeof event.type !== "string" || !KNOWN_EVENT_TYPES.has(event.type)) {
      return { type: "unknown" };
    }

    switch (event.type) {
      case "session.created":
      case "session.updated":
      case "input_audio_buffer.committed":
      case "session.finished":
        return { type: event.type };
      case "conversation.item.input_audio_transcription.text":
        return {
          type: event.type,
          text: typeof event.text === "string" ? event.text : "",
          stash: typeof event.stash === "string" ? event.stash : "",
        };
      case "conversation.item.input_audio_transcription.completed":
        return {
          type: event.type,
          transcript: typeof event.transcript === "string" ? event.transcript : "",
        };
      case "conversation.item.input_audio_transcription.failed":
        return {
          type: event.type,
          itemId: typeof event.item_id === "string" ? event.item_id : null,
          error: event.error && typeof event.error === "object" ? event.error : null,
        };
      case "input_audio_buffer.speech_started":
        return {
          type: event.type,
          audioStartMs: Number(event.audio_start_ms) || 0,
        };
      case "input_audio_buffer.speech_stopped":
        return {
          type: event.type,
          audioEndMs: Number(event.audio_end_ms) || 0,
        };
      case "error":
        return {
          type: "error",
          code: typeof event.code === "string" ? event.code : null,
          message: typeof event.message === "string" ? event.message : "",
        };
      default:
        return { type: "unknown" };
    }
  }

  /**
   * Builds the session.update that opens every realtime session: PCM input
   * at 16 kHz, Chinese transcription, and the doc-recommended server VAD
   * (threshold 0.0 = most sensitive, 400 ms silence closes an utterance).
   * `eventId` overrides the generated event_id (tests pass a literal).
   */
  function buildSessionUpdate(eventId = nextEventId()) {
    return {
      event_id: eventId,
      type: "session.update",
      session: {
        input_audio_format: "pcm",
        sample_rate: 16000,
        input_audio_transcription: { language: "zh" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.0,
          silence_duration_ms: 400,
        },
      },
    };
  }

  /**
   * Builds one input_audio_buffer.append carrying a base64-encoded PCM16
   * chunk (see chunkFloat32ToPcm16Base64).
   */
  function buildAppend(base64Audio, eventId = nextEventId()) {
    return {
      event_id: eventId,
      type: "input_audio_buffer.append",
      audio: String(base64Audio || ""),
    };
  }

  /**
   * Builds the session.finish event. It must be sent BEFORE closing the
   * WebSocket: closing without it discards the in-flight (trailing)
   * utterance, losing the session's last spoken sentence.
   */
  function buildFinish(eventId = nextEventId()) {
    return {
      event_id: eventId,
      type: "session.finish",
    };
  }

  /**
   * Stateful utterance timestamp tracker: pairs the server's VAD speech
   * markers (absolute stream ms) with each transcription.completed event to
   * produce the seconds-based { start, duration } a Transcript record needs.
   *
   * The server does not guarantee marker ordering, so completion guards for
   * missing markers: no start marker -> 0; no stop marker -> the last known
   * end (0 if none was ever seen). Durations clamp at 0.5 s so degenerate
   * pairings (or server-clock glitches) still render a visible record.
   */
  function createUtteranceTracker() {
    let startMs = null;
    let endMs = null;
    let lastKnownEndMs = 0;
    return {
      onSpeechStarted(audioStartMs) {
        const value = Number(audioStartMs);
        if (Number.isFinite(value)) startMs = value;
      },
      onSpeechStopped(audioEndMs) {
        const value = Number(audioEndMs);
        if (Number.isFinite(value)) endMs = value;
      },
      /**
       * Consumes one completed event and resets the pairing for the next
       * utterance. Returns { text, startSeconds, durationSeconds }.
       */
      onCompleted(text) {
        const start = startMs === null ? 0 : startMs;
        const end = endMs === null ? lastKnownEndMs : endMs;
        const utterance = {
          text: String(text || ""),
          startSeconds: start / 1000,
          durationSeconds: Math.max(0.5, (end - start) / 1000),
        };
        if (endMs !== null) lastKnownEndMs = endMs;
        startMs = null;
        endMs = null;
        return utterance;
      },
    };
  }

  /**
   * Base64-encodes a byte array on both platforms: Buffer in Node, chunked
   * btoa in the browser (same pattern as speech-transcription.js's
   * bytesToBase64 — String.fromCharCode with a spread blows the stack on
   * large arrays, so 0x8000-byte slices keep it safe).
   */
  function bytesToBase64(bytes) {
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
   * Converts one chunk of captured Float32 samples into the base64 PCM16
   * payload an input_audio_buffer.append event carries: each sample clamped
   * to [-1, 1], scaled to signed 16-bit, written little-endian (the byte
   * order DashScope's pcm input expects on all mainstream platforms).
   */
  function chunkFloat32ToPcm16Base64(float32Array) {
    if (!float32Array || float32Array.length === 0) return "";
    const bytes = new Uint8Array(float32Array.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < float32Array.length; i++) {
      const clamped = Math.max(-1, Math.min(1, Number(float32Array[i]) || 0));
      view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }
    return bytesToBase64(bytes);
  }

  /**
   * Builds the realtime WebSocket URL. The documented auth is the
   * "Authorization: Bearer <api_key>" HANDSHAKE HEADER (verified during the
   * handshake; missing/invalid key fails with HTTP 401/403), which a browser
   * WebSocket cannot set. The browser-compatible fallback carries the same
   * value as a urlencoded `authorization` query parameter — the mechanism
   * this extension uses; if DashScope rejects it at the handshake, the
   * fallback plan is a header-injecting proxy (out of scope here).
   *
   * @param {string} [baseUrl] - default: the legacy DashScope endpoint
   * @param {string} apiKey - DashScope API key from the captureStart message
   * @param {string} [model] - default: qwen3-asr-flash-realtime
   * @returns {string} wss:// URL with ?model=...&authorization=Bearer%20...
   */
  function buildRealtimeUrl(baseUrl = REALTIME_WS_BASE_URL, apiKey, model = REALTIME_MODEL) {
    const base = String(baseUrl || REALTIME_WS_BASE_URL).replace(/\?.*$/, "");
    return (
      `${base}?model=${encodeURIComponent(model || REALTIME_MODEL)}` +
      `&authorization=${encodeURIComponent(`Bearer ${apiKey || ""}`)}`
    );
  }

  return {
    REALTIME_WS_BASE_URL,
    REALTIME_MODEL,
    nextEventId,
    parseServerEvent,
    buildSessionUpdate,
    buildAppend,
    buildFinish,
    createUtteranceTracker,
    chunkFloat32ToPcm16Base64,
    buildRealtimeUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_REALTIME_PROTOCOL;
}
