/**
 * Realtime WebSocket protocol layer (spec #44 / #46): server-event parsing,
 * client-event builders, utterance timestamp pairing, PCM chunk framing, and
 * the browser-compatible WS URL builder — all pure, all Node-tested. The
 * browser-only WebSocket/AudioContext wiring lives in offscreen.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const protocol = require("../realtime-protocol.js");

// --- Server-event parsing: WS frames are hostile input, never throw ---------

test("parseServerEvent maps the transcription partial event to text and stash", () => {
  const parsed = protocol.parseServerEvent(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.text",
      text: "已确认的前缀",
      stash: "草稿后缀",
    }),
  );
  assert.equal(parsed.type, "conversation.item.input_audio_transcription.text");
  assert.equal(parsed.text, "已确认的前缀");
  assert.equal(parsed.stash, "草稿后缀");
});

test("parseServerEvent maps the completed event to its transcript", () => {
  const parsed = protocol.parseServerEvent(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "整句转写结果。",
    }),
  );
  assert.equal(parsed.type, "conversation.item.input_audio_transcription.completed");
  assert.equal(parsed.transcript, "整句转写结果。");
});

test("parseServerEvent maps the failed event to item id and error", () => {
  const parsed = protocol.parseServerEvent(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item_9",
      error: { code: "transcribe_failed", message: "boom" },
    }),
  );
  assert.equal(parsed.type, "conversation.item.input_audio_transcription.failed");
  assert.equal(parsed.itemId, "item_9");
  assert.equal(parsed.error.code, "transcribe_failed");
});

test("parseServerEvent maps the VAD speech markers to stream milliseconds", () => {
  const started = protocol.parseServerEvent(
    JSON.stringify({
      type: "input_audio_buffer.speech_started",
      audio_start_ms: 12_500,
    }),
  );
  assert.equal(started.type, "input_audio_buffer.speech_started");
  assert.equal(started.audioStartMs, 12_500);

  const stopped = protocol.parseServerEvent(
    JSON.stringify({
      type: "input_audio_buffer.speech_stopped",
      audio_end_ms: 18_000,
    }),
  );
  assert.equal(stopped.type, "input_audio_buffer.speech_stopped");
  assert.equal(stopped.audioEndMs, 18_000);
});

test("parseServerEvent maps session lifecycle events", () => {
  assert.equal(
    protocol.parseServerEvent(JSON.stringify({ type: "session.created" })).type,
    "session.created",
  );
  assert.equal(
    protocol.parseServerEvent(JSON.stringify({ type: "session.updated" })).type,
    "session.updated",
  );
  assert.equal(
    protocol.parseServerEvent(JSON.stringify({ type: "input_audio_buffer.committed" }))
      .type,
    "input_audio_buffer.committed",
  );
  assert.equal(
    protocol.parseServerEvent(JSON.stringify({ type: "session.finished" })).type,
    "session.finished",
  );
});

test("parseServerEvent maps the error event to a code and message", () => {
  const parsed = protocol.parseServerEvent(
    JSON.stringify({ type: "error", code: "invalid_session", message: "bad session" }),
  );
  assert.equal(parsed.type, "error");
  assert.equal(parsed.code, "invalid_session");
  assert.equal(parsed.message, "bad session");
});

test("parseServerEvent returns unknown for malformed and hostile frames", () => {
  // Not JSON, not an object, missing type, wrong types: all land on unknown.
  assert.equal(protocol.parseServerEvent("not json {").type, "unknown");
  assert.equal(protocol.parseServerEvent("42").type, "unknown");
  assert.equal(protocol.parseServerEvent("null").type, "unknown");
  assert.equal(protocol.parseServerEvent(JSON.stringify({ nope: true })).type, "unknown");
  assert.equal(protocol.parseServerEvent(JSON.stringify({ type: 42 })).type, "unknown");
  assert.equal(protocol.parseServerEvent("").type, "unknown");
  assert.equal(protocol.parseServerEvent(undefined).type, "unknown");
  assert.equal(protocol.parseServerEvent(null).type, "unknown");
});

// --- Client-event builders: exact shapes per the DashScope docs -------------

test("buildSessionUpdate sends pcm 16kHz, zh transcription and doc-recommended server VAD", () => {
  const event = protocol.buildSessionUpdate("evt-test");
  assert.deepEqual(event, {
    event_id: "evt-test",
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
  });
});

test("buildAppend wraps the base64 audio chunk", () => {
  const event = protocol.buildAppend("QUJD", "evt-2");
  assert.deepEqual(event, {
    event_id: "evt-2",
    type: "input_audio_buffer.append",
    audio: "QUJD",
  });
});

test("buildFinish emits the pre-close flush event", () => {
  const event = protocol.buildFinish("evt-3");
  assert.deepEqual(event, {
    event_id: "evt-3",
    type: "session.finish",
  });
});

test("builders fill event_id with a unique value when none is passed", () => {
  const events = [
    protocol.buildSessionUpdate(),
    protocol.buildAppend("QQ=="),
    protocol.buildFinish(),
  ];
  for (const event of events) {
    assert.equal(typeof event.event_id, "string");
    assert.ok(event.event_id.length > 0);
  }
  const ids = new Set(events.map((event) => event.event_id));
  assert.equal(ids.size, 3, "generated event ids are unique");
});

// --- Utterance timestamp pairing: speech_started/stopped ms -> seconds ------

test("the tracker pairs speech markers into a seconds-based utterance", () => {
  const tracker = protocol.createUtteranceTracker();
  tracker.onSpeechStarted(12_500);
  tracker.onSpeechStopped(18_000);
  assert.deepEqual(tracker.onCompleted("整句结果。"), {
    text: "整句结果。",
    startSeconds: 12.5,
    durationSeconds: 5.5,
  });
});

test("the tracker clamps utterance duration at 0.5s minimum", () => {
  const tracker = protocol.createUtteranceTracker();
  tracker.onSpeechStarted(10_000);
  tracker.onSpeechStopped(10_100); // 100 ms spoken
  const utterance = tracker.onCompleted("短句");
  assert.equal(utterance.durationSeconds, 0.5);
  assert.equal(utterance.startSeconds, 10);
});

test("a completed event without speech_started starts at 0", () => {
  const tracker = protocol.createUtteranceTracker();
  tracker.onSpeechStopped(4_000); // end marker without a start marker
  const utterance = tracker.onCompleted("没有起点的句子");
  assert.equal(utterance.startSeconds, 0);
  assert.equal(utterance.durationSeconds, 4);
});

test("a completed event without speech_stopped falls back to the last known end", () => {
  const tracker = protocol.createUtteranceTracker();
  tracker.onSpeechStarted(1_000);
  tracker.onSpeechStopped(3_000);
  tracker.onCompleted("第一句");
  // Second utterance: server sent only a start marker, no stop marker.
  tracker.onSpeechStarted(8_000);
  const utterance = tracker.onCompleted("第二句");
  assert.equal(utterance.startSeconds, 8);
  // Duration falls back to the last known end (3s) -> clamped to 0.5s min.
  assert.equal(utterance.durationSeconds, 0.5);
});

test("a completed event with no markers at all lands at 0 with the minimum duration", () => {
  const tracker = protocol.createUtteranceTracker();
  assert.deepEqual(tracker.onCompleted("裸完成事件"), {
    text: "裸完成事件",
    startSeconds: 0,
    durationSeconds: 0.5,
  });
});

test("the tracker resets after each completed utterance", () => {
  const tracker = protocol.createUtteranceTracker();
  tracker.onSpeechStarted(1_000);
  tracker.onSpeechStopped(4_000);
  tracker.onCompleted("第一句");
  tracker.onSpeechStarted(10_000);
  tracker.onSpeechStopped(13_500);
  const second = tracker.onCompleted("第二句");
  assert.equal(second.startSeconds, 10);
  assert.equal(second.durationSeconds, 3.5);
});

// --- PCM framing: Float32 samples -> base64 little-endian PCM16 -------------

test("chunkFloat32ToPcm16Base64 encodes known samples to little-endian PCM16", () => {
  // Hand-derived int16 LE bytes: 0 -> 0x0000, 0.5 -> 0.5*0x7FFF truncated to
  // 0x3FFF, -0.5 -> -0.5*0x8000 = 0xC000, 1 -> 0x7FFF.
  const base64 = protocol.chunkFloat32ToPcm16Base64(new Float32Array([0, 0.5, -0.5, 1]));
  assert.equal(
    base64,
    Buffer.from([0x00, 0x00, 0xff, 0x3f, 0x00, 0xc0, 0xff, 0x7f]).toString("base64"),
  );
});

test("chunkFloat32ToPcm16Base64 clamps samples outside [-1, 1]", () => {
  const base64 = protocol.chunkFloat32ToPcm16Base64(new Float32Array([1.5, -1.5]));
  assert.equal(
    base64,
    Buffer.from([0xff, 0x7f, 0x00, 0x80]).toString("base64"),
  );
});

test("chunkFloat32ToPcm16Base64 encodes an empty chunk as an empty string", () => {
  assert.equal(protocol.chunkFloat32ToPcm16Base64(new Float32Array(0)), "");
  assert.equal(protocol.chunkFloat32ToPcm16Base64(null), "");
});

// --- WS URL builder: browser-compatible auth --------------------------------

test("buildRealtimeUrl appends the model and the urlencoded Bearer key", () => {
  assert.equal(
    protocol.buildRealtimeUrl(
      protocol.REALTIME_WS_BASE_URL,
      "sk-test-key",
      "qwen3-asr-flash-realtime",
    ),
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime" +
      "?model=qwen3-asr-flash-realtime&authorization=Bearer%20sk-test-key",
  );
});

test("buildRealtimeUrl defaults to the legacy endpoint and realtime model", () => {
  assert.equal(
    protocol.buildRealtimeUrl(undefined, "sk-abc"),
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime" +
      "?model=qwen3-asr-flash-realtime&authorization=Bearer%20sk-abc",
  );
});

test("buildRealtimeUrl encodes special characters in the key", () => {
  assert.match(
    protocol.buildRealtimeUrl(undefined, "a/b+c=d"),
    /authorization=Bearer%20a%2Fb%2Bc%3Dd$/,
  );
});
