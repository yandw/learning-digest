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

  /** Open the detail view for one resource (contract §3.3). */
  async function openDetail(id) {
    busy = true;
    const result = await api.getResourceDetail(id);
    busy = false;
    if (!result.ok) {
      error = envelopeMessage(result.data);
      return { ok: false };
    }
    detail = result.data;
    error = null;
    notice = null;
    view = "detail";
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
