"""GET /v1/resources and GET /v1/resources/{id} (Ticket P4, issue #53).
Python port of test/resources-list-detail.test.js.

Seam: the /v1 HTTP endpoints against the P1 fixtures. The list example
shows the state after the fixture progress chain (api-progress-update:
positionMs 250000, revision 2) — that chain's end state is seeded through
the store seam as fixture setup; every assertion still goes through HTTP.
Notes are the real read-back (P12) — empty here because nothing was
created yet."""

import pytest

from helpers import api_example, auth_header, error_example, open_account, parse_ms

LEARNER = "learner@example.com"
OWNER = "owner@example.com"
OTHER = "other@example.com"

# The fixture create examples pin 08:00:00Z (bilibili) and 08:05:00Z
# (generic); the injected clock reproduces exactly those strings.
FIXTURE_CREATE_TIMES = {
    "bilibili": "2026-11-10T08:00:00Z",
    "generic": "2026-11-10T08:05:00Z",
}


def replay_create_samples(app, token, clock):
    """Favorite the fixture create samples with the clock pinned to the
    fixture timestamps. Returns {bilibili, generic} response bodies."""
    bilibili_example = api_example("api-resources-create-bilibili-p2")
    generic_example = api_example("api-resources-create-generic-webpage")

    clock["ms"] = parse_ms(FIXTURE_CREATE_TIMES["bilibili"])
    bilibili = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=bilibili_example["request"]["body"]
    )
    assert bilibili.status == 201

    clock["ms"] = parse_ms(FIXTURE_CREATE_TIMES["generic"])
    generic = app.request(
        "POST", "/v1/resources", headers=auth_header(token), body=generic_example["request"]["body"]
    )
    assert generic.status == 201
    return {"bilibili": bilibili.json, "generic": generic.json}


def test_list_returns_the_accounts_favorites_newest_first_with_per_source_progress(start_app):
    example = api_example("api-resources-list")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    created = replay_create_samples(app, token, clock)
    bilibili, generic = created["bilibili"], created["generic"]

    # The fixture chain end state (api-progress-update) on the bilibili
    # source; the write endpoint itself is exercised in sources-progress.
    app.store.set("progress", bilibili["source"]["id"], {"positionMs": 250000, "revision": 2})

    response = app.request("GET", "/v1/resources", headers=auth_header(token))
    assert response.status == example["response"]["status"]
    items = response.json["resources"]
    assert len(items) == 2

    # Newest first: generic (08:05) before bilibili (08:00) — fixture order.
    generic_item, bilibili_item = items
    assert generic_item["resource"] == {
        "id": generic["resource"]["id"],
        "title": generic["resource"]["title"],
        "kind": "webpage",
        "createdAt": FIXTURE_CREATE_TIMES["generic"],
    }
    assert generic_item["sources"] == [generic["source"]]

    assert bilibili_item["resource"] == {
        "id": bilibili["resource"]["id"],
        "title": bilibili["resource"]["title"],
        "kind": "video",
        "createdAt": FIXTURE_CREATE_TIMES["bilibili"],
    }
    assert bilibili_item["sources"] == [
        {**bilibili["source"], "progress": {"positionMs": 250000, "revision": 2}}
    ]

    # The fixture list body, with opaque ids mapped onto the live ones.
    fixture_generic = example["response"]["body"]["resources"][0]
    fixture_bilibili = example["response"]["body"]["resources"][1]
    assert {
        "createdAt": bilibili_item["resource"]["createdAt"],
        "sourceUrl": bilibili_item["sources"][0]["url"],
        "progress": bilibili_item["sources"][0]["progress"],
        "identity": {
            "platformId": bilibili_item["sources"][0]["platformId"],
            "platformVideoId": bilibili_item["sources"][0]["platformVideoId"],
            "episodeId": bilibili_item["sources"][0]["episodeId"],
            "platformScopeId": bilibili_item["sources"][0]["platformScopeId"],
        },
    } == {
        "createdAt": fixture_bilibili["resource"]["createdAt"],
        "sourceUrl": fixture_bilibili["sources"][0]["url"],
        "progress": fixture_bilibili["sources"][0]["progress"],
        "identity": {
            "platformId": fixture_bilibili["sources"][0]["platformId"],
            "platformVideoId": fixture_bilibili["sources"][0]["platformVideoId"],
            "episodeId": fixture_bilibili["sources"][0]["episodeId"],
            "platformScopeId": fixture_bilibili["sources"][0]["platformScopeId"],
        },
    }, "list mirrors the fixture sample with live ids"
    assert generic_item["resource"]["createdAt"] == fixture_generic["resource"]["createdAt"]


