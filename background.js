/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Calling the AI Provider to analyze transcripts, explain selections,
 *    translate content, clean up saved notes, and refresh the Rolling
 *    Summary / Session Digest of an active learning Session
 * 3. Note storage
 * 4. Sending results back to the side panel
 *
 * Source Platform capture (xiaoe-tech.com) and the Session pipeline land in a
 * later ticket; the Session state machine and Speech Provider registry are
 * already loaded here and ready to be driven by that capture layer.
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js", "speech-transcription.js", "speech-providers.js", "session-pipeline.js", "session-persistence.js", "source-platforms.js", "session-segmenter.js", "session-summary.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Keep storage limited to trusted extension contexts.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[Learning Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "AI provider API key not configured. Open Learning Digest Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(settings.aiBaseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves the provider is still making progress. It may
    // then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `AI provider error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("The AI provider returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "The AI request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "The AI request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including the provider's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("The AI provider response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("The AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * Icon click is the single capture entry point. Chrome only allows
 * tabCapture after the user has INVOKED the extension on the target tab,
 * and a click inside the side panel does not count — so the toolbar icon
 * click must carry both the invocation and the gesture that authorizes
 * capture. From Chrome 116 the action click can also open the side panel
 * programmatically, so one click does both: open the panel, and when the
 * active tab is a recognized learning page, start the Session immediately.
 */
chrome.action.onClicked.addListener((tab) => {
  void handleActionClicked(tab);
});

async function handleActionClicked(tab) {
  try {
    await chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
  } catch (_error) {
    // The panel may already be open for this tab; opening is best-effort.
  }

  // Without the "tabs" permission tab.url is only populated when the
  // extension has host access to the page; on unrecognized hosts it is
  // simply absent and we only open the panel.
  if (!tab?.url) {
    console.error("[Learning Digest] icon click ignored: tab.url is empty", tab);
    return;
  }
  const recognition = YTD_SOURCE_PLATFORMS.recognizePage(tab.url);
  if (recognition.kind === "none") {
    console.error("[Learning Digest] icon click ignored: page not recognized:", tab.url);
    return;
  }

  const existing = await ensureCaptureResumed();
  if (existing) {
    console.log("[Learning Digest] icon click: a Session is already active");
    return; // Session already running; the panel shows its state.
  }

  const result = await handleStartLearning({ url: tab.url, tabId: tab.id });
  if (result && !result.success) {
    // The panel just opened but may still be loading; retry briefly so the
    // failure reason is visible instead of a silently empty session view.
    const payload = { action: "sessionUpdate", startError: result.error };
    for (const delayMs of [0, 600, 1800]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await chrome.runtime.sendMessage(payload);
        return;
      } catch (_error) {
        // Panel not ready yet; next retry.
      }
    }
    console.error(
      "[Learning Digest] startLearning failed and the panel never received it:",
      result.error,
    );
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "analyzeTranscript") {
    // Pass content duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using the AI Provider.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save exact selected transcript text as a timestamped note.
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.selectedText,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  // --- Session capture (xiaoe-tech Source Platform, #16) ---

  if (message.action === "startLearning") {
    handleStartLearning(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "endLearning") {
    handleEndLearning()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getSessionState") {
    handleGetSessionState()
      .then(sendResponse)
      .catch((err) => sendResponse({ active: false, error: err.message }));
    return true;
  }

  if (message.action === "mediaPosition") {
    // From the xiaoe page bridge: drives replay/course Segments and the
    // media-end auto-stop. No response needed.
    handleMediaPosition(message, sender).catch((error) =>
      debugLog("[Learning Digest BG] mediaPosition error:", error),
    );
    return false;
  }

  if (message.action === "captureChunk") {
    // Backstop self-cut from the offscreen recorder (worker was asleep).
    handleBackstopChunk(message).catch((error) =>
      debugLog("[Learning Digest BG] captureChunk error:", error),
    );
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[Learning Digest BG] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// AI ANALYSIS
// ============================================================

/**
 * Sends the transcript to the AI Provider for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole session
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The session/lesson title
 * @param {string} channelName - The course/channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI provider API key not configured. Open Learning Digest Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationFormatted =
      YTD_SPEECH_TRANSCRIPTION.formatTimestamp(effectiveSeconds);
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE session instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold =
      YTD_SPEECH_TRANSCRIPTION.formatTimestamp(lateThresholdSeconds);

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[Learning Digest] Requesting session analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "The AI provider rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "The AI provider rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed content duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from the AI Provider
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  // [m:ss] formatting is the shared speech-transcription helper; keep this
  // validator free of its own copy.
  const formatTimestamp = (seconds) =>
    YTD_SPEECH_TRANSCRIPTION.formatTimestamp(seconds);
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using the AI Provider.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Session title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI provider API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[Learning Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note for the current Session. The side panel supplies the exact
 * selected transcript text, which is stored directly without an AI cleanup
 * request.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  selectedText,
) {
  try {
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));
    const exactSelectedText =
      typeof selectedText === "string"
        ? selectedText.replace(/\s+/g, " ").trim().slice(0, 3000)
        : "";

    // A selected transcript note is already the exact text the user wants.
    // Save it directly without asking the AI to rewrite the text.
    if (!exactSelectedText) {
      return {
        success: false,
        error: "NO_SELECTED_TEXT",
        message: "Select transcript text in the side panel to save a note.",
      };
    }

    const note = {
      id: `note_${Date.now()}`,
      videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Session",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: YTD_SPEECH_TRANSCRIPTION.formatTimestamp(safeTimestamp),
      timestampSeconds: safeTimestamp,
      text: exactSelectedText,
      rawText: exactSelectedText,
      createdAt: Date.now(),
    };

    await saveNoteToStorage(note);
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
    return { success: true, note };
  } catch (error) {
    console.error("[Learning Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by session ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}


// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  handleSaveNote,
  generateSessionDigest,
  // Session capture orchestration (provider-aware start gate, resume
  // settlement of interrupted Segments) — see tests/background-capture.test.js.
  handleStartLearning,
  handleGetSessionState,
  handleActionClicked,
};

// ============================================================
// SESSION CAPTURE ORCHESTRATION (xiaoe-tech Source Platform)
// ============================================================
//
// The thin browser layer in front of the pure pieces:
// session-pipeline.js (state machine), session-segmenter.js (timing math),
// source-platforms.js (URL recognition), speech-providers.js (transcription),
// session-persistence.js (incremental snapshots). Everything timed or
// browser-bound lives here so the core modules stay pure and unit-tested.
//
// Shape: one active capture at a time. The capture context lives in memory
// and is mirrored to storage under ACTIVE_CAPTURE_KEY so a service-worker
// restart (or browser restart) can rebuild mid-Session without
// re-transcribing done Segments.

const ACTIVE_CAPTURE_KEY = "ytd_active_capture";
const LIVE_TICK_MS = 1000;

/** @type {object|null} in-memory capture context, rebuilt from storage on wake. */
let captureContext = null;

function dataUrlToBlob(dataUrl, fallbackMime = "audio/webm") {
  const [header, base64] = String(dataUrl).split(",");
  const mime = /data:([^;]+)/.exec(header)?.[1] || fallbackMime;
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function sendOffscreen(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    // USER_MEDIA for the getUserMedia recorder; AUDIO_PLAYBACK so the
    // offscreen loopback that keeps the captured lesson audible is allowed
    // without a user gesture (autoplay policy exemption for offscreen docs).
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Records the course tab's audio and plays it back so the learner can still hear the lesson while it is being captured.",
  });
}

function broadcastSession(state, extra = {}) {
  try {
    chrome.runtime
      .sendMessage({ action: "sessionUpdate", sessionId: state.sessionId, state, ...extra })
      .catch(() => {});
  } catch (_error) {
    // Side panel closed; the snapshot in storage is the durable record.
  }
}

async function persistContextPointer(context) {
  // Session metadata only — Speech Provider credentials are re-read from
  // settings on rebuild and are never duplicated here.
  await chrome.storage.local.set({
    [ACTIVE_CAPTURE_KEY]: {
      sessionId: context.sessionId,
      tabId: context.tabId,
      platformId: context.platformId,
      kind: context.kind,
      timestampKind: context.timestampKind,
      startedAtMs: context.startedAtMs,
      segmentLengthSeconds: context.segmentLengthSeconds,
    },
  });
}

async function readContextPointer() {
  const stored = await chrome.storage.local.get(ACTIVE_CAPTURE_KEY);
  return stored[ACTIVE_CAPTURE_KEY] || null;
}

async function clearContextPointer() {
  await chrome.storage.local.remove(ACTIVE_CAPTURE_KEY);
}

/**
 * The Session timeline position (seconds from Session start) that capture
 * has reached: the end of the last persisted Segment. This is where a
 * rebuilt segmenter resumes, so a Segment still pending whose range ends at
 * or before this cursor can never be dispatched again.
 */
function segmentsEndSeconds(state) {
  return state.segments.reduce(
    (end, segment) => Math.max(end, segment.start + segment.duration),
    0,
  );
}

/**
 * The in-memory capture context, one shape for both creation sites. The
 * factory owns every field's default so handleStartLearning (fresh Session)
 * and ensureCaptureResumed (rebuilt from storage) cannot drift apart.
 *
 * @param {object} parts - the per-site values
 * @param {string} parts.sessionId
 * @param {number} parts.tabId
 * @param {string} parts.platformId
 * @param {string} parts.kind
 * @param {string} parts.timestampKind
 * @param {number} parts.startedAtMs - wall-clock Session start
 * @param {number} parts.segmentLengthSeconds
 * @param {object} parts.state - Session state from session-pipeline.js
 * @param {object} parts.segmenter - scheduler from session-segmenter.js
 * @param {string} parts.providerId - selected Speech Provider id
 * @param {object} parts.credentials - that provider's credentials
 */
function createCaptureContext({
  sessionId,
  tabId,
  platformId,
  kind,
  timestampKind,
  startedAtMs,
  segmentLengthSeconds,
  state,
  segmenter,
  providerId,
  credentials,
}) {
  return {
    sessionId,
    tabId,
    platformId,
    kind,
    timestampKind,
    startedAtMs,
    segmentLengthSeconds,
    state,
    segmenter,
    lastPosition: segmentsEndSeconds(state),
    pendingChunks: [],
    providerId,
    credentials,
    liveTimer: null,
    summaryTimer: null,
    // Scheduling state starts conservative: a fresh Session has nothing to
    // summarize yet, and a resumed one waits one full interval after the
    // (re)start before its next summary tick either way.
    lastSummaryAtMs: Date.now(),
    summaryInFlight: false,
    ended: false,
  };
}

/**
 * Rebuilds the in-memory capture context after a service-worker restart.
 * Resume is exactly the #12 contract: load the snapshot, resumeFromSnapshot,
 * keep feeding events — done Segments are never re-transcribed.
 */
async function ensureCaptureResumed() {
  if (captureContext) return captureContext;
  const pointer = await readContextPointer();
  if (!pointer) return null;
  const snapshot = await YTD_SESSION_PERSISTENCE.loadSessionSnapshot(
    chrome.storage.local,
    pointer.sessionId,
  );
  if (!snapshot) {
    await clearContextPointer();
    return null;
  }
  const state = YTD_SESSION_PIPELINE.resumeFromSnapshot(snapshot);
  if (state.status !== "active") {
    await clearContextPointer();
    return null;
  }

  // Segments captured but never transcribed when the previous worker died
  // were in flight; the rebuilt segmenter starts past them, so settle them
  // as failed here. Each one emits its [语音转录失败] marker record, closing
  // the transcript hole with a visible annotation instead of a silent gap.
  let resumedState = YTD_SESSION_PIPELINE.settleInterruptedSegments(state);
  if (resumedState !== state) {
    await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(
      chrome.storage.local,
      resumedState,
    );
  }

  const settings = await getSettings();
  const context = createCaptureContext({
    ...pointer,
    state: resumedState,
    segmenter: YTD_SEGMENTER.createSegmenter({
      segmentLengthSeconds: pointer.segmentLengthSeconds,
      startAt: segmentsEndSeconds(resumedState),
      startIndex: resumedState.segments.length,
    }),
    providerId: settings.speechProvider,
    credentials: settings.speechProviders[settings.speechProvider] || {},
  });
  captureContext = context;

  // The offscreen recorder survives a worker restart but not a browser
  // restart; only the latter needs a fresh capture stream.
  if (!(await chrome.offscreen.hasDocument())) {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: context.tabId,
      });
      await ensureOffscreen();
      const started = await sendOffscreen({
        action: "captureStart",
        streamId,
        segmentLengthSeconds: context.segmentLengthSeconds,
        mode: context.timestampKind === "wallclock" ? "wallclock" : "video",
      });
      if (!started?.success) throw new Error(started?.error || "capture restart failed");
    } catch (error) {
      // Without the tab (closed or navigated away) capture cannot restart;
      // the Session stays resumable the moment the learner returns.
      debugLog("[Learning Digest BG] capture restart failed:", error);
    }
  }
  if (context.timestampKind === "wallclock") startLiveTimer(context);
  startSummaryTimer(context, settings.summaryIntervalMinutes);
  return context;
}

