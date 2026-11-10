/**
 * Shared Platform Video ID extraction (Ticket P4, issue #53).
 *
 * Seam: contracts/platform-video-id.js exports extractVideoIdentity(url)
 * and normalizeUrl(url) — pure functions, zero dependencies, never throw.
 * The expectations are exactly the P1 fixtures: source-matching.json
 * samples assert every extraction/normalization result, and this test is
 * the "actual matching belongs to the implementation ticket" landing point
 * the contract test deferred — same-source / different-source relations
 * are re-derived here through the module, not through fixture literals.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { extractVideoIdentity, normalizeUrl } = require("./platform-video-id");

const { samples } = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "source-matching.json"), "utf8"),
);
const sampleById = new Map(samples.map((s) => [s.id, s]));

/** The identity tuple a sample's expect{} declares. */
function expectedIdentityOf(sample) {
  const expect = sample.expect;
  return {
    platformId: expect.platformId,
    platformVideoId: expect.platformVideoId,
    episodeId: expect.episodeId ?? null,
    platformScopeId: expect.platformScopeId ?? null,
  };
}

/**
 * The matching key the module derives for a sample (rules §2): the
 * extracted platform identity when the URL carries one, the normalized
 * address otherwise.
 */
function matchingKeyOf(sample) {
  const identity = extractVideoIdentity(sample.url);
  if (identity) {
    return { strategy: "platform-identity", identity };
  }
  return { strategy: "url-exact", url: normalizeUrl(sample.url) };
}

// --- fixture-driven: every source-matching sample ---------------------------

test("every platform-identity sample extracts its declared identity", () => {
  const checked = [];
  for (const sample of samples) {
    if (sample.expect.matchStrategy !== "platform-identity") continue;
    checked.push(sample.id);
    assert.deepEqual(
      extractVideoIdentity(sample.url),
      expectedIdentityOf(sample),
      `${sample.id}: extraction must match the fixture identity`,
    );
  }
  // All four stations must be exercised by the fixture set.
  const platforms = new Set(
    checked.map((id) => sampleById.get(id).expect.platformId),
  );
  assert.deepEqual(
    [...platforms].sort(),
    ["bilibili", "xiaoe-tech", "xiaohongshu", "youtube"],
    "identity samples must cover all four stations",
  );
});

test("every url-exact sample normalizes to its declared address", () => {
  const checked = [];
  for (const sample of samples) {
    if (sample.expect.matchStrategy !== "url-exact") continue;
    checked.push(sample.id);
    assert.equal(
      normalizeUrl(sample.url),
      sample.expect.normalizedUrl,
      `${sample.id}: normalized address must match the fixture`,
    );
  }
  assert.ok(checked.length >= 4, "url-exact samples must be present");
});

test("declared same-source relations hold through the module", () => {
  for (const sample of samples) {
    const ref = sample.expect.matchesSameSourceAs;
    if (ref === undefined) continue;
    assert.deepEqual(
      matchingKeyOf(sample),
      matchingKeyOf(sampleById.get(ref)),
      `${sample.id} must match the same Source as ${ref}`,
    );
  }
});

test("declared different-source relations hold through the module", () => {
  for (const sample of samples) {
    const ref = sample.expect.differsFromSourceOf;
    if (ref === undefined) continue;
    assert.notDeepEqual(
      matchingKeyOf(sample),
      matchingKeyOf(sampleById.get(ref)),
      `${sample.id} must be a different Source from ${ref}`,
    );
  }
});

// --- bilibili ----------------------------------------------------------------

test("bilibili p default, explicit p=1 and p value normalization", () => {
  const base = "https://www.bilibili.com/video/BV1tx421c7ab";
  assert.deepEqual(extractVideoIdentity(`${base}/`), {
    platformId: "bilibili",
    platformVideoId: "BV1tx421c7ab",
    episodeId: "1",
    platformScopeId: null,
  });
  assert.deepEqual(
    extractVideoIdentity(`${base}?p=1`),
    extractVideoIdentity(`${base}/`),
    "explicit p=1 matches the address without p",
  );
  assert.equal(extractVideoIdentity(`${base}?p=02`).episodeId, "2", "p is the decimal value");
  assert.equal(extractVideoIdentity(`${base}?p=abc`).episodeId, "1", "non-numeric p falls back to the default");
  assert.equal(extractVideoIdentity(`${base}?p=3&t=42`).episodeId, "3");
});

