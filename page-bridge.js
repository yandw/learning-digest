/**
 * Page bridge (content script, xiaoe-tech pages only).
 *
 * The Source Platform registry decides page kinds purely from the URL, but
 * replay and course pages need VIDEO-position timestamps and media-end
 * detection, which only page code can see. This bridge reports the primary
 * media element's position to the service worker once a second; the
 * segment scheduler (session-segmenter.js) turns that position stream into
 * Segments. Live pages need none of this (wall-clock elapsed), so missing
 * media is not an error here — the bridge simply stays quiet.
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

  function reportPosition() {
    const media = findPrimaryMedia();
    if (!media) return;
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

  setInterval(reportPosition, POSITION_INTERVAL_MS);
  window.addEventListener("pagehide", reportPosition);
})();