function startLiveTimer(context) {
  context.liveTimer = setInterval(() => {
    feedPosition(context, (Date.now() - context.startedAtMs) / 1000);
  }, LIVE_TICK_MS);
}

// ============================================================
// ROLLING SUMMARY + SESSION DIGEST (#18)
// ============================================================
//
// The Rolling Summary runs on a configurable interval while a Session is
// active. All assembly/scheduling decisions are pure functions in
// session-summary.js; this layer only owns the timer, the AI call, and
// feeding the result back as a summaryTick event. Scheduling state lives
// in the capture context (not the persisted state): lastSummaryAtMs is the
// last ATTEMPT time, so a failed summary waits one more interval instead of
// retrying in a tight loop, and a resumed Session simply waits one interval
// before its next tick.

function startSummaryTimer(context, summaryIntervalMinutes) {
  context.summaryTimer = setInterval(() => {
    void maybeRunRollingSummary(context);
  }, Math.max(60_000, Number(summaryIntervalMinutes) * 60 * 1000));
}

async function maybeRunRollingSummary(context) {
  if (context.ended || context.summaryInFlight) return;
  const settings = await getSettings();
  const due = YTD_SESSION_SUMMARY.isSummaryDue({
    nowMs: Date.now(),
    lastSummaryAtMs: context.lastSummaryAtMs,
    intervalMinutes: settings.summaryIntervalMinutes,
    hasNewTranscript: YTD_SESSION_SUMMARY.hasNewTranscript(context.state),
  });
  if (!due) return;

  context.summaryInFlight = true;
  context.lastSummaryAtMs = Date.now();
  try {
    const input = YTD_SESSION_SUMMARY.assembleRollingSummaryInput(context.state);
    const { text } = await requestAiCompletion({
      maxTokens: 4096,
      messages: YTD_SESSION_SUMMARY.buildRollingSummaryMessages({
        previousSummary: input.previousSummary,
        newTranscriptText: YTD_SESSION_SUMMARY.formatTranscriptForPrompt(
          input.newTranscript,
        ),
      }),
    });
    // Sliding window: only the latest summary is kept (the state machine
    // enforces that on summaryTick), and coveredUntil moves the next
    // window past exactly the records this tick consumed.
    context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
      type: "summaryTick",
      summary: {
        text,
        coveredUntil: YTD_SESSION_SUMMARY.coveredUntilFor(input.newTranscript),
      },
    });
    await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(
      chrome.storage.local,
      context.state,
    );
    broadcastSession(context.state);
  } catch (error) {
    // A failed tick leaves the window untouched; the next interval retries.
    debugLog("[Learning Digest BG] Rolling Summary failed:", error);
  } finally {
    context.summaryInFlight = false;
  }
}

