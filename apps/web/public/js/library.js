/**
 * Library flow state machine (pure module — no DOM, no fetch). The P5
 * learning-library core on top of the P3 login shell: paste-to-collect,
 * the learning list, and the resource detail with manual retitle.
 *
 * It owns the decisions:
 * - collect runs the SHARED identity extractor (contracts/
 *   platform-video-id.js, injected as `identity.extractVideoIdentity`)
 *   client-side and posts the identity with the favorite (contract §2.5),
 *   omitting it when the URL alone cannot confirm one (D6/D8);
 * - a 201 create and a 200 duplicate hit present differently (D3: the
 *   duplicate IS the same resource — "已收藏，返回同一条资料");
 * - retitle goes through PATCH /v1/resources/{id} (contract §3.7, the
 *   round-1 supplement) with a locally-checked non-empty title;
 * - delete goes through DELETE /v1/resources/{id} (contract-r4 §8,
 *   ticket 5.5, decision D23) behind a TWO-STEP CONFIRM: the first click
 *   arms (button shows 确认删除, nothing is sent), the second click sends;
 *   blur or the 3s timeout disarms. Deletion is terminal (D23): a 404 is
 *   the "already deleted at the other end" presentation and the row
 *   leaves the list with 资料已不存在;
 * - every failed call presents the contract error envelope verbatim
 *   (`error.message`), so wording always matches the fixtures.
 *
 * The 401 path is deliberately NOT handled here: the api client's
 * interceptor clears the credential and calls back into the login flow
 * (P3), which swaps the shell back to the login view.
 *
 * Presentation helpers (formatPosition / progressLabel / platformLabel /
 * kindLabel / presentListItem / presentDetail / presentSummary /
 * presentSummariesList / presentUsage) are the data-level view model; the
 * page builds DOM from them without adding logic.
 */

import { renderMarkdown } from "./markdown.js";

// Display labels. Platform names follow GLOSSARY.md's Source Platforms;
// kinds follow contract §2.1/§2.2.
const PLATFORM_LABELS = {
  "xiaoe-tech": "小鹅通",
  "bilibili": "B站",
  "youtube": "YouTube",
  "xiaohongshu": "小红书",
};

const KIND_LABELS = {
  webpage: "网页",
  video: "视频",
  audio: "音频",
  live: "直播",
  replay: "回放",
};

/**
 * 250000 -> "4:10", 3661000 -> "1:01:01"; null/undefined -> null.
 * Progress positions are non-negative integers (contract §2.3).
 */
