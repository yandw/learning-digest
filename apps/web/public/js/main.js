/**
 * Page binding only: wires the login flow state machine, the library flow
 * (P5: collect / list / detail / retitle), the api client and the
 * credential store to the DOM. All decisions live in the pure modules
 * (login-flow.js / library.js / api-client.js / credentials.js); this file
 * only builds elements from their snapshots and view models.
 */
import { createLoginFlow } from "./login-flow.js";
import { createLibraryFlow, presentListItem, presentDetail, presentNote, buildNoteJumpUrl } from "./library.js";
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

  setMessage(elements.libraryNotice, libraryState.notice);
  setMessage(elements.libraryError, libraryState.error);

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
