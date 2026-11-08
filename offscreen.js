/**
 * Offscreen capture document: the MediaRecorder home AND, since #46, the
 * realtime WebSocket client.
 *
 * MV3 service workers have no DOM, so the actual recording runs here.
 * The service worker owns all timing decisions (the segment scheduler is
 * pure and lives there); this document is a deliberately dumb recorder:
 *
 * - captureStart {streamId, segmentLengthSeconds, mode, transcribeMode,
 *   apiKey}: opens the tabCapture stream handed over from
 *   chrome.tabCapture.getMediaStreamId, starts a playback loopback (a
 *   consumed tab is muted for the user, which would mean a silent lesson),
 *   then branches:
 *   - transcribeMode "segment" (default): starts a MediaRecorder — the
 *     unchanged pre-0.1.44 path. mode is "wallclock" (live) or "video"
 *     (replay/course): wallclock Sessions cut on a regular interval HERE,
 *     because the MV3 service worker is suspended after ~30 s of inactivity
 *     and nothing wakes it on a live page; video Sessions are cut by the
 *     worker following media position instead.
 *   - transcribeMode "realtime" (qwen3-asr-flash-realtime, spec #44): NO
 *     recorder and no cut timers. Instead an AudioContext resamples the
 *     stream to 16 kHz mono and a ScriptProcessor pump emits ~100 ms PCM16
 *     chunks over a WebSocket to DashScope
 *     (wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...). Server
 *     events stream back to the worker as unsolicited realtimePartial /
 *     realtimeUtterance / realtimeError messages; captureStop sends
 *     session.finish and waits for session.finished (2 s timeout) before
 *     closing, because closing first discards the trailing utterance.
 * - captureCut {}: stops the current recorder (one decodable blob per
 *   recorder, the same pattern the pre-strip code used), immediately
 *   starts the next, and responds with the finished chunk as a data URL.
 *   In realtime mode there is no recorder; the worker's request answers
 *   { error: "not recording" } (segment scheduling is disabled in realtime
 *   mode by the pipeline ticket that owns utterance handling).
 * - captureCadence {mode}: re-arms (or disarms) the regular wall-clock cut
 *   mid-Session; the worker sends it when a wallclock Session anchors to
 *   the video timeline (#48) and position-driven cuts take over.
 * - captureStop {}: stops recording/pumping and releases the stream.
 *
 * Realtime auth: the docs verify "Authorization: Bearer <api_key>" during
 * the WebSocket handshake (HTTP 401/403 otherwise), but a browser
 * WebSocket cannot set handshake headers. The key therefore travels as the
 * urlencoded query parameter buildRealtimeUrl appends
 * (?authorization=Bearer%20...); if DashScope rejects that at the
 * handshake, the fallback plan is a header-injecting proxy. The key comes
 * in the captureStart message only and is never persisted.
 *
 * Chunks travel as base64 data URLs because chrome.runtime messages are
 * JSON-serialized (Blobs are not). A backstop self-cut every few segment
 * lengths bounds chunk size when the service worker is suspended, and is
 * pushed to the worker as an unsolicited captureChunk message; the
 * wallclock regular cut uses the same unsolicited channel.
 *
 * A capture stream can die mid-Session (the course tab is closed or
 * navigated away, leaving the tabCapture stream inactive forever). Every
 * later recorder start would then throw NotSupportedError, so startRecorder
 * guards for it and throws a clear error instead; the self-cut and
 * captureCut paths turn that rejection into a one-shot unsolicited
 * captureEnded notice to the worker (which auto-ends the Session) and shut
 * everything down so nothing keeps failing after death. The realtime pump
 * detects the same death via stream.active on every audio callback.
 *
 * Realtime reconnect: a WebSocket close while the Session is active
 * reconnects with bounded backoff (500 ms doubling, capped 5 s); after 5
 * failed attempts the realtime path shuts down entirely (WebSocket and
 * capture released, lesson audio back on the speakers) and one
 * realtimeGaveUp message tells the worker, which auto-ends the Session
 * honestly — the learner keeps the transcript collected so far and the
 * digest built from it. Audio is dropped while disconnected. A failed
 * utterance (conversation.item.input_audio_transcription.failed) is NOT a
 * connection failure: when the tracker holds the item's speech pairing it
 * lands as a realtimeUtterance with failed: true — the same failure-marker
 * record shape the segment path uses — and realtimeError stays reserved
 * for connection-level failures.
 *
 * Browser-only: WebSocket/AudioContext are DOM APIs, so the realtime wiring
 * is not unit-tested (spec Testing Decisions); the pure protocol layer it
 * calls lives in realtime-protocol.js and is fully Node-tested. Manual
 * verification checklist:
 * 1. Qwen provider + 实时转写 + a live page: starting a Session opens the
 *    WS (offscreen console shows the realtime open log) and sends
 *    session.update; NO MediaRecorder starts.
 * 2. Speaking produces realtimePartial drafts and, per VAD utterance, one
 *    realtimeUtterance with start/duration in seconds.
 * 3. The lesson stays audible exactly once: the pump routes through a zero
 *    gain node and must never double the playback loopback.
 * 4. Drop the network mid-Session: reconnect attempts at 500 ms / 1 s /
 *    2 s / 4 s / 5 s, then the Session auto-ends with the panel notice
 *    实时转写连接失败，会话自动结束。(one realtimeGaveUp to the worker)
 *    and the digest is built from the transcript collected so far.
 * 4b. A transcription.failed server event (no network problem): the
 *     utterance lands in the transcript as a [实时转写失败] failure-marker
 *     record instead of alerting; only connection failures alert.
 * 5. End learning: session.finish goes out BEFORE ws.close(), ideally after
 *    session.finished (2 s timeout fallback), and the document releases
 *    everything (no leaked AudioContext/timers).
 * 6. Regression: a 分段转写 Session still records and cuts exactly as in
 *    0.1.43 — no WebSocket, no pump.
 */
