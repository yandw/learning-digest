/**
 * Source Platform registry: page recognition as a pure function over URL.
 *
 * Seam: the public API of source-platforms.js (registerSourcePlatform,
 * listSourcePlatforms, recognizePage). Recognition must be total — any
 * string input returns a recognition result, never throws — because the
 * side panel feeds it whatever the active tab's URL happens to be.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  registerSourcePlatform,
  listSourcePlatforms,
  recognizePage,
} = require("../source-platforms.js");

test("registry ships with the xiaoe-tech Source Platform", () => {
  const ids = listSourcePlatforms().map((platform) => platform.id);
  assert.ok(ids.includes("xiaoe-tech"));
});

test("registerSourcePlatform rejects an adapter without an id", () => {
  assert.throws(() => registerSourcePlatform({}), /id/);
});

test("registerSourcePlatform rejects a non-function recognizePage", () => {
  assert.throws(
    () => registerSourcePlatform({ id: "broken", recognizePage: "nope" }),
    /recognizePage/,
  );
});

test("xiaoe-tech live pages resolve to live with wall-clock timestamps", () => {
  for (const url of [
    "https://app12345.xiaoe-tech.com/live_player/l_abc123def456",
    "https://app12345.xiaoe-tech.com/live/l_abc123def456",
    "https://app12345.xiaoe-tech.com/l_abc123def456",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.platformId, "xiaoe-tech", url);
    assert.equal(result.kind, "live", url);
    assert.equal(result.timestampKind, "wallclock", url);
  }
});

test("xiaoe-tech replay pages resolve to replay with video-position timestamps", () => {
  for (const url of [
    "https://app12345.xiaoe-tech.com/replay/l_abc123def456",
    "https://app12345.xiaoe-tech.com/web/playback/v_abc123def456",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.platformId, "xiaoe-tech", url);
    assert.equal(result.kind, "replay", url);
    assert.equal(result.timestampKind, "video", url);
  }
});

test("xiaoe-tech course pages resolve to course with video-position timestamps", () => {
  for (const url of [
    "https://apptdemenwi8039.pc.xiaoe-tech.com/p/t_pc/goods_pc_detail/goods_detail/term_5f4380290ac80_9unBs1",
    "https://app12345.xiaoe-tech.com/p_abc123def456ghi",
    "https://app12345.xiaoe-tech.com/detail/v_abc123def456",
    "https://app12345.h5.xiaoe-tech.com/content_page/i_abc123def456",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.platformId, "xiaoe-tech", url);
    assert.equal(result.kind, "course", url);
    assert.equal(result.timestampKind, "video", url);
  }
});

test("any xiaoe-tech subdomain is treated as the platform", () => {
  for (const url of [
    "https://study.xiaoe-tech.com/replay/l_abc123def456",
    "https://my-shop.xiaoe-tech.com/live/l_abc123def456",
    "https://app12345.pc.xiaoe-tech.com/p_abc123def456",
  ]) {
    assert.equal(recognizePage(url).platformId, "xiaoe-tech", url);
  }
});

test("non-course xiaoe-tech pages resolve to none", () => {
  for (const url of [
    "https://app12345.xiaoe-tech.com/",
    "https://app12345.xiaoe-tech.com/user/login",
    "https://www.xiaoe-tech.com/",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.kind, "none", url);
    assert.equal(result.timestampKind, null, url);
  }
});

test("non-xiaoe-tech pages resolve to none", () => {
  const result = recognizePage("https://example.com/course/123");
  assert.equal(result.platformId, null);
  assert.equal(result.kind, "none");
  assert.equal(result.timestampKind, null);
});

test("recognizePage is total: malformed input resolves to none without throwing", () => {
  for (const input of ["not a url", "", null, undefined, 42, "xiaoe-tech.com/p_abc"]) {
    const result = recognizePage(input);
    assert.equal(result.kind, "none", String(input));
    assert.equal(result.platformId, null, String(input));
  }
});

// --- bilibili Source Platform (P10b, #63) -----------------------------------
//
// Only real playback pages recognize: /video/<BV> on the desktop and mobile
// hosts, per contracts/platform-video-id-rules.md §1. b23.tv is a redirect
// host (no player of its own) — recognition stays "none" there and the
// redirect lands on /video/<BV> where injection happens.

test("registry ships with the bilibili Source Platform", () => {
  const ids = listSourcePlatforms().map((platform) => platform.id);
  assert.ok(ids.includes("bilibili"));
});

test("bilibili video pages resolve to video with video-position timestamps", () => {
  for (const url of [
    "https://www.bilibili.com/video/BV1ab411L78c",
    "https://www.bilibili.com/video/BV1ab411L78c?p=2",
    "https://m.bilibili.com/video/BV1ab411L78c",
    "https://www.bilibili.com/video/BV1ab411L78c/?spm_id_from=share",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.platformId, "bilibili", url);
    assert.equal(result.kind, "video", url);
    assert.equal(result.timestampKind, "video", url);
  }
});

test("non-video bilibili pages resolve to none", () => {
  for (const url of [
    "https://www.bilibili.com/",
    "https://search.bilibili.com/all?keyword=x",
    "https://www.bilibili.com/video/notABVid",
    "https://www.bilibili.com/video/BVshort",
    "https://b23.tv/BV1ab411L78c",
    "https://evil.example/video/BV1ab411L78c",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.kind, "none", url);
    assert.equal(result.platformId, null, url);
    assert.equal(result.timestampKind, null, url);
  }
});

// --- youtube Source Platform (P10b, #63) ------------------------------------
//
// Only the /watch playback page recognizes, with a well-formed v= id, on the
// three watch hosts. youtu.be is a redirect host (no player) — recognition
// stays "none" there and the redirect lands on www.youtube.com/watch.

test("registry ships with the youtube Source Platform", () => {
  const ids = listSourcePlatforms().map((platform) => platform.id);
  assert.ok(ids.includes("youtube"));
});

test("youtube watch pages resolve to video with video-position timestamps", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s&list=PLxyz",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.platformId, "youtube", url);
    assert.equal(result.kind, "video", url);
    assert.equal(result.timestampKind, "video", url);
  }
});

test("non-watch youtube pages and malformed ids resolve to none", () => {
  for (const url of [
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=waytoomanychar1",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://evil.example/watch?v=dQw4w9WgXcQ",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.kind, "none", url);
    assert.equal(result.platformId, null, url);
    assert.equal(result.timestampKind, null, url);
  }
});

// --- xiaohongshu Source Platform (P10b, #63) --------------------------------
//
// Note pages recognize (/explore/<id> and /discovery/item/<id>, 24-hex ids).
// The URL shape cannot tell a video note from an image-text one (contract
// decision D6), so the adapter commits to the video-note reading: those are
// the pages the learner opens to play. On an image-text page the page-bridge
// finds no media and the position stream simply stays quiet.

test("registry ships with the xiaohongshu Source Platform", () => {
  const ids = listSourcePlatforms().map((platform) => platform.id);
  assert.ok(ids.includes("xiaohongshu"));
});

test("xiaohongshu note pages resolve to video with video-position timestamps", () => {
  for (const url of [
    "https://www.xiaohongshu.com/explore/65f0abc123def4567890ab12",
    "https://www.xiaohongshu.com/explore/65f0abc123def4567890ab12?xsec_token=AbC&xsec_source=pc_share",
    "https://www.xiaohongshu.com/discovery/item/65f0abc123def4567890ab12",
    "https://www.xiaohongshu.com/discovery/item/65F0ABC123DEF4567890AB12",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.platformId, "xiaohongshu", url);
    assert.equal(result.kind, "video", url);
    assert.equal(result.timestampKind, "video", url);
  }
});

test("non-note xiaohongshu pages and malformed ids resolve to none", () => {
  for (const url of [
    "https://www.xiaohongshu.com/",
    "https://www.xiaohongshu.com/user/profile/5ff0e50b0000000001008400",
    "https://www.xiaohongshu.com/explore/shortid",
    "https://www.xiaohongshu.com/explore/65f0abc123def4567890ab1z",
    "https://www.xiaohongshu.com/search_result?keyword=x",
    "https://xhslink.com/xy9Kz2",
    "https://evil.example/explore/65f0abc123def4567890ab12",
  ]) {
    const result = recognizePage(url);
    assert.equal(result.kind, "none", url);
    assert.equal(result.platformId, null, url);
    assert.equal(result.timestampKind, null, url);
  }
});

test("the first registered platform whose recognition is not none wins", () => {
  registerSourcePlatform({
    id: "fake-always",
    recognizePage: () => ({ platformId: "fake-always", kind: "live", timestampKind: "wallclock" }),
  });
  // Registration order is fixed for the whole Node process: the fake
  // platform registered above comes after xiaoe-tech, so a xiaoe URL
  // still recognizes as xiaoe-tech...
  assert.equal(
    recognizePage("https://app12345.xiaoe-tech.com/live/l_abc123").platformId,
    "xiaoe-tech",
  );
  // ...while a non-xiaoe URL falls through to the fake platform.
  assert.equal(
    recognizePage("https://other.example/live").platformId,
    "fake-always",
  );
});

test("query strings and hashes do not affect recognition", () => {
  const bare = recognizePage("https://app12345.xiaoe-tech.com/live/l_abc123");
  const noisy = recognizePage(
    "https://app12345.xiaoe-tech.com/live/l_abc123?scene=1&from=share#top",
  );
  assert.deepEqual(noisy, bare);
});
