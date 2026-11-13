/**
 * Learning-start layer (P10, issue #59): the pure contract layer behind the
 * panel's course tab list, the locked learning target and the real-time
 * progress writes. The background service worker calls into this module;
 * copy strings and DOM stay in the panel. Pure and require()-able — no
 * chrome or DOM dependencies — following the collect.js / auth-gate.js
 * pattern: fully covered by Node tests, consumed by the worker via
 * importScripts.
 *
 * Decision 4 of spec #49 (the start side): learning only records after
 * 开始学习; the recorded target is locked while a Session runs — browser
 * focus or tab switching can never change it — and the list becomes
 * selectable again once the Session ends.
 *
 * Contract v1 (contracts/contract-v1.md):
 * - §3.5 PUT /v1/sources/{id}/progress — { positionMs, expectedRevision };
 *   200 returns { positionMs, revision }; 409 carries
 *   `current: { positionMs, revision }` (decision D4: positionMs can legally
 *   go backwards, so the revision number is the only concurrency signal and
 *   the client decides to overwrite from `current`).
 * - §2.3 positionMs is the last ACTUALLY PLAYED position — drags backward
 *   (回拖) are saved as-is.
 *
 * Write policy (aligned with apps/api/app/progress.py, ticket #54):
 * - throttle: positions coalesce; at most one PUT per `throttleMs` window
 *   (default 10s), always carrying the NEWEST pending position. Key events
 *   bypass the throttle: the first position after start (the anchor), a
 *   backward drag (the server must learn the rewound position quickly), and
 *   the end-of-Session flush.
 * - 409: adopt `current.revision` as the next expectedRevision and retry
 *   the LATEST local position immediately (bounded by maxConflictRetries),
 *   so the learner's newest position always wins and is never lost.
 * - 401: stop the writer permanently and surface onUnauthorized — the
 *   worker wiring routes the learner back through the authorization gate
 *   and stops the Session (the P7 linked-logout path takes over capture).
 * - 404: the source is not writable by this account (D2 isolation); stop.
 * - network failure: bounded exponential backoff resends the SAME
 *   expectedRevision + positionMs on the throttle schedule. The API treats
 *   that exact resend as an idempotent re-ack (200 without bumping the
 *   revision, see apps/api/app/progress.py); if the original write had
 *   landed, the resend turns into a 409 whose `current` is adopted. When
 *   the backoff budget is exhausted the latest position stays pending and
 *   is retried after the throttle window — the pending slot only ever holds
 *   the newest position, so nothing stale is ever queued behind it.
 *   Throttle-bypassing cycles (key events, flush) never wait on the network:
 *   their first failed attempt defers to the throttle schedule so an
 *   awaited flush cannot stall the Session end.
 */
