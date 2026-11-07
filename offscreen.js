/**
 * Offscreen capture document: the MediaRecorder home.
 *
 * MV3 service workers have no DOM, so the actual recording runs here.
 * The service worker owns all timing decisions (the segment scheduler is
 * pure and lives there); this document is a deliberately dumb recorder:
 *
 * - captureStart {streamId, segmentLengthSeconds}: opens the tabCapture
 *   stream handed over from chrome.tabCapture.getMediaStreamId and starts
 *   a MediaRecorder.
 * - captureCut {}: stops the current recorder (one decodable blob per
 *   recorder, the same pattern the pre-strip code used), immediately
 *   starts the next, and responds with the finished chunk as a data URL.
 * - captureStop {}: stops recording and releases the stream.
 *
 * Chunks travel as base64 data URLs because chrome.runtime messages are
 * JSON-serialized (Blobs are not). A backstop self-cut every few segment
 * lengths bounds chunk size when the service worker is suspended, and is
 * pushed to the worker as an unsolicited captureChunk message.
 *
 * Browser-only: not unit-tested (spec Testing Decisions); verified
 * manually per the ticket's checklist.
 */
(() => {
  let stream = null;
  let recorder = null;
  let chunkStartedAtMs = 0;
  let backstopTimer = null;
  let segmentLengthMs = 120_000;

  const MIME_TYPE = "audio/webm;codecs=opus";

  function armBackstop() {
    clearTimeout(backstopTimer);
    // Five segment lengths: far beyond normal cut latency, small enough to
    // stay well under the Speech Provider's upload size limit.
    backstopTimer = setTimeout(() => {
      void cutChunk().then((chunk) => {
        if (!chunk) return;
        try {
          chrome.runtime.sendMessage(
            { action: "captureChunk", ...chunk },
            () => void chrome.runtime.lastError,
          );
        } catch (_error) {
          // Worker gone; nothing useful to do with the chunk anyway.
        }
      });
    }, segmentLengthMs * 5);
  }

  function startRecorder() {
    const options = MediaRecorder.isTypeSupported(MIME_TYPE) ? { mimeType: MIME_TYPE } : undefined;
    recorder = new MediaRecorder(stream, options);
    recorder.start();
    chunkStartedAtMs = Date.now();
    armBackstop();
  }

  function stopRecorder() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        resolve(null);
        return;
      }
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const durationSeconds = Math.max(0, (Date.now() - chunkStartedAtMs) / 1000);
        const blob = new Blob(chunks, { type: mimeType });
        const reader = new FileReader();
        reader.onload = () => resolve({ dataUrl: reader.result, durationSeconds, mimeType });
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      };
      recorder.stop();
    });
  }

  async function startCapture(message, sendResponse) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: message.streamId,
          },
        },
        video: false,
      });
      segmentLengthMs = Math.max(30_000, Number(message.segmentLengthSeconds) || 120) * 1000;
      startRecorder();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ success: false, error: error?.message || String(error) });
    }
  }

  async function cutChunk() {
    if (!stream || !recorder) return null;
    const finished = await stopRecorder();
    if (!finished || !finished.dataUrl) return null;
    startRecorder();
    return finished;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "captureStart") {
      void startCapture(message, sendResponse);
      return true;
    }
    if (message.action === "captureCut") {
      void cutChunk().then((chunk) =>
        sendResponse(chunk || { error: "not recording" }),
      );
      return true;
    }
    if (message.action === "captureStop") {
      clearTimeout(backstopTimer);
      void stopRecorder().then(() => {
        if (stream) {
          for (const track of stream.getTracks()) track.stop();
          stream = null;
        }
        recorder = null;
        sendResponse({ success: true });
      });
      return true;
    }
    return false;
  });
})();
