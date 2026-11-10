import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, validateEmail, validateCode } from "../public/js/validation.js";

// Form validation for the login flow (pure module — the page binds it).
// Email rules mirror apps/api: trim + lowercase, /^[^\s@]+@[^\s@]+$/. Code
// rules mirror the API's own generated codes: exactly 6 digits.

test("normalizeEmail trims and lowercases like the API", () => {
  assert.equal(normalizeEmail("  Learner@Example.COM "), "learner@example.com");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(undefined), "");
});

test("valid emails pass with no error", () => {
  assert.equal(validateEmail("learner@example.com"), null);
  assert.equal(validateEmail("  LEARNER@Example.COM "), null);
});

test("empty email asks for an address", () => {
  assert.deepEqual(validateEmail(""), { message: "请输入邮箱" });
  assert.deepEqual(validateEmail("   "), { message: "请输入邮箱" });
  assert.deepEqual(validateEmail(undefined), { message: "请输入邮箱" });
});

test("non-email-shaped input matches the API's wording", () => {
  assert.deepEqual(validateEmail("not-an-email"), { message: "邮箱格式不正确" });
  assert.deepEqual(validateEmail("a@b c"), { message: "邮箱格式不正确" });
  assert.deepEqual(validateEmail("@example.com"), { message: "邮箱格式不正确" });
});

test("6-digit codes pass with no error", () => {
  assert.equal(validateCode("000000"), null);
  assert.equal(validateCode(" 654321 "), null);
});

test("empty code asks for the code", () => {
  assert.deepEqual(validateCode(""), { message: "请输入验证码" });
  assert.deepEqual(validateCode("  "), { message: "请输入验证码" });
});

test("codes that are not exactly 6 digits are rejected", () => {
  assert.deepEqual(validateCode("12345"), { message: "验证码为 6 位数字" });
  assert.deepEqual(validateCode("1234567"), { message: "验证码为 6 位数字" });
  assert.deepEqual(validateCode("12 456"), { message: "验证码为 6 位数字" });
  assert.deepEqual(validateCode("12ab56"), { message: "验证码为 6 位数字" });
});
