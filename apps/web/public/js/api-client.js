/**
 * API access for the page (pure module over an injectable fetch). The page
 * always talks to its own origin with relative /v1 paths — the server
 * proxies them to the API upstream, so no CORS is involved. Single auth
 * mechanism per contract §1: `Authorization: Bearer <token>` from the
 * credential store.
 *
 * The 401 contract is split deliberately:
 * - authenticated call returns 401  -> the credential expired or was
 *   revoked (linked logout, P7): clear it and signal onUnauthorized so the
 *   page returns to the login view;
 * - login-step call (auth: false)   -> a form error like 验证码错误或已过期:
 *   present the envelope message, keep credentials untouched.
 */

const NETWORK_ERROR_BODY = Object.freeze({
  error: { code: "network_error", message: "无法连接服务器，请稍后重试" },
});

async function parseJsonBody(response) {
  try {
    return JSON.parse(await response.text());
  } catch (_error) {
    return null;
  }
}

/**
 * @param {object} options
 * @param {(path: string, init?: object) => Promise<Response>} options.fetchImpl
 * @param {import("./credentials.js").CredentialStore} options.credentials
 * @param {() => void} [options.onUnauthorized] called at most once per 401
 *   on an authenticated call, AFTER the credential was cleared
 * @returns {object} api client with request() plus named wrappers
 */
export function createApiClient({ fetchImpl, credentials, onUnauthorized } = {}) {
  async function request(method, path, { body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (auth) {
      const token = credentials.get()?.token;
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    let response;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (_error) {
      return { ok: false, status: 0, data: NETWORK_ERROR_BODY };
    }

    const data = await parseJsonBody(response);
    if (response.status === 401 && auth) {
      credentials.clear();
      if (onUnauthorized) {
        onUnauthorized();
      }
    }
    return { ok: response.status >= 200 && response.status < 300, status: response.status, data };
  }

  // Named wrappers so callers never hand-write paths (the login flow tests
  // fake exactly this shape).
  function requestCode(email) {
    return request("POST", "/v1/auth/request-code", { body: { email }, auth: false });
  }

  function verify(email, code) {
    return request("POST", "/v1/auth/verify", { body: { email, code }, auth: false });
  }

  function logout() {
    return request("POST", "/v1/auth/logout", { body: {} });
  }

  function me() {
    return request("GET", "/v1/me");
  }

  // P6 extension linking: create a one-time link code bound to this
  // session's credential group. A 401 here routes through the shared
  // interceptor (clear + onUnauthorized) so the link page returns to login.
  function createLinkRequest() {
    return request("POST", "/v1/auth/link-requests", { body: {} });
  }

  // Resource endpoints (P5): collection, list, detail and the §3.7 retitle.
  // Ids are opaque server-generated strings; they are encoded so a hostile
  // value can never change the path shape.
  function createResource(body) {
    return request("POST", "/v1/resources", { body });
  }

  function listResources() {
    return request("GET", "/v1/resources");
  }

  function getResourceDetail(id) {
    return request("GET", `/v1/resources/${encodeURIComponent(String(id))}`);
  }

  function updateResourceTitle(id, title) {
    return request("PATCH", `/v1/resources/${encodeURIComponent(String(id))}`, {
      body: { title },
    });
  }

  // Session transcript (contract-r2 §3.5): the per-Session second pull the
  // detail page does after GET /v1/resources/{id} — the detail's sessions[]
  // carries only the transcript summary counts, the full TranscriptView is
  // read here (contract-r2 §3.6).
  function getSessionTranscript(id) {
    return request("GET", `/v1/sessions/${encodeURIComponent(String(id))}/transcript`);
  }

  return { request, requestCode, verify, logout, me, createLinkRequest, createResource, listResources, getResourceDetail, updateResourceTitle, getSessionTranscript };
}
