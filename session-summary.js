/**
 * Session summaries: pure assembly for the Topic timeline and Session Digest.
 *
 * Two prompt inputs are assembled here, both browser-free so they can be
 * unit-tested in Node and loaded by the service worker with importScripts:
 *
 * - Topic tick input: the Transcript records since the coverage cursor (the
 *   end of the last Topic, or 0) plus a context-only overlap tail before it
 *   and the existing Topics' titles. The background layer loads the prompt
 *   copy from prompts/topic-tick.md, injects it into buildTopicTickMessages
 *   and sends the result to the AI Provider when the content-driven trigger
 *   fires, feeding the parsed result back as a `topicsAppended` event; the
 *   state machine appends to the timeline without rewriting earlier Topics
 *   (ADR 0002).
 * - Global pass input: the FULL Transcript plus the live Topic timeline as
 *   a merge hint, assembled once when the Session ends. The background layer
 *   loads prompts/session-report.md the same way, sends one request and
 *   persists the parsed report as the Session Digest artifact (ADR 0002).
 *
 * The prompt copy itself lives in the prompts/*.md files (editable without
 * touching code); these builders only render the variable parts into the
 * injected template sections. No fetch, no chrome dependency here.
 *
 * The coveredUntil convention governs the tick windows: a record counts as
 * covered when its `start` is strictly below the cursor, so the next window
 * is `start >= cursor`. Failure-marker records stay in every window so a
 * summary can mention the gap instead of silently skipping it.
 */
