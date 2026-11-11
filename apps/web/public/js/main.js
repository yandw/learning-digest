/**
 * Page binding only: wires the login flow state machine, the library flow
 * (P5: collect / list / detail / retitle), the api client and the
 * credential store to the DOM. All decisions live in the pure modules
 * (login-flow.js / library.js / api-client.js / credentials.js); this file
 * only builds elements from their snapshots and view models.
 */
import { createLoginFlow } from "./login-flow.js";
import {
  createLibraryFlow,
  presentListItem,
  presentDetail,
  presentNote,
  presentSession,
  presentTranscript,
  buildNoteJumpUrl,
  presentSummary,
  presentSummariesList,
  presentUsage,
} from "./library.js";
import { createApiClient } from "./api-client.js";
import { createCredentialStore } from "./credentials.js";
import { createSessionRevalidator } from "./session-revalidate.js";

function byId(id) {
  return document.getElementById(id);
}

const credentials = createCredentialStore({ storage: window.localStorage });

// The api client and the flows reference each other (401 -> login flow
// reset), so the expiry handler is bound after both exist.
let sessionExpiredHandler = () => {};
const api = createApiClient({
  fetchImpl: (path, init) => fetch(path, init),
  credentials,
  onUnauthorized: () => sessionExpiredHandler(),
});
const flow = createLoginFlow({ api, credentials });

// Shared contracts module (UMD global). If it failed to load, degrade to
// no client-side identity: the server extracts the identity from the URL
// itself, so collection still works.
const identityExtractor =
  window.YTD_PLATFORM_VIDEO_ID || { extractVideoIdentity: () => null };
const library = createLibraryFlow({ api, identity: identityExtractor });
sessionExpiredHandler = () => flow.handleSessionExpired();

const elements = {
  loginView: byId("loginView"),
  libraryView: byId("libraryView"),
  emailForm: byId("emailForm"),
  codeForm: byId("codeForm"),
  emailInput: byId("emailInput"),
  codeInput: byId("codeInput"),
  codeSentNotice: byId("codeSentNotice"),
  loginError: byId("loginError"),
  requestCodeBtn: byId("requestCodeBtn"),
  verifyBtn: byId("verifyBtn"),
  changeEmailBtn: byId("changeEmailBtn"),
  logoutBtn: byId("logoutBtn"),
  accountEmail: byId("accountEmail"),
  // library: list view
  listSection: byId("listSection"),
  collectForm: byId("collectForm"),
  collectUrl: byId("collectUrl"),
  collectTitle: byId("collectTitle"),
  collectBtn: byId("collectBtn"),
  libraryNotice: byId("libraryNotice"),
  libraryError: byId("libraryError"),
  resourceList: byId("resourceList"),
  listEmpty: byId("listEmpty"),
  // library: detail view
  detailSection: byId("detailSection"),
  backToListBtn: byId("backToListBtn"),
  detailTitleHeading: byId("detailTitleHeading"),
  editTitleBtn: byId("editTitleBtn"),
  titleForm: byId("titleForm"),
  titleInput: byId("titleInput"),
  saveTitleBtn: byId("saveTitleBtn"),
  cancelTitleBtn: byId("cancelTitleBtn"),
  detailSources: byId("detailSources"),
  detailNotesList: byId("detailNotesList"),
  notesEmpty: byId("notesEmpty"),
  // library: detail view, transcript read-back (round 2)
  detailTranscriptsList: byId("detailTranscriptsList"),
  transcriptsEmpty: byId("transcriptsEmpty"),
  // library: detail view, course summary + history (round 3)
  generateSummaryBtn: byId("generateSummaryBtn"),
  summariesError: byId("summariesError"),
  summariesHistory: byId("summariesHistory"),
  summaryContent: byId("summaryContent"),
  summariesEmpty: byId("summariesEmpty"),
  // usage entry (round 3): the account-area toggle + summary panel
  usageBtn: byId("usageBtn"),
  usagePanel: byId("usagePanel"),
  usageText: byId("usageText"),
};

