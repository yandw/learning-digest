"""Production entrypoint for the Python API. Port of server.js onto uvicorn.

Run: python -m app.main

Configuration (ticket 5.8, issue #97): apps/api/config.json (see
config.example.json) holds the base values; environment variables override
them; built-in defaults fill the rest. A missing config file is fine. The
listen port is not a config-file field — scripts/dev.sh manages it.

Environment (same names and meanings as the Node server.js):
  PORT                  listen port (default 8787; 0 = ephemeral)
  LD_API_STATE_FILE     embedded store file (default data/state.json)
  LD_API_INVITE_SEED    invited-email seed file (default data/invites.seed.json)
  LD_API_OUTBOX_FILE    dev-mailer JSONL outbox (default data/outbox.jsonl)
  LD_API_WORKER_TOKEN   worker service credential (round-2 endpoints)
  LD_API_AUDIO_DIR      temp audio directory for uploaded segments (D14)
  LD_AI_PROVIDER        AI Provider for course summaries (D16)
  LD_AI_API_KEY         provider API key (separate from the worker's
                        speech credentials, D16)
  LD_AI_MODEL           model override
  LD_AI_BASE_URL        endpoint override
  LD_AI_TIMEOUT_MS      per-generation timeout (default 120000)
  LD_COURSE_SUMMARY_PROMPT  detailed or relationship (default detailed)

The real email service account is undecided (decision 3 note): until it
exists, codes are delivered by the dev mailer to the outbox file and
stdout. Swapping in a real Mailer means passing a different `mailer` into
create_app — no route or storage changes.
"""

from __future__ import annotations

import logging
import os
import socket
import sys

import uvicorn

from .config import DEFAULT_CONFIG_FILE


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


def build_app(env: dict, config_file: str | None = None):
    from .app_factory import create_app
    from .config import load_config
    from .mailer import create_dev_mailer
    from .persistence import create_file_store

    cfg = load_config(env, config_file=config_file)
    store = create_file_store({"file": cfg["stateFile"]})
    mailer = create_dev_mailer(out_file=cfg["outboxFile"])
    return create_app(
        store=store,
        mailer=mailer,
        seed_file=cfg["inviteSeed"],
        config={
            "worker_token": cfg["workerToken"],
            "audio_dir": cfg["audioDir"],
            "ai_provider_name": cfg["aiProvider"],
            "ai_api_key": cfg["aiApiKey"],
            "ai_model": cfg["aiModel"],
            "ai_base_url": cfg["aiBaseUrl"],
            "ai_timeout_ms": cfg["aiTimeoutMs"],
            "course_summary_prompt": cfg["courseSummaryPrompt"],
        },
    )


def main(env: dict | None = None) -> None:
    logging.basicConfig()
    logging.getLogger("app").setLevel(logging.INFO)
    env = dict(os.environ if env is None else env)
    app = build_app(env, config_file=DEFAULT_CONFIG_FILE)
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
