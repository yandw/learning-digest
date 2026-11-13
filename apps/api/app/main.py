"""Production entrypoint for the Python API. Port of server.js onto uvicorn.

Run: python -m app.main

Environment (same names and meanings as the Node server.js):
  PORT                  listen port (default 8787; 0 = ephemeral)
  LD_API_STATE_FILE     embedded store file (default data/state.json)
  LD_API_INVITE_SEED    invited-email seed file (default data/invites.seed.json)
  LD_API_OUTBOX_FILE    dev-mailer JSONL outbox (default data/outbox.jsonl)
  LD_API_WORKER_TOKEN   worker service credential (round-2 endpoints; the
                        Python side accepts it into config until those
                        domains land in a later round-4 ticket)
  LD_API_AUDIO_DIR      temp audio directory for uploaded segments (D14)
  LD_AI_PROVIDER        AI Provider for course summaries (D16)
  LD_AI_API_KEY         provider API key (separate from the worker's
                        speech credentials, D16)
  LD_AI_MODEL           model override
  LD_AI_BASE_URL        endpoint override
  LD_AI_TIMEOUT_MS      per-generation timeout (default 120000)

The real email service account is undecided (decision 3 note): until it
exists, codes are delivered by the dev mailer to the outbox file and
stdout. Swapping in a real Mailer means passing a different `mailer` into
create_app — no route or storage changes.
"""

from __future__ import annotations

import os
import socket
import sys
import tempfile

import uvicorn


def _parse_int(value: str | None, fallback: int) -> int:
    try:
        return int(value or "")
    except ValueError:
        return fallback


def keep_alive_seconds(ai_timeout_ms: int) -> float:
    """Socket idle window for uvicorn's timeout_keep_alive — the port of
    lib/app.js's server.timeout raise: max(10s, aiTimeoutMs + 5s). The AI
    call happens inside the POST (synchronous generation, D16); the idle
    window must be wider than the provider timeout so a slow-but-successful
    generation is still deliverable."""
    return max(10.0, ai_timeout_ms / 1000 + 5.0)


def build_app(env: dict):
    from .app_factory import create_app
    from .mailer import create_dev_mailer
    from .persistence import create_file_store

    package_dir = os.path.dirname(os.path.abspath(__file__))
    api_dir = os.path.dirname(package_dir)
    state_file = env.get("LD_API_STATE_FILE") or os.path.join(api_dir, "data", "state.json")
    seed_file = env.get("LD_API_INVITE_SEED") or os.path.join(api_dir, "data", "invites.seed.json")
    out_file = env.get("LD_API_OUTBOX_FILE") or os.path.join(api_dir, "data", "outbox.jsonl")

    store = create_file_store({"file": state_file})
    mailer = create_dev_mailer(out_file=out_file)
    return create_app(
        store=store,
        mailer=mailer,
        seed_file=seed_file,
        config={
            "worker_token": env.get("LD_API_WORKER_TOKEN") or "",
            "audio_dir": env.get("LD_API_AUDIO_DIR")
            or os.path.join(tempfile.gettempdir(), "ld-api-audio"),
            "ai_provider_name": env.get("LD_AI_PROVIDER") or "",
            "ai_api_key": env.get("LD_AI_API_KEY") or "",
            "ai_model": env.get("LD_AI_MODEL") or "",
            "ai_base_url": env.get("LD_AI_BASE_URL") or "",
            "ai_timeout_ms": _parse_int(env.get("LD_AI_TIMEOUT_MS"), 120_000),
        },
    )


def main(env: dict | None = None) -> None:
    env = dict(os.environ if env is None else env)
    app = build_app(env)
    port = _parse_int(env.get("PORT"), 8787)

    # Bind before printing so PORT=0 reports the real port (server.js
    # prints server.address().port from the listen callback).
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    sock.listen()
    sys.stdout.write(f"[api] listening on port {sock.getsockname()[1]}\n")
    sys.stdout.flush()

    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_config=None,
            access_log=False,
            lifespan="on",
            # Synchronous summary generation (D16) awaits the AI Provider
            # inside the POST; keep the socket's idle window wider than the
            # provider timeout so a slow-but-successful generation is still
            # deliverable (lib/app.js server.timeout, mirrored).
            timeout_keep_alive=keep_alive_seconds(app.state.ctx.config.ai_timeout_ms),
        )
    )
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
