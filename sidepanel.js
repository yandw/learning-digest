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
  const seconds = Math.max(5, Math.floor(Number(segmentLengthForCopy) || 30));
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
  // The first Session paint must wait for this value: Chrome storage can
  // resolve after refreshSessionUI(), leaving the pending row at the 30s
  // default even when the learner configured a shorter Segment.
  await refreshSegmentLengthForCopy();
  await evictOldCacheEntries(20);

  // P6 authorization gate: a valid linked credential unlocks everything;
  // anything else shows only the guide below.
  if (await runStartupGate()) {
    await startAuthorizedSession();
  }
});

/**
 * The post-gate startup: the config check the panel has always run, then
 * the welcome-state sequence.
 */
async function startAuthorizedSession() {
  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  unlockAfterAuth();
}

/**
 * The startup authorization probe (P6): asks the background to present the
 * stored credential to GET /v1/me. Returns true when authorized (the caller
 * continues into the normal startup sequence); otherwise shows the guide
 * and returns false.
 */
async function runStartupGate() {
  let authStatus = null;
  try {
    authStatus = await chrome.runtime.sendMessage({ action: "checkAuth" });
  } catch (_error) {
    authStatus = { authorized: false, reason: "unreachable" };
  }
  if (authStatus && authStatus.authorized === true) {
    return true;
  }
  showAuthGate(authStatus || { authorized: false, reason: "unconfigured" });
  return false;
}

/**
 * The post-authorization startup sequence: restore the surfaces the gate
 * hid, then run the welcome-state startup the panel has always run.
 */
function unlockAfterAuth() {
  setSettingsButtonVisible(true);
  showState("welcome");
  setupSessionUI();
  // D7 (#30): reopening the panel shows the most recent persisted report
  // even with no active Session.
  void adoptLatestStoredReport();
  // The 概览 first-topic hint names the configured tick interval.
  void refreshSummaryIntervalMinutes();
  // P8 (#58): when the active tab is a recognized video page, one read-only
  // resolve probe (inside the background) can announce "已在你的学习库"
  // before the learner clicks 收藏当前页. Pages without a confirmable
  // identity never reach the API, so panel opens stay quiet.
  void refreshCollectEntry();
  // P10 (#59): the course tab list — pick a target, 开始学习 records it.
  void refreshCourseTabs();
  // P12 (#61): surface an unsent note draft, if any — the input is
  // pre-filled so clicking 保存笔记 resends it (same clientRequestId).
  void refreshNoteDraftEntry();
}

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
  if (message.action === "authAuthorized") {
    // The link flow finished in the background: re-run the gate and, when
    // it passes, continue into the full startup sequence.
    void (async () => {
      if (await runStartupGate()) {
        await startAuthorizedSession();
      }
    })();
    sendResponse({ success: true });
  }
  if (message.action === "authState" && message.authorized === false) {
    // Authorization died (a failed exchange, or a blocked capture attempt):
    // back to the guide.
    showAuthGate(message);
    sendResponse({ success: true });
  }
  if (message.action === "learningTargetChanged") {
    // P10 (#59): the recorded target changed — locked (the Session started)
    // or released (it ended; the list becomes selectable again).
    renderLearningTargetLabel(message.target ? message.target.target : null);
    if (!message.target) {
      void refreshCourseTabs();
    } else {
      updateCourseTabsVisibility();
    }
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

  // P7 linked logout: revoke the whole credential group server-side (the
  // Web session dies with it), clear the stored credential and return to
  // the guide, whose 授权页 entry doubles as the re-login path.
  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    void (async () => {
      try {
        await chrome.runtime.sendMessage({ action: "logout" });
      } catch (_error) {
        // The worker may be gone (a restart during the click): the guide
        // below still reflects the logged-out state this panel requested.
      }
      showAuthGate({ authorized: false, reason: "unconfigured" });
    })();
  });

  // Authorization gate (P6): open the Web confirmation page, or re-run the
  // probe after the learner believes the link is done.
  document.getElementById("openAuthPageBtn")?.addEventListener("click", () => {
    showAuthGateWaiting();
    chrome.runtime.sendMessage({ action: "openAuthPage" });
  });
  document.getElementById("authRecheckBtn")?.addEventListener("click", () => {
    void (async () => {
      if (await runStartupGate()) {
        await startAuthorizedSession();
      }
    })();
  });

  // Collect current page (P8, #58): the active tab becomes a favorite.
  document
    .getElementById("collectPageBtn")
    ?.addEventListener("click", () => {
      void collectCurrentPage();
    });

  // Course tab list (P10, #59): 开始学习 opens the Session on the chosen
  // course tab; 收藏并开始 covers the resolve-missed target in one click.
  // P11 (#60): 继续学习/从头开始 position the player for a chosen target
  // with progress — only 开始学习 records.
  document
    .getElementById("startLearningForTargetBtn")
    ?.addEventListener("click", () => {
      void startLearningForTarget();
    });
  document
    .getElementById("collectTargetBtn")
    ?.addEventListener("click", () => {
      void collectAndStartTarget();
    });
  document
    .getElementById("seekResumeTargetBtn")
    ?.addEventListener("click", () => {
      void seekChosenTarget(courseTargetUi.resumePositionMs);
    });
  document
    .getElementById("seekFromStartTargetBtn")
    ?.addEventListener("click", () => {
      void seekChosenTarget(0);
    });

  // Library note entry (P12, #61): the note text goes to the background,
  // which resolves the current page and posts the note (a recognized video
  // page carries the current media position). A network failure keeps a
  // local draft; the same button then retries it.
  document
    .getElementById("saveNoteBtn")
    ?.addEventListener("click", () => {
      void saveLibraryNote();
    });
  document
    .getElementById("discardNoteDraftBtn")
    ?.addEventListener("click", () => {
      void discardNoteDraft();
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
  const authGateEl = document.getElementById("authGateState");
  if (authGateEl) {
    authGateEl.style.display = state === "authGate" ? "flex" : "none";
  }
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
  if (!configStatus.hasAiKey) missingKeys.push("AI API 密钥");

  showState("error");
  document.getElementById("errorTitle").textContent = "缺少 API 密钥";
  document.getElementById("errorMessage").textContent =
    `请在 Learning Digest 设置中填写你的 ${missingKeys.join(" 和 ")}。`;
  document.getElementById("errorBtn").textContent = "打开设置";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// AUTHORIZATION GATE VIEW (P6)
// ============================================================

const AUTH_GATE_COPY = {
  unconfigured:
    "先把 Learning Digest 插件关联到你的学习库账号：点击下方按钮，在打开的网页中登录并确认关联，完成后这里会自动解锁。",
  unauthorized:
    "授权已失效，请重新关联学习库账号：点击下方按钮，在打开的网页中重新确认，完成后这里会自动解锁。",
  unreachable:
    "暂时连不上学习服务。请检查设置中的学习服务 API 地址，或稍后点击下方按钮重试。",
  linkFailed: null, // the exchange failure message arrives with the event
};

function setSettingsButtonVisible(visible) {
  const settingsBtn = document.getElementById("settingsBtn");
  if (settingsBtn) {
    settingsBtn.style.display = visible ? "" : "none";
  }
  // P7 linked logout: the 退出登录 entry belongs to the authorized shell
  // only; the gate view's 授权页按钮 is the re-login entry that replaces it.
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.style.display = visible ? "" : "none";
  }
}

/**
 * The gate view: every functional surface (tabs, session bar, settings
 * entry) is replaced by the authorization guide. All the learner can do
 * here is open the authorization page or re-check.
 */
function showAuthGate(status) {
  setSettingsButtonVisible(false);
  showState("authGate");
  // The course tab list is an unlocked-panel surface: the gate hides it.
  courseTargetUi.available = false;
  const courseBox = document.getElementById("courseTabsBox");
  if (courseBox) courseBox.style.display = "none";

  const message =
    status && status.reason === "linkFailed" && status.message
      ? status.message
      : AUTH_GATE_COPY[status && status.reason] || AUTH_GATE_COPY.unconfigured;
  const statusEl = document.getElementById("authGateStatus");
  if (statusEl) {
    statusEl.textContent = message || "";
  }
  const waitingEl = document.getElementById("authGateWaiting");
  if (waitingEl) {
    waitingEl.style.display = "none";
  }
}

/** The waiting copy while the authorization page tab is open. */
function showAuthGateWaiting() {
  const waitingEl = document.getElementById("authGateWaiting");
  if (waitingEl) {
    waitingEl.style.display = "block";
  }
}

// ============================================================
// COLLECT CURRENT PAGE (P8, #58)
// ============================================================
//
// The welcome-state 收藏当前页 entry: the background turns the learner's
// active tab into a favorite (POST /v1/resources, contract §3.1) and can
// pre-probe whether the source is already in the library (POST
// /v1/sources/resolve, contract §3.4, read-only). This side is only copy
// and messaging; the URL/identity work and the Bearer token stay in the
// service worker, and a 401 pushes the panel back through showAuthGate.

const COLLECT_STATUS_COPY = {
  collecting: "正在收藏…",
  created: "已收藏",
  existing: "已在库中，返回同一条资料",
  inLibrary: "该来源已在你的学习库",
  failed: "收藏没有完成，请稍后重试。",
};

function setCollectStatus(text) {
  const statusEl = document.getElementById("collectStatus");
  if (!statusEl) return;
  statusEl.textContent = text || "";
  statusEl.style.display = text ? "block" : "none";
}

/** The 已在你的学习库 announcement, with the resource's title when known. */
function describeResolvedSource(resolution) {
  const title =
    resolution.resource && typeof resolution.resource.title === "string"
      ? resolution.resource.title.trim()
      : "";
  return title
    ? `${COLLECT_STATUS_COPY.inLibrary}：${title}`
    : COLLECT_STATUS_COPY.inLibrary;
}

/**
 * The pre-collect probe, once per panel unlock. The background answers a
 * local miss (no API call) for pages without a confirmable identity, and
 * any transport failure here is silent — the probe is a convenience, not
 * a surface the learner depends on.
 */
async function refreshCollectEntry() {
  setCollectStatus("");
  let resolution = null;
  try {
    resolution = await chrome.runtime.sendMessage({
      action: "resolveCurrentSource",
    });
  } catch (_error) {
    return;
  }
  if (resolution && resolution.ok && resolution.matched) {
    setCollectStatus(describeResolvedSource(resolution));
  }
}

/**
 * The 收藏当前页 click: the authoritative gate, URL/identity extraction
 * and the POST happen in the background; this maps the verdict to the
 * status line. A 401 arrives as an authState broadcast, which re-shows
 * the authorization guide on its own.
 */
async function collectCurrentPage() {
  const button = document.getElementById("collectPageBtn");
  if (button) button.disabled = true;
  setCollectStatus(COLLECT_STATUS_COPY.collecting);
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({
      action: "collectCurrentPage",
    });
  } catch (_error) {
    result = null;
  }
  if (button) button.disabled = false;
  if (result && result.ok && COLLECT_STATUS_COPY[result.outcome]) {
    setCollectStatus(COLLECT_STATUS_COPY[result.outcome]);
    return;
  }
  setCollectStatus((result && result.message) || COLLECT_STATUS_COPY.failed);
}

