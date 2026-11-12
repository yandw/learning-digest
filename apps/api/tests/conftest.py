"""Test harness for the Python API — mirrors test/helpers/harness.js.

Starts the FastAPI app in-process (ASGI via starlette TestClient, no
sockets, no external network) with every seam injected:

- store:  generic collection store (default: temp-file FileStore)
- mailer: dev/memory mailer (default: memory spy)
- now:    injectable clock in ms epoch, for expiry/cooldown determinism
- config: config overrides over the defaults
- seed:   invited-email seed file loaded at startup
"""

import json
import os
import tempfile
from dataclasses import dataclass
from typing import Any

import pytest
from starlette.testclient import TestClient

_UNSET = object()


def make_temp_dir(prefix: str = "ld-api-test-") -> str:
    return tempfile.mkdtemp(prefix=prefix)


def write_seed_file(emails: list[str], directory: str | None = None) -> str:
    """Write an invited-emails seed file (JSON array) and return its path."""
    directory = directory or make_temp_dir("ld-api-seed-")
    path = os.path.join(directory, "invites.seed.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(emails, fh, ensure_ascii=False, indent=2)
    return path


@dataclass
class Response:
    status: int
    headers: Any
    text: str
    json: Any


@dataclass
class TestApp:
    store: Any
    mailer: Any
    app: Any
    client: TestClient

    def request(
        self,
        method: str,
        path: str,
        body: Any = _UNSET,
        headers: dict[str, str] | None = None,
    ) -> Response:
        request_headers = dict(headers or {})
        kwargs: dict[str, Any] = {"headers": request_headers}
        if body is not _UNSET:
            if isinstance(body, (str, bytes)):
                kwargs["content"] = body
            else:
                kwargs["content"] = json.dumps(body, ensure_ascii=False)
                kwargs["headers"] = {**request_headers, "Content-Type": "application/json"}
        raw = self.client.request(method, path, **kwargs)
        try:
            parsed = raw.json()
        except Exception:
            parsed = None
        return Response(status=raw.status_code, headers=raw.headers, text=raw.text, json=parsed)

    def close(self) -> None:
        self.client.close()


@pytest.fixture
def start_app():
    created: list[TestApp] = []

    def _start(
        seed_file: str | None = None,
        seed_emails: list[str] | None = None,
        store: Any = None,
        mailer: Any = None,
        now: Any = None,
        config: dict | None = None,
    ) -> TestApp:
        from app.app_factory import create_app
        from app.mailer import create_memory_mailer
        from app.persistence import create_file_store

        if seed_emails is not None:
            seed_file = write_seed_file(seed_emails)
        store = store or create_file_store({"file": os.path.join(make_temp_dir(), "state.json")})
        mailer = mailer or create_memory_mailer()
        app = create_app(store=store, mailer=mailer, now=now, config=config, seed_file=seed_file)
        client = TestClient(app)
        instance = TestApp(store=store, mailer=mailer, app=app, client=client)
        created.append(instance)
        return instance

    yield _start

    for instance in created:
        instance.close()
