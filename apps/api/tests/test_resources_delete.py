"""DELETE /v1/resources/{id} — the resource-delete cascade (contract-r4
§8; ticket 5.5, issue #94; decision D23).

Seam: the /v1 HTTP endpoints; all material is built through the PUBLIC
flow (favorite -> progress -> note -> session -> captions -> finish ->
rolling summary -> digest -> course summary), the same discipline as the
other domain tests. The store is only READ (counts) to pin the cascade
across every collection the API owns, and the FileStore is reloaded from
disk to pin the one-snapshot persistence.

Pinned here: the cascade empties sources/progress/notes/sessions/
transcripts/sessionInsights/sessionDigests/summaries for the deleted
resource while the usage ledger stays (账目不随删除消失, D23); D2
isolation (unknown id, other account, repeat delete — deletion is
terminal, no tombstone); resolve answers no-match after a delete; the
same URL can be re-favorited as a NEW resource; other resources of the
same account are untouched.
"""

import json

from helpers import (
    auth_header,
    create_fixture_source,
    error_example,
    open_account,
    open_session,
)

EMAIL_A = "delete-a@example.com"
EMAIL_B = "delete-b@example.com"

CAPTION_SEGMENTS = [
    {"startMs": 30000, "endMs": 60000, "text": "注意力分数的计算，就是把查询向量和键向量做点积"},
    {"startMs": 60000, "endMs": 90000, "text": "上一节我们留了一个问题：为什么要缩放点积"},
]

CASCADE_COLLECTIONS = (
    "resources",
    "sources",
    "progress",
    "notes",
    "sessions",
    "transcripts",
    "sessionInsights",
    "sessionDigests",
    "summaries",
)


def build_full_material(app, token, *, label="delete", episode="2"):
    """Favorite one fixture source and hang EVERY deletable artifact off it
    through the public flow. `episode` picks the bilibili p= param so two
    materials in one account are two Resources (D5/D8 matching). Returns
    { resource, source, session }."""
    created = create_fixture_source(
        app,
        token,
        title=f"注意力机制详解 P{episode}：自注意力（{label}）",
        url=f"https://www.bilibili.com/video/BV1ab411L78c?p={episode}",
    )
    resource, source = created["resource"], created["source"]

    progress = app.request(
        "PUT",
        f"/v1/sources/{source['id']}/progress",
        headers=auth_header(token),
        body={"positionMs": 45000, "expectedRevision": 0},
    )
    assert progress.status == 200, progress.json

    note = app.request(
        "POST",
        f"/v1/resources/{resource['id']}/notes",
        headers=auth_header(token),
        body={
            "clientRequestId": f"note-{label}",
            "text": "自注意力的核心是点积和缩放",
            "sourceId": source["id"],
            "positionMs": 45000,
        },
    )
    assert note.status == 201, note.json

    session = open_session(app, token, source["id"])
    archived = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/captions",
        headers=auth_header(token),
        body={"segments": CAPTION_SEGMENTS},
    )
    assert archived.status == 201, archived.json
    finished = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/finish",
        headers=auth_header(token),
        body={"gaps": [{"startMs": 120000, "endMs": 150000}]},
    )
    assert finished.status == 200, finished.json

    rolling = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/rolling-summary",
        headers=auth_header(token),
        body={},
    )
    assert rolling.status == 201, rolling.json
    digest = app.request(
        "POST",
        f"/v1/sessions/{session['id']}/digest",
        headers=auth_header(token),
        body={},
    )
    assert digest.status == 201, digest.json
    summary = app.request(
        "POST",
        f"/v1/resources/{resource['id']}/summaries",
        headers=auth_header(token),
        body={},
    )
    assert summary.status == 201, summary.json

    return {"resource": resource, "source": source, "session": session}


def test_delete_cascades_every_collection_and_keeps_the_usage_ledger(start_app):
    app = start_app(seed_emails=[EMAIL_A])
    token = open_account(app, EMAIL_A)
    material = build_full_material(app, token)
    resource_id = material["resource"]["id"]

    # The cascade preconditions: every collection actually holds this
    # resource's rows before the delete (the test builds them via the
    # public flow, this read-only check keeps the assertion honest).
    for collection in CASCADE_COLLECTIONS:
        assert app.store.count(collection) > 0, collection
    usage_before = app.request("GET", "/v1/usage", headers=auth_header(token))
    assert usage_before.status == 200
    assert usage_before.json["summaryCount"] >= 1

    response = app.request(
        "DELETE", f"/v1/resources/{resource_id}", headers=auth_header(token)
    )

    assert response.status == 200
    assert response.json == {"deleted": True}

    # The cascade: not one row of this resource survives in any collection.
    for collection in CASCADE_COLLECTIONS:
        assert app.store.count(collection) == 0, collection

    # The ledger stays (D23): usage is byte-identical after the delete.
    usage_after = app.request("GET", "/v1/usage", headers=auth_header(token))
    assert usage_after.status == 200
    assert usage_after.json == usage_before.json

    # Reads after the delete all answer the D2 404 family.
    detail = app.request("GET", f"/v1/resources/{resource_id}", headers=auth_header(token))
    assert detail.status == 404
    assert detail.json == error_example("error-cross-account-resource")["response"]["body"]
    listed = app.request("GET", "/v1/resources", headers=auth_header(token))
    assert listed.status == 200
    assert listed.json["resources"] == []
    transcript = app.request(
        "GET",
        f"/v1/sessions/{material['session']['id']}/transcript",
        headers=auth_header(token),
    )
    assert transcript.status == 404
    assert transcript.json == error_example("error-cross-account-session-transcript")["response"]["body"]
    overview = app.request(
        "GET",
        f"/v1/sessions/{material['session']['id']}/overview",
        headers=auth_header(token),
    )
    assert overview.status == 404
    summaries = app.request(
        "GET", f"/v1/resources/{resource_id}/summaries", headers=auth_header(token)
    )
    assert summaries.status == 404
    assert summaries.json == error_example("error-cross-account-resource")["response"]["body"]

    # One-snapshot persistence: a fresh store loading the same file sees
    # the completed cascade (no collection left half-deleted on disk).
    reloaded_store = json.loads(open(app.store.file, encoding="utf-8").read())
    for collection in CASCADE_COLLECTIONS:
        assert reloaded_store.get(collection, {}) == {}, collection
    assert reloaded_store["usage"] != {}


