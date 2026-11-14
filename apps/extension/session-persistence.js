/**
 * Session persistence: the thin browser layer in front of the pure Session
 * pipeline state machine (session-pipeline.js).
 *
 * Session state is JSON-plain, so persisting it incrementally is just
 * writing the latest state to chrome.storage.local under a per-session key
 * after every applied event. Closing the tab or side panel mid-lesson then
 * loses nothing: on reopen, loadSessionSnapshot + resumeFromSnapshot returns
 * the Session to exactly where it was, with finished Segments marked done
 * and never re-transcribed.
 *
 * The storage object is injected (chrome.storage.local in the extension, an
 * in-memory fake in Node tests), which keeps this module free of direct
 * browser dependencies while staying a deliberately thin wrapper.
 */
var YTD_SESSION_PERSISTENCE = (() => {
  const KEY_PREFIX = "ytd_session_";

  /**
   * The chrome.storage.local key holding one Session's snapshot.
   *
   * @param {string} sessionId
   * @returns {string}
   */
  function sessionStorageKey(sessionId) {
    return `${KEY_PREFIX}${sessionId}`;
  }

  /**
   * Persists the current Session state. Call after every applied event so
   * an interruption at any point loses at most the in-flight Segment.
   *
   * @param {{get: Function, set: Function}} storage - chrome.storage.local shaped
   * @param {object} state - Session state from session-pipeline.js
   */
  async function saveSessionSnapshot(storage, state) {
    if (!state || typeof state.sessionId !== "string" || !state.sessionId) {
      throw new Error("Session state with a sessionId is required");
    }
    await storage.set({ [sessionStorageKey(state.sessionId)]: state });
  }

  /**
   * Loads a persisted Session snapshot, or null when none exists.
   *
   * @param {{get: Function}} storage - chrome.storage.local shaped
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async function loadSessionSnapshot(storage, sessionId) {
    const result = await storage.get(sessionStorageKey(sessionId));
    return result?.[sessionStorageKey(sessionId)] ?? null;
  }

  /**
   * Removes a persisted Session snapshot (e.g. after a Session Digest has
   * been delivered and the verbatim Transcript exported).
   *
   * @param {{remove: Function}} storage - chrome.storage.local shaped
   * @param {string} sessionId
   */
  async function deleteSessionSnapshot(storage, sessionId) {
    await storage.remove(sessionStorageKey(sessionId));
  }

  return {
    sessionStorageKey,
    saveSessionSnapshot,
    loadSessionSnapshot,
    deleteSessionSnapshot,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SESSION_PERSISTENCE;
}
