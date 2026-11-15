/**
 * Migrated upstream tests (Ticket 2.6, issue #69): the caption-track
 * selection, json3 parsing, fetch fallthrough and player-authorization
 * cases from the youtube-digest repo (~/Workspace/youtube-digest, frozen
 * per ADR 0001). Source files, and what changed in the migration:
 * - tests/caption-selection.test.js — migrated, then REWRITTEN by Ticket
 *   5.3 (issue #85): the selection policy is now 简体CC → 繁体CC → 英文CC →
 *   简体自动 → 繁体自动 → 英文自动 (creator CC beats auto-generated, 其余
 *   语言垫底), translation (tlang) candidates are retired, and a track list
 *   holding only auto-generated (asr) tracks yields no candidates at all —
 *   the fetch stage short-circuits to only_auto_generated_captions because
 *   the PO-token gate empties those timedtext bodies (2026-11-15 real-page
 *   measurement in the ticket).
 * - tests/caption-parsing.test.js — the transcript entries are the contract
 *   shape {startMs, endMs, text} on the source timeline (json3's native
 *   milliseconds) instead of the upstream {text, start, duration, language}
 *   display shape; the transcriptTextPlain/Timestamped display joins are
 *   not part of this repo's contract and are not produced.
 * - tests/caption-fetch.test.js — same fallthrough discipline (rewritten
 *   for the 5.3 direct-track-only candidates); the result's ok flag reads
 *   available, and the NO_SUITABLE_CAPTION verdict reads as the honest
 *   available:false (无字幕).
 * - the withPlayerCaptionAuthorization cases migrate unchanged (the pure
 *   PO-token merge stays as a seam).
 * - tests/player-caption-capture.test.js — the MAIN-world capture migrates
 *   in Ticket 5.7 (issue #96) as capturePlayerCaptionRequest in the reader
 *   module (release.test.js pins the runtime files free of player
 *   internals, so it cannot live in background.js like upstream's). The
 *   tests drive the SAME function object the worker serializes into the
 *   MAIN world: vm.runInNewContext over it, with hand-stubbed
 *   window/document/XMLHttpRequest/timers standing in for the page.
 *
 * All page dependencies are stubbed (hand-rolled fetch doubles — no
 * network, no jsdom), matching the repo's node:test style.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const captions = require("../youtube-captions.js");

// --- selection (Ticket 5.3, issue #85 policy) ----------------------------------
//
// The user-specified total order: 简体CC → 繁体CC → 英文CC → 简体自动 →
// 繁体自动 → 英文自动. Creator-uploaded CC (kind 非 asr) beats the
// auto-generated (kind=asr) track of the same language; every other
// language pads the bottom (CC before asr within it). Only direct tracks
// are candidates — translation (tlang) candidates are retired with the
// policy rewrite.

const native = (languageCode, extra = {}) => ({
  languageCode,
  baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}`,
  isTranslatable: true,
  ...extra,
});
const auto = (languageCode, extra = {}) =>
  native(languageCode, { kind: "asr", ...extra });

test("candidates follow 简体CC → 繁体CC → 英文CC → 简体自动 → 繁体自动 → 英文自动", () => {
  const picked = captions.selectCaptionCandidates([
    auto("en"),
    auto("zh-Hant"),
    auto("zh-Hans"),
    native("en"),
    native("zh-Hant"),
    native("zh-Hans"),
  ]);

  assert.deepEqual(
    picked.map((track) => `${track.kind || "cc"}:${track.languageCode}`),
    ["cc:zh-Hans", "cc:zh-Hant", "cc:en", "asr:zh-Hans", "asr:zh-Hant", "asr:en"],
  );
});

test("other languages pad the bottom: creator CC still beats auto-generated within them", () => {
  const japaneseCC = native("ja");
  const japaneseAsr = auto("ja");
  const picked = captions.selectCaptionCandidates([
    japaneseAsr,
    auto("en"),
    japaneseCC,
    native("zh-Hans"),
  ]);

  assert.deepEqual(
    picked.map((track) => `${track.kind || "cc"}:${track.languageCode}`),
    ["cc:zh-Hans", "asr:en", "cc:ja", "asr:ja"],
  );
});

test("zh-CN and zh-TW rank as 简体/繁体 candidates directly", () => {
  const picked = captions.selectCaptionCandidates([auto("zh-TW"), native("zh-CN")]);

  assert.deepEqual(
    picked.map((track) => `${track.kind || "cc"}:${track.languageCode}`),
    ["cc:zh-CN", "asr:zh-TW"],
  );
  assert.equal(picked[0].isAutoTranslated, undefined);
  assert.equal(picked[0].baseUrl.includes("tlang"), false);
});

test("a creator CC track precedes the auto-generated track of the same language", () => {
  const picked = captions.selectCaptionCandidates([auto("zh-Hans"), native("zh-Hans")]);

  assert.deepEqual(
    picked.map((track) => track.kind || "cc"),
    ["cc", "asr"],
  );
});

test("same-rank tracks keep the player's own order", () => {
  const first = native("en");
  const second = native("en-US");
  const picked = captions.selectCaptionCandidates([first, second]);

  assert.deepEqual(picked, [first, second]);
});

test("only auto-generated tracks yield no candidates at all (the 5.3 short-circuit)", () => {
  assert.deepEqual(captions.selectCaptionCandidates([auto("en")]), []);
  assert.deepEqual(
    captions.selectCaptionCandidates([auto("zh-Hans"), auto("en-US")]),
    [],
  );
});

test("a creator CC track without a baseUrl cannot serve, so only the asr track remains", () => {
  const unusableCC = native("en", { baseUrl: undefined });
  assert.deepEqual(captions.selectCaptionCandidates([unusableCC, auto("en")]), []);
});

test("selection never throws and never invents candidates", () => {
  assert.deepEqual(captions.selectCaptionCandidates(undefined), []);
  assert.deepEqual(captions.selectCaptionCandidates(null), []);
  assert.deepEqual(captions.selectCaptionCandidates([null, 42, "x"]), []);
  assert.deepEqual(captions.selectCaptionCandidates([{ languageCode: "zh-Hans" }]), []);
});

test("hasOnlyAutoGeneratedTracks is the shared short-circuit predicate", () => {
  assert.equal(captions.hasOnlyAutoGeneratedTracks([auto("en")]), true);
  assert.equal(captions.hasOnlyAutoGeneratedTracks([auto("zh-Hans"), auto("en")]), true);
  assert.equal(captions.hasOnlyAutoGeneratedTracks([native("en"), auto("en")]), false);
  assert.equal(captions.hasOnlyAutoGeneratedTracks([native("ja")]), false);
  assert.equal(captions.hasOnlyAutoGeneratedTracks([]), false);
  assert.equal(captions.hasOnlyAutoGeneratedTracks(undefined), false);
});

// --- fetch fallthrough (from caption-fetch.test.js) -----------------------------
//
// The migrated verdicts speak the repo's contract vocabulary: available /
// reason instead of the upstream success / error, and the honest
// available:false stands in for NO_SUITABLE_CAPTION (无字幕 — 不猜、不误报).
// Ticket 5.3 rewrote the candidates to direct tracks only and added the
// only-auto-generated short-circuit.

const track = (languageCode, extra = {}) => ({
  languageCode,
  baseUrl: `https://www.youtube.com/api/timedtext?v=test&lang=${languageCode}`,
  isTranslatable: true,
  ...extra,
});
const json3WithText = (text) => ({
  events: [
    {
      tStartMs: 0,
      dDurationMs: 1000,
      segs: [{ utf8: text }],
    },
  ],
});
const okJson = (json3) => ({ ok: true, json: async () => json3 });

test("an empty higher-priority caption falls through to the next language", async () => {
  const requested = [];
  const routes = {
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hans&fmt=json3":
      okJson({ events: [] }),
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hant&fmt=json3":
      okJson(json3WithText("繁體中文")),
  };
  const result = await captions.fetchCaptionTranscript(
    [track("zh-Hans"), track("zh-Hant")],
    async (url) => {
      requested.push(url);
      return routes[url];
    },
  );

  assert.equal(result.available, true);
  assert.deepEqual(result.track, { language: "zh-Hant", asr: false, autoTranslated: false });
  assert.deepEqual(result.segments, [
    { startMs: 0, endMs: 1000, text: "繁體中文" },
  ]);
  assert.deepEqual(requested, [
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hans&fmt=json3",
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hant&fmt=json3",
  ]);
});

test("empty, malformed, and failed captions fall through to the next candidate", async () => {
  const requested = [];
  const result = await captions.fetchCaptionTranscript(
    [track("zh-Hans"), track("zh-Hant"), track("ja")],
    async (url) => {
      requested.push(url);
      if (url === "https://www.youtube.com/api/timedtext?v=test&lang=ja&fmt=json3") {
        return okJson(json3WithText("日语字幕"));
      }
      if (url.includes("lang=zh-Hant&")) return { ok: false };
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      };
    },
  );

  assert.equal(result.available, true);
  assert.equal(result.track.language, "ja");
  assert.equal(result.track.asr, false);
  assert.equal(result.track.autoTranslated, false);
  assert.deepEqual(result.segments, [
    { startMs: 0, endMs: 1000, text: "日语字幕" },
  ]);
  assert.deepEqual(requested, [
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hans&fmt=json3",
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hant&fmt=json3",
    "https://www.youtube.com/api/timedtext?v=test&lang=ja&fmt=json3",
  ]);
});

test("only auto-generated tracks short-circuit to ASR without a single timedtext request", async () => {
  let fetchCount = 0;
  const result = await captions.fetchCaptionTranscript(
    [auto("en")],
    async () => {
      fetchCount += 1;
      return okJson(json3WithText("unexpected"));
    },
  );

  assert.deepEqual(result, {
    available: false,
    reason: "only_auto_generated_captions",
  });
  assert.equal(fetchCount, 0, "the PO-token-gated fetch is never attempted");
});

test("the only-auto-generated verdict precedes the missing-fetch-seam verdict", async () => {
  const result = await captions.fetchCaptionTranscript([auto("zh-Hans")], undefined);
  assert.deepEqual(result, {
    available: false,
    reason: "only_auto_generated_captions",
  });
});

test("an empty creator CC falls through to the auto-generated track's doomed fetch", async () => {
  const requested = [];
  const result = await captions.fetchCaptionTranscript(
    [auto("zh-Hans"), track("zh-Hans")],
    async (url) => {
      requested.push(url);
      // Both bodies empty: the asr body is the PO-token gate's signature.
      return okJson({ events: [] });
    },
  );

  assert.deepEqual(result, { available: false, reason: "timedtext_failed" });
  // The creator CC (rank 0) is fetched first; the asr track (rank 3) takes
  // the doomed second request before the honest failure.
  assert.deepEqual(requested, [
    "https://www.youtube.com/api/timedtext?v=test&lang=zh-Hans&fmt=json3",
    "https://www.youtube.com/api/timedtext?lang=zh-Hans&fmt=json3",
  ]);
});

test("an auto-generated track still archives when its body is usable", async () => {
  const requested = [];
  const result = await captions.fetchCaptionTranscript(
    [auto("zh-Hans"), track("zh-Hans")],
    async (url) => {
      requested.push(url);
      if (requested.length === 1) return okJson({ events: [] });
      return okJson(json3WithText("自动字幕正文"));
    },
  );

  assert.equal(result.available, true);
  assert.deepEqual(result.track, {
    language: "zh-Hans",
    asr: true,
    autoTranslated: false,
  });
  assert.deepEqual(result.segments, [
    { startMs: 0, endMs: 1000, text: "自动字幕正文" },
  ]);
});

test("no suitable candidates returns 无字幕 without fetching", async () => {
  let fetchCount = 0;
  const result = await captions.fetchCaptionTranscript(
    [track("ja", { baseUrl: undefined })],
    async () => {
      fetchCount += 1;
      return okJson(json3WithText("unexpected"));
    },
  );

  assert.deepEqual(result, { available: false, reason: "no_subtitle_track" });
  assert.equal(fetchCount, 0);
});

test("all empty or failed candidates answer honestly 无字幕", async () => {
  const result = await captions.fetchCaptionTranscript(
    [track("zh-Hans"), track("en")],
    async () => okJson({ events: [] }),
  );

  assert.deepEqual(result, { available: false, reason: "timedtext_failed" });
});

test("a caption URL without a query string uses a question mark for json3", async () => {
  let requestedUrl;
  const result = await captions.fetchCaptionTranscript(
    [track("en", { baseUrl: "https://www.youtube.com/api/timedtext" })],
    async (url) => {
      requestedUrl = url;
      return okJson(json3WithText("English"));
    },
  );

  assert.equal(result.available, true);
  assert.equal(requestedUrl, "https://www.youtube.com/api/timedtext?fmt=json3");
});

test("player authorization is merged without replacing candidate language parameters", () => {
  const candidate =
    "https://www.youtube.com/api/timedtext?v=video&lang=ja&signature=candidate&tlang=zh-Hans";
  const playerRequest =
    "https://www.youtube.com/api/timedtext?v=video&lang=en&potc=1&pot=token&c=WEB&cver=1.2&cplayer=UNIPLAYER&xorb=2&fmt=json3";

  const merged = new URL(
    captions.withPlayerCaptionAuthorization(candidate, playerRequest),
  );
  assert.equal(merged.searchParams.get("v"), "video");
  assert.equal(merged.searchParams.get("lang"), "ja");
  assert.equal(merged.searchParams.get("signature"), "candidate");
  assert.equal(merged.searchParams.get("tlang"), "zh-Hans");
  assert.equal(merged.searchParams.get("potc"), "1");
  assert.equal(merged.searchParams.get("pot"), "token");
  assert.equal(merged.searchParams.get("c"), "WEB");
  assert.equal(merged.searchParams.get("cver"), "1.2");
  assert.equal(merged.searchParams.get("cplayer"), "UNIPLAYER");
  assert.equal(merged.searchParams.get("xorb"), "2");
  assert.equal(merged.searchParams.get("fmt"), null);
});

test("caption fetching can apply player authorization to its request URL", async () => {
  let requestedUrl;
  const playerRequest =
    "https://www.youtube.com/api/timedtext?v=test&lang=en&pot=token&potc=1&c=WEB";
  const result = await captions.fetchCaptionTranscript(
    [track("en")],
    async (url) => {
      requestedUrl = url;
      return okJson(json3WithText("Authorized English"));
    },
    (url) => captions.withPlayerCaptionAuthorization(url, playerRequest),
  );

  assert.equal(result.available, true);
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.searchParams.get("pot"), "token");
  assert.equal(parsed.searchParams.get("potc"), "1");
  assert.equal(parsed.searchParams.get("c"), "WEB");
  assert.equal(parsed.searchParams.get("fmt"), "json3");
});

// --- MAIN-world player caption capture (Ticket 5.7, issue #96) ------------------
//
// The player only puts the PO Token and client parameters on the timedtext
// request it issues itself. capturePlayerCaptionRequest hooks fetch and
// XMLHttpRequest.open, forces one captions toggle so the player sends that
// request, resolves with its URL, then restores both the network functions
// and the user's original caption-switch state. It runs in the page's MAIN
// world, so every test drives it inside a vm context whose globals are the
// stubs — the same free identifiers (window, document, XMLHttpRequest,
// URL, setTimeout, clearTimeout) the injected function resolves there.

const CAPTURED_REQUEST =
  "https://www.youtube.com/api/timedtext?v=KvLw1234567&lang=en&potc=1&pot=token&c=WEB&fmt=json3";

/**
 * The page the capture sees: a subtitles button whose click plays the
 * player (each click flips the switch; switching ON issues the timedtext
 * request, over fetch or XHR per `viaXhr`), and controllable timers —
 * sub-second timers (the 100ms re-enable click) only run at flushTimers(),
 * the capture timeout only at fireTimeouts(), so each test decides when
 * time passes. `playerRequestUrls` lists what the player sends when the
 * switch turns on — only the pot-bearing one for the expected video may
 * finish the capture; an empty list is the no-request timeout path.
 */
