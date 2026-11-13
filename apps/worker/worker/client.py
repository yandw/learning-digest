"""Worker API client (ticket 4.5; Node ticket 2.3, lib/client.js;
contract-r2 §3.7): the two worker endpoints with the service credential
attached. httpx with an injectable transport — no network in tests.
Non-2xx answers raise with status + error code so the loop's log carries
something triageable."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

import httpx


def _parse_json(raw: str) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


class WorkerClient:
    def __init__(self, http: httpx.Client):
        self._http = http

    def _request(self, path: str, body: Any) -> Any:
        response = self._http.post(
            path,
            headers={"Content-Type": "application/json"},
            json=body,
        )
        raw = response.text
        parsed = _parse_json(raw)
        if not 200 <= response.status_code < 300:
            error = parsed.get("error") if isinstance(parsed, dict) else None
            if error:
                code = error.get("code", "unknown")
                message = error.get("message", raw[:200])
            else:
                code, message = "unknown", raw[:200]
            raise RuntimeError(
                f"API {path} failed with HTTP {response.status_code} ({code}): {message}"
            )
        return parsed

    def claim(self, limit: int | None = None) -> Any:
        """POST /v1/worker/tasks/claim -> { tasks: [Task] }"""
        return self._request("/v1/worker/tasks/claim", {"limit": limit or 1})

    def submit_result(self, task_id: str, body: Any) -> Any:
        """POST /v1/worker/tasks/{id}/result -> { taskId, status }"""
        return self._request(f"/v1/worker/tasks/{quote(task_id, safe='')}/result", body)


def create_worker_client(
    *, api_base: str, token: str, transport: httpx.BaseTransport | None = None
) -> WorkerClient:
    """api_base like "http://127.0.0.1:8787" (no trailing slash); token is
    the worker service credential (Bearer)."""
    base = str(api_base or "").rstrip("/") if api_base else ""
    http = httpx.Client(
        base_url=base,
        headers={"Authorization": f"Bearer {token}"},
        transport=transport,
    )
    return WorkerClient(http)
