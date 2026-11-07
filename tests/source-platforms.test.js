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
