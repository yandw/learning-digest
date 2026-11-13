"""run_loop — the worker main loop (ticket 4.5, decision D13): poll claim,
drain what it gets, sleep when idle, back off on cycle errors. Poll
interval and backoff are configurable (deployment config, not contract).
Ported intent: apps/worker/test/loop.test.js.

Seam: run_loop(client=..., provider=..., sleep_impl=..., max_cycles=...) —
sleep_impl is injected so tests are instant and deterministic; max_cycles
bounds the loop for tests (the production entry runs unbounded)."""

from worker.loop import run_loop


class ScriptedClient:
    """Serves `pages` of claimed tasks, then stays empty."""

    def __init__(self, pages):
        self.pages = pages
        self.page = 0

    def claim(self, limit=None):
        tasks = self.pages[self.page] if self.page < len(self.pages) else []
        self.page += 1
        return {"tasks": tasks}

    def submit_result(self, task_id, body):
        return {"taskId": task_id, "status": body["status"]}


PROVIDER = {
    "id": "stub",
    "transcribe": lambda **kwargs: [{"startMs": 0, "endMs": 1000, "text": "t"}],
}


def task(task_id):
    return {
        "taskId": task_id,
        "sessionId": "s",
        "sourceId": "r",
        "segmentIndex": 0,
        "startMs": 0,
        "endMs": 30000,
        "audioMimeType": "m",
        "audioBase64": "YQ==",
    }


def test_drains_tasks_then_idles_on_the_poll_interval_until_the_budget_ends():
    sleeps = []

    def sleep_impl(ms):
        sleeps.append(ms)

    client = ScriptedClient([[task("tsk_a"), task("tsk_b")]])

    summary = run_loop(
        client=client,
        provider=PROVIDER,
        poll_interval_ms=5000,
        max_cycles=4,
        sleep_impl=sleep_impl,
    )

    assert summary == {"cycles": 4, "done": 2, "failed": 0}
    # After the working cycle the loop polls again immediately; the idle
    # cycles sleep, but the final cycle exits without sleeping.
    assert sleeps == [5000, 5000]


def test_a_cycle_error_logs_and_backs_off_then_keeps_polling():
    sleeps = []
    logs = []
    calls = []

    def sleep_impl(ms):
        sleeps.append(ms)

    class FlakyClient(ScriptedClient):
        def claim(self, limit=None):
            calls.append(self.page)
            if len(calls) == 1:
                raise RuntimeError("api unreachable")
            return {"tasks": []}

    summary = run_loop(
        client=FlakyClient([]),
        provider=PROVIDER,
        poll_interval_ms=5000,
        error_backoff_ms=15000,
        max_cycles=3,
        sleep_impl=sleep_impl,
        log=logs.append,
    )

    assert summary == {"cycles": 3, "done": 0, "failed": 0}
    # The error cycle backs off with the (longer) error interval; the idle
    # cycle sleeps the poll interval.
    assert sleeps == [15000, 5000]
    assert len(logs) == 1
    assert "api unreachable" in logs[0]


def test_provider_level_failures_still_count_as_processed():
    """Task-level, not cycle-level: a failing provider still yields a
    write-back, and the loop keeps polling."""
    client = ScriptedClient([[task("tsk_x")]])

    def failing(**kwargs):
        raise RuntimeError("HTTP 429")

    summary = run_loop(
        client=client,
        provider={"id": "qwen", "transcribe": failing},
        max_cycles=2,
        sleep_impl=lambda ms: None,
    )
    assert summary == {"cycles": 2, "done": 0, "failed": 1}