var YTD_LEARNING_START = (() => {
  const DEFAULT_THROTTLE_MS = 10_000;
  const DEFAULT_NETWORK_RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
  const DEFAULT_MAX_CONFLICT_RETRIES = 3;

  // ============================================================
  // COURSE TAB LIST
  // ============================================================

  function parseUrl(url) {
    try {
      const parsed = new URL(String(url));
      return /^https?:$/.test(parsed.protocol) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  /** Only http(s) pages are listable course tabs. */
  function isListableUrl(url) {
    return parseUrl(url) !== null;
  }

  /**
   * The panel's course tab list from the open tabs (background tabs
   * included). Video pages (the four round-1 stations with a confirmable
   * identity, or a registered Source Platform page — the ones with a media
   * player to record) sort first; the original tab order is preserved
   * inside each tier. While a Session records, the locked target stays
   * visible (`isTarget`) and every other row is marked `locked` so the
   * panel renders it unselectable.
   *
   * @param {object} parts
   * @param {Array<{id: unknown, url: unknown, title: unknown}>} parts.tabs
   *   chrome.tabs.query output (any shape; garbage entries are skipped)
   * @param {number|null} parts.lockedTabId - the recorded target's tab, or null
   * @param {(url: string) => boolean} parts.isVideoPage - injected checker
   * @returns {Array<{tabId: number, url: string, title: string, video: boolean, locked: boolean, isTarget: boolean}>}
   */
  function buildCourseTabList({ tabs, lockedTabId, isVideoPage } = {}) {
    const checkVideo = typeof isVideoPage === "function" ? isVideoPage : () => false;
    const entries = [];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (!tab || typeof tab.id !== "number") continue;
      if (typeof tab.url !== "string" || !isListableUrl(tab.url)) continue;
      entries.push({
        tabId: tab.id,
        url: tab.url,
        title:
          typeof tab.title === "string" && tab.title.trim() !== ""
            ? tab.title.trim()
            : tab.url,
        video: checkVideo(tab.url),
      });
    }
    entries.sort((a, b) => (a.video === b.video ? 0 : a.video ? -1 : 1));
    const locking = typeof lockedTabId === "number" ? lockedTabId : null;
    return entries.map((entry) => ({
      ...entry,
      locked: locking !== null && entry.tabId !== locking,
      isTarget: locking !== null && entry.tabId === locking,
    }));
  }

  // ============================================================
  // LEARNING TARGET STATE MACHINE (decision 4 of #49)
  // ============================================================
  //
  // idle → chosen (panel picked a course tab) → locked (Session recording;
  // nothing can retarget it) → idle (Session ended, list selectable again).
  // The toolbar-icon path has no choice step and locks straight from idle.
  // The machine only changes through these explicit calls — there is no
  // "active tab" input at all, which is exactly the decision-4 guarantee:
  // focus and tab switches cannot change the recorded target.

  function createTargetState() {
    return {
      status: "idle",
      target: null,
      sourceId: null,
      sessionId: null,
      expectedRevision: 0,
    };
  }

  function sanitizeTarget(target) {
    if (!target || typeof target !== "object") return null;
    const tabId =
      typeof target.tabId === "number" && Number.isInteger(target.tabId)
        ? target.tabId
        : null;
    if (tabId === null || typeof target.url !== "string" || !isListableUrl(target.url)) {
      return null;
    }
    return {
      tabId,
      url: target.url,
      title: typeof target.title === "string" ? target.title.trim() : "",
    };
  }

  function chooseTarget(state, target) {
    if (state && state.status === "locked") {
      return { ok: false, reason: "locked", state };
    }
    const sanitized = sanitizeTarget(target);
    if (!sanitized) return { ok: false, reason: "invalidTarget", state };
    return {
      ok: true,
      state: { ...createTargetState(), status: "chosen", target: sanitized },
    };
  }

  /**
   * Locks the target for a running Session. From `chosen` the tabId must
   * match the chosen target; from `idle` (toolbar-icon start) the passed
   * target becomes the target directly. `sourceId` is null when the page
   * had no resolvable source — capture still runs, progress simply has
   * nowhere to write.
   */
  function lockTarget(state, { tabId, url, title, sessionId, sourceId, expectedRevision } = {}) {
    if (state && state.status === "locked") {
      return { ok: false, reason: "locked", state };
    }
    if (state && state.status === "chosen") {
      const chosen = sanitizeTarget(state.target);
      if (!chosen || chosen.tabId !== tabId) {
        return { ok: false, reason: "targetMismatch", state };
      }
    }
    const sanitized = sanitizeTarget({ tabId, url, title });
    if (!sanitized) return { ok: false, reason: "invalidTarget", state };
    return {
      ok: true,
      state: {
        status: "locked",
        target: sanitized,
        sourceId: typeof sourceId === "string" && sourceId ? sourceId : null,
        sessionId: typeof sessionId === "string" && sessionId ? sessionId : null,
        expectedRevision:
          Number.isInteger(expectedRevision) && expectedRevision >= 0
            ? expectedRevision
            : 0,
      },
    };
  }

  /** Session ended: the list becomes selectable again. */
  function endTarget(state) {
    return createTargetState();
  }

  function isLocked(state) {
    return !!(state && state.status === "locked");
  }

  function targetInfo(state) {
    if (!state || state.status !== "locked") return null;
    return {
      target: state.target,
      sourceId: state.sourceId,
      sessionId: state.sessionId,
      expectedRevision: state.expectedRevision,
    };
  }

  /** JSON-plain snapshot for chrome.storage.local; null when nothing is held. */
  function serializeTarget(state) {
    const info = targetInfo(state);
    if (info) return { status: "locked", ...info };
    if (state && state.status === "chosen" && state.target) {
      return { status: "chosen", target: state.target };
    }
    return null;
  }

  /** Anything malformed parses to null — a corrupted record is never a lock. */
  function parseTarget(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.status === "locked") {
      const target = sanitizeTarget(raw.target);
      if (!target) return null;
      return {
        status: "locked",
        target,
        sourceId:
          typeof raw.sourceId === "string" && raw.sourceId ? raw.sourceId : null,
        sessionId:
          typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null,
        expectedRevision:
          Number.isInteger(raw.expectedRevision) && raw.expectedRevision >= 0
            ? raw.expectedRevision
            : 0,
      };
    }
    if (raw.status === "chosen") {
      const target = sanitizeTarget(raw.target);
      if (!target) return null;
      return { status: "chosen", target };
    }
    return null;
  }

  // ============================================================
  // SAME-TAB SOURCE-SWITCH DETECTION (P11, issue #60 — decision 4 收尾侧)
  // ============================================================

  /**
   * Did this tab move to a DIFFERENT video/episode — decision 4's final
   * finish trigger ("原标签页换视频或分集时收尾")? The comparison runs on
   * the platform identity (platform, video id, episode, scope), NOT the raw
   * URL: bilibili and youtube rewrite their URLs in place during ordinary
   * playback (?t= seek replaceState), and only a different identity is a
   * different Source (glossary: a separately playable part is its own
   * Source with its own playback position). A URL without a confirmable
   * identity (a station home page, a xiaoe container page, garbage) can
   * never CONFIRM a switch, so the answer stays false — those transitions
   * end through the other triggers (manual end, capture stream death, tab
   * close) instead of a possibly-wrong auto-finish.
   *
   * @param {unknown} previousUrl - the URL the Session started from
   * @param {unknown} nextUrl - the URL the tab reports now
   * @param {(url: unknown) => {platformId: string, platformVideoId: string, episodeId: string|null, platformScopeId: string|null}|null} [extractIdentity]
   *   injected identity extractor (the worker passes
   *   contracts/platform-video-id.js's extractVideoIdentity)
   * @returns {boolean}
   */
  function didLearningSourceSwitch(previousUrl, nextUrl, extractIdentity) {
    const extract = typeof extractIdentity === "function" ? extractIdentity : () => null;
    let previous = null;
    let next = null;
    try {
      previous = extract(previousUrl);
      next = extract(nextUrl);
    } catch (_error) {
      return false;
    }
    if (!previous || !next) return false;
    return (
      previous.platformId !== next.platformId ||
      previous.platformVideoId !== next.platformVideoId ||
      String(previous.episodeId ?? "") !== String(next.episodeId ?? "") ||
      String(previous.platformScopeId ?? "") !== String(next.platformScopeId ?? "")
    );
  }

  // ============================================================
  // PROGRESS WRITE CLIENT (contract §3.5, decision D4)
  // ============================================================

  /** The §3.5 endpoint path for one source. */
  function progressPath(sourceId) {
    return `/v1/sources/${encodeURIComponent(String(sourceId))}/progress`;
  }

  // Base-URL joining rides the shared api-client module (one rule for every
  // contract module); the §3.5 path shaping stays here.
  const apiClient =
    typeof YTD_API_CLIENT !== "undefined"
      ? YTD_API_CLIENT
      : require("./api-client.js");

  function buildProgressApiUrl(apiBaseUrl, sourceId) {
    return apiClient.buildApiUrl(apiBaseUrl, progressPath(sourceId));
  }

  /**
   * §3.5 request body: integer positionMs (a slightly negative media-position
   * glitch clamps to 0) and a well-formed expectedRevision — a negative
   * revision means corruption, and the write is refused instead of guessed.
   */
  function buildProgressRequest(positionMs, expectedRevision) {
    const position = Number(positionMs);
    const revision = Number(expectedRevision);
    if (!Number.isFinite(position) || !Number.isFinite(revision) || revision < 0) {
      return null;
    }
    return {
      positionMs: Math.max(0, Math.round(position)),
      expectedRevision: Math.round(revision),
    };
  }

  /**
   * §3.5 response → verdict. Verdicts drive the write loop: "ok" adopts the
   * revision, "conflict" carries the server's `current` (D4), "unauthorized"
   * and "notFound" stop the writer, anything else is a transient deferral.
   */
  function parseProgressResponse({ status, data } = {}) {
    if (status >= 200 && status < 300) {
      const positionMs =
        data && Number.isInteger(data.positionMs) && data.positionMs >= 0
          ? data.positionMs
          : null;
      const revision =
        data && Number.isInteger(data.revision) && data.revision >= 0
          ? data.revision
          : null;
      if (positionMs !== null && revision !== null) {
        return { kind: "ok", positionMs, revision };
      }
      return { kind: "transient" };
    }
    if (status === 409) {
      const current =
        data && typeof data.current === "object" && data.current ? data.current : null;
      return {
        kind: "conflict",
        currentRevision:
          current && Number.isInteger(current.revision) && current.revision >= 0
            ? current.revision
            : null,
        currentPositionMs:
          current && Number.isInteger(current.positionMs) && current.positionMs >= 0
            ? current.positionMs
            : null,
      };
    }
    if (status === 401) return { kind: "unauthorized" };
    if (status === 404) return { kind: "notFound" };
    return { kind: "transient" };
  }

  /**
   * The per-Session progress writer. One in-flight PUT at a time; every
   * write carries the newest pending position. Timers and the clock are
   * injected so Node tests drive the schedule deterministically.
   *
   * @param {object} options
   * @param {(url: string, init?: object) => Promise<Response>} options.fetchImpl
   * @param {string} options.apiBaseUrl configured Learning Digest API origin
   * @param {string} options.token the linked credential's Bearer token
   * @param {string} options.sourceId the resolved Source to write to
   * @param {number} [options.expectedRevision] the resolve's progress revision (0 = no progress yet)
   * @param {number} [options.throttleMs] coalescing window between writes
   * @param {number[]} [options.networkRetryDelaysMs] backoff waits inside one write cycle
   * @param {number} [options.maxConflictRetries] 409 retries per write cycle
   * @param {() => number} [options.dateNow]
   * @param {Function} [options.setTimeoutImpl]
   * @param {Function} [options.clearTimeoutImpl]
   * @param {() => void} [options.onUnauthorized] 401 hook (the wiring ends the Session and re-gates the panel)
   * @returns {{reportPosition: Function, flush: Function, stop: Function, snapshot: Function}}
   */
  function createProgressWriter({
    fetchImpl,
    apiBaseUrl,
    token,
    sourceId,
    expectedRevision = 0,
    throttleMs = DEFAULT_THROTTLE_MS,
    networkRetryDelaysMs = DEFAULT_NETWORK_RETRY_DELAYS_MS,
    maxConflictRetries = DEFAULT_MAX_CONFLICT_RETRIES,
    dateNow = () => Date.now(),
    setTimeoutImpl = (fn, delay) => setTimeout(fn, delay),
    clearTimeoutImpl = (id) => clearTimeout(id),
    onUnauthorized = () => {},
  } = {}) {
    const url = buildProgressApiUrl(apiBaseUrl, sourceId);
    let revision =
      Number.isInteger(expectedRevision) && expectedRevision >= 0
        ? expectedRevision
        : 0;
    let pendingPositionMs = null;
    let lastReportedMs = null;
    let lastWriteStartAt = null;
    let stopped = url === null;
    let timerId = null;
    let queuedCycles = 0;

    // Every write cycle serializes through one chain: cycles never overlap,
    // and flush() awaits the tail, which also awaits any cycle already
    // queued (the key-event/flush path settles deterministically).
    let chain = Promise.resolve();

    // A non-positive delay (test configurations) needs no timer at all —
    // one yielded turn keeps the retry loop honest without scheduling.
    const sleep = (ms) =>
      ms > 0
        ? new Promise((resolve) => {
            setTimeoutImpl(resolve, ms);
          })
        : Promise.resolve();

    function cancelTimer() {
      if (timerId !== null) {
        clearTimeoutImpl(timerId);
        timerId = null;
      }
    }

    function scheduleCycle(delayMs) {
      cancelTimer();
      timerId = setTimeoutImpl(() => {
        timerId = null;
        enqueue(false);
      }, Math.max(0, delayMs));
    }

    function enqueue(forced) {
      queuedCycles += 1;
      const run = () =>
        runCycle(forced)
          .catch(() => {})
          .finally(() => {
            queuedCycles -= 1;
          });
      const result = chain.then(run, run);
      chain = result.then(() => {}, () => {});
      return result;
    }

    async function attempt(position) {
      const body = buildProgressRequest(position, revision);
      if (!body || !url) return { status: 0, data: null, malformed: true };
      const response = await fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      let data = null;
      try {
        data = await response.json();
      } catch (_error) {
        data = null;
      }
      return { status: response.status, data, malformed: false };
    }

    async function runCycle(forced) {
      if (stopped) return;
      const now = dateNow();
      if (!forced && lastWriteStartAt !== null && now - lastWriteStartAt < throttleMs) {
        scheduleCycle(throttleMs - (now - lastWriteStartAt));
        return;
      }
      lastWriteStartAt = now;
      let conflicts = 0;
      let networkRetries = 0;
      let done = false;
      while (!stopped && !done) {
        const position = pendingPositionMs;
        if (position === null || position === undefined) break;
        let outcome;
        try {
          outcome = await attempt(position);
        } catch (_error) {
          outcome = { status: 0, data: null, network: true };
        }
        if (stopped) return;
        const parsed = outcome.network ? { kind: "transient" } : parseProgressResponse(outcome);
        if (parsed.kind === "ok") {
          revision = parsed.revision;
          // Only clear the pending slot when no newer position arrived
          // while this write was in flight.
          if (pendingPositionMs === position) pendingPositionMs = null;
          lastReportedMs = position;
          done = true;
          break;
        }
        if (parsed.kind === "unauthorized") {
          stopInternal();
          try {
            onUnauthorized();
          } catch (_error) {
            // The hook must never break the write loop.
          }
          return;
        }
        if (parsed.kind === "notFound") {
          stopInternal();
          return;
        }
        if (parsed.kind === "conflict") {
          // D4: adopt the server's current revision and retry the LATEST
          // local position (re-read at the loop top), so a coalesced newer
          // position rides the same retry.
          if (parsed.currentRevision !== null) revision = parsed.currentRevision;
          conflicts += 1;
          if (conflicts > maxConflictRetries) break;
          continue;
        }
        // Transient (network error, 5xx, malformed body): bounded backoff.
        // A throttle-bypassing cycle never sleeps — its caller observes the
        // latency — so it defers to the throttle schedule immediately.
        if (forced || networkRetries >= networkRetryDelaysMs.length) break;
        await sleep(networkRetryDelaysMs[networkRetries]);
        networkRetries += 1;
      }
      // Whatever the exit, a still-pending position gets another chance
      // after the throttle window. The latest position is never lost.
      if (!stopped && pendingPositionMs !== null && queuedCycles <= 1) {
        scheduleCycle(throttleMs);
      }
    }

    function stopInternal() {
      stopped = true;
      cancelTimer();
    }

    return {
      /**
       * Records the last actually-played position (ms). Key events — the
       * first position after start and a backward drag (回拖) — write
       * immediately; other positions coalesce on the throttle schedule.
       */
      reportPosition(positionMs) {
        if (stopped) return;
        const position = Number(positionMs);
        if (!Number.isFinite(position) || position < 0) return;
        pendingPositionMs = Math.round(position);
        const immediate =
          lastReportedMs === null ||
          (lastReportedMs !== null && pendingPositionMs < lastReportedMs);
        if (immediate) {
          cancelTimer();
          enqueue(true);
        } else if (timerId === null && queuedCycles === 0) {
          scheduleCycle(throttleMs);
        }
      },

      /**
       * Key event (P11, decision 4 of #49): the player PAUSED. The exact
       * paused position is recorded and written immediately — the learner
       * may close the laptop next, so the pause position cannot wait for
       * the throttle — while the writer (and the Session behind it) stays
       * live: resuming playback keeps reporting into the same Session.
       */
      reportPause(positionMs) {
        if (stopped) return;
        const position = Number(positionMs);
        if (!Number.isFinite(position) || position < 0) return;
        pendingPositionMs = Math.round(position);
        cancelTimer();
        enqueue(true);
      },

      /**
       * Forces a write of the pending position now (end of Session, media
       * end). Resolves once the forced cycle settles; a stopped writer or
       * an empty pending slot resolves without touching the API.
       */
      flush() {
        if (stopped) return Promise.resolve();
        cancelTimer();
        return enqueue(true);
      },

      /** No writes after stop (auth loss, end of Session teardown). */
      stop() {
        stopInternal();
      },

      /** Test/debug view of the writer's public state. */
      snapshot() {
        return {
          sourceId,
          expectedRevision: revision,
          pendingPositionMs,
          lastReportedMs,
          stopped,
        };
      },
    };
  }

  return {
    DEFAULT_THROTTLE_MS,
    DEFAULT_NETWORK_RETRY_DELAYS_MS,
    DEFAULT_MAX_CONFLICT_RETRIES,
    isListableUrl,
    buildCourseTabList,
    createTargetState,
    chooseTarget,
    lockTarget,
    endTarget,
    isLocked,
    targetInfo,
    serializeTarget,
    parseTarget,
    didLearningSourceSwitch,
    progressPath,
    buildProgressApiUrl,
    buildProgressRequest,
    parseProgressResponse,
    createProgressWriter,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_LEARNING_START;
}
