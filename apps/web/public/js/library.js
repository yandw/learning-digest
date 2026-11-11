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
 * - every failed call presents the contract error envelope verbatim
 *   (`error.message`), so wording always matches the fixtures.
 *
 * The 401 path is deliberately NOT handled here: the api client's
 * interceptor clears the credential and calls back into the login flow
 * (P3), which swaps the shell back to the login view.
 *
 * Presentation helpers (formatPosition / progressLabel / platformLabel /
 * kindLabel / presentListItem / presentDetail) are the data-level view
 * model; the page builds DOM from them without adding logic.
 */

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
 * - pending: a still-transcribing audio segment (「转写中」);
 * - failed: a failed audio segment with the contract error message verbatim.
 */
const TIMELINE_KIND_ORDER = { record: 0, pending: 1, failed: 2, gap: 3 };

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
      text: "转写中",
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
 * @param {object} options
 * @param {object} options.api createApiClient-shaped seam:
 *   { createResource, listResources, getResourceDetail, updateResourceTitle }
 *   -> { ok, status, data }
 * @param {object} options.identity the shared contracts module:
 *   { extractVideoIdentity } (browser: window.YTD_PLATFORM_VIDEO_ID)
 */
export function createLibraryFlow({ api, identity }) {
  let view = "list"; // "list" | "detail"
  let resources = [];
  let detail = null;
  let notice = null;
  let error = null;
  let busy = false;

  function getState() {
    return { view, resources, detail, notice, error, busy };
  }

  function envelopeMessage(data) {
    return (data && data.error && data.error.message) || "请求失败，请稍后重试";
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
  async function openDetail(id) {
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
    await Promise.all(
      (detail.sessions || []).map(async (session) => {
        const transcript = await api.getSessionTranscript(session.id);
        detail.transcripts[session.id] = transcript.ok ? transcript.data : null;
      }),
    );
    busy = false;
    return { ok: true };
  }

  function backToList() {
    view = "list";
    detail = null;
  }

  /** Full wipe for the next session (logout / login as another account). */
  function reset() {
    view = "list";
    resources = [];
    detail = null;
    notice = null;
    error = null;
    busy = false;
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

  return { getState, load, collect, openDetail, backToList, retitle, reset };
}
