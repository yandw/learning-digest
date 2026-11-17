/**
 * 重新获取字幕 recheck flow (0.2.32): the panel header button's
 * side-effect-free captions probe. handleRecheckCaptions re-runs the same
 * observation path as the 开始学习 probe (probeCaptionsForTab — direct
 * bridge read plus the youtube PO-token authorized re-read) without creating
 * a Session or archiving anything, and answers the verdict the button puts
 * on its own label: 有字幕 (track + segment count) or 无字幕 (the reader's
 * reason). Harness pattern: plugin-yt-captions-flow.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

const YT_WATCH = "https://www.youtube.com/watch?v=AbCdEfGh123";
const BILI_WATCH = "https://www.bilibili.com/video/BV1xx411c7mD";
const PLAIN_PAGE = "https://example.com/article";

const SEGMENTS = [
  { startMs: 0, endMs: 1200, text: "大家好" },
  { startMs: 1200, endMs: 2400, text: "今天我们讲字幕" },
];
const CAPTIONS_AVAILABLE = {
  success: true,
  available: true,
  segments: SEGMENTS,
  track: { language: "zh-Hans", asr: false, autoTranslated: false },
};

/** The MAIN-world captionTracks the live-source read answers with. */
const PLAYER_TRACKS = [
  {
    baseUrl:
      "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=zh-Hans",
    languageCode: "zh-Hans",
    kind: "asr",
  },
];

/** A player-issued timedtext request URL the PO-token capture returns. */
const CAPTURED_PLAYER_REQUEST_URL =
  "https://www.youtube.com/api/timedtext?v=AbCdEfGh123&lang=en" +
  "&pot=pot-token&c=WEB&cver=2.20261116.00.00";

test("recheck: a non-video page answers ok:false without probing", async () => {
  const tabMessages = [];
  const bg = loadBackgroundHelpers({ tabMessages });
  const result = await bg.handleRecheckCaptions({
    tabId: 42,
    url: PLAIN_PAGE,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /不是支持字幕检测的视频页/);
  // The honest refusal probed nothing.
  assert.equal(tabMessages.length, 0);
});

test("recheck: a missing tabId refuses without touching the page", async () => {
  const tabMessages = [];
  const bg = loadBackgroundHelpers({ tabMessages });
  const result = await bg.handleRecheckCaptions({ url: YT_WATCH });
  assert.equal(result.ok, false);
  assert.equal(tabMessages.length, 0);
});

test("recheck: captions available answers the verdict with track and count", async () => {
  const bg = loadBackgroundHelpers({
    tabMessageImpl: (message) =>
      message.action === "getYouTubeCaptions"
        ? CAPTIONS_AVAILABLE
        : { success: true },
  });
  const result = await bg.handleRecheckCaptions({ tabId: 7, url: YT_WATCH });
  // Field-by-field, not deepEqual: the answer is built in the VM sandbox,
  // whose Object.prototype differs from this realm's.
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.reason, null);
  assert.equal(result.track.language, "zh-Hans");
  assert.equal(result.track.asr, false);
  assert.equal(result.segmentCount, 2);
  assert.equal(result.captionsEnabledBySite, true);
  // The verdict lands in the breadcrumb channel for after-the-fact traces.
  const breadcrumb = bg.readStored("ytd_last_caption_recheck");
  assert.equal(breadcrumb.available, true);
  assert.equal(breadcrumb.url, YT_WATCH);
});

test("recheck: 无字幕 carries the reader's reason", async () => {
  const bg = loadBackgroundHelpers({
    tabMessageImpl: (message) =>
      message.action === "getYouTubeCaptions"
        ? { success: true, available: false, reason: "no_subtitle_track" }
        : { success: true },
  });
  const result = await bg.handleRecheckCaptions({ tabId: 7, url: BILI_WATCH });
  assert.equal(result.ok, true);
  assert.equal(result.available, false);
  assert.equal(result.reason, "no_subtitle_track");
  // The panel-facing label is the worker-side translation (the panel file
  // stays free of the reader's internal codes).
  assert.match(result.reasonLabel, /字幕轨道/);
  assert.equal(result.segmentCount, 0);
  const breadcrumb = bg.readStored("ytd_last_caption_recheck");
  assert.equal(breadcrumb.reason, "no_subtitle_track");
});

test("recheck: a gate-emptied direct read wins through the PO-token retry", async () => {
  const tabMessages = [];
  const bg = loadBackgroundHelpers({
    tabMessages,
    // The MAIN-world seam serves BOTH the live caption-source read (one
    // arg) and the PO-token capture (two args), like the real injection.
    executeScriptImpl: async ({ func, args }) => {
      if (args.length === 1) {
        return [
          {
            result: {
              videoId: "AbCdEfGh123",
              source: "main_player_response",
              captionTracks: PLAYER_TRACKS,
            },
          },
        ];
      }
      return [{ result: CAPTURED_PLAYER_REQUEST_URL }];
    },
    tabMessageImpl: (message) => {
      if (message.action === "getYouTubeCaptions") {
        // The direct (unauthorized) read: candidates existed, every body
        // gate-emptied — the 5.7 retry trigger.
        return { success: true, available: false, reason: "timedtext_failed" };
      }
      if (message.action === "getYouTubeCaptionsAuthorized") {
        assert.equal(message.playerRequestUrl, CAPTURED_PLAYER_REQUEST_URL);
        return CAPTIONS_AVAILABLE;
      }
      return { success: true };
    },
  });
  const result = await bg.handleRecheckCaptions({ tabId: 7, url: YT_WATCH });
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.segmentCount, 2);
  assert.equal(result.track.language, "zh-Hans");
  // The authorized re-read rode the bridge as its own command, after the
  // gate-emptied direct read.
  const actions = tabMessages.map((m) => m.action);
  assert.ok(actions.includes("getYouTubeCaptions"));
  assert.ok(actions.includes("getYouTubeCaptionsAuthorized"));
  const breadcrumb = bg.readStored("ytd_last_caption_recheck");
  assert.equal(breadcrumb.available, true);
});
