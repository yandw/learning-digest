/**
 * Page binding for the extension link confirmation page (P6). All decisions
 * live in the pure modules (link-flow.js reusing the P3 login flow, the
 * shared api-client and credential store); this file only binds state
 * snapshots to the DOM and performs the final redirect to the success
 * address carrying `?link=<code>` — the URL the extension reads from the
 * tab it opened.
 */
import { createLinkFlow } from "./link-flow.js";
import { createApiClient } from "./api-client.js";
import { createCredentialStore } from "./credentials.js";

function byId(id) {
  return document.getElementById(id);
}

const credentials = createCredentialStore({ storage: window.localStorage });

// The api client and the flow reference each other (401 -> back to login),
// so the expiry handler is bound after both exist.
let sessionExpiredHandler = () => {};
const api = createApiClient({
  fetchImpl: (path, init) => fetch(path, init),
  credentials,
  onUnauthorized: () => sessionExpiredHandler(),
});
const flow = createLinkFlow({ api, credentials });
sessionExpiredHandler = () => {
  flow.start().then(render);
};

const elements = {
  linkEmailForm: byId("linkEmailForm"),
  linkCodeForm: byId("linkCodeForm"),
  linkConfirmView: byId("linkConfirmView"),
  linkDoneView: byId("linkDoneView"),
  linkBusy: byId("linkBusy"),
  linkError: byId("linkError"),
  linkCodeSentNotice: byId("linkCodeSentNotice"),
  linkEmailInput: byId("linkEmailInput"),
  linkCodeInput: byId("linkCodeInput"),
  linkRequestCodeBtn: byId("linkRequestCodeBtn"),
  linkVerifyBtn: byId("linkVerifyBtn"),
  linkChangeEmailBtn: byId("linkChangeEmailBtn"),
  confirmLinkBtn: byId("confirmLinkBtn"),
};

function render() {
  const state = flow.getState();
  const s = state.state;

  elements.linkEmailForm.hidden = s !== "login-email";
  elements.linkCodeForm.hidden = s !== "login-code";
  elements.linkConfirmView.hidden = s !== "confirm" && s !== "issuing";
  elements.linkDoneView.hidden = s !== "issued";
  elements.linkBusy.hidden = s !== "issuing" && s !== "checking";

  elements.linkCodeSentNotice.textContent =
    s === "login-code" ? state.login.notice || "" : "";

  if (state.error) {
    elements.linkError.textContent = state.error;
    elements.linkError.hidden = false;
  } else {
    elements.linkError.hidden = true;
    elements.linkError.textContent = "";
  }

  elements.linkRequestCodeBtn.disabled = state.login.busy;
  elements.linkVerifyBtn.disabled = state.login.busy;
  elements.confirmLinkBtn.disabled = s !== "confirm";
}

async function act(action) {
  const result = await action();
  render();
  return result;
}

elements.linkEmailForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(() => flow.submitEmail(elements.linkEmailInput.value));
});

elements.linkCodeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(() => flow.submitCode(elements.linkCodeInput.value));
});

elements.linkChangeEmailBtn.addEventListener("click", () => {
  flow.backToEmail();
  render();
});

elements.confirmLinkBtn.addEventListener("click", () => {
  act(async () => {
    const result = await flow.confirmLink();
    if (result.ok) {
      // The success address carries the one-time code; the extension reads
      // it from the final URL of the tab it opened.
      window.location.replace(
        `/link.html?link=${encodeURIComponent(result.linkCode)}`,
      );
    }
    return result;
  });
});

/**
 * The success address itself: the extension picked up the code (and usually
 * closed the tab); if the user stays, show the done view only.
 */
function linkCodeFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get("link");
}

const existingCode = linkCodeFromLocation();
if (existingCode) {
  byId("linkTitle").textContent = "已发起关联";
  elements.linkDoneView.hidden = false;
} else {
  flow.start().then(render);
}
