/**
 * Page binding only: wires the login flow state machine, the library flow
 * (P5: collect / list / detail / retitle), the admin site-capability flow
 * (round 4: the 站点管理 table), the api client and the credential store to
 * the DOM. All decisions live in the pure modules (login-flow.js /
 * library.js / admin.js / api-client.js / credentials.js); this file only
 * builds elements from their snapshots and view models.
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
  DELETE_CONFIRM_MS,
} from "./library.js";
import { createAdminFlow, presentRowStatus, shouldShowAdminEntry } from "./admin.js";
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
// Round-4 admin surface (contract-r4 §3.2/§3.3): the 站点管理 table. It
// loads only when its surface opens (view "idle" marks never-loaded).
const admin = createAdminFlow({ api });
sessionExpiredHandler = () => flow.handleSessionExpired();

const elements = {
  loginView: byId("loginView"),
  libraryView: byId("libraryView"),
  // shell nav: the surface switcher + the admin entry (isAdmin-driven)
  libraryNavBtn: byId("libraryNavBtn"),
  adminNavBtn: byId("adminNavBtn"),
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
  // library: detail view, delete entry (ticket 5.5, contract-r4 §8)
  deleteResourceBtn: byId("deleteResourceBtn"),
  deleteResourceHint: byId("deleteResourceHint"),
  // usage entry (round 3): the account-area toggle + summary panel
  usageBtn: byId("usageBtn"),
  usagePanel: byId("usagePanel"),
  usageText: byId("usageText"),
  // admin view (round 4, #87): the site-capability table / denied placeholder
  adminSection: byId("adminSection"),
  adminHint: byId("adminHint"),
  adminError: byId("adminError"),
  adminDenied: byId("adminDenied"),
  adminDeniedText: byId("adminDeniedText"),
  adminTable: byId("adminTable"),
  adminTableBody: byId("adminTableBody"),
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

/**
 * Two-step delete wiring (ticket 5.5, contract-r4 §8): the arm/execute
 * decision lives in the flow (deleteClick's toggle); this binds one
 * button. A click that ARMS schedules the revert render for when the
 * confirm window elapses (the flow's own timer clears the state; the page
 * only needs to re-render the label); a blur disarms — the flow reports
 * whether anything changed, so idempotent blurs skip the render.
 */
function wireDeleteButton(button, run) {
  button.addEventListener("click", () => {
    act(async () => {
      const result = await run();
      if (result && result.armed) {
        setTimeout(() => render(), DELETE_CONFIRM_MS + 100);
      }
      return result;
    });
  });
  button.addEventListener("blur", () => {
    if (library.disarmDelete()) {
      render();
    }
  });
}

/** One learning-list row: open-in-new-tab link + badges + progress. */
function renderListItem(presented, armed) {
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
  // 删除（ticket 5.5）：与「详情」并列的两步确认按钮；armed 时文案变
  // 「确认删除」，再点才发 DELETE。
  const deleteBtn = el("button", "link-btn delete-btn", armed ? "确认删除" : "删除");
  deleteBtn.type = "button";
  deleteBtn.dataset.id = presented.id;
  deleteBtn.classList.toggle("armed", armed);
  wireDeleteButton(deleteBtn, () => library.deleteClick(presented.id, "list"));
  meta.appendChild(deleteBtn);
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
    ...state.resources.map((item) => {
      const presented = presentListItem(item);
      const armed = !!(
        state.armedDelete &&
        state.armedDelete.surface === "list" &&
        state.armedDelete.id === presented.id
      );
      return renderListItem(presented, armed);
    }),
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

  // The delete entry (ticket 5.5, contract-r4 §8): armed flips the label to
  // 确认删除 and reveals the cascade hint (删除即终态, D23).
  const deleteArmed = !!(
    state.armedDelete &&
    state.armedDelete.surface === "detail" &&
    state.armedDelete.id === presented.id
  );
  elements.deleteResourceBtn.textContent = deleteArmed ? "确认删除" : "删除资料";
  elements.deleteResourceBtn.classList.toggle("armed", deleteArmed);
  elements.deleteResourceHint.hidden = !deleteArmed;
}

// The library loads once per authenticated session: on resume, after a
// fresh login, and never with a previous account's data (reset on logout
// and session expiry below).
let libraryLoaded = false;

// The shell surface (round 4, #87): the nav switches the visible section
// between the library views (list/detail, the flow's own state) and the
// admin table. "admin" additionally loads the table on first open.
let surface = "library";

// The /v1/me account (one read per authenticated session): its isAdmin
// flag drives the 站点管理 nav entry — non-admins never see it.
let meAccount = null;
let meLoaded = false;

