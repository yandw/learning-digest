"""Release metadata for the worker unit (AGENTS.md: apps/worker is the
fourth release unit; its first runnable version started at 0.1.0). Ported
intent: apps/worker/test/release.test.js — since the ticket-4.6 switchover
(#82) the authoritative release metadata is pyproject.toml itself (the
Node package.json is retired; the former pyproject-mirrors-package.json
convention is gone with it)."""

import pathlib
import tomllib

WORKER_ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_pyproject_is_the_worker_unit_release_metadata():
    pyproject = tomllib.loads((WORKER_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["project"]["name"] == "learning-digest-worker"
    # 0.2.1: the local Speech Provider (self-hosted / LAN ASR, ticket 5.1,
    # issue #83). 0.2.0 was the implementation rewrite switchover (Python
    # becomes the sole service-layer implementation, ticket 4.6, issue #82;
    # first runnable worker 0.1.0 = Node ticket 2.3, issue #66; Python port
    # 4.5, #81). The contract generation (/v1) is unchanged.
    assert pyproject["project"]["version"] == "0.2.1"
    assert pyproject["project"]["requires-python"] == ">=3.12"


def test_python_side_ships_only_the_declared_runtime_dependency():
    """The Node release test pinned zero npm dependencies; the Python
    side's runtime surface is exactly httpx (pytest is dev-only)."""
    pyproject = tomllib.loads((WORKER_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["dependencies"] == ["httpx>=0.27"]
    assert pyproject["dependency-groups"]["dev"] == ["pytest>=8"]
