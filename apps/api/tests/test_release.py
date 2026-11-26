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
    # 0.2.9: qwen3's default thinking phase is disabled on every product
    # generation (chat_template_kwargs.enable_thinking=false) — reasoning
    # alone on a long merged transcript exceeded the 120s AI timeout
    # (218s observed before the first content token), 502-ing every
    # long-video summary.
    # 0.2.8 fixes the 0.2.7 merge's cluster rule: clustering on ANY overlap
    # collapsed sliding-window caption chunks (~50% pairwise overlap) into
    # one transitive chain, keeping a single record — only near-duplicates
    # (one range covering ≥80% of the other's shorter span) may merge now.
    # 0.2.7: 一份资料只有一份逐字稿 — collect_material clusters overlapping
    # records across a resource's sessions and keeps one copy per range
    # (longest text, captions over asr, smaller sessionId), folding
    # duplicate gaps, so the course-summary prompt no longer carries
    # duplicated transcript text from multi-session re-watching.
    # 0.2.6 hardens the usage ledger against pre-r4 rows (missing newer
    # counters crashed record_*/usage_view with KeyError; with_defaults()
    # backfills on read and the next write upgrades the row).
    # 0.2.5 raises the long-course caption-archive transport cap to 10 MiB.
    # 0.2.4: long-course caption archives use a route-specific 4 MiB body
    # cap rather than the 64 KiB control-plane default. 0.2.3 (ticket 5.8,
    # issue #97): the config-file layer — apps/api/
    # config.json (workerToken/ai*/stateFile/inviteSeed/outboxFile/
    # audioDir; PORT stays script-managed) is the base values layer, env
    # overrides it, built-in defaults fill the rest; invalid JSON fails
    # fast at startup. 0.2.2 (ticket 5.5, issue #94): DELETE
    # /v1/resources/{id} — the resource-delete cascade
    # (sources/progress/notes/sessions/transcripts/sessionInsights/
    # sessionDigests/summaries), usage ledger retained (D23), one-snapshot
    # batch delete in the store. 0.2.1 (round-4/6 review fixes): AI
    # provider timeout reaches httpx in seconds not milliseconds; the four
    # AI-pass routes become def (run in the threadpool instead of
    # serializing the event loop). 0.2.0: the implementation rewrite
    # switchover (Python becomes the sole service-layer implementation,
    # ticket 4.6, issue #82). 0.1.5 (round 3, ticket 3.2 / issue #74):
    # course summary endpoints, AI Provider seam, GET /v1/usage, D18 usage
    # recording. 0.1.6 (round-3 review fixes): per-generate timeout signal
    # + course-summary prompt notes-marker. The contract generation (/v1)
    # is unchanged.
    assert pyproject["project"]["version"] == "0.2.17"
    assert pyproject["project"]["requires-python"] == ">=3.12"


def test_invited_email_seed_file_is_a_json_array():
    seed = json.loads((API_ROOT / "data" / "invites.seed.json").read_text(encoding="utf-8"))
    assert isinstance(seed, list)