/** One admin table row: platformId + three switches + the row save. */
function renderAdminRow(row) {
  const tr = el("tr", "admin-row");
  tr.appendChild(el("td", "admin-platform", row.platformId));

  for (const field of ["captions", "asr", "enabled"]) {
    const td = el("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = row[field];
    checkbox.dataset.platform = row.platformId;
    checkbox.dataset.field = field;
    checkbox.disabled = row.saveState === "saving";
    td.appendChild(checkbox);
    tr.appendChild(td);
  }

  const actions = el("td", "admin-actions");
  const status = el("span", "admin-row-status", presentRowStatus(row));
  if (row.saveState === "error") {
    status.classList.add("admin-row-status-error");
  }
  actions.appendChild(status);
  const saveBtn = el("button", "secondary-btn admin-save-btn", "保存");
  saveBtn.type = "button";
  saveBtn.dataset.platform = row.platformId;
  saveBtn.disabled = row.saveState === "saving" || row.changedKeys.length === 0;
  actions.appendChild(saveBtn);
  tr.appendChild(actions);

  return tr;
}

/**
 * The admin view (round 4): the table, or the denied placeholder — the
 * two views, switched like the library's list/detail. loading/error/idle
 * collapse into the shared hint/error lines. The denied text is the API's
 * D2 404 message verbatim (「接口不存在或无权访问」).
 */
function renderAdmin(adminState) {
  elements.adminTable.hidden = adminState.view !== "table";
  elements.adminDenied.hidden = adminState.view !== "denied";
  elements.adminDeniedText.textContent = adminState.view === "denied" ? adminState.error || "" : "";
  elements.adminError.hidden = adminState.view !== "error";
  elements.adminError.textContent = adminState.view === "error" ? adminState.error || "" : "";
  setMessage(elements.adminHint, adminState.view === "loading" ? "站点能力加载中…" : "");
  if (adminState.view === "table") {
    elements.adminTableBody.replaceChildren(...adminState.rows.map((row) => renderAdminRow(row)));
  } else {
    elements.adminTableBody.replaceChildren();
  }
}

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
    // Leave no trace of the previous session: the admin table reloads per
    // session too, and the shell starts back on the library surface.
    meAccount = null;
    meLoaded = false;
    surface = "library";
    admin.reset();
    return;
  }

  const credential = credentials.get();
  elements.accountEmail.textContent = credential ? credential.email : "";

  // One /v1/me read per authenticated session: the account's isAdmin flag
  // decides the 站点管理 nav entry (non-admins never see it), and legacy
  // accounts without the field read as non-admin (fail closed).
  if (!meLoaded) {
    meLoaded = true;
    void refreshAccount();
  }

  const libraryState = library.getState();
  elements.listSection.hidden = surface !== "library" || libraryState.view !== "list";
  elements.detailSection.hidden = surface !== "library" || libraryState.view !== "detail";
  elements.adminSection.hidden = surface !== "admin";

  elements.libraryNavBtn.classList.toggle("active", surface === "library");
  elements.adminNavBtn.classList.toggle("active", surface === "admin");
  elements.adminNavBtn.hidden = !shouldShowAdminEntry(meAccount);
  elements.collectBtn.disabled = libraryState.busy;
  elements.saveTitleBtn.disabled = libraryState.busy;
  // 生成中状态（round 3）：按钮禁用 + 进行时文案；同步生成可达数十秒，
  // 不假超时——状态只由 201/失败回落。
  elements.generateSummaryBtn.disabled = libraryState.generating || libraryState.busy;
  elements.generateSummaryBtn.textContent = libraryState.generating ? "生成中…" : "生成总结";
  elements.deleteResourceBtn.disabled = libraryState.busy;

  setMessage(elements.libraryNotice, libraryState.notice);
  setMessage(elements.libraryError, libraryState.error);
  setMessage(elements.summariesError, libraryState.summariesError);

  if (libraryState.view === "list") {
    renderList(libraryState);
  } else {
    renderDetail(libraryState);
  }

  if (surface === "admin") {
    renderAdmin(admin.getState());
  }

  if (!libraryLoaded) {
    libraryLoaded = true;
    act(() => library.load());
  }
}

/**
 * The nav's surface switch (round 4): the admin table loads on its first
 * open of the session (the flow's "idle" view marks never-loaded); act()
 * renders when the load lands.
 */
function showSurface(next) {
  surface = next;
  if (next === "admin" && admin.getState().view === "idle") {
    act(() => admin.load());
    return;
  }
  render();
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

// 删除资料（ticket 5.5, contract-r4 §8, D23）：详情页脚的两步确认入口，
// 与列表条目按钮同款 wireDeleteButton——arm/execute 判定在 flow（点击当前
// 详情资源），这里只接线；删除成功后 flow 回学习列表并清空 summaries 缓存。
wireDeleteButton(elements.deleteResourceBtn, () => {
  const libraryState = library.getState();
  if (!libraryState.detail) {
    return { ok: false };
  }
  return library.deleteClick(libraryState.detail.resource.id, "detail");
});

// --- admin surface bindings (round 4, contract-r4 §3.2/§3.3) -------------------

elements.libraryNavBtn.addEventListener("click", () => {
  showSurface("library");
});

elements.adminNavBtn.addEventListener("click", () => {
  showSurface("admin");
});

// The table rows re-render wholesale on every render (the library list's
// pattern), so row controls bind by delegation on the tbody: a checkbox
// change toggles the flow's row state, a save click PUTs only that row's
// diff — both decisions live in admin.js, this is fetch-and-bind only.
elements.adminTableBody.addEventListener("change", (event) => {
  const target = event.target;
  if (target && target.type === "checkbox" && target.dataset.platform && target.dataset.field) {
    act(() => admin.setToggle(target.dataset.platform, target.dataset.field, target.checked));
  }
});

elements.adminTableBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-platform]");
  if (button) {
    act(() => admin.saveRow(button.dataset.platform));
  }
});

/** Validate the stored credential at shell entry and show the account. */
async function refreshAccount() {
  const result = await api.me();
  if (result.ok && result.data && result.data.account) {
    // Round 4 (#87): keep the whole account — its isAdmin flag drives the
    // 站点管理 nav entry through shouldShowAdminEntry.
    meAccount = result.data.account;
    if (result.data.account.email) {
      elements.accountEmail.textContent = result.data.account.email;
    }
  }
  // A 401 was already routed through the interceptor back to the login
  // view; other failures just leave the stored email displayed (and, for
  // the admin flag, fail closed: no entry without a confirmed isAdmin).
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
  // render() fires the one-shot /v1/me read when authenticated, which
  // brings back the account (isAdmin flag included) and re-renders.
  render();
});
