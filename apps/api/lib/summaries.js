/**
 * Course Summary domain (contract-r3.md §2.1–2.3, §3.1–3.3; decisions
 * D16/D17/D18, ticket 3.2, issue #74).
 *
 * Owns the "summaries" collection, one document per successful generation:
 *
 *   { id, accountId, resourceId, content, citations,
 *     generation: { provider, model, inputChars }, generatedAt, generatedAtMs }
 *
 * Only successful generations exist — a failed provider call answers the
 * contract 502 and lands NOTHING (no summary row, no usage write, D16
 * 不落脏数据); there is no status field because every stored summary is
 * queryable. Each accepted POST creates a NEW record (contract-r3 §1
 * 幂等例外): regenerating is the user's decision, history is kept.
 *
 * Generation pipeline (one POST, synchronous, D16):
 * 1. aggregate the Resource's CURRENT archived material (D17): every
 *    Session's transcript records (startMs-ascending across sessions) and
 *    gaps as skipped markers, plus the account's notes — pending/failed
 *    segments and silent segments contribute nothing (no text);
 * 2. assemble the prompt from the contract template
 *    prompts/course-summary.md (D17: the copy lives in the template file,
 *    code only fills the four variables) — inputChars is the full
 *    assembled prompt (system + user), the same number usage reports;
 * 3. call the injected AI Provider (lib/ai-providers.js);
 * 4. reconcile the returned citations against the archived records and
 *    drop every one that does not resolve (§2.2: sessionId belongs to the
 *    resource, the range matches a real record, quote is a verbatim
 *    excerpt) — 宁可少引用不落死链;
 * 5. store the summary and record usage in the same stroke (D18: the
 *    record-keeping timepoint is the landing moment).
 */
const fs = require("node:fs");
const path = require("node:path");
const { ApiError, notFoundResource } = require("./errors");
const { generateId } = require("./ids");
const { isoSeconds, notesForResource } = require("./notes");
const { loadState } = require("./transcripts");
const { recordSummaryGeneration } = require("./usage");

// D17: the prompt template is the contract record at the repo root.
const PROMPT_FILE = path.join(__dirname, "..", "..", "..", "prompts", "course-summary.md");

const GAP_MARKER = "已跳过，该范围未取得文本";
const NOTHING_MARKER = "（无）";

let cachedTemplate = null;

/** Extract the first fenced code block after a markdown heading. */
function extractFencedBlock(markdown, heading) {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex < 0) {
    throw new Error(`prompts/course-summary.md is missing the "${heading}" section`);
  }
  const fence = markdown.indexOf("```", headingIndex);
  if (fence < 0) {
    throw new Error(`prompts/course-summary.md has no code block after "${heading}"`);
  }
  const contentStart = markdown.indexOf("\n", fence) + 1;
  const closing = markdown.indexOf("```", contentStart);
  return markdown.slice(contentStart, closing).replace(/\n$/, "");
}

/** Load (and cache) the { system, user } template from the contract file. */
function loadCourseSummaryTemplate() {
  if (!cachedTemplate) {
    const markdown = fs.readFileSync(PROMPT_FILE, "utf8");
    cachedTemplate = {
      system: extractFencedBlock(markdown, "## System prompt"),
      user: extractFencedBlock(markdown, "## User prompt"),
    };
  }
  return cachedTemplate;
}

/** Unicode code-point count (D18: 字符量用 Unicode 码点数). */
function countCodePoints(text) {
  return [...text].length;
}

function noTranscriptToSummarize() {
  return new ApiError(
    409,
    "no_transcript_to_summarize",
    "这门资料还没有可总结的逐字稿，先学习并归档后再生成",
  );
}

function summaryGenerationFailed() {
  return new ApiError(
    502,
    "summary_generation_failed",
    "总结生成失败，请稍后重试；本次尝试不产生总结记录",
  );
}

function notFoundSummary() {
  return new ApiError(404, "not_found", "总结不存在或无权访问");
}

/** D2 lookup: the account's Resource by id, or throw the same 404 for unknown ids. */
function requireAccountResource({ store, accountId, resourceId }) {
  const resource = store
    .list("resources")
    .find((r) => r.id === resourceId && r.accountId === accountId);
  if (!resource) {
    throw notFoundResource();
  }
  return resource;
}

/**
 * Aggregate one Resource's archived material (D17): records and gaps from
 * ALL of the account's Sessions on the resource (active and finished
 * alike — 未学完可生成), merged on the shared source timeline.
 */
