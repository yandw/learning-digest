"""Storage port: FileStore/MemoryStore behavior locked to lib/persistence.js
(write-through sets, save-on-effective-delete, one-shot load at
construction, atomic tmp+rename save, insertion-ordered lists). Seams: the
store objects themselves — the same seam the Node unit tests indirectly and
the server-entry test pins on disk."""

import json
import os

from app.persistence import create_file_store, create_memory_store


def test_memory_store_collection_semantics():
    store = create_memory_store()
    assert store.get("things", "a") is None
    store.set("things", "a", {"n": 1})
    store.set("things", "b", {"n": 2})
    assert store.get("things", "a") == {"n": 1}
    assert store.list("things") == [{"n": 1}, {"n": 2}]
    assert store.count("things") == 2
    assert store.delete("things", "a") is True
    assert store.delete("things", "a") is False
    assert store.list("things") == [{"n": 2}]
    store.set("other", "x", {"y": 0})
    assert store.get("things", "a") is None and store.count("other") == 1


def test_file_store_persists_writes_through(tmp_path):
    file = str(tmp_path / "state.json")
    store = create_file_store({"file": file})
    assert not os.path.exists(file)
    store.set("invites", "a@example.com", {"email": "a@example.com"})
    # Write-through: the file already reflects the mutation.
    with open(file, encoding="utf-8") as fh:
        assert json.load(fh) == {"invites": {"a@example.com": {"email": "a@example.com"}}}
    store.set("invites", "b@example.com", {"email": "b@example.com"})
    with open(file, encoding="utf-8") as fh:
        assert list(json.load(fh)["invites"]) == ["a@example.com", "b@example.com"]


def test_file_store_delete_only_saves_when_something_was_removed(tmp_path):
    file = str(tmp_path / "state.json")
    store = create_file_store({"file": file})
    store.set("things", "a", {"n": 1})
    first_mtime = os.path.getmtime(file)
    assert store.delete("things", "missing") is False
    assert os.path.getmtime(file) == first_mtime, "no-op delete must not rewrite the file"
    assert store.delete("things", "a") is True
    assert os.path.getmtime(file) != first_mtime
    with open(file, encoding="utf-8") as fh:
        assert json.load(fh) == {"things": {}}


def test_file_store_loads_the_snapshot_once_at_construction(tmp_path):
    file = str(tmp_path / "state.json")
    with open(file, "w", encoding="utf-8") as fh:
        json.dump({"invites": {"a@example.com": {"email": "a@example.com", "invitedAt": "2026-01-01T00:00:00.000Z"}}}, fh)
    store = create_file_store({"file": file})
    assert store.get("invites", "a@example.com")["invitedAt"] == "2026-01-01T00:00:00.000Z"
    assert store.list("invites") == [{"email": "a@example.com", "invitedAt": "2026-01-01T00:00:00.000Z"}]
    # One-shot load: later external edits are not re-read.
    with open(file, "w", encoding="utf-8") as fh:
        json.dump({"invites": {}}, fh)
    assert store.count("invites") == 1


def test_file_store_save_is_atomic_tmp_then_rename(tmp_path):
    file = str(tmp_path / "nested" / "state.json")
    store = create_file_store({"file": file})
    store.set("things", "a", {"n": 1})
    assert not os.path.exists(f"{file}.tmp"), "tmp file is renamed away after each save"
    leftovers = [name for name in os.listdir(os.path.dirname(file)) if name != "state.json"]
    assert leftovers == []


def test_file_store_creates_missing_parent_directories(tmp_path):
    file = str(tmp_path / "deep" / "dir" / "state.json")
    store = create_file_store({"file": file})
    store.set("things", "a", {"n": 1})
    with open(file, encoding="utf-8") as fh:
        assert json.load(fh)["things"]["a"] == {"n": 1}
