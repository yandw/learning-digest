const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseBilibiliSubtitleView,
  rebuildBilibiliSubtitleUrl,
} = require("../bilibili-captions.js");

function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    const byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 0x80 : 0));
  } while (remaining);
  return bytes;
}

function field(number, bytes) {
  return [...varint((number << 3) | 2), ...varint(bytes.length), ...bytes];
}

function text(number, value) {
  return field(number, [...new TextEncoder().encode(value)]);
}

function track({ id, lan, label, url, ai }) {
  return field(3, [
    ...text(2, id),
    ...text(3, lan),
    ...text(4, label),
    ...text(5, url),
    ...varint(8 << 3),
    ...varint(ai),
  ]);
}

test("the protobuf subtitle view restores native CC and AI body URLs", () => {
  const bytes = Uint8Array.from([
    ...field(1, [1]),
    ...track({
      id: "2151495217046636032",
      lan: "zh",
      label: "中文",
      url: "//subtitle.bilibili.com/native.json?auth_key=signed-native",
      ai: 0,
    }),
    ...track({
      id: "2151495341122403840",
      lan: "ai-zh",
      label: "中文",
      url: "//subtitle.bilibili.com/ai.json?auth_key=signed-ai",
      ai: 1,
    }),
  ]);

  assert.deepEqual(parseBilibiliSubtitleView(bytes), [
    {
      id_str: "2151495217046636032",
      lan: "zh",
      lan_doc: "中文",
      ai_type: 0,
      subtitle_url: "//subtitle.bilibili.com/native.json?auth_key=signed-native",
    },
    {
      id_str: "2151495341122403840",
      lan: "ai-zh",
      lan_doc: "中文",
      ai_type: 1,
      subtitle_url: "//subtitle.bilibili.com/ai.json?auth_key=signed-ai",
    },
  ]);
});

test("signed-in web/view responses unwrap the data message before reading tracks", () => {
  const bytes = Uint8Array.from([
    ...field(1, [
      ...track({
        id: "2151495217046636032",
        lan: "zh",
        label: "中文",
        url: "//subtitle.bilibili.com/native.json?auth_key=signed-native",
        ai: 0,
      }),
      ...track({
        id: "2151495341122403840",
        lan: "ai-zh",
        label: "中文",
        url: "//subtitle.bilibili.com/ai.json?auth_key=signed-ai",
        ai: 1,
      }),
    ]),
  ]);

  assert.deepEqual(
    parseBilibiliSubtitleView(bytes).map((item) => ({
      id_str: item.id_str,
      lan: item.lan,
      hasUrl: Boolean(item.subtitle_url),
    })),
    [
      { id_str: "2151495217046636032", lan: "zh", hasUrl: true },
      { id_str: "2151495341122403840", lan: "ai-zh", hasUrl: true },
    ],
  );
});

test("malformed protobuf cannot invent a caption track", () => {
  assert.deepEqual(parseBilibiliSubtitleView(Uint8Array.from([0x1a, 0xff, 0x01])), []);
});

test("the player subtitle URL transform restores the fetchable CDN path", () => {
  const encoded =
    "//subtitle.bilibili.com/S%13%1BP.%1D()X%2CR%5Ej%1F%25w%0E%02H%5EHO4%14%7B4%08K%40%3C%7B%00M%0B%0A%1AM%08%056N6%24%0C0%26%02%1E%01%09%0E%1A2V!E%01%01P%16G%01%03%07Q?auth_key=signed-native";
  assert.equal(
    rebuildBilibiliSubtitleUrl(encoded),
    "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/native.json?auth_key=signed-native",
  );
});

test("an already restored subtitle CDN URL stays unchanged", () => {
  const restored = "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/native.json?auth_key=signed";
  assert.equal(rebuildBilibiliSubtitleUrl(restored), restored);
});

test("an undecodable subtitle URL is rejected instead of fetched directly", () => {
  assert.equal(
    rebuildBilibiliSubtitleUrl("//subtitle.bilibili.com/%E0%A4%A?auth_key=broken"),
    null,
  );
  assert.equal(
    rebuildBilibiliSubtitleUrl("//subtitle.bilibili.com/not-encrypted.json?auth_key=broken"),
    null,
  );
});
