/**
 * Site-capability layer (ticket 6.3, issue #88 — sub-issue of spec #49):
 * the extension's view of the server-side site capability registry
 * (contract-r4 §3.1's GET /v1/site-capabilities — Bearer, any logged-in
 * user, body { capabilities: [{platformId, captions, asr, enabled}] }; the
 * registry itself is ticket 6.1's work).
 *
 * Three capability sources combine, in this order:
 * - the BUILT-IN DEFAULT TABLE below — the fallback when the API is
 *   unreachable, times out or fails (失败/超时兜底), and the base every
 *   server answer merges over;
 * - the server's rows — fetched at panel startup and before a start, cached
 *   in the capability store with a TTL (DEFAULT_TTL_MS = 10 minutes);
 * - the Source Platform adapters' own declarations
 *   (source-platforms.js captionsReader) — the final captions capability is
 *   the server switch AND the reader's availability, so a server that
 *   switches captions on for a platform without a captions reader still
 *   cannot send the extension probing for captions that cannot be read.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded with importScripts / <script> tags — the auth-gate.js /
 * learning-start.js pattern: fetch and clock are injected, the §1 envelope
 * helpers ride the shared api-client.js module.
 */
var YTD_SITE_CAPABILITIES = (() => {
  const apiClient =
    typeof YTD_API_CLIENT !== "undefined"
      ? YTD_API_CLIENT
      : require("./api-client.js");

  const SITE_CAPABILITIES_PATH = "/v1/site-capabilities";

  /**
   * The cache lifetime for a fetched server table. A site the operator just
   * disabled can keep starting for up to this long when the panel stays
   * open — the next panel open and the next start both refresh first, so in
   * practice the staleness window is one panel session.
   */
  const DEFAULT_TTL_MS = 10 * 60 * 1000;

  /**
   * The row every platform without a specific entry gets (6.1's unknown
   * platform seed). asr-only and enabled: an unlisted recognized platform
   * keeps starting (任何网页可收藏; start gating needs an explicit server
   * enabled=false), it just never takes the captions path.
   */
  const DEFAULT_ROW = Object.freeze({
    captions: false,
    asr: true,
    enabled: true,
  });

  /**
   * The built-in default table — exactly contract-r4 §2.1's seed defaults,
   * keyed by the extension's own Source Platform ids (source-platforms.js:
   * the xiaoe adapter's id is "xiaoe-tech"; the registry's row id "xiaoe"
   * is aliased at the boundary, see SERVER_PLATFORM_ID_ALIASES). Frozen;
   * merging never mutates it.
   */
  const DEFAULT_TABLE = Object.freeze({
    bilibili: Object.freeze({ captions: true, asr: true, enabled: true }),
    youtube: Object.freeze({ captions: true, asr: true, enabled: true }),
    "xiaoe-tech": Object.freeze({ captions: false, asr: true, enabled: true }),
    xiaohongshu: Object.freeze({ captions: false, asr: true, enabled: true }),
  });

  function buildSiteCapabilitiesApiUrl(apiBaseUrl) {
    return apiClient.buildApiUrl(apiBaseUrl, SITE_CAPABILITIES_PATH);
  }

  /**
   * The registry's platformId for the xiaoe Source Platform (contract-r4
   * §2.1 seeds the row as "xiaoe") — while the extension's adapter id (and
   * the Source.platformId the identity extractor produces) is "xiaoe-tech".
   * The alias is applied at the boundary when server rows are normalized,
   * so exactly one canonical id exists inside the extension and a server
   * "xiaoe" row governs the extension's xiaoe start gating and captions
   * decision.
   */
  const SERVER_PLATFORM_ID_ALIASES = Object.freeze({ xiaoe: "xiaoe-tech" });

  function canonicalPlatformId(platformId) {
    return SERVER_PLATFORM_ID_ALIASES[platformId] || platformId;
  }

  /**
   * One capability row: the three flags as booleans, defaulting like the
   * unknown-platform seed when a flag is missing (the contract pins all
   * four fields required — the defaults are client-side resilience only).
   * A row that is not an object (or carries no usable platformId) is
   * malformed — null.
   */
  function normalizeRow(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rawId =
      typeof raw.platformId === "string" && raw.platformId.trim() !== ""
        ? raw.platformId.trim()
        : null;
    if (!rawId) return null;
    return {
      platformId: canonicalPlatformId(rawId),
      captions: raw.captions !== undefined ? !!raw.captions : DEFAULT_ROW.captions,
      asr: raw.asr !== undefined ? !!raw.asr : DEFAULT_ROW.asr,
      enabled: raw.enabled !== undefined ? !!raw.enabled : DEFAULT_ROW.enabled,
    };
  }

  /**
   * The capability row for one platform: the table's entry, or the unknown
   * default. Never null, never throws — a garbage platformId reads as
   * unknown.
   */
  function capabilityFor(table, platformId) {
    const key = typeof platformId === "string" && platformId ? platformId : "";
    if (key && table && Object.prototype.hasOwnProperty.call(table, key)) {
      return table[key];
    }
    return DEFAULT_ROW;
  }

  // ============================================================
  // GET /v1/site-capabilities: verdict + response parsing
  // ============================================================

  /**
   * One read of the response body; a non-JSON body parses to null (the
   * transcript-pipeline.js readJson rule).
   */
  async function readJson(response) {
    try {
      return await response.json();
    } catch (_error) {
      return null;
    }
  }

  /**
   * The GET verdict from one response. 200 with the contract-r4 §3.1 body —
   * { capabilities: [...] } — yields { kind: "ok", rows } (malformed
   * entries dropped); 401 → "unauthorized" (the wiring routes the P7
   * linked-logout path); anything else — 5xx, bodies without a
   * capabilities array, network failures — is a transient "error" whose
   * fallback is the built-in default table, never a wrong capability.
   */
  function parseSiteCapabilitiesResponse({ status, data, network } = {}) {
    if (network) return { kind: "error" };
    if (status >= 200 && status < 300) {
      const rows = data && Array.isArray(data.capabilities) ? data.capabilities : null;
      if (!rows) return { kind: "error" };
      const parsed = [];
      for (const entry of rows) {
        const row = normalizeRow(entry);
        if (row) parsed.push(row);
      }
      return { kind: "ok", rows: parsed };
    }
    if (status === 401) return { kind: "unauthorized" };
    return { kind: "error" };
  }

  // ============================================================
  // MERGE: server rows over the built-in defaults
  // ============================================================

  /**
   * The effective capability table: the base table with one merged row per
   * well-formed server row. Pure — the base table (and its frozen rows) is
   * never mutated; a server row for an id the client does not recognize is
   * kept (the table mirrors the server's registry; capabilityFor reads it).
   */
  function applyServerRows(serverRows, baseTable) {
    const merged = { ...baseTable };
    for (const raw of Array.isArray(serverRows) ? serverRows : []) {
      const row = normalizeRow(raw);
      if (row) merged[row.platformId] = row;
    }
    return merged;
  }

  // ============================================================
  // THE CAPABILITY STORE: fetch + cache + fallback
  // ============================================================

  /** The GET timeout (ms): a hung API reads as failure → default table. */
  const DEFAULT_TIMEOUT_MS = 5_000;

  /**
   * The cached capability view the worker wiring consumes. One in-flight
   * GET at a time (a panel open and a start racing share the request);
   * fetch/clock/timers are injected so Node tests drive everything.
   *
   * Fallback policy (ticket 6.3): a verdict that is not ok — network
   * failure, timeout, 5xx, malformed body — and a 401 alike serve the
   * BUILT-IN DEFAULT TABLE for this round; a previously fetched table is
   * not extended past its TTL by a failed refresh (the operator may have
   * just disabled the site; the default table is the safe fallback the
   * ticket names). The 401 additionally fires onUnauthorized — the wiring
   * routes the P7 linked-logout path; capability data itself falls back.
   *
   * @param {object} options
   * @param {(url: string, init?: object) => Promise<Response>} [options.fetchImpl]
   * @param {() => number} [options.now] injected clock (ms)
   * @param {number} [options.ttlMs] cache lifetime (DEFAULT_TTL_MS)
   * @param {number} [options.timeoutMs] per-request timeout (DEFAULT_TIMEOUT_MS)
   * @param {(platformId: string) => boolean} [options.declaresCaptionsReader]
   *   the adapter-declaration seam (source-platforms.js captionsReaderFor):
   *   the final captions capability is the server switch AND this.
   * @param {() => void} [options.onUnauthorized] 401 hook (P7 routing)
   * @param {Function} [options.setTimeoutImpl]
   * @param {Function} [options.clearTimeoutImpl]
   */
  function createCapabilityStore({
    fetchImpl = fetch,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    declaresCaptionsReader = () => false,
    onUnauthorized = () => {},
    setTimeoutImpl = (fn, delay) => setTimeout(fn, delay),
    clearTimeoutImpl = (id) => clearTimeout(id),
  } = {}) {
    let serverRows = null; // the last ok GET's rows; null serves the defaults
    let fetchedAtMs = null;
    let inFlight = null;

    function effectiveTable() {
      return serverRows
        ? applyServerRows(serverRows, DEFAULT_TABLE)
        : DEFAULT_TABLE;
    }

    async function fetchRows(apiBaseUrl, token) {
      const url = buildSiteCapabilitiesApiUrl(apiBaseUrl);
      if (!url || typeof token !== "string" || token === "") {
        return { status: 0, data: null, network: true, unreachable: true };
      }
      // The timeout race: a hung GET resolves to the timeout outcome (the
      // same 失败/超时兜底 as any other failure), and the timer is cleared
      // when the fetch wins so no stray beat lingers behind the store.
      let timerId = null;
      let outcome;
      try {
        outcome = await Promise.race([
          (async () => {
            const response = await fetchImpl(url, {
              method: "GET",
              headers: { Authorization: `Bearer ${token}` },
            });
            return { status: response.status, data: await readJson(response) };
          })(),
          new Promise((resolve) => {
            timerId = setTimeoutImpl(() => {
              timerId = null;
              resolve({ status: 0, data: null, network: true, timedOut: true });
            }, timeoutMs);
          }),
        ]);
      } catch (_error) {
        outcome = { status: 0, data: null, network: true };
      } finally {
        if (timerId !== null) clearTimeoutImpl(timerId);
      }
      return outcome;
    }

    async function refresh({ apiBaseUrl, token }) {
      const outcome = await fetchRows(apiBaseUrl, token);
      const verdict = parseSiteCapabilitiesResponse(outcome);
      if (verdict.kind === "ok") {
        serverRows = verdict.rows;
        fetchedAtMs = now();
      } else if (verdict.kind === "unauthorized") {
        try {
          onUnauthorized();
        } catch (_error) {
          // The hook must never break the fallback.
        }
      }
      return verdict;
    }

    return {
      /**
       * Fetches when the cache is absent or stale (or force is set — the
       * pre-start refresh). Concurrent calls share one in-flight GET. The
       * returned verdict reports what this round used: "ok" (fresh rows),
       * "unauthorized" (P7) or "error" (defaults serving).
       */
      ensureFresh({ apiBaseUrl, token, force = false } = {}) {
        const fresh =
          fetchedAtMs !== null && now() - fetchedAtMs < ttlMs && serverRows !== null;
        if (fresh && !force) return Promise.resolve({ kind: "ok", cached: true });
        if (!inFlight) {
          inFlight = refresh({ apiBaseUrl, token }).finally(() => {
            inFlight = null;
          });
        }
        return inFlight;
      },

      /** The capability row for one platform (defaults when unfetched). */
      capabilityFor(platformId) {
        return capabilityFor(effectiveTable(), platformId);
      },

      /**
       * The final captions capability for one platform: the server switch
       * (or the default row's) AND the Source Platform adapter's own
       * captionsReader declaration. A platform without a reader never
       * probes, whatever the server says.
       */
      captionsEnabledFor(platformId) {
        const row = capabilityFor(effectiveTable(), platformId);
        return !!row.captions && !!declaresCaptionsReader(platformId);
      },

      /** Test/diagnostics view. */
      snapshot() {
        return {
          hasServerRows: serverRows !== null,
          fetchedAtMs,
          stale: fetchedAtMs === null || now() - fetchedAtMs >= ttlMs,
        };
      },
    };
  }

  return {
    SITE_CAPABILITIES_PATH,
    DEFAULT_TTL_MS,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_ROW,
    DEFAULT_TABLE,
    buildSiteCapabilitiesApiUrl,
    normalizeRow,
    capabilityFor,
    readJson,
    parseSiteCapabilitiesResponse,
    applyServerRows,
    createCapabilityStore,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SITE_CAPABILITIES;
}
