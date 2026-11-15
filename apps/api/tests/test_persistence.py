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


# --- batch delete (contract-r4 §8, ticket 5.5, D23): the resource-delete
# cascade removes six+ collections in one stroke, so the store needs a
# batch primitive that lands the whole removal as ONE snapshot write —
# per-key deletes would persist an intermediate state between them.


def test_memory_store_delete_many_removes_only_existing_keys_across_collections():
    store = create_memory_store()
    store.set("things", "a", {"n": 1})
    store.set("things", "b", {"n": 2})
    store.set("other", "x", {"y": 0})

    removed = store.delete_many({"things": ["a", "missing"], "other": ["x"], "empty": ["z"]})

    assert removed == 2
    assert store.count("things") == 1 and store.get("things", "b") == {"n": 2}
    assert store.count("other") == 0
    # An all-missing batch removes nothing.
    assert store.delete_many({"things": ["missing"]}) == 0


def test_file_store_delete_many_lands_one_snapshot_after_all_removals(tmp_path, monkeypatch):
    file = str(tmp_path / "state.json")
    store = create_file_store({"file": file})
    store.set("things", "a", {"n": 1})
    store.set("things", "b", {"n": 2})
    store.set("other", "x", {"y": 0})

    snapshots_at_save = []
    original_save = store._save

    def counting_save():
        # What this save is about to serialize (the in-memory snapshot _save
        # dumps) — captured before the write lands.
        snapshots_at_save.append(
            {name: dict(entries) for name, entries in store.collections.items()}
        )
        original_save()

    monkeypatch.setattr(store, "_save", counting_save)

    removed = store.delete_many({"things": ["a", "b"], "other": ["x", "missing"]})

    assert removed == 3
    assert len(snapshots_at_save) == 1, "the batch persists exactly once"
    # The single write already reflects EVERY removal — no intermediate
    # state (things half-deleted) ever lands on disk.
    assert snapshots_at_save[0] == {"things": {}, "other": {}}
    # A reload from the same file agrees.
    reloaded = create_file_store({"file": file})
    assert reloaded.count("things") == 0 and reloaded.count("other") == 0


def test_file_store_delete_many_skips_the_save_when_nothing_was_removed(tmp_path):
    file = str(tmp_path / "state.json")
    store = create_file_store({"file": file})
    store.set("things", "a", {"n": 1})
    first_mtime = os.path.getmtime(file)

    assert store.delete_many({"things": ["missing"], "other": ["gone"]}) == 0
    assert os.path.getmtime(file) == first_mtime, "a no-op batch must not rewrite the file"
