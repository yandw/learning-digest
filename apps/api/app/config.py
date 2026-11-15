"""App config — ports the DEFAULT_CONFIG table of lib/app.js. Same names,
same defaults, same units (ms), so env wiring in main.py can stay 1:1 with
server.js. Later round-4 tickets extend this dataclass as domains land.

Ticket 5.8 (#97) adds the config-file layer: apps/api/config.json (when it
exists) holds base values keyed by the camelCase names (workerToken,
aiProvider, aiApiKey, aiModel, aiBaseUrl, aiTimeoutMs, stateFile,
inviteSeed, outboxFile, audioDir — PORT stays script-managed), environment
variables override it, the built-in defaults fill the rest. A missing file
is the pre-5.8 behavior; invalid JSON fails at startup with the file path.
load_config only touches the filesystem when given config_file — the
production entrypoint passes DEFAULT_CONFIG_FILE, tests stay hermetic."""

from __future__ import annotations

import dataclasses
import json
import os
import tempfile

# apps/api (the unit root: pyproject.toml, data/, config.json).
API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# apps/api/config.json (runtime, gitignored — see config.example.json).
DEFAULT_CONFIG_FILE = os.path.join(API_DIR, "config.json")

# Data-path defaults: files next to the API package, as the entrypoint
# wired them before the config-file layer existed.
PATH_DEFAULTS: dict[str, str] = {
    "stateFile": os.path.join(API_DIR, "data", "state.json"),
    "inviteSeed": os.path.join(API_DIR, "data", "invites.seed.json"),
    "outboxFile": os.path.join(API_DIR, "data", "outbox.jsonl"),
}


@dataclasses.dataclass(frozen=True)
class Config:
    # Verification code lifetime. Decision: 10 minutes, a normal email-code
    # window; configurable so trials can tighten it.
    code_ttl_ms: int = 10 * 60 * 1000
    # Link code lifetime: the one-time code travels through the browser
    # location bar, so it lives only as long as a focused link confirmation.
    link_code_ttl_ms: int = 10 * 60 * 1000
    # Failed verification attempts allowed per code before it is invalidated
    # (brute-force guard). 5 tries on a 6-digit code.
    code_max_attempts: int = 5
    # Minimum interval between two codes for the same email. Extra requests
    # inside the window answer 200 but do not resend (anti-enumeration).
    code_resend_cooldown_ms: int = 60 * 1000
    # Bearer credential token entropy.
    token_bytes: int = 32
    # Request body cap.
    max_body_bytes: int = 64 * 1024
    # Worker service credential (round-2 endpoints; not wired in Python yet).
    worker_token: str = ""
    # Temporary audio directory for uploaded segments (D14).
    audio_dir: str = os.path.join(tempfile.gettempdir(), "ld-api-audio")
    # AI Provider seam for course summaries (round 3; not wired yet).
    ai_provider_name: str = ""
    ai_api_key: str = ""
    ai_model: str = ""
    ai_base_url: str = ""
    ai_timeout_ms: int = 120_000


DEFAULT_CONFIG = Config()


def resolve_config(overrides: dict | None) -> Config:
    """Merge partial overrides over the defaults (lib/app.js semantics)."""
    if not overrides:
        return DEFAULT_CONFIG
    return dataclasses.replace(DEFAULT_CONFIG, **overrides)


def env_string(env: dict[str, str], name: str, fallback: str = "") -> str:
    value = env.get(name)
    value = value.strip() if isinstance(value, str) else ""
    return value or fallback


def env_int(env: dict[str, str], name: str, fallback: int) -> int:
    """The entrypoint's _parse_int equivalent: a non-numeric env value falls
    back (no positivity rule here — PORT needs 0 = ephemeral)."""
    value = env.get(name)
    try:
        return int(value or "")
    except (TypeError, ValueError):
        return fallback


def load_config_file(path: str) -> dict:
    """The config-file layer (ticket 5.8): a missing file is no values at
    all (pre-5.8 behavior); anything unreadable or malformed fails with the
    file path in the message, at startup."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"config file {path} is not valid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"config file {path} must contain a JSON object")
    return parsed


def file_string(value: object) -> str:
    """String fields take JSON strings; any other JSON type (or null) is no
    value at all — the env layer and then the defaults fill in."""
    return value.strip() if isinstance(value, str) else ""


def file_int(value: object, fallback: int) -> int:
    """JSON number or numeric string (bools are not numbers); junk falls
    back — the same rule the env layer applies."""
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else fallback
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return fallback
    return fallback


def load_config(env: dict[str, str] | None = None, config_file: str | None = None) -> dict:
    """Merged configuration for the API entrypoint, keyed by the camelCase
    names the config file (and the README field tables) use. Precedence:
    environment variables > config.json > built-in defaults. PORT is not
    here — the listen port stays script-managed (scripts/dev.sh)."""
    env = env or {}
    file_values = load_config_file(config_file) if config_file is not None else {}
    return {
        "workerToken": env_string(env, "LD_API_WORKER_TOKEN", file_string(file_values.get("workerToken"))),
        "aiProvider": env_string(env, "LD_AI_PROVIDER", file_string(file_values.get("aiProvider"))),
        "aiApiKey": env_string(env, "LD_AI_API_KEY", file_string(file_values.get("aiApiKey"))),
        "aiModel": env_string(env, "LD_AI_MODEL", file_string(file_values.get("aiModel"))),
        "aiBaseUrl": env_string(env, "LD_AI_BASE_URL", file_string(file_values.get("aiBaseUrl"))),
        "aiTimeoutMs": env_int(
            env,
            "LD_AI_TIMEOUT_MS",
            file_int(file_values.get("aiTimeoutMs"), DEFAULT_CONFIG.ai_timeout_ms),
        ),
        "stateFile": env_string(env, "LD_API_STATE_FILE", file_string(file_values.get("stateFile")) or PATH_DEFAULTS["stateFile"]),
        "inviteSeed": env_string(env, "LD_API_INVITE_SEED", file_string(file_values.get("inviteSeed")) or PATH_DEFAULTS["inviteSeed"]),
        "outboxFile": env_string(env, "LD_API_OUTBOX_FILE", file_string(file_values.get("outboxFile")) or PATH_DEFAULTS["outboxFile"]),
        "audioDir": env_string(env, "LD_API_AUDIO_DIR", file_string(file_values.get("audioDir")) or DEFAULT_CONFIG.audio_dir),
    }
