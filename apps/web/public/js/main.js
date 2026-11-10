/**
 * Page binding only: wires the login flow state machine, the api client
 * and the credential store to the DOM. All decisions live in the pure
 * modules (login-flow.js / api-client.js / credentials.js); this file has
 * no logic worth unit-testing beyond what the static bundle test asserts.
 */
import { createLoginFlow } from "./login-flow.js";
import { createApiClient } from "./api-client.js";
import { createCredentialStore } from "./credentials.js";

function byId(id) {
  return document.getElementById(id);
}

const credentials = createCredentialStore({ storage: window.localStorage });

// The api client and the flow reference each other (401 -> flow.reset), so
// the expiry handler is bound after both exist.
let sessionExpiredHandler = () => {};
const api = createApiClient({
  fetchImpl: (path, init) => fetch(path, init),
  credentials,
  onUnauthorized: () => sessionExpiredHandler(),
});
const flow = createLoginFlow({ api, credentials });
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
};

function render() {
  const state = flow.getState();
  elements.loginView.hidden = state.state === "authenticated";
  elements.libraryView.hidden = state.state !== "authenticated";

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

  if (state.state === "authenticated") {
    const credential = credentials.get();
    elements.accountEmail.textContent = credential ? credential.email : "";
  }
}

async function act(action) {
  const result = await action();
  render();
  return result;
}

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
  act(() => flow.logout());
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

flow.resume().then(() => {
  render();
  if (flow.getState().state === "authenticated") {
    refreshAccount();
  }
});
