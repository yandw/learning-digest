import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../public/js/markdown.js";

// Minimal safe Markdown rendering (round 3, ticket 3.3). The summary body
// is AI-authored Markdown (contract-r3 §2.1) and the citation quotes are
// user-controlled transcript text — the renderer's contract is that NO
// HTML STRING IS EVER PRODUCED: it returns plain-text view models (blocks
// and runs) that the page turns into DOM with createElement/textContent,
// so hostile markup can only ever land in text nodes. The supported
// surface is deliberately minimal: headings, unordered lists, bold runs
// and paragraphs — everything else is literal text.

// --- structure -----------------------------------------------------------------

test("renderMarkdown maps ATX headings to heading blocks", () => {
  const blocks = renderMarkdown("# 注意力机制详解 P2：自注意力 · 课程总结\n\n## 核心要点");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["h1", "h2"],
  );
  assert.equal(blocks[0].runs[0].text, "注意力机制详解 P2：自注意力 · 课程总结");
  assert.equal(blocks[1].runs[0].text, "核心要点");
});

test("renderMarkdown groups consecutive - lines into one list block", () => {
  // The contract fixture's body shape: a heading followed by a list.
  const blocks = renderMarkdown("## 核心要点\n\n- 注意力分数的计算，就是把查询向量和键向量做点积。\n- 点积之后要缩放。\n- 矩阵视角：Q、K、V 各司其职。");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].kind, "ul");
  assert.equal(blocks[1].items.length, 3);
  assert.equal(blocks[1].items[0][0].text, "注意力分数的计算，就是把查询向量和键向量做点积。");
});

test("renderMarkdown renders one bullet item per line, including bare * markers", () => {
  const blocks = renderMarkdown("- 甲\n* 乙\n- 丙");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "ul");
  assert.deepEqual(blocks[0].items.map((runs) => runs[0].text), ["甲", "乙", "丙"]);
});

test("renderMarkdown merges consecutive plain lines into one paragraph", () => {
  const blocks = renderMarkdown("第一行。\n第二行。");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "p");
  assert.equal(blocks[0].runs.map((r) => r.text).join(""), "第一行。\n第二行。");
});

test("renderMarkdown splits blocks on blank lines", () => {
  const blocks = renderMarkdown("段落一。\n\n段落二。");
  assert.deepEqual(blocks.map((b) => b.kind), ["p", "p"]);
  assert.equal(blocks[0].runs[0].text, "段落一。");
  assert.equal(blocks[1].runs[0].text, "段落二。");
});

// --- inline bold ------------------------------------------------------------------

test("renderMarkdown parses **bold** runs inside paragraphs and list items", () => {
  const blocks = renderMarkdown("前缀**加粗**后缀");
  assert.equal(blocks[0].kind, "p");
  assert.deepEqual(blocks[0].runs, [
    { text: "前缀", bold: false },
    { text: "加粗", bold: true },
    { text: "后缀", bold: false },
  ]);

  const list = renderMarkdown("- 项目**重点**收尾");
  assert.deepEqual(list[0].items[0], [
    { text: "项目", bold: false },
    { text: "重点", bold: true },
    { text: "收尾", bold: false },
  ]);
});

test("renderMarkdown keeps an unterminated ** as literal text", () => {
  const blocks = renderMarkdown("这里有**未闭合的星号");
  assert.deepEqual(blocks[0].runs, [{ text: "这里有**未闭合的星号", bold: false }]);
});

// --- safety ------------------------------------------------------------------------

test("renderMarkdown never emits HTML: hostile markup survives as literal text runs", () => {
  // The safety property the page relies on: whatever the content (AI body,
  // user-controlled transcript quotes), the output is plain text runs. The
  // page renders them through textContent, so this content can only ever
  // appear as text.
  const blocks = renderMarkdown("<script>alert(1)</script>");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "p");
  assert.equal(blocks[0].runs[0].text, "<script>alert(1)</script>");

  const img = renderMarkdown("**<img src=x onerror=alert(1)>**");
  assert.deepEqual(img[0].runs, [{ text: "<img src=x onerror=alert(1)>", bold: true }]);

  const amp = renderMarkdown('a & b < c > d "quotes"');
  assert.equal(amp[0].runs[0].text, 'a & b < c > d "quotes"');
});

test("renderMarkdown accepts the contract fixture's body verbatim", () => {
  // fixtures/summary-examples.json is the authoritative body sample.
  const fixturesDir = path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    "..",
    "..",
    "contracts",
    "fixtures",
  );
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, "summary-examples.json"), "utf8"));
  const content = fixture.samples.find((s) => s.id === "api-summary-detail").response.body.summary.content;
  const blocks = renderMarkdown(content);
  // The fixture body: an h1, three h2 sections, a list under each.
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["h1", "h2", "ul", "h2", "ul", "h2", "ul"],
  );
  assert.equal(blocks[0].runs[0].text, "注意力机制详解 P2：自注意力 · 课程总结");
  assert.equal(blocks[2].items.length, 3);
});

// --- degenerate inputs --------------------------------------------------------------

test("renderMarkdown returns no blocks for empty or non-string content", () => {
  assert.deepEqual(renderMarkdown(""), []);
  assert.deepEqual(renderMarkdown(null), []);
  assert.deepEqual(renderMarkdown(undefined), []);
  assert.deepEqual(renderMarkdown(42), []);
});

test("renderMarkdown skips heading-like lines without a space after the marker", () => {
  // "#hashtag" is not an ATX heading in Markdown — keep it literal text.
  const blocks = renderMarkdown("#hashtag 不是标题");
  assert.equal(blocks[0].kind, "p");
  assert.equal(blocks[0].runs[0].text, "#hashtag 不是标题");
});
