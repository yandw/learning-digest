"""Pre-r4 usage rows lack the rolling-summary / digest / explain counters.

Rows persisted before contract-r4 shipped only carry
{accountId, audioMs, summaryCount, summaryInputChars, updatedAt,
updatedAtMs}. Every record_* call and usage_view used to index the newer
keys directly and crashed with KeyError on such a row (observed in the
dev API log as 500s on POST /v1/sessions/{id}/digest right after a
successful generation). with_defaults() backfills missing fields on read,
so recording through it works and the stored row is upgraded on write."""

from app import usage


class DictStore:
    def __init__(self, rows=None):
        self.collections = {"usage": dict(rows or {})}

    def get(self, collection, key):
        return self.collections.get(collection, {}).get(key)

    def set(self, collection, key, value):
        self.collections.setdefault(collection, {})[key] = value


NOW_MS = 1_700_000_000_000
LEGACY_ROW = {
    "accountId": "acc_legacy",
    "audioMs": 1_541_000,
    "summaryCount": 1,
    "summaryInputChars": 2131,
    "updatedAt": "2026-11-17T05:17:40Z",
    "updatedAtMs": 1_765_665_460_000,
}


def _legacy_store():
    return DictStore({"acc_legacy": dict(LEGACY_ROW)})


def test_record_digest_generation_backfills_and_counts_on_legacy_row():
    store = _legacy_store()
    row = usage.record_digest_generation(
        store=store, account_id="acc_legacy", input_chars=500, now=lambda: NOW_MS
    )
    assert row["digestCount"] == 1
    assert row["digestInputChars"] == 500
    # Pre-existing values survive; the row keeps its old fields.
    assert row["audioMs"] == 1_541_000
    assert row["summaryCount"] == 1
    assert row["updatedAtMs"] == NOW_MS
    # The write-back carried the upgraded shape.
    stored = store.get("usage", "acc_legacy")
    assert stored["digestCount"] == 1
    assert stored["rollingSummaryCount"] == 0
    assert stored["explainCount"] == 0


def test_record_rolling_summary_generation_on_legacy_row():
    store = _legacy_store()
    row = usage.record_rolling_summary_generation(
        store=store, account_id="acc_legacy", input_chars=700, now=lambda: NOW_MS
    )
    assert row["rollingSummaryCount"] == 1
    assert row["rollingSummaryInputChars"] == 700
    assert row["digestCount"] == 0


def test_record_explain_generation_on_legacy_row():
    store = _legacy_store()
    row = usage.record_explain_generation(
        store=store, account_id="acc_legacy", input_chars=42, now=lambda: NOW_MS
    )
    assert row["explainCount"] == 1
    assert row["explainInputChars"] == 42
    assert row["digestCount"] == 0


def test_record_summary_generation_and_audio_survive_on_legacy_row():
    store = _legacy_store()
    row = usage.record_summary_generation(
        store=store, account_id="acc_legacy", input_chars=100, now=lambda: NOW_MS
    )
    assert row["summaryCount"] == 2
    assert row["summaryInputChars"] == 2231
    row = usage.record_audio_seconds(
        store=store, account_id="acc_legacy", duration_ms=1500, now=lambda: NOW_MS
    )
    assert row["audioMs"] == 1_542_500


def test_usage_view_reports_defaults_for_legacy_row():
    store = _legacy_store()
    view = usage.usage_view(store=store, account_id="acc_legacy")
    assert view["audioSeconds"] == 1541
    assert view["summaryCount"] == 1
    assert view["digestCount"] == 0
    assert view["rollingSummaryCount"] == 0
    assert view["explainCount"] == 0
    assert view["updatedAt"] == "2026-11-17T05:17:40Z"


def test_usage_view_for_never_recorded_account():
    store = DictStore()
    view = usage.usage_view(store=store, account_id="acc_new")
    assert view["audioSeconds"] == 0
    assert view["digestCount"] == 0
    assert view["updatedAt"] is None


def test_full_schema_row_still_round_trips():
    store = DictStore({"acc_full": usage.empty_usage("acc_full")})
    row = usage.record_digest_generation(
        store=store, account_id="acc_full", input_chars=10, now=lambda: NOW_MS
    )
    assert row["digestCount"] == 1
