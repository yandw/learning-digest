"""scripts/dev.sh status must see through service launcher wrappers.

`uv run python -m app.main` leaves the `uv` wrapper as the command-line match
while the real API listener is its child
(`apps/api/.venv/bin/python3 -m app.main`). The status probe must inspect the
launcher's descendants instead of requiring the matched process itself to own
the listening socket. The fixture stubs only pgrep/lsof and runs the real
dev.sh status path with an isolated LD_DEV_RUN_DIR; no real service is touched.
"""

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEV_SCRIPT = REPO_ROOT / "scripts" / "dev.sh"


def write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def fake_bin(tmp_path: Path) -> Path:
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()

    # PID 500 is the uv-compatible API launcher; PID 501 is its child and
    # actual listener. PID 600/601 model the equivalent Worker process tree.
    write_executable(
        bin_dir / "pgrep",
        """#!/bin/sh
case " $* " in
  *" -P 600 "*) echo 601 ;;
  *" -P 500 "*) echo 501 ;;
  *"worker.main"*) echo 600 ;;
  *"app.main"*) echo 500 ;;
esac
exit 0
""",
    )
    write_executable(
        bin_dir / "lsof",
        """#!/bin/sh
pid=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-p" ]; then
    pid="$arg"
  fi
  prev="$arg"
done
case " $* " in
  *" -d cwd "*)
    case "$pid" in
      600|601) echo "n$PWD/apps/worker" ;;
      *) echo "n$PWD/apps/api" ;;
    esac
    ;;
  *" -iTCP "*)
    if [ "$pid" = "501" ]; then
      echo "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME"
      echo "python3 501 atom 3u IPv4 0x0 0t0 TCP *:8787 (LISTEN)"
    fi
    ;;
esac
exit 0
""",
    )
    return bin_dir


def test_status_finds_api_listener_on_launcher_child(tmp_path):
    env = {
        **os.environ,
        "PATH": f"{fake_bin(tmp_path)}:{os.environ['PATH']}",
        "LD_DEV_RUN_DIR": str(tmp_path / "run"),
    }
    result = subprocess.run(
        ["bash", str(DEV_SCRIPT), "status"],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "api    :8787  RUNNING(运行中)" in result.stdout
    assert "worker : RUNNING(运行中)" in result.stdout
