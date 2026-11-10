/**
 * Resource/Source favorite domain (contract-v1.md §2.1–2.2, §3.1; decisions
 * 1, D2–D8). One favorite = one Resource + one Source (D5); duplicate
 * favorites return the same data (D3); everything is account-scoped (D2).
 *
 * Matching (platform-video-id-rules.md §2):
 * 1. a declared (or server-extracted) platform identity matches on
 *    (platformId, platformScopeId, platformVideoId, episodeId);
 * 2. with no identity confirmable, the §0 normalized address matches.
 * A declared identity that misses does NOT fall back to the address —
 * unresolvable share links stay separate Sources (D8).
 *
 * The shared extractor (contracts/platform-video-id.js) is the single
 * source of identity extraction and normalization; this module only adds
 * the account-scoped store access and the API kinds.
 */
const { ApiError, validationFailed, notFoundResource } = require("./errors");
const { generateId } = require("./ids");
const { normalizeUrl, extractVideoIdentity } = require("../../../contracts/platform-video-id");

// platformVideoId formats from platform-video-id-rules.md §1.
const PLATFORM_VIDEO_ID_FORMATS = {
  "xiaoe-tech": /^(p|v|a|i|l)_[a-z0-9]{4,}$/i,
  "bilibili": /^BV[0-9A-Za-z]{10}$/,
  "youtube": /^[0-9A-Za-z_-]{11}$/,
  "xiaohongshu": /^[0-9a-f]{24}$/,
};

function invalidUrl() {
  return new ApiError(400, "invalid_url", "仅支持 http(s) 网页地址");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a submitted identity declaration (contract §2.5). Returns the
 * normalized identity tuple, or null when nothing is declared. Well-formed
 * but unsupported declarations are contract 400s ("其他字段校验失败").
 */
function parseIdentity(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw validationFailed("identity 必须是对象");
  }
  const { platformId, platformVideoId } = value;
  if (
    (platformId === undefined || platformId === null) &&
    (platformVideoId === undefined || platformVideoId === null)
  ) {
    return null;
  }
  const format = PLATFORM_VIDEO_ID_FORMATS[platformId];
  if (!format) {
    throw validationFailed("identity.platformId 不受支持");
  }
  if (typeof platformVideoId !== "string" || !format.test(platformVideoId)) {
    throw validationFailed("identity.platformVideoId 与该平台的格式不符");
  }
  let episodeId = value.episodeId ?? null;
  if (platformId === "bilibili") {
    // Same default as URL extraction: an absent p means episode 1.
    if (episodeId === null) {
      episodeId = "1";
    } else if (typeof episodeId === "number" && Number.isInteger(episodeId)) {
      episodeId = String(episodeId);
    } else if (typeof episodeId !== "string" || !/^\d+$/.test(episodeId)) {
      throw validationFailed("identity.episodeId 必须是十进制分集号");
    } else {
      episodeId = String(Number.parseInt(episodeId, 10));
    }
  } else if (episodeId !== null) {
    throw validationFailed("该平台没有分集概念，不应携带 identity.episodeId");
  }
  let platformScopeId = value.platformScopeId ?? null;
  if (platformId === "xiaoe-tech") {
    // D7: the shop subdomain is part of the xiaoe identity.
    if (typeof platformScopeId !== "string" || platformScopeId === "") {
      throw validationFailed("小鹅通 identity 必须携带商店子域 platformScopeId");
    }
  } else if (platformScopeId !== null) {
    throw validationFailed("identity.platformScopeId 仅小鹅通支持");
  }
  return { platformId, platformVideoId, episodeId, platformScopeId };
}

/**
 * Validate a favorite/resolve request body (contract §3.1/§3.4: url
 * required http(s), title optional, identity optional). The raw address is
 * kept verbatim for storage; normalization happens through the shared
 * module only for matching.
 */
function parseSourceRequest(body) {
  if (!isPlainObject(body)) {
    throw validationFailed("缺少必填字段 url");
  }
  if (body.url === undefined || body.url === null || body.url === "") {
    throw validationFailed("缺少必填字段 url");
  }
  if (typeof body.url !== "string") {
    throw invalidUrl();
  }
  let parsed;
  try {
    parsed = new URL(body.url);
  } catch (_error) {
    throw invalidUrl();
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw invalidUrl();
  }
  let title = null;
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== "string") {
      throw validationFailed("title 必须是字符串");
    }
    title = body.title.trim() === "" ? null : body.title;
  }
  return {
    url: body.url,
    pathname: parsed.pathname,
    title,
    identity: parseIdentity(body.identity),
    normalized: normalizeUrl(body.url),
  };
}

/**
 * Source.kind from the identity (platform-video-id-rules.md §3): xiaoe
 * tokens map v_→video, a_→audio, l_→live (explicit replay paths → replay,
 * matching source-platforms.js precedence), i_/p_ containers → webpage;
 * the other three stations are playable video pages; no identity → webpage.
 */
function deriveSourceKind(identity, pathname) {
  if (!identity) {
    return "webpage";
  }
  if (identity.platformId === "xiaoe-tech") {
    const token = identity.platformVideoId.toLowerCase();
    if (token.startsWith("v_")) {
      return "video";
    }
    if (token.startsWith("a_")) {
      return "audio";
    }
    if (token.startsWith("l_")) {
      return /(^|\/)(replay|playback)([_\/-]|s|$)/i.test(pathname) ? "replay" : "live";
    }
    return "webpage";
  }
  return "video";
}