function setMessage(element, text) {
  element.textContent = text || "";
  element.hidden = !text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** One learning-list row: open-in-new-tab link + badges + progress. */
function renderListItem(presented) {
  const item = el("li", "resource-item");

  const link = el("a", "resource-link", presented.title);
  link.href = presented.href || "#";
  link.target = "_blank";
  link.rel = "noopener";
  item.appendChild(link);

  const meta = el("div", "resource-meta");
  meta.appendChild(el("span", "badge badge-kind", presented.kindLabel));
  if (presented.platformLabel) {
    meta.appendChild(el("span", "badge badge-platform", presented.platformLabel));
  }
  if (presented.progressText) {
    meta.appendChild(el("span", "badge badge-progress", presented.progressText));
  }
  const detailBtn = el("button", "link-btn detail-btn", "详情");
  detailBtn.type = "button";
  detailBtn.dataset.id = presented.id;
  detailBtn.addEventListener("click", () => {
    act(() => library.openDetail(presented.id));
  });
  meta.appendChild(detailBtn);
  item.appendChild(meta);

  return item;
}

/** One detail source row: the original address with badges and progress. */
function renderDetailSource(presented) {
  const item = el("li", "source-item");

  const link = el("a", "source-link", presented.url);
  link.href = presented.url;
  link.target = "_blank";
  link.rel = "noopener";
  item.appendChild(link);

  const meta = el("div", "resource-meta");
  meta.appendChild(el("span", "badge badge-kind", presented.kindLabel));
  if (presented.platformLabel) {
    meta.appendChild(el("span", "badge badge-platform", presented.platformLabel));
  }
  if (presented.progressText) {
    meta.appendChild(el("span", "badge badge-progress", presented.progressText));
  }
  item.appendChild(meta);

  return item;
}

/**
 * One read-back note row (P12): the text plus the mm:ss stamp for a
 * timestamped note. The stamp is a button only when the platform offers a
 * seek parameter (bilibili/youtube); otherwise it stays plain text —
 * the jump decision lives in the pure module, this only renders it.
 */
function renderDetailNote(note, sources) {
  const presented = presentNote(note);
  const item = el("li", "note-item");

  item.appendChild(el("p", "note-text", presented.text));

  const meta = el("div", "note-meta");
  if (presented.stamp) {
    const jumpUrl = buildNoteJumpUrl(note, sources);
    if (jumpUrl) {
      const stamp = el("button", "link-btn note-stamp", presented.stamp);
      stamp.type = "button";
      stamp.title = "回到原视频的这个位置";
      stamp.addEventListener("click", () => {
        window.open(jumpUrl, "_blank", "noopener");
      });
      meta.appendChild(stamp);
    } else {
      meta.appendChild(el("span", "badge badge-progress", presented.stamp));
    }
  }
  item.appendChild(meta);

  return item;
}

/**
 * One transcript timeline row (the merged records/gaps/pending/failed
 * stream from presentTranscript): the mm:ss stamp plus the row text, and
 * for failed rows the contract error message below. Like the note stamps,
 * the stamp is a jump button only when the platform offers a seek
 * parameter; otherwise it stays plain text — the jump decision lives in
 * the pure module, this only renders it.
 */
function renderTranscriptEntry(entry) {
  const item = el("li", `transcript-entry transcript-${entry.kind}`);
  const line = el("p", "transcript-line");

  if (entry.jumpUrl) {
    const stamp = el("button", "link-btn note-stamp", entry.stamp);
    stamp.type = "button";
    stamp.title = "回到原视频的这个位置";
    stamp.addEventListener("click", () => {
      window.open(entry.jumpUrl, "_blank", "noopener");
    });
    line.appendChild(stamp);
  } else if (entry.stamp) {
    line.appendChild(el("span", "transcript-stamp", entry.stamp));
  }
  line.appendChild(el("span", "transcript-text", entry.text));
  item.appendChild(line);

  if (entry.detail) {
    item.appendChild(el("p", "transcript-detail", entry.detail));
  }
  return item;
}

/**
 * One session block (contract-r2 §3.6 sessions[]): the header from the
 * detail (study time, status, origin badge, summary counts) plus the
 * timeline of the per-session second pull stored in detail.transcripts —
 * null marks a failed pull (header stays, body shows a load-failure line),
 * an empty view reads as a session that produced no transcript.
 */
function renderSessionBlock(session, transcripts, sources) {
  const presented = presentSession(session);
  const item = el("li", "session-item");

  const header = el("div", "session-header");
  header.appendChild(el("span", "session-time", presented.startedAtText || ""));
  header.appendChild(el("span", "badge badge-status", presented.statusLabel));
  if (presented.originLabel) {
    header.appendChild(el("span", "badge badge-origin", presented.originLabel));
  }
  item.appendChild(header);
  item.appendChild(el("p", "session-summary", presented.summaryText));

  const view = transcripts[session.id];
  if (view === null) {
    item.appendChild(el("p", "session-hint", "逐字稿加载失败，请稍后重试"));
    return item;
  }
  const entries = presentTranscript(view, sources);
  if (entries.length === 0) {
    item.appendChild(el("p", "session-hint", "本次学习未产生逐字稿"));
    return item;
  }
  const list = el("ul", "transcript-entries");
  list.replaceChildren(...entries.map((entry) => renderTranscriptEntry(entry)));
  item.appendChild(list);
  return item;
}

/**
 * Inline runs (the safe markdown view models) -> text nodes, <strong> for
 * bold runs. No HTML string is ever built: whatever the content (AI body,
 * user-controlled citation quotes) lands in a text node.
 */
function appendRuns(node, runs) {
  for (const run of runs) {
    node.appendChild(run.bold ? el("strong", null, run.text) : document.createTextNode(run.text));
  }
}

/**
 * One markdown block view model -> an element. Heading kinds nest inside
 * the detail's outline (h1 -> h3, h2 -> h4, h3 -> h5); list items render
 * as plain li text; paragraph soft-wraps keep their line breaks via
 * white-space: pre-wrap.
 */
function renderSummaryBlock(block) {
  if (block.kind === "ul") {
    const list = el("ul", "summary-list");
    for (const runs of block.items) {
      const item = el("li");
      appendRuns(item, runs);
      list.appendChild(item);
    }
    return list;
  }
  const headings = { h1: "h3", h2: "h4", h3: "h5" };
  const node = el(headings[block.kind] || "p");
  appendRuns(node, block.runs);
  return node;
}

/**
 * One citation (contract-r3 §2.2): the verbatim quote as text, the range
 * stamp on the source timeline, the session attribution, and the
 * best-effort jump — the jump decision lives in the pure module (null on
 * platforms without seek support), this only renders it, like the note
 * and transcript stamps.
 */
function renderCitation(citation) {
  const item = el("li", "citation-item");
  item.appendChild(el("p", "citation-quote", `「${citation.quote}」`));

  const meta = el("div", "citation-meta");
  if (citation.jumpUrl) {
    const stamp = el("button", "link-btn note-stamp", citation.stamp || "");
    stamp.type = "button";
    stamp.title = "回到原视频的这个位置";
    stamp.addEventListener("click", () => {
      window.open(citation.jumpUrl, "_blank", "noopener");
    });
    meta.appendChild(stamp);
  } else if (citation.stamp) {
    meta.appendChild(el("span", "transcript-stamp", citation.stamp));
  }
  if (citation.sessionStartedAtText) {
    meta.appendChild(el("span", "citation-session", `来自 ${citation.sessionStartedAtText} 的学习`));
  }
  if (citation.sessionOriginLabel) {
    meta.appendChild(el("span", "badge badge-origin", citation.sessionOriginLabel));
  }
  item.appendChild(meta);
  return item;
}

/**
 * The history pills (contract-r3 §3.2, newest first): ordinal + time +
 * citationCount per generation; clicking one switches the displayed
 * generation (showSummary pulls and caches its full form).
 */
function renderSummaryHistory(state) {
  const items = presentSummariesList(state.summaries);
  elements.summariesHistory.hidden = items.length === 0;
  elements.summariesHistory.replaceChildren(
    ...items.map((item) => {
      const li = el("li");
      const btn = el(
        "button",
        "summary-history-btn",
        `第 ${item.ordinal} 次 · ${item.generatedAtText} · ${item.citationCount} 条引用`,
      );
      btn.type = "button";
      btn.setAttribute("aria-pressed", item.id === state.activeSummaryId ? "true" : "false");
      if (item.id === state.activeSummaryId) {
        btn.classList.add("active");
      }
      btn.addEventListener("click", () => {
        act(() => library.showSummary(item.id));
      });
      li.appendChild(btn);
      return li;
    }),
  );
}

/**
 * The displayed generation: meta line, the safe-rendered body blocks and
 * the citation list. null marks a failed detail pull (load-failure hint);
 * an empty history shows only the empty hint.
 */
function renderSummaryContent(state) {
  const hasHistory = state.summaries.length > 0;
  elements.summariesEmpty.hidden = hasHistory || state.generating;

  const summary = state.activeSummaryId ? state.summaryDetails[state.activeSummaryId] : null;
  if (!state.activeSummaryId || summary === undefined) {
    elements.summaryContent.hidden = true;
    elements.summaryContent.replaceChildren();
    return;
  }
  elements.summaryContent.hidden = false;
  if (summary === null) {
    elements.summaryContent.replaceChildren(el("p", "session-hint", "总结加载失败，请稍后重试"));
    return;
  }

  const presented = presentSummary(
    summary,
    state.detail ? state.detail.sessions || [] : [],
    state.detail ? state.detail.sources || [] : [],
  );
  const parts = [el("p", "summary-meta", `生成于 ${presented.generatedAtText} · ${presented.citationCount} 条引用`)];
  for (const block of presented.blocks) {
    parts.push(renderSummaryBlock(block));
  }
  if (presented.citations.length > 0) {
    parts.push(el("p", "summary-citations-heading", "原文引用"));
    const list = el("ul", "summary-citations");
    for (const citation of presented.citations) {
      list.appendChild(renderCitation(citation));
    }
    parts.push(list);
  }
  elements.summaryContent.replaceChildren(...parts);
}

function renderList(state) {
  elements.resourceList.replaceChildren(
    ...state.resources.map((item) => renderListItem(presentListItem(item))),
  );
  elements.listEmpty.hidden = state.resources.length > 0;
}

function renderDetail(state) {
  if (!state.detail) {
    return;
  }
  const presented = presentDetail(state.detail);
  elements.detailTitleHeading.textContent = presented.title;
  if (elements.titleForm.hidden) {
    // Don't clobber a title the user is currently editing.
    elements.titleInput.value = presented.title;
  }
  elements.detailSources.replaceChildren(
    ...presented.sources.map((source) => renderDetailSource(source)),
  );
  // The notes read-back renders from the RAW detail (the jump URLs need
  // each source's platformId); the view models come from presentNote.
  const rawNotes = state.detail.notes || [];
  elements.detailNotesList.replaceChildren(
    ...rawNotes.map((note) => renderDetailNote(note, state.detail.sources || [])),
  );
  elements.notesEmpty.hidden = rawNotes.length > 0;

  // The transcript blocks render from the RAW detail too: sessions[] for
  // the headers (newest first per contract-r2 §3.6), detail.transcripts
  // for the per-session second-pull views, sources[] for the jump URLs.
  const rawSessions = state.detail.sessions || [];
  elements.detailTranscriptsList.replaceChildren(
    ...rawSessions.map((session) =>
      renderSessionBlock(session, state.detail.transcripts || {}, state.detail.sources || []),
    ),
  );
  elements.transcriptsEmpty.hidden = rawSessions.length > 0;

  // The course summary block (round 3): the history pills and the displayed
  // generation render from the flow's summaries state; the citations need
  // the detail's sessions[]/sources[] for attribution and jump URLs.
  renderSummaryHistory(state);
  renderSummaryContent(state);
}

// The library loads once per authenticated session: on resume, after a
// fresh login, and never with a previous account's data (reset on logout
// and session expiry below).
let libraryLoaded = false;

function render() {
  const state = flow.getState();
  const authenticated = state.state === "authenticated";
  elements.loginView.hidden = authenticated;
  elements.libraryView.hidden = !authenticated;

  elements.emailForm.hidden = state.state !== "email";
  elements.codeForm.hidden = state.state !== "code";

  elements.codeSentNotice.textContent = state.state === "code" ? state.notice || "" : "";

  if (state.error) {
    elements.loginError.textContent = state.error;
    elements.loginError.hidden = false;
  } else {
    elements.loginError.hidden = true;
    elements.loginError.textContent = "";
  }

  elements.requestCodeBtn.disabled = state.busy;
  elements.verifyBtn.disabled = state.busy;
  elements.logoutBtn.disabled = state.busy;

  if (!authenticated) {
    libraryLoaded = false;
    return;
  }

  const credential = credentials.get();
  elements.accountEmail.textContent = credential ? credential.email : "";

  const libraryState = library.getState();
  elements.listSection.hidden = libraryState.view !== "list";
  elements.detailSection.hidden = libraryState.view !== "detail";
  elements.collectBtn.disabled = libraryState.busy;
  elements.saveTitleBtn.disabled = libraryState.busy;
  // 生成中状态（round 3）：按钮禁用 + 进行时文案；同步生成可达数十秒，
  // 不假超时——状态只由 201/失败回落。
  elements.generateSummaryBtn.disabled = libraryState.generating || libraryState.busy;
  elements.generateSummaryBtn.textContent = libraryState.generating ? "生成中…" : "生成总结";

  setMessage(elements.libraryNotice, libraryState.notice);
  setMessage(elements.libraryError, libraryState.error);
  setMessage(elements.summariesError, libraryState.summariesError);

  if (libraryState.view === "list") {
    renderList(libraryState);
  } else {
    renderDetail(libraryState);
  }

  if (!libraryLoaded) {
    libraryLoaded = true;
    act(() => library.load());
  }
}

async function act(action) {
  const result = await action();
  render();
  return result;
}

// --- login flow bindings (P3) -------------------------------------------------

elements.emailForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(() => flow.submitEmail(elements.emailInput.value));
});

