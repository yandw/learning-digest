"""Production entrypoint for the Learning Digest worker. Port of
worker.js (ticket 4.5). One runtime dependency: httpx.

Run: python -m worker.main

Environment (see worker/config.py for the full list):
  LD_WORKER_API_BASE          API base (default http://127.0.0.1:8787)
  LD_WORKER_TOKEN             worker service credential (required for the
                              real API; empty -> claim answers 401)
  LD_WORKER_PROVIDER          stub | qwen (default stub)
  QWEN_API_KEY                Bailian key for the qwen provider

Pull model (D13): the loop polls POST /v1/worker/tasks/claim, drains
claimed tasks serially (concurrency 1), and idles pollIntervalMs between
empty polls. Ctrl-C stops it; a claimed-but-unfinished task is re-claimable
after a lease mechanism lands (API-side, not this ticket)."""

from __future__ import annotations

import os
import sys
from typing import Any

from .client import create_worker_client
from .config import create_provider_from_config, load_worker_config
from .loop import run_loop


def main(env: dict[str, str] | None = None) -> Any:
    env = os.environ if env is None else env
    config = load_worker_config(env)
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
