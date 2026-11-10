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

/** "上次学到 mm:ss" for a source with progress; null otherwise. */
export function progressLabel(source) {
  if (!source || !source.progress || typeof source.progress.positionMs !== "number") {
    return null;
  }
  const position = formatPosition(source.progress.positionMs);
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
 * openable original address with its progress, and the note count for the
 * notes block (the notes themselves arrive with P12).
 */
export function presentDetail(detail) {
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
    notesCount: (detail.notes || []).length,
  };
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
