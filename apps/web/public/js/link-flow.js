/**
 * Extension link flow state machine (pure module — no DOM, no fetch; P6,
 * decision 3 of #49). The page the extension opens walks the user to a
 * confirmed link code:
 *
 *   "checking" -> "confirm"                          (stored credential live)
 *   "checking" -> "login-email" -> "login-code"      (login first, then back)
 *              -> "confirm" -> "issuing" -> "issued" (code created)
 *
 * The login half is the P3 login-flow state machine reused as-is; this
 * module only maps its states and owns the confirm/issue half. The API
 * client's 401 interceptor clears dead credentials and is what moves the
 * flow back to "login-email" mid-flight. The page binding redirects the
 * browser to the success address carrying `?link=<code>` when the state
 * reaches "issued" — the extension reads the code from the tab's final URL.
 */
import { createLoginFlow } from "./login-flow.js";

const GENERIC_ERROR = "请求失败，请稍后重试";

function envelopeMessage(data) {
  return (data && data.error && data.error.message) || GENERIC_ERROR;
}

/**
 * @param {object} options
 * @param {object} options.api createApiClient-shaped seam:
 *   { requestCode, verify, me, createLinkRequest } -> { ok, status, data }
 * @param {import("./credentials.js").CredentialStore} options.credentials
 */
export function createLinkFlow({ api, credentials }) {
  const login = createLoginFlow({ api, credentials });
  let state = "checking"; // "checking" | "login-email" | "login-code" | "confirm" | "issuing" | "issued"
  let linkCode = null;
  let error = null;

  function getState() {
    return { state, linkCode, error, login: login.getState() };
  }

  function syncFromLogin() {
    const loginState = login.getState().state;
    if (loginState === "authenticated") {
      if (state !== "issued") {
        state = "confirm";
      }
    } else if (loginState === "code") {
      state = "login-code";
    } else {
      state = "login-email";
    }
  }

  /**
   * Entry: verify the stored credential against the API (the page never
   * trusts localStorage alone). A live credential lands on "confirm";
   * anything else (not logged in, expired, server unreachable) lands on
   * the login half, with the failure surfaced as copy.
   */
  async function start() {
    error = null;
    const credential = credentials.get();
    if (!credential || !credential.token) {
      state = "login-email";
      return getState();
    }
    const result = await api.me();
    if (result.ok) {
      state = "confirm";
      return getState();
    }
    // A 401 already went through the interceptor (credential cleared).
    state = "login-email";
    if (result.status !== 401) {
      error = envelopeMessage(result.data);
    }
    return getState();
  }

  async function submitEmail(rawEmail) {
    const result = await login.submitEmail(rawEmail);
    syncFromLogin();
    return result;
  }

  async function submitCode(rawCode) {
    const result = await login.submitCode(rawCode);
    // A successful verify puts the login machine at "authenticated"; the
    // link flow continues on the confirm view of the same page.
    syncFromLogin();
    return result;
  }

  function backToEmail() {
    login.backToEmail();
    syncFromLogin();
  }

  async function confirmLink() {
    if (state !== "confirm") {
      return { ok: false, message: GENERIC_ERROR };
    }
    state = "issuing";
    error = null;
    const result = await api.createLinkRequest();
    if (result.ok && result.data && result.data.linkCode) {
      linkCode = result.data.linkCode;
      state = "issued";
      return { ok: true, linkCode };
    }
    error = envelopeMessage(result.data);
    if (result.status === 401) {
      // The session died between entry and confirm; the interceptor has
      // already cleared the credential — restart on the login half.
      state = "login-email";
    } else {
      state = "confirm";
    }
    return { ok: false, message: error };
  }

  return { getState, start, submitEmail, submitCode, backToEmail, confirmLink };
}
