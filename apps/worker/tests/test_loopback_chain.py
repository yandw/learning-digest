"""Loopback chain (ticket 4.5 acceptance): public session flow -> audio
upload -> worker claim -> stub Speech Provider -> result write-back -> GET
transcript shows the archive. Ported intent:
apps/api/test/audio-chain.test.js — the worker runs through its REAL
client + stub provider + run loop over loopback HTTP against the real
Python API, started as a subprocess (same pattern as
apps/api/tests/test_server_entry.py). No external network; the stub
provider keeps it repeatable. The end state is observed through the
public TranscriptView seam (GET /v1/sessions/{id}/transcript) and the
audio directory (D14), never store internals."""

import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

import httpx

from worker.client import create_worker_client
from worker.loop import run_loop
from worker.providers.stub import create_stub_provider

WORKER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKER_DIR.parents[1]
API_DIR = REPO_ROOT / "apps" / "api"
FIXTURES_DIR = REPO_ROOT / "contracts" / "fixtures"

EMAIL = "chain-py@example.com"
WORKER_TOKEN = "chain-py-worker-token"


def audio_example(example_id: str) -> dict:
    with open(FIXTURES_DIR / "audio-task-examples.json", encoding="utf-8") as fh:
        samples = json.load(fh)["samples"]
    return next(s for s in samples if s["id"] == example_id)


SEGMENT_BODIES = {
    1: audio_example("api-audio-segment-upload")["request"]["body"],
    2: audio_example("api-audio-segment-upload-second")["request"]["body"],
    3: audio_example("api-audio-segment-out-of-order")["request"]["body"],
}


