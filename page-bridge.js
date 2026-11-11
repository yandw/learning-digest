/**
 * Page bridge (content script; injected on xiaoe-tech, bilibili, youtube and
 * xiaohongshu playback pages — P10b, #63).
 *
 * The Source Platform registry decides page kinds purely from the URL, but
 * replay and video pages need VIDEO-position timestamps and media-end
 * detection, which only page code can see. This bridge reports the primary
 * media element's position to the service worker once a second; the
 * segment scheduler (session-segmenter.js) turns that position stream into
 * Segments. Live pages need none of this (wall-clock elapsed), so missing
 * media is not an error here — the bridge simply stays quiet on positions.
 *
 * Every page kind also reports document.title — once at startup and again
 * on pagehide (#32) — so the Session knows the page's title for the report
 * header; the background keeps only the first report.
 *
 * All four stations play through a standard HTMLVideoElement (bilibili,
 * xiaohongshu and youtube each expose one to the DOM), so position reading
 * and playback control stay element-generic: the per-station differences
 * live in the manifest's match patterns and the Source Platform adapters,
 * not here.
 *
 * P10b additions (#63):
 * - every mediaPosition report carries pageUrl (the bridge's location.href).
 *   A bilibili episode switch (?p=N) or any in-page navigation changes it
 *   without a document reload, so the stream itself distinguishes episodes;
 *   the episode→Source semantics stay with P11/P10's course-switch logic.
 * - the seekMedia command: currentTime assignment + a play() attempt that
 *   tolerates autoplay-policy rejection, for P11 resume positioning.
 *
 * Ticket 2.5 (#68) addition:
 * - the getBilibiliCaptions command: the frame that can see a bilibili
 *   subtitle track list answers with the caption reader's result (async).
 *   The reader lives in bilibili-captions.js (loaded before this file in
 *   the manifest; injectable as env.createCaptionReader for tests).
 *
 * Structure: YTD_PAGE_BRIDGE.createPageBridge(env) builds every behavior
 * over an injected DOM/chrome/timer environment so the Node tests drive the
 * SAME code the content script runs (tests/page-bridge.test.js, hand-stubbed
 * DOM — no jsdom). The auto-start block below is the shipped wiring.
 */
