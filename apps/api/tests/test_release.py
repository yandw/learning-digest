"""Release metadata for the API unit (AGENTS.md: the API's first runnable
version started at 0.1.0 in its own release metadata; the root 0.2.0
belongs to the Chrome extension and is not touched from here). Ported
intent: apps/api/test/release.test.js — since the ticket-4.6 switchover
(#82) the authoritative release metadata is pyproject.toml itself (the
Node package.json is retired). Also pins the invited-email seed file
shape, which the API loads at startup."""

import json
import pathlib
import tomllib

API_ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_pyproject_is_the_api_unit_release_metadata():
    pyproject = tomllib.loads((API_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["project"]["name"] == "learning-digest-api"
    # 0.2.0: the implementation rewrite switchover (Python becomes the sole
    # service-layer implementation, ticket 4.6, issue #82). 0.1.5 (round 3,
    # ticket 3.2 / issue #74): course summary endpoints, AI Provider seam,
    # GET /v1/usage, D18 usage recording. 0.1.6 (round-3 review fixes):
    # per-generate timeout signal + course-summary prompt notes-marker.
    # The contract generation (/v1) is unchanged.
    assert pyproject["project"]["version"] == "0.2.0"
    assert pyproject["project"]["requires-python"] == ">=3.12"


def test_invited_email_seed_file_is_a_json_array():
    seed = json.loads((API_ROOT / "data" / "invites.seed.json").read_text(encoding="utf-8"))
    assert isinstance(seed, list)
