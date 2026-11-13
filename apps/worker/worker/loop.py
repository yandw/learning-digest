"""Worker main loop (ticket 4.5; Node ticket 2.3, lib/loop.js; decision
D13: pull model, no push, no heartbeat). Poll -> runOnce -> sleep while
idle; cycle errors (API unreachable, credential rejected) log and back
off; task errors never reach the loop (runOnce turns them into result
write-backs).

Poll interval and error backoff are deployment config, not contract
constants. max_cycles/sleep_impl are test seams — the production entry
runs unbounded with the real timer."""

from __future__ import annotations

import math
import time
from typing import Any, Callable

from .run_once import run_once


def _sleep_wall(ms: float) -> None:
    time.sleep(ms / 1000)


def run_loop(
    *,
    client: Any,
    provider: Any,
    poll_interval_ms: float = 5000,
    error_backoff_ms: float | None = None,
    log: Callable[[str], None] = lambda line: None,
    max_cycles: float = math.inf,
    sleep_impl: Callable[[float], None] | None = None,
) -> dict[str, int]:
    sleep = sleep_impl or _sleep_wall
    backoff = error_backoff_ms or poll_interval_ms

    cycles = 0
    done = 0
    failed = 0
    while cycles < max_cycles:
        cycles += 1
        try:
            summary = run_once(client=client, provider=provider)
        except Exception as error:
            message = str(error) or type(error).__name__
            log(f"[worker] cycle failed: {message}; retrying in {backoff}ms")
            if cycles < max_cycles:
                sleep(backoff)
            continue
        done += summary["done"]
        failed += summary["failed"]
        if summary["claimed"] == 0 and cycles < max_cycles:
            sleep(poll_interval_ms)
    return {"cycles": cycles, "done": done, "failed": failed}