/**
 * Builds the Session Digest when a Session ends. The input assembly is the
 * pure `assembleSessionDigestInput` from session-pipeline.js; this function
 * only adds the AI call and persistence. If the uncovered tail is empty and
 * a Rolling Summary already covers the whole Session, its text is reused
 * verbatim instead of paying for a redundant call.
 *
 * @returns {Promise<{text: string|null, error?: string, skipped?: string}>}
 */
async function generateSessionDigest(state) {
  const records = state?.transcriptRecords || [];
  if (records.length === 0 || YTD_SESSION_PIPELINE.allSegmentsFailed(state)) {
    return { text: null, skipped: "noTranscript" };
  }
  try {
    const { rollingSummary, uncoveredTranscript } =
      YTD_SESSION_PIPELINE.assembleSessionDigestInput(state);
    if (uncoveredTranscript.length === 0 && rollingSummary?.text) {
      return { text: rollingSummary.text };
    }
    const { text } = await requestAiCompletion({
      maxTokens: 8192,
      messages: YTD_SESSION_SUMMARY.buildSessionDigestMessages({
        rollingSummaryText: rollingSummary?.text ?? null,
        uncoveredTranscriptText: YTD_SESSION_SUMMARY.formatTranscriptForPrompt(
          uncoveredTranscript,
        ),
      }),
    });
    return { text };
  } catch (error) {
    debugLog("[Learning Digest BG] Session Digest failed:", error);
    return { text: null, error: error?.message || String(error) };
  }
}


