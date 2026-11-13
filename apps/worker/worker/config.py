"""Worker config (ticket 4.5; Node ticket 2.3, lib/config.js): env wiring
only — the provider seam and the loop are the behavior. apiBase / token /
provider / poll interval come from LD_WORKER_* env vars; the Qwen key from
QWEN_API_KEY. A qwen selection without a key fails at startup (fail fast,
not per task)."""

from __future__ import annotations

import math
from typing import Any

DEFAULTS: dict[str, Any] = {
    "apiBase": "http://127.0.0.1:8787",
    "provider": "stub",
    "pollIntervalMs": 5000,
    "qwenBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwenModel": "qwen3-asr-flash",
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


def load_worker_config(env: dict[str, str] | None = None) -> dict[str, Any]:
    env = env or {}
    return {
        "apiBase": env_string(env, "LD_WORKER_API_BASE", DEFAULTS["apiBase"]),
        "token": env_string(env, "LD_WORKER_TOKEN"),
        "provider": env_string(env, "LD_WORKER_PROVIDER", DEFAULTS["provider"]),
        "pollIntervalMs": env_number(env, "LD_WORKER_POLL_INTERVAL_MS", DEFAULTS["pollIntervalMs"]),
        "errorBackoffMs": env_number(env, "LD_WORKER_ERROR_BACKOFF_MS", None),
        "qwenApiKey": env_string(env, "QWEN_API_KEY"),
        "qwenBaseUrl": env_string(env, "LD_WORKER_QWEN_BASE_URL", DEFAULTS["qwenBaseUrl"]),
        "qwenModel": env_string(env, "LD_WORKER_QWEN_MODEL", DEFAULTS["qwenModel"]),
    }


def create_provider_from_config(config: dict[str, Any]) -> dict[str, Any]:
    """Builds the Speech Provider from config. Unknown selections and a
    qwen selection without a key raise here, at startup — never per task."""
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
        )
    raise ValueError(f"unknown LD_WORKER_PROVIDER: {provider} (expected stub | qwen)")
