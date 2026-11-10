/**
 * Form validation for the login flow. Pure functions, no DOM and no fetch,
 * so node tests and the page share exactly one rule set. Email rules
 * mirror apps/api's normalizeEmail (trim + lowercase + /^[^\s@]+@[^\s@]+$/)
 * so the client rejects the same inputs the server would; the code rule
 * matches the API's own 6-digit generated codes.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const CODE_PATTERN = /^\d{6}$/;

/** Trim + lowercase like the API; non-strings collapse to "". */
export function normalizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

/**
 * @returns {null | { message: string }} null when the email is valid,
 *   otherwise the message to present under the field.
 */
export function validateEmail(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { message: "请输入邮箱" };
  }
  if (!EMAIL_PATTERN.test(normalizeEmail(raw))) {
    return { message: "邮箱格式不正确" };
  }
  return null;
}

/** @returns {null | { message: string }} null when the code is valid. */
export function validateCode(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { message: "请输入验证码" };
  }
  if (!CODE_PATTERN.test(raw.trim())) {
    return { message: "验证码为 6 位数字" };
  }
  return null;
}
