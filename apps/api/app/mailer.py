"""Mailer seam: the routes never touch a concrete email vendor. Port of
lib/mailer.js. The real mail service account is undecided, so round 1
ships a dev implementation (code written to a readable file/log) plus an
in-memory spy for tests. A production implementation only needs to satisfy
send() — no vendor SDK or SMTP client is bundled here."""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from .timeutil import iso_now


class MemoryMailer:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, record: dict) -> None:
        self.sent.append({**record, "sentAt": iso_now()})


class DevMailer:
    """Appends one JSON line per email to `out_file` and logs to stdout.
    The verification code rides on the record so tests (and the operator)
    can read it directly from the outbox."""

    def __init__(self, *, out_file: str | None, log: bool = True) -> None:
        self.out_file = out_file
        self.log = log

    async def send(self, record: dict) -> None:
        line = json.dumps({**record, "sentAt": iso_now()}, ensure_ascii=False)
        if self.out_file:
            directory = os.path.dirname(self.out_file)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with open(self.out_file, "a", encoding="utf-8") as fh:
                fh.write(f"{line}\n")
        if self.log:
            sys.stdout.write(
                f"[mailer] to={record['to']} subject=\"{record['subject']}\" "
                f"code={record['code']}\n"
            )


def create_memory_mailer() -> MemoryMailer:
    return MemoryMailer()


def create_dev_mailer(*, out_file: str | None, log: bool = True) -> DevMailer:
    return DevMailer(out_file=out_file, log=log)