def test_detail_returns_resource_sources_with_progress_and_notes(start_app):
    example = api_example("api-resources-detail-with-notes")
    clock = {"ms": 0}
    app = start_app(seed_emails=[LEARNER], now=lambda: clock["ms"])
    token = open_account(app, LEARNER)
    bilibili = replay_create_samples(app, token, clock)["bilibili"]
    app.store.set("progress", bilibili["source"]["id"], {"positionMs": 250000, "revision": 2})

    response = app.request(
        "GET", f"/v1/resources/{bilibili['resource']['id']}", headers=auth_header(token)
    )
    assert response.status == example["response"]["status"]
    assert response.json["resource"] == bilibili["resource"]
    assert response.json["resource"]["createdAt"] == FIXTURE_CREATE_TIMES["bilibili"]
    assert response.json["sources"] == [
        {**bilibili["source"], "progress": {"positionMs": 250000, "revision": 2}}
    ]
    assert response.json["sources"][0]["progress"] == example["response"]["body"]["sources"][0][
        "progress"
    ], "detail progress equals the fixture chain end state"
    # Round 1 data only so far: no notes were created on this resource.
    assert response.json["notes"] == []


def test_another_accounts_resource_id_is_a_404_indistinguishable_from_unknown(start_app):
    example = error_example("error-cross-account-resource")
    clock = {"ms": 0}
    app = start_app(seed_emails=[OWNER, OTHER], now=lambda: clock["ms"])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    bilibili = replay_create_samples(app, owner, clock)["bilibili"]

    for resource_id in [bilibili["resource"]["id"], "res_does-not-exist"]:
        response = app.request(
            "GET", f"/v1/resources/{resource_id}", headers=auth_header(other)
        )
        assert response.status == example["response"]["status"]
        assert response.json == example["response"]["body"]


def test_each_accounts_list_only_shows_its_own_favorites(start_app):
    clock = {"ms": 0}
    app = start_app(seed_emails=[OWNER, OTHER], now=lambda: clock["ms"])
    owner = open_account(app, OWNER)
    other = open_account(app, OTHER)
    created = replay_create_samples(app, owner, clock)
    bilibili, generic = created["bilibili"], created["generic"]

    other_list = app.request("GET", "/v1/resources", headers=auth_header(other))
    assert other_list.status == 200
    assert other_list.json == {"resources": []}, "no cross-account leakage"

    owner_list = app.request("GET", "/v1/resources", headers=auth_header(owner))
    assert owner_list.status == 200
    assert sorted(item["resource"]["id"] for item in owner_list.json["resources"]) == sorted(
        [bilibili["resource"]["id"], generic["resource"]["id"]]
    )
    assert all(
        source["resourceId"] == item["resource"]["id"]
        for item in owner_list.json["resources"]
        for source in item["sources"]
    )


def test_list_requires_credentials(start_app):
    example = error_example("error-unauthorized-missing-token")
    app = start_app(seed_emails=[LEARNER])
    response = app.request("GET", "/v1/resources")
    assert response.status == example["response"]["status"]
    assert response.json == example["response"]["body"]
