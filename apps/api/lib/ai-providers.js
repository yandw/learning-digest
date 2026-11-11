/**
 * AI Provider seam for course summary generation (contract-r3.md §2.3,
 * §3.1; decisions D16/D17, ticket 3.2). The API is the ONLY holder of AI
 * Provider credentials (D16: same reasoning as D10 for speech, but the
 * inputs are already-archived text, so the seam lives here, not in the
 * Worker — the two seams are parallel and independent).
 *
 * Interface (the one thing consumers may rely on):
 *
 *   provider = { id: string, model: string, generate({ system, user }) }
 *   generate resolves to { content: string, citations: RawCitation[] }
 *   where RawCitation = { quote, sessionId, startMs, endMs } — the shape
 *   the model is asked for by prompts/course-summary.md; every citation is
 *   later reconciled against the archived records (lib/summaries.js)
 *   before anything lands.
 *
 * Two implementations (D16: default deployment is the real product path,
 * tests inject the stub):
 * - createStubProvider: deterministic — output depends only on the input
 *   prompt text. It reads the assembled transcript lines back out of the
 *   user prompt and cites them verbatim, so the citation reconciliation
 *   can hold; same input always yields the same summary.
 * - createQwenProvider: Aliyun Bailian compatible-mode chat/completions.
 *   The API key comes from env LD_AI_API_KEY (server.js) — deliberately
 *   NOT the worker's speech credentials (apps/worker uses QWEN_API_KEY for
 *   ASR): the two seams have different owners, credentials and lifecycles
 *   (D16). The model defaults to qwen3.8-flash and is configurable
 *   (one model behind config, per the round-3 product decision). Real
 *   network calls stay out of the test suite; fetchImpl is the seam.
 *
 * selectAiProvider(config) resolves config/env into a provider instance
 * at startup; an unknown name or a keyless qwen selection fails closed
 * (throw at startup), never per-request.
 */

const DEFAULTS = Object.freeze({
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.8-flash",
  timeoutMs: 120000,
});

// The user prompt's section markers (prompts/course-summary.md — the
// template is the contract record, D17; the stub parses it, it never
// re-derives the prompt copy).
const SECTIONS = Object.freeze({
  transcript: "已归档逐字稿（按来源时间轴排序）：",
  gaps: "已跳过范围：",
  notes: "学习者笔记：",
});

// One transcript/gap line as assembled by lib/summaries.js:
// [ses_… 30000–60000] text — en dash between the ms marks.
const STAMPED_LINE = /^\[(\S+) (\d+)–(\d+)\] (.+)$/gm;

/** Extract `{ sessionId, startMs, endMs, text }` lines from one section. */
function parseStampedLines(section) {
  const lines = [];
  for (const match of section.matchAll(STAMPED_LINE)) {
    lines.push({
      sessionId: match[1],
      startMs: Number.parseInt(match[2], 10),
      endMs: Number.parseInt(match[3], 10),
      text: match[4],
    });
  }
  return lines;
}

/** Slice the user prompt into its three material sections. */
function parseUserPrompt(user) {
  const transcriptStart = user.indexOf(SECTIONS.transcript);
  const gapsStart = user.indexOf(SECTIONS.gaps);
  const notesStart = user.indexOf(SECTIONS.notes);
  const transcriptSection =
    transcriptStart >= 0 && gapsStart > transcriptStart
      ? user.slice(transcriptStart + SECTIONS.transcript.length, gapsStart)
      : "";
  const gapsSection =
    gapsStart >= 0 && notesStart > gapsStart
      ? user.slice(gapsStart + SECTIONS.gaps.length, notesStart)
      : "";
  const notesSection = notesStart >= 0 ? user.slice(notesStart + SECTIONS.notes.length) : "";
  const titleMatch = /^资料标题：(.*)$/m.exec(user);
  return {
    title: titleMatch ? titleMatch[1].trim() : "课程资料",
    records: parseStampedLines(transcriptSection),
    gaps: parseStampedLines(gapsSection),
    notes: notesSection
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && line !== "（无）"),
  };
}

/**
 * The stub's citation rule: one citation per distinct Session, pointing at
 * that Session's latest record on the shared timeline (the newest
 * material), quote verbatim. Deterministic; everything it cites exists in
 * the input, so the reconciliation keeps them all.
 */
function stubCitations(records, maxSessions = 6) {
  const latestBySession = new Map();
  for (const record of records) {
    // The assembled lines are startMs-ascending, so the last occurrence
    // per session is that session's latest record.
    latestBySession.set(record.sessionId, record);
  }
  return [...latestBySession.values()]
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, maxSessions)
    .map((record) => ({
      quote: record.text,
      sessionId: record.sessionId,
      startMs: record.startMs,
      endMs: record.endMs,
    }));
}

