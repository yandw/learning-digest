"""Slice 7: the production entrypoint wires FileStore + dev file mailer +
invite seed and listens. Tests drive the real process over loopback. Ported
intent: apps/api/test/server-entry.test.js. Seams: `python -m app.main`
subprocess + loopback HTTP + files it writes (no external network)."""

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx

API_DIR = Path(__file__).resolve().parents[1]


def make_workspace(tmp_path):
    return {
        "dir": str(tmp_path),
        "state_file": str(tmp_path / "data" / "state.json"),
        "outbox_file": str(tmp_path / "data" / "outbox.jsonl"),
        "seed_file": str(tmp_path / "invites.seed.json"),
    }


def start_server(env):
    return subprocess.Popen(
        [sys.executable, "-m", "app.main"],
        cwd=str(API_DIR),
        env={**os.environ, "PORT": "0", **env},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def wait_for_listening(proc, timeout_s=15):
    """Wait for the '[api] listening on port N' line on stdout (the server.js
    contract) and return the port."""
    buffer = {"text": ""}

    def pump():
        for line in proc.stdout:
            buffer["text"] += line
            if match := re.search(r"listening on port (\d+)", buffer["text"]):
                return int(match[1])
        return None

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if match := re.search(r"listening on port (\d+)", buffer["text"]):
            return int(match[1])
        if proc.poll() is not None:
            stderr = proc.stderr.read() if proc.stderr else ""
            raise AssertionError(f"server exited early ({proc.returncode}): {buffer['text']} {stderr}")
        time.sleep(0.05)
    raise AssertionError(f"timeout waiting for listening line: {buffer['text']}")


def test_keep_alive_window_covers_the_synchronous_summary_generation():
    # lib/app.js: server.timeout = max(10_000, aiTimeoutMs + 5_000) — the
    # socket idle window must be wider than the provider timeout so a
    # slow-but-successful synchronous generation (D16, tens of seconds
    # inside the POST) is still deliverable. The uvicorn counterpart is
    # timeout_keep_alive (seconds), fed by the same formula.
    from app.main import keep_alive_seconds

    assert keep_alive_seconds(120_000) == 125.0
    assert keep_alive_seconds(0) == 10.0
    assert keep_alive_seconds(3_000) == 10.0


def test_server_wires_file_store_dev_mailer_and_invite_seed_end_to_end(tmp_path):
    ws = make_workspace(tmp_path)
    with open(ws["seed_file"], "w", encoding="utf-8") as fh:
        json.dump(["entry@example.com"], fh)
    proc = start_server({
        "LD_API_STATE_FILE": ws["state_file"],
        "LD_API_INVITE_SEED": ws["seed_file"],
        "LD_API_OUTBOX_FILE": ws["outbox_file"],
    })
    try:
        port = wait_for_listening(proc)
        base = f"http://127.0.0.1:{port}"

        # Unknown path still speaks the contract envelope.
        with httpx.Client(base_url=base, timeout=5) as client:
            unknown = client.get("/v1/nope")
            assert unknown.status_code == 404
            assert unknown.json() == {"error": {"code": "not_found", "message": "未知接口路径"}}

            # Invited email flows through the real process into the outbox file.
            request_code = client.post("/v1/auth/request-code", json={"email": "entry@example.com"})
            assert request_code.status_code == 200

        with open(ws["outbox_file"], encoding="utf-8") as fh:
            lines = fh.read().strip().split("\n")
        mail = json.loads(lines[-1])
        assert mail["to"] == "entry@example.com"
        assert len(mail["code"]) == 6 and mail["code"].isdigit()

        # State is persisted to the configured file.
        with open(ws["state_file"], encoding="utf-8") as fh:
            state = json.load(fh)
        assert state["invites"]["entry@example.com"]
        assert state["verificationCodes"]["entry@example.com"]
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
