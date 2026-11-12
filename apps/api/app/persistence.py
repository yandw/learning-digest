"""Storage seam: a generic collection store so routes and domain modules
never lock to a storage implementation. Port of lib/persistence.js.

Two implementations, one interface:
- FileStore: round-1 embedded persistence, one JSON file, in-memory maps,
  write-through with an atomic tmp+rename save.
- MemoryStore: no persistence (app default; tests use it too).
Collections are opaque named dicts; the store knows nothing about domains.

Semantics locked to the Node reference:
- get/set/delete/list/count on named collections; list is insertion-ordered
  (Python dicts and JSON objects both preserve insertion order).
- FileStore loads the file once at construction; every set writes through;
  delete saves only when it actually removed something.
- Load and save are whole-snapshot JSON: {collection: {key: record}}.
"""

from __future__ import annotations

import json
import os
from typing import Any

_MISSING = object()


class MemoryStore:
    def __init__(self) -> None:
        self.collections: dict[str, dict[str, Any]] = {}

    def get(self, collection: str, key: str) -> Any:
        return self.collections.get(collection, {}).get(key)

    def set(self, collection: str, key: str, value: Any) -> None:
        self.collections.setdefault(collection, {})[key] = value

    def delete(self, collection: str, key: str) -> bool:
        entries = self.collections.get(collection, {})
        return entries.pop(key, _MISSING) is not _MISSING

    def list(self, collection: str) -> list[Any]:
        return list(self.collections.get(collection, {}).values())

    def count(self, collection: str) -> int:
        return len(self.collections.get(collection, {}))


class FileStore(MemoryStore):
    def __init__(self, *, file: str) -> None:
        super().__init__()
        self.file = file
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self.file):
            return
        with open(self.file, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        for name, entries in raw.items():
            self.collections[name] = dict(entries)

    def _save(self) -> None:
        snapshot = {
            name: dict(entries) for name, entries in self.collections.items()
        }
        directory = os.path.dirname(self.file)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp = f"{self.file}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(snapshot, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, self.file)

    def set(self, collection: str, key: str, value: Any) -> None:
        super().set(collection, key, value)
        self._save()

    def delete(self, collection: str, key: str) -> bool:
        existed = super().delete(collection, key)
        if existed:
            self._save()
        return existed


def create_memory_store() -> MemoryStore:
    return MemoryStore()


def create_file_store(options: dict) -> FileStore:
    """Node-style factory: createFileStore({ file }) -> store."""
    return FileStore(file=options["file"])