class ChainApp:
    """One real API subprocess + one opened account with a session on its
    own fixture source, and the worker's real client pointed at it."""

    def __init__(self, tmp_path: Path):
        self.audio_dir = tmp_path / "audio"
        seed_file = tmp_path / "invites.seed.json"
        seed_file.write_text(json.dumps([EMAIL]), encoding="utf-8")
        self.proc = subprocess.Popen(
            [
                "uv",
                "run",
                "--project",
                str(API_DIR),
                "python",
                "-m",
                "app.main",
            ],
            cwd=str(API_DIR),
            env={
                **os.environ,
                "PORT": "0",
                "LD_API_STATE_FILE": str(tmp_path / "state.json"),
                "LD_API_INVITE_SEED": str(seed_file),
                "LD_API_OUTBOX_FILE": str(tmp_path / "outbox.jsonl"),
                "LD_API_WORKER_TOKEN": WORKER_TOKEN,
                "LD_API_AUDIO_DIR": str(self.audio_dir),
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.outbox_file = tmp_path / "outbox.jsonl"
        self.port = self._wait_for_listening()
        self.base = f"http://127.0.0.1:{self.port}"
        self.client = create_worker_client(api_base=self.base, token=WORKER_TOKEN)

    def _wait_for_listening(self, timeout_s: float = 20.0) -> int:
        """Wait for the '[api] listening on port N' line (the server.js
        contract) and return the port."""
        buffer = {"text": "", "stderr": ""}

        def pump():
            for line in self.proc.stdout:
                buffer["text"] += line

        def drain_stderr():
            # uv sync noise and server errors; read on early exit below.
            for line in self.proc.stderr:
                buffer["stderr"] += line

        threading.Thread(target=pump, daemon=True).start()
        threading.Thread(target=drain_stderr, daemon=True).start()
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            if match := re.search(r"listening on port (\d+)", buffer["text"]):
                return int(match[1])
            if self.proc.poll() is not None:
                raise AssertionError(
                    f"api exited early ({self.proc.returncode}): "
                    f"{buffer['text']} {buffer['stderr']}"
                )
            time.sleep(0.05)
        raise AssertionError(f"timeout waiting for listening line: {buffer['text']}")

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            self.proc.kill()
            self.proc.wait(timeout=5)

    # -- public HTTP flow -------------------------------------------------

    def open_account_with_session(self) -> dict:
        with httpx.Client(base_url=self.base, timeout=5) as http:
            requested = http.post("/v1/auth/request-code", json={"email": EMAIL})
            assert requested.status_code == 200
            with open(self.outbox_file, encoding="utf-8") as fh:
                mail = json.loads(fh.read().strip().split("\n")[-1])
            verified = http.post(
                "/v1/auth/verify", json={"email": EMAIL, "code": mail["code"]}
            )
            assert verified.status_code in (200, 201)
            token = verified.json()["credential"]["token"]
            headers = {"Authorization": f"Bearer {token}"}

            created = http.post(
                "/v1/resources",
                headers=headers,
                json={
                    "url": "https://www.bilibili.com/video/BV1ab411L78c?p=2",
                    "title": "注意力机制详解 P2：自注意力（chain-py）",
                },
            )
            assert created.status_code == 201
            session = http.post(
                f"/v1/sources/{created.json()['source']['id']}/sessions",
                headers=headers,
                json={},
            )
            assert session.status_code == 201
            return {
                "token": token,
                "sourceId": created.json()["source"]["id"],
                "session": session.json()["session"],
            }

    def upload(self, account: dict, segment_index: int) -> httpx.Response:
        return httpx.post(
            f"{self.base}/v1/sessions/{account['session']['id']}/audio-segments",
            headers={"Authorization": f"Bearer {account['token']}"},
            json=SEGMENT_BODIES[segment_index],
            timeout=5,
        )

    def transcript(self, account: dict) -> dict:
        response = httpx.get(
            f"{self.base}/v1/sessions/{account['session']['id']}/transcript",
            headers={"Authorization": f"Bearer {account['token']}"},
            timeout=5,
        )
        assert response.status_code == 200
        return response.json()

    def audio_files(self) -> int:
        if not self.audio_dir.exists():
            return 0
        return len(list(self.audio_dir.iterdir()))


def test_out_of_order_upload_worker_drains_all_segments_transcript_shows_archive(tmp_path):
    chain = ChainApp(tmp_path)
    try:
        account = chain.open_account_with_session()
        # Out of order: 3, 1, 2 — the server places them by segmentIndex.
        for index in [3, 1, 2]:
            response = chain.upload(account, index)
            assert response.status_code == 201

        # Mid-flight: the view shows all three segments pending.
        mid_view = chain.transcript(account)
        assert [p["segmentIndex"] for p in mid_view["pending"]] == [1, 2, 3]
        assert mid_view["origin"] == "asr"

        # The worker drains three tasks (limit 1 per cycle) plus one idle
        # poll, through its real client + the stub provider.
        summary = run_loop(
            client=chain.client,
            provider=create_stub_provider(),
            poll_interval_ms=1,
            max_cycles=4,
        )
        assert summary == {"cycles": 4, "done": 3, "failed": 0}

        # The public transcript view now carries the whole archive, records
        # sorted by startMs, nothing pending, nothing failed.
        view = chain.transcript(account)
        assert view["sessionId"] == account["session"]["id"]
        assert view["sourceId"] == account["sourceId"]
        assert view["sessionStatus"] == "active"
        assert view["origin"] == "asr"
        assert [
            {"startMs": r["startMs"], "endMs": r["endMs"], "text": r["text"], "origin": r["origin"]}
            for r in view["records"]
        ] == [
            {"startMs": 30000, "endMs": 60000, "text": "stub 转写文本（第 1 段）", "origin": "asr"},
            {"startMs": 60000, "endMs": 90000, "text": "stub 转写文本（第 2 段）", "origin": "asr"},
            {"startMs": 90000, "endMs": 120000, "text": "stub 转写文本（第 3 段）", "origin": "asr"},
        ]
        assert view["pending"] == []
        assert view["failed"] == []
        assert view["gaps"] == []

        # D14: every done task's audio file is gone.
        assert chain.audio_files() == 0

        # The queue is drained: another claim gets the empty state.
        drained = chain.client.claim(limit=1)
        assert drained == {"tasks": []}
    finally:
        chain.close()


def test_a_failing_provider_writes_failed_feedback_into_the_view_and_keeps_audio(tmp_path):
    chain = ChainApp(tmp_path)
    try:
        account = chain.open_account_with_session()
        response = chain.upload(account, 1)
        assert response.status_code == 201

        def failing(**kwargs):
            raise RuntimeError("Speech Provider 返回 429，重试后仍失败")

        summary = run_loop(
            client=chain.client,
            provider={"id": "stub", "transcribe": failing},
            poll_interval_ms=1,
            max_cycles=2,
        )
        assert summary == {"cycles": 2, "done": 0, "failed": 1}

        view = chain.transcript(account)
        assert view["failed"] == [
            {
                "segmentIndex": 1,
                "startMs": 30000,
                "endMs": 60000,
                "error": {
                    "code": "transcription_failed",
                    "message": "Speech Provider 返回 429，重试后仍失败",
                },
            }
        ]
        assert view["records"] == []
        assert view["pending"] == []

        # D14: failed audio is retained.
        assert chain.audio_files() == 1
    finally:
        chain.close()


def test_a_silence_segment_flows_through_as_done_with_no_records(tmp_path):
    chain = ChainApp(tmp_path)
    try:
        account = chain.open_account_with_session()
        # Normal audio upload; the provider just finds no speech in it
        # (contract-r2 §3.7: records: [] written back is still done).
        response = chain.upload(account, 1)
        assert response.status_code == 201

        summary = run_loop(
            client=chain.client,
            provider={"id": "stub", "transcribe": lambda **kwargs: []},
            poll_interval_ms=1,
            max_cycles=2,
        )
        assert summary == {"cycles": 2, "done": 1, "failed": 0}

        view = chain.transcript(account)
        assert view["records"] == []
        assert view["pending"] == []
        assert view["failed"] == []

        # D14: the done task's audio file is gone.
        assert chain.audio_files() == 0
    finally:
        chain.close()
