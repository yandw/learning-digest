"""Public episode HTML from the fixed Xiaoyuzhou origin."""

import asyncio
import json
from html.parser import HTMLParser

import httpx

from .platform_video_id import XIAOYUZHOU_EPISODE_ID_RE, XIAOYUZHOU_ORIGIN

_MAX_EPISODE_HTML_BYTES = 2 * 1024 * 1024
_FETCH_SECONDS = 3


async def _fetch_episode_html(episode_id: str) -> bytes:
    if not XIAOYUZHOU_EPISODE_ID_RE.fullmatch(episode_id):
        return b""
    url = f"{XIAOYUZHOU_ORIGIN}/episode/{episode_id}"
    try:
        async with (
            asyncio.timeout(_FETCH_SECONDS),
            httpx.AsyncClient(trust_env=False, follow_redirects=False) as client,
            client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response,
        ):
            if response.status_code != 200 or response.headers.get("Content-Encoding", "identity") != "identity":
                return b""
            html = bytearray()
            async for chunk in response.aiter_raw():
                if len(html) + len(chunk) > _MAX_EPISODE_HTML_BYTES:
                    return b""
                html.extend(chunk)
            return bytes(html)
    except (httpx.HTTPError, TimeoutError):
        return b""


class _NextData(HTMLParser):
    def __init__(self):
        super().__init__()
        self.capturing = False
        self.text = ""

    def handle_starttag(self, tag, attrs):
        if tag == "script" and not self.text:
            self.capturing = dict(attrs).get("id") == "__NEXT_DATA__"

    def handle_endtag(self, tag):
        if tag == "script":
            self.capturing = False

    def handle_data(self, data):
        if self.capturing:
            self.text = data


class _ShowNotes(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hidden = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden = True
        elif tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.hidden = False
        elif tag in {"p", "div", "li", "ul", "ol", "blockquote", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _text(value, limit):
    if not isinstance(value, str):
        return None
    return value.strip()[:limit].encode("utf-8", errors="replace").decode("utf-8") or None


async def read_episode_metadata(episode_id: str) -> dict:
    html = await _fetch_episode_html(episode_id)
    if not html:
        return {}
    data = _NextData()
    try:
        data.feed(html.decode("utf-8", errors="replace"))
        episode = json.loads(data.text)["props"]["pageProps"]["episode"]
        if (
            episode["eid"] != episode_id
            or episode["payType"] != "FREE"
            or episode["isPrivateMedia"] is not False
        ):
            return {}
        notes = _ShowNotes()
        if isinstance(episode.get("shownotes"), str):
            notes.feed(episode["shownotes"])
        show_notes = "\n".join(line.strip() for line in "".join(notes.parts).splitlines() if line.strip())
    except (KeyError, TypeError, ValueError, AssertionError, RecursionError):
        return {}

    podcast = episode.get("podcast")
    video = episode.get("video")
    duration = episode.get("duration")
    return {
        "title": _text(episode.get("title"), 500),
        "kind": "video" if isinstance(video, dict) and video.get("available") is True else "audio",
        "podcastTitle": _text(podcast.get("title"), 500) if isinstance(podcast, dict) else None,
        "durationMs": int(duration * 1000) if type(duration) in (int, float) and 0 < duration <= 86400 else None,
        "showNotes": _text(show_notes, 20000) or _text(episode.get("description"), 20000),
    }
