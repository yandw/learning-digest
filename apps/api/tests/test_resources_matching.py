"""Matching semantics end-to-end (Ticket P4, issue #53). Python port of
test/resources-matching.test.js.

Seam: the /v1 HTTP endpoints. The source-matching.json samples are
favorited into one account WITHOUT a declared identity, so the
server-side fallback extraction drives every decision — the fixture
same-source/different-source relations must hold through the API exactly
as the contract test holds them through the module. A second pass
re-resolves every sample with client-supplied identity (what the plugin
does) and must land on the same Sources. Dual-account concurrency closes
the isolation story (decision 1 rule 4, D2, D8)."""

import pytest

from app.platform_video_id import extract_video_identity
from helpers import api_example, auth_header, matching_samples, open_account

LEARNER = "learner@example.com"
A = "a@example.com"
B = "b@example.com"


def test_fixture_matching_relations_hold_end_to_end_driven_by_server_side_extraction(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source_ids = {}
    resource_ids = {}
    original_urls = {}

    for sample in matching_samples():
        response = app.request(
            "POST",
            "/v1/resources",
            headers=auth_header(token),
            # No identity: the server must extract/normalize on its own.
            body={"url": sample["url"], "title": sample.get("title")},
        )
        # A sample re-favoriting an earlier one (matchesSameSourceAs) gets
        # 200 with the same Resource + Source; every other sample is new.
        same = sample["expect"].get("matchesSameSourceAs")
        expect_duplicate = same is not None and same in source_ids
        assert response.status == (200 if expect_duplicate else 201), (
            f"{sample['id']}: {'duplicate favorite (200)' if expect_duplicate else 'first favorite (201)'}"
        )
        if expect_duplicate:
            assert response.json["source"]["id"] == source_ids[same]
        source_ids[sample["id"]] = response.json["source"]["id"]
        resource_ids[sample["id"]] = response.json["resource"]["id"]
        # source.url is the first-favorited address, preserved on duplicates.
        original_urls[sample["id"]] = response.json["source"]["url"]

    for sample in matching_samples():
        same = sample["expect"].get("matchesSameSourceAs")
        if same is not None:
            assert source_ids[sample["id"]] == source_ids[same], (
                f"{sample['id']} must share the Source of {same}"
            )
            assert original_urls[sample["id"]] == original_urls[same], (
                f"{sample['id']}: duplicate favorite keeps the first-favorited URL"
            )
        diff = sample["expect"].get("differsFromSourceOf")
        if diff is not None:
            assert source_ids[sample["id"]] != source_ids[diff], (
                f"{sample['id']} must be an independent Source from {diff}"
            )
            assert resource_ids[sample["id"]] != resource_ids[diff]

    # Same-title different-video acceptance: equal titles, separate data.
    a = next(s for s in matching_samples() if s["id"] == "match-same-title-video-a")
    b = next(s for s in matching_samples() if s["id"] == "match-same-title-video-b")
    assert a["title"] == b["title"]
    assert source_ids[a["id"]] != source_ids[b["id"]]

    # B 站多分集：p2/p3 same BV, separate Sources with separate identities.
    p2_id = "match-bilibili-multi-episode-p2"
    p3_id = "match-bilibili-multi-episode-p3"
    assert source_ids[p2_id] != source_ids[p3_id]


def test_client_supplied_identity_resolves_to_the_same_sources_as_server_extraction(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    source_ids = {}
    for sample in matching_samples():
        response = app.request(
            "POST",
            "/v1/resources",
            headers=auth_header(token),
            body={"url": sample["url"], "title": sample.get("title")},
        )
        assert response.status in (200, 201)
        source_ids[sample["id"]] = response.json["source"]["id"]

    for sample in matching_samples():
        identity = extract_video_identity(sample["url"])
        body = {"url": sample["url"], "identity": identity} if identity else {"url": sample["url"]}
        response = app.request(
            "POST", "/v1/sources/resolve", headers=auth_header(token), body=body
        )
        assert response.status == 200
        assert response.json["matched"] is True, f"{sample['id']}: resolve finds its own Source"
        assert response.json["source"]["id"] == source_ids[sample["id"]], (
            f"{sample['id']}: identity resolve lands on the same Source"
        )


def test_two_accounts_favoriting_the_same_url_concurrently_each_get_their_own_source(start_app):
    example = api_example("api-resources-create-bilibili-p2")
    app = start_app(seed_emails=[A, B])
    a = open_account(app, A)
    b = open_account(app, B)

    first = app.request(
        "POST", "/v1/resources", headers=auth_header(a), body=example["request"]["body"]
    )
    second = app.request(
        "POST", "/v1/resources", headers=auth_header(b), body=example["request"]["body"]
    )
    assert first.status == 201
    assert second.status == 201
    assert first.json["resource"]["id"] != second.json["resource"]["id"]
    assert first.json["source"]["id"] != second.json["source"]["id"]
    assert first.json["source"]["url"] == second.json["source"]["url"]
    assert {
        "platformId": second.json["source"]["platformId"],
        "platformVideoId": second.json["source"]["platformVideoId"],
        "episodeId": second.json["source"]["episodeId"],
        "platformScopeId": second.json["source"]["platformScopeId"],
    } == {
        "platformId": first.json["source"]["platformId"],
        "platformVideoId": first.json["source"]["platformVideoId"],
        "episodeId": first.json["source"]["episodeId"],
        "platformScopeId": first.json["source"]["platformScopeId"],
    }

    # Each account sees exactly one favorite — its own.
    for token, own in [(a, first.json), (b, second.json)]:
        list_response = app.request("GET", "/v1/resources", headers=auth_header(token))
        assert list_response.status == 200
        assert len(list_response.json["resources"]) == 1
        assert list_response.json["resources"][0]["resource"]["id"] == own["resource"]["id"]
        assert list_response.json["resources"][0]["sources"][0]["id"] == own["source"]["id"]

    # Re-favoriting inside one account still deduplicates (200).
    repeat = app.request(
        "POST", "/v1/resources", headers=auth_header(a), body=example["request"]["body"]
    )
    assert repeat.status == 200
    assert repeat.json["source"]["id"] == first.json["source"]["id"]


def test_a_declared_uppercase_hex_xiaohongshu_identity_validates(start_app):
    # The §1 format judgment is the platform module's formats table —
    # case-insensitive like the extractors and the recognition adapter, so
    # an uppercase-hex note identity is not a 400.
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    response = app.request(
        "POST",
        "/v1/resources",
        headers=auth_header(token),
        body={
            "url": "https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab23",
            "identity": {
                "platformId": "xiaohongshu",
                "platformVideoId": "66A1B2C3000000001E01AB23",
            },
        },
    )
    assert response.status == 201
    assert response.json["source"]["platformVideoId"] == "66A1B2C3000000001E01AB23"


def test_malformed_identity_declarations_are_rejected_with_validation_failed(start_app):
    app = start_app(seed_emails=[LEARNER])
    token = open_account(app, LEARNER)
    cases = [
        {"identity": "not-an-object"},
        {"identity": {"platformId": "vimeo", "platformVideoId": "12345"}},
        {"identity": {"platformId": "bilibili", "platformVideoId": "BV123"}},
        {
            "identity": {
                "platformId": "youtube",
                "platformVideoId": "dQw4w9WgXcQ",
                "platformScopeId": "shop",
            }
        },
        {"identity": {"platformId": "xiaoe-tech", "platformVideoId": "v_66a1b2c3d4e5"}},
        {"identity": {"platformId": "youtube", "platformVideoId": "dQw4w9WgXcQ", "episodeId": "2"}},
    ]
    for body in cases:
        response = app.request(
            "POST",
            "/v1/resources",
            headers=auth_header(token),
            body={"url": "https://www.example.com/whatever", **body},
        )
        assert response.status == 400, str(body)
        assert response.json["error"]["code"] == "validation_failed"

    # Nothing was created by the rejected requests.
    list_response = app.request("GET", "/v1/resources", headers=auth_header(token))
    assert list_response.json == {"resources": []}
