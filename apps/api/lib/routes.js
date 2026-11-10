/**
 * /v1 route registration. Auth routes (request-code / verify / logout / me)
 * are added slice by slice; P4/P9/P12 append resource/source routes here.
 */
const { validationFailed, unauthorizedMissing, unauthorizedExpired } = require("./errors");
const { normalizeEmail, isInvited } = require("./invites");
const { issueCode } = require("./codes");
const { openOrLogin } = require("./accounts");
const { authenticate, findCredentialByToken, revokeCredentialGroup, issueCredential } = require("./credentials");
const { createLinkCode, consumeLinkCode } = require("./link-codes");
const {
  parseSourceRequest,
  matchSource,
  createFavorite,
  presentFavorite,
  listResources,
  getResourceDetail,
  retitleResource,
} = require("./resources");
const { saveProgress } = require("./progress");
const { createNote } = require("./notes");

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

  // POST /v1/auth/logout — linked logout (P7, decision 3 of #49): the
  // presented credential's WHOLE credential group is revoked, so the Web
  // session and the extension credential die together (contract §1: 401 =
  // expired OR linked-revoked). A repeat logout with an already-revoked
  // credential stays a 200 no-op; a token the server never issued is still
  // the expired-token 401 body.
  router.add("POST", "/v1/auth/logout", async ({ req }) => {
    const token = bearerToken(req);
    if (!token) {
      throw unauthorizedMissing();
    }
    const record = findCredentialByToken({ store, token });
    if (!record) {
      throw unauthorizedExpired();
    }
    revokeCredentialGroup({ store, groupId: record.credentialGroupId, now });
    return { status: 200, body: { ok: true } };
  });

  // POST /v1/resources — favorite (contract §3.1): identity hit first,
  // else the normalized address; 201 creates, 200 returns the existing
  // Resource + Source with the original first-favorited URL (D3).
  router.add("POST", "/v1/resources", async ({ req, body }) => {
    const credential = requireCredential(req);
    const request = parseSourceRequest(body);
    const existing = matchSource({ store, accountId: credential.accountId, request });
    if (existing) {
      return { status: 200, body: presentFavorite({ store, ...existing }) };
    }
    const created = createFavorite({ store, accountId: credential.accountId, request, now });
    return { status: 201, body: presentFavorite({ store, ...created }) };
  });

  // GET /v1/resources — the account's list, newest first (contract §3.2).
  router.add("GET", "/v1/resources", async ({ req }) => {
    const credential = requireCredential(req);
    return listResources({ store, accountId: credential.accountId });
  });

  // GET /v1/resources/:id — detail with sources and notes; cross-account
  // reads are the same 404 as unknown ids (D2).
  router.add("GET", "/v1/resources/:id", async ({ req, params }) => {
    const credential = requireCredential(req);
    return getResourceDetail({ store, accountId: credential.accountId, id: params.id });
  });

  // POST /v1/resources/:id/notes — add a note (contract §3.6; P12): a
  // clientRequestId dedupes resends (201 creates, 200 returns the original
  // note); an optional sourceId + positionMs pair stamps the note onto one
  // of the resource's own sources. Cross-account resources are 404 (D2).
  router.add("POST", "/v1/resources/:id/notes", async ({ req, params, body }) => {
    const credential = requireCredential(req);
    return createNote({
      store,
      accountId: credential.accountId,
      resourceId: params.id,
      body,
      now,
    });
  });

  // PATCH /v1/resources/:id — manual retitle (contract §3.7, round-1
  // supplement): body accepts only { title }; cross-account is 404 (D2).
  router.add("PATCH", "/v1/resources/:id", async ({ req, params, body }) => {
    const credential = requireCredential(req);
    return retitleResource({ store, accountId: credential.accountId, id: params.id, body });
  });

  // POST /v1/sources/resolve — read-only pre-study lookup (contract §3.4):
  // the same matching as favoriting, but a miss answers matched:false and
  // writes nothing.
  router.add("POST", "/v1/sources/resolve", async ({ req, body }) => {
    const credential = requireCredential(req);
    const request = parseSourceRequest(body);
    const existing = matchSource({ store, accountId: credential.accountId, request });
    if (!existing) {
      return { status: 200, body: { matched: false } };
    }
    return {
      status: 200,
      body: { matched: true, ...presentFavorite({ store, ...existing }) },
    };
  });

  // PUT /v1/sources/:id/progress — save the playback position with
  // optimistic concurrency (contract §3.5; decision D4). Semantics live in
  // lib/progress.js: rewinds are legal, resends of the last write are
  // idempotent, cross-account sources are 404.
  router.add("PUT", "/v1/sources/:id/progress", async ({ req, params, body }) => {
    const credential = requireCredential(req);
    return saveProgress({
      store,
      accountId: credential.accountId,
      sourceId: params.id,
      body,
    });
  });

  // --- P6: extension account linking (decision 3 of #49) ---

  // POST /v1/auth/link-requests — the Web confirmation page (presenting its
  // own Bearer credential) creates a one-time short-lived link code bound to
  // its credential group. The page bounces the browser to a success address
  // carrying the code; the extension reads it from the tab it opened.
  router.add("POST", "/v1/auth/link-requests", async ({ req }) => {
    const credential = requireCredential(req);
    const { linkCode, expiresAt } = createLinkCode({
      store,
      credential,
      now,
      config,
    });
    return { status: 201, body: { linkCode, expiresAt } };
  });

  // POST /v1/auth/link — the extension exchanges the code (no Bearer: it has
  // no credential yet) for a live extension credential joined into the
  // confirming Web session's credential group. One exchange per code; a
  // group revoked in the meantime fails the exchange.
  router.add("POST", "/v1/auth/link", async ({ body }) => {
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.code === undefined ||
      body.code === null ||
      body.code === ""
    ) {
      throw validationFailed("缺少必填字段 code");
    }
    const { accountId, credentialGroupId } = consumeLinkCode({
      store,
      code: String(body.code),
      now,
    });
    const { token, credential } = issueCredential({
      store,
      accountId,
      kind: "extension",
      now,
      config,
      credentialGroupId,
    });
    const account = store.list("accounts").find((entry) => entry.id === accountId);
    return {
      status: 201,
      body: {
        account: { id: accountId, email: account ? account.email : null },
        credential: {
          token,
          kind: credential.kind,
          credentialGroupId: credential.credentialGroupId,
        },
      },
    };
  });
}

module.exports = { registerRoutes };
