"""JS number semantics for JSON request bodies (Python port plumbing).

JavaScript has one number type: a JSON `2.0` parses to the same value as
`2`, and `Number.isInteger(2.0)` is true. Python parses `2.0` to a float
and would echo it back as "2.0", so the ported domains judge integers
with `is_js_integer` and normalize integral floats with
`coerce_js_integer` before storing or echoing them. The 400 *policy*
(which field, which message) stays with each domain — resources.py
(parse_identity), notes.py (positionMs) and progress.py (positionMs,
expectedRevision) all lean on this module."""

from __future__ import annotations

from typing import Any


def coerce_js_integer(value: Any) -> Any:
    """JSON numbers written with a decimal point parse to Python floats;
    JS numbers are one type and Number.isInteger(2.0) is true. A float
    with an integral value IS the int — normalize so stores and echoes
    match the JS reference (1000.0 would serialize as "1000.0")."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def is_js_integer(value: Any) -> bool:
    """Number.isInteger: ints count, bools do not (JSON true/false are not
    numbers), float integrals count (they parse as JS numbers)."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()