function collectMaterial({ store, accountId, resourceId }) {
  const sessions = store
    .list("sessions")
    .filter((s) => s.accountId === accountId && s.resourceId === resourceId);
  const records = [];
  const gaps = [];
  for (const session of sessions) {
    const state = loadState(store, session.id);
    for (const record of state.records) {
      records.push({ sessionId: session.id, startMs: record.startMs, endMs: record.endMs, text: record.text });
    }
    for (const gap of state.gaps) {
      gaps.push({ sessionId: session.id, startMs: gap.startMs, endMs: gap.endMs });
    }
  }
  records.sort((a, b) => a.startMs - b.startMs);
  gaps.sort((a, b) => a.startMs - b.startMs);
  return { sessions, records, gaps };
}

/** Line the transcript rows up with their session id stamp (D17). */
function stampLine(entry) {
  return `[${entry.sessionId} ${entry.startMs}–${entry.endMs}] ${entry.text}`;
}

/**
 * Fill the template's four variables. String arguments are wrapped in
 * functions so user-authored `$&`-style text can never be interpreted as
 * a replacement pattern.
 */
function fillTemplate(template, values) {
  return template.replace(/\{(resourceTitle|transcriptLines|gapLines|noteLines)\}/g, (name) => {
    const fill = values[name.slice(1, -1)];
    return typeof fill === "function" ? fill() : name;
  });
}

/**
 * Assemble the generation input (D17). Returns { system, user, inputChars,
 * records } — inputChars is the full submitted prompt (system + user, code
 * points), the same number the usage report carries.
 */
function buildGenerationInput({ store, accountId, resource }) {
  const { records, gaps } = collectMaterial({ store, accountId, resourceId: resource.id });
  const transcriptLines = records.map(stampLine);
  const gapLines = gaps.map((gap) => stampLine({ ...gap, text: GAP_MARKER }));
  const notes = notesForResource({ store, accountId, resourceId: resource.id });
  const noteLines = notes.map((note) =>
    note.sourceId !== null && note.positionMs !== null
      ? `[${note.sourceId} ${note.positionMs}] ${note.text}`
      : `- ${note.text}`,
  );

  const template = loadCourseSummaryTemplate();
  const user = fillTemplate(template.user, {
    resourceTitle: () => resource.title,
    transcriptLines: () => transcriptLines.join("\n"),
    gapLines: () => (gapLines.length > 0 ? gapLines.join("\n") : NOTHING_MARKER),
    noteLines: () => (noteLines.length > 0 ? noteLines.join("\n") : NOTHING_MARKER),
  });
  return {
    system: template.system,
    user,
    inputChars: countCodePoints(template.system) + countCodePoints(user),
    records,
  };
}

/**
 * Citation reconciliation (§2.2, D17 引用清洗): keep a citation only when
 * the session belongs to this resource, the range matches one of its real
 * archived records exactly, and the quote is a verbatim excerpt of that
 * record's text. Survivors are sorted by source-timeline startMs.
 */
function reconcileCitations({ rawCitations, records }) {
  if (!Array.isArray(rawCitations)) {
    return [];
  }
  const bySession = new Map();
  for (const record of records) {
    const list = bySession.get(record.sessionId) || [];
    list.push(record);
    bySession.set(record.sessionId, list);
  }
  const kept = [];
  for (const raw of rawCitations) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const { quote, sessionId, startMs, endMs } = raw;
    if (
      typeof quote !== "string" ||
      quote.trim() === "" ||
      typeof sessionId !== "string" ||
      sessionId === ""
    ) {
      continue;
    }
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs) {
      continue;
    }
    const record = (bySession.get(sessionId) || []).find(
      (candidate) => candidate.startMs === startMs && candidate.endMs === endMs,
    );
    if (!record || !record.text.includes(quote)) {
      continue;
    }
    kept.push({ quote, segmentRef: { sessionId, startMs, endMs } });
  }
  kept.sort((a, b) => a.segmentRef.startMs - b.segmentRef.startMs);
  return kept;
}

/** Contract §2.1 full shape. */
function serializeSummary(summary) {
  return {
    id: summary.id,
    resourceId: summary.resourceId,
    content: summary.content,
    citations: summary.citations,
    generation: summary.generation,
    generatedAt: summary.generatedAt,
  };
}

