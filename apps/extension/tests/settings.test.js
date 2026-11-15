const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

// --- v5 retirement (ticket 6.6, issue #91): the local AI config is gone ------
//
// The panel's AI (rolling summary, digest, explain) runs server-side through
// the learning service (contract-r4 §6/§7), so the plugin's config face
// carries no AI provider fields anymore. Like the v4 ASR-key retirement, the
// fields are simply not emitted: a stored blob's keys are dropped on the
// next read+persist, and the version bump marks the retirement.

test("the v5 retirement drops the whole local AI config (ticket 6.6)", () => {
  const stored = settings.normalize({
    settingsVersion: 4,
    provider: "deepseek",
    aiApiKey: "sk-gone",
    aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aiModel: "qwen3.8-flash",
    segmentLengthSeconds: 45,
    summaryIntervalMinutes: 30,
    apiBaseUrl: "https://api.example.com",
    webAppBaseUrl: "https://learn.example.com",
  });

  assert.equal(stored.settingsVersion, 5);
  assert.equal("provider" in stored, false);
  assert.equal("aiApiKey" in stored, false);
  assert.equal("aiBaseUrl" in stored, false);
  assert.equal("aiModel" in stored, false);
  // The non-AI settings survive the migration untouched.
  assert.equal(stored.segmentLengthSeconds, 45);
  assert.equal(stored.summaryIntervalMinutes, 30);
  assert.equal(stored.apiBaseUrl, "https://api.example.com");
  assert.equal(stored.webAppBaseUrl, "https://learn.example.com");

  // The same for an unstamped blob: the keys never come back, and a fresh
  // default blob never carries them at all.
  const unstamped = settings.normalize({
    aiApiKey: "sk-legacy",
    aiBaseUrl: "https://openrouter.ai/api/v1",
    aiModel: "deepseek/deepseek-v4.1-flash-1017",
  });
  assert.equal(unstamped.settingsVersion, 5);
  assert.equal("aiApiKey" in unstamped, false);
  assert.equal("aiBaseUrl" in unstamped, false);
  assert.equal("aiModel" in unstamped, false);

  const fresh = settings.normalize({});
  assert.equal("provider" in fresh, false);
  assert.equal("aiApiKey" in fresh, false);
  assert.equal("aiBaseUrl" in fresh, false);
  assert.equal("aiModel" in fresh, false);
  // The retired helpers are gone with the config face.
  assert.equal(settings.chatCompletionsUrl, undefined);
  assert.equal(settings.isValidAiBaseUrl, undefined);
  assert.equal(settings.migrateLegacyCustom, undefined);
});

// --- Segment length ------------------------------------------------------------

test("Segment length defaults to 30 seconds", () => {
  const normalized = settings.normalize({});

  assert.equal(normalized.segmentLengthSeconds, 30);
});

test("Segment length is clamped into the supported 5-60 range", () => {
  assert.equal(settings.normalize({ segmentLengthSeconds: 1 }).segmentLengthSeconds, 5);
  assert.equal(settings.normalize({ segmentLengthSeconds: 5 }).segmentLengthSeconds, 5);
  assert.equal(settings.normalize({ segmentLengthSeconds: 30 }).segmentLengthSeconds, 30);
  assert.equal(settings.normalize({ segmentLengthSeconds: 60 }).segmentLengthSeconds, 60);
  assert.equal(settings.normalize({ segmentLengthSeconds: 600 }).segmentLengthSeconds, 60);
  assert.equal(settings.normalize({ segmentLengthSeconds: 3600 }).segmentLengthSeconds, 60);
  assert.equal(settings.normalize({ segmentLengthSeconds: 45 }).segmentLengthSeconds, 45);
});

test("malformed Segment length falls back to the default", () => {
  for (const bad of ["abc", null, undefined, NaN, Infinity, {}]) {
    assert.equal(
      settings.normalize({ segmentLengthSeconds: bad }).segmentLengthSeconds,
      30,
      String(bad),
    );
  }
});