def test_another_accounts_resource_and_unknown_ids_are_the_same_404(start_app):
    app = start_app(seed_emails=[EMAIL_A, EMAIL_B])
    a = open_account(app, EMAIL_A)
    b = open_account(app, EMAIL_B)
    material = build_full_material(app, a, label="a")

    cross = app.request(
        "DELETE", f"/v1/resources/{material['resource']['id']}", headers=auth_header(b)
    )
    unknown = app.request(
        "DELETE", "/v1/resources/res_missing0000", headers=auth_header(b)
    )

    assert cross.status == 404
    assert cross.json == error_example("error-cross-account-resource")["response"]["body"]
    assert unknown.status == 404
    assert unknown.json == cross.json, "D2: the two 404s are indistinguishable"
    # The cross-account attempt deleted nothing — A's material is intact.
    for collection in CASCADE_COLLECTIONS:
        assert app.store.count(collection) > 0, collection


def test_repeat_delete_is_the_same_404_deletion_is_terminal(start_app):
    app = start_app(seed_emails=[EMAIL_A])
    token = open_account(app, EMAIL_A)
    material = build_full_material(app, token)

    first = app.request(
        "DELETE", f"/v1/resources/{material['resource']['id']}", headers=auth_header(token)
    )
    assert first.status == 200
    repeat = app.request(
        "DELETE", f"/v1/resources/{material['resource']['id']}", headers=auth_header(token)
    )

    assert repeat.status == 404
    assert repeat.json == error_example("error-cross-account-resource")["response"]["body"]


def test_delete_without_credentials_is_the_shared_401(start_app):
    app = start_app(seed_emails=[EMAIL_A])
    token = open_account(app, EMAIL_A)
    material = build_full_material(app, token)

    response = app.request("DELETE", f"/v1/resources/{material['resource']['id']}")

    assert response.status == 401
    assert response.json == error_example("error-unauthorized-missing-token")["response"]["body"]
    # Nothing was deleted.
    assert app.store.count("resources") == 1


def test_resolve_after_delete_answers_no_match(start_app):
    app = start_app(seed_emails=[EMAIL_A])
    token = open_account(app, EMAIL_A)
    material = build_full_material(app, token)
    deleted = app.request(
        "DELETE", f"/v1/resources/{material['resource']['id']}", headers=auth_header(token)
    )
    assert deleted.status == 200

    resolve = app.request(
        "POST",
        "/v1/sources/resolve",
        headers=auth_header(token),
        body={"url": "https://www.bilibili.com/video/BV1ab411L78c?p=2"},
    )

    assert resolve.status == 200
    assert resolve.json == {"matched": False}


def test_refavorite_after_delete_creates_a_new_resource(start_app):
    app = start_app(seed_emails=[EMAIL_A])
    token = open_account(app, EMAIL_A)
    material = build_full_material(app, token)
    old_resource_id = material["resource"]["id"]
    deleted = app.request(
        "DELETE", f"/v1/resources/{old_resource_id}", headers=auth_header(token)
    )
    assert deleted.status == 200

    refavorite = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body={"url": "https://www.bilibili.com/video/BV1ab411L78c?p=2", "title": "重新收藏"},
    )

    assert refavorite.status == 201, "the deleted id no longer matches — a fresh create"
    new_resource = refavorite.json["resource"]
    assert new_resource["id"] != old_resource_id
    detail = app.request(
        "GET", f"/v1/resources/{new_resource['id']}", headers=auth_header(token)
    )
    assert detail.status == 200
    assert detail.json["sources"][0]["id"] != material["source"]["id"]


def test_deleting_one_resource_leaves_the_others_of_the_same_account_untouched(start_app):
    app = start_app(seed_emails=[EMAIL_A])
    token = open_account(app, EMAIL_A)
    doomed = build_full_material(app, token, label="doomed", episode="2")
    survivor = build_full_material(app, token, label="survivor", episode="3")

    response = app.request(
        "DELETE", f"/v1/resources/{doomed['resource']['id']}", headers=auth_header(token)
    )
    assert response.status == 200

    # The survivor keeps every row (one resource + one source + progress +
    # note + session + transcript + insight + digest + summary each).
    assert app.store.count("resources") == 1
    assert app.store.count("sources") == 1
    assert app.store.count("progress") == 1
    assert app.store.count("notes") == 1
    assert app.store.count("sessions") == 1
    assert app.store.count("transcripts") == 1
    assert app.store.count("sessionInsights") == 1
    assert app.store.count("sessionDigests") == 1
    assert app.store.count("summaries") == 1
    detail = app.request(
        "GET", f"/v1/resources/{survivor['resource']['id']}", headers=auth_header(token)
    )
    assert detail.status == 200
    assert detail.json["resource"]["id"] == survivor["resource"]["id"]
