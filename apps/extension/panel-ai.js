/**
 * Panel AI client, server-side (ticket 6.6, issue #91; contract-r4 §6/§7):
 * the client piece the panel's AI features need now that the rolling
 * summary, the session digest and the explain-selection all run on the
 * learning service instead of a locally configured AI Provider (D21/D22).
 *
 * - Paths + rhythm: the contract routes and the PoC's content-driven tick
 *   debounce (≥ the configured coverage interval AND ≥ 10 new records),
   * with the coverage cursor externalized — the server owns the real
 *   cursor (overview.lastCoveredMs), the client only keeps its own copy
 *   for the debounce decision.
 * - Parsers: the SessionOverview (§6.1) and SessionDigest (§7.1) payload
 *   validators, plus the digest→report-artifact mapping that lets the
 *   existing report renderers (report-render.js) and the persisted
 *   `report_<sessionId>` artifact keep working unchanged — only the
 *   source-timeline unit converts, from the server's milliseconds to the
 *   panel's seconds.
 * - Verdicts: one classifier for the §1 error envelope across the §6.4/§7.4
 *   codes; the server's message always passes through verbatim (如实呈现).
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts. The success shapes are
 * pinned to contracts/fixtures/session-overview-examples.json and
 * session-digest-examples.json in tests/panel-ai.test.js.
 */
