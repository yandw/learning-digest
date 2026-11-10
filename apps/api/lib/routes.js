/**
 * /v1 route registration. Auth routes (request-code / verify / logout / me)
 * are added slice by slice; P4/P9/P12 append resource/source routes here.
 */
const { validationFailed } = require("./errors");
const { normalizeEmail, isInvited } = require("./invites");
const { issueCode } = require("./codes");

function registerRoutes(ctx) {
  const { router, store, mailer, now, config } = ctx;

  // POST /v1/auth/request-code — decision 3: invited email -> code email.
  // The response is uniform for invited and uninvited addresses so the
  // endpoint cannot be used to enumerate the invite list.
  router.add("POST", "/v1/auth/request-code", async ({ body }) => {
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
    if (isInvited(store, email)) {
      await issueCode({ store, email, now, config, mailer });
    }
    return { status: 200, body: { ok: true } };
  });
}

module.exports = { registerRoutes };
