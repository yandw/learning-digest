/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for Learning Digest: rendering transcripts, the Session
 * Digest surfaces (概览/纪要), and notes. Source Platform capture that feeds
 * new Sessions lands with the platform ticket; until then the panel shows
 * its welcome state and can render previously cached transcripts.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// The pure report renderers (#30): the 纪要 tab and the downloads share one
// data source. In the browser the global arrives via
// <script src="report-render.js">; Node tests that inject the sandbox get it
// from YTD_REPORT_RENDER, and a Node require() is only used when both are
// absent (plain Node) so minimal test sandboxes never crash on load.
const reportRender =
  typeof YTD_REPORT_RENDER !== "undefined"
    ? YTD_REPORT_RENDER
    : typeof require === "function"
      ? require("./report-render.js")
      : null;

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
// The Segment length drives user-facing wait copy (pending row, start
// toast); cached from settings at startup instead of hardcoding minutes.
// Options-page changes are picked up on the next panel load.
let segmentLengthForCopy = 30;
function segmentLengthLabel() {
  const seconds = Math.max(30, Math.floor(Number(segmentLengthForCopy) || 30));
  return seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;
}
async function refreshSegmentLengthForCopy() {
  try {
    const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
    const normalized = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY] || {});
    if (Number.isFinite(normalized.segmentLengthSeconds)) {
      segmentLengthForCopy = normalized.segmentLengthSeconds;
    }
  } catch (_error) {
    // Keep the default on any storage hiccup; copy is cosmetic.
  }
}
let currentVideoUrl = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptLanguage = null;
let currentVideoTitle = "";
let currentChannelName = "";
let errorAction = null;

let currentNotes = [];
let currentNotesFilterVideoId = null;

// --- Transcript search state ---
// Search navigation only scrolls the panel. It does not seek the video.
let transcriptSearchMatches = [];
let transcriptSearchIndex = -1;

// --- Transcript reading position state ---
// Session storage survives a side panel close but clears when Chrome closes.
const TRANSCRIPT_VIEW_STATE_KEY = "ytd_transcript_view_state";
let pendingTranscriptViewState = null;
let transcriptViewStateSaveTimer = null;
let isRestoringTranscriptView = false;
let selectionActionsController = null;
let lastTranscriptScrollTop = 0;

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  void refreshSegmentLengthForCopy();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  showState("welcome");
  setupSessionUI();
  // D7 (#30): reopening the panel shows the most recent persisted report
  // even with no active Session.
  void adoptLatestStoredReport();
  // The 概览 first-topic hint names the configured tick interval.
  void refreshSummaryIntervalMinutes();
});

// Listen for messages from the background script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentNotesScopeId());
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// EVENT LISTENERS
// ============================================================

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  setupTranscriptSearch();
  setupReportTab();

  // pagehide also covers closing the side panel without a tab change.
  window.addEventListener("pagehide", () => {
    void saveCurrentTranscriptViewState();
  });

  // Remember the transcript reading position as the user scrolls.
  document.getElementById("contentArea")?.addEventListener(
    "scroll",
    scheduleTranscriptViewStateSave,
  );

  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    applyNotesFilter(false);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    applyNotesFilter(true);
  });

  // Session notes carry a jumpable stamp; one delegated listener covers
  // every row render.
  document
    .getElementById("notesList")
    ?.addEventListener("click", handleNotesListClick);

  // The selection toolbar serves both transcript surfaces (legacy rows and
  // session records), so it is wired once at startup.
  setupExplainFeature();
}

/**
 * Applies a notes filter button press: updates the pressed state and loads
 * the matching scope (本会话 = the current Session or video, 全部笔记 = all).
 */
function applyNotesFilter(showAll) {
  setNotesFilter(showAll);
  loadNotes(showAll ? null : currentNotesScopeId());
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

/**
 * Loads a previously cached digest for a session. Source Platform capture
 * that produces new transcripts lands with the platform ticket; until then
 * a session with no cached digest has nothing to show.
 */
async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentTranscript) {
    showState("results");
    return;
  }

  const videoChanged = videoId !== currentVideoId;

  if (videoChanged) {
    resetTranscriptSearch();
    lastTranscriptScrollTop = 0;
    pendingTranscriptViewState = await loadTranscriptViewState(videoId);
    document
      .getElementById("contentArea")
      ?.classList.toggle(
        "restoring-transcript-view",
        Boolean(pendingTranscriptViewState),
      );
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptLanguage = cached.transcriptLanguage || null;

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";
    restorePendingTranscriptViewState(videoId);

    // Load notes for this video
    loadNotes(videoId);
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptLanguage = null;

  // No transcript source is wired up yet (Source Platform capture lands
  // with the platform ticket), so a session without a cached digest has
  // nothing to show.
  showState("welcome");
}

// ============================================================
// RENDERING
// ============================================================

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    transcriptList.appendChild(div);
  });

  // Reapply an active query after a language mode rerenders the transcript.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });
}

// ============================================================
// TRANSCRIPT SEARCH
// ============================================================

/**
 * Finds separate, case-insensitive literal matches. A literal search is
 * important here because punctuation such as "." must be treated as transcript
 * text, not as a regular expression command.
 */
function findLiteralTranscriptMatches(text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) return [];

  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escapedNeedle, "giu");
  const matches = [];
  for (const match of source.matchAll(matcher)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  return matches;
}

/**
 * Removes old marks before a new search. Restoring plain text first prevents
 * nested marks when the user types one more letter into the search field.
 */
function clearTranscriptSearchHighlights() {
  document
    .querySelectorAll("#transcriptList mark.transcript-search-highlight")
    .forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize();
    });

  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));
}

/**
 * Replaces matching parts of one text node with mark elements. We collect all
 * text nodes before changing the DOM, so each replacement is safe and stable.
 */
function markTranscriptTextNode(textNode, query) {
  const ranges = findLiteralTranscriptMatches(textNode.nodeValue, query);
  if (!ranges.length) return [];

  const fragment = document.createDocumentFragment();
  const marks = [];
  let cursor = 0;

  ranges.forEach(({ start, end }) => {
    if (start > cursor) {
      fragment.appendChild(
        document.createTextNode(textNode.nodeValue.slice(cursor, start)),
      );
    }

    const mark = document.createElement("mark");
    mark.className = "transcript-search-highlight";
    mark.textContent = textNode.nodeValue.slice(start, end);
    fragment.appendChild(mark);
    marks.push(mark);
    cursor = end;
  });

  if (cursor < textNode.nodeValue.length) {
    fragment.appendChild(
      document.createTextNode(textNode.nodeValue.slice(cursor)),
    );
  }

  textNode.parentNode.replaceChild(fragment, textNode);
  return marks;
}

/**
 * Updates the result count and navigation buttons from the current search
 * state. The live output gives the same information to screen reader users.
 */
function updateTranscriptSearchControls(query) {
  const count = document.getElementById("transcriptSearchCount");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  const hasMatches = transcriptSearchMatches.length > 0;

  if (count) {
    count.textContent = !query
      ? ""
      : hasMatches
        ? `${transcriptSearchIndex + 1} / ${transcriptSearchMatches.length}`
        : "无匹配结果";
  }
  if (previous) previous.disabled = !hasMatches;
  if (next) next.disabled = !hasMatches;
}