/** Deterministic Markdown body, derived only from the parsed input. */
function stubContent({ title, records, gaps, notes }) {
  const lines = [`# ${title}：课程总结`, "", "## 核心要点", ""];
  // Up to 8 records so the body visibly grows when a catch-up session
  // adds material (the two-generation story regenerates over a growing
  // archive); a real provider would synthesize, the stub quotes.
  for (const record of records.slice(0, 8)) {
    lines.push(`- ${record.text}`);
  }
  if (notes.length > 0) {
    lines.push("", "## 学习笔记并入", "");
    for (const note of notes.slice(0, 3)) {
      lines.push(`- ${note}`);
    }
  }
  lines.push("", "## 尚未覆盖", "");
  if (gaps.length > 0) {
    for (const gap of gaps) {
      lines.push(`- [${gap.sessionId} ${gap.startMs}–${gap.endMs}] 该范围被跳过，未取得文本。`);
    }
    lines.push("- 这些区间没有文本，补学后可重新生成总结。");
  } else {
    lines.push("- 没有显式跳过范围。");
  }
  return lines.join("\n");
}

function createStubProvider({ model } = {}) {
  async function generate({ system, user }) {
    // `system` shapes the real provider's behavior; the stub is
    // deterministic by construction and only consumes the material.
    void system;
    const parsed = parseUserPrompt(user);
    return {
      content: stubContent(parsed),
      citations: stubCitations(parsed.records),
    };
  }
  return { id: "stub", model: model || "stub-course-summary-1", generate };
}

/** Trim trailing slashes; empty falls back to the Bailian endpoint. */
function normalizeBaseUrl(baseUrl) {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  return (trimmed || DEFAULTS.baseUrl).replace(/\/+$/, "");
}

/**
 * Parse the model's reply into the summary payload. The system prompt
 * demands one bare JSON object, but real models wrap it (code fences,
 * prose) — tolerate everything that contains a parseable object with a
 * string `content`; `citations` defaults to []. Anything else is
 * "unparseable" (the caller answers the contract 502).
 */
function parseSummaryPayload(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }
  let candidate = text.trim();
  const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(candidate);
  if (fence) {
    candidate = fence[1].trim();
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(candidate.slice(start, end + 1));
  } catch (_error) {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  if (typeof data.content !== "string") {
    return null;
  }
  return {
    content: data.content,
    citations: Array.isArray(data.citations) ? data.citations : [],
  };
}

/**
 * A FRESH timeout signal per generate() call (round-3 review fix).
 * `AbortSignal.timeout` built at provider construction would be
 * permanently aborted once timeoutMs elapsed, poisoning every later
 * generation (the qwen path would 502 forever after the first timeout);
 * the value (`timeoutMs`) is fixed at construction, the signal is not.
 * Injectable so tests can observe the signals handed to fetch.
 */
function createTimeoutSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

/**
 * Bailian compatible-mode chat/completions (worker/lib/providers/qwen.js
 * is the shape precedent — same endpoint family, different credential
 * ownership, D16). One request per generation: system + user messages,
 * one fresh timeout signal per request (createTimeoutSignal).
 */
function createQwenProvider({ apiKey, baseUrl, model, fetchImpl, timeoutMs, createTimeoutSignal: timeoutSignalFactory } = {}) {
  const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmedKey) {
    throw new Error("Qwen AI Provider requires an API key (env LD_AI_API_KEY; separate from the worker's speech credentials, D16)");
  }
  const resolvedModel = (typeof model === "string" && model.trim()) || DEFAULTS.model;
  const resolvedBase = normalizeBaseUrl(baseUrl);
  const doFetch = fetchImpl || fetch;
  const makeSignal = timeoutSignalFactory || createTimeoutSignal;
  const resolvedTimeoutMs = timeoutMs || DEFAULTS.timeoutMs;

  async function generate({ system, user }) {
    const response = await doFetch(`${resolvedBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: makeSignal(resolvedTimeoutMs),
    });
    if (!response.ok) {
      const body = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      const detail = body ? `: ${body.slice(0, 500)}` : "";
      throw new Error(`Qwen AI Provider request failed with HTTP ${response.status}${detail}`);
    }
    const json = await response.json();
    const text = String(json?.choices?.[0]?.message?.content || "");
    const parsed = parseSummaryPayload(text);
    if (!parsed) {
      throw new Error("Qwen AI Provider returned an unparseable summary payload");
    }
    return parsed;
  }

  return { id: "qwen", model: resolvedModel, generate };
}

/**
 * Resolve the deployment config (server.js fills it from LD_AI_PROVIDER /
 * LD_AI_API_KEY / LD_AI_MODEL / LD_AI_BASE_URL) into one provider
 * instance. Default is the deterministic stub so a bare `npm start` and
 * every test get repeatable summaries; "qwen" is the product path.
 */
function selectAiProvider(config = {}) {
  const name = String(config.aiProviderName || "").trim().toLowerCase();
  if (!name || name === "stub") {
    return createStubProvider({ model: config.aiModel });
  }
  if (name === "qwen") {
    return createQwenProvider({
      apiKey: config.aiApiKey,
      baseUrl: config.aiBaseUrl,
      model: config.aiModel,
      timeoutMs: config.aiTimeoutMs,
    });
  }
  throw new Error(`Unknown AI provider "${name}" (expected "stub" or "qwen")`);
}

module.exports = { createStubProvider, createQwenProvider, selectAiProvider, parseSummaryPayload, DEFAULTS };
