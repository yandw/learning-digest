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
 * on pagehide (#32) — so the Session knows the lesson's name for the
 * report header; the background keeps only the first report.
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
     *  (previews, ads); the largest visible one is the lesson. */
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

    /** The lesson title for the report header (#32), sent unconditionally:
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
     *
     * With all_frames injection the message reaches every frame; frames
     * without media stay silent (return false) so only the frame holding
     * the player answers and the worker takes its response.
     *
     * @returns {boolean} false: every response is synchronous.
     */
    function handleMessage(message, sendResponse) {
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
