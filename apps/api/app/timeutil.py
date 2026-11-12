"""ISO 8601 UTC timestamps (contract §1: createdAt-style fields are ISO 8601
UTC strings). Mirrors Node's new Date(ms).toISOString(): millisecond
precision with a trailing Z."""

from datetime import datetime, timezone


def iso_from_ms(at_ms: int) -> str:
    moment = datetime.fromtimestamp(at_ms / 1000, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at_ms % 1000:03d}Z"


def iso_now() -> str:
    return iso_from_ms(int(datetime.now(tz=timezone.utc).timestamp() * 1000))


def iso_seconds_from_ms(at_ms: int) -> str:
    """Contract §1 timestamp format for createdAt-style fields: ISO 8601 UTC
    at second precision, like the fixture samples ("2026-11-10T08:00:00Z").
    Port of lib/notes.js isoSeconds (floor to the second, drop the ".mmm")
    — the API's single createdAt formatter, shared by resources and notes
    so every timestamp is shaped alike."""
    moment = datetime.fromtimestamp((at_ms // 1000), tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")