// ============================================================
// ============================================================
// COURSE TAB LIST + START LEARNING (P10, #59)
// ============================================================
//
// The panel lists the open http(s) tabs (video pages first — pages with a
// confirmable platform identity, which are the ones with a media player),
// the learner picks one as the target and the background resolves it
// against the library (contract §3.4: matched with the resume position, or
// unmatched → 先收藏). Only the 开始学习 click opens the Session. While a
// Session records, the list is locked: the box yields to the session view
// and the bar names the recorded target (decision 4 of #49 — focus and tab
// switches cannot change it); when the Session ends the list comes back
// selectable. Copy and messaging only — URL/identity work, the Bearer
// token and the progress writes stay in the service worker.

const COURSE_TAB_COPY = {
  matched: "已在你的学习库：",
  resume: "上次学到",
  fromStart: "从头开始",
  unmatched: "该页还未收藏：先收藏才能记录学习进度。",
  notStartable: "该平台暂不支持开始学习采集，可先收藏。",
  locked: "已有进行中的学习会话，先结束本次学习。",
  starting: "正在开始学习…",
  favoriting: "正在收藏…",
  failed: "操作没有完成，请稍后重试。",
  // P11 (#60): the 继续学习/从头开始 options position the player only —
  // the status line reminds the learner that recording starts with
  // 开始学习 (试看不落账).
  locatedResume: (position) =>
    `已定位到上次位置 ${position}，点「开始学习」开始记录。`,
  locatedFromStart: "已定位到开头，点「开始学习」开始记录。",
  seekFailed: "定位没有完成，请稍后重试。",
};

// The chosen-target UI state, reconciled from the background's answers.
const courseTargetUi = {
  available: false, // the panel is authorized and the list has loaded once
  chosenTabId: null,
  startable: false,
  matched: false,
  // P11 (#60): the chosen source's resume position (resolve §3.4), or null
  // when it has no progress — the 继续学习/从头开始 options exist only then.
  resumePositionMs: null,
  busy: false,
};

function setCourseTabStatus(text) {
  const statusEl = document.getElementById("courseTabStatus");
  if (!statusEl) return;
  statusEl.textContent = text || "";
  statusEl.style.display = text ? "block" : "none";
}