/** Contract §3.2 list projection (body and citations come from the detail endpoint). */
function serializeSummaryListItem(summary) {
  return {
    id: summary.id,
    resourceId: summary.resourceId,
    generatedAt: summary.generatedAt,
    generation: summary.generation,
    citationCount: summary.citations.length,
  };
}

/**
 * POST /v1/resources/{id}/summaries (contract §3.1): aggregate -> prompt ->
 * provider -> reconcile -> land + count. Any provider failure (throw,
 * timeout, unparseable payload) becomes the 502 with nothing written.
 */
async function generateSummary({ store, accountId, resourceId, aiProvider, now }) {
  const resource = requireAccountResource({ store, accountId, resourceId });

  const input = buildGenerationInput({ store, accountId, resource });
  // 409 before any AI call: gaps/failed/silent-only archives have no text.
  if (input.records.length === 0) {
    throw noTranscriptToSummarize();
  }

  let generated;
  try {
    generated = await aiProvider.generate({ system: input.system, user: input.user });
  } catch (_error) {
    throw summaryGenerationFailed();
  }
  const content = generated && typeof generated.content === "string" ? generated.content : null;
  if (content === null) {
    throw summaryGenerationFailed();
  }
  const citations = reconcileCitations({ rawCitations: generated.citations, records: input.records });

  const atMs = now();
  const summary = {
    id: generateId("sum"),
    accountId,
    resourceId: resource.id,
    content,
    citations,
    generation: {
      provider: aiProvider.id,
      model: aiProvider.model,
      inputChars: input.inputChars,
    },
    generatedAt: isoSeconds(atMs),
    generatedAtMs: atMs,
    // Internal list-order tie-break: two generations can land in the same
    // millisecond (double click); the newest one must sort first. Monotonic
    // because the contract has no summary deletion.
    seq: store.count("summaries") + 1,
  };
  store.set("summaries", summary.id, summary);
  // D18: the usage counters land with the summary (201's same moment).
  recordSummaryGeneration({ store, accountId, inputChars: input.inputChars, now });
  return { status: 201, body: { summary: serializeSummary(summary) } };
}

/** GET /v1/resources/{id}/summaries (§3.2): newest first, projection items. */
function listSummaries({ store, accountId, resourceId }) {
  requireAccountResource({ store, accountId, resourceId });
  const summaries = store
    .list("summaries")
    .filter((s) => s.accountId === accountId && s.resourceId === resourceId)
    .sort((a, b) => b.generatedAtMs - a.generatedAtMs || b.seq - a.seq)
    .map(serializeSummaryListItem);
  return { status: 200, body: { summaries } };
}

/** GET /v1/summaries/{id} (§3.3): the bare full shape; cross-account is the same 404 (D2). */
function getSummary({ store, accountId, summaryId }) {
  const summary = store.get("summaries", summaryId);
  if (!summary || summary.accountId !== accountId) {
    throw notFoundSummary();
  }
  return { status: 200, body: { summary: serializeSummary(summary) } };
}

/**
 * Register the round-3 summary routes. `requireCredential` comes from
 * routes.js (round-1 auth semantics); `aiProvider` is resolved once at
 * startup by lib/ai-providers.selectAiProvider and injected through
 * createApp — tests swap it for stubs/fault-injectors there.
 */
function registerSummaryRoutes({ router, store, now, requireCredential, aiProvider }) {
  router.add("POST", "/v1/resources/:id/summaries", async ({ req, params }) => {
    const credential = requireCredential(req);
    // The request body is an empty object by contract (no client-side
    // input trimming, D17) — nothing to validate, nothing to read.
    return generateSummary({
      store,
      accountId: credential.accountId,
      resourceId: params.id,
      aiProvider,
      now,
    });
  });

  router.add("GET", "/v1/resources/:id/summaries", async ({ req, params }) => {
    const credential = requireCredential(req);
    return listSummaries({ store, accountId: credential.accountId, resourceId: params.id });
  });

  router.add("GET", "/v1/summaries/:id", async ({ req, params }) => {
    const credential = requireCredential(req);
    return getSummary({ store, accountId: credential.accountId, summaryId: params.id });
  });
}

module.exports = {
  generateSummary,
  listSummaries,
  getSummary,
  registerSummaryRoutes,
  buildGenerationInput,
  reconcileCitations,
  loadCourseSummaryTemplate,
  serializeSummary,
  serializeSummaryListItem,
};
