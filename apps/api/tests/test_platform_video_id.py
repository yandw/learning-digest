"""Shared Platform Video ID extraction — Python port of the JS contract
test (contracts/platform-video-id.test.js; ticket 4.2 mirrors it 1:1).

Seam: app/platform_video_id.py exports extract_video_identity(url) and
normalize_url(url) — pure functions, zero dependencies, total (any input,
including garbage, returns a result and never throws). The expectations
are exactly the P1 fixtures: source-matching.json samples assert every
extraction/normalization result, and same-source / different-source
relations are re-derived through the module, not through fixture literals.

Authority note: this test consumes the SAME fixture file as the JS
contract test (contracts/fixtures/source-matching.json). The JS module
(contracts/platform-video-id.js) stays the plugin/Web implementation; the
Python module is the server-side authority. Same fixtures + the two
contract tests passing means the two implementations agree — there is no
third copy of the rules."""

import json
import pathlib

from app.platform_video_id import (
    PLATFORM_VIDEO_ID_FORMATS,
    extract_video_identity,
    normalize_url,
)

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
with open(REPO_ROOT / "contracts" / "fixtures" / "source-matching.json", encoding="utf-8") as _fh:
    SAMPLES = json.load(_fh)["samples"]

SAMPLE_BY_ID = {sample["id"]: sample for sample in SAMPLES}


def expected_identity_of(sample: dict) -> dict:
    """The identity tuple a sample's expect{} declares."""
    expect = sample["expect"]
    return {
        "platformId": expect.get("platformId"),
        "platformVideoId": expect.get("platformVideoId"),
        "episodeId": expect.get("episodeId"),
        "platformScopeId": expect.get("platformScopeId"),
    }


def matching_key_of(sample: dict) -> dict:
    """The matching key the module derives for a sample (rules §2): the
    extracted platform identity when the URL carries one, the normalized
    address otherwise."""
    identity = extract_video_identity(sample["url"])
    if identity:
        return {"strategy": "platform-identity", "identity": identity}
    return {"strategy": "url-exact", "url": normalize_url(sample["url"])}


# --- fixture-driven: every source-matching sample ---------------------------


def test_every_platform_identity_sample_extracts_its_declared_identity():
    checked = []
    for sample in SAMPLES:
        if sample["expect"]["matchStrategy"] != "platform-identity":
            continue
        checked.append(sample["id"])
        assert extract_video_identity(sample["url"]) == expected_identity_of(sample), (
            f"{sample['id']}: extraction must match the fixture identity"
        )
    # All four stations must be exercised by the fixture set.
    platforms = sorted({SAMPLE_BY_ID[i]["expect"]["platformId"] for i in checked})
    assert platforms == ["bilibili", "xiaoe-tech", "xiaohongshu", "youtube"], (
        "identity samples must cover all four stations"
    )


def test_every_url_exact_sample_normalizes_to_its_declared_address():
    checked = []
    for sample in SAMPLES:
        if sample["expect"]["matchStrategy"] != "url-exact":
            continue
        checked.append(sample["id"])
        assert normalize_url(sample["url"]) == sample["expect"]["normalizedUrl"], (
            f"{sample['id']}: normalized address must match the fixture"
        )
    assert len(checked) >= 4, "url-exact samples must be present"


def test_declared_same_source_relations_hold_through_the_module():
    for sample in SAMPLES:
        ref = sample["expect"].get("matchesSameSourceAs")
        if ref is None:
            continue
        assert matching_key_of(sample) == matching_key_of(SAMPLE_BY_ID[ref]), (
            f"{sample['id']} must match the same Source as {ref}"
        )


def test_declared_different_source_relations_hold_through_the_module():
    for sample in SAMPLES:
        ref = sample["expect"].get("differsFromSourceOf")
        if ref is None:
            continue
        assert matching_key_of(sample) != matching_key_of(SAMPLE_BY_ID[ref]), (
            f"{sample['id']} must be a different Source from {ref}"
        )


# --- bilibili ----------------------------------------------------------------


def test_bilibili_p_default_explicit_p1_and_p_value_normalization():
    base = "https://www.bilibili.com/video/BV1tx421c7ab"
    assert extract_video_identity(f"{base}/") == {
        "platformId": "bilibili",
        "platformVideoId": "BV1tx421c7ab",
        "episodeId": "1",
        "platformScopeId": None,
    }
    assert extract_video_identity(f"{base}?p=1") == extract_video_identity(f"{base}/"), (
        "explicit p=1 matches the address without p"
    )
    assert extract_video_identity(f"{base}?p=02")["episodeId"] == "2", "p is the decimal value"
    assert (
        extract_video_identity(f"{base}?p=abc")["episodeId"] == "1"
    ), "non-numeric p falls back to the default"
    assert extract_video_identity(f"{base}?p=3&t=42")["episodeId"] == "3"


