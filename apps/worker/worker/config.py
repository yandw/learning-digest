"""Worker config (ticket 4.5; Node ticket 2.3, lib/config.js): env wiring
only — the provider seam and the loop are the behavior. apiBase / token /
provider / poll interval come from LD_WORKER_* env vars; the Qwen key from
QWEN_API_KEY; the local (self-hosted / LAN) ASR service from
LD_WORKER_LOCAL_*. A qwen selection without a key, or a local selection
without a base URL, fails at startup (fail fast, not per task).

Ticket 5.8 (#97) adds the config-file layer: apps/worker/config.json (when
it exists) holds base values keyed by the internal camelCase names, env
vars override it, DEFAULTS fill whatever neither set. A missing file is the
pre-5.8 behavior; invalid JSON fails at startup with the file path (fail
fast, not per task). load_worker_config only touches the filesystem when
given config_file — the production entrypoint passes DEFAULT_CONFIG_FILE,
tests stay hermetic."""

from __future__ import annotations

import json
import math
import pathlib
from typing import Any

# apps/worker/config.json (runtime, gitignored — see config.example.json).
DEFAULT_CONFIG_FILE = pathlib.Path(__file__).resolve().parents[1] / "config.json"

DEFAULTS: dict[str, Any] = {
    "apiBase": "http://127.0.0.1:8787",
    "provider": "stub",
    "pollIntervalMs": 5000,
    "qwenBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwenModel": "qwen3-asr-flash",
    # Per-request ASR timeout (ms): a 30s segment is routine, far beyond
    # httpx's 5s shared default — the provider sends an explicit timeout.
    "qwenTimeoutMs": 120000,
    # LD_WORKER_LOCAL_BASE_URL has no default (required, fail fast without it).
    "localModel": "whisper-1",
    "localResponseFormat": "verbose_json",
    "localLanguage": "zh",
}


def env_string(env: dict[str, str], name: str, fallback: str = "") -> str:
    value = env.get(name)
    value = value.strip() if isinstance(value, str) else ""
    return value or fallback


def env_number(env: dict[str, str], name: str, fallback: Any = None) -> Any:
    """Number(raw) equivalent: a non-positive or non-numeric value falls
    back (the Node port accepts only finite numbers > 0)."""
    raw = env.get(name)
    raw = raw.strip() if isinstance(raw, str) else ""
    if not raw:
        return fallback
    try:
        parsed = float(raw)
    except ValueError:
        return fallback
    if not math.isfinite(parsed) or parsed <= 0:
        return fallback
    return int(parsed) if parsed.is_integer() else parsed


def load_config_file(path: str | Any) -> dict[str, Any]:
    """The config-file layer (ticket 5.8): a missing file is no values at
    all (pre-5.8 behavior); anything unreadable or malformed fails with the
    file path in the message, at startup — never per task."""
    try:
        text = pathlib.Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"config file {path} is not valid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"config file {path} must contain a JSON object")
    return parsed


def file_string(value: Any) -> str:
    """String fields take JSON strings; any other JSON type (or null) is no
    value at all — the env layer and then the defaults fill in."""
    return value.strip() if isinstance(value, str) else ""


def file_number(value: Any, fallback: Any = None) -> Any:
    """Number(raw) equivalent for the file layer: a JSON number (bools are
    not numbers) or a numeric string; non-positive/non-numeric falls back —
    the same rule the env layer applies."""
    if isinstance(value, bool) or value is None:
        return fallback
    if isinstance(value, (int, float)):
        parsed = float(value)
    elif isinstance(value, str):
        raw = value.strip()
        if not raw:
            return fallback
        try:
            parsed = float(raw)
        except ValueError:
            return fallback
    else:
        return fallback
    if not math.isfinite(parsed) or parsed <= 0:
        return fallback
    return int(parsed) if parsed.is_integer() else parsed


def load_worker_config(
    env: dict[str, str] | None = None,
    config_file: str | Any | None = None,
) -> dict[str, Any]:
    env = env or {}
    file_values = load_config_file(config_file) if config_file is not None else {}
    return {
        "apiBase": env_string(env, "LD_WORKER_API_BASE", file_string(file_values.get("apiBase")) or DEFAULTS["apiBase"]),
        "token": env_string(env, "LD_WORKER_TOKEN", file_string(file_values.get("token"))),
        "provider": env_string(env, "LD_WORKER_PROVIDER", file_string(file_values.get("provider")) or DEFAULTS["provider"]),
        "pollIntervalMs": env_number(env, "LD_WORKER_POLL_INTERVAL_MS", file_number(file_values.get("pollIntervalMs"), DEFAULTS["pollIntervalMs"])),
        "errorBackoffMs": env_number(env, "LD_WORKER_ERROR_BACKOFF_MS", file_number(file_values.get("errorBackoffMs"), None)),
        "qwenApiKey": env_string(env, "QWEN_API_KEY", file_string(file_values.get("qwenApiKey"))),
        "qwenBaseUrl": env_string(env, "LD_WORKER_QWEN_BASE_URL", file_string(file_values.get("qwenBaseUrl")) or DEFAULTS["qwenBaseUrl"]),
        "qwenModel": env_string(env, "LD_WORKER_QWEN_MODEL", file_string(file_values.get("qwenModel")) or DEFAULTS["qwenModel"]),
        "qwenTimeoutMs": env_number(env, "LD_WORKER_QWEN_TIMEOUT_MS", file_number(file_values.get("qwenTimeoutMs"), DEFAULTS["qwenTimeoutMs"])),
        "localBaseUrl": env_string(env, "LD_WORKER_LOCAL_BASE_URL", file_string(file_values.get("localBaseUrl"))),
        "localModel": env_string(env, "LD_WORKER_LOCAL_MODEL", file_string(file_values.get("localModel")) or DEFAULTS["localModel"]),
        "localToken": env_string(env, "LD_WORKER_LOCAL_TOKEN", file_string(file_values.get("localToken"))),
        "localLanguage": env_string(env, "LD_WORKER_LOCAL_LANGUAGE", file_string(file_values.get("localLanguage")) or DEFAULTS["localLanguage"]),
        "localMimeType": env_string(env, "LD_WORKER_LOCAL_MIME_TYPE", file_string(file_values.get("localMimeType"))),
        "localResponseFormat": env_string(env, "LD_WORKER_LOCAL_RESPONSE_FORMAT", file_string(file_values.get("localResponseFormat")) or DEFAULTS["localResponseFormat"]),
    }


def create_provider_from_config(config: dict[str, Any]) -> dict[str, Any]:
    """Builds the Speech Provider from config. Unknown selections, a qwen
    selection without a key, and a local selection without a base URL raise
    here, at startup — never per task."""
    provider = config["provider"]
    if provider == "stub":
        from .providers.stub import create_stub_provider

        return create_stub_provider()
    if provider == "qwen":
        from .providers.qwen import create_qwen_provider

        return create_qwen_provider(
            api_key=config["qwenApiKey"],
            base_url=config["qwenBaseUrl"],
            model=config["qwenModel"],
            timeout_ms=config["qwenTimeoutMs"],
        )
    if provider == "local":
        from .providers.local import create_local_provider

        return create_local_provider(
            base_url=config["localBaseUrl"],
            model=config["localModel"],
            token=config["localToken"],
            language=config["localLanguage"],
            mime_type=config["localMimeType"],
            response_format=config["localResponseFormat"],
        )
    raise ValueError(f"unknown LD_WORKER_PROVIDER: {provider} (expected stub | qwen | local)")