elements.codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(() => flow.submitCode(elements.codeInput.value));
});

elements.changeEmailBtn.addEventListener("click", () => {
  flow.backToEmail();
  render();
});

elements.logoutBtn.addEventListener("click", () => {
  act(async () => {
    const result = await flow.logout();
    // Leave no trace of the previous session's library.
    library.reset();
    elements.usagePanel.hidden = true;
    elements.usageText.textContent = "";
    return result;
  });
});

// --- library flow bindings (P5) ------------------------------------------------

elements.collectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(async () => {
    const result = await library.collect({
      url: elements.collectUrl.value,
      title: elements.collectTitle.value,
    });
    if (result.ok) {
      // A fresh empty input invites the next paste.
      elements.collectUrl.value = "";
      elements.collectTitle.value = "";
    }
    return result;
  });
});

elements.backToListBtn.addEventListener("click", () => {
  library.backToList();
  render();
});

// 生成总结（round 3, contract-r3 §3.1）：先起 POST 再立刻 render，让生成中
// 状态（按钮禁用 + 生成中…）在请求飞行期间就可见——act 完成后的那次 render
// 只能展示结果。
elements.generateSummaryBtn.addEventListener("click", () => {
  act(async () => {
    const libraryState = library.getState();
    if (!libraryState.detail) {
      return { ok: false };
    }
    const pending = library.generateSummary();
    render();
    return await pending;
  });
});