var YTD_SESSION_SUMMARY = (() => {
  // The [m:ss] timestamp formatter is shared with speech-transcription.js;
  // in Node tests we require it, in the service worker both globals arrive
  // via importScripts.
  const speechTranscription =
    typeof YTD_SPEECH_TRANSCRIPTION !== "undefined"
      ? YTD_SPEECH_TRANSCRIPTION
      : require("./speech-transcription.js");

  /**
   * The timeline position (seconds from Session start) up to which a set of
   * Transcript records is covered. The next window starts exactly here.
   *
   * @param {object[]} records
   * @returns {number}
   */
  function coveredUntilFor(records) {
    let end = 0;
    for (const record of records || []) {
      const start = Number(record?.start) || 0;
      const duration = Number(record?.duration) || 0;
      end = Math.max(end, start + duration);
    }
    return end;
  }

  // --- Topic timeline (ADR 0002): content-driven tick trigger and input
  // assembly. The coverage cursor derives from the appended Topics, so it
  // survives a service-worker restart for free (it is persisted state, not
  // timer state).

  /** A tick needs at least this many new Transcript records (the debounce). */
  const MIN_TICK_RECORDS = 10;
  /** Context-only Transcript tail before the cursor, in seconds. */
  const TOPIC_OVERLAP_SECONDS = 120;

  /**
   * The coverage cursor: the end of the last Topic, or 0 when none exist.
   * Transcript at or after this point is what the next tick summarizes.
   *
   * @param {object} state
   * @returns {number}
   */
  function topicCursor(state) {
    const topics = Array.isArray(state?.topics) ? state.topics : [];
    let end = 0;
    for (const topic of topics) {
      end = Math.max(end, Number(topic?.end) || 0);
    }
    return end;
  }

  /**
   * Transcript records at or after the cursor (the shared coveredUntil
   * convention: a record counts as covered when its start is strictly below
   * the cursor).
   *
   * @param {object} state
   * @param {number} cursor
   * @returns {object[]}
   */
  function transcriptSince(state, cursor) {
    return (state?.transcriptRecords || []).filter(
      (record) => (Number(record.start) || 0) >= cursor,
    );
  }

  /**
   * Pure, content-driven trigger decision for a Topic tick: a tick is due
   * when the Transcript coverage since the last tick (cursor = end of the
   * last Topic) reaches the configured interval AND at least
   * MIN_TICK_RECORDS new records exist. Quiet stretches produce no ticks
   * because coverage never grows; a failed tick leaves the cursor (the
   * Topics) untouched, so the next timer fire simply retries.
   *
   * @param {{state: object, intervalMinutes: number, minRecords?: number}} input
   * @returns {boolean}
   */
  function isTopicTickDue({ state, intervalMinutes, minRecords = MIN_TICK_RECORDS }) {
    const cursor = topicCursor(state);
    const newRecords = transcriptSince(state, cursor);
    if (newRecords.length < Math.max(1, Number(minRecords) || 0)) return false;
    const coverageSeconds = coveredUntilFor(newRecords) - cursor;
    return coverageSeconds >= Math.max(0, Number(intervalMinutes) || 0) * 60;
  }

  /**
   * Assembles one Topic tick's input from Session state:
   *
   * - newTranscript: the Transcript records at or after the Topic cursor
   *   (the only records that may be summarized into new Topics);
   * - overlapTail: the records covering the last TOPIC_OVERLAP_SECONDS
   *   before the cursor, carried along as context-only input so a Topic
   *   spanning the tick boundary is not summarized as unrelated fragments
   *   (they are never summarized into new Topics);
   * - existingTopicTitles: the appended Topics' titles in timeline order, so
   *   the model can mark the first output Topic as a continuation.
   *
   * @param {object} state
   * @returns {{cursor: number, newTranscript: object[], overlapTail: object[], existingTopicTitles: string[]}}
   */
  function assembleTopicTickInput(state) {
    const cursor = topicCursor(state);
    const records = state?.transcriptRecords || [];
    const newTranscript = transcriptSince(state, cursor);
    const tailCutoff = cursor - TOPIC_OVERLAP_SECONDS;
    const overlapTail = [];
    if (cursor > 0) {
      for (const record of records) {
        const start = Number(record?.start) || 0;
        const end = start + (Number(record?.duration) || 0);
        // Strictly inside the tail window: a record ending exactly at the
        // cutoff covers nothing after it, and one at/after the cursor is
        // already new input.
        if (start < cursor && end > tailCutoff) overlapTail.push(record);
      }
    }
    const topics = Array.isArray(state?.topics) ? state.topics : [];
    const existingTopicTitles = topics.map((topic) => String(topic?.title ?? ""));
    return { cursor, newTranscript, overlapTail, existingTopicTitles };
  }

  const formatTimestamp = speechTranscription.formatTimestamp;

  /**
   * Parses JSON returned by an LLM, tolerating the small mistakes they
   * sometimes make: trailing commas before a ] or }, prose or code fences
   * around the payload. Plain JSON.parse throws on those, which is what
   * broke the Overview tab in the seed era; this function strips fences,
   * isolates the outermost { ... } or [ ... ], removes trailing commas, and
   * only then parses. Throws when the text still holds no parseable JSON.
   *
   * @param {string} text - raw text from the model
   * @returns {*} the parsed value
   */
  function parseLooseJson(text) {
    let cleaned = (text || "").trim();

    // Strip ```json ... ``` style code fences
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    }

    // Isolate the outermost { ... } or [ ... ] in case the model added a
    // sentence around it.
    const openers = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter(
      (index) => index !== -1,
    );
    const closers = [cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]")].filter(
      (index) => index !== -1,
    );
    if (openers.length > 0 && closers.length > 0) {
      const first = Math.min(...openers);
      const last = Math.max(...closers);
      if (last > first) cleaned = cleaned.slice(first, last + 1);
    }

    try {
      return JSON.parse(cleaned);
    } catch (_firstError) {
      // Most common LLM slip: a trailing comma right before a } or ].
      // e.g. ["a", "b", ]  ->  ["a", "b" ]
      const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(repaired);
    }
  }

  /** Caps shared with the Overview validator in background.js. */
  const TOPIC_TITLE_MAX_LENGTH = 300;
  const TOPIC_TEXT_MAX_LENGTH = 1500;

  /**
   * The shared Topic-entry validation both parsers apply: a usable entry is
   * an object carrying a finite numeric time range (clamped to non-negative
   * integer seconds, end never before start) plus a non-empty title and body
   * string (trimmed, length-capped). Returns the clamped fields with the
   * body under `bodyKey`, or null when the entry is not usable — the callers
   * keep only their distinct entry shape on top (tick `text` with the
   * continuation flag, report `summary`).
   *
   * @param {*} entry
   * @param {string} bodyKey - "text" (tick) or "summary" (report)
   * @param {number} bodyMaxLength - cap for the body string
   * @returns {object|null}
   */
  function sanitizeTopicFields(entry, bodyKey, bodyMaxLength) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const start = Number(entry.start);
    const end = Number(entry.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const safeStart = Math.max(0, Math.floor(start));
    const safeEnd = Math.max(0, Math.floor(end));
    if (safeEnd < safeStart) return null;
    const title =
      typeof entry.title === "string" ? entry.title.trim().slice(0, TOPIC_TITLE_MAX_LENGTH) : "";
    const body =
      typeof entry[bodyKey] === "string"
        ? entry[bodyKey].trim().slice(0, bodyMaxLength)
        : "";
    if (!title || !body) return null;
    return { start: safeStart, end: safeEnd, title, [bodyKey]: body };
  }

  /**
   * Maps one raw model entry to a Topic shape, or null when the entry is
   * not a usable Topic (missing title/text, non-numeric or inverted time
   * range). Numbers become non-negative integer seconds; strings are
   * trimmed and length-capped; continuation survives only as a true flag.
   *
   * @param {*} entry
   * @returns {object|null}
   */
  function sanitizeTopicEntry(entry) {
    const fields = sanitizeTopicFields(entry, "text", TOPIC_TEXT_MAX_LENGTH);
    if (!fields) return null;
    const topic = {
      start: fields.start,
      end: fields.end,
      title: fields.title,
      text: fields.text,
    };
    if (entry.continuation === true) topic.continuation = true;
    return topic;
  }

  /**
   * Parses a Topic tick's model output into Topics. Tolerant of the same
   * LLM slips as the Overview JSON (fences, prose, trailing commas), and
   * accepts a bare array or an object wrapping one under `topics`. On
   * malformed output this returns an empty list: the caller appends nothing
   * and the state stays untouched.
   *
   * @param {string} text - raw text from the model
   * @returns {object[]} sanitized Topic entries
   */
  function parseTopicTick(text) {
    let parsed;
    try {
      parsed = parseLooseJson(text);
    } catch (_error) {
      return [];
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.topics)
        ? parsed.topics
        : [];
    return list.map(sanitizeTopicEntry).filter(Boolean);
  }

  /**
   * Renders Transcript records as `[m:ss] text` lines — the same stamp
   * convention the analysis prompt documents, so the AI Provider can cite
   * timestamps in summaries.
   *
   * @param {object[]} records
   * @returns {string}
   */
  function formatTranscriptForPrompt(records) {
    return (records || [])
      .map(
        (record) =>
          `[${formatTimestamp(record?.start)}] ${String(record?.text ?? "")}`,
      )
      .join("\n");
  }

  /**
   * Substitutes {key} placeholders in a prompt template — the one placeholder
   * convention for prompts/*.md. loadPromptSection in background.js delegates
   * here for its load-time variables, and the prompt builders below use it
   * for the Session-state variables. Only the given keys are replaced: a
   * placeholder with no matching variable stays in the text (a broken
   * template is visible in the prompt instead of silently vanishing), and a
   * missing value becomes an empty string.
   *
   * @param {string} template
   * @param {Record<string, unknown>} [variables]
   * @returns {string}
   */
  function fillPromptTemplate(template, variables = {}) {
    let prompt = String(template ?? "");
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
    }
    return prompt;
  }

  /**
   * Chat-completion messages for one Topic tick. The prompt copy lives in
   * prompts/topic-tick.md; the background layer loads its three sections
   * (system prompt plus the two user-prompt variants) through
   * loadPromptSection and injects them here, so this stays pure and
   * browser-free. The first tick of a Session (no existing Topics) fills the
   * first-batch variant; otherwise the template names the prior Topics and
   * the continuation anchor.
   *
   * @param {{systemPrompt: string, userPrompt: string, firstBatchUserPrompt: string}} template
   * @param {{existingTopicTitles: string[], contextTranscriptText: string, newTranscriptText: string}} input
   * @returns {Array<{role: string, content: string}>}
   */
  function buildTopicTickMessages(
    template,
    { existingTopicTitles, contextTranscriptText, newTranscriptText },
  ) {
    const titles = Array.isArray(existingTopicTitles) ? existingTopicTitles : [];
    const firstBatch = titles.length === 0;
    const userTemplate = firstBatch
      ? template.firstBatchUserPrompt
      : template.userPrompt;
    const variables = {
      contextTranscriptText: contextTranscriptText || "（无）",
      newTranscriptText,
    };
    if (!firstBatch) {
      variables.existingTopicTitlesLines = titles.join("\n- ");
      variables.lastTopicTitle = titles[titles.length - 1];
    }
    return [
      { role: "system", content: template.systemPrompt },
      { role: "user", content: fillPromptTemplate(userTemplate, variables) },
    ];
  }

  /**
   * Assembles the end-of-session global pass input (ADR 0002): the FULL
   * Transcript for the one global pass, plus the live Topic timeline as a
   * merge hint (a Topic spanning summary ticks renders as continuation
   * sections live; the global pass merges them into whole semantic units).
   *
   * @param {object} state
   * @returns {{transcriptRecords: object[], liveTopics: object[]}}
   */
  function assembleGlobalPassInput(state) {
    const topics = Array.isArray(state?.topics) ? state.topics : [];
    return {
      transcriptRecords: [...(state?.transcriptRecords || [])],
      liveTopics: topics.map((topic) => ({
        start: Number(topic?.start) || 0,
        end: Number(topic?.end) || 0,
        title: String(topic?.title ?? ""),
      })),
    };
  }

  /**
   * Chat-completion messages for the Session Digest at session end: one
   * global pass over the full Transcript (ADR 0002), independent of the
   * Rolling Summary. The prompt copy lives in prompts/session-report.md,
   * loaded by the background layer and injected here. The live Topics ride
   * along as a reference the model may merge, never as input to trust
   * blindly; with an empty timeline the no-topics template variant drops
   * the hint.
   *
   * @param {{systemPrompt: string, userPrompt: string, userPromptWithoutTopics: string}} template
   * @param {{transcriptText: string, liveTopics: object[]}} input
   * @returns {Array<{role: string, content: string}>}
   */
  function buildGlobalPassMessages(template, { transcriptText, liveTopics }) {
    const topics = Array.isArray(liveTopics) ? liveTopics : [];
    const withTopics = topics.length > 0;
    const userTemplate = withTopics
      ? template.userPrompt
      : template.userPromptWithoutTopics;
    const variables = { transcriptText: transcriptText || "（无）" };
    if (withTopics) {
      variables.liveTopicsLines = topics
        .map(
          (topic) =>
            `[${formatTimestamp(topic?.start)}–${formatTimestamp(topic?.end)}] ${topic?.title ?? ""}`,
        )
        .join("\n- ");
    }
    return [
      { role: "system", content: template.systemPrompt },
      { role: "user", content: fillPromptTemplate(userTemplate, variables) },
    ];
  }

  /** Quote/todo text caps, sized like the Overview validator's caps. */
  const REPORT_QUOTE_MAX_LENGTH = 3000;
  const REPORT_TODO_MAX_LENGTH = 500;

  /**
   * Maps one raw model entry to a report Topic ({start, end, title,
   * summary}), or null when the entry is not usable (missing title/summary,
   * non-numeric or inverted time range) — the same shared validation as the
   * tick parser's sanitizeTopicEntry, with the body under `summary`.
   * Numbers become non-negative integer seconds; strings are trimmed and
   * length-capped.
   *
   * @param {*} entry
   * @returns {object|null}
   */
  function sanitizeReportTopic(entry) {
    const fields = sanitizeTopicFields(entry, "summary", TOPIC_TEXT_MAX_LENGTH);
    if (!fields) return null;
    return {
      start: fields.start,
      end: fields.end,
      title: fields.title,
      summary: fields.summary,
    };
  }

  /**
   * Maps one raw model entry to a report quote ({start, text}), or null when
   * the timestamp is not a number or the text is empty.
   *
   * @param {*} entry
   * @returns {object|null}
   */
  function sanitizeReportQuote(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const start = Number(entry.start);
    const text =
      typeof entry.text === "string" ? entry.text.trim().slice(0, REPORT_QUOTE_MAX_LENGTH) : "";
    if (!Number.isFinite(start) || !text) return null;
    return { start: Math.max(0, Math.floor(start)), text };
  }

  /**
   * Keeps only non-empty string todos, trimmed and length-capped; anything
   * else the model slipped in is dropped.
   *
   * @param {*} value
   * @returns {string[]}
   */
  function sanitizeReportTodos(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((todo) => typeof todo === "string" && todo.trim().length > 0)
      .map((todo) => todo.trim().slice(0, REPORT_TODO_MAX_LENGTH));
  }

  /**
   * Parses the global pass output into the Session Digest report. Tolerant
   * of the same LLM slips as the Topic tick parser (fences, prose, trailing
   * commas); the payload must be a JSON object, and every entry is
   * re-validated so a malformed item is dropped instead of reaching the
   * panel. Returns null when the text holds no usable report object at all —
   * the caller treats that like truncation and offers a retry.
   *
   * @param {string} text - raw text from the model
   * @returns {{topics: object[], quotes: object[], todos: string[]}|null}
   */
  function parseGlobalPass(text) {
    let parsed;
    try {
      parsed = parseLooseJson(text);
    } catch (_error) {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      topics: (Array.isArray(parsed.topics) ? parsed.topics : [])
        .map(sanitizeReportTopic)
        .filter(Boolean),
      quotes: (Array.isArray(parsed.quotes) ? parsed.quotes : [])
        .map(sanitizeReportQuote)
        .filter(Boolean),
      todos: sanitizeReportTodos(parsed.todos),
    };
  }

  return {
    coveredUntilFor,
    MIN_TICK_RECORDS,
    TOPIC_OVERLAP_SECONDS,
    topicCursor,
    isTopicTickDue,
    assembleTopicTickInput,
    fillPromptTemplate,
    buildTopicTickMessages,
    parseLooseJson,
    parseTopicTick,
    formatTranscriptForPrompt,
    assembleGlobalPassInput,
    buildGlobalPassMessages,
    parseGlobalPass,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SESSION_SUMMARY;
}
