"""Sliding-window transcripts must not collapse in the merge/dedup.

YouTube caption chunks advance by roughly half their width, so every
record overlaps its neighbours (~50%). The original cluster rule treated
ANY overlap as "same range", and the whole session's records formed one
transitive chain — the merged material (and the web 逐字稿) collapsed to
a single record. The rule now clusters only near-duplicates (one range
covering ≥80% of the other's shorter span): exact copies across sessions
dedup, sliding-window neighbours all survive."""


from app.summaries import collect_material
from app.transcripts import empty_state, save_state


class DictStore:
    def __init__(self):
        self.collections: dict = {}

    def get(self, collection, key):
        return self.collections.get(collection, {}).get(key)

    def set(self, collection, key, value):
        self.collections.setdefault(collection, {})[key] = value

    def list(self, collection):
        return list(self.collections.get(collection, {}).values())


ACCOUNT = "acc_a"
RESOURCE = "res_a"

# One session's sliding-window chunks: each record overlaps the next ~50%.
SESSION_A = [
    {"startMs": 0, "endMs": 4040, "text": "短文本甲"},
    {"startMs": 1800, "endMs": 6120, "text": "中段文本"},
    {"startMs": 4040, "endMs": 8200, "text": "长"},
]
# A second session re-watching the same ranges with sparser copies.
SESSION_B = [
    {"startMs": 0, "endMs": 4040, "text": "短"},
    {"startMs": 1800, "endMs": 6120, "text": "中"},
]


def _store():
    store = DictStore()
    for sid, origin, records in (
        ("ses_a", "captions", SESSION_A),
        ("ses_b", "captions", SESSION_B),
    ):
        store.set(
            "sessions",
            sid,
            {"id": sid, "accountId": ACCOUNT, "resourceId": RESOURCE, "origin": origin},
        )
        state = empty_state(sid)
        state["records"] = [dict(r) for r in records]
        save_state(store, state)
    return store


def test_sliding_window_positions_all_survive_across_sessions():
    material = collect_material(store=_store(), account_id=ACCOUNT, resource_id=RESOURCE)
    texts = [r["text"] for r in material["records"]]
    # Three distinct positions kept (not one collapsed record)…
    assert len(texts) == 3
    # …and each exact copy dedups to the longest text.
    assert texts == ["短文本甲", "中段文本", "长"]


def test_single_session_sliding_window_keeps_every_position():
    store = DictStore()
    store.set(
        "sessions",
        "ses_only",
        {"id": "ses_only", "accountId": ACCOUNT, "resourceId": RESOURCE, "origin": "captions"},
    )
    state = empty_state("ses_only")
    state["records"] = [dict(r) for r in SESSION_A]
    save_state(store, state)

    material = collect_material(store=store, account_id=ACCOUNT, resource_id=RESOURCE)
    assert [r["text"] for r in material["records"]] == ["短文本甲", "中段文本", "长"]
