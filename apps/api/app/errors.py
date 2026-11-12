"""Unified error type + contract error envelope.

Every non-2xx response body is `{"error": {"code", "message"}}` per
contracts/contract-v1.md §1; progress conflicts additionally carry
`current` at the top level, which `extra` accommodates. Message copy is
verbatim from contracts/fixtures/error-examples.json and the Node port
source (lib/errors.js).
"""

from __future__ import annotations

from typing import Any


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def to_body(self) -> dict:
        body: dict[str, Any] = {"error": {"code": self.code, "message": self.message}}
        if self.extra:
            body.update(self.extra)
        return body


def validation_failed(message: str) -> ApiError:
    return ApiError(400, "validation_failed", message)


def unauthorized_missing() -> ApiError:
    return ApiError(401, "unauthorized", "未登录或凭据缺失")


def unauthorized_expired() -> ApiError:
    return ApiError(401, "unauthorized", "凭据已失效，请重新登录并关联")


def not_found_unknown_path() -> ApiError:
    return ApiError(404, "not_found", "未知接口路径")


def not_found_resource() -> ApiError:
    """Cross-account or missing Resource reads (decision D2: always 404)."""
    return ApiError(404, "not_found", "资源不存在或无权访问")


def not_found_source() -> ApiError:
    """Cross-account or missing Source writes (decision D2: always 404)."""
    return ApiError(404, "not_found", "来源不存在或无权访问")


def not_found_session() -> ApiError:
    """Cross-account or missing Session reads/writes (contract-r2 §3; D2)."""
    return ApiError(404, "not_found", "学习记录不存在或无权访问")


def session_already_finished() -> ApiError:
    """Writes against a finished Session (contract-r2 §3.2: repeat finish)."""
    return ApiError(409, "session_already_finished", "本次学习已结束，无需重复收尾")


def method_not_allowed() -> ApiError:
    return ApiError(405, "method_not_allowed", "HTTP 方法不被允许")


def internal_error() -> ApiError:
    return ApiError(500, "internal_error", "服务内部错误")
