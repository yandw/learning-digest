/**
 * Worker API client (ticket 2.3; contract-r2 §3.7): the two worker
 * endpoints with the service credential attached. Vanilla Node — global
 * fetch, zero dependencies. Non-2xx answers reject with status + error
 * code so the loop's log carries something triageable.
 */

/**
 * @param {object} deps
 * @param {string} deps.apiBase e.g. "http://127.0.0.1:8787" (no trailing slash)
 * @param {string} deps.token the worker service credential (Bearer)
 * @param {typeof fetch} [deps.fetchImpl] injectable for tests
 */
function createWorkerClient({ apiBase, token, fetchImpl } = {}) {
  const base = String(apiBase || "").replace(/\/+$/, "");
  const doFetch = fetchImpl || fetch;

  async function request(path, body) {
    const response = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_error) {
      parsed = null;
    }
    if (!response.ok) {
      const code = parsed && parsed.error ? parsed.error.code : "unknown";
      const message = parsed && parsed.error ? parsed.error.message : raw.slice(0, 200);
      throw new Error(`API ${path} failed with HTTP ${response.status} (${code}): ${message}`);
    }
    return parsed;
  }

  return {
    /** POST /v1/worker/tasks/claim -> { tasks: [Task] } */
    claim({ limit } = {}) {
      return request("/v1/worker/tasks/claim", { limit: limit || 1 });
    },
    /** POST /v1/worker/tasks/{id}/result -> { taskId, status } */
    submitResult(taskId, body) {
      return request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/result`, body);
    },
  };
}

module.exports = { createWorkerClient };
