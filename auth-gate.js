/**
 * Authorization gate (P6, decision 3 of #49): a valid linked credential is
 * the precondition for every extension feature. Pure and require()-able —
 * no chrome or DOM dependencies — so the Node tests cover it fully and the
 * background service worker / side panel consume it via importScripts.
 *
 * The link flow this module serves (settled design of #56):
 *   1. the extension opens the Web confirmation page (apps/web link.html)
 *      in a tab it owns;
 *   2. the logged-in user confirms; the page creates a one-time link code
 *      bound to its credential group and bounces to a success address
 *      carrying `?link=<code>`;
 *   3. the extension reads that final URL (its own tab, via chrome.tabs)
 *      and exchanges the code for a live extension credential, which joins
 *      the confirming Web session's credential group (P7 linked logout).
 */
var YTD_AUTH_GATE = (() => {
  // The linked credential lives in chrome.storage.local under the repo's
  // ytd_* key convention.
  const CREDENTIAL_STORAGE_KEY = "ytd_auth_credential";

  const GENERIC_EXCHANGE_ERROR = "关联失败，请在网页上重新发起关联";

  /**
   * Validates a stored credential blob. Anything malformed behaves like
   * "not linked" — a corrupted record can never unlock the panel.
   */
  function parseStoredCredential(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (typeof raw.token !== "string" || raw.token.trim() === "") return null;
    return {
      token: raw.token,
      credentialGroupId: typeof raw.credentialGroupId === "string" ? raw.credentialGroupId : null,
      accountId: typeof raw.accountId === "string" ? raw.accountId : null,
      email: typeof raw.email === "string" ? raw.email : null,
      linkedAt: typeof raw.linkedAt === "number" ? raw.linkedAt : null,
    };
  }

  /**
   * Joins a configured base URL and a /v1 path. Returns null when the base
   * URL is not an http(s) URL (a misconfigured setting must fail loudly at
   * the call site, not build a nonsense request).
   */
  function buildApiUrl(baseUrl, path) {
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
    try {
      const url = new URL(baseUrl.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      const base = baseUrl.trim().replace(/\/+$/, "");
      const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
      return `${base}${suffix}`;
    } catch (_error) {
      return null;
    }
  }

  /** The Web confirmation page the extension opens for linking. */
  function buildLinkPageUrl(webAppBaseUrl) {
    return buildApiUrl(webAppBaseUrl, "/link.html");
  }

  /**
   * Extracts the one-time code from a tab's final URL. Only the link
   * success address (…/link.html?link=<code>) counts; anything else —
   * other pages, other params, the confirmation page before redirect —
   * returns null so the background keeps waiting.
   */
  function extractLinkCode(url) {
    if (typeof url !== "string" || url === "") return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return null;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/link.html")) return null;
    const code = parsed.searchParams.get("link");
    return code && code.trim() !== "" ? code : null;
  }

  function parseEnvelope(data) {
    const message = data && data.error && data.error.message;
    return typeof message === "string" && message ? message : GENERIC_EXCHANGE_ERROR;
  }

  /**
   * Startup probe (and any re-check): present the stored credential to
   * GET /v1/me. Network failures do NOT invalidate a credential — the gate
   * reports "unreachable" so the panel can say so instead of treating the
   * learner as logged out; only a 401 means the credential died.
   *
   * @param {object} options
   * @param {(url: string, init?: object) => Promise<Response>} options.fetchImpl
   * @param {string} options.apiBaseUrl configured Learning Digest API origin
   * @param {object|null} options.credential parsed stored credential
   * @returns {Promise<object>} { authorized, reason, account? } where reason
   *   is "unconfigured" | "unauthorized" | "unreachable" (only when not
   *   authorized)
   */
  async function checkAuthorization({ fetchImpl, apiBaseUrl, credential }) {
    const parsed = parseStoredCredential(credential);
    if (!parsed) {
      return { authorized: false, reason: "unconfigured" };
    }
    const url = buildApiUrl(apiBaseUrl, "/v1/me");
    if (!url) {
      return { authorized: false, reason: "unconfigured" };
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${parsed.token}` },
      });
    } catch (_error) {
      return { authorized: false, reason: "unreachable" };
    }
    if (response.status === 401) {
      return { authorized: false, reason: "unauthorized" };
    }
    if (response.status >= 200 && response.status < 300) {
      let account = null;
      try {
        const body = await response.json();
        account = body && body.account ? body.account : null;
      } catch (_error) {
        account = null; // a 2xx without JSON still proves the token is live
      }
      return { authorized: true, reason: null, account };
    }
    // Anything else: the API answered but not with a verdict we can trust.
    return { authorized: false, reason: "unreachable" };
  }

  /**
   * Exchange the one-time link code for a live extension credential
   * (POST /v1/auth/link, no Bearer — the extension has none yet).
   *
   * @param {object} options
   * @param {(url: string, init?: object) => Promise<Response>} options.fetchImpl
   * @param {string} options.apiBaseUrl configured Learning Digest API origin
   * @param {string} options.code the code from the success address
   * @returns {Promise<object>} { ok, credential?, account?, status?, message? }
   */
  async function exchangeLinkCode({ fetchImpl, apiBaseUrl, code }) {
    const url = buildApiUrl(apiBaseUrl, "/v1/auth/link");
    if (!url) {
      return { ok: false, status: 0, message: GENERIC_EXCHANGE_ERROR };
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
    } catch (_error) {
      return { ok: false, status: 0, message: "无法连接学习服务，请稍后重试" };
    }
    let data = null;
    try {
      data = await response.json();
    } catch (_error) {
      data = null;
    }
    const credentialBody = data && data.credential;
    if (response.status === 201 && credentialBody && typeof credentialBody.token === "string") {
      return {
        ok: true,
        credential: parseStoredCredential({
          token: credentialBody.token,
          credentialGroupId: credentialBody.credentialGroupId,
          accountId: data.account ? data.account.id : null,
          email: data.account ? data.account.email : null,
          linkedAt: Date.now(),
        }),
        account: data.account || null,
      };
    }
    return {
      ok: false,
      status: response.status,
      message: data ? parseEnvelope(data) : GENERIC_EXCHANGE_ERROR,
    };
  }

  return {
    CREDENTIAL_STORAGE_KEY,
    parseStoredCredential,
    buildApiUrl,
    buildLinkPageUrl,
    extractLinkCode,
    checkAuthorization,
    exchangeLinkCode,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_AUTH_GATE;
}