test("bilibili non-video paths and malformed BV ids yield no identity", () => {
  assert.equal(extractVideoIdentity("https://www.bilibili.com/read/cv25512345"), null);
  assert.equal(extractVideoIdentity("https://www.bilibili.com/video/av12345678"), null);
  assert.equal(extractVideoIdentity("https://www.bilibili.com/video/BV123"), null);
  assert.equal(extractVideoIdentity("https://m.bilibili.com/video/BV1ab411L78c?p=2").episodeId, "2");
  assert.equal(extractVideoIdentity("https://www.bilibili.com"), null);
});

test("b23.tv short links only carry identity when the BV is present", () => {
  assert.deepEqual(extractVideoIdentity("https://b23.tv/BV1ab411L78c?p=2"), {
    platformId: "bilibili",
    platformVideoId: "BV1ab411L78c",
    episodeId: "2",
    platformScopeId: null,
  });
  assert.equal(extractVideoIdentity("https://b23.tv/xy9Kz2a"), null, "unresolvable short code (D8)");
  assert.equal(extractVideoIdentity("https://b23.tv/"), null);
});

// --- youtube -----------------------------------------------------------------

test("youtube watch page and youtu.be short link extract the same identity", () => {
  const watch = extractVideoIdentity("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const short = extractVideoIdentity("https://youtu.be/dQw4w9WgXcQ");
  assert.deepEqual(watch, {
    platformId: "youtube",
    platformVideoId: "dQw4w9WgXcQ",
    episodeId: null,
    platformScopeId: null,
  });
  assert.deepEqual(short, watch);
  assert.deepEqual(
    extractVideoIdentity("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
    watch,
    "music.youtube.com is a youtube host",
  );
});

test("youtube non-watch pages and malformed ids yield no identity", () => {
  assert.equal(extractVideoIdentity("https://www.youtube.com/watch"), null);
  assert.equal(extractVideoIdentity("https://www.youtube.com/watch?v=short-id7"), null);
  assert.equal(extractVideoIdentity("https://www.youtube.com/shorts/dQw4w9WgXcQ"), null);
  assert.equal(extractVideoIdentity("https://www.youtube.com/feed/library"), null);
  assert.equal(extractVideoIdentity("https://youtu.be/"), null);
});

// --- xiaoe-tech ---------------------------------------------------------------

test("xiaoe-tech identity is shop subdomain plus resource token", () => {
  assert.deepEqual(extractVideoIdentity("https://appdemo.xiaoe-tech.com/v_66a1b2c3d4e5"), {
    platformId: "xiaoe-tech",
    platformVideoId: "v_66a1b2c3d4e5",
    episodeId: null,
    platformScopeId: "appdemo",
  });
  assert.equal(
    extractVideoIdentity("https://appdemo.xiaoe-tech.com/l_77c1b2d3e4f5").platformVideoId,
    "l_77c1b2d3e4f5",
    "live/replay tokens extract too",
  );
  assert.equal(
    extractVideoIdentity("https://appdemo.xiaoe-tech.com/a_88d1b2e3f4a5").platformVideoId,
    "a_88d1b2e3f4a5",
  );
});

test("xiaoe-tech container pages yield no identity (url-exact)", () => {
  assert.equal(extractVideoIdentity("https://appdemo.xiaoe-tech.com/term_66a1b2c3d4e5"), null);
  assert.equal(
    extractVideoIdentity("https://appdemo.xiaoe-tech.com/goods_pc_detail?id=p_66a1"),
    null,
  );
  assert.equal(
    extractVideoIdentity("https://appdemo.xiaoe-tech.com/detail?v=1"),
    null,
  );
});

test("xiaoe-tech term_ next to v_ takes v_ as the identity", () => {
  assert.deepEqual(
    extractVideoIdentity("https://appdemo.xiaoe-tech.com/term_66a1b2/v_66a1b2c3d4e5"),
    {
      platformId: "xiaoe-tech",
      platformVideoId: "v_66a1b2c3d4e5",
      episodeId: null,
      platformScopeId: "appdemo",
    },
  );
});

test("xiaoe-tech tokens shorter than 4 chars or without a subdomain", () => {
  assert.equal(extractVideoIdentity("https://appdemo.xiaoe-tech.com/v_abc"), null);
  assert.equal(
    extractVideoIdentity("https://xiaoe-tech.com/v_66a1b2c3d4e5").platformScopeId,
    null,
    "no shop subdomain -> null platformScopeId",
  );
});

// --- xiaohongshu ---------------------------------------------------------------

test("xiaohongshu note id extracts from both path shapes", () => {
  const explore = extractVideoIdentity("https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab23");
  assert.deepEqual(explore, {
    platformId: "xiaohongshu",
    platformVideoId: "66a1b2c3000000001e01ab23",
    episodeId: null,
    platformScopeId: null,
  });
  assert.deepEqual(
    extractVideoIdentity("https://www.xiaohongshu.com/discovery/item/66a1b2c3000000001e01ab23"),
    explore,
    "discovery/item is the same note identity",
  );
});

test("xiaohongshu malformed ids and short links yield no identity", () => {
  assert.equal(extractVideoIdentity("https://www.xiaohongshu.com/explore/66A1B2C3000000001E01AB23"), null, "hex is lowercase only");
  assert.equal(extractVideoIdentity("https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab2"), null);
  assert.equal(extractVideoIdentity("https://www.xiaohongshu.com/user/profile/5ffd1a05000000000100712c"), null);
  assert.equal(extractVideoIdentity("https://xhslink.com/xy9Kz2a"), null, "xhslink short code is not locally confirmable (D8)");
});

// --- normalization details ------------------------------------------------------

test("normalization drops fragments and utm_* tracking params", () => {
  assert.equal(
    normalizeUrl("https://www.example.com/articles/habit#section-2"),
    "https://www.example.com/articles/habit",
  );
  assert.equal(
    normalizeUrl("https://www.example.com/a?utm_source=x&utm_medium=y&utm_campaign=z&keep=1"),
    "https://www.example.com/a?keep=1",
  );
  assert.equal(
    normalizeUrl("https://www.example.com/a?utm_Source=x"),
    "https://www.example.com/a",
    "utm_ matching is case-insensitive",
  );
});

test("normalization keeps platform ignore-lists and sorts the rest", () => {
  assert.equal(
    normalizeUrl("https://www.bilibili.com/video/BV1tx421c7ab?spm_id_from=333&vd_source=x&p=2&buvid=y"),
    "https://www.bilibili.com/video/BV1tx421c7ab?p=2",
    "bilibili share params drop, p stays",
  );
  assert.equal(
    normalizeUrl("https://www.youtube.com/watch?v=abc&t=90&si=share&index=3"),
    "https://www.youtube.com/watch?v=abc",
    "youtube share params drop, v stays",
  );
  assert.equal(
    normalizeUrl("https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab23?xsec_token=A&xsec_source=pc&keep=1"),
    "https://www.xiaohongshu.com/explore/66a1b2c3000000001e01ab23?keep=1",
  );
  assert.equal(
    normalizeUrl("https://appdemo.xiaoe-tech.com/v_66a1b2c3d4e5?app_id=appxyz"),
    "https://appdemo.xiaoe-tech.com/v_66a1b2c3d4e5",
    "xiaoe app_id drops",
  );
  assert.equal(
    normalizeUrl("https://www.example.com/a?z=1&a=2&m=3&b=4"),
    "https://www.example.com/a?a=2&b=4&m=3&z=1",
    "unknown platforms only drop utm_*; the rest is name-sorted",
  );
});

test("normalization lowercases the host and keeps the raw path", () => {
  assert.equal(
    normalizeUrl("https://EXAMPLE.com/Articles/Habit"),
    "https://example.com/Articles/Habit",
  );
});

test("normalization and extraction are total: garbage in, null out, never throw", () => {
  const garbage = [
    undefined,
    null,
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
    Symbol("x"),
  ];
  for (const input of garbage) {
    assert.doesNotThrow(() => {
      assert.equal(extractVideoIdentity(input), null, `extract(${String(input)})`);
      assert.equal(normalizeUrl(input), null, `normalize(${String(input)})`);
    });
  }
  // Non-garbage but exotic URLs still answer without throwing.
  assert.doesNotThrow(() => {
    extractVideoIdentity("https://例え.テスト/视频?v=abc");
    normalizeUrl("https://例え.テスト/视频?v=abc");
  });
});
