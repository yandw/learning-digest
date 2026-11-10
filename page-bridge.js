/**
 * Page bridge (content script, xiaoe-tech pages only).
 *
 * The Source Platform registry decides page kinds purely from the URL, but
 * replay and course pages need VIDEO-position timestamps and media-end
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
 * Browser-only by design: not unit-tested (see the spec's Testing
 * Decisions); verified manually per docs/agents verification checklist.
 */
(() => {
  const POSITION_INTERVAL_MS = 1000;

  /** The "primary" media: xiaoe pages can mount several video elements
   *  (previews, ads); the largest playing one is the lesson. */
  function findPrimaryMedia() {
    const candidates = [...document.querySelectorAll("video")].filter(
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
        console.debug(
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
        console.debug(
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
      };
    } catch (_error) {
      // A detached or mid-navigation element must never break the bridge.
      return;
    }
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch (_error) {
      // Extension context invalidated (reload/update) — the bridge is done.
    }
  }

  /** The lesson title for the report header (#32), sent unconditionally:
   *  live pages have no position stream but do have a title. */
  function reportPageTitle() {
    let message;
    try {
      message = { action: "pageTitle", title: document.title };
    } catch (_error) {
      // A mid-navigation document has no title to give; never break the bridge.
      return;
    }
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch (_error) {
      // Extension context invalidated (reload/update) — the bridge is done.
    }
  }

  // Playback control (#0.1.63): the panel's 从头开始 button rewinds the
  // lesson to 0:00 and plays. The content script shares the DOM with the
  // page, so driving the primary media element needs no page-world eval.
  // Autoplay-started lessons (xiaoe) otherwise lose their first grid cell:
  // the Session opens seconds in, and the anchor snaps UP to a boundary.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "restartFromBeginning") return false;
    const media = findPrimaryMedia();
    if (!media) {
      // Silent no-response: with all_frames injection the message reaches
      // every frame, and only the frame holding the player should answer.
      return false;
    }
    try {
      media.currentTime = 0;
      // The seeking/seeked listeners above report the rewind immediately;
      // play() may reject under autoplay policy — the seek already landed,
      // so report success either way.
      const playing = media.play();
      if (playing && typeof playing.catch === "function") playing.catch(() => {});
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ success: false, error: error?.message || String(error) });
    }
    return false;
  });

  // One-shot position query (P12 notes): the same primary-media source the
  // per-second stream above reads, sampled at the moment the learner saves
  // a note. With all_frames injection the message reaches every frame;
  // frames without media stay silent (return false, like
  // restartFromBeginning) so only the frame holding the player answers and
  // the worker takes its response.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "getMediaPosition") return false;
    const media = findPrimaryMedia();
    if (!media) {
      return false;
    }
    try {
      sendResponse({
        success: true,
        position: Number(media.currentTime) || 0,
        duration: Number.isFinite(media.duration) ? media.duration : null,
        paused: media.paused,
        ended: media.ended,
      });
    } catch (_error) {
      // A detached or mid-navigation element must never break the bridge.
    }
    return false;
  });

  reportPageTitle();
  console.debug("[LD bridge] 已注入，开始每秒上报播放位置");
  setInterval(reportPosition, POSITION_INTERVAL_MS);
  window.addEventListener("pagehide", reportPosition);
  window.addEventListener("pagehide", reportPageTitle);
})();