/**
 * Shows which match is current.
 */
function revealCurrentTranscriptSearchMatch({ scroll = true } = {}) {
  transcriptSearchMatches.forEach((mark) => mark.classList.remove("current"));
  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));

  const mark = transcriptSearchMatches[transcriptSearchIndex];
  if (!mark) return;

  mark.classList.add("current");
  mark.closest(".transcript-entry")?.classList.add("search-current");

  if (!scroll) return;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Searches the transcript that is visible now. This means Original searches
 * source subtitles, Chinese searches translated text, and Bilingual searches
 * both columns. Translated rows call this again as their text arrives.
 */
function refreshTranscriptSearch({ preserveIndex = false, scroll = true } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const query = String(input?.value || "").trim();
  const previousIndex = transcriptSearchIndex;

  clearTranscriptSearchHighlights();
  transcriptSearchMatches = [];
  transcriptSearchIndex = -1;
  if (clearButton) clearButton.hidden = !input?.value;

  if (!query) {
    updateTranscriptSearchControls(query);
    return;
  }

  document
    .querySelectorAll("#transcriptList .transcript-entry")
    .forEach((row) => {
      const content = row.querySelector(".transcript-text, .transcript-copy");
      if (!content) return;

      const textNodes = [];
      const walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!node.nodeValue || parent?.closest("button")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((node) => {
        transcriptSearchMatches.push(...markTranscriptTextNode(node, query));
      });
    });

  if (transcriptSearchMatches.length) {
    transcriptSearchIndex = preserveIndex
      ? Math.min(Math.max(previousIndex, 0), transcriptSearchMatches.length - 1)
      : 0;
    revealCurrentTranscriptSearchMatch({ scroll });
  }
  updateTranscriptSearchControls(query);
}

/**
 * Moves through results in a loop, like the browser's built-in Find control.
 */
function moveTranscriptSearch(direction) {
  if (!transcriptSearchMatches.length) return;
  transcriptSearchIndex =
    (transcriptSearchIndex + direction + transcriptSearchMatches.length) %
    transcriptSearchMatches.length;
  revealCurrentTranscriptSearchMatch();
  updateTranscriptSearchControls(
    document.getElementById("transcriptSearchInput")?.value.trim(),
  );
}/**
 * Clears search when the user opens a different video. A query for the old
 * video is unlikely to help and can make the next transcript look empty.
 */
function resetTranscriptSearch({ focus = false } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  if (input) input.value = "";
  refreshTranscriptSearch({ scroll: false });
  if (focus) input?.focus();
}

/**
 * Wires mouse and keyboard controls once when the side panel starts.
 */
function setupTranscriptSearch() {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  if (!input) return;

  input.addEventListener("input", () => refreshTranscriptSearch());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveTranscriptSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      resetTranscriptSearch({ focus: true });
    }
  });

  clearButton?.addEventListener("click", () => {
    resetTranscriptSearch({ focus: true });
  });
  previous?.addEventListener("click", () => moveTranscriptSearch(-1));
  next?.addEventListener("click", () => moveTranscriptSearch(1));
}

function getDisplayedTranscriptText() {
  return currentTranscriptText || "";
}

function copyTranscript() {
  copyToClipboardWithFeedback(getDisplayedTranscriptText(), "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = getDisplayedTranscriptText();

  let exportText = "";
  exportText += `逐字稿\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `标题：${currentVideoTitle || "未知"}\n`;
  exportText += `课程：${currentChannelName || "未知"}\n`;
  exportText += `\n${"=".repeat(60)}\n\n`;

  exportText += `逐字稿：\n\n${transcriptContent}\n`;
  exportText += `\n${"=".repeat(60)}\n`;
  exportText += `由 Learning Digest 导出\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "重试";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasAiKey) missingKeys.push("OpenRouter API 密钥");

  showState("error");
  document.getElementById("errorTitle").textContent = "缺少 API 密钥";
  document.getElementById("errorMessage").textContent =
    `请在 Learning Digest 设置中填写你的 ${missingKeys.join(" 和 ")}。`;
  document.getElementById("errorBtn").textContent = "打开设置";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  // Capture the transcript position before another tab reuses the same scroll
  // area. Scrolling Overview or Notes must not replace this value.
  if (tabName !== "transcript" && transcriptTabIsActive()) {
    captureCurrentTranscriptScrollTop();
    dismissSelectionActions(true);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Restore the independent transcript reading position when the user
  // returns here (Notes always opens at the top instead).
  if (tabName === "transcript") {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      if (!contentArea || !transcriptTabIsActive()) return;
      contentArea.scrollTop = lastTranscriptScrollTop;
    });
  }

  // Saved notes are stored newest first. Open Notes at the top so the note the
  // user just created is the first item they see.
  if (tabName === "notes") {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      const notesPanelIsActive = document.querySelector(
        '.tab-panel[data-panel="notes"].active',
      );
      if (contentArea && notesPanelIsActive) contentArea.scrollTop = 0;
    });
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "已复制";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION ACTIONS
// ============================================================

/**
 * Hides actions that belong only to a live transcript selection. Clearing the
 * browser range also prevents the toolbar from returning on another tab.
 */
function dismissSelectionActions(clearSelection = false) {
  const tooltip = document.getElementById("explainTooltip");
  if (tooltip) tooltip.style.display = "none";
  if (clearSelection) window.getSelection()?.removeAllRanges();
}