var YTD_PAGE_BRIDGE = (() => {
  const POSITION_INTERVAL_MS = 1000;

  /**
   * @param {object} env
   * @param {Document} env.document
   * @param {Window} env.window
   * @param {{runtime: object}} env.chrome
   * @param {Function} [env.setInterval] injectable for tests
   * @param {Console} [env.console] injectable for tests
   */
  function createPageBridge(env) {
    const doc = env.document;
    const win = env.window;
    const runtime = env.chrome.runtime;
    const scheduleInterval = env.setInterval || ((fn, ms) => setInterval(fn, ms));
    const log = env.console || console;

    /** The "primary" media: these pages can mount several video elements
     *  (previews, ads); the largest visible one is the one being watched. */
    function findPrimaryMedia() {
      const candidates = [...doc.querySelectorAll("video")].filter(
        (video) => video.readyState >= 1 && video.videoWidth > 0,
      );
      if (candidates.length === 0) return null;
      return candidates.reduce((largest, video) =>
        video.videoWidth * video.videoHeight >
        largest.videoWidth * largest.videoHeight
          ? video
          : largest,
      );
    }

    let bridgedMedia = null;

    /**
     * The caption reader (Ticket 2.5, #68): created lazily over this
     * bridge's own document/window so the reader shares the page state the
     * position stream reads. The factory comes from the env injection
     * (tests) or the bilibili-captions.js global (the shipped manifest
     * loads it before this file); absent means the command stays ignored.
     */
    let captionReader = null;
    function getCaptionReader() {
      if (captionReader) return captionReader;
      const factory =
        env.createCaptionReader ||
        (typeof YTD_BILIBILI_CAPTIONS !== "undefined" && YTD_BILIBILI_CAPTIONS
          ? YTD_BILIBILI_CAPTIONS.createBilibiliCaptionReader
          : null);
      if (typeof factory !== "function") return null;
      try {
        captionReader = factory({ document: doc, window: win });
      } catch (_error) {
        return null;
      }
      return captionReader || null;
    }

    /** (Re)binds the seek listeners to the current primary media: a drag is
     *  reported the moment the player starts seeking, not up to a second
     *  later at the next poll. Old listeners come off the previous element. */
    function attachMediaListeners(media) {
      if (bridgedMedia === media) return;
      if (bridgedMedia) {
        bridgedMedia.removeEventListener("seeking", reportPosition);
        bridgedMedia.removeEventListener("seeked", reportPosition);
      }
      bridgedMedia = media;
      if (media) {
        media.addEventListener("seeking", reportPosition);
        media.addEventListener("seeked", reportPosition);
        if (!attachMediaListeners.logged) {
          attachMediaListeners.logged = true;
          log.debug(
            `[LD bridge] 已绑定视频元素 ${media.videoWidth}x${media.videoHeight}`,
          );
        }
      }
    }

    let loggedNoMedia = false;

    function reportPosition() {
      const media = findPrimaryMedia();
      if (!media) {
        if (!loggedNoMedia) {
          loggedNoMedia = true;
          log.debug(
            "[LD bridge] 未找到可上报的视频元素（readyState/videoWidth 过滤），位置流暂停",
          );
        }
        return;
      }
      loggedNoMedia = false;
      attachMediaListeners(media);
      let message;
      try {
        message = {
          action: "mediaPosition",
          position: Number(media.currentTime) || 0,
          // duration is Infinity for live streams; JSON has no Infinity, so
          // report null there — the registry already said "wallclock".
          duration: Number.isFinite(media.duration) ? media.duration : null,
          paused: media.paused,
          ended: media.ended,
          // P10b: the page URL rides the stream. An in-page episode switch
          // (bilibili ?p=N) changes it without a document reload.
          pageUrl: String(win.location && win.location.href) || "",
        };
      } catch (_error) {
        // A detached or mid-navigation element must never break the bridge.
        return;
      }
      try {
        runtime.sendMessage(message, () => void runtime.lastError);
      } catch (_error) {
        // Extension context invalidated (reload/update) — the bridge is done.
      }
    }

    /** The page title for the report header (#32), sent unconditionally:
     *  live pages have no position stream but do have a title. */
    function reportPageTitle() {
      let message;
      try {
        message = { action: "pageTitle", title: doc.title };
      } catch (_error) {
        // A mid-navigation document has no title to give; never break the bridge.
        return;
      }
      try {
        runtime.sendMessage(message, () => void runtime.lastError);
      } catch (_error) {
        // Extension context invalidated (reload/update) — the bridge is done.
      }
    }

    /**
     * Playback control. The content script shares the DOM with the page, so
     * driving the primary media element needs no page-world eval.
     * - restartFromBeginning (0.1.63): the panel's 从头开始 button.
     * - getMediaPosition (P12): the one-shot position sample for notes.
     * - seekMedia (P10b, #63): resume positioning for P11 — positionMs →
     *   currentTime, clamped to the duration, plus a play() attempt whose
     *   autoplay-policy rejection does not fail the (already landed) seek.
     * - getBilibiliCaptions (Ticket 2.5, #68): the caption reader's stage —
     *   the frame that can see a subtitle track list answers (async: the
     *   subtitle body may need a fetch); frames without any subtitle source
     *   stay silent so only the owning frame's answer reaches the sender.
     *
     * With all_frames injection the message reaches every frame; frames
     * without media stay silent (return false) so only the frame holding
     * the player answers and the worker takes its response.
     *
     * @returns {boolean} true when an async response is held open
     *   (getBilibiliCaptions only); every other response is synchronous.
     */
    function handleMessage(message, sendResponse) {
      if (message?.action === "getBilibiliCaptions") {
        return handleCaptionsRequest(message, sendResponse);
      }
      const isSeek = message?.action === "seekMedia";
      if (!isSeek && message?.action !== "restartFromBeginning" && message?.action !== "getMediaPosition") {
        return false;
      }
      const media = findPrimaryMedia();
      if (!media) {
        // Silent no-response: only the frame holding the player should answer.
        return false;
      }
      try {
        if (message.action === "getMediaPosition") {
          sendResponse({
            success: true,
            position: Number(media.currentTime) || 0,
            duration: Number.isFinite(media.duration) ? media.duration : null,
            paused: media.paused,
            ended: media.ended,
          });
          return false;
        }
        const duration = Number(media.duration);
        let positionSeconds;
        if (isSeek) {
          const requested = Number(message.positionMs) / 1000;
          if (!Number.isFinite(requested) || requested < 0) {
            sendResponse({ success: false, error: "invalid positionMs" });
            return false;
          }
          positionSeconds =
            Number.isFinite(duration) && duration > 0
              ? Math.min(requested, duration)
              : requested;
        } else {
          positionSeconds = 0;
        }
        media.currentTime = positionSeconds;
        // The seeking/seeked listeners above report the landing immediately;
        // play() may reject under autoplay policy — the seek already landed,
        // so report success either way.
        const playing = media.play();
        if (playing && typeof playing.catch === "function") playing.catch(() => {});
        sendResponse(
          isSeek
            ? { success: true, position: positionSeconds }
            : { success: true },
        );
      } catch (error) {
        sendResponse({ success: false, error: error?.message || String(error) });
      }
      return false;
    }

    /**
     * Ticket 2.5 (#68): the getBilibiliCaptions command. The caption reader
     * (bilibili-captions.js, loaded before this file in the manifest) probes
     * the page's subtitle sources; only a frame that can see a track list
     * answers — the same only-the-owning-frame rule the media commands
     * follow, extended to the async case with a held-open sendResponse.
     * A reader failure answers available:false with an explicit reason: a
     * failed read can never read as "captions found".
     */
    function handleCaptionsRequest(message, sendResponse) {
      const reader = getCaptionReader();
      if (!reader) return false;
      let probe;
      try {
        probe = reader.probe();
      } catch (_error) {
        probe = { present: false, source: null };
      }
      if (!probe || !probe.present) return false;
      const options = {};
      if (message.intervalStartMs !== undefined) options.intervalStartMs = message.intervalStartMs;
      if (message.intervalEndMs !== undefined) options.intervalEndMs = message.intervalEndMs;
      reader
        .read(options)
        .then((result) => {
          sendResponse({ success: true, ...result });
        })
        .catch((_error) => {
          sendResponse({ success: true, available: false, reason: "subtitle_read_failed" });
        });
      return true;
    }

    /** The shipped content-script wiring: one message listener, the 1s
     *  position cadence, and the pagehide flushes. */
    function start() {
      runtime.onMessage.addListener(handleMessage);
      log.debug("[LD bridge] 已注入，开始每秒上报播放位置");
      scheduleInterval(reportPosition, POSITION_INTERVAL_MS);
      win.addEventListener("pagehide", reportPosition);
      win.addEventListener("pagehide", reportPageTitle);
    }

    return {
      reportPosition,
      reportPageTitle,
      handleMessage,
      start,
    };
  }

  return { createPageBridge, POSITION_INTERVAL_MS };
})();

// Content-script auto-start: only a page world with the extension runtime
// wires the bridge. Node (module.exports) and non-extension contexts skip it,
// so requiring this file never schedules a timer or touches chrome.
if (
  typeof document !== "undefined" &&
  typeof window !== "undefined" &&
  typeof chrome !== "undefined" &&
  chrome &&
  chrome.runtime &&
  chrome.runtime.onMessage
) {
  YTD_PAGE_BRIDGE.createPageBridge({
    document,
    window,
    chrome,
  }).start();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_PAGE_BRIDGE;
}
