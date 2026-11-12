"""Request-body models for the /v1 auth endpoints. The contract's field
messages are exact copy (缺少必填字段 … / 邮箱格式不正确), so validators
mirror lib/routes.js's requireEmail/verify checks instead of relying on
pydantic's default error copy. Non-object bodies (arrays, strings, null)
collapse to an empty object first — lib/routes.js answers the
missing-field error for those shapes, and so do we."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from .errors import validation_failed
from .invites import normalize_email


def validate_email_field(value: Any) -> str:
    """lib/routes.js requireEmail: missing/null/empty string answer the
    missing-field error; any other non-string or non-email-shaped value
    answers the format error (normalizeEmail's verdict)."""
    if value is None or value == "":
        raise validation_failed("缺少必填字段 email")
    normalized = normalize_email(value)
    if not normalized:
        raise validation_failed("邮箱格式不正确")
    return normalized


def validate_code_field(value: Any) -> str:
    """lib/routes.js verify: code may be any scalar (Node stringifies it);
    missing/null/blank-after-trim answer the missing-field error."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        raise validation_failed("缺少必填字段 code")
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    # Node's String([]) is "" (missing) and String({}) is "[object Object]";
    # both shapes are nonsense input — we answer the missing-field error.
    raise validation_failed("缺少必填字段 code")


class RequestCodeBody(BaseModel):
    model_config = ConfigDict(extra="ignore", validate_default=True)

    email: str = ""

    @field_validator("email", mode="before")
    @classmethod
    def _email(cls, value: Any) -> str:
        return validate_email_field(value)


class VerifyBody(BaseModel):
    model_config = ConfigDict(extra="ignore", validate_default=True)

    email: str = ""
    code: str = ""

    @field_validator("email", mode="before")
    @classmethod
    def _email(cls, value: Any) -> str:
        return validate_email_field(value)

    @field_validator("code", mode="before")
    @classmethod
    def _code(cls, value: Any) -> str:
        return validate_code_field(value)


class LinkBody(BaseModel):
    model_config = ConfigDict(extra="ignore", validate_default=True)

    code: str = ""

    @field_validator("code", mode="before")
    @classmethod
    def _code(cls, value: Any) -> str:
        return validate_code_field(value)
