/**
 * Session summaries: pure assembly for the Topic timeline and Session Digest.
 *
 * Two prompt inputs are assembled here, both browser-free so they can be
 * unit-tested in Node and loaded by the service worker with importScripts:
 *
 * - Topic tick input: the Transcript records since the coverage cursor (the
 *   end of the last Topic, or 0) plus a context-only overlap tail before it
 *   and the existing Topics' titles. The background layer sends that to the
 *   AI Provider when the content-driven trigger fires and feeds the parsed
 *   result back as a `topicsAppended` event; the state machine appends to
 *   the timeline without rewriting earlier Topics (ADR 0002).
 * - Global pass input: the FULL Transcript plus the live Topic timeline as
 *   a merge hint, assembled once when the Session ends. The background layer
 *   sends it in one request and persists the parsed report as the Session
 *   Digest artifact (ADR 0002).
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

  // --- Topic timeline (ADR 0002): content-driven tick trigger and block
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
   * Assembles one Topic tick's block input from Session state:
   *
   * - newTranscript: the Transcript records at or after the Topic cursor
   *   (the only records that may be summarized into new Topics);
   * - overlapTail: the records covering the last TOPIC_OVERLAP_SECONDS
   *   before the cursor, carried along as context-only input so a Topic
   *   spanning the block boundary is not summarized as unrelated fragments
   *   (they are never summarized into new Topics);
   * - existingTopicTitles: the appended Topics' titles in timeline order, so
   *   the model can mark the first output Topic as a continuation.
   *
   * @param {object} state
   * @returns {{cursor: number, newTranscript: object[], overlapTail: object[], existingTopicTitles: string[]}}
   */
  function assembleTopicBlockInput(state) {
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
   * Maps one raw model entry to a Topic shape, or null when the entry is
   * not a usable Topic (missing title/text, non-numeric or inverted time
   * range). Numbers become non-negative integer seconds; strings are
   * trimmed and length-capped; continuation survives only as a true flag.
   *
   * @param {*} entry
   * @returns {object|null}
   */
  function sanitizeTopicEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const start = Number(entry.start);
    const end = Number(entry.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const safeStart = Math.max(0, Math.floor(start));
    const safeEnd = Math.max(0, Math.floor(end));
    if (safeEnd < safeStart) return null;
    const title =
      typeof entry.title === "string" ? entry.title.trim().slice(0, TOPIC_TITLE_MAX_LENGTH) : "";
    const text =
      typeof entry.text === "string" ? entry.text.trim().slice(0, TOPIC_TEXT_MAX_LENGTH) : "";
    if (!title || !text) return null;
    const topic = { start: safeStart, end: safeEnd, title, text };
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
  function parseTopicBlock(text) {
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

  // The Topic tick prompt stays in Chinese: the product (prompt, titles,
  // summaries, panel copy) is Chinese-only, and the transcript language
  // must not leak into the timeline.
  const TOPIC_BLOCK_SYSTEM_PROMPT = `你在维护一节长课程的话题段时间轴。请把「本段新逐字稿」切分成一到多个话题段（Topic）：每个话题段是语义连贯的一段内容，可以跨越逐字稿的固定切片边界。
只输出一个 JSON 数组，不要输出任何其他文字，格式如下：
[{"start": 起始秒数, "end": 结束秒数, "title": "短标题", "text": "总结", "continuation": true}]
要求：
- start 和 end 是相对会话开始的秒数（整数），必须落在本段新逐字稿的时间范围内。
- title 是不超过 20 字的短标题；text 是 2 到 4 句的总结；两者一律用简体中文，忽略逐字稿本身的语言。
- 第一个话题段如果延续上一批的最后一个话题（见「上一批的最后一个话题」），给它加 "continuation": true；其余话题段一律不加该字段。
- 「上文回顾」里的逐字稿只是上下文，不要把它们写成新的话题段，也不要因此重复已总结过的内容。
- 如果逐字稿里有 [语音转录失败] 这样的失败标记，请在对应话题段的总结里提及该时间段的空缺，不要编造内容。`;

  // The global pass prompt stays in Chinese like the Topic tick prompt: the
  // product (prompt, titles, summaries, panel copy) is Chinese-only, and the
  // transcript language must not leak into the report.
  const GLOBAL_PASS_SYSTEM_PROMPT = `你在为已结束的课程生成一份完整的会话纪要。请通读全部逐字稿，一次性完成全局整理，只输出一个 JSON 对象，不要输出任何其他文字，格式如下：
{"topics": [{"start": 起始秒数, "end": 结束秒数, "title": "短标题", "summary": "总结"}], "quotes": [{"start": 时间戳秒数, "text": "原话"}], "todos": ["待办事项"]}
要求：
- topics 把整节课切分成语义连贯的话题段：start 和 end 是相对会话开始的秒数（整数），时间范围必须以逐字稿为准；title 是不超过 20 字的短标题，summary 是 2 到 4 句的总结，两者一律用简体中文，忽略逐字稿本身的语言。
- 课中时间轴上因分段总结拆开的延续话题（同一话题被拆成多段）必须合并为一个完整的话题段，不要按拆分后的片段划分。
- 逐字稿因录音切片可能出现在开头或结尾被截断的句子：忽略截断痕迹，把跨切片的句子衔接起来理解，不要为切片边界单独划分话题。
- quotes 挑选课中最有价值的原话（最多 5 条），每条必须携带它在逐字稿中的时间戳（秒数）。
- 只有当逐字稿里确实出现行动项（作业、待办、下一步要做的事）时才输出 todos；没有就输出空数组。
- 如果逐字稿里有 [语音转录失败] 这样的失败标记，请在对应话题段的总结里提及该时间段的空缺，不要编造内容。`;

  /**
   * Chat-completion messages for one Topic tick.
   *
   * @param {{existingTopicTitles: string[], contextTranscriptText: string, newTranscriptText: string}} input
   * @returns {Array<{role: string, content: string}>}
   */
  function buildTopicBlockMessages({
    existingTopicTitles,
    contextTranscriptText,
    newTranscriptText,
  }) {
    const titles = Array.isArray(existingTopicTitles) ? existingTopicTitles : [];
    const userParts = [];
    if (titles.length > 0) {
      userParts.push(
        `已有话题（按时间顺序）：\n${titles.map((title) => `- ${title}`).join("\n")}`,
      );
      userParts.push(`上一批的最后一个话题：「${titles[titles.length - 1]}」`);
    } else {
      userParts.push("这是本次会话的第一批话题段，此前没有已有话题。");
    }
    userParts.push(
      `上文回顾（仅作上下文，不要总结成新的话题段）：\n${contextTranscriptText || "（无）"}`,
    );
    userParts.push(`本段新逐字稿：\n${newTranscriptText}`);
    return [
      { role: "system", content: TOPIC_BLOCK_SYSTEM_PROMPT },
      { role: "user", content: userParts.join("\n\n") },
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
   * Rolling Summary. The live Topics ride along as a reference the model may
   * merge, never as input to trust blindly.
   *
   * @param {{transcriptText: string, liveTopics: object[]}} input
   * @returns {Array<{role: string, content: string}>}
   */
  function buildGlobalPassMessages({ transcriptText, liveTopics }) {
    const userParts = [];
    const topics = Array.isArray(liveTopics) ? liveTopics : [];
    if (topics.length > 0) {
      userParts.push(
        `课中已识别的话题段（可参考/合并）：\n${topics
          .map(
            (topic) =>
              `- [${formatTimestamp(topic?.start)}–${formatTimestamp(topic?.end)}] ${topic?.title ?? ""}`,
          )
          .join("\n")}`,
      );
    }
    userParts.push(`完整逐字稿：\n${transcriptText || "（无）"}`);
    return [
      { role: "system", content: GLOBAL_PASS_SYSTEM_PROMPT },
      { role: "user", content: userParts.join("\n\n") },
    ];
  }

  /** Quote/todo text caps, sized like the Overview validator's caps. */
  const REPORT_QUOTE_MAX_LENGTH = 3000;
  const REPORT_TODO_MAX_LENGTH = 500;

  /**
   * Maps one raw model entry to a report Topic ({start, end, title,
   * summary}), or null when the entry is not usable (missing title/summary,
   * non-numeric or inverted time range). Numbers become non-negative integer
   * seconds; strings are trimmed and length-capped.
   *
   * @param {*} entry
   * @returns {object|null}
   */
  function sanitizeReportTopic(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const start = Number(entry.start);
    const end = Number(entry.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const safeStart = Math.max(0, Math.floor(start));
    const safeEnd = Math.max(0, Math.floor(end));
    if (safeEnd < safeStart) return null;
    const title =
      typeof entry.title === "string" ? entry.title.trim().slice(0, TOPIC_TITLE_MAX_LENGTH) : "";
    const summary =
      typeof entry.summary === "string"
        ? entry.summary.trim().slice(0, TOPIC_TEXT_MAX_LENGTH)
        : "";
    if (!title || !summary) return null;
    return { start: safeStart, end: safeEnd, title, summary };
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
    assembleTopicBlockInput,
    buildTopicBlockMessages,
    parseLooseJson,
    parseTopicBlock,
    formatTranscriptForPrompt,
    assembleGlobalPassInput,
    buildGlobalPassMessages,
    parseGlobalPass,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SESSION_SUMMARY;
}
