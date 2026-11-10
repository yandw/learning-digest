/**
 * /v1 route registration. Auth routes (request-code / verify / logout / me)
 * are added slice by slice; P4/P9/P12 append resource/source routes here.
 */
const { validationFailed } = require("./errors");
const { normalizeEmail, isInvited } = require("./invites");
const { issueCode } = require("./codes");
const { openOrLogin } = require("./accounts");

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
}

module.exports = { registerRoutes };