/**
 * Feeds the scheduler one position reading (video position for replay and
 * course pages, wall-clock elapsed for live) and dispatches whatever
 * Segments completed. Feeding is idempotent: the scheduler's cursor only
 * moves forward.
 */
function feedPosition(context, positionSeconds) {
  if (context.ended) return;
  context.lastPosition = Math.max(context.lastPosition, positionSeconds);
  for (const segment of context.segmenter.recordPosition(positionSeconds)) {
    void dispatchSegment(context, segment);
  }
}

/**
 * One Segment end to end: append it to the Session, cut its audio from the
 * recorder (consuming any backstop chunk first), transcribe exactly once,
 * then feed the result back into the state machine. Every transition is
 * persisted and broadcast so a close at any point loses at most the
 * in-flight Segment.
 */
async function dispatchSegment(context, segment) {
  const segmentId = `seg-${segment.index}`;
  context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
    type: "segmentCaptured",
    segment: { id: segmentId, start: segment.start, duration: segment.duration },
  });
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
  broadcastSession(context.state);

  try {
    const queued = context.pendingChunks.shift();
    const cut = queued || (await sendOffscreen({ action: "captureCut" }));
    if (!cut || cut.error) throw new Error(cut?.error || "no audio chunk");
    const blob = dataUrlToBlob(cut.dataUrl, cut.mimeType);
    const records = await YTD_SPEECH_PROVIDERS.transcribeSegment(
      context.providerId,
      blob,
      context.credentials,
    );
    // Provider records are Segment-relative; the Transcript needs absolute
    // Session timestamps.
    const absoluteRecords = records.map((record) => ({
      ...record,
      start: record.start + segment.start,
    }));
    context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
      type: "transcribeOk",
      segmentId,
      records: absoluteRecords,
    });
  } catch (error) {
    debugLog("[Learning Digest BG] Segment transcription failed:", error);
    context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, {
      type: "transcribeFailed",
      segmentId,
    });
  }
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
  broadcastSession(context.state);
}