var YTD_PANEL_AI = (() => {
  const apiClient =
    typeof YTD_API_CLIENT !== "undefined"
      ? YTD_API_CLIENT
      : require("./api-client.js");

  // ============================================================
  // PATHS (§1: opaque ids are encoded — a hostile id must not change the
  // path shape)
  // ============================================================

  function sessionRoute(sessionId, leaf) {
    return `/v1/sessions/${encodeURIComponent(String(sessionId))}/${leaf}`;
  }

  function rollingSummaryPath(sessionId) {
    return sessionRoute(sessionId, "rolling-summary");
  }

  function overviewPath(sessionId) {
    return sessionRoute(sessionId, "overview");
  }

  function digestPath(sessionId) {
    return sessionRoute(sessionId, "digest");
  }

  function explainPath() {
    return "/v1/ai/explain";
  }

  // ============================================================
  // TICK RHYTHM (the PoC debounce, cursor externalized)
  // ============================================================

  /** A tick needs at least this many new Transcript records (the debounce). */
  const MIN_TICK_RECORDS = 10;

  /**
   * The timeline position (seconds from Session start) up to which a set of
   * Transcript records is covered (the shared coveredUntil convention).
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

  /**
   * The content-driven trigger decision for a rolling-summary tick (the
   * retired PoC isTopicTickDue, its cursor externalized): a tick is due
   * when the Transcript coverage since the caller's cursor reaches the
   * configured interval AND at least MIN_TICK_RECORDS new records exist.
   * Quiet stretches produce no ticks because coverage never grows; a failed
   * tick leaves the cursor untouched, so the next timer fire simply retries.
   *
   * The cursor is the caller's copy of the server's coverage position
   * (overview.lastCoveredMs in seconds) — the server's Topics are the real
   * timeline; this only paces the POSTs.
   *
   * @param {{state: object, cursorSeconds: number, intervalMinutes: number, minRecords?: number}} input
   * @returns {boolean}
   */
  function isRollingSummaryDue({
    state,
    cursorSeconds,
    intervalMinutes,
    minRecords = MIN_TICK_RECORDS,
  }) {
    const cursor = Math.max(0, Math.floor(Number(cursorSeconds) || 0));
    const records = Array.isArray(state?.transcriptRecords)
      ? state.transcriptRecords
      : [];
    // Records at or after the cursor (a record counts as covered when its
    // start is strictly below the cursor); failure markers stay in every
    // window so a summary can mention the gap.
    const newRecords = records.filter(
      (record) => (Number(record?.start) || 0) >= cursor,
    );
    if (newRecords.length < Math.max(1, Number(minRecords) || 0)) return false;
    const coverageSeconds = coveredUntilFor(newRecords) - cursor;
    return coverageSeconds >= Math.max(0, Number(intervalMinutes) || 0) * 60;
  }

  // ============================================================
  // SESSIONOVERVIEW (§6.1)
  // ============================================================

  function isFiniteNonNegativeInt(value) {
    return Number.isInteger(value) && value >= 0;
  }

  /**
   * One overview Topic entry (§6.1): index ≥ 1, a valid millisecond range,
   * non-empty title and text; `continuation` survives only as true.
   *
   * @param {*} entry
   * @returns {object|null}
   */
  function parseOverviewTopic(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const index = Number(entry.index);
    const startMs = Number(entry.startMs);
    const endMs = Number(entry.endMs);
    if (!Number.isInteger(index) || index < 1) return null;
    if (!isFiniteNonNegativeInt(startMs) || !isFiniteNonNegativeInt(endMs)) return null;
    if (endMs < startMs) return null;
    const title = typeof entry.title === "string" ? entry.title : "";
    const text = typeof entry.text === "string" ? entry.text : "";
    if (!title.trim() || !text.trim()) return null;
    const topic = { index, startMs, endMs, title, text };
    if (entry.continuation === true) topic.continuation = true;
    return topic;
  }

  /**
   * The SessionOverview payload (§6.1) from a `{overview}` response body:
   * the envelope shape is validated (sessionId, topics, lastCoveredMs,
   * generation, generatedAt) and malformed Topic entries are dropped.
   * Returns null when the payload is not a usable overview at all.
   *
   * @param {*} data
   * @returns {object|null}
   */
  function parseOverview(data) {
    const overview = data && typeof data === "object" ? data.overview : null;
    if (!overview || typeof overview !== "object" || Array.isArray(overview)) {
      return null;
    }
    if (typeof overview.sessionId !== "string" || !overview.sessionId) return null;
    const lastCoveredMs = Number(overview.lastCoveredMs);
    if (!isFiniteNonNegativeInt(lastCoveredMs)) return null;
    const generation =
      overview.generation && typeof overview.generation === "object"
        ? overview.generation
        : null;
    if (!generation) return null;
    if (typeof overview.generatedAt !== "string" || !overview.generatedAt) return null;
    const topics = (Array.isArray(overview.topics) ? overview.topics : [])
      .map(parseOverviewTopic)
      .filter(Boolean);
    return {
      sessionId: overview.sessionId,
      topics,
      lastCoveredMs,
      generation,
      generatedAt: overview.generatedAt,
    };
  }

  /** ms → panel seconds (floored), the one unit conversion of this module. */
  function msToSeconds(ms) {
    return Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  }

  /**
   * The overview's Topics in the live-timeline shape the panel renders
   * (seconds on the source timeline, `text` bodies, the continuation flag).
   *
   * @param {object|null} overview - parseOverview's shape
   * @returns {Array<{start: number, end: number, title: string, text: string, continuation?: true}>}
   */
  function overviewLiveTopics(overview) {
    if (!overview) return [];
    return (overview.topics || []).map((topic) => {
      const mapped = {
        start: msToSeconds(topic.startMs),
        end: msToSeconds(topic.endMs),
        title: topic.title,
        text: topic.text,
      };
      if (topic.continuation === true) mapped.continuation = true;
      return mapped;
    });
  }

  /**
   * The caller's debounce cursor derived from the adopted overview: the
   * server's lastCoveredMs floored to panel seconds.
   *
   * @param {object|null} overview
   * @returns {number}
   */
  function overviewCursorSeconds(overview) {
    if (!overview) return 0;
    return msToSeconds(overview.lastCoveredMs);
  }

  // ============================================================
  // SESSIONDIGEST (§7.1)
  // ============================================================

  function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }

  function parseDigestTopic(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const startMs = Number(entry.startMs);
    const endMs = Number(entry.endMs);
    if (!isFiniteNonNegativeInt(startMs) || !isFiniteNonNegativeInt(endMs)) return null;
    if (endMs < startMs) return null;
    if (typeof entry.title !== "string" || !entry.title.trim()) return null;
    const topic = { startMs, endMs, title: entry.title };
    if (Array.isArray(entry.bullets) && entry.bullets.every((b) => typeof b === "string")) {
      topic.bullets = entry.bullets;
    }
    if (typeof entry.summary === "string") topic.summary = entry.summary;
    // §7.1: bullets and summary — at least one must exist.
    if (!topic.bullets && !topic.summary) return null;
    return topic;
  }

  function parseDigestCategory(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.title !== "string" || !entry.title.trim()) return null;
    if (!isStringArray(entry.points)) return null;
    return { title: entry.title, points: entry.points };
  }

  function parseDigestQuote(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const startMs = Number(entry.startMs);
    if (!isFiniteNonNegativeInt(startMs)) return null;
    if (typeof entry.text !== "string" || !entry.text.trim()) return null;
    return { startMs, text: entry.text };
  }

  /**
   * The SessionDigest payload (§7.1) from a `{digest}` response body: the
   * five report keys are fixed (empty sections arrive as empty arrays), the
   * envelope shape is validated, malformed entries are dropped. Returns
   * null when the payload is not a usable digest at all.
   *
   * @param {*} data
   * @returns {object|null}
   */
  function parseDigest(data) {
    const digest = data && typeof data === "object" ? data.digest : null;
    if (!digest || typeof digest !== "object" || Array.isArray(digest)) return null;
    if (typeof digest.sessionId !== "string" || !digest.sessionId) return null;
    if (!isStringArray(digest.overview)) return null;
    if (!isStringArray(digest.todos)) return null;
    if (!Array.isArray(digest.topics) || !Array.isArray(digest.categories) || !Array.isArray(digest.quotes)) {
      return null;
    }
    const generation =
      digest.generation && typeof digest.generation === "object"
        ? digest.generation
        : null;
    if (!generation) return null;
    if (typeof digest.generatedAt !== "string" || !digest.generatedAt) return null;
    return {
      sessionId: digest.sessionId,
      overview: digest.overview,
      topics: digest.topics.map(parseDigestTopic).filter(Boolean),
      categories: digest.categories.map(parseDigestCategory).filter(Boolean),
      quotes: digest.quotes.map(parseDigestQuote).filter(Boolean),
      todos: digest.todos,
      generation,
      generatedAt: digest.generatedAt,
    };
  }

  /**
   * Maps a parsed digest into the persisted report artifact shape
   * (`report_<sessionId>`): the report renderers (report-render.js), the
   * D7 startup scan and the report page keep their exact consumer shape —
   * only the timestamps convert from the server's milliseconds to the
   * panel's seconds. `meta` stays null (the caller attaches the artifact
   * meta when it knows the wall-clock range); generatedAtMs comes from the
   * server's ISO stamp, falling back to the mapping time.
   *
   * @param {{digest: object, sessionId: string}} input - parseDigest's shape
   *   under `digest`, plus the LOCAL session id the artifact is keyed by
   * @returns {{sessionId: string, report: object, meta: null, generatedAtMs: number}}
   */
  function digestToReportArtifact({ digest, sessionId }) {
    const parsedAtMs = Date.parse(digest.generatedAt);
    return {
      sessionId,
      report: {
        overview: digest.overview,
        topics: (digest.topics || []).map((topic) => {
          const mapped = {
            start: msToSeconds(topic.startMs),
            end: msToSeconds(topic.endMs),
            title: topic.title,
          };
          if (topic.bullets) mapped.bullets = topic.bullets;
          if (topic.summary) mapped.summary = topic.summary;
          return mapped;
        }),
        categories: (digest.categories || []).map((category) => ({
          title: category.title,
          points: category.points,
        })),
        quotes: (digest.quotes || []).map((quote) => ({
          start: msToSeconds(quote.startMs),
          text: quote.text,
        })),
        todos: digest.todos,
      },
      meta: null,
      generatedAtMs: Number.isFinite(parsedAtMs) ? parsedAtMs : Date.now(),
    };
  }

  // ============================================================
  // EXPLAIN (§7.2, stateless)
  // ============================================================

  /**
   * The explain request body: `text` required and non-empty; `context`
   * optional, omitted entirely when empty (the server treats missing and
   * empty the same). Returns null when the text is not a usable string —
   * the caller refuses instead of burning a guaranteed 400.
   *
   * @param {{text?: string, context?: string}} input
   * @returns {{text: string, context?: string}|null}
   */
  function buildExplainBody({ text, context } = {}) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return null;
    const body = { text: trimmed };
    const trimmedContext = typeof context === "string" ? context.trim() : "";
    if (trimmedContext) body.context = trimmedContext;
    return body;
  }

  /**
   * The `{explanation}` response body: the explanation string, or null when
   * the server answered without a usable one.
   *
   * @param {*} data
   * @returns {string|null}
   */
  function parseExplanation(data) {
    const explanation = data && typeof data === "object" ? data.explanation : null;
    return typeof explanation === "string" && explanation.trim() ? explanation : null;
  }

  // ============================================================
  // VERDICTS (§1 envelope; contract-r4 §6.4/§7.4)
  // ============================================================

  /**
   * One HTTP outcome → verdict, shared by the rolling-summary, overview,
   * digest and explain calls. The terminal verdicts (unauthorized,
   * notGenerated, notFound, noTranscript, notFinished, failed, invalid)
   * never retry from here — the callers own their retry policies (the tick
   * timer retries by design; the digest offers the panel's retry entry).
   * The server's envelope message passes through verbatim on every verdict.
   *
   * @param {{status?: number, data?: object, network?: boolean, networkMessage?: string, fallback?: string}} input
   * @returns {{kind: string, code?: string, message?: string}}
   */
  function classifyPanelAiOutcome({ status, data, network, networkMessage, fallback = "请求未完成" }) {
    if (network) return { kind: "network", message: networkMessage };
    if (status >= 200 && status < 300) return { kind: "ok" };
    const code = apiClient.envelopeCode(data);
    const message = apiClient.parseEnvelope(data, fallback);
    if (status === 401) return { kind: "unauthorized", code, message };
    if (status === 404) {
      if (code === "overview_not_generated" || code === "digest_not_generated") {
        return { kind: "notGenerated", code, message };
      }
      return { kind: "notFound", code, message };
    }
    if (status === 409) {
      if (code === "no_session_transcript_to_summarize") {
        return { kind: "noTranscript", code, message };
      }
      if (code === "session_not_finished") {
        return { kind: "notFinished", code, message };
      }
      return { kind: "error", code, message };
    }
    if (status === 502) return { kind: "failed", code, message };
    if (status === 400) return { kind: "invalid", code, message };
    return { kind: "error", code, message: apiClient.parseEnvelope(data, `HTTP ${status}`) };
  }

  return {
    MIN_TICK_RECORDS,
    rollingSummaryPath,
    overviewPath,
    digestPath,
    explainPath,
    coveredUntilFor,
    isRollingSummaryDue,
    parseOverview,
    overviewLiveTopics,
    overviewCursorSeconds,
    parseDigest,
    digestToReportArtifact,
    buildExplainBody,
    parseExplanation,
    classifyPanelAiOutcome,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_PANEL_AI;
}