/** "4:10" from a positionMs; "0:00" at 0 (0 IS progress, round-1 review
 *  fix); empty when the value is unusable. */
function formatResumePosition(positionMs) {
  if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0) {
    return "";
  }
  const totalSeconds = Math.floor(positionMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? hours + ":" : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The "has progress" judgment (round-1 review fix): progress exists AND its
 * revision is real (≥1) — a revision-backed positionMs of 0 IS progress, so
 * 继续学习 stays available and the copy shows 上次学到 0:00. A progress
 * blob without a positive revision (or with an unusable position) is no
 * progress at all.
 */
function hasResumableProgress(progress) {
  return !!(
    progress &&
    Number.isInteger(progress.revision) &&
    progress.revision >= 1 &&
    typeof progress.positionMs === "number" &&
    Number.isFinite(progress.positionMs) &&
    progress.positionMs >= 0
  );
}

/** The list shows whenever the panel is unlocked and nothing records. */
function updateCourseTabsVisibility() {
  const box = document.getElementById("courseTabsBox");
  if (!box) return;
  box.style.display = courseTargetUi.available && !sessionUi.active ? "" : "none";
}

function setCourseTabBusy(busy) {
  courseTargetUi.busy = busy;
  updateStartButtons();
}

function updateStartButtons() {
  const startBtn = document.getElementById("startLearningForTargetBtn");
  const collectBtn = document.getElementById("collectTargetBtn");
  const resumeBtn = document.getElementById("seekResumeTargetBtn");
  const fromStartBtn = document.getElementById("seekFromStartTargetBtn");
  if (startBtn) {
    startBtn.disabled =
      courseTargetUi.busy ||
      !courseTargetUi.chosenTabId ||
      !courseTargetUi.startable;
  }
  if (collectBtn) {
    collectBtn.style.display =
      courseTargetUi.chosenTabId && !courseTargetUi.matched ? "" : "none";
    collectBtn.disabled = courseTargetUi.busy;
  }
  // P11 (#60): the 定位选项 appear only for a chosen, startable, matched
  // target that HAS progress; without progress 开始学习 alone is the flow.
  // Round-1 review fix: resumePositionMs is null exactly when there is no
  // revision-backed progress — a stored 0 still counts.
  const resumable = !!(
    courseTargetUi.chosenTabId &&
    courseTargetUi.startable &&
    courseTargetUi.matched &&
    courseTargetUi.resumePositionMs !== null
  );
  if (resumeBtn) {
    resumeBtn.style.display = resumable ? "" : "none";
    resumeBtn.disabled = courseTargetUi.busy;
  }
  if (fromStartBtn) {
    fromStartBtn.style.display = resumable ? "" : "none";
    fromStartBtn.disabled = courseTargetUi.busy;
  }
}

/**
 * Reloads the list from the background and reconciles the target state.
 * While a Session records the list is locked (the rows come back marked),
 * so the box stays hidden and the bar's 学习目标 line speaks instead.
 */
async function refreshCourseTabs() {
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({ action: "getCourseTabs" });
  } catch (_error) {
    return;
  }
  if (!result || !result.ok) return;
  courseTargetUi.available = true;
  courseTargetUi.chosenTabId = result.chosenTabId || null;
  courseTargetUi.matched = false;
  courseTargetUi.startable = false;
  courseTargetUi.resumePositionMs = null;
  renderCourseTabList(result.tabs || []);
  setCourseTabStatus("");
  updateStartButtons();
  updateCourseTabsVisibility();
}

function renderCourseTabList(rows) {
  const list = document.getElementById("courseTabList");
  if (!list) return;
  list.textContent = "";
  for (const row of rows) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "course-tab-row";
    if (row.isTarget) {
      item.classList.add("course-tab-row-target");
    } else if (row.locked) {
      // 学习进行中：其他标签页锁定（决策 4）。
      item.classList.add("course-tab-row-locked");
      item.disabled = true;
    } else {
      item.addEventListener("click", () => {
        void chooseCourseTarget(row.tabId);
      });
    }
    if (row.tabId === courseTargetUi.chosenTabId) {
      item.classList.add("course-tab-row-chosen");
    }
    const badge = document.createElement("span");
    badge.className = `course-tab-badge${row.video ? " course-tab-badge-video" : ""}`;
    badge.textContent = row.video ? "视频" : "网页";
    const title = document.createElement("span");
    title.className = "course-tab-title";
    title.textContent = row.title;
    title.title = row.title;
    item.append(badge, title);
    list.append(item);
  }
}

/** The resolve verdict → status copy: 续播位置, or the 先收藏 prompt. */
function describeCourseTargetResolution(result) {
  const source = result.resolve && result.resolve.source;
  if (result.resolve && result.resolve.matched && source) {
    const title =
      (result.resolve.resource &&
        typeof result.resolve.resource.title === "string" &&
        result.resolve.resource.title.trim()) ||
      source.url;
    const position = hasResumableProgress(source.progress)
      ? `${COURSE_TAB_COPY.resume} ${formatResumePosition(source.progress.positionMs)}`
      : COURSE_TAB_COPY.fromStart;
    return `${COURSE_TAB_COPY.matched}${title} · ${position}`;
  }
  if (!result.startable) return COURSE_TAB_COPY.notStartable;
  return COURSE_TAB_COPY.unmatched;
}

async function chooseCourseTarget(tabId) {
  setCourseTabBusy(true);
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({
      action: "chooseLearningTarget",
      tabId,
    });
  } catch (_error) {
    result = null;
  }
  setCourseTabBusy(false);
  if (!result) {
    setCourseTabStatus(COURSE_TAB_COPY.failed);
    return;
  }
  if (!result.ok) {
    setCourseTabStatus(result.reason === "locked" ? COURSE_TAB_COPY.locked : COURSE_TAB_COPY.failed);
    return;
  }
  // The list refresh re-renders the chosen row; the resolve verdict is
  // applied AFTER it (refreshCourseTabs reconciles from getCourseTabs,
  // which carries no resolve data — applying first let the refresh clobber
  // startable/matched and leave 开始学习 disabled).
  await refreshCourseTabs();
  courseTargetUi.chosenTabId = tabId;
  courseTargetUi.startable = !!result.startable;
  courseTargetUi.matched = !!(result.resolve && result.resolve.matched);
  const progress =
    result.resolve && result.resolve.source && result.resolve.source.progress;
  // Round-1 review fix: a revision-backed positionMs of 0 IS progress —
  // the 继续学习 option stays available (it seeks to 0:00, same place as
  // 从头开始, but the 上次学到 0:00 line proves the Source has history).
  courseTargetUi.resumePositionMs = hasResumableProgress(progress)
    ? progress.positionMs
    : null;
  setCourseTabStatus(describeCourseTargetResolution(result));
  updateStartButtons();
}

