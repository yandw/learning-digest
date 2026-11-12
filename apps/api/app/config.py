"""App config — ports the DEFAULT_CONFIG table of lib/app.js. Same names,
same defaults, same units (ms), so env wiring in main.py can stay 1:1 with
server.js. Later round-4 tickets extend this dataclass as domains land."""

from __future__ import annotations

import dataclasses
import os
import tempfile


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
