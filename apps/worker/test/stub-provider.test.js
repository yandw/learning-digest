/**
 * Stub Speech Provider (ticket 2.3; Testing Decisions: a replacement
 * Speech Provider makes tests repeatable).
 *
 * Seam: provider.transcribe() — same interface the real Qwen provider
 * implements. Deterministic sample text and timestamps so every run is
 * repeatable; a zero-byte audio input models a silence segment.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStubProvider } = require("../lib/providers/stub");

test("stub provider: transcribes one segment into a deterministic record", async () => {
  const provider = createStubProvider();
  const records = await provider.transcribe({
    audioBase64: Buffer.from("fake audio bytes").toString("base64"),
    audioMimeType: "audio/webm;codecs=opus",
    segment: { segmentIndex: 3, startMs: 90000, endMs: 120000 },
  });

  // Segment-relative milliseconds: runOnce folds them onto the source
  // timeline, so the provider itself never knows absolute positions.
  assert.deepEqual(records, [
    { startMs: 0, endMs: 30000, text: "stub 转写文本（第 3 段）" },
  ]);

  // Repeatable: the same input yields the same output.
  const again = await provider.transcribe({
    audioBase64: Buffer.from("fake audio bytes").toString("base64"),
    audioMimeType: "audio/webm;codecs=opus",
    segment: { segmentIndex: 3, startMs: 90000, endMs: 120000 },
  });
  assert.deepEqual(records, again);
});

test("stub provider: zero-byte audio is a silence segment (empty records)", async () => {
  const provider = createStubProvider();
  const records = await provider.transcribe({
    audioBase64: "",
    audioMimeType: "audio/webm;codecs=opus",
    segment: { segmentIndex: 0, startMs: 0, endMs: 30000 },
  });
  assert.deepEqual(records, []);
});