// --- Topic timeline cadence ----------------------------------------------------

test("Topic timeline interval defaults to 15 minutes", () => {
  const normalized = settings.normalize({});

  assert.equal(normalized.summaryIntervalMinutes, 15);
});

test("Topic timeline interval is clamped into the supported 5-180 range", () => {
  assert.equal(settings.normalize({ summaryIntervalMinutes: 1 }).summaryIntervalMinutes, 5);
  assert.equal(settings.normalize({ summaryIntervalMinutes: 5 }).summaryIntervalMinutes, 5);
  assert.equal(settings.normalize({ summaryIntervalMinutes: 15 }).summaryIntervalMinutes, 15);
  assert.equal(settings.normalize({ summaryIntervalMinutes: 180 }).summaryIntervalMinutes, 180);
  assert.equal(settings.normalize({ summaryIntervalMinutes: 240 }).summaryIntervalMinutes, 180);
});

test("malformed Topic timeline interval falls back to the default", () => {
  for (const bad of ["abc", null, undefined, NaN, Infinity, {}]) {
    assert.equal(
      settings.normalize({ summaryIntervalMinutes: bad }).summaryIntervalMinutes,
      15,
      String(bad),
    );
  }
});

test("a legacy blob with the old default Segment length migrates to 30", () => {
  // 0.1.41: stored 120s blobs predate the 0.1.39 default change and the
  // field has no options UI, so the stored value is never a user choice.
  const normalized = settings.normalize({ segmentLengthSeconds: 120 });

  assert.equal(normalized.segmentLengthSeconds, 30);
  assert.equal(normalized.settingsVersion, 5);
});

test("a stamped blob keeps a hand-tuned Segment length", () => {
  // A v2 stamp (0.1.41-0.1.50) is below the current version, but 45 was
  // never a shipped default, so the hand-tuned value passes through and the
  // blob is re-stamped to the current version.
  const normalized = settings.normalize({
    settingsVersion: 2,
    segmentLengthSeconds: 45,
  });

  assert.equal(normalized.segmentLengthSeconds, 45);
  assert.equal(normalized.settingsVersion, 5);
});

test("an unstamped blob with a hand-tuned Segment length keeps it", () => {
  const normalized = settings.normalize({ segmentLengthSeconds: 45 });

  assert.equal(normalized.segmentLengthSeconds, 45);
});

// --- Learning service origins (P6): API + Web authorization page ------------

test("learning service URLs default to the local dev servers", () => {
  const normalized = settings.normalize({});
  assert.equal(normalized.apiBaseUrl, "http://127.0.0.1:8787");
  assert.equal(normalized.webAppBaseUrl, "http://127.0.0.1:8080");
});

test("custom learning service URLs are preserved and normalized", () => {
  const normalized = settings.normalize({
    apiBaseUrl: "https://api.example.com/",
    webAppBaseUrl: "  https://learn.example.com  ",
  });
  assert.equal(normalized.apiBaseUrl, "https://api.example.com");
  assert.equal(normalized.webAppBaseUrl, "https://learn.example.com");
});

test("invalid learning service URLs fall back to the dev defaults", () => {
  const normalized = settings.normalize({
    apiBaseUrl: "not a url",
    webAppBaseUrl: "https://",
  });
  assert.equal(normalized.apiBaseUrl, settings.DEFAULTS.apiBaseUrl);
  assert.equal(normalized.webAppBaseUrl, settings.DEFAULTS.webAppBaseUrl);
});

test("learning service URLs accept plain http only on loopback", () => {
  assert.equal(
    settings.normalize({ apiBaseUrl: "http://192.168.1.5:8787" }).apiBaseUrl,
    settings.DEFAULTS.apiBaseUrl,
    "a LAN http origin is rejected",
  );
  assert.equal(
    settings.normalize({ apiBaseUrl: "http://localhost:8787" }).apiBaseUrl,
    "http://localhost:8787",
    "localhost http is allowed (self-hosted dev)",
  );
});
