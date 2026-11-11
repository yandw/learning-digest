/**
 * Minimal safe Markdown rendering for Course Summary bodies (round 3,
 * ticket 3.3; contract-r3 §2.1 — content is Markdown, citations' quotes
 * are verbatim user-controlled transcript text).
 *
 * Safety policy: this module NEVER produces an HTML string. It parses the
 * markdown subset the contract bodies use — ATX headings (# ## ###),
 * unordered lists (- and *), **bold** runs and paragraphs — into plain-text
 * view models:
 *
 *   block  := { kind: "h1"|"h2"|"h3", runs }   one heading line
 *           | { kind: "ul", items: runs[] }    consecutive bullet lines
 *           | { kind: "p", runs }              consecutive plain lines
 *   run    := { text, bold }                   text is LITERAL, unmodified
 *
 * The page binding turns these into DOM via createElement/textContent (and
 * <strong> for bold runs), so hostile markup — in the AI body or in a
 * user-controlled citation quote — can only ever land in a text node.
 * There is no innerHTML path and nothing to escape incorrectly; markup
 * survives verbatim as text by construction.
 *
 * Anything outside the subset (tables, code fences, links, ####+, ...) is
 * rendered as literal paragraph text — degrade, never guess.
 */

/** Parse one line into inline runs: **bold** spans, literal text otherwise. */
function parseInlineRuns(line) {
  const runs = [];
  let plain = "";
  let index = 0;
  while (index < line.length) {
    const start = line.indexOf("**", index);
    if (start < 0) {
      plain += line.slice(index);
      break;
    }
    const end = line.indexOf("**", start + 2);
    if (end < 0) {
      // Unterminated **: literal text from here on.
      plain += line.slice(index);
      break;
    }
    if (start > index) {
      plain += line.slice(index, start);
    }
    if (plain !== "") {
      runs.push({ text: plain, bold: false });
      plain = "";
    }
    const boldText = line.slice(start + 2, end);
    if (boldText !== "") {
      runs.push({ text: boldText, bold: true });
    }
    index = end + 2;
  }
  if (plain !== "") {
    runs.push({ text: plain, bold: false });
  }
  return runs;
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const LIST_ITEM_RE = /^[-*]\s+(.*)$/;

/** Whether a line is blank (block separator). */
function isBlank(line) {
  return line.trim() === "";
}

/**
 * Render a Course Summary body into block view models. Empty and non-string
 * inputs render as nothing rather than throwing.
 */
export function renderMarkdown(content) {
  if (typeof content !== "string" || content === "") {
    return [];
  }
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let list = null; // items of the list block being accumulated
  let paragraph = null; // runs of the paragraph being accumulated

  function flushList() {
    if (list) {
      blocks.push({ kind: "ul", items: list });
      list = null;
    }
  }

  function flushParagraph() {
    if (paragraph) {
      blocks.push({ kind: "p", runs: paragraph });
      paragraph = null;
    }
  }

  for (const line of lines) {
    if (isBlank(line)) {
      flushList();
      flushParagraph();
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushList();
      flushParagraph();
      blocks.push({ kind: `h${heading[1].length}`, runs: parseInlineRuns(heading[2]) });
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      flushParagraph();
      if (!list) {
        list = [];
      }
      list.push(parseInlineRuns(item[1]));
      continue;
    }
    flushList();
    if (paragraph) {
      // Markdown soft-wrap: consecutive plain lines are one paragraph.
      paragraph.push({ text: "\n", bold: false });
    } else {
      paragraph = [];
    }
    paragraph.push(...parseInlineRuns(line));
  }
  flushList();
  flushParagraph();
  return blocks;
}
