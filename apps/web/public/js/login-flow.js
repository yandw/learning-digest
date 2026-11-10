/**
 * Login flow state machine (pure module — no DOM, no fetch).
 *
 * States: "email" (enter invited address) -> "code" (enter the 6-digit
 * verification code) -> "authenticated" (library shell). Logout and
 * session expiry return to "email".
 *
 * It owns: calling the API through the injected `api` seam (the shape
 * createApiClient exposes), local form validation before any request,
 * storing the issued credential, and the user-facing Chinese copy for
 * notices and errors. Contract error envelopes are presented verbatim
 * (`error.message`), so wording always matches the fixtures. The page
 * binds only getState() snapshots and action results to the DOM.
 */
import { normalizeEmail, validateEmail, validateCode } from "./validation.js";

const CODE_SENT_NOTICE =
  "验证码已发送，请查收邮件。本地开发环境可在 apps/api/data/outbox.jsonl 查看验证码。";
const SESSION_EXPIRED_MESSAGE = "登录状态已失效，请重新登录";
const BUSY_MESSAGE = "正在处理，请稍候";

/**
 * @param {object} options
 * @param {object} options.api createApiClient-shaped seam:
 *   { requestCode, verify, logout, me } -> { ok, status, data }
 * @param {import("./credentials.js").CredentialStore} options.credentials
 */
export function createLoginFlow({ api, credentials }) {
  let state = "email"; // "email" | "code" | "authenticated"
  let email = null;
  let notice = null;
  let error = null;
  let busy = false;

  function getState() {
    return { state, email, notice, error, busy };
  }

  function transition(next) {
    state = next;
    if (next === "email") {
      email = null;
      notice = null;
    }
    busy = false;
  }

  function envelopeMessage(data) {
    return (data && data.error && data.error.message) || "请求失败，请稍后重试";
  }

  async function submitEmail(rawEmail) {
    if (busy) {
      return { ok: false, message: BUSY_MESSAGE };
    }
    const invalid = validateEmail(rawEmail);
    if (invalid) {
      error = invalid.message;
      return { ok: false, message: invalid.message };
    }
    busy = true;
    error = null;
    const normalized = normalizeEmail(rawEmail);
    const result = await api.requestCode(normalized);
    busy = false;
    if (!result.ok) {
      error = envelopeMessage(result.data);
      return { ok: false, message: error };
    }
    // Anti-enumeration: the API answers 200 for every address, so the
    // notice never claims the address is invited or not.
    email = normalized;
    notice = CODE_SENT_NOTICE;
    state = "code";
    return { ok: true };
  }

  async function submitCode(rawCode) {
    if (busy) {
      return { ok: false, message: BUSY_MESSAGE };
    }
    const invalid = validateCode(rawCode);
    if (invalid) {
      error = invalid.message;
      return { ok: false, message: invalid.message };
    }
    busy = true;
    error = null;
    const result = await api.verify(email, rawCode.trim());
    busy = false;
    const credential = result.ok && result.data && result.data.credential;
    if (!result.ok || !credential || !credential.token) {
      error = envelopeMessage(result.data);
      return { ok: false, message: error };
    }
    credentials.set({
      token: credential.token,
      email: (result.data.account && result.data.account.email) || email,
      accountId: result.data.account ? result.data.account.id : null,
      credentialGroupId: credential.credentialGroupId || null,
    });
    notice = null;
    email = null;
    state = "authenticated";
    return { ok: true };
  }

  async function logout() {
    // Server-side revocation is best effort: a 401 here means the
    // credential already died (the interceptor handled it), and any other
    // failure must not trap the user in the shell.
    try {
      await api.logout();
    } catch (_error) {
      // fall through to the local cleanup
    }
    credentials.clear();
    transition("email");
    return { ok: true };
  }

  /** Called by the api client's 401 interceptor (P7 linked logout). */
  function handleSessionExpired() {
    credentials.clear();
    transition("email");
    error = SESSION_EXPIRED_MESSAGE;
  }

  async function resume() {
    const credential = credentials.get();
    if (credential && credential.token) {
      state = "authenticated";
    } else {
      transition("email");
    }
    return getState();
  }

  function backToEmail() {
    transition("email");
  }

  return { getState, submitEmail, submitCode, logout, handleSessionExpired, resume, backToEmail };
}
