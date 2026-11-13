"""Integer request-field validation shared by the ported domains.

The 400 *policy* (which field, which message) stays with each domain:
callers pass their exact contract messages, this module only carries the
shared shape (missing-field branch, JS integer semantics via jsnum, the
0 default floor and an optional upper bound). Non-object bodies answer
the missing-field message unless ``non_dict_is_missing`` is False, in
which case the property access happens on the body itself and mirrors
whatever the JS reference would have raised."""

from __future__ import annotations

from typing import Any

from .errors import validation_failed
from .jsnum import coerce_js_integer, is_js_integer


def require_int_field(
    obj: Any,
    field: str,
    *,
    missing_message: str,
    invalid_message: str,
    min_value: int | None = None,
    max_value: int | None = None,
    non_dict_is_missing: bool = True,
) -> Any:
    """Read ``field`` from ``obj`` as a JS integer, raising the caller's
    exact 400s. ``min_value`` defaults to 0 (non-negative); ``max_value``
    reuses ``invalid_message``. ``non_dict_is_missing=False`` preserves a
    caller that originally indexed the body directly on non-objects."""
    if not isinstance(obj, dict):
        if non_dict_is_missing:
            raise validation_failed(missing_message)
        value = obj[field]  # mirrors the JS reference's property access
    elif field not in obj or obj[field] is None:
        raise validation_failed(missing_message)
    else:
        value = obj[field]
    if not is_js_integer(value) or value < (0 if min_value is None else min_value):
        raise validation_failed(invalid_message)
    value = coerce_js_integer(value)
    if max_value is not None and value > max_value:
        raise validation_failed(invalid_message)
    return value
