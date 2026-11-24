import json

import httpx
import pytest

from helpers import auth_header, open_account


LEARNER = "learner@example.com"
EPISODE_ID = "6afde79ea4a79edf137b6820"
EPISODE_URL = f"https://www.xiaoyuzhoufm.com/episode/{EPISODE_ID}"
SHARE_URL = f"https://xiaoyuzhoufm.com/episode/{EPISODE_ID.upper()}/?s=share#notes"


@pytest.fixture
def vendor(monkeypatch):
    requests = []
    outcome = [httpx.ConnectError("connection failed")]

    async def respond(_transport, request):
        requests.append(request)
        response = outcome[0]
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", respond)
    return requests, outcome


def test_episode_share_links_reuse_a_favorite_even_when_metadata_is_unavailable(start_app, vendor):
    app = start_app(seed_emails=[LEARNER])
    headers = auth_header(open_account(app, LEARNER))
    first = app.request("POST", "/v1/resources", headers=headers, body={"url": SHARE_URL})
    assert first.status == 201
    assert first.json["resource"]["title"] == EPISODE_URL
    assert first.json["source"]["url"] == EPISODE_URL
    assert first.json["source"]["platformId"] == "xiaoyuzhou"
    assert first.json["source"]["platformVideoId"] == EPISODE_ID

    second = app.request("POST", "/v1/resources", headers=headers, body={"url": EPISODE_URL})
    assert second.status == 200
    assert second.json == first.json
    assert [str(request.url) for request in vendor[0]] == [EPISODE_URL]


def test_existing_generic_favorite_is_reused_by_resolve_and_save(start_app, vendor):
    app = start_app(seed_emails=[LEARNER])
    headers = auth_header(open_account(app, LEARNER))
    legacy = app.request(
        "POST", "/v1/resources", headers=headers,
        body={"url": "https://example.com/old-link", "title": "My original title"},
    ).json
    source_id = legacy["source"]["id"]
    resource_id = legacy["resource"]["id"]
    # Load a generic Source as it was stored before episode recognition existed.
    source = app.store.get("sources", source_id)
    app.store.set("sources", source_id, {**source, "url": SHARE_URL, "normalizedUrl": SHARE_URL})
    note = app.request(
        "POST", f"/v1/resources/{resource_id}/notes", headers=headers,
        body={"text": "My original note", "clientRequestId": "legacy-note"},
    )
    assert note.status == 201
    progress = app.request(
        "PUT", f"/v1/sources/{source_id}/progress", headers=headers,
        body={"positionMs": 24000, "expectedRevision": 0, "clientRequestId": "legacy-pos"},
    )
    assert progress.status == 200

    resolved = app.request("POST", "/v1/sources/resolve", headers=headers, body={"url": EPISODE_URL})
    assert resolved.json["matched"] is True
    assert resolved.json["source"]["id"] == source_id
    assert resolved.json["source"]["progress"]["positionMs"] == 24000
    assert vendor[0] == []

    duplicate = app.request("POST", "/v1/resources", headers=headers, body={"url": EPISODE_URL})
    assert duplicate.status == 200
    assert duplicate.json["resource"]["id"] == resource_id
    assert duplicate.json["resource"]["title"] == "My original title"
    assert duplicate.json["source"]["id"] == source_id
    assert duplicate.json["source"]["platformId"] == "xiaoyuzhou"
    detail = app.request("GET", f"/v1/resources/{resource_id}", headers=headers)
    assert detail.json["notes"][0]["text"] == "My original note"
    assert detail.json["sources"][0]["progress"]["positionMs"] == 24000


def test_public_metadata_is_shown_in_library_and_detail(start_app, vendor):
    episode = {
        "eid": EPISODE_ID,
        "title": "How to read a paper",
        "podcast": {"title": "Research Notes"},
        "duration": 3661,
        "description": "Short description",
        "shownotes": "<p>First &amp; second</p><p>Next steps</p>",
        "payType": "FREE",
        "isPrivateMedia": False,
        "video": {"available": True},
    }
    data = json.dumps({"props": {"pageProps": {"episode": episode}}})
    html = f'<html><script id="__NEXT_DATA__" type="application/json">{data}</script></html>'
    vendor[1][0] = httpx.Response(200, stream=httpx.ByteStream(html.encode()))
    app = start_app(seed_emails=[LEARNER])
    headers = auth_header(open_account(app, LEARNER))
    saved = app.request(
        "POST", "/v1/resources", headers=headers, body={"url": EPISODE_URL, "title": "Browser tab title"}
    )
    assert saved.status == 201
    resource = saved.json["resource"]
    assert (resource["title"], resource["kind"]) == ("How to read a paper", "video")
    library = app.request("GET", "/v1/resources", headers=headers).json["resources"][0]
    detail = app.request("GET", f"/v1/resources/{resource['id']}", headers=headers).json
    assert library["resource"]["title"] == "How to read a paper"
    assert library["sources"][0]["podcastTitle"] == "Research Notes"
    source = detail["sources"][0]
    assert source["url"] == EPISODE_URL
    assert source["durationMs"] == 3661000
    assert source["showNotes"] == "First & second\nNext steps"


@pytest.mark.parametrize("url", [
    EPISODE_URL.replace("/episode/", "/podcast/"),
    EPISODE_URL.replace("https:", "http:"),
    EPISODE_URL.replace(".com", ".com.example"),
    EPISODE_URL.replace(".com", ".com:444"),
    EPISODE_URL.replace("www.", "@www."),
    EPISODE_URL.replace("xiaoyuzhou", "xıaoyuzhou"),
])
def test_only_supported_episode_addresses_fetch_metadata(start_app, vendor, url):
    app = start_app(seed_emails=[LEARNER])
    headers = auth_header(open_account(app, LEARNER))
    saved = app.request("POST", "/v1/resources", headers=headers, body={"url": url})
    assert saved.status == 201
    assert saved.json["source"]["kind"] == "webpage"
    forged = app.request(
        "POST", "/v1/resources", headers=headers,
        body={"url": url, "identity": {"platformId": "xiaoyuzhou", "platformVideoId": EPISODE_ID}},
    )
    assert forged.status == 400
    assert vendor[0] == []


@pytest.mark.parametrize("response", [
    httpx.Response(302, headers={"Location": "https://example.com/redirect"}),
    httpx.Response(200, stream=httpx.ByteStream(b"x" * (2 * 1024 * 1024 + 1))),
    httpx.Response(200, stream=httpx.ByteStream(b"<script id=__NEXT_DATA__>{</script>")),
])
def test_redirects_oversized_html_and_parse_errors_fall_back_to_the_link(start_app, vendor, response):
    vendor[1][0] = response
    app = start_app(seed_emails=[LEARNER])
    headers = auth_header(open_account(app, LEARNER))
    saved = app.request("POST", "/v1/resources", headers=headers, body={"url": EPISODE_URL})
    assert saved.status == 201
    assert saved.json["resource"]["title"] == EPISODE_URL
    assert "showNotes" not in saved.json["source"]
    assert [str(request.url) for request in vendor[0]] == [EPISODE_URL]