/**
 * Sets up text selection handling for both transcript surfaces (the legacy
 * digest rows and the Session transcript records). When the user selects
 * text in either, shows Explain and Note actions.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  const sessionTranscript = document.getElementById("sessionTranscript");
  if (!transcriptList && !sessionTranscript) return;

  // This setup can run again (it aborts old document listeners so one
  // selection creates only one action toolbar).
  selectionActionsController?.abort();
  selectionActionsController = new AbortController();
  const selectionSignal = selectionActionsController.signal;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create one small toolbar for actions on the selected transcript text.
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.setAttribute("role", "toolbar");
  tooltip.setAttribute("aria-label", "选中文字操作");
  const explainButton = document.createElement("button");
  explainButton.type = "button";
  explainButton.className = "explain-btn";
  explainButton.textContent = "解释";
  const noteButton = document.createElement("button");
  noteButton.type = "button";
  noteButton.className = "selection-note-btn";
  noteButton.textContent = "笔记";
  tooltip.append(explainButton, noteButton);
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  const selectionContainers = [transcriptList, sessionTranscript].filter(
    Boolean,
  );

  let selectedText = "";
  let selectedTimestamp = 0;

  // Interacting with either action must preserve the transcript selection and
  // stay isolated from document and row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener(
    "mouseup",
    () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;

      // Both ends must be inside one of the transcript surfaces. The first
      // selected row supplies the timestamp when the selection spans more
      // than one row; session rows carry their start second too.
      const isInTranscript = Boolean(
        range &&
          selectionContainers.some(
            (container) =>
              container.contains(range.startContainer) &&
              container.contains(range.endContainer),
          ),
      );

      // Allow any selection length.
      if (text.length > 0 && isInTranscript) {
        selectedText = text;
        const startElement =
          range.startContainer.nodeType === 1
            ? range.startContainer
            : range.startContainer.parentElement;
        const selectedRow = startElement?.closest(
          ".transcript-entry, .session-record",
        );
        const rowSeconds = Number(selectedRow?.dataset.seconds);
        selectedTimestamp = Number.isFinite(rowSeconds) ? rowSeconds : 0;

        // Set the final coordinates while the toolbar is still hidden. If it
        // becomes visible first, Chrome paints it at its default left edge for
        // one frame before moving it to the selection center.
        const rect = range.getBoundingClientRect();
        tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
        tooltip.style.display = "flex";
      } else {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Hide tooltip when clicking elsewhere
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!tooltip.contains(event.target)) {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Handle explain button click
  explainButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedText) return;

    tooltip.style.display = "none";
    await showExplanation(selectedText);
  });

  // Save the exact selected words at the first selected transcript row. This
  // action does not move playback and does not ask the AI to rewrite the text.
  noteButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = noteSaveTarget();
    if (!selectedText || !target) return;

    const button = event.currentTarget;
    const originalText = button.textContent;
    button.textContent = "保存中…";
    button.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        action: "saveNote",
        videoId: target.videoId,
        timestamp: selectedTimestamp,
        videoTitle: target.videoTitle,
        channelName: target.channelName,
        selectedText,
      });

      if (!result?.success) {
        throw new Error(result?.error || "Could not save note");
      }

      button.textContent = "已保存";
      loadNotes(currentNotesScopeId());
      setTimeout(() => {
        tooltip.style.display = "none";
        button.textContent = originalText;
        button.disabled = false;
      }, 900);
    } catch (error) {
      console.error("[Learning Digest] Save selected note error:", error);
      button.textContent = "出错";
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
      }, 1500);
    }
  });
}

/**
 * Where a note saved from the selection toolbar belongs: a loaded legacy
 * digest stores it under the video id with the video's title; a Session
 * stores it under the Session id with the course title the page bridge
 * reported (falling back to the id). With no target there is nothing to
 * attach the note to.
 */