/**
 * P11 (#60): the 继续学习/从头开始 click. Positioning only — the
 * background forwards seekMedia to the page bridge; no progress is written
 * and no Session starts (试看不落账: recording begins with 开始学习).
 */
async function seekChosenTarget(positionMs) {
  if (!courseTargetUi.chosenTabId) return;
  setCourseTabBusy(true);
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({
      action: "seekLearningTarget",
      tabId: courseTargetUi.chosenTabId,
      positionMs,
    });
  } catch (_error) {
    result = null;
  }
  setCourseTabBusy(false);
  if (result && result.success) {
    // The seek COPY keeps the position>0 split: a seek to 0 lands the
    // player at the start whether it came from 从头开始 or a stored
    // 0-position 继续学习, so "已定位到开头" stays the honest copy there.
    setCourseTabStatus(
      positionMs > 0
        ? COURSE_TAB_COPY.locatedResume(formatResumePosition(positionMs))
        : COURSE_TAB_COPY.locatedFromStart,
    );
    return;
  }
  setCourseTabStatus((result && result.error) || COURSE_TAB_COPY.seekFailed);
}

/**
 * The 开始学习 click: resolve-before-start happens in the background; on
 * success the sessionUpdate broadcast takes over and the list yields.
 */
async function startLearningForTarget() {
  if (!courseTargetUi.chosenTabId) return;
  setCourseTabBusy(true);
  setCourseTabStatus(COURSE_TAB_COPY.starting);
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({
      action: "startLearningForTarget",
      tabId: courseTargetUi.chosenTabId,
    });
  } catch (_error) {
    result = null;
  }
  setCourseTabBusy(false);
  if (result && result.success) {
    setCourseTabStatus("");
    updateCourseTabsVisibility();
    return;
  }
  if (result && result.needsFavorite) {
    courseTargetUi.matched = false;
    setCourseTabStatus(result.error || COURSE_TAB_COPY.unmatched);
    updateStartButtons();
    return;
  }
  setCourseTabStatus((result && result.error) || COURSE_TAB_COPY.failed);
}

/** 一键收藏并开始 for the chosen, still-unfavorited target. */
async function collectAndStartTarget() {
  if (!courseTargetUi.chosenTabId) return;
  setCourseTabBusy(true);
  setCourseTabStatus(COURSE_TAB_COPY.favoriting);
  let collected = null;
  try {
    collected = await chrome.runtime.sendMessage({
      action: "collectLearningTarget",
      tabId: courseTargetUi.chosenTabId,
    });
  } catch (_error) {
    collected = null;
  }
  if (!collected || !collected.ok) {
    setCourseTabBusy(false);
    setCourseTabStatus((collected && collected.message) || COURSE_TAB_COPY.failed);
    return;
  }
  courseTargetUi.matched = true;
  setCourseTabBusy(false);
  await startLearningForTarget();
}

/** The bar's 学习目标 line: the recorded target while a Session runs. */
function renderLearningTargetLabel(target) {
  const label = document.getElementById("learningTargetLabel");
  if (!label) return;
  if (target) {
    label.textContent = `学习目标：${target.title || target.url}`;
    label.style.display = "";
  } else {
    label.style.display = "none";
  }
}


// ============================================================
// LIBRARY NOTE ENTRY (P12, #61)
// ============================================================
//
// The welcome-state note entry, shaped like the collect entry above: the
// background resolves the current page and posts the note (contract §3.6)
// with the tab's media position when it is a recognized video page. This
// side is only copy and messaging; a 401 arrives as an authState broadcast
// which re-shows the authorization guide on its own. The draft policy
// (network failure keeps the note, retry resends the SAME clientRequestId)
// lives in notes.js and the background; the panel only pre-fills the input
// from the stored draft so the retry is one click.

const NOTE_STATUS_COPY = {
  saving: "正在保存…",
  created: "笔记已保存到学习库",
  idempotent: "笔记已在学习库中（未重复保存）",
  draftKept: "网络没有通：笔记已保留为草稿，稍后点「保存笔记」重试。",
};

function setNoteStatus(text) {
  const statusEl = document.getElementById("noteStatus");
  if (!statusEl) return;
  statusEl.textContent = text || "";
  statusEl.style.display = text ? "block" : "none";
}

function setDiscardDraftButtonVisible(visible) {
  const discardBtn = document.getElementById("discardNoteDraftBtn");
  if (discardBtn) {
    discardBtn.style.display = visible ? "" : "none";
  }
}

/**
 * The unsent-draft surface on panel unlock: pre-fill the input with the
 * draft's text so a retry needs no retyping, and say so. Silent on any
 * transport failure — the entry stays usable for a fresh note.
 */
async function refreshNoteDraftEntry() {
  setNoteStatus("");
  setDiscardDraftButtonVisible(false);
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({ action: "getNoteDraft" });
  } catch (_error) {
    return;
  }
  if (result && result.ok && result.draft) {
    const input = document.getElementById("libraryNoteInput");
    if (input && !input.value.trim()) {
      input.value = result.draft.text;
    }
    setNoteStatus("有一条未发送的笔记草稿，点击「保存笔记」重试。");
    setDiscardDraftButtonVisible(true);
  }
}

/**
 * The 保存笔记 click. The background's verdict maps to the status line; a
 * kept draft (network failure, 401) leaves the draft affordances visible,
 * a clean save or a discarded draft clears them.
 */
async function saveLibraryNote() {
  const input = document.getElementById("libraryNoteInput");
  const button = document.getElementById("saveNoteBtn");
  const text = input ? input.value : "";
  if (button) button.disabled = true;
  setNoteStatus(NOTE_STATUS_COPY.saving);
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({
      action: "saveNoteToLibrary",
      text,
    });
  } catch (_error) {
    result = { ok: false, draftKept: true, message: NOTE_STATUS_COPY.draftKept };
  }
  if (button) button.disabled = false;
  if (result && result.ok) {
    if (input) input.value = "";
    setDiscardDraftButtonVisible(false);
    setNoteStatus(NOTE_STATUS_COPY[result.outcome] || NOTE_STATUS_COPY.created);
    return;
  }
  const draftKept = Boolean(result && result.draftKept);
  setDiscardDraftButtonVisible(draftKept);
  setNoteStatus(
    (result && result.message) || (draftKept ? NOTE_STATUS_COPY.draftKept : "笔记没有保存，请稍后重试。"),
  );
}