elements.editTitleBtn.addEventListener("click", () => {
  elements.detailTitleHeading.hidden = true;
  elements.editTitleBtn.hidden = true;
  elements.titleForm.hidden = false;
  elements.titleInput.focus();
});

function closeTitleEditor() {
  elements.titleForm.hidden = true;
  elements.detailTitleHeading.hidden = false;
  elements.editTitleBtn.hidden = false;
}

elements.cancelTitleBtn.addEventListener("click", () => {
  const libraryState = library.getState();
  if (libraryState.detail) {
    elements.titleInput.value = libraryState.detail.resource.title;
  }
  setMessage(elements.libraryError, null);
  closeTitleEditor();
});

elements.titleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(async () => {
    const libraryState = library.getState();
    if (!libraryState.detail) {
      return { ok: false };
    }
    const result = await library.retitle(
      libraryState.detail.resource.id,
      elements.titleInput.value,
    );
    if (result.ok) {
      closeTitleEditor();
    }
    return result;
  });
});

/** Validate the stored credential at shell entry and show the account. */
async function refreshAccount() {
  const result = await api.me();
  if (result.ok && result.data && result.data.account && result.data.account.email) {
    elements.accountEmail.textContent = result.data.account.email;
  }
  // A 401 was already routed through the interceptor back to the login
  // view; other failures just leave the stored email displayed.
  render();
}