function noteSaveTarget() {
  if (currentVideoId) {
    return {
      videoId: currentVideoId,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    };
  }
  const sessionId = currentSessionContextId();
  if (!sessionId) return null;
  return {
    videoId: sessionId,
    videoTitle: sessionUi.title || sessionId,
    channelName: "",
  };
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">解释</div>
        <button class="explain-modal-close" id="closeExplain">关闭</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>正在分析…</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">获取解释失败：${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">错误：${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================
// The digest_<videoId> cache is read-only legacy data now: the analysis pass
// that wrote it was removed with the legacy Overview (#31), so pre-0.1.31
// cached transcripts still render but nothing writes new entries. Eviction
// and the 30-day expiry keep old entries from piling up.

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[Learning Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * The Session id the panel's session-mode surfaces currently belong to: the
 * active one, else the last observed one (kept after the Session ends so
 * notes and jumps keep working while its transcript is still on screen),
 * else the Session whose report the startup scan adopted.
 */
function currentSessionContextId() {
  return (
    sessionUi.sessionId || sessionUi.lastSessionId || reportTabUi.sessionId || null
  );
}

/**
 * The 本会话 notes scope: a loaded legacy digest's video, else the current
 * Session context. Null means all notes.
 */
function currentNotesScopeId() {
  return currentVideoId || currentSessionContextId();
}

/**
 * True when the note belongs to the current Session context: its stamp then
 * jumps into the Session transcript. Legacy video notes keep their plain,
 * non-jumping stamp.
 */
function noteStampJumps(note) {
  const sessionId = currentSessionContextId();
  return Boolean(sessionId) && note.videoId === sessionId;
}

/**
 * One delegated listener for the notes list: session notes render a
 * clickable [m:ss] stamp that jumps to the transcript position (the same
 * affordance the Overview timestamps use).
 */
function handleNotesListClick(event) {
  const stamp = event.target?.closest?.(".note-timestamp-jump");
  if (!stamp) return;
  jumpToTranscriptTimestamp(Number(stamp.dataset.seconds));
}

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success) {
      currentNotes = result.notes || [];
      currentNotesFilterVideoId = videoId;
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[Learning Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent =
      "在逐字稿中选中文字，点击浮条上的「笔记」即可保存。";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note, index) => {
    const stampClasses = noteStampJumps(note)
      ? "note-timestamp note-timestamp-jump"
      : "note-timestamp";
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="${stampClasses}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
      </div>
      <div class="note-text">${escapeHtml(note.text)}</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">复制文字</button>
        <button class="note-delete" data-id="${escapeHtml(note.id)}" type="button" aria-label="删除笔记" title="删除笔记">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="m19 6-1 14H6L5 6"></path>
            <path d="M10 11v5"></path>
            <path d="M14 11v5"></path>
          </svg>
        </button>
      </div>
    `;

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.text);
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "已复制";
          setTimeout(() => {
            btn.textContent = "复制文字";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    notesList.appendChild(noteEl);
  });

}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[Learning Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// TRANSCRIPT READING POSITION
// ============================================================
// The panel remembers each session's last visible transcript position so a
// reopen lands where the user stopped reading.

/**
 * Uses session storage when it is available. Local storage is a safe fallback
 * for older test or browser environments that do not expose session storage.
 */
function getTranscriptViewStateStorage() {
  return chrome.storage.session || chrome.storage.local;
}

/**
 * Reads one session's last visible transcript position.
 */
async function loadTranscriptViewState(videoId) {
  if (!videoId) return null;
  try {
    const result = await getTranscriptViewStateStorage().get(
      TRANSCRIPT_VIEW_STATE_KEY,
    );
    const state = result?.[TRANSCRIPT_VIEW_STATE_KEY]?.[videoId];
    const scrollTop = Number(state?.scrollTop);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
    return { videoId, scrollTop };
  } catch (error) {
    console.error("[Learning Digest] Reading position load error:", error);
    return null;
  }
}

/**
 * Stores positions for a small recent set of sessions. This prevents one value
 * from growing without a limit during a long Chrome session.
 */
async function saveTranscriptViewState(videoId, scrollTop) {
  if (!videoId || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    const storage = getTranscriptViewStateStorage();
    const result = await storage.get(TRANSCRIPT_VIEW_STATE_KEY);
    const states = result?.[TRANSCRIPT_VIEW_STATE_KEY] || {};
    states[videoId] = { scrollTop, updatedAt: Date.now() };

    const recentStates = Object.fromEntries(
      Object.entries(states)
        .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 20),
    );
    await storage.set({ [TRANSCRIPT_VIEW_STATE_KEY]: recentStates });
  } catch (error) {
    console.error("[Learning Digest] Reading position save error:", error);
  }
}

/**
 * Saves the visible position after scrolling stops. Capturing the session ID
 * and position now prevents a later session change from writing the wrong state.
 */
function scheduleTranscriptViewStateSave() {
  if (
    isRestoringTranscriptView ||
    !currentVideoId ||
    !transcriptTabIsActive()
  ) {
    return;
  }
  const contentArea = document.getElementById("contentArea");
  if (!contentArea) return;

  const videoId = currentVideoId;
  const scrollTop = contentArea.scrollTop;
  lastTranscriptScrollTop = scrollTop;
  clearTimeout(transcriptViewStateSaveTimer);
  transcriptViewStateSaveTimer = setTimeout(() => {
    void saveTranscriptViewState(videoId, scrollTop);
  }, 150);
}

/**
 * Saves immediately before the panel closes.
 */
function saveCurrentTranscriptViewState() {
  clearTimeout(transcriptViewStateSaveTimer);
  const contentArea = document.getElementById("contentArea");
  if (!currentVideoId || !contentArea) return Promise.resolve();
  if (transcriptTabIsActive()) captureCurrentTranscriptScrollTop();
  return saveTranscriptViewState(currentVideoId, lastTranscriptScrollTop);
}

/**
 * Returns true only while the Transcript tab is the visible results panel.
 */
function transcriptTabIsActive() {
  return resultTabIsActive("transcript");
}

function resultTabIsActive(tabName) {
  return Boolean(
    document.querySelector(
      `.tab-panel[data-panel="${CSS.escape(tabName)}"].active`,
    ),
  );
}

/**
 * Copies the shared scroll area's current value into transcript-only state.
 */
function captureCurrentTranscriptScrollTop() {
  const contentArea = document.getElementById("contentArea");
  if (contentArea) lastTranscriptScrollTop = contentArea.scrollTop;
}

/**
 * Restores the saved position after the transcript becomes visible.
 */
function restorePendingTranscriptViewState(videoId) {
  const state = pendingTranscriptViewState;
  pendingTranscriptViewState = null;
  const contentArea = document.getElementById("contentArea");
  if (!state || state.videoId !== videoId) {
    contentArea?.classList.remove("restoring-transcript-view");
    return;
  }

  requestAnimationFrame(() => {
    if (currentVideoId !== videoId || !contentArea) {
      contentArea?.classList.remove("restoring-transcript-view");
      return;
    }

    isRestoringTranscriptView = true;
    contentArea.scrollTop = state.scrollTop;
    lastTranscriptScrollTop = state.scrollTop;
    contentArea.classList.remove("restoring-transcript-view");
    requestAnimationFrame(() => {
      isRestoringTranscriptView = false;
    });
  });
}


// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  groupTranscriptEntries,
  splitOversizedThought,
  findLiteralTranscriptMatches,
  loadTranscriptViewState,
  saveTranscriptViewState,
  renderSubtitleInlineMarkup,
  switchTab,
};

// Report tab helpers for the repository's Node tests (#30). The extension
// does not read this object at runtime.
globalThis.__YTD_REPORT_TESTING__ = {
  renderReportTab,
  applyReportPayloadToTab,
  adoptLatestStoredReport,
  reportTabSetActiveSession,
  showSessionMode,
  retryReportFromTab,
  openReportInTab,
  openReportForPrint,
  downloadReportFile,
  resetReportTabForTesting,
};

// Overview tab helpers for the repository's Node tests (#31). The extension
// does not read this object at runtime.
globalThis.__YTD_OVERVIEW_TESTING__ = {
  renderOverviewTab,
  jumpToTranscriptTimestamp,
  findSessionRecordForSeconds,
};

// Session-mode IA helpers for the repository's Node tests (0.1.37). The
// extension does not read this object at runtime.
globalThis.__YTD_SESSION_TESTING__ = {
  setupExplainFeature,
  startDigest,
  applyNotesFilter,
  handleNotesListClick,
  renderNotes,
  loadNotes,
  refreshSummaryIntervalMinutes,
  segmentLengthLabel,
  setSegmentLengthForCopy(value) {
    segmentLengthForCopy = value;
  },
};

// ============================================================
// SESSION CAPTURE UX (xiaoe-tech Source Platform)
// ============================================================
//
// The panel reflects the Session started by the toolbar icon click
// (Chrome's tabCapture invocation rule makes a panel-side start button
// unusable, so there isn't one) and offers「结束学习」during an active
// Session. Transcript records render incrementally as the background
// pipeline broadcasts sessionUpdate; reopening the panel re-syncs from the
// persisted Session (resume), so finished Segments are never re-transcribed.

const sessionUi = {
  sessionId: null,
  // The most recently observed Session, kept after it ends so the notes
  // tab's 本会话 scope and the note stamps keep working while the ended
  // Session's transcript is still on screen.
  lastSessionId: null,
  // The course title the page bridge reported for the Session (#32); used
  // as the title of session-mode notes.
  title: null,
  titleSessionId: null,
  kind: null,
  timestampKind: null,
  renderedRecords: 0,
  active: false,
  // True once an end-time report has been adopted: the Session view (the
  // transcript the report's timestamps jump into) stays visible after the
  // Session ends instead of being wiped by the 5s poll.
  reportShown: false,
};

/**
 * Remembers the current Session's course title (the page bridge reports it
 * once per Session, #32). A new Session id starts with a fresh title.
 */
function observeSessionTitle(state) {
  if (!state?.sessionId) return;
  if (state.sessionId !== sessionUi.titleSessionId) {
    sessionUi.titleSessionId = state.sessionId;
    sessionUi.title = null;
  }
  if (typeof state.title === "string" && state.title) {
    sessionUi.title = state.title;
  }
}

const SESSION_KIND_LABELS = {
  live: "直播",
  replay: "回放",
  course: "课程",
};

function sessionTimestampLabel(startSeconds) {
  const total = Math.floor(Number(startSeconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? hours + ":" : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

/** A record's start second, clamped to a plain non-negative integer. */
function recordStartSeconds(startSeconds) {
  return Math.max(0, Math.floor(Number(startSeconds) || 0));
}

function renderSessionStatus() {
  const status = document.getElementById("sessionStatus");
  if (!status) return;
  const kindLabel = SESSION_KIND_LABELS[sessionUi.kind] || sessionUi.kind || "";
  status.textContent = sessionUi.active
    ? `${kindLabel} · 正在采集音频`
    : kindLabel;
}

function renderSessionTranscript(state) {
  const container = document.getElementById("sessionTranscript");
  if (!container || !state) return;
  const records = state.transcriptRecords || [];
  for (const record of records.slice(sessionUi.renderedRecords)) {
    const row = document.createElement("div");
    row.className = record.failed
      ? "session-record session-record-failed"
      : "session-record";
    // The Overview's timestamp jumps target rows by start second (#31).
    row.dataset.seconds = String(recordStartSeconds(record.start));
    const stamp = document.createElement("span");
    stamp.className = "session-record-stamp";
    stamp.textContent = `[${sessionTimestampLabel(record.start)}]`;
    const text = document.createElement("span");
    text.className = "session-record-text";
    text.textContent = record.text;
    row.append(stamp, text);
    container.appendChild(row);
  }
  sessionUi.renderedRecords = records.length;
  renderPendingSegments(container, state);
  container.scrollTop = container.scrollHeight;
}

// Pending Segments (and the wait before the very first one) render as
// spinner rows — the same loading affordance the original digest
// transcript had: the learner sees activity at 0:00 instead of an empty
// pane while the first Segment is still being recorded and transcribed.
function renderPendingSegments(container, state) {
  container.querySelectorAll(".session-pending").forEach((row) => row.remove());
  const segments = state.segments || [];
  const bootstrap =
    segments.length === 0 && (state.transcriptRecords || []).length === 0;
  if (bootstrap) {
    appendPendingRow(container, 0, `录制中，第一段逐字稿约 ${segmentLengthLabel()} 后出现…`);
  }
  for (const segment of segments) {
    if (segment.status === "pending") {
      appendPendingRow(container, segment.start, "转写中…");
    }
  }
}

function appendPendingRow(container, startSeconds, text) {
  const row = document.createElement("div");
  row.className = "session-record session-pending";
  row.dataset.seconds = String(recordStartSeconds(startSeconds));
  const stamp = document.createElement("span");
  stamp.className = "session-record-stamp";
  stamp.textContent = `[${sessionTimestampLabel(startSeconds)}]`;
  const spinner = document.createElement("span");
  spinner.className = "session-pending-spinner";
  const label = document.createElement("span");
  label.className = "session-record-text";
  label.textContent = text;
  row.append(stamp, spinner, label);
  container.appendChild(row);
}

// True when a report payload carries anything renderable at all (error,
// skipped marker, or at least one Topic/quote/todo). Shared by the report
// adoption path and the 纪要 tab funnel.
function reportHasContent(report) {
  return Boolean(
    report &&
      typeof report === "object" &&
      (report.error ||
        report.skipped ||
        (Array.isArray(report.topics) && report.topics.length > 0) ||
        (Array.isArray(report.quotes) && report.quotes.length > 0) ||
        (Array.isArray(report.todos) && report.todos.length > 0)),
  );
}

/**
 * The end-time Session Digest arrives here from every path (broadcast,
 * endLearning, retry): the 纪要 tab funnel adopts it and the 概览 tab
 * re-renders from the same artifact, so the final report Topics replace the
 * live timeline. Keeping the Session view open afterwards preserves the
 * transcript those timestamps jump into.
 */
function adoptSessionReport(report, sessionId) {
  if (!reportHasContent(report)) return;
  sessionUi.reportShown = true;
  void applyReportPayloadToTab(report, sessionId);
}

// ============================================================
// REPORT TAB (#30): the 纪要 tab's report surface
// ============================================================
//
// One tab state at a time, derived from what the panel knows: a failed pass
// (report.error) shows the retry affordance; a persisted artifact renders
// compactly; an active Session shows the generating hint; anything else is
// the idle line. The startup scan (D7) surfaces the most recent persisted
// report so reopening the panel is never a dead end. This tab is the
// deliverable's full surface; every report arrival funnels here (and the
// 概览 tab re-renders from the same artifact).

const reportTabUi = {
  // The Session the tab is about; a new active Session retires the artifact.
  sessionId: null,
  // The latest report artifact {sessionId, report, meta, generatedAtMs}.
  artifact: null,
  // A retryable failure from the end-time pass: { message, sessionId }.
  error: null,
  // The end-time pass found no Transcript: informational, not retryable.
  skipped: false,
  // True while a regenerateReport request is in flight.
  regenerating: false,
};

function reportTabElements() {
  return {
    hint: document.getElementById("reportTabHint"),
    actions: document.getElementById("reportTabActions"),
    errorBox: document.getElementById("reportTabError"),
    errorText: document.getElementById("reportTabErrorText"),
    body: document.getElementById("reportTabBody"),
  };
}

/**
 * The 纪要 tab button. renderReportTab owns its enabled/disabled state:
 * while the Session is still generating the deliverable there is nothing to
 * open, so the tab is disabled with a tooltip; the report arriving (ready
 * or failed-with-retry) re-enables it.
 */
function reportTabButton() {
  return (
    Array.from(document.querySelectorAll(".tab")).find(
      (tab) => tab.dataset.tab === "report",
    ) || null
  );
}

/**
 * Renders the current report-tab state. Idempotent: every state change
 * re-renders the whole tab from reportTabUi. The 概览 tab renders from the
 * same artifact, so this is also its refresh point (#31).
 */
function renderReportTab() {
  renderOverviewTab();
  const els = reportTabElements();
  if (!els.hint || !els.actions || !els.errorBox || !els.errorText || !els.body) {
    return;
  }
  const tabButton = reportTabButton();
  if (tabButton) {
    // Default: openable. The generating branch below disables it again.
    tabButton.disabled = false;
    tabButton.title = "";
  }
  els.errorBox.style.display = "none";
  els.actions.style.display = "none";
  els.body.style.display = "none";
  // The body is a pure function of the current state: stale compact markup
  // never survives a state change.
  els.body.innerHTML = "";
  els.hint.style.display = "none";

  const artifact = reportTabUi.artifact;
  const report = artifact?.report;
  if (report && !report.error && !report.skipped) {
    els.body.innerHTML = reportRender.renderReportCompact(
      report,
      artifact.meta || null,
    );
    els.body.style.display = "block";
    els.actions.style.display = "flex";
    return;
  }
  if (reportTabUi.error) {
    els.errorText.textContent = reportTabUi.error.message;
    els.errorBox.style.display = "flex";
    return;
  }
  if (reportTabUi.skipped) {
    els.hint.textContent = "未捕获到逐字稿，未生成学习纪要。";
    els.hint.style.display = "flex";
    return;
  }
  if (reportTabUi.regenerating) {
    els.hint.textContent = "正在重新生成学习纪要…";
    els.hint.style.display = "flex";
    return;
  }
  if (sessionUi.active) {
    els.hint.textContent = "报告生成中…";
    els.hint.style.display = "flex";
    if (tabButton) {
      tabButton.disabled = true;
      tabButton.title = "报告生成中…";
    }
    return;
  }
  els.hint.textContent = "结束学习后，学习纪要会显示在这里。";
  els.hint.style.display = "flex";
}

/**
 * A new active Session (or the same one re-observed after resume): only an
 * id change retires the previous state, so the 5s poll cannot wipe a report
 * that just arrived.
 */
function reportTabSetActiveSession(sessionId) {
  if (reportTabUi.sessionId === sessionId) return;
  reportTabUi.sessionId = sessionId;
  reportTabUi.artifact = null;
  reportTabUi.error = null;
  reportTabUi.skipped = false;
  reportTabUi.regenerating = false;
  renderReportTab();
}

/**
 * The one funnel for report arrivals (broadcast, endLearning, retry
 * response): failed passes show the error, skipped passes show the hint,
 * and successful ones prefer the persisted artifact — it carries meta and
 * generatedAtMs that the broadcast payload lacks. A stale arrival for an
 * older Session never supersedes the current one.
 *
 * @param {object} report - the report payload
 * @param {string|null} sessionId - the Session it belongs to
 */
async function applyReportPayloadToTab(report, sessionId) {
  if (!report || typeof report !== "object" || !reportHasContent(report)) return;
  if (
    sessionId &&
    reportTabUi.sessionId &&
    sessionId !== reportTabUi.sessionId
  ) {
    return;
  }
  if (sessionId) reportTabUi.sessionId = sessionId;
  reportTabUi.regenerating = false;
  if (report.error) {
    reportTabUi.error = { message: report.error, sessionId: sessionId || null };
    reportTabUi.artifact = null;
    reportTabUi.skipped = false;
    renderReportTab();
    return;
  }
  if (report.skipped) {
    reportTabUi.skipped = true;
    reportTabUi.error = null;
    reportTabUi.artifact = null;
    renderReportTab();
    return;
  }
  reportTabUi.error = null;
  reportTabUi.skipped = false;
  let artifact = null;
  if (sessionId) {
    try {
      const storageKey = `${reportRender.REPORT_STORAGE_KEY_PREFIX}${sessionId}`;
      const stored = await chrome.storage.local.get(storageKey);
      artifact = stored?.[storageKey] || null;
    } catch (_error) {
      // Storage unreachable; the payload itself is the fallback below.
    }
  }
  if (artifact?.report && !artifact.report.error && !artifact.report.skipped) {
    reportTabUi.artifact = artifact;
  } else {
    reportTabUi.artifact = { sessionId: sessionId || null, report, meta: null };
  }
  renderReportTab();
}

/**
 * The startup scan (D7): the most recent report_<sessionId> in storage
 * wins (latest generatedAtMs), shown even with no active Session. Skipped
 * while a Session is active — the tab then belongs to the running Session.
 */
async function adoptLatestStoredReport() {
  if (sessionUi.active) return;
  let best = null;
  try {
    const all = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(all || {})) {
      if (!key.startsWith(reportRender.REPORT_STORAGE_KEY_PREFIX)) continue;
      if (!value || typeof value !== "object") continue;
      if (!value.report || typeof value.report !== "object") continue;
      if (value.report.error || value.report.skipped) continue;
      const at = Number(value.generatedAtMs) || 0;
      if (!best || at > (Number(best.generatedAtMs) || 0)) best = value;
    }
  } catch (_error) {
    best = null; // Storage unavailable; the tab renders its idle state.
  }
  if (best) {
    reportTabUi.sessionId = best.sessionId || reportTabUi.sessionId;
    reportTabUi.artifact = best;
    // D7: the deliverable exists with no active Session — surface it.
    surfaceReportTab();
  }
  // Render even when nothing was found: this is the tab's first paint, and
  // the idle line must be visible before any session activity.
  renderReportTab();
}

/**
 * Surfaces the deliverable (#30): shows the results view with the 纪要 tab
 * active. In session mode the Session view (live transcript, end-time card)
 * stays visible above it; a loaded legacy video digest keeps its own tab
 * choice.
 */
function surfaceReportTab() {
  if (currentVideoId) return;
  showState("results");
  switchTab("report");
}

/**
 * The 重试 action: re-runs the end-of-session global pass for the failed
 * Session. While it runs the tab shows the regenerating hint; the direct
 * response re-lands the result (the background also broadcasts).
 */
async function retryReportFromTab() {
  const sessionId = reportTabUi.error?.sessionId || reportTabUi.sessionId;
  reportTabUi.regenerating = true;
  renderReportTab();
  try {
    const result = await chrome.runtime.sendMessage({
      action: "regenerateReport",
      sessionId: sessionId || undefined,
    });
    if (result?.report) {
      await applyReportPayloadToTab(result.report, result.sessionId || sessionId);
      return;
    }
  } catch (_error) {
    // Background unreachable; restore the failed state below.
  }
  reportTabUi.regenerating = false;
  renderReportTab();
}

/**
 * The Session id the report actions act on: the shown artifact wins, then
 * the failed report's Session, then the tab's active Session.
 */
function reportTargetSessionId() {
  return (
    reportTabUi.artifact?.sessionId ||
    reportTabUi.error?.sessionId ||
    reportTabUi.sessionId ||
    null
  );
}

/** Opens the shown session's report page in a browser tab. */
function openReportInTab() {
  const sessionId = reportTargetSessionId();
  if (!sessionId) return;
  chrome.tabs.create({
    url: `${chrome.runtime.getURL("report.html")}?session=${encodeURIComponent(sessionId)}`,
  });
}

/** 打印 / 存为 PDF: opens the report page with ?print=1 so it auto-prints. */
function openReportForPrint() {
  const sessionId = reportTargetSessionId();
  if (!sessionId) return;
  chrome.tabs.create({
    url: `${chrome.runtime.getURL("report.html")}?session=${encodeURIComponent(sessionId)}&print=1`,
  });
}

/** Downloads the shown report as .html or .md, named after the Session. */
function downloadReportFile(format) {
  const artifact = reportTabUi.artifact;
  const report = artifact?.report;
  if (!report) return;
  const sessionId = artifact.sessionId || "session";
  if (format === "markdown") {
    downloadTextFile(
      reportRender.renderReportMarkdown(report, artifact.meta || null),
      `learning-digest-report-${sessionId}.md`,
    );
    return;
  }
  downloadTextFile(
    reportRender.renderReportHtml(report, artifact.meta || null),
    `learning-digest-report-${sessionId}.html`,
  );
}

function setupReportTab() {
  document
    .getElementById("reportOpenBtn")
    ?.addEventListener("click", openReportInTab);
  document
    .getElementById("reportPrintBtn")
    ?.addEventListener("click", openReportForPrint);
  document
    .getElementById("reportDownloadHtmlBtn")
    ?.addEventListener("click", () => downloadReportFile("html"));
  document
    .getElementById("reportDownloadMdBtn")
    ?.addEventListener("click", () => downloadReportFile("markdown"));
  document
    .getElementById("reportRetryBtn")
    ?.addEventListener("click", retryReportFromTab);
}

function resetReportTabForTesting() {
  reportTabUi.sessionId = null;
  reportTabUi.artifact = null;
  reportTabUi.error = null;
  reportTabUi.skipped = false;
  reportTabUi.regenerating = false;
}

// ============================================================
// OVERVIEW TAB (#31): the Topic timeline and quotes
// ============================================================
//
// The 概览 tab has two blocks: the Topic timeline first, quotes second.
// During a Session the timeline shows the live Rolling Summary's Topics
// (append-only, #28); once the end-time report is adopted it shows the
// report's merged Topics from the same artifact the 纪要 funnel holds — no
// second AI pass, no lazy self-analysis. Quotes only exist after the report.
// Every timestamp is a jump control: clicking it opens the 逐字稿 tab at the
// matching Session transcript record. Until there is anything to show, the
// tab shows guidance instead.

const OVERVIEW_EMPTY_TEXT = "结束一次学习会话后，这里会显示话题与金句。";

// The Rolling Summary tick interval (settings.summaryIntervalMinutes): the
// pre-first-tick hint names it. Refreshed from storage when a Session starts.
let summaryIntervalMinutes = 15;

function overviewElements() {
  return {
    empty: document.getElementById("overviewEmpty"),
    topicsSection: document.getElementById("overviewTopicsSection"),
    topics: document.getElementById("overviewTopics"),
    quotesSection: document.getElementById("overviewQuotesSection"),
    quotes: document.getElementById("overviewQuotes"),
  };
}

/**
 * Reads the configured summary interval so the first-topic hint is truthful.
 * When the value changes while a Session is running, refreshes the hint —
 * it is only on screen before the first Topic tick renders.
 */
async function refreshSummaryIntervalMinutes() {
  let minutes = 15;
  try {
    if (typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS?.normalize) {
      const result = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
      minutes =
        YTD_SETTINGS.normalize(result?.[YTD_SETTINGS.STORAGE_KEY] || {})
          .summaryIntervalMinutes || 15;
    }
  } catch (_error) {
    // Storage unreachable; the default hint stays.
  }
  if (minutes === summaryIntervalMinutes) return;
  summaryIntervalMinutes = minutes;
  if (!sessionUi.active) return;
  if (document.getElementById("overviewTopics")?.children.length) return;
  renderOverviewLive([], { live: true });
}

/**
 * Renders the Overview tab from the report artifact the 纪要 funnel adopts.
 * Idempotent: every render rebuilds both lists; a state without renderable
 * report content (no report, failed or skipped pass) shows the guidance line.
 */
function renderOverviewTab() {
  const els = overviewElements();
  if (!els.empty || !els.topics || !els.quotes) return;
  const artifact = reportTabUi.artifact;
  const report =
    artifact && !artifact.report.error && !artifact.report.skipped
      ? artifact.report
      : null;
  const topics = Array.isArray(report?.topics) ? report.topics : [];
  const quotes = Array.isArray(report?.quotes) ? report.quotes : [];
  renderOverviewContent(els, topics, quotes, { live: false });
}

/**
 * The live side of the Overview: the Rolling Summary's Topics while a
 * Session runs, or the guidance line once it goes idle. An adopted report
 * owns the tab, so both paths step aside when one is on screen — the final
 * report Topics replace the live ones and live ticks never clobber them.
 */
function renderOverviewLive(topics, { live }) {
  const els = overviewElements();
  if (!els.empty || !els.topics || !els.quotes) return;
  const artifact = reportTabUi.artifact;
  if (artifact?.report && !artifact.report.error && !artifact.report.skipped) {
    return;
  }
  renderOverviewContent(els, Array.isArray(topics) ? topics : [], [], { live });
}

/**
 * Renders one Session tick's Rolling Summary Topics into the timeline.
 * Appended Topics are never rewritten, so re-renders just redraw the list.
 */
function renderLiveTopics(state) {
  renderOverviewLive(state?.topics, { live: true });
}

/**
 * One Overview render, shared by the live timeline and the report funnel:
 * Topics always, quotes only once a report carried them. With nothing to
 * show, the guidance line is the live-session first-topic hint before the
 * first tick and the general line otherwise.
 */
function renderOverviewContent(els, topics, quotes, { live = false } = {}) {
  const hasContent = topics.length > 0 || quotes.length > 0;

  els.empty.textContent =
    live && topics.length === 0
      ? `第一个话题段将在约 ${summaryIntervalMinutes} 分钟后出现。`
      : OVERVIEW_EMPTY_TEXT;
  els.empty.style.display = hasContent ? "none" : "block";
  els.topicsSection.style.display = topics.length ? "block" : "none";
  els.quotesSection.style.display = quotes.length ? "block" : "none";

  els.topics.textContent = "";
  topics.forEach((topic, index) => {
    els.topics.appendChild(buildOverviewTopic(topic, index));
  });

  els.quotes.textContent = "";
  for (const quote of quotes) {
    els.quotes.appendChild(buildOverviewQuote(quote));
  }
}

/** One stop on the Overview timeline: numbered dot, time range, title, summary. */
function buildOverviewTopic(topic, index) {
  const row = document.createElement("div");
  row.classList.add("overview-topic");
  const step = document.createElement("div");
  step.classList.add("overview-topic-step");
  const dot = document.createElement("span");
  dot.classList.add("overview-topic-dot");
  dot.textContent = String(index + 1);
  step.appendChild(dot);
  const content = document.createElement("div");
  content.classList.add("overview-topic-content");
  const title = document.createElement("div");
  title.classList.add("overview-topic-title");
  title.appendChild(
    overviewJumpButton(
      `[${sessionTimestampLabel(topic?.start)}–${sessionTimestampLabel(topic?.end)}]`,
      recordStartSeconds(topic?.start),
    ),
  );
  const name = document.createElement("span");
  name.classList.add("overview-topic-name");
  // A live Topic continuing the previous tick's last one keeps the 续
  // marker; the merged report Topics never carry it.
  name.textContent = topic?.continuation ? `续 ${topic?.title ?? ""}` : topic?.title ?? "";
  title.appendChild(name);
  const summary = document.createElement("div");
  summary.classList.add("overview-topic-summary");
  // Live Topic ticks carry `text`; report Topics carry `summary`.
  summary.textContent = topic?.summary ?? topic?.text ?? "";
  content.append(title, summary);
  row.append(step, content);
  return row;
}

/** One timestamped key quote on the Overview. */
function buildOverviewQuote(quote) {
  const row = document.createElement("div");
  row.classList.add("overview-quote");
  const text = document.createElement("div");
  text.classList.add("overview-quote-text");
  text.appendChild(
    overviewJumpButton(
      `[${sessionTimestampLabel(quote?.start)}]`,
      recordStartSeconds(quote?.start),
    ),
  );
  const body = document.createElement("span");
  body.classList.add("overview-quote-body");
  body.textContent = quote?.text ?? "";
  text.appendChild(body);
  row.appendChild(text);
  return row;
}

/** The clickable [m:ss] control that opens the 逐字稿 at that position. */
function overviewJumpButton(label, seconds) {
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("overview-time");
  button.textContent = label;
  button.addEventListener("click", () => jumpToTranscriptTimestamp(seconds));
  return button;
}

/**
 * Jumps to a transcript position from an Overview timestamp: switches to the
 * 逐字稿 tab, then scrolls the Session transcript to the record at or before
 * that second and highlights it briefly — the same affordance the transcript
 * search uses for its current match.
 */
function jumpToTranscriptTimestamp(seconds) {
  switchTab("transcript");
  // Queue behind switchTab's reading-position restore so the jump scroll is
  // not overwritten by it (requestAnimationFrame callbacks run in order).
  requestAnimationFrame(() => {
    revealSessionRecordAt(seconds);
  });
}

/**
 * Scrolls the Session transcript to the nearest record at or before
 * `seconds` and flashes the jump highlight on it. With no matching record
 * (nothing transcribed that early) only the tab switch happened.
 */
function revealSessionRecordAt(seconds) {
  const container = document.getElementById("sessionTranscript");
  if (!container) return;
  const row = findSessionRecordForSeconds(container, seconds);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("session-record-jump");
  setTimeout(() => row.classList.remove("session-record-jump"), 1600);
}

/**
 * The nearest transcript record at or before `seconds`: rows carry their
 * start second in dataset.seconds, and records render in session order, so
 * the last matching row is the nearest one.
 */
function findSessionRecordForSeconds(container, seconds) {
  const target = Number(seconds);
  if (!Number.isFinite(target)) return null;
  let match = null;
  for (const row of container.children || []) {
    const start = Number(row.dataset?.seconds);
    if (!Number.isFinite(start) || start > target) continue;
    if (!match || start >= Number(match.dataset.seconds)) match = row;
  }
  return match;
}

/**
 * Resets the Overview's live rendering when a Session goes idle with no
 * report on screen. An adopted report keeps the tab (the guard inside
 * renderOverviewLive), and the report's own funnel re-renders it anyway.
 */
function clearLiveOverview() {
  sessionUi.reportShown = false;
  renderOverviewLive([], { live: false });
}

// One-shot-per-Session toast: every path that surfaces an active Session
// (icon auto-start, panel button, panel reopen) funnels through
// showSessionMode, so it is the single place to confirm "recording started".
const toastedSessions = new Set();

function showRecordingToast() {
  let toast = document.getElementById("recordingToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "recordingToast";
    toast.className = "recording-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = `已开始录制 · 逐字稿将在约 ${segmentLengthLabel()}后出现`;
  toast.classList.add("recording-toast-visible");
  clearTimeout(showRecordingToast.timer);
  showRecordingToast.timer = setTimeout(
    () => toast.classList.remove("recording-toast-visible"),
    4000,
  );
}

function showSessionMode({ active, kind, state }) {
  const bar = document.getElementById("sessionBar");
  const view = document.getElementById("sessionView");
  const endBtn = document.getElementById("endLearningBtn");
  const welcome = document.getElementById("welcomeState");
  if (!bar) return;

  if (active) {
    sessionUi.active = true;
    const activeSessionId = state?.sessionId ?? sessionUi.sessionId ?? null;
    if (activeSessionId) {
      sessionUi.sessionId = activeSessionId;
      sessionUi.lastSessionId = activeSessionId;
    }
    observeSessionTitle(state);
    // A new Session retires any previous Session's report state.
    sessionUi.reportShown = false;
    // ...and the 纪要 tab shows the generating hint until the new report
    // lands (#30); only an id change retires it, so the poll is safe.
    const reportSessionBefore = reportTabUi.sessionId;
    reportTabSetActiveSession(activeSessionId);
    // A fresh Session surfaces the deliverable's tab (story 7): the 纪要 tab
    // reads 报告生成中… until the end-time pass lands. Later polls never
    // yank the learner off the tab they picked. The first-topic hint is
    // truthful about the configured tick interval from Session start on.
    if (reportTabUi.sessionId && reportTabUi.sessionId !== reportSessionBefore) {
      surfaceReportTab();
      void refreshSummaryIntervalMinutes();
    }
    bar.style.display = "flex";
    endBtn.style.display = "";
    view.style.display = "";
    if (welcome) welcome.style.display = "none";
    if (state?.sessionId && !toastedSessions.has(state.sessionId)) {
      toastedSessions.add(state.sessionId);
      showRecordingToast();
    }
    renderSessionStatus();
    renderLiveTopics(state);
    renderSessionTranscript(state);
    return;
  }

  sessionUi.active = false;
  sessionUi.sessionId = null;
  sessionUi.renderedRecords = 0;
  endBtn.style.display = "none";
  if (sessionUi.reportShown) {
    // The ended Session's report is on screen: keep the Session view (the
    // transcript its timestamps jump into) open so the 5s poll does not
    // wipe it right after ending.
    view.style.display = "";
  } else {
    view.style.display = "none";
    clearLiveOverview();
    const transcript = document.getElementById("sessionTranscript");
    if (transcript) transcript.textContent = "";
  }

  if (kind && kind !== "none") {
    // The toolbar icon is the only start entry point: a click inside the
    // panel can never satisfy Chrome's tabCapture invocation rule, so the
    // panel deliberately offers no start control at all.
    bar.style.display = "flex";
    sessionUi.kind = kind;
    renderSessionStatus();
    if (welcome && state === null) welcome.style.display = "none";
  } else {
    bar.style.display = "none";
    // D7 (#30): a surfaced report owns the panel — the welcome state must
    // not stack on top of it when the startup scan and this idle render race.
    if (welcome) {
      welcome.style.display =
        reportTabUi.artifact && !currentVideoId ? "none" : "flex";
    }
  }
}

async function refreshSessionUI() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const recognition = window.YTD_SOURCE_PLATFORMS.recognizePage(tab?.url);
    const session = await chrome.runtime.sendMessage({ action: "getSessionState" });
    if (session?.active) {
      sessionUi.sessionId = session.sessionId;
      sessionUi.lastSessionId = session.sessionId;
      sessionUi.kind = session.kind;
      sessionUi.timestampKind = session.timestampKind;
      showSessionMode({ active: true, kind: session.kind, state: session.state });
    } else {
      showSessionMode({ active: false, kind: recognition.kind, state: null });
    }
  } catch (_error) {
    // Panel opened on a non-extension page (e.g. chrome://): no session UI.
    showSessionMode({ active: false, kind: "none", state: null });
  }
}

async function endLearning() {
  const endBtn = document.getElementById("endLearningBtn");
  endBtn.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: "endLearning" });
    if (result?.state) {
      renderSessionTranscript(result.state);
      observeSessionTitle(result.state);
      renderLiveTopics(result.state);
      const status = document.getElementById("sessionStatus");
      if (status) status.textContent = "会话已结束";
      if (result.report) {
        // Keep the Session view open so the transcript stays readable and
        // the report's timestamps keep somewhere to jump into.
        adoptSessionReport(result.report, result.state.sessionId);
        return;
      }
    }
    showSessionMode({ active: false, kind: sessionUi.kind, state: null });
  } finally {
    endBtn.disabled = false;
  }
}

function setupSessionUI() {
  document.getElementById("endLearningBtn")?.addEventListener("click", endLearning);
  chrome.tabs.onActivated.addListener(() => {
    if (!sessionUi.active) void refreshSessionUI();
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === "complete" && !sessionUi.active) void refreshSessionUI();
  });
  // The panel can miss sessionUpdate broadcasts (it may still be loading
  // when the Session starts after an icon click), which used to leave a
  // freshly started Session looking idle. Poll cheaply to converge on the
  // true state; rendering is idempotent.
  setInterval(() => void refreshSessionUI(), 5000);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "sessionUpdate" && message.startError) {
      // Auto-start from the toolbar icon failed (e.g. missing API key);
      // surface the reason in the panel that click just opened.
      window.alert(message.startError);
      sendResponse({ success: true });
      return false;
    }
    if (message.action === "sessionUpdate" && message.captureNotice) {
      // The capture stream died mid-Session (course tab closed or navigated
      // away) and the worker auto-ended the Session; surface the reason the
      // same way the startError precedent does. The ended state and its
      // digest arrive in the follow-up sessionUpdate broadcast.
      window.alert(message.captureNotice);
      const status = document.getElementById("sessionStatus");
      if (status) status.textContent = message.captureNotice;
      sendResponse({ success: true });
      return false;
    }
    if (message.action === "sessionUpdate" && message.state) {
      if (sessionUi.sessionId && message.sessionId !== sessionUi.sessionId) return false;
      sessionUi.sessionId = message.sessionId;
      sessionUi.lastSessionId = message.sessionId;
      observeSessionTitle(message.state);
      renderSessionTranscript(message.state);
      renderLiveTopics(message.state);
      if (message.report) adoptSessionReport(message.report, message.sessionId);
      if (message.state.status === "ended") {
        sessionUi.active = false;
        const status = document.getElementById("sessionStatus");
        if (status) status.textContent = "会话已结束";
      }
      sendResponse({ success: true });
      return false;
    }
    return false;
  });
  void refreshSessionUI();
}
