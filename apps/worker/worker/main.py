"""Production entrypoint for the Learning Digest worker. Port of
worker.js (ticket 4.5). One runtime dependency: httpx.

Run: python -m worker.main

Configuration (ticket 5.8, issue #97): apps/worker/config.json (see
config.example.json) holds the base values; environment variables override
them; built-in defaults fill the rest. A missing config file is fine.

Environment (see worker/config.py for the full list):
  LD_WORKER_API_BASE          API base (default http://127.0.0.1:8787)
  LD_WORKER_TOKEN             worker service credential (required for the
                              real API; empty -> claim answers 401)
  LD_WORKER_PROVIDER          stub | qwen | local (default stub)
  QWEN_API_KEY                Bailian key for the qwen provider
  LD_WORKER_LOCAL_*           self-hosted / LAN ASR service wiring for the
                              local provider (BASE_URL required, fail fast
                              without it; ticket 5.1, issue #83)

Pull model (D13): the loop polls POST /v1/worker/tasks/claim, drains
claimed tasks serially (concurrency 1), and idles pollIntervalMs between
empty polls. Ctrl-C stops it; a claimed-but-unfinished task is re-claimable
after a lease mechanism lands (API-side, not this ticket)."""

from __future__ import annotations

import os
import sys
from typing import Any

from .client import create_worker_client
from .config import (
    DEFAULT_CONFIG_FILE,
    create_provider_from_config,
    load_worker_config,
)
from .loop import run_loop


def main(env: dict[str, str] | None = None) -> Any:
    env = os.environ if env is None else env
    config = load_worker_config(env, config_file=DEFAULT_CONFIG_FILE)
    provider = create_provider_from_config(config)
    client = create_worker_client(api_base=config["apiBase"], token=config["token"])

    sys.stdout.write(
        f"[worker] provider={config['provider']} api={config['apiBase']} poll={config['pollIntervalMs']}ms\n"
    )
    sys.stdout.flush()
    return run_loop(
        client=client,
        provider=provider,
        poll_interval_ms=config["pollIntervalMs"],
        error_backoff_ms=config["errorBackoffMs"],
        log=lambda line: (sys.stdout.write(f"{line}\n"), sys.stdout.flush()),
    )


if __name__ == "__main__":
    main()
