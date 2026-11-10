/**
 * Web credential persistence. Bearer credentials (contract §1: the one
 * auth mechanism) live in localStorage under a single stable key; every
 * API request presents them as `Authorization: Bearer <token>`. The
 * storage seam is injectable so tests use a Map-backed fake instead of
 * window.localStorage.
 */

export const CREDENTIALS_KEY = "learning-digest.web.credentials";

/**
 * @param {object} options
 * @param {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void,
 *           removeItem: (key: string) => void }} options.storage
 *   localStorage-like seam
 * @returns {{ get: () => object | null, set: (credential: object) => void, clear: () => void }}
 */
export function createCredentialStore({ storage }) {
  function get() {
    let parsed;
    try {
      const raw = storage.getItem(CREDENTIALS_KEY);
      if (raw === null) {
        return null;
      }
      parsed = JSON.parse(raw);
    } catch (_error) {
      return null; // corrupted contents behave like "not logged in"
    }
    if (parsed === null || typeof parsed !== "object" || !parsed.token) {
      return null;
    }
    return parsed;
  }

  function set(credential) {
    storage.setItem(CREDENTIALS_KEY, JSON.stringify(credential));
  }

  function clear() {
    storage.removeItem(CREDENTIALS_KEY);
  }

  return { get, set, clear };
}
