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
      "DeepSeek API key not configured. Open Learning Digest Settings.",
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
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "DeepSeek request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "DeepSeek request exceeded the 120-second limit. Please Retry.",
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
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
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
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
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
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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

  // Translation: send content to the AI Provider.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
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
        message: "DeepSeek API key not configured. Open Learning Digest Settings.",
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
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE session instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

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
        message: "DeepSeek rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "DeepSeek rate-limited this request. Try again shortly.",
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

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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
        message: "DeepSeek API key not configured.",
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

    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const note = {
      id: `note_${Date.now()}`,
      videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Session",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
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

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[㐀-鿿]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using the AI Provider.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - 'transcriptBatch' or 'interfaceBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The session title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (!["transcriptBatch", "interfaceBatch"].includes(contentType)) {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "DeepSeek API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const promptSection =
      contentType === "transcriptBatch"
        ? "Transcript batch translation"
        : "Interface content translation";
    const systemPrompt = await loadPromptSection(
      "translation.md",
      promptSection,
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[Learning Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single AI Provider call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleSaveNote,
  handleTranslateContent,
  generateSessionDigest,
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
    reasons: ["USER_MEDIA"],
    justification: "Records the course tab's audio for segment transcription.",
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

function segmentCursor(state) {
  return state.segments.reduce(
    (end, segment) => Math.max(end, segment.start + segment.duration),
    0,
  );
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

  const settings = await getSettings();
  const context = {
    ...pointer,
    state,
    segmenter: YTD_SEGMENTER.createSegmenter({
      segmentLengthSeconds: pointer.segmentLengthSeconds,
      startAt: segmentCursor(state),
      startIndex: state.segments.length,
    }),
    lastPosition: segmentCursor(state),
    pendingChunks: [],
    providerId: settings.speechProvider,
    credentials: settings.speechProviders[settings.speechProvider] || {},
    liveTimer: null,
    summaryTimer: null,
    // Scheduling state is rebuilt conservatively on resume: wait one full
    // interval after a worker restart before the next summary tick.
    lastSummaryAtMs: Date.now(),
    summaryInFlight: false,
    ended: false,
  };
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
  if (!credentials.apiKey) {
    return { success: false, error: "Add a Speech Provider API key in Settings first." };
  }

  const state = YTD_SESSION_PIPELINE.createSession({
    sessionId: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  });
  const context = {
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
    lastPosition: 0,
    pendingChunks: [],
    providerId,
    credentials,
    liveTimer: null,
    summaryTimer: null,
    lastSummaryAtMs: Date.now(),
    summaryInFlight: false,
    ended: false,
  };
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
    });
    if (!started?.success) throw new Error(started?.error || "capture start failed");
  } catch (error) {
    captureContext = null;
    await clearContextPointer();
    return {
      success: false,
      error: `Could not start audio capture: ${error?.message || error}`,
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
