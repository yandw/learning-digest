"""Per-request context: the injected seams shared by every route. Port of
the `ctx` object lib/routes.js receives from createApp."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .config import Config


@dataclass
class AppContext:
    store: Any
    mailer: Any
    now: Callable[[], int]
    config: Config
    seed_file: str | None = None
    # AI Provider seam for course summaries (D16), resolved once at startup.
    ai_provider: Any = None
