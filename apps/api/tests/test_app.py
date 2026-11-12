"""Slice 1: the app skeleton speaks the shared contract's error envelope on
every non-2xx response ({ error: { code, message } }), and unknown paths fail
closed with 404 not_found. Ported intent: apps/api/test/app.test.js.

Seam: the HTTP boundary of the FastAPI app factory, exercised through the
in-process ASGI harness (conftest.start_app) — no sockets, no network.
"""

import pytest


def test_unknown_v1_path_returns_404_with_contract_envelope(start_app):
    app = start_app()
    response = app.request("GET", "/v1/does-not-exist")
    assert response.status == 404
    assert response.headers["content-type"] == "application/json"
    assert response.json == {
        "error": {"code": "not_found", "message": "未知接口路径"},
    }


def test_path_outside_v1_is_also_a_404_with_same_envelope(start_app):
    app = start_app()
    response = app.request("GET", "/healthz")
    assert response.status == 404
    assert response.json == {
        "error": {"code": "not_found", "message": "未知接口路径"},
    }