function createCaptureHarness({
  captionsInitiallyOn,
  playerRequestUrls = [CAPTURED_REQUEST],
  viaXhr = false,
}) {
  const timers = new Map();
  let nextTimerId = 1;
  const originalFetch = async () => ({ ok: true });
  const window = {
    location: { origin: "https://www.youtube.com" },
    fetch: originalFetch,
  };
  const issuedRequests = [];
  const issuePlayerRequest = (url) => {
    issuedRequests.push(String(url instanceof URL ? url.toString() : url));
    if (viaXhr) {
      void new XMLHttpRequest().open("GET", url);
    } else {
      void window.fetch(url);
    }
  };
  const button = {
    pressed: captionsInitiallyOn,
    getAttribute(name) {
      return name === "aria-pressed" ? String(this.pressed) : null;
    },
    click() {
      this.pressed = !this.pressed;
      if (this.pressed) {
        for (const url of playerRequestUrls) issuePlayerRequest(url);
      }
    },
  };
  class XMLHttpRequest {
    open(method, url) {
      issuedRequests.push(`${method} ${url}`);
    }
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  const sandbox = {
    URL,
    Promise,
    window,
    document: {
      querySelector(selector) {
        return selector === ".ytp-subtitles-button" ? button : null;
      },
    },
    XMLHttpRequest,
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  sandbox.globalThis = sandbox;
  const runTimers = (shouldRun) => {
    for (let round = 0; round < 10; round++) {
      const due = [...timers.entries()].filter(([, timer]) => shouldRun(timer.ms));
      if (due.length === 0) return;
      for (const [, timer] of due) timer.fn();
    }
  };
  return {
    button,
    window,
    document: sandbox.document,
    originalFetch,
    originalOpen,
    XMLHttpRequest,
    issuedRequests,
    /** The player's own sub-second scheduling (the re-enable click). */
    flushTimers() {
      runTimers((ms) => ms < 1000);
    },
    /** The capture timeout's wall-clock expiry. */
    fireTimeouts() {
      runTimers((ms) => ms >= 1000);
    },
    capture(videoId, timeoutMs = 8000) {
      // Rebuild the function INSIDE the context from its own source — the
      // same self-contained source chrome.scripting serializes into the
      // MAIN world. A host-built function object would keep resolving its
      // free identifiers against this module's realm, not the sandbox's.
      sandbox.__videoId = videoId;
      sandbox.__timeoutMs = timeoutMs;
      const fnSource = `(${captions.capturePlayerCaptionRequest.toString()})`;
      return vm.runInNewContext(`${fnSource}(__videoId, __timeoutMs)`, sandbox);
    },
  };
}

test("capturing the player's pot-bearing request restores captions that were originally off", async () => {
  const harness = createCaptureHarness({ captionsInitiallyOn: false });
  const result = await harness.capture("KvLw1234567", 8000);

  assert.equal(result, CAPTURED_REQUEST);
  assert.equal(harness.button.pressed, false, "the switch is restored to off");
  assert.equal(harness.window.fetch, harness.originalFetch);
  assert.equal(harness.XMLHttpRequest.prototype.open, harness.originalOpen);
});

test("capturing leaves captions on when they were already on", async () => {
  // Initially on: capture clicks the switch off, the 100ms re-enable timer
  // clicks it back on (the fresh authorized request), and the switch ends
  // where the user had it. The timer only runs at flushTimers().
  const harness = createCaptureHarness({ captionsInitiallyOn: true });
  const pending = harness.capture("KvLw1234567", 8000);
  assert.equal(harness.button.pressed, false, "the first click toggles off");
  harness.flushTimers();

  assert.equal(await pending, CAPTURED_REQUEST);
  assert.equal(harness.button.pressed, true, "the switch is restored to on");
  assert.equal(harness.window.fetch, harness.originalFetch);
  assert.equal(harness.XMLHttpRequest.prototype.open, harness.originalOpen);
});

test("the XHR open path is captured the same way", async () => {
  const harness = createCaptureHarness({ captionsInitiallyOn: false, viaXhr: true });
  const result = await harness.capture("KvLw1234567", 8000);

  assert.equal(result, CAPTURED_REQUEST);
  assert.equal(harness.XMLHttpRequest.prototype.open, harness.originalOpen);
});

test("a URL-instance input captures the same request URL", async () => {
  const harness = createCaptureHarness({
    captionsInitiallyOn: false,
    playerRequestUrls: [new URL(CAPTURED_REQUEST)],
  });
  assert.equal(await harness.capture("KvLw1234567", 8000), CAPTURED_REQUEST);
});

test("a request for another video, or without pot, never finishes the capture", async () => {
  const harness = createCaptureHarness({
    captionsInitiallyOn: false,
    playerRequestUrls: [
      "https://www.youtube.com/api/timedtext?v=otherVideo1&lang=en&pot=token",
      "https://www.youtube.com/api/timedtext?v=KvLw1234567&lang=en",
    ],
  });
  const pending = harness.capture("KvLw1234567", 8000);
  harness.flushTimers();
  harness.fireTimeouts();
  assert.equal(await pending, null, "only the timeout resolves it, as null");
  assert.equal(harness.button.pressed, false, "the switch is restored to off");
  assert.equal(harness.window.fetch, harness.originalFetch);
});

test("no authorized request at all times out to null with everything restored", async () => {
  const harness = createCaptureHarness({
    captionsInitiallyOn: false,
    playerRequestUrls: [],
  });
  const pending = harness.capture("KvLw1234567", 8000);
  harness.flushTimers();
  harness.fireTimeouts();

  assert.equal(await pending, null);
  assert.equal(harness.button.pressed, false, "the forced enable is undone");
  assert.equal(harness.window.fetch, harness.originalFetch);
  assert.equal(harness.XMLHttpRequest.prototype.open, harness.originalOpen);
});

test("a frame without the subtitles button answers null and touches nothing", async () => {
  const harness = createCaptureHarness({ captionsInitiallyOn: false });
  harness.document.querySelector = () => null;

  assert.equal(await harness.capture("KvLw1234567", 8000), null);
  assert.equal(harness.window.fetch, harness.originalFetch);
  assert.equal(harness.XMLHttpRequest.prototype.open, harness.originalOpen);
});
