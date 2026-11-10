/**
 * Unified error type + contract error envelope.
 *
 * Every non-2xx response body is `{"error": {"code", "message"}}` per
 * contracts/contract-v1.md §1; progress conflicts (P9) additionally carry
 * `current` at the top level, which `extra` accommodates.
 */
class ApiError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable machine-readable code, e.g. "unauthorized"
   * @param {string} message human-readable Chinese explanation
   * @param {object} [extra] extra top-level body fields (e.g. `current`)
   */
  constructor(status, code, message, extra) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }

  toBody() {
    const body = { error: { code: this.code, message: this.message } };
    if (this.extra) {
      Object.assign(body, this.extra);
    }
    return body;
  }
}

function validationFailed(message) {
  return new ApiError(400, "validation_failed", message);
}

function unauthorizedMissing() {
  return new ApiError(401, "unauthorized", "未登录或凭据缺失");
}

function unauthorizedExpired() {
  return new ApiError(401, "unauthorized", "凭据已失效，请重新登录并关联");
}

function notFoundUnknownPath() {
  return new ApiError(404, "not_found", "未知接口路径");
}

/** Cross-account or missing Resource reads (decision D2: always 404). */
function notFoundResource() {
  return new ApiError(404, "not_found", "资源不存在或无权访问");
}

/** Cross-account or missing Source writes (decision D2: always 404). */
function notFoundSource() {
  return new ApiError(404, "not_found", "来源不存在或无权访问");
}

function methodNotAllowed() {
  return new ApiError(405, "method_not_allowed", "HTTP 方法不被允许");
}

function internalError() {
  return new ApiError(500, "internal_error", "服务内部错误");
}

module.exports = {
  ApiError,
  validationFailed,
  unauthorizedMissing,
  unauthorizedExpired,
  notFoundUnknownPath,
  notFoundResource,
  notFoundSource,
  methodNotAllowed,
  internalError,
};