export function formatPosition(positionMs) {
  if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0) {
    return null;
  }
  const totalSeconds = Math.floor(positionMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const twoDigits = (value) => String(value).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`;
  }
  return `${minutes}:${twoDigits(seconds)}`;
}

/**
 * "上次学到 mm:ss" for a source with progress; null otherwise. The
 * has-progress judgment (round-1 review fix) is revision-based: a progress
 * record with revision ≥ 1 IS progress — positionMs 0 renders "上次学到
 * 0:00" — while a blob without a positive revision (or with an unusable
 * position) shows no line at all.
 */
export function progressLabel(source) {
  if (!source || !source.progress) {
    return null;
  }
  const { progress } = source;
  if (!Number.isInteger(progress.revision) || progress.revision < 1) {
    return null;
  }
  const position = formatPosition(progress.positionMs);
  return position ? `上次学到 ${position}` : null;
}

/** Platform badge text; null when the source has no recognized platform. */
export function platformLabel(platformId) {
  return PLATFORM_LABELS[platformId] || null;
}

/** Kind badge text; unknown kinds fall back to their raw value. */
export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || null;
}

/**
 * View model for one learning-list row: title, the original address to
 * open in a new tab, badges, and the progress line.
 */
export function presentListItem(item) {
  const source = item.sources && item.sources.length > 0 ? item.sources[0] : null;
  return {
    id: item.resource.id,
    title: item.resource.title,
    href: source ? source.url : null,
    kindLabel: kindLabel(item.resource.kind),
    platformLabel: source ? platformLabel(source.platformId) : null,
    progressText: source ? progressLabel(source) : null,
  };
}

/**
 * View model for the detail page: the editable title, each source as an
 * openable original address with its progress, and the notes read-back
 * (P12) as presentNote view models. Round 1 reads notes only — the Web
 * never writes them.
 */
export function presentDetail(detail) {
  const notes = (detail.notes || []).map(presentNote);
  return {
    id: detail.resource.id,
    title: detail.resource.title,
    sources: (detail.sources || []).map((source) => ({
      id: source.id,
      url: source.url,
      kindLabel: kindLabel(source.kind),
      platformLabel: platformLabel(source.platformId),
      progressText: progressLabel(source),
    })),
    notes,
    notesCount: notes.length,
  };
}

/**
 * View model for one read-back note (contract §2.4): the text plus, for a
 * timestamped note, the mm:ss stamp (same formatting as the progress
 * line). A plain webpage note carries sourceId/positionMs null and has no
 * stamp.
 */
export function presentNote(note) {
  return {
    id: note.id,
    text: note.text,
    stamp: formatPosition(note.positionMs),
    sourceId: note.sourceId === undefined || note.sourceId === null ? null : note.sourceId,
    positionMs:
      typeof note.positionMs === "number" && Number.isFinite(note.positionMs) && note.positionMs >= 0
        ? note.positionMs
        : null,
  };
}

export function noteKindLabel(note) {
  if (note.kind === "excerpt") return "逐字稿摘记";
  if (note.kind === "manual" || note.positionMs == null) return "手写笔记";
  return "带时间的笔记";
}

/**
 * "2026-11-10T10:00:00Z" -> "2026-11-10 10:00" in the viewer's local time
 * (the contract's ISO 8601 UTC instants, contract-v1 §1). Unusable inputs
 * render nothing rather than a broken stamp.
 */
export function formatDateTime(iso) {
  if (typeof iso !== "string" || iso === "") {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const twoDigits = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/**
 * Origin badge for one study session (contract-r2 §2.1): the path the
 * session's transcript came from — captions reads 字幕, asr reads 语音转写;
 * origin null (nothing archived yet) shows no badge.
 */
export function sessionOriginLabel(origin) {
  if (origin === "captions") {
    return "字幕";
  }
  if (origin === "asr") {
    return "语音转写";
  }
  return null;
}

const SESSION_STATUS_LABELS = {
  active: "进行中",
  finished: "已结束",
};

/**
 * "0 段文本" is never a part — an all-zero summary reads as its own line.
 */
function transcriptSummaryText(summary) {
  const parts = [];
  if (summary.recordCount > 0) {
    parts.push(`${summary.recordCount} 段文本`);
  }
  if (summary.gapCount > 0) {
    parts.push(`${summary.gapCount} 处已跳过`);
  }
  if (summary.failedCount > 0) {
    parts.push(`${summary.failedCount} 段转写失败`);
  }
  return parts.length > 0 ? parts.join(" · ") : "本次学习未产生逐字稿";
}

/**
 * View model for one session block header (contract-r2 §3.6 sessions[]):
 * the study time, the lifecycle status, the origin badge and the transcript
 * summary counts carried by the detail response (the full transcript text
 * arrives through the per-session second pull, see presentTranscript).
 */
export function presentSession(session) {
  const summary = session.transcript || { recordCount: 0, gapCount: 0, failedCount: 0 };
  return {
    id: session.id,
    sourceId: session.sourceId === undefined || session.sourceId === null ? null : session.sourceId,
    statusLabel: SESSION_STATUS_LABELS[session.status] || session.status,
    startedAtText: formatDateTime(session.startedAt),
    originLabel: sessionOriginLabel(session.origin),
    summaryText: transcriptSummaryText(summary),
  };
}

/** "150000, 210000" -> "2:30–3:30" on the source-video timeline; null when
 * either end is unusable (the view degrades instead of a broken range). */
function formatRange(startMs, endMs) {
  const start = formatPosition(startMs);
  const end = formatPosition(endMs);
  return start && end ? `${start}–${end}` : null;
}

/**
 * One transcript timeline row. The four TranscriptView arrays (contract-r2
 * §2.5) merge into a single startMs-ordered stream — the client "统一遍历"
 * the contract calls for — with a kind per row:
 * - record: a text segment; the stamp is the segment's start on the source
 *   timeline and, when the platform offers a seek parameter, a jump URL
 *   built by the SAME builder the round-1 note stamps use
 *   (SEEK_PARAM_BUILDERS via buildNoteJumpUrl: bilibili t=, youtube t=..s;
 *   小鹅通/小红书 and plain webpages get null -> the page shows the
 *   timestamp without a jump affordance, exactly like the notes);
 * - gap:    an explicitly skipped range (finish-reported, reason skipped)
 *           — nothing was captured, so no jump;
 * - pending: a still-transcribing audio segment (「转写中」; on a finished
 *   session a leftover pending row is queued work the drain could not
 *   finish — 「转写排队中（会话已结束）」, D15 evolution);
 * - failed: a failed audio segment with the contract error message verbatim.
 */
const TIMELINE_KIND_ORDER = { record: 0, pending: 1, failed: 2, gap: 3 };

/**
 * The pending row's label. An active session's pending segment is
 * 「转写中」; a finished session's leftover pending segment is work the
 * end-of-session drain could not finish (worker 停机且无租约时滞留, D15
 * evolution) — the view marks it queued instead of presenting a terminal
 * state (contract-r2 §2.5/§3.5).
 */
function pendingLabel(sessionStatus) {
  return sessionStatus === "finished" ? "转写排队中（会话已结束）" : "转写中";
}

export function presentTranscript(view, sources) {
  if (!view) {
    return [];
  }
  const entries = [
    ...(view.records || []).map((record) => ({
      kind: "record",
      startMs: record.startMs,
      endMs: record.endMs,
      stamp: formatPosition(record.startMs),
      text: record.text,
      detail: null,
      origin: record.origin === undefined ? null : record.origin,
      sessionId: record.sessionId === undefined ? null : record.sessionId,
      jumpUrl: buildNoteJumpUrl(
        { sourceId: view.sourceId, positionMs: record.startMs },
        sources,
      ),
    })),
    ...(view.gaps || []).map((gap) => ({
      kind: "gap",
      startMs: gap.startMs,
      endMs: gap.endMs,
      stamp: formatRange(gap.startMs, gap.endMs),
      text: "已跳过",
      detail: null,
      jumpUrl: null,
    })),
    ...(view.pending || []).map((segment) => ({
      kind: "pending",
      startMs: segment.startMs,
      endMs: segment.endMs,
      stamp: formatRange(segment.startMs, segment.endMs),
      text: pendingLabel(view.sessionStatus),
      detail: null,
      jumpUrl: null,
    })),
    ...(view.failed || []).map((segment) => ({
      kind: "failed",
      startMs: segment.startMs,
      endMs: segment.endMs,
      stamp: formatRange(segment.startMs, segment.endMs),
      text: "转写失败",
      detail: (segment.error && segment.error.message) || null,
      jumpUrl: null,
    })),
  ];
  return entries.sort(
    (a, b) =>
      a.startMs - b.startMs || TIMELINE_KIND_ORDER[a.kind] - TIMELINE_KIND_ORDER[b.kind],
  );
}

/**
 * Merge several sessions' transcript views into ONE resource-level
 * transcript (owner decision, 2026-11-17: a video learned in multiple
 * sessions stores/presents a single merged 逐字稿 — duplicate overlapping
 * copies break the course summary). Sessions stay the internal capture /
 * metering unit; the merged timeline is the only display and summary
 * input.
 *
 * Dedup rule (kept identical on the API side, summaries.collect_material):
 * - records: sorted by startMs; NEAR-DUPLICATE ranges cluster together —
 *   one range covering ≥80% of the other's shorter span — and the cluster
 *   keeps the best copy: longest text first, then captions over asr
 *   (authored beats machine), then the smaller sessionId — fully
 *   deterministic regardless of session list order. Plain touching
 *   overlap is NOT a duplicate: caption/ASR chunks advance in sliding
 *   windows (~50% pairwise overlap), and a transitive-overlap chain would
 *   collapse the whole transcript into one record. The survivor keeps
 *   its own sessionId + origin.
 * - gaps: overlapping ranges fold into one (min start, max end); a range
 *   already covered by a kept record is dropped (the record says more).
 * - failed: same range dedup, smallest (startMs, endMs, sessionId) kept.
 * - pending: kept as-is (only the active session can have any).
 *
 * @param {Array} views transcript views (§2.5 TranscriptView) in any
 *   session order; a null view (still loading / failed pull) is skipped.
 * @returns {{ sourceId, sessionStatus, records, gaps, pending, failed }}
 *   shaped exactly like one transcript view, ready for presentTranscript.
 */
export function mergeTranscriptViews(viewsIn) {
  const views = (Array.isArray(viewsIn) ? viewsIn : []).filter(Boolean);
  const sourceId = views.length > 0 ? views[0].sourceId : null;
  const active = views.find((view) => view.sessionStatus === "active");
  const sessionStatus = active ? "active" : "finished";

  const records = [];
  const failed = [];
  const pending = [];
  for (const view of views) {
    const origin = view.origin === undefined ? null : view.origin;
    for (const record of view.records || []) {
      records.push({ ...record, origin, sessionId: view.sessionId });
    }
    for (const segment of view.failed || []) {
      failed.push({ ...segment, sessionId: view.sessionId });
    }
    for (const segment of view.pending || []) {
      pending.push({ ...segment, sessionId: view.sessionId });
    }
  }
  records.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.endMs - b.endMs ||
      String(a.sessionId).localeCompare(String(b.sessionId)),
  );

  // Deterministic winner for a cluster: longest text; tie → captions over
  // asr (authored beats machine); tie → lexicographically smaller
  // sessionId. Session list order must never influence the outcome — the
  // API side merges the same data with its own store order.
  const originRank = (origin) => (origin === "captions" ? 0 : 1);
  function beats(challenger, current) {
    const lenDiff =
      String(challenger.text || "").length - String(current.text || "").length;
    if (lenDiff !== 0) return lenDiff > 0;
    const originDiff = originRank(challenger.origin) - originRank(current.origin);
    if (originDiff !== 0) return originDiff < 0;
    return String(challenger.sessionId) < String(current.sessionId);
  }

  // Same range re-captured, not a sliding-window neighbour: the
  // intersection must cover ≥80% of the shorter span. YouTube caption chunks
  // advance by roughly half their width (~50% pairwise overlap), so they
  // never cluster; exact copies across sessions do (100%).
  function nearDuplicate(a, b) {
    const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
    const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
    return shorter > 0 && overlap * 5 >= shorter * 4;
  }

  const keptRecords = [];
  let cluster = null;
  for (const record of records) {
    if (cluster && nearDuplicate(record, cluster.chosen)) {
      // Same range re-captured in another session: compete for the seat.
      if (beats(record, cluster.chosen)) {
        cluster.chosen = record;
      }
    } else {
      if (cluster) keptRecords.push(cluster.chosen);
      cluster = { chosen: record };
    }
  }
  if (cluster) keptRecords.push(cluster.chosen);

  // Gaps: fold overlaps, then drop any range a kept record already covers.
  const gaps = [];
  for (const view of views) {
    for (const gap of view.gaps || []) {
      gaps.push({ ...gap, sessionId: view.sessionId });
    }
  }
  gaps.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.endMs - b.endMs ||
      String(a.sessionId).localeCompare(String(b.sessionId)),
  );
  const foldedGaps = [];
  for (const gap of gaps) {
    const last = foldedGaps[foldedGaps.length - 1];
    if (last && gap.startMs < last.endMs) {
      if (gap.endMs > last.endMs) last.endMs = gap.endMs;
    } else {
      foldedGaps.push({ ...gap });
    }
  }
  const keptGaps = foldedGaps.filter(
    (gap) => !keptRecords.some((r) => r.startMs < gap.endMs && gap.startMs < r.endMs),
  );

  // Failed rows: same range dedup, smallest (startMs, endMs, sessionId) kept.
  failed.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.endMs - b.endMs ||
      String(a.sessionId).localeCompare(String(b.sessionId)),
  );
  const keptFailed = [];
  for (const segment of failed) {
    const last = keptFailed[keptFailed.length - 1];
    if (last && segment.startMs < last.endMs && last.startMs < segment.endMs) {
      continue;
    }
    keptFailed.push(segment);
  }

  return {
    sourceId,
    sessionStatus,
    records: keptRecords,
    gaps: keptGaps,
    pending,
    failed: keptFailed,
  };
}

/**
 * Best-effort jump-back to the note's position on the original platform
 * (ticket #61: 回原平台对应位置按平台能力尽力实现). Only platforms with a
 * documented seek parameter get a URL — bilibili appends `t=<seconds>` to
 * the source address (keeping its `p=` episode param), youtube appends
 * `t=<seconds>s`. xiaoe-tech has no documented seek parameter and plain
 * webpages have nothing to seek: both return null, and the page then
 * shows the timestamp without a jump affordance.
 *
 * @param {object} note a contract §2.4 note (sourceId + positionMs)
 * @param {Array} sources the detail's sources (with platformId and url)
 * @returns {string|null} the seek URL, or null when no jump is possible
 */
const SEEK_PARAM_BUILDERS = {
  bilibili: (seconds) => ({ t: String(seconds) }),
  youtube: (seconds) => ({ t: `${seconds}s` }),
};

export function buildNoteJumpUrl(note, sources) {
  if (
    !note ||
    typeof note.positionMs !== "number" ||
    !Number.isFinite(note.positionMs) ||
    note.positionMs < 0 ||
    !note.sourceId
  ) {
    return null;
  }
  const source = (sources || []).find((s) => s && s.id === note.sourceId);
  if (!source || typeof source.url !== "string") {
    return null;
  }
  const buildParams = SEEK_PARAM_BUILDERS[source.platformId];
  if (!buildParams) {
    return null;
  }
  try {
    const url = new URL(source.url);
    const params = buildParams(Math.floor(note.positionMs / 1000));
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch (_error) {
    return null;
  }
}

/**
 * View model for one Course Summary (round 3, ticket 3.3; contract-r3
 * §2.1/§2.2). The body renders through the SAFE markdown view models
 * (markdown.js — plain-text runs, no HTML string anywhere), and each
 * citation carries:
 * - quote:     the verbatim transcript excerpt (rendered as text, never
 *              markup — it is user-controlled);
 * - stamp:     the segmentRef range on the source timeline (0:30–1:00),
 *              degrading to null on unusable ranges;
 * - jumpUrl:   the best-effort seek URL through the SAME builder the
 *              notes/transcript use (SEEK_PARAM_BUILDERS). Citations name
 *              a SESSION, so the session's sourceId comes from the
 *              detail's sessions[]; a session outside that list (or a
 *              platform without seek support) gets null -> stamp only;
 * - session attribution: which study session the quote came from
 *              (startedAt text + origin badge), null when unknown.
 *
 * A null summary (a failed detail pull) maps to null — the page shows a
 * load-failure hint instead of content.
 */
export function presentSummary(summary, sessions, sources) {
  if (!summary) {
    return null;
  }
  const sessionById = new Map((sessions || []).map((session) => [session.id, session]));
  const presentCitation = ({ quote, segmentRef }) => {
    const session = sessionById.get(segmentRef?.sessionId);
    return {
      quote,
      stamp: formatRange(segmentRef?.startMs, segmentRef?.endMs),
      jumpUrl: buildNoteJumpUrl(
        { sourceId: session?.sourceId, positionMs: segmentRef?.startMs },
        sources,
      ),
      sessionStartedAtText: session ? formatDateTime(session.startedAt) : null,
      sessionOriginLabel: session ? sessionOriginLabel(session.origin) : null,
    };
  };
  const flowchart = summary.flowchart;
  const groups = new Map();
  if (Array.isArray(flowchart?.nodes) && Array.isArray(flowchart?.edges)) {
    const labels = new Map(flowchart.nodes.map((node) => [node.id, node.label]));
    for (const edge of flowchart.edges) {
      if (!labels.has(edge.from) || !labels.has(edge.to) || !edge.citation) {
        continue;
      }
      if (!groups.has(edge.from)) {
        groups.set(edge.from, { id: edge.from, label: labels.get(edge.from), branches: [] });
      }
      groups.get(edge.from).branches.push({
        step: labels.get(edge.to),
        condition: edge.label,
        ...presentCitation(edge.citation),
      });
    }
  }
  return {
    id: summary.id,
    blocks: renderMarkdown(summary.content),
    generatedAtText: formatDateTime(summary.generatedAt),
    citations: (summary.citations || []).map(presentCitation),
    citationCount: (summary.citations || []).length,
    flowchart: groups.size ? { title: flowchart.title, groups: [...groups.values()] } : null,
  };
}

/**
 * View models for the history list (contract-r3 §3.2: 历次生成，generatedAt
 * 倒序，历史保留可回查). The list arrives newest-first from the API; the
 * ordinal is the generation number — the newest item is 第 N 次 (N = list
 * length), the oldest 第 1 次. Junk input renders as nothing.
 */
export function presentSummariesList(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item, index) => ({
    id: item.id,
    ordinal: items.length - index,
    generatedAtText: formatDateTime(item.generatedAt),
    citationCount: item.citationCount,
  }));
}

/**
 * View model for the account usage line (round 3, contract-r3 §2.4/§3.4;
 * D18 只记录不计费 — no price, no billing, no quota wording anywhere).
 * audioSeconds renders with the same mm:ss formatting as every other
 * duration on the page. Before the first recorded write the API answers
 * updatedAt null — the entry then reads 「从未产生用量」 instead of a row of
 * zeroes. Junk input degrades to the same line.
 */
export function presentUsage(usage) {
  if (!usage || usage.updatedAt === null || usage.updatedAt === undefined) {
    return { text: "从未产生用量" };
  }
  const audioText = formatPosition(usage.audioSeconds * 1000) || "0:00";
  const updatedText = formatDateTime(usage.updatedAt) || "";
  return {
    text: `累计用量：转写 ${audioText} · 总结 ${usage.summaryCount} 次 · 输入 ${usage.summaryInputChars} 字符 · 更新于 ${updatedText}`,
    audioText,
    summaryCount: usage.summaryCount,
    summaryInputChars: usage.summaryInputChars,
    updatedText,
  };
}

/**
 * The delete confirm window (ticket 5.5): how long the armed 「确认删除」
 * state stays before reverting. The page re-renders when it elapses; the
 * decision lives here, main.js only imports the number for its render.
 */
export const DELETE_CONFIRM_MS = 3000;

/**
 * @param {object} options
 * @param {object} options.api createApiClient-shaped seam:
 *   { createResource, listResources, getResourceDetail, updateResourceTitle,
 *     deleteResource } -> { ok, status, data }
 * @param {object} options.identity the shared contracts module:
 *   { extractVideoIdentity } (browser: window.YTD_PLATFORM_VIDEO_ID)
 * @param {number} [options.deleteConfirmMs] the armed-confirm window (tests
 *   shrink it; the page never overrides the 3s default)
 */
export function createLibraryFlow({ api, identity, deleteConfirmMs = DELETE_CONFIRM_MS }) {
  let view = "list"; // "list" | "detail"
  let resources = [];
  let detail = null;
  let notice = null;
  let error = null;
  let busy = false;
  // Round-3 Course Summary state (contract-r3 §3.1-§3.3), reset per detail:
  // summaries is the history (newest first, §3.2 projections), activeId the
  // generation on display, summaryDetails the id -> full summary cache
  // (null marks a failed pull), generating the explicit in-flight flag.
  let summaries = [];
  let activeSummaryId = null;
  let summaryDetails = {};
  let summariesError = null;
  let generating = false;
  // Delete two-step confirm (contract-r4 §8, ticket 5.5): armedDelete is
  // the one armed button ({ id, surface: "list" | "detail" }) or null;
  // disarmTimer reverts it after the window (and is cancelled by the
  // second click, a blur disarm, navigation or reset).
  let armedDelete = null;
  let disarmTimer = null;

  function getState() {
    return { view, resources, detail, notice, error, busy, summaries, activeSummaryId, summaryDetails, summariesError, generating, armedDelete };
  }

  function envelopeMessage(data) {
    return (data && data.error && data.error.message) || "请求失败，请稍后重试";
  }

  function cancelDisarmTimer() {
    if (disarmTimer !== null) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
  }

  function scheduleAutoDisarm() {
    cancelDisarmTimer();
    disarmTimer = setTimeout(() => {
      disarmTimer = null;
      armedDelete = null;
    }, deleteConfirmMs);
    // A dangling timer must not hold a node:test process open (browsers
    // return a plain number without unref).
    if (typeof disarmTimer.unref === "function") {
      disarmTimer.unref();
    }
  }

  /**
   * Disarm the confirm (blur, explicit cancel, navigation): the button
   * reverts, nothing is sent. Returns whether anything changed so the
   * page only re-renders on a real flip.
   */
  function disarmDelete() {
    cancelDisarmTimer();
    if (!armedDelete) {
      return false;
    }
    armedDelete = null;
    return true;
  }

  /** The summary caches belong to one resource; a delete wipes them. */
  function clearSummaryState() {
    summaries = [];
    activeSummaryId = null;
    summaryDetails = {};
    summariesError = null;
  }

  /**
   * The delete entry point, shared by the list rows and the detail page
   * (contract-r4 §8, D23). Toggle semantics: the first click arms (no
   * request), the second — while armed for the SAME id AND surface —
   * sends the DELETE.
   *
   * - 200: the row is gone server-side; refresh the list (资源已不在) and
   *   clear the summary caches; from the detail view, return to the list.
   * - 404: deletion is terminal (D23) — this is "already deleted at the
   *   other end": drop the row locally, resync the list, present
   *   资料已不存在 (not an error).
   * - other failures: the envelope verbatim, nothing touched.
   */
  async function deleteClick(id, surface = "list") {
    if (busy) {
      return { ok: false };
    }
    if (!armedDelete || armedDelete.id !== id || armedDelete.surface !== surface) {
      armedDelete = { id, surface };
      scheduleAutoDisarm();
      return { ok: false, armed: true };
    }
    disarmDelete();
    busy = true;
    const result = await api.deleteResource(id);
    busy = false;
    if (!result.ok) {
      if (result.status === 404) {
        resources = resources.filter((item) => !item.resource || item.resource.id !== id);
        clearSummaryState();
        notice = "资料已不存在";
        error = null;
        await load();
        return { ok: false, gone: true };
      }
      error = envelopeMessage(result.data);
      return { ok: false };
    }
    notice = "已删除";
    error = null;
    clearSummaryState();
    if (surface === "detail" && detail && detail.resource.id === id) {
      view = "list";
      detail = null;
    }
    await load();
    return { ok: true };
  }

  async function load() {
    busy = true;
    const result = await api.listResources();
    busy = false;
    if (!result.ok) {
      error = envelopeMessage(result.data);
      return { ok: false };
    }
    resources = (result.data && result.data.resources) || [];
    error = null;
    return { ok: true };
  }

  /**
   * Paste-to-collect (contract §3.1): extract the identity locally, then
   * POST. 201 creates, 200 hits the same resource again (D3).
   */
  async function collect({ url, title } = {}) {
    if (busy) {
      return { ok: false };
    }
    const trimmedUrl = typeof url === "string" ? url.trim() : "";
    if (trimmedUrl === "") {
      error = "请输入网页链接";
      return { ok: false };
    }
    const body = { url: trimmedUrl };
    const trimmedTitle = typeof title === "string" ? title.trim() : "";
    if (trimmedTitle !== "") {
      body.title = trimmedTitle;
    }
    const extracted = identity.extractVideoIdentity(trimmedUrl);
    if (extracted) {
      body.identity = extracted;
    }
    busy = true;
    const result = await api.createResource(body);
    busy = false;
    if (!result.ok) {
      error = envelopeMessage(result.data);
      return { ok: false };
    }
    error = null;
    // D3: 201 created, 200 hit the account's existing source — the same
    // data either way, so the list refresh alone makes it a single item.
    notice = result.status === 200 ? "已收藏，返回同一条资料" : "已收藏";
    await load();
    return { ok: true, status: result.status };
  }

  /**
   * Open the detail view for one resource (contract §3.3, extended by
   * contract-r2 §3.6). The detail's sessions[] carries each study session
   * plus only the transcript SUMMARY counts ({ recordCount, gapCount,
   * failedCount }) — the contract pins the full text to the per-Session
   * second pull through GET /v1/sessions/{id}/transcript (§3.5), one read
   * per block here. A failed pull leaves that block null (the page renders
   * the header from the detail and a load-failure line) instead of failing
   * the whole detail; a detail without sessions skips the pull entirely.
   */
  /**
   * Pull one generation's full form (contract-r3 §3.3) into the cache.
   * A failed pull marks the entry null (the page shows a load-failure
   * hint for it) instead of failing the flow; a pull that lands after the
   * user navigated to another resource is discarded.
   */
  async function fetchSummaryDetail(summaryId) {
    const resourceId = detail ? detail.resource.id : null;
    const result = await api.getSummary(summaryId);
    if (!detail || detail.resource.id !== resourceId) {
      return;
    }
    summaryDetails[summaryId] =
      result.ok && result.data && result.data.summary ? result.data.summary : null;
  }

  /**
   * Load the summaries history (contract-r3 §3.2, newest first) and focus
   * one generation — focusId, or the newest when unspecified. An empty
   * history focuses nothing; a failed list read presents the envelope
   * verbatim without failing the whole detail.
   */
  async function loadSummaries({ focusId } = {}) {
    if (!detail) {
      return;
    }
    const resourceId = detail.resource.id;
    const result = await api.listSummaries(resourceId);
    if (!detail || detail.resource.id !== resourceId) {
      return;
    }
    if (!result.ok) {
      summariesError = envelopeMessage(result.data);
      return;
    }
    summaries = (result.data && result.data.summaries) || [];
    summariesError = null;
    const target = focusId || (summaries.length > 0 ? summaries[0].id : null);
    activeSummaryId = target;
    if (target) {
      await fetchSummaryDetail(target);
    }
  }

  async function openDetail(id) {
    disarmDelete();
    busy = true;
    const result = await api.getResourceDetail(id);
    if (!result.ok) {
      busy = false;
      error = envelopeMessage(result.data);
      return { ok: false };
    }
    detail = result.data;
    error = null;
    notice = null;
    view = "detail";
    detail.transcripts = {};
    summaries = [];
    activeSummaryId = null;
    summaryDetails = {};
    summariesError = null;
    await Promise.all([
      Promise.all(
        (detail.sessions || []).map(async (session) => {
          const transcript = await api.getSessionTranscript(session.id);
          detail.transcripts[session.id] = transcript.ok ? transcript.data : null;
        }),
      ),
      loadSummaries(),
    ]);
    busy = false;
    return { ok: true };
  }

  function backToList() {
    disarmDelete();
    view = "list";
    detail = null;
  }

  /** Full wipe for the next session (logout / login as another account). */
  function reset() {
    disarmDelete();
    view = "list";
    resources = [];
    detail = null;
    notice = null;
    error = null;
    busy = false;
    summaries = [];
    activeSummaryId = null;
    summaryDetails = {};
    summariesError = null;
    generating = false;
  }

  /**
   * Manual retitle (contract §3.7, round-1 supplement): only a non-empty
   * title; the envelope's 400/404 present verbatim.
   */
  async function retitle(id, rawTitle) {
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
    if (title === "") {
      error = "标题不能为空";
      return { ok: false };
    }
    busy = true;
    const result = await api.updateResourceTitle(id, title);
    busy = false;
    if (!result.ok) {
      error = envelopeMessage(result.data);
      return { ok: false };
    }
    if (detail && detail.resource && detail.resource.id === id && result.data && result.data.resource) {
      detail.resource = result.data.resource;
    }
    error = null;
    notice = "标题已更新";
    await load();
    return { ok: true };
  }

  /**
   * User-initiated summary generation (round 3, ticket 3.3; contract-r3
   * §3.1). The POST runs synchronously server-side and can take tens of
   * seconds — no timeout is faked; the explicit `generating` flag holds
   * the button disabled and the 进行时文案 on the page. Re-entry while a
   * generation is in flight is ignored (the contract leaves repeat-click
   * debounce to this side, §1).
   *
   * 201 -> refresh the history and focus the NEW generation (每次生成一条
   * 新记录, §1 幂等例外); the history stays untouched on failure. Every
   * failure presents the contract envelope verbatim — 409
   * no_transcript_to_summarize and 502 summary_generation_failed included;
   * a 401 is the api client's interceptor's to handle. A landing that
   * arrives after the user navigated to another resource refreshes
   * nothing (the state belongs to the resource it was started on).
   */
  async function generateSummary() {
    if (generating || !detail) {
      return { ok: false };
    }
    const resourceId = detail.resource.id;
    generating = true;
    summariesError = null;
    const result = await api.generateSummary(resourceId);
    generating = false;
    if (!result.ok) {
      summariesError = envelopeMessage(result.data);
      return { ok: false, status: result.status };
    }
    if (detail && detail.resource.id === resourceId) {
      const newId = result.data && result.data.summary ? result.data.summary.id : undefined;
      await loadSummaries({ focusId: newId });
    }
    return { ok: true };
  }

  /**
   * Switch the displayed generation (历次回查): the id goes first so the
   * click feels immediate, the full form is pulled once and cached.
   */
  async function showSummary(summaryId) {
    if (!detail) {
      return { ok: false };
    }
    activeSummaryId = summaryId;
    if (summaryDetails[summaryId] === undefined) {
      await fetchSummaryDetail(summaryId);
    }
    return { ok: true };
  }

  return { getState, load, collect, openDetail, backToList, retitle, deleteClick, disarmDelete, generateSummary, showSummary, reset };
}