def test_bilibili_non_video_paths_and_malformed_bv_ids_yield_no_identity():
    assert extract_video_identity("https://www.bilibili.com/read/cv25512345") is None
    assert extract_video_identity("https://www.bilibili.com/video/av12345678") is None
    assert extract_video_identity("https://www.bilibili.com/video/BV123") is None
    assert extract_video_identity("https://m.bilibili.com/video/BV1ab411L78c?p=2")["episodeId"] == "2"
    assert extract_video_identity("https://www.bilibili.com") is None


def test_b23tv_short_links_only_carry_identity_when_the_bv_is_present():
    assert extract_video_identity("https://b23.tv/BV1ab411L78c?p=2") == {
        "platformId": "bilibili",
        "platformVideoId": "BV1ab411L78c",
        "episodeId": "2",
        "platformScopeId": None,
    }
    assert (
        extract_video_identity("https://b23.tv/xy9Kz2a") is None
    ), "unresolvable short code (D8)"
    assert extract_video_identity("https://b23.tv/") is None


# --- youtube -----------------------------------------------------------------


def test_youtube_watch_page_and_youtube_short_link_extract_the_same_identity():
    watch = extract_video_identity("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    short = extract_video_identity("https://youtu.be/dQw4w9WgXcQ")
    assert watch == {
        "platformId": "youtube",
        "platformVideoId": "dQw4w9WgXcQ",
        "episodeId": None,
        "platformScopeId": None,
    }
    assert short == watch
    assert extract_video_identity("https://music.youtube.com/watch?v=dQw4w9WgXcQ") == watch, (
        "music.youtube.com is a youtube host"
    )


def test_youtube_non_watch_pages_and_malformed_ids_yield_no_identity():
    assert extract_video_identity("https://www.youtube.com/watch") is None
    assert extract_video_identity("https://www.youtube.com/watch?v=short-id7") is None
    assert extract_video_identity("https://www.youtube.com/shorts/dQw4w9WgXcQ") is None
    assert extract_video_identity("https://www.youtube.com/feed/library") is None
    assert extract_video_identity("https://youtu.be/") is None


# --- xiaoe-tech ---------------------------------------------------------------


def test_xiaoe_tech_identity_is_shop_subdomain_plus_resource_token():
    assert extract_video_identity("https://appdemo.xiaoe-tech.com/v_66a1b2c3d4e5") == {
        "platformId": "xiaoe-tech",
        "platformVideoId": "v_66a1b2c3d4e5",
        "episodeId": None,
        "platformScopeId": "appdemo",
    }
    assert (
        extract_video_identity("https://appdemo.xiaoe-tech.com/l_77c1b2d3e4f5")["platformVideoId"]
        == "l_77c1b2d3e4f5"
    ), "live/replay tokens extract too"
    assert (
        extract_video_identity("https://appdemo.xiaoe-tech.com/a_88d1b2e3f4a5")["platformVideoId"]
        == "a_88d1b2e3f4a5"
    )


def test_xiaoe_tech_container_pages_yield_no_identity_url_exact():
    assert extract_video_identity("https://appdemo.xiaoe-tech.com/term_66a1b2c3d4e5") is None
    assert extract_video_identity("https://appdemo.xiaoe-tech.com/goods_pc_detail?id=p_66a1") is None
    assert extract_video_identity("https://appdemo.xiaoe-tech.com/detail?v=1") is None


def test_xiaoe_tech_term_next_to_v_takes_v_as_the_identity():
    assert extract_video_identity("https://appdemo.xiaoe-tech.com/term_66a1b2/v_66a1b2c3d4e5") == {
        "platformId": "xiaoe-tech",
        "platformVideoId": "v_66a1b2c3d4e5",
        "episodeId": None,
        "platformScopeId": "appdemo",
    }


def test_xiaoe_tech_tokens_shorter_than_4_chars_or_without_a_subdomain():
    assert extract_video_identity("https://appdemo.xiaoe-tech.com/v_abc") is None
    assert (
        extract_video_identity("https://xiaoe-tech.com/v_66a1b2c3d4e5")["platformScopeId"] is None
    ), "no shop subdomain -> null platformScopeId"


# --- platformVideoIdFormats ----------------------------------------------------


def test_platform_video_id_formats_exports_the_formats_as_contract_data():
    # The single format-judgment source: the API's declared-identity
    # validation consumes this map instead of re-declaring the regexes.
    assert sorted(PLATFORM_VIDEO_ID_FORMATS.keys()) == [
        "bilibili",
        "xiaoe-tech",
        "xiaohongshu",
        "youtube",
    ]
    assert PLATFORM_VIDEO_ID_FORMATS["bilibili"].fullmatch("BV1ab411L78c")
    assert PLATFORM_VIDEO_ID_FORMATS["xiaoe-tech"].fullmatch("v_66a1b2c3d4e5")
    assert PLATFORM_VIDEO_ID_FORMATS["youtube"].fullmatch("dQw4w9WgXcQ")
    assert PLATFORM_VIDEO_ID_FORMATS["xiaohongshu"].fullmatch("66A1B2C3000000001E01AB23")
    assert not PLATFORM_VIDEO_ID_FORMATS["bilibili"].fullmatch("BV123")


# --- xiaohongshu ---------------------------------------------------------------


def test_xiaohongshu_note_id_extracts_from_both_path_shapes():
    explore = extract_video_identity(
        "https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab23"
    )
    assert explore == {
        "platformId": "xiaohongshu",
        "platformVideoId": "66a1b2c3000000001e01ab23",
        "episodeId": None,
        "platformScopeId": None,
    }
    assert (
        extract_video_identity(
            "https://www.xiaohongshu.com/discovery/item/66a1b2c3000000001e01ab23"
        )
        == explore
    ), "discovery/item is the same note identity"


def test_xiaohongshu_uppercase_hex_note_ids_extract_too():
    # The recognition adapter (source-platforms.js NOTE_ID_RE) has always
    # been case-insensitive; the extractor now agrees, so an uppercase-hex
    # note URL cannot recognize as a video page yet fail identity extraction.
    explore = extract_video_identity(
        "https://www.xiaohongshu.com/explore/66A1B2C3000000001E01AB23"
    )
    assert explore == {
        "platformId": "xiaohongshu",
        "platformVideoId": "66A1B2C3000000001E01AB23",
        "episodeId": None,
        "platformScopeId": None,
    }
    assert (
        extract_video_identity(
            "https://www.xiaohongshu.com/discovery/item/66A1B2C3000000001E01AB23"
        )
        == explore
    ), "discovery/item is the same note identity"


def test_xiaohongshu_malformed_ids_and_short_links_yield_no_identity():
    assert (
        extract_video_identity("https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab2")
        is None
    ), "23 hex digits are not a note id"
    assert (
        extract_video_identity("https://www.xiaohongshu.com/explore/66a1b2c3000000001e01abz")
        is None
    ), "non-hex digits are not a note id"
    assert (
        extract_video_identity("https://www.xiaohongshu.com/user/profile/5ffd1a05000000000100712c")
        is None
    )
    assert (
        extract_video_identity("https://xhslink.com/xy9Kz2a") is None
    ), "xhslink short code is not locally confirmable (D8)"


# --- normalization details ------------------------------------------------------


def test_normalization_drops_fragments_and_utm_tracking_params():
    assert (
        normalize_url("https://www.example.com/articles/habit#section-2")
        == "https://www.example.com/articles/habit"
    )
    assert (
        normalize_url("https://www.example.com/a?utm_source=x&utm_medium=y&utm_campaign=z&keep=1")
        == "https://www.example.com/a?keep=1"
    )
    assert (
        normalize_url("https://www.example.com/a?utm_Source=x") == "https://www.example.com/a"
    ), "utm_ matching is case-insensitive"


def test_normalization_keeps_platform_ignore_lists_and_sorts_the_rest():
    assert (
        normalize_url(
            "https://www.bilibili.com/video/BV1tx421c7ab?spm_id_from=333&vd_source=x&p=2&buvid=y"
        )
        == "https://www.bilibili.com/video/BV1tx421c7ab?p=2"
    ), "bilibili share params drop, p stays"
    assert (
        normalize_url("https://www.youtube.com/watch?v=abc&t=90&si=share&index=3")
        == "https://www.youtube.com/watch?v=abc"
    ), "youtube share params drop, v stays"
    assert (
        normalize_url(
            "https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab23?xsec_token=A&xsec_source=pc&keep=1"
        )
        == "https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab23?keep=1"
    )
    assert (
        normalize_url("https://appdemo.xiaoe-tech.com/v_66a1b2c3d4e5?app_id=appxyz")
        == "https://appdemo.xiaoe-tech.com/v_66a1b2c3d4e5"
    ), "xiaoe app_id drops"
    assert (
        normalize_url("https://www.example.com/a?z=1&a=2&m=3&b=4")
        == "https://www.example.com/a?a=2&b=4&m=3&z=1"
    ), "unknown platforms only drop utm_*; the rest is name-sorted"


def test_normalization_lowercases_the_host_and_keeps_the_raw_path():
    assert (
        normalize_url("https://EXAMPLE.com/Articles/Habit") == "https://example.com/Articles/Habit"
    )


def test_normalization_and_extraction_are_total_garbage_in_null_out_never_throw():
    garbage = [
        None,
        "",
        "   ",
        "not a url",
        "ftp://files.example.com/course.zip",
        "javascript:alert(1)",
        "mailto:someone@example.com",
        "/relative/path",
        "https://",
        42,
        {},
        [],
        object(),
    ]
    for value in garbage:
        assert extract_video_identity(value) is None, f"extract({value!r})"
        assert normalize_url(value) is None, f"normalize({value!r})"
    # Non-garbage but exotic URLs still answer without throwing.
    assert extract_video_identity("https://例え.テスト/视频?v=abc") is None
    assert normalize_url("https://例え.テスト/视频?v=abc") is not None