/** The explicit 放弃草稿 click: the draft is gone; the input clears too. */
async function discardNoteDraft() {
  try {
    await chrome.runtime.sendMessage({ action: "discardNoteDraft" });
  } catch (_error) {
    // The worker may be gone; clear the surface anyway — the draft dies
    // with the next successful save attempt either way.
  }
  const input = document.getElementById("libraryNoteInput");
  if (input) input.value = "";
  setDiscardDraftButtonVisible(false);
  setNoteStatus("已放弃未发送的笔记草稿。");
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

  // The Session view (the live transcript) belongs to the 逐字稿 tab only:
  // 概览/纪要/笔记 must not have it stacked underneath their own content.
  updateSessionViewVisibility();

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

// Authorization gate view helpers for the repository's Node tests (P6). The
// extension does not read this object at runtime.
globalThis.__YTD_AUTH_TESTING__ = {
  runStartupGate,
  showAuthGate,
  showAuthGateWaiting,
  unlockAfterAuth,
  setSettingsButtonVisible,
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

// Course-target resume helpers for the repository's Node tests (P11 +
// round-1 review fix). The extension does not read this object at runtime.
globalThis.__YTD_COURSE_TESTING__ = {
  formatResumePosition,
  hasResumableProgress,
  describeCourseTargetResolution,
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
  showSessionMode,
  endLearning,
  renderEndButton,
  renderStartHint,
  renderClearButton,
  clearSessionRecord,
  formatSessionClock,
  adoptSessionReport,
  // The sessionUpdate envelope's branches (#47 live box, notices), driven
  // directly by the mock-DOM tests since the real listener only registers
  // on DOMContentLoaded.
  handleSessionUpdateMessage,
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
  // The transcript path (Ticket 2.4/2.5): "captions" (the archived 字幕
  // full text) or "asr" (the D11 segment upload pipeline); drives the
  // start toast and the transcript empty-state copy.
  capturePath: null,
  // When the live Session started (context.startedAtMs from the worker):
  // the status line names the clock time so the learner can tell when
  // transcription actually began.
  startedAtMs: null,
  renderedRecords: 0,
  // Timeline-ordered row reconciliation: one DOM row per transcriptRecords
  // index (the key), kept in video-time order so a late re-watched fill
  // inserts before records that arrived earlier instead of appending.
  recordRows: new Map(),
  recordRowsSessionId: null,
  active: false,
  // True once an end-time report has been adopted: the Session view (the
  // transcript the report's timestamps jump into) stays visible after the
  // Session ends instead of being wiped by the 5s poll.
  reportShown: false,
  // Ticket 2.5 (#68): the transcript path's display state, read from the
  // sessionUpdate state — transcriptOrigin "captions" means the archived
  // captions full text, captionsProbe the honest 无字幕 record.
  transcriptOrigin: null,
  captionsProbe: null,
  transcriptStateSessionId: null,
  // End-button state machine (0.1.40): 结束学习 click or a report retry sets
  // reportGenerating until any end-time payload arrives; a failed pass keeps
  // reportError so the 开始总结 button doubles as the retry affordance.
  reportGenerating: false,
  reportError: null,
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

/**
 * Ticket 2.5 (#68): remembers the transcript path's display state the same
 * way the title is remembered — a new Session id starts clean, so a stale
 * 字幕 badge can never bleed into the next Session. Tracks its own session
 * id: observeSessionTitle updates the shared titleSessionId before this
 * runs, so comparing against it would never see the switch.
 */
function observeTranscriptState(state) {
  if (!state?.sessionId) return;
  if (state.sessionId !== sessionUi.transcriptStateSessionId) {
    sessionUi.transcriptStateSessionId = state.sessionId;
    sessionUi.transcriptOrigin = null;
    sessionUi.captionsProbe = null;
  }
  if (state.transcriptOrigin === "captions" || state.transcriptOrigin === "asr") {
    sessionUi.transcriptOrigin = state.transcriptOrigin;
  }
  if (
    state.captionsProbe &&
    typeof state.captionsProbe === "object" &&
    state.captionsProbe.available === false
  ) {
    sessionUi.captionsProbe = state.captionsProbe;
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
  // The timeline mode (#48): an anchored Session counts video positions,
  // a wallclock one counts elapsed time — the learner should know which
  // timeline the transcript stamps follow.
  const modeLabel =
    sessionUi.timestampKind === "video" ? "已对齐视频时间轴" : "直播计时（墙钟）";
  if (sessionUi.active) {
    const startedAt = formatSessionClock(sessionUi.startedAtMs);
    // Ticket 2.5 (#68): the captions path has nothing to wait for — the
    // transcript is the archived captions full text (字幕), not 转写中.
    const transcriptLabel =
      sessionUi.transcriptOrigin === "captions" ? "字幕" : "转写中";
    status.textContent = `${kindLabel} · ${modeLabel} · ${transcriptLabel} · 开始于 ${startedAt}`;
    return;
  }
  status.textContent = kindLabel ? `${kindLabel} · 未开始转写` : kindLabel;
}

/**
 * "14:03" for a wall-clock ms timestamp; "—" when unknown (a Session state
 * broadcast predating the startedAtMs field, or a test double without one).
 */
function formatSessionClock(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const date = new Date(value);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The idle-state entry point. A panel-side button cannot start the capture
 * (Chrome's tabCapture invocation rule), so instead of a dead button the bar
 * shows this pointer at the toolbar icon whenever a recognized learning page
 * has no Session yet. Hidden while a Session runs and while an ended Session's
 * report is generating/retrying (the 开始总结 button owns the bar then).
 */
function renderStartHint() {
  const hint = document.getElementById("startLearningHint");
  if (!hint) return;
  const show =
    !sessionUi.active &&
    !sessionUi.reportGenerating &&
    !sessionUi.reportError &&
    Boolean(sessionUi.kind) &&
    sessionUi.kind !== "none";
  hint.style.display = show ? "" : "none";
}

function buildSessionRecordRow(record) {
  const row = document.createElement("div");
  // The Overview's timestamp jumps target rows by start second (#31).
  row.dataset.seconds = String(recordStartSeconds(record.start));
  const stamp = document.createElement("span");
  stamp.className = "session-record-stamp";
  const text = document.createElement("span");
  text.className = "session-record-text";
  row.append(stamp, text);
  updateSessionRecordRow(row, record);
  return row;
}

function updateSessionRecordRow(row, record) {
  row.className = record.failed
    ? "session-record session-record-failed"
    : "session-record";
  row.dataset.seconds = String(recordStartSeconds(record.start));
  const stamp = row.children[0];
  const text = row.children[1];
  if (stamp) stamp.textContent = `[${sessionTimestampLabel(record.start)}]`;
  if (text) text.textContent = record.text;
}

function renderSessionTranscript(state) {
  const container = document.getElementById("sessionTranscript");
  if (!container || !state) return;
  const records = state.transcriptRecords || [];

  // A new Session starts from a clean row map; stale rows from the previous
  // Session (whose container may still be on screen behind the report) go.
  if (sessionUi.recordRowsSessionId !== state.sessionId) {
    for (const row of sessionUi.recordRows.values()) row.remove();
    sessionUi.recordRows.clear();
    sessionUi.recordRowsSessionId = state.sessionId;
  }

  // Reconcile against the video-timeline order: create/update one row per
  // record, then place the rows in that order, so a fill recorded after a
  // later segment still lands at its own timestamp.
  const entries = YTD_SESSION_TIMELINE.orderedTranscriptEntries(state);
  const liveKeys = new Set();
  const rows = [];
  for (const { record, index } of entries) {
    liveKeys.add(index);
    let row = sessionUi.recordRows.get(index);
    if (!row) {
      row = buildSessionRecordRow(record);
      sessionUi.recordRows.set(index, row);
      container.appendChild(row);
    } else {
      updateSessionRecordRow(row, record);
    }
    rows.push(row);
  }
  for (const [index, row] of sessionUi.recordRows) {
    if (!liveKeys.has(index)) {
      row.remove();
      sessionUi.recordRows.delete(index);
    }
  }
  // Reorder pass, back to front: each row goes right before the node that
  // should follow it. Non-record children (pending spinner rows) are
  // untouched — renderPendingSegments re-appends them after this.
  const rowSet = new Set(rows);
  let before = null;
  for (const child of Array.from(container.children)) {
    if (!rowSet.has(child)) {
      before = child;
      break;
    }
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    container.insertBefore(rows[i], before);
    before = rows[i];
  }

  sessionUi.renderedRecords = records.length;
  renderPendingSegments(container, state);
  renderCaptionsStateNotice(container, state);
  container.scrollTop = container.scrollHeight;
}

/**
 * Ticket 2.5 (#68): the transcript area's three states, distinguished under
 * the rows. With archived captions the rows ARE the 字幕 full text; with a
 * recorded 无字幕 probe and nothing else to show, the honest empty state
 * names it and keeps the 可转写 hint (the forced-transcription entry's
 * semantics — the switch itself is ticket 2.7's).
 */
function renderCaptionsStateNotice(container, state) {
  container.querySelectorAll(".session-captions-empty").forEach((row) => row.remove());
  const records = state.transcriptRecords || [];
  if (records.length > 0) return;
  const appendNotice = (text) => {
    const row = document.createElement("div");
    row.className = "session-record session-captions-empty";
    const label = document.createElement("span");
    label.className = "session-record-text";
    label.textContent = text;
    row.append(label);
    container.appendChild(row);
  };
  if (state.transcriptOrigin === "captions") {
    // Archived on the server but no usable rows on screen yet: the archive
    // round trip is in flight — activity, never an invented empty state.
    appendNotice("正在归档字幕全文…");
    return;
  }
  if (
    state.captionsProbe &&
    state.captionsProbe.available === false &&
    !(state.segments || []).some((segment) => segment.status === "pending")
  ) {
    appendNotice("本页未读取到可用字幕，本次学习不产生字幕逐字稿。可转写：可改用语音转写取得整个学习区间的逐字稿。");
  }
}

/**
 * The captions path's display state keeps the caption full text; the
 * realtime draft box (#47) retired with the local transcription path
 * (ticket 2.4, D10) — there is no live partial anymore, only the poll.
 */

// Pending Segments (and the wait before the very first one) render as
// spinner rows — the same loading affordance the original digest
// transcript had: the learner sees activity at 0:00 instead of an empty
// pane while the first Segment is still being recorded and uploaded.
//
// The ASR path has two pending sources: the LOCAL segments (recording and
// uploading, until the D11 POST answers) and the SERVER view's
// pendingSegments (transcribing, from the §3.5 poll). They never overlap
// for long — the local spinner hands over to the server's at upload
// acceptance — and a same-start dedupe keeps a retry's brief overlap from
// double-spinning one range.
function renderPendingSegments(container, state) {
  container.querySelectorAll(".session-pending").forEach((row) => row.remove());
  // The captions path (Ticket 2.5) records no audio: the capture bootstrap
  // copy ("第一段逐字稿约 X 后出现…") would be a lie there.
  if (sessionUi.transcriptOrigin === "captions") return;
  const segments = state.segments || [];
  // The 无字幕 notice (Ticket 2.5) owns the empty state when the probe
  // found nothing: promising a first transcript row next to it would
  // contradict the honest observation. Pending ASR segments still spin.
  const bootstrap =
    segments.length === 0 &&
    (state.transcriptRecords || []).length === 0 &&
    !sessionUi.captionsProbe;
  if (bootstrap) {
    appendPendingRow(
      container,
      0,
      `录制中，第一段逐字稿约 ${segmentLengthLabel()} 后出现…`,
    );
  }
  const localPendingStarts = new Set(
    segments
      .filter((segment) => segment.status === "pending")
      .map((segment) => recordStartSeconds(segment.start)),
  );
  for (const segment of segments) {
    if (segment.status === "pending") {
      appendPendingRow(container, segment.start, "转写中…");
    }
  }
  for (const segment of state.pendingSegments || []) {
    if (localPendingStarts.has(recordStartSeconds(segment.start))) continue;
    appendPendingRow(container, segment.start, "转写中…");
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
  // Any end-time payload (content, error, skipped) settles the generating
  // state, keeps the Session view alive for the button's state machine, and
  // funnels into the tabs — applyReportPayloadToTab renders error/skipped.
  sessionUi.reportGenerating = false;
  sessionUi.reportError = report?.error || null;
  sessionUi.reportShown = true;
  renderEndButton();
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
  sessionUi.reportGenerating = false;
  sessionUi.reportError = report?.error || null;
  renderEndButton();
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
    // D7 adopts the deliverable with no active Session. 0.1.59: the panel
    // opens on the 逐字稿 tab from here on — the report content is adopted
    // (one click away on 纪要) but the startup scan no longer yanks the tab.
    showState("results");
  }
  // Render even when nothing was found: this is the tab's first paint, and
  // the idle line must be visible before any session activity.
  renderReportTab();
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
  // The captions path (Ticket 2.5) records no audio at all — its copy must
  // not say 录制; the ASR path (Ticket 2.4) is the segment-recording one.
  toast.textContent =
    sessionUi.capturePath === "captions"
      ? "已开始学习 · 字幕全文归档中"
      : `已开始录制 · 逐字稿将在约 ${segmentLengthLabel()}后出现`;
  toast.classList.add("recording-toast-visible");
  clearTimeout(showRecordingToast.timer);
  showRecordingToast.timer = setTimeout(
    () => toast.classList.remove("recording-toast-visible"),
    4000,
  );
}

function showSessionMode({ active, kind, state, capturePath, timestampKind, startedAtMs }) {
  const bar = document.getElementById("sessionBar");
  const view = document.getElementById("sessionView");
  const welcome = document.getElementById("welcomeState");
  if (!bar) return;

  if (active) {
    sessionUi.active = true;
    if (capturePath) sessionUi.capturePath = capturePath;
    // The timeline mode (#48): wallclock at start, "video" once the probe
    // anchored the Session — the status line names which one is live.
    if (timestampKind) sessionUi.timestampKind = timestampKind;
    if (kind) sessionUi.kind = kind;
    if (Number.isFinite(Number(startedAtMs)) && Number(startedAtMs) > 0) {
      sessionUi.startedAtMs = Number(startedAtMs);
    }
    const activeSessionId = state?.sessionId ?? sessionUi.sessionId ?? null;
    if (activeSessionId) {
      sessionUi.sessionId = activeSessionId;
      sessionUi.lastSessionId = activeSessionId;
    }
    observeSessionTitle(state);
    observeTranscriptState(state);
    // A new Session retires any previous Session's report state.
    sessionUi.reportShown = false;
    // ...and the 纪要 tab shows the generating hint until the new report
    // lands (#30); only an id change retires it, so the poll is safe.
    const reportSessionBefore = reportTabUi.sessionId;
    reportTabSetActiveSession(activeSessionId);
    // The 0.1.57 default keeps the learner on their current tab when a
    // Session starts: watching the transcript grow is the primary in-Session
    // job, so surfacing the 纪要 tab up front (story 7) yanked the learner
    // away from it. The tab BAR still becomes visible here — without it the
    // 笔记/概览/纪要 tabs would be unreachable mid-Session (tabsNav starts
    // hidden and only showState reveals it). The first-topic hint stays
    // truthful about the configured tick interval from Session start on.
    if (reportTabUi.sessionId && reportTabUi.sessionId !== reportSessionBefore) {
      showState("results");
      void refreshSummaryIntervalMinutes();
    }
    bar.style.display = "flex";
    renderEndButton();
    renderStartHint();
    updateSessionViewVisibility();
    if (welcome) welcome.style.display = "none";
    if (state?.sessionId && !toastedSessions.has(state.sessionId)) {
      toastedSessions.add(state.sessionId);
      showRecordingToast();
    }
    renderSessionStatus();
    renderLiveTopics(state);
    renderSessionTranscript(state);
    // P10: a recording Session locks the course tab list — the box yields
    // to the session view and the bar's 学习目标 line speaks instead.
    updateCourseTabsVisibility();
    return;
  }

  sessionUi.active = false;
  sessionUi.sessionId = null;
  sessionUi.renderedRecords = 0;
  // The transcript path's display state retires with the Session (the ended
  // broadcast re-derives it from its own state when it re-renders).
  sessionUi.transcriptOrigin = null;
  sessionUi.captionsProbe = null;
  sessionUi.transcriptStateSessionId = null;
  // The ended (or idle) Session takes its rows with it; a new Session
  // reconciles from an empty row map.
  for (const row of sessionUi.recordRows.values()) row.remove();
  sessionUi.recordRows.clear();
  sessionUi.recordRowsSessionId = null;
  // Set kind before the renders below: the start hint's visibility and the
  // status line both read it.
  sessionUi.kind = kind && kind !== "none" ? kind : null;
  renderEndButton();
  if (!sessionUi.reportShown) {
    clearLiveOverview();
    const transcript = document.getElementById("sessionTranscript");
    if (transcript) transcript.textContent = "";
  }
  updateSessionViewVisibility();

  if (kind && kind !== "none") {
    // The toolbar icon is the only start entry point: a click inside the
    // panel can never satisfy Chrome's tabCapture invocation rule, so the
    // panel deliberately offers no start control at all.
    bar.style.display = "flex";
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
    // P10: the Session ended (or the panel idled) — the course tab list is
    // selectable again (决策 4: 结束本次学习后列表恢复可选).
    updateCourseTabsVisibility();
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
      showSessionMode({
        active: true,
        kind: session.kind,
        state: session.state,
        capturePath: session.capturePath,
        timestampKind: session.timestampKind,
        startedAtMs: session.startedAtMs,
      });
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
  if (!sessionUi.active) {
    // The 开始总结 button doubles as the retry affordance after a failed
    // summary pass: clicking it regenerates the last ended Session's report.
    if (sessionUi.reportError && sessionUi.lastSessionId) {
      sessionUi.reportGenerating = true;
      renderEndButton();
      try {
        const result = await chrome.runtime.sendMessage({
          action: "regenerateReport",
          sessionId: sessionUi.lastSessionId,
        });
        if (result?.report) {
          adoptSessionReport(result.report, sessionUi.lastSessionId);
        } else {
          sessionUi.reportGenerating = false;
          renderEndButton();
        }
      } catch (error) {
        sessionUi.reportGenerating = false;
        sessionUi.reportError = error?.message || String(error);
        renderEndButton();
      }
    }
    return;
  }
  sessionUi.reportGenerating = true;
  endBtn.disabled = true;
  renderEndButton();
  try {
    const result = await chrome.runtime.sendMessage({ action: "endLearning" });
    if (result?.state) {
      // The end response's status settles the Session locally; the follow-up
      // broadcast/poll only brings the report from here on.
      if (result.state.status === "ended") sessionUi.active = false;
      renderSessionTranscript(result.state);
      observeSessionTitle(result.state);
      renderLiveTopics(result.state);
      const status = document.getElementById("sessionStatus");
      if (status) {
        status.textContent = sessionUi.reportGenerating
          ? "会话已结束 · 正在生成学习纪要…"
          : "会话已结束";
      }
      if (result.report) {
        // Keep the Session view open so the transcript stays readable and
        // the report's timestamps keep somewhere to jump into.
        adoptSessionReport(result.report, result.state.sessionId);
        return;
      }
      // No report in the end response: a follow-up broadcast carries it;
      // until then the button shows the disabled 开始总结 state.
      renderEndButton();
      return;
    }
    showSessionMode({ active: false, kind: sessionUi.kind, state: null });
    renderEndButton();
  } catch (error) {
    // The end action itself failed: the Session is still active, so restore
    // the button to 结束学习 instead of leaving a disabled 开始总结 behind.
    sessionUi.reportGenerating = false;
    console.error("[Learning Digest] endLearning failed:", error?.message || error);
    renderEndButton();
  }
}

/**
 * The 结束学习/开始总结 button is a small state machine over the Session
 * lifecycle: active → 结束学习 (enabled); ended with the report generating →
 * 开始总结 (disabled); ended with a failed pass → 开始总结 (enabled, acts as
 * retry); otherwise (report ready/skipped, or nothing to show) hidden.
 */
/**
 * The 清除记录 button. Visible only for an ENDED Session that is still on
 * screen: it deletes the persisted snapshot and report artifact (via the
 * worker) and wipes the panel rows. Hidden while a Session runs — ending is
 * the 结束学习 button's job — and while its report is still generating.
 */
function renderClearButton() {
  const clearBtn = document.getElementById("clearSessionBtn");
  if (!clearBtn) return;
  const show =
    !sessionUi.active &&
    !sessionUi.reportGenerating &&
    Boolean(sessionUi.lastSessionId || reportTabUi.sessionId);
  clearBtn.style.display = show ? "" : "none";
}

/**
 * Confirms, then asks the worker to delete the ended Session's snapshot and
 * report artifact, and locally retires its rows, ids and adopted report so
 * the panel converges on empty without waiting for the next poll.
 */
async function clearSessionRecord() {
  if (sessionUi.active) return;
  const sessionId = sessionUi.lastSessionId || reportTabUi.sessionId;
  if (!sessionId) return;
  const ok =
    typeof window.confirm === "function"
      ? window.confirm(
          "清除当前课程的转录记录和学习纪要？此操作不可恢复。",
        )
      : true;
  if (!ok) return;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "clearSessionRecord",
      sessionId,
    });
    if (!result?.success) return;
  } catch (_error) {
    return;
  }
  for (const row of sessionUi.recordRows.values()) row.remove();
  sessionUi.recordRows.clear();
  sessionUi.recordRowsSessionId = null;
  sessionUi.renderedRecords = 0;
  sessionUi.sessionId = null;
  sessionUi.lastSessionId = null;
  sessionUi.reportShown = false;
  sessionUi.reportGenerating = false;
  sessionUi.reportError = null;
  const transcript = document.getElementById("sessionTranscript");
  if (transcript) transcript.textContent = "";
  // Retire the adopted report (resets the 纪要/概览 tabs too).
  reportTabSetActiveSession(null);
  renderEndButton();
  updateSessionViewVisibility();
  void refreshSessionUI();
}

/**
 * The 从头开始 button (0.1.63): visible only while a replay/course Session
 * runs — live streams have no timeline to rewind. It rewinds the lesson to
 * 0:00 so autoplay-started courses transcribe from the true beginning.
 */
function renderRestartFromStartButton() {
  const btn = document.getElementById("restartFromStartBtn");
  if (!btn) return;
  const show = sessionUi.active && sessionUi.kind !== "live";
  btn.style.display = show ? "" : "none";
  if (!show) btn.disabled = false;
}

function renderEndButton() {
  const endBtn = document.getElementById("endLearningBtn");
  // The hint/clear buttons and the end button share the same state machine
  // (active / reportGenerating / lastSessionId), so every end-button render
  // refreshes them too — no call site can leave them out of step.
  renderStartHint();
  renderClearButton();
  renderRestartFromStartButton();
  if (!endBtn) return;
  if (sessionUi.active) {
    endBtn.style.display = "";
    endBtn.disabled = false;
    endBtn.textContent = "结束学习";
    return;
  }
  if (sessionUi.reportGenerating) {
    endBtn.style.display = "";
    endBtn.disabled = true;
    endBtn.textContent = "开始总结";
    return;
  }
  if (sessionUi.reportError) {
    endBtn.style.display = "";
    endBtn.disabled = false;
    endBtn.textContent = "开始总结";
    return;
  }
  endBtn.style.display = "none";
  endBtn.disabled = false;
  endBtn.textContent = "结束学习";
}

/**
 * The Session view (the live transcript) belongs to the 逐字稿 tab alone:
 * it shows there whenever a Session view has content to show, and every
 * other tab renders only its own panel. Kept in sync from switchTab and
 * showSessionMode so the 5s poll can never fight the active tab.
 */
function updateSessionViewVisibility() {
  const view = document.getElementById("sessionView");
  if (!view) return;
  const hasSessionContent =
    sessionUi.active ||
    sessionUi.reportShown ||
    Boolean(sessionUi.sessionId || sessionUi.lastSessionId) ||
    view.childElementCount > 0;
  view.style.display = transcriptTabIsActive() && hasSessionContent ? "" : "none";
}

async function restartFromBeginning() {
  const btn = document.getElementById("restartFromStartBtn");
  if (!btn || !sessionUi.active || btn.disabled) return;
  btn.disabled = true;
  const settle = (text) => {
    btn.textContent = text;
    setTimeout(() => {
      btn.textContent = "从头开始";
      btn.disabled = false;
    }, 2500);
  };
  try {
    const result = await chrome.runtime.sendMessage({
      action: "restartFromBeginning",
    });
    settle(result?.success ? "已回到 0:00" : result?.error || "控制失败，请刷新课程页");
  } catch (_error) {
    settle("控制失败，请刷新课程页");
  }
}

function setupSessionUI() {
  document.getElementById("endLearningBtn")?.addEventListener("click", endLearning);
  document
    .getElementById("restartFromStartBtn")
    ?.addEventListener("click", restartFromBeginning);
  document
    .getElementById("clearSessionBtn")
    ?.addEventListener("click", clearSessionRecord);
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
    if (message.action === "sessionUpdate") {
      return handleSessionUpdateMessage(message, sendResponse);
    }
    return false;
  });
  void refreshSessionUI();
}

/**
 * The sessionUpdate envelope's branches, extracted from the message
 * listener so the repository's tests can drive them directly (the listener
 * itself only registers on DOMContentLoaded). Every branch answers with
 * {success: true} and returns false (no async response held open).
 *
 * @param {object} message - a sessionUpdate broadcast from the worker
 * @param {(response: object) => void} sendResponse
 * @returns {boolean}
 */
function handleSessionUpdateMessage(message, sendResponse) {
  if (message.startError) {
    // Auto-start from the toolbar icon failed (e.g. missing API key);
    // surface the reason in the panel that click just opened.
    window.alert(message.startError);
    sendResponse({ success: true });
    return false;
  }
  if (message.captureNotice) {
    // One surface for every mid-Session trouble notice: a dead capture
    // stream (course tab closed or navigated away), or the archive
    // pipeline's terminal verdicts (the D15 origin conflict's server
    // message rides this field verbatim). Alerts plus the status line —
    // the same surface the startError precedent uses — and any auto-end
    // arrives in the follow-up sessionUpdate broadcast with the ended
    // state and its digest.
    const notice = message.captureNotice;
    window.alert(notice);
    const status = document.getElementById("sessionStatus");
    if (status) status.textContent = notice;
    sendResponse({ success: true });
    return false;
  }
  if (message.state) {
    if (sessionUi.sessionId && message.sessionId !== sessionUi.sessionId) return false;
    sessionUi.sessionId = message.sessionId;
    sessionUi.lastSessionId = message.sessionId;
    if (message.capturePath) sessionUi.capturePath = message.capturePath;
    if (message.timestampKind) {
      // The probe anchored the Session to the video timeline (#48); the
      // status line flips immediately instead of waiting for the poll.
      sessionUi.timestampKind = message.timestampKind;
      renderSessionStatus();
    }
    observeSessionTitle(message.state);
    observeTranscriptState(message.state);
    renderSessionStatus();
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
}
