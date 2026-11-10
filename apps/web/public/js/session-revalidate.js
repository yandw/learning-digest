/**
 * Session revalidation (P7 linked logout, pull side): there is no push
 * channel to an already-open page, so an extension-side logout (or any
 * linked logout from another surface) surfaces here — when the page
 * becomes visible or focused again while logged in, a silent GET /v1/me
 * re-checks the stored credential. A 401 routes through the api client's
 * shared interceptor (clears the credential, fires onUnauthorized), and
 * the page returns to the login view; the revalidator only reports what
 * happened.
 *
 * Pure logic, no DOM: the page binds visibilitychange/focus to
 * onPageVisible() and re-renders from its own onUnauthorized wiring. A
 * cooldown keeps tab-switching from turning into a probe storm; the clock
 * is injectable for tests.
 */

/**
 * @param {object} options
 * @param {{ me: () => Promise<{ ok: boolean, status: number, data: object }> }} options.api
 *   createApiClient-shaped seam (the me() wrapper is enough)
 * @param {() => boolean} options.isAuthenticated true only while the login
 *   flow is in the authenticated state
 * @param {() => void} [options.onInvalidated] called when a probe came back
 *   401 (the interceptor already cleared the credential and ran its own
 *   onUnauthorized)
 * @param {number} [options.minIntervalMs] minimum spacing between probes
 * @param {() => number} [options.now] injectable clock
 * @returns {{ onPageVisible: (visible?: boolean) => Promise<{ probed: boolean, invalidated?: boolean }> }}
 */
export function createSessionRevalidator({
  api,
  isAuthenticated,
  onInvalidated,
  minIntervalMs = 30_000,
  now = () => Date.now(),
} = {}) {
  let lastProbeEndedAt = -Infinity;
  let inFlight = null;

  function shouldProbe() {
    if (!isAuthenticated()) return false;
    if (now() - lastProbeEndedAt < minIntervalMs) return false;
    return inFlight === null;
  }

  /**
   * The visibility/focus entry. `visible` mirrors
   * `document.visibilityState === "visible"` from the visibilitychange
   * handler; the focus handler passes true. A hidden page is never probed.
   */
  async function onPageVisible(visible = true) {
    if (!visible || !shouldProbe()) {
      return { probed: false };
    }
    inFlight = (async () => {
      try {
        const result = await api.me();
        lastProbeEndedAt = now();
        const invalidated = result.status === 401;
        if (invalidated && onInvalidated) {
          onInvalidated();
        }
        return { probed: true, invalidated };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { onPageVisible };
}