(() => {
  let stream = null;
  let recorder = null;
  let playbackContext = null;
  let chunkStartedAtMs = 0;
  let backstopTimer = null;
  let regularCutTimer = null;
  let segmentLengthMs = 30_000;
  // The realtime WebSocket session (#46), null in segment mode.
  let realtimeSession = null;

  const MIME_TYPE = "audio/webm;codecs=opus";

  // Realtime pump tuning: the ScriptProcessor hands us 4096-sample blocks
  // (256 ms at 16 kHz); ~100 ms append chunks match the docs' example of
  // 3200-byte PCM16 payloads every 100 ms.
  const REALTIME_PUMP_BUFFER_SIZE = 4096;
  const REALTIME_CHUNK_SECONDS = 0.1;
  // Bounded reconnect backoff while the Session is active: 500 ms doubling,
  // capped at 5 s, five attempts, then one loud realtimeError and silence.
  const REALTIME_RECONNECT_BASE_MS = 500;
  const REALTIME_RECONNECT_MAX_MS = 5_000;
  const REALTIME_MAX_RECONNECTS = 5;
  // session.finish must be sent before closing or the trailing utterance is
  // discarded (spec #44); this bounds how long we wait for session.finished.
  const REALTIME_FINISH_TIMEOUT_MS = 2_000;

  // While a tab's stream is being consumed its audio no longer plays for
  // the user (same rule as getDisplayMedia's suppressLocalAudioPlayback).
  // For a learning tool that means a silent lesson, so route the captured
  // audio back to the speakers. Requires the AUDIO_PLAYBACK offscreen
  // reason (declared by the service worker) to pass autoplay policy.
  function startPlaybackLoop() {
    try {
      playbackContext = new AudioContext();
      const source = playbackContext.createMediaStreamSource(stream);
      source.connect(playbackContext.destination);
    } catch (_error) {
      playbackContext = null;
    }
  }

  function stopPlaybackLoop() {
    if (!playbackContext) return;
    try {
      playbackContext.close();
    } catch (_error) {
      // Already closed; nothing to release.
    }
    playbackContext = null;
  }

  // One-shot death notice to the worker: the capture stream is gone for
  // good, so the worker auto-ends the Session instead of zombie-ing.
  // Best-effort: the worker may be gone too; lastError is tolerated.
  function notifyCaptureEnded(reason) {
    try {
      chrome.runtime.sendMessage(
        { action: "captureEnded", reason },
        () => void chrome.runtime.lastError,
      );
    } catch (_error) {
      // Worker gone; nothing can be told about the death anymore.
    }
  }

  // A dead stream stays dead: release everything the capture held so no
  // timer fires into a broken recorder after death. Same cleanup shape as
  // captureStop, minus the response.
  function shutdownCapture() {
    clearTimeout(backstopTimer);
    clearInterval(regularCutTimer);
    regularCutTimer = null;
    stopPlaybackLoop();
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    recorder = null;
  }

  // ============================================================
  // REALTIME WEBSOCKET PATH (#46, spec #44)
  // ============================================================
  //
  // transcribeMode "realtime" replaces the MediaRecorder with a PCM pump:
  // AudioContext(16 kHz) -> ScriptProcessor -> clamp/scale to PCM16 ->
  // base64 -> input_audio_buffer.append over the WebSocket. The pure
  // protocol pieces (parse/build/frame) live in realtime-protocol.js and
  // are Node-tested; everything here is browser-only wiring.

  // Best-effort unsolicited message to the worker (same tolerance as
  // notifyCaptureEnded: the worker may be gone; lastError is tolerated).
  function sendRealtimeWorkerMessage(payload) {
    try {
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    } catch (_error) {
      // Worker gone; nothing else can consume the event anymore.
    }
  }

  function startRealtimeSession(apiKey) {
    realtimeSession = {
      apiKey,
      // Wall-clock base: utterance timestamps are absolute stream seconds,
      // and a live Session's stream time is wall time since captureStart.
      startedAtMs: Date.now(),
      ws: null,
      context: null,
      source: null,
      processor: null,
      muteGain: null,
      accumulator: [],
      // Wall ms elapsed before the CURRENT connection's audio timeline
      // started; server speech markers are per-connection and get this
      // offset added so utterance timestamps stay monotonic across
      // reconnects (audio dropped during a gap is not counted).
      streamBaseMs: 0,
      tracker: YTD_REALTIME_PROTOCOL.createUtteranceTracker(),
      reconnectAttempt: 0,
      reconnectTimer: null,
      // Set by captureStop: finish-before-close is in progress.
      stopping: false,
      finished: false,
      finishTimer: null,
      finishResponder: null,
    };
    openRealtimeSocket();
  }

  function openRealtimeSocket() {
    const session = realtimeSession;
    if (!session) return;
    let socket;
    try {
      socket = new WebSocket(
        YTD_REALTIME_PROTOCOL.buildRealtimeUrl(undefined, session.apiKey),
      );
    } catch (error) {
      console.error("[Learning Digest] realtime WebSocket failed:", error?.message || error);
      handleRealtimeSocketClose(session);
      return;
    }
    socket.binaryType = "arraybuffer";
    session.ws = socket;
    socket.onopen = () => {
      // A torn-down or superseded session's socket events are stale.
      if (realtimeSession !== session) return;
      console.log("[Learning Digest] realtime WebSocket open");
      socket.send(JSON.stringify(YTD_REALTIME_PROTOCOL.buildSessionUpdate()));
      session.streamBaseMs = Date.now() - session.startedAtMs;
      session.reconnectAttempt = 0;
      startRealtimePump(session);
    };
    socket.onmessage = (event) => handleRealtimeServerMessage(session, event.data);
    socket.onerror = (error) => {
      // Log only; the close event that always follows drives the reconnect.
      console.error("[Learning Digest] realtime WebSocket error:", error?.message || "(no detail)");
    };
    socket.onclose = () => handleRealtimeSocketClose(session);
  }

  function handleRealtimeSocketClose(session) {
    session.ws = null;
    stopRealtimePump(session);
    if (realtimeSession !== session) return;
    if (session.stopping) {
      // captureStop already sent session.finish (or never had a socket);
      // this close completes the stop flow.
      finishRealtimeTeardown(session);
      return;
    }
    if (session.reconnectAttempt >= REALTIME_MAX_RECONNECTS) {
      // Final give-up: tear down the realtime path AND the capture, then
      // tell the worker once. The worker answers like captureEnded — loud
      // log, panel notice, auto-end — so the Session cannot zombie on with
      // a dead stream; the learner keeps the transcript collected so far.
      shutdownRealtimeCapture();
      sendRealtimeWorkerMessage({ action: "realtimeGaveUp" });
      return;
    }
    const delayMs = Math.min(
      REALTIME_RECONNECT_BASE_MS * 2 ** session.reconnectAttempt,
      REALTIME_RECONNECT_MAX_MS,
    );
    session.reconnectAttempt += 1;
    console.log(
      `[Learning Digest] realtime WebSocket closed; reconnecting in ${delayMs} ms ` +
        `(attempt ${session.reconnectAttempt}/${REALTIME_MAX_RECONNECTS})`,
    );
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      if (realtimeSession === session && !session.stopping) openRealtimeSocket();
    }, delayMs);
  }

  function startRealtimePump(session) {
    if (session.context) return;
    try {
      // Requesting the context at 16 kHz resamples the tab stream down on
      // capture; no manual downsampling is needed.
      session.context = new AudioContext({ sampleRate: 16000 });
      session.source = session.context.createMediaStreamSource(stream);
      session.processor = session.context.createScriptProcessor(
        REALTIME_PUMP_BUFFER_SIZE,
        1,
        1,
      );
      // ScriptProcessor only runs connected to a destination; a zero gain
      // keeps the pumped audio silent (the playback loop owns audibility —
      // without the mute the learner hears the lesson twice).
      session.muteGain = session.context.createGain();
      session.muteGain.gain.value = 0;
      session.processor.onaudioprocess = (event) =>
        pumpRealtimeChunk(session, event.inputBuffer.getChannelData(0));
      session.source.connect(session.processor);
      session.processor.connect(session.muteGain);
      session.muteGain.connect(session.context.destination);
    } catch (error) {
      console.error("[Learning Digest] realtime pump failed:", error?.message || error);
      // No pump means no transcription at all: same one-shot death notice
      // as a dead capture stream, so the worker auto-ends the Session.
      notifyCaptureEnded(error?.message || "realtime pump failed");
      shutdownRealtimeCapture();
    }
  }

  function pumpRealtimeChunk(session, samples) {
    if (realtimeSession !== session || session.stopping) return;
    // Dead capture stream (tab closed or navigated away): the recorder
    // path notices via startRecorder, the pump path via stream.active.
    if (!stream || !stream.active) {
      notifyCaptureEnded("capture stream is no longer active");
      shutdownRealtimeCapture();
      return;
    }
    const socket = session.ws;
    // Audio arriving while disconnected is dropped: there is nowhere to
    // send it, and buffering minutes of PCM is not worth the memory.
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const pending = session.accumulator;
    for (let i = 0; i < samples.length; i++) pending.push(samples[i]);
    const chunkSamples = Math.round(REALTIME_CHUNK_SECONDS * session.context.sampleRate);
    while (pending.length >= chunkSamples) {
      const chunk = new Float32Array(pending.splice(0, chunkSamples));
      sendRealtimeAudioChunk(session, chunk);
    }
  }

  function sendRealtimeAudioChunk(session, chunkSamples) {
    try {
      session.ws.send(
        JSON.stringify(
          YTD_REALTIME_PROTOCOL.buildAppend(
            YTD_REALTIME_PROTOCOL.chunkFloat32ToPcm16Base64(chunkSamples),
          ),
        ),
      );
    } catch (error) {
      // A send on a dying socket throws; the close event drives reconnect.
      console.error("[Learning Digest] realtime append failed:", error?.message || error);
    }
  }

  function handleRealtimeServerMessage(session, data) {
    if (realtimeSession !== session) return;
    const parsed = YTD_REALTIME_PROTOCOL.parseServerEvent(
      typeof data === "string" ? data : null,
    );
    switch (parsed.type) {
      case "input_audio_buffer.speech_started":
        session.tracker.onSpeechStarted(session.streamBaseMs + parsed.audioStartMs);
        break;
      case "input_audio_buffer.speech_stopped":
        session.tracker.onSpeechStopped(session.streamBaseMs + parsed.audioEndMs);
        break;
      case "conversation.item.input_audio_transcription.text": {
        // Live preview = confirmed prefix + draft suffix (spec #44).
        sendRealtimeWorkerMessage({
          action: "realtimePartial",
          text: parsed.text + parsed.stash,
        });
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const utterance = session.tracker.onCompleted(parsed.transcript);
        sendRealtimeWorkerMessage({
          action: "realtimeUtterance",
          text: utterance.text,
          start: utterance.startSeconds,
          duration: utterance.durationSeconds,
        });
        break;
      }
      case "conversation.item.input_audio_transcription.failed": {
        // A failed UTTERANCE is a content hole, not a connection problem:
        // it lands as a failure-marker record (the segment path's
        // [语音转录失败] shape) whenever the tracker holds the item's
        // speech_started/stopped pairing, so the transcript gap stays
        // visible like any other failed transcription. realtimeError stays
        // reserved for connection-level failures.
        console.error(
          "[Learning Digest] realtime utterance failed:",
          parsed.error?.message || parsed.itemId || "(no detail)",
        );
        const pairing = session.tracker.onFailed();
        if (pairing) {
          sendRealtimeWorkerMessage({
            action: "realtimeUtterance",
            text: "[实时转写失败]",
            start: pairing.startSeconds,
            duration: pairing.durationSeconds,
            failed: true,
          });
        }
        break;
      }
      case "error":
        console.error(
          "[Learning Digest] realtime server error:",
          parsed.code,
          parsed.message,
        );
        sendRealtimeWorkerMessage({
          action: "realtimeError",
          message: parsed.message || "实时转写服务返回错误",
        });
        break;
      case "session.finished":
        session.finished = true;
        // A stop waiting on this event can tear down immediately; anything
        // sent before it (the last completed utterance) was already handled.
        if (session.stopping) finishRealtimeTeardown(session);
        break;
      default:
        // session.created/updated/committed and unknown frames need no action.
        break;
    }
  }

  // Releases the pump graph between reconnects (each new connection gets a
  // fresh context; the source re-attaches from the live stream).
  function stopRealtimePump(session) {
    if (session.processor) {
      session.processor.onaudioprocess = null;
      try {
        session.processor.disconnect();
      } catch (_error) {
        // Already disconnected.
      }
      session.processor = null;
    }
    if (session.source) {
      try {
        session.source.disconnect();
      } catch (_error) {
        // Already disconnected.
      }
      session.source = null;
    }
    if (session.muteGain) {
      try {
        session.muteGain.disconnect();
      } catch (_error) {
        // Already disconnected.
      }
      session.muteGain = null;
    }
    if (session.context) {
      try {
        session.context.close();
      } catch (_error) {
        // Already closed.
      }
      session.context = null;
    }
    session.accumulator = [];
  }

  // captureStop in realtime mode: stop the pump, send session.finish BEFORE
  // closing, wait for session.finished (2 s timeout), then tear everything
  // down and answer. The response MUST always be sent — the worker's
  // dispatch awaits it.
  function stopRealtimeCapture(sendResponse) {
    const session = realtimeSession;
    if (!session) {
      sendResponse({ success: true });
      return true;
    }
    session.stopping = true;
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    stopRealtimePump(session);
    session.finishResponder = sendResponse;
    const socket = session.ws;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(YTD_REALTIME_PROTOCOL.buildFinish()));
      session.finishTimer = setTimeout(
        () => finishRealtimeTeardown(session),
        REALTIME_FINISH_TIMEOUT_MS,
      );
    } else {
      // No live socket to flush the trailing utterance through.
      finishRealtimeTeardown(session);
    }
    return true;
  }

  function finishRealtimeTeardown(session) {
    clearTimeout(session.finishTimer);
    session.finishTimer = null;
    if (session.ws) {
      const socket = session.ws;
      session.ws = null;
      try {
        socket.close(1000);
      } catch (_error) {
        // Already closed.
      }
    }
    if (realtimeSession === session) realtimeSession = null;
    shutdownCapture();
    const responder = session.finishResponder;
    if (responder) {
      session.finishResponder = null;
      responder({ success: true });
    }
  }

  // Death/give-up teardown: release the WebSocket session AND the capture
  // (the recorder path's shutdownCapture, plus the realtime state).
  function shutdownRealtimeCapture() {
    const session = realtimeSession;
    if (session) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
      clearTimeout(session.finishTimer);
      session.finishTimer = null;
      stopRealtimePump(session);
      if (session.ws) {
        const socket = session.ws;
        session.ws = null;
        try {
          socket.close(1000);
        } catch (_error) {
          // Already closed.
        }
      }
      realtimeSession = null;
    }
    shutdownCapture();
  }

  // Cut a chunk now and push it to the service worker unsolicited. The
  // worker wakes on the message, so the cut pipeline keeps running even
  // while the worker's own timers are suspended.
  function selfCutAndSend() {
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
    }, (error) => {
      // The stream died mid-Session (tab closed or navigated away). Tell
      // the worker once, loudly, then release everything instead of letting
      // every later cut fail the same way in silence.
      notifyCaptureEnded(error?.message || String(error));
      shutdownCapture();
    });
  }

  function armBackstop() {
    clearTimeout(backstopTimer);
    // Five segment lengths: far beyond normal cut latency, small enough to
    // stay well under the Speech Provider's upload size limit.
    backstopTimer = setTimeout(selfCutAndSend, segmentLengthMs * 5);
  }

  // Live (wallclock) Sessions: the worker's live tick dies with the ~30 s
  // service-worker suspension and no page message wakes it, so the regular
  // segment cut must live here in the persistent offscreen document. Audio
  // is being recorded AND played back, so this page is neither silent nor
  // media-idle and its timers escape intensive throttling.
  function armRegularCut(mode) {
    clearInterval(regularCutTimer);
    regularCutTimer = null;
    if (mode === "wallclock") {
      regularCutTimer = setInterval(selfCutAndSend, segmentLengthMs);
    }
  }

  function startRecorder() {
    // A tabCapture stream whose tab closed or navigated away stays inactive
    // forever; starting a recorder on it throws NotSupportedError (the
    // live-tested zombie path). Fail with a clear error instead; callers
    // turn the rejection into a captureEnded notice.
    const hasLiveAudio =
      !!stream &&
      stream.active &&
      stream.getAudioTracks().some((track) => track.readyState === "live");
    if (!hasLiveAudio) {
      throw new Error("capture stream is no longer active");
    }
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
      segmentLengthMs = Math.max(30_000, Number(message.segmentLengthSeconds) || 30) * 1000;
      startPlaybackLoop();
      if (message.transcribeMode === "realtime") {
        // Realtime path (spec #44): no recorder, no cut timers — the PCM
        // pump over the WebSocket replaces them. The key rides the
        // captureStart message only (never persisted anywhere).
        startRealtimeSession(message.apiKey);
      } else {
        startRecorder();
        armRegularCut(message.mode);
      }
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
      void cutChunk().then(
        (chunk) => sendResponse(chunk || { error: "not recording" }),
        (error) => {
          // The stream died mid-Session: same handling as selfCutAndSend's
          // rejection, plus the response the worker's dispatch is awaiting;
          // the channel must ALWAYS close.
          notifyCaptureEnded(error?.message || String(error));
          shutdownCapture();
          sendResponse({ error: error?.message || String(error) });
        },
      );
      return true;
    }
    if (message.action === "captureCadence") {
      // #48 timeline anchoring: re-arm (or disarm) the regular wall-clock
      // cut mid-Session. A wallclock Session that anchored to the video
      // timeline switches to position-driven cuts like any replay Session,
      // so its wall-clock cadence must stop here.
      armRegularCut(message.mode);
      sendResponse({ success: true });
      return false;
    }
    if (message.action === "captureStop") {
      if (realtimeSession) {
        // Realtime: finish-before-close (session.finish, wait for
        // session.finished with a 2 s timeout), then full teardown.
        return stopRealtimeCapture(sendResponse);
      }
      clearTimeout(backstopTimer);
      clearInterval(regularCutTimer);
      regularCutTimer = null;
      stopPlaybackLoop();
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