function matchByIdentity(sources, accountId, identity) {
  return (
    sources.find(
      (s) =>
        s.accountId === accountId &&
        s.platformId === identity.platformId &&
        s.platformScopeId === identity.platformScopeId &&
        s.platformVideoId === identity.platformVideoId &&
        s.episodeId === identity.episodeId,
    ) || null
  );
}

function matchByNormalizedUrl(sources, accountId, normalized) {
  return (
    sources.find((s) => s.accountId === accountId && s.normalizedUrl === normalized) || null
  );
}

/**
 * Find the account's existing Source for this request, or null. A
 * declared or server-extracted identity matches on the identity tuple;
 * otherwise the §0 normalized address decides (rules §2).
 */
function matchSource({ store, accountId, request }) {
  const identity = request.identity || extractVideoIdentity(request.url);
  const sources = store.list("sources");
  const source = identity
    ? matchByIdentity(sources, accountId, identity)
    : matchByNormalizedUrl(sources, accountId, request.normalized);
  if (!source) {
    return null;
  }
  const resource = store.get("resources", source.resourceId);
  return resource && resource.accountId === accountId ? { resource, source } : null;
}

/**
 * Create one Resource + one Source for the request (D5). The Source keeps
 * the raw first-favorited address (§2.2); normalizedUrl is internal.
 */
function createFavorite({ store, accountId, request, now }) {
  const atMs = now();
  const identity = request.identity || extractVideoIdentity(request.url) || null;
  const sourceKind = deriveSourceKind(identity, request.pathname);
  const resource = {
    id: generateId("res"),
    accountId,
    // Display title only (never matches); the address is the fallback.
    title: request.title || request.url,
    kind: sourceKind === "replay" ? "video" : sourceKind,
    // Contract §1: ISO 8601 UTC at the fixture sample's second precision;
    // ms stay internal for list ordering.
    createdAt: isoSeconds(atMs),
    createdAtMs: atMs,
  };
  const source = {
    id: generateId("src"),
    resourceId: resource.id,
    accountId,
    kind: sourceKind,
    url: request.url,
    platformId: identity ? identity.platformId : null,
    platformVideoId: identity ? identity.platformVideoId : null,
    episodeId: identity ? identity.episodeId : null,
    platformScopeId: identity ? identity.platformScopeId : null,
    normalizedUrl: request.normalized,
  };
  store.set("resources", resource.id, resource);
  store.set("sources", source.id, source);
  return { resource, source };
}

/**
 * Contract §1 timestamp format: ISO 8601 UTC at second precision, like the
 * fixture samples ("2026-11-10T08:00:00Z").
 */
function isoSeconds(atMs) {
  return new Date(Math.floor(atMs / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Contract §2.1 shape (internal fields stripped). */
function serializeResource(resource) {
  return {
    id: resource.id,
    title: resource.title,
    kind: resource.kind,
    createdAt: resource.createdAt,
  };
}

/** Contract §2.2 shape: the source plus the account's progress on it. */
function serializeSource({ store, source }) {
  const progress = store.get("progress", source.id);
  return {
    id: source.id,
    resourceId: source.resourceId,
    kind: source.kind,
    url: source.url,
    platformId: source.platformId,
    platformVideoId: source.platformVideoId,
    episodeId: source.episodeId,
    platformScopeId: source.platformScopeId,
    progress: progress
      ? { positionMs: progress.positionMs, revision: progress.revision }
      : null,
  };
}

function presentFavorite({ store, resource, source }) {
  return {
    resource: serializeResource(resource),
    source: serializeSource({ store, source }),
  };
}

/** All sources of one account's resource, insertion order. */
function sourcesForResource({ store, accountId, resourceId }) {
  return store
    .list("sources")
    .filter((s) => s.accountId === accountId && s.resourceId === resourceId);
}

/**
 * Contract §3.2: the account's resources, newest first, each with its
 * sources carrying the latest progress.
 */
function listResources({ store, accountId }) {
  const items = store
    .list("resources")
    .filter((r) => r.accountId === accountId)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .map((resource) => ({
      resource: serializeResource(resource),
      sources: sourcesForResource({ store, accountId, resourceId: resource.id }).map(
        (source) => serializeSource({ store, source }),
      ),
    }));
  return { status: 200, body: { resources: items } };
}

/**
 * Contract §3.3: one account resource with sources and notes. Reads run
 * with the accountId in the query (D2): other accounts' ids and unknown
 * ids are the same 404. Notes stay empty until P12 lands.
 */
function getResourceDetail({ store, accountId, id }) {
  const resource =
    store.list("resources").find((r) => r.id === id && r.accountId === accountId) || null;
  if (!resource) {
    throw notFoundResource();
  }
  return {
    status: 200,
    body: {
      resource: serializeResource(resource),
      sources: sourcesForResource({ store, accountId, resourceId: resource.id }).map(
        (source) => serializeSource({ store, source }),
      ),
      notes: [],
    },
  };
}

module.exports = {
  parseSourceRequest,
  matchSource,
  createFavorite,
  presentFavorite,
  listResources,
  getResourceDetail,
  serializeResource,
  serializeSource,
};