async function handleStartLearning(message) {
  const recognition = YTD_SOURCE_PLATFORMS.recognizePage(message.url);
  if (recognition.kind === "none") {
    return { success: false, error: "This page is not a recognized learning page." };
  }
  const existing = await ensureCaptureResumed();
  if (existing) {
    return { success: false, error: "A learning Session is already active.", sessionId: existing.sessionId };
  }

  const settings = await getSettings();
  const providerId = settings.speechProvider;
  const credentials = settings.speechProviders[providerId] || {};
  // The gate follows the SELECTED Speech Provider's declared credential
  // fields (the password-typed ones, same rule the options page enforces on
  // save), not a hard-coded apiKey check: Tencent has no apiKey.
  const missingFields =
    YTD_SPEECH_PROVIDERS.missingProviderCredentials(providerId, credentials);
  if (missingFields.length) {
    const provider = YTD_SPEECH_PROVIDERS.getSpeechProvider(providerId);
    return {
      success: false,
      error:
        `Add ${missingFields.join(", ")} for ${provider?.label || providerId} ` +
        "in Settings first.",
    };
  }

  const state = YTD_SESSION_PIPELINE.createSession({
    sessionId: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  });
  const context = createCaptureContext({
    sessionId: state.sessionId,
    tabId: message.tabId,
    platformId: recognition.platformId,
    kind: recognition.kind,
    timestampKind: recognition.timestampKind,
    startedAtMs: Date.now(),
    segmentLengthSeconds: settings.segmentLengthSeconds,
    state,
    segmenter: YTD_SEGMENTER.createSegmenter({
      segmentLengthSeconds: settings.segmentLengthSeconds,
    }),
    providerId,
    credentials,
  });
  captureContext = context;
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, state);
  await persistContextPointer(context);

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: context.tabId });
    await ensureOffscreen();
    const started = await sendOffscreen({
      action: "captureStart",
      streamId,
      segmentLengthSeconds: context.segmentLengthSeconds,
      mode: context.timestampKind === "wallclock" ? "wallclock" : "video",
    });
    if (!started?.success) throw new Error(started?.error || "capture start failed");
  } catch (error) {
    captureContext = null;
    await clearContextPointer();
    const message = error?.message || String(error);
    console.error("[Learning Digest] startLearning failed:", message);
    // Chrome only allows tabCapture after the user has INVOKED the extension
    // on the target tab (a toolbar icon click); a side-panel button click
    // does not count. Turn the raw English API error into an actionable
    // instruction instead of leaving the learner stranded.
    if (/not been invoked/i.test(message)) {
      return {
        success: false,
        error:
          "Chrome 要求在采集前先调用一次扩展：请在小鹅通课程标签页上点击工具栏中的 Learning Digest 图标（点击即打开侧边栏并算作一次调用），然后再点「开始学习」。如果刚刷新或跳转过课程页面，需要重新点一次图标。",
      };
    }
    return {
      success: false,
      error: `无法开始音频采集：${message}`,
    };
  }

  if (context.timestampKind === "wallclock") startLiveTimer(context);
  startSummaryTimer(context, settings.summaryIntervalMinutes);
  broadcastSession(context.state);
  return {
    success: true,
    sessionId: context.sessionId,
    kind: context.kind,
    timestampKind: context.timestampKind,
    state: context.state,
  };
}

