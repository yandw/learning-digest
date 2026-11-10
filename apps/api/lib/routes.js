/**
 * /v1 route registration. Auth routes (request-code / verify / logout / me)
 * are added slice by slice; P4/P9/P12 append resource/source routes here.
 */
const { validationFailed, unauthorizedMissing, unauthorizedExpired } = require("./errors");
const { normalizeEmail, isInvited } = require("./invites");
const { issueCode } = require("./codes");
const { openOrLogin } = require("./accounts");
const { authenticate } = require("./credentials");

/** Require body.email, normalized. Throws the contract 400 on failure. */
function requireEmail(body) {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.email === undefined ||
    body.email === null ||
    body.email === ""
  ) {
    throw validationFailed("缺少必填字段 email");
  }
  const email = normalizeEmail(body.email);
  if (!email) {
    throw validationFailed("邮箱格式不正确");
  }
  return email;
}

function registerRoutes(ctx) {
  const { router, store, mailer, now, config } = ctx;

  /**
   * Extract the Bearer token from the Authorization header, or null when
   * the header is absent or not Bearer (RFC 7235: scheme is case-insensitive).
   */
  function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") {
      return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
  }

  /**
   * Guard for protected endpoints: 401 with the contract fixture bodies —
   * missing header -> "未登录或凭据缺失"; unknown/revoked token (or a
   * credential whose whole group was revoked) -> "凭据已失效，请重新登录并关联".
   */
  function requireCredential(req) {
    const token = bearerToken(req);
    if (!token) {
      throw unauthorizedMissing();
    }
    const credential = authenticate({ store, token });
    if (!credential) {
      throw unauthorizedExpired();
    }
    return credential;
  }

  // POST /v1/auth/request-code — decision 3: invited email -> code email.
  // The response is uniform for invited and uninvited addresses so the
  // endpoint cannot be used to enumerate the invite list.
  router.add("POST", "/v1/auth/request-code", async ({ body }) => {
    const email = requireEmail(body);
    if (isInvited(store, email)) {
      await issueCode({ store, email, now, config, mailer });
    }
    return { status: 200, body: { ok: true } };
  });

  // POST /v1/auth/verify — correct code opens the account (201) or logs in
  // (200); both issue a Web credential into the active credential group.
  router.add("POST", "/v1/auth/verify", async ({ body }) => {
    const email = requireEmail(body);
    if (
      body.code === undefined ||
      body.code === null ||
      String(body.code).trim() === ""
    ) {
      throw validationFailed("缺少必填字段 code");
    }
    const result = openOrLogin({
      store,
      email,
      code: String(body.code),
      now,
      config,
    });
    return { status: result.opened ? 201 : 200, body: result };
  });

  // GET /v1/me — the round-1 protected endpoint: proves Bearer auth and
  // gives clients a way to inspect the logged-in account.
  router.add("GET", "/v1/me", async ({ req }) => {
    const credential = requireCredential(req);
    const account = store
      .list("accounts")
      .find((entry) => entry.id === credential.accountId);
    return {
      status: 200,
      body: { account: { id: credential.accountId, email: account ? account.email : null } },
    };
  });
}

module.exports = { registerRoutes };
