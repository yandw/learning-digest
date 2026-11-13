"""Release metadata for the worker unit (AGENTS.md: apps/worker is the
fourth release unit; its first runnable version starts at 0.1.0). Ported
intent: apps/worker/test/release.test.js — on the Python side this pins
the pyproject mirror: uv requires a version field, so pyproject.toml must
move in lockstep with the unit's authoritative package.json until ticket
4.6 moves the release version (same convention as apps/api/pyproject.toml)."""

import json
import pathlib
import tomllib

WORKER_ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_pyproject_mirrors_the_worker_unit_release_metadata():
    package_json = json.loads((WORKER_ROOT / "package.json").read_text(encoding="utf-8"))
    pyproject = tomllib.loads((WORKER_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert package_json["name"] == "@learning-digest/worker"
    # 0.1.0: the first runnable worker (Node ticket 2.3, issue #66; Python
    # port ticket 4.5, issue #81).
    assert package_json["version"] == "0.1.0"
    assert pyproject["project"]["name"] == "learning-digest-worker"
    assert pyproject["project"]["version"] == package_json["version"]
    assert pyproject["project"]["requires-python"] == ">=3.12"


def test_python_side_ships_only_the_declared_runtime_dependency():
    """The Node release test pins zero npm dependencies; the Python side's
    runtime surface is exactly httpx (pytest is dev-only)."""
    pyproject = tomllib.loads((WORKER_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["dependencies"] == ["httpx>=0.27"]
    assert pyproject["dependency-groups"]["dev"] == ["pytest>=8"]