async function handleMediaPosition(message, sender) {
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  if (context.timestampKind !== "video") return; // live runs on wall-clock
  if (sender.tab?.id !== context.tabId) return;
  feedPosition(context, Number(message.position) || 0);
  // Media end auto-ends replay/course Sessions; live ends only via the
  // explicit end action.
  if (message.ended && (context.kind === "replay" || context.kind === "course")) {
    await endActiveSession(context, { reason: "mediaEnded" });
  }
}

async function handleBackstopChunk(message) {
  const context = await ensureCaptureResumed();
  if (!context || context.ended) return;
  context.pendingChunks.push({ dataUrl: message.dataUrl, durationSeconds: message.durationSeconds, mimeType: message.mimeType });
  // Keep the position stream moving even if the live tick was suspended.
  feedPosition(context, (Date.now() - context.startedAtMs) / 1000);
}

async function endActiveSession(context, { reason } = {}) {
  if (context.ended) return { success: true, reason, state: context.state };
  context.ended = true;
  if (context.liveTimer) clearInterval(context.liveTimer);
  if (context.summaryTimer) clearInterval(context.summaryTimer);

  const finalPosition =
    context.timestampKind === "wallclock"
      ? (Date.now() - context.startedAtMs) / 1000
      : context.lastPosition;
  const tail = context.segmenter.flush(finalPosition);
  if (tail) await dispatchSegment(context, tail);

  context.state = YTD_SESSION_PIPELINE.applyEvent(context.state, { type: "sessionEnd" });
  await YTD_SESSION_PERSISTENCE.saveSessionSnapshot(chrome.storage.local, context.state);
  await clearContextPointer();

  // Both end paths (explicit action and media-end auto-stop) produce the
  // Session Digest from the ended state. Digest failures never block ending.
  const digest = await generateSessionDigest(context.state);
  if (digest.text) {
    await chrome.storage.local.set({
      [`digest_${context.state.sessionId}`]: {
        sessionId: context.state.sessionId,
        text: digest.text,
        generatedAtMs: Date.now(),
      },
    });
  }
  broadcastSession(context.state, { digest });

  await sendOffscreen({ action: "captureStop" });
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
  if (captureContext?.sessionId === context.sessionId) captureContext = null;
  return { success: true, reason, state: context.state, digest };
}

async function handleEndLearning() {
  const context = await ensureCaptureResumed();
  if (!context) return { success: false, error: "No active learning Session." };
  return endActiveSession(context, { reason: "explicit" });
}

async function handleGetSessionState() {
  const context = await ensureCaptureResumed();
  if (!context) return { active: false, state: null };
  return {
    active: true,
    sessionId: context.sessionId,
    kind: context.kind,
    timestampKind: context.timestampKind,
    startedAtMs: context.startedAtMs,
    state: context.state,
  };
}