// --- usage entry (round 3, contract-r3 §3.4, D18 只记录不计费) -----------------
// The account-area toggle re-reads GET /v1/usage on every open so the
// numbers follow the latest generation; a 401 routes through the shared
// interceptor (credential cleared, back to the login view). The decision
// lives in the pure modules (api-client's wrapper, presentUsage's line);
// this is fetch-and-fill binding only, like refreshAccount above.

async function refreshUsage() {
  elements.usageText.textContent = "用量加载中…";
  const result = await api.getUsage();
  if (elements.usagePanel.hidden) {
    return; // closed while in flight
  }
  elements.usageText.textContent = result.ok
    ? presentUsage(result.data).text
    : (result.data && result.data.error && result.data.error.message) || "用量加载失败，请稍后重试";
}

elements.usageBtn.addEventListener("click", () => {
  if (elements.usagePanel.hidden) {
    elements.usagePanel.hidden = false;
    void refreshUsage();
  } else {
    elements.usagePanel.hidden = true;
  }
});

// P7 linked logout, pull side: a logout on the extension (same credential
// group) cannot push to this page. While logged in, the next visibility or
// focus event silently re-checks GET /v1/me; a 401 routes through the
// shared interceptor (credential cleared, flow reset) and the page
// re-renders back to the login view.
const sessionRevalidator = createSessionRevalidator({
  api,
  isAuthenticated: () => flow.getState().state === "authenticated",
  onInvalidated: () => render(),
});
document.addEventListener("visibilitychange", () => {
  void sessionRevalidator.onPageVisible(document.visibilityState === "visible");
});
window.addEventListener("focus", () => {
  void sessionRevalidator.onPageVisible(true);
});

flow.resume().then(() => {
  render();
  if (flow.getState().state === "authenticated") {
    refreshAccount();
  }
});
