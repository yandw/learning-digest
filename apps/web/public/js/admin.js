/**
 * Admin site-capability flow (pure module — no DOM, no fetch). Round 4
 * (contract-r4 §3.2/§3.3, ticket 6.2 / issue #87): the administrator's
 * table of per-platform capture switches on top of the login shell.
 *
 * It owns the decisions:
 * - load reads GET /v1/admin/site-capabilities into one table view; a 404
 *   is the D2 non-admin answer and switches to the denied view with the
 *   envelope verbatim (「接口不存在或无权访问」 as the fallback wording);
 *   any other failure is a plain load error, also verbatim;
 * - every row keeps its SAVED baseline next to the edited values; toggles
 *   flip only the targeted row/field and the diff (changedKeys) drives
 *   both the row's save button and the PUT body — an unchanged row sends
 *   nothing, a partially changed row patches only what moved (the PUT is
 *   a boolean-subset patch per contract-r4 §3.3);
 * - a successful save adopts the read-back row as both display value and
 *   new baseline (改后 GET 回读一致), a failed one keeps the row dirty with
 *   the envelope verbatim — both rendered as the row-level save status;
 * - shouldShowAdminEntry is the nav decision: only account.isAdmin true
 *   shows the 站点管理 entry (legacy accounts predate the field and read
 *   as non-admin).
 *
 * The 401 path is deliberately NOT handled here: the api client's
 * interceptor clears the credential and calls back into the login flow,
 * which swaps the shell back to the login view.
 */

const CAPABILITY_FIELDS = ["captions", "asr", "enabled"];

// The D2 non-admin 404's fallback wording (the API sends the same message
// in its envelope; this covers an unusable body).
const DENIED_FALLBACK_MESSAGE = "接口不存在或无权访问";

/**
 * The nav decision: the 站点管理 entry exists iff the /v1/me account
 * carries isAdmin true. Junk input and legacy rows (no field) are
 * non-admins — fail closed.
 */
export function shouldShowAdminEntry(account) {
  return Boolean(account && account.isAdmin === true);
}

/**
 * The only-changed-keys computation: compare the edited booleans against
 * the row's saved baseline, in the contract's canonical field order. This
 * is exactly the PUT body — an unchanged row diffs to [] and sends nothing.
 */
export function changedCapabilityKeys(current, saved) {
  const keys = [];
  for (const field of CAPABILITY_FIELDS) {
    if (Boolean(current[field]) !== Boolean(saved[field])) {
      keys.push(field);
    }
  }
  return keys;
}

/**
 * Row-level save status text: the in-flight, success and failure lines.
 * The failure shows the contract envelope verbatim.
 */
export function presentRowStatus(row) {
  if (!row) {
    return "";
  }
  if (row.saveState === "saving") {
    return "保存中…";
  }
  if (row.saveState === "saved") {
    return "已保存";
  }
  if (row.saveState === "error") {
    return row.saveError || "保存失败，请稍后重试";
  }
  return "";
}

/**
 * @param {object} options
 * @param {object} options.api createApiClient-shaped seam:
 *   { getAdminSiteCapabilities, updateAdminSiteCapability }
 *   -> { ok, status, data }
 */
export function createAdminFlow({ api }) {
  // "idle" (never opened) -> "loading" -> "table" | "denied" | "error".
  let view = "idle";
  let rows = [];
  let error = null;
  let loading = false;

  function getState() {
    return { view, rows, error, loading };
  }

  function envelopeMessage(data, fallback) {
    return (data && data.error && data.error.message) || fallback;
  }

  function rowById(platformId) {
    return rows.find((row) => row.platformId === platformId) || null;
  }

  function refreshDiffs() {
    for (const row of rows) {
      row.changedKeys = changedCapabilityKeys(row, row.saved);
    }
  }

  /** Read the whole table (contract-r4 §3.2). */
  async function load() {
    if (loading) {
      return { ok: false };
    }
    loading = true;
    view = "loading";
    const result = await api.getAdminSiteCapabilities();
    loading = false;
    if (!result.ok) {
      if (result.status === 404) {
        // D2: a non-admin's 404 is indistinguishable from an unknown path.
        // The surface simply does not exist for them — the denied view.
        view = "denied";
        error = envelopeMessage(result.data, DENIED_FALLBACK_MESSAGE);
      } else {
        view = "error";
        error = envelopeMessage(result.data, "请求失败，请稍后重试");
      }
      rows = [];
      return { ok: false };
    }
    const capabilities = (result.data && result.data.capabilities) || [];
    rows = capabilities
      .filter((cap) => cap && typeof cap.platformId === "string")
      .map((cap) => {
        const values = {
          captions: cap.captions === true,
          asr: cap.asr === true,
          enabled: cap.enabled === true,
        };
        return {
          platformId: cap.platformId,
          ...values,
          saved: { ...values },
          changedKeys: [],
          saveState: "idle",
          saveError: null,
        };
      });
    view = "table";
    error = null;
    return { ok: true };
  }

  /**
   * Flip one row's one switch. The diff resets the row's stale save status
   * (a new edit after a failed save clears the old error line).
   */
  function setToggle(platformId, field, value) {
    const row = rowById(platformId);
    if (!row || !CAPABILITY_FIELDS.includes(field)) {
      return { ok: false };
    }
    row[field] = value === true;
    row.saveState = "idle";
    row.saveError = null;
    refreshDiffs();
    return { ok: true };
  }

  /** The PUT body: only the changed keys (contract-r4 §3.3 subset patch). */
  function patchFor(platformId) {
    const row = rowById(platformId);
    if (!row) {
      return {};
    }
    const patch = {};
    for (const key of changedCapabilityKeys(row, row.saved)) {
      patch[key] = row[key];
    }
    return patch;
  }

  /**
   * Save one row (contract-r4 §3.3): PUT only what changed. An unchanged
   * row sends nothing; re-entry while a save is in flight is ignored.
   * Success adopts the read-back row (the server's merged result) as both
   * display value and new baseline; failure keeps the row dirty with the
   * envelope verbatim.
   */
  async function saveRow(platformId) {
    const row = rowById(platformId);
    if (!row || row.saveState === "saving") {
      return { ok: false };
    }
    const patch = patchFor(platformId);
    if (Object.keys(patch).length === 0) {
      return { ok: true, skipped: true };
    }
    row.saveState = "saving";
    row.saveError = null;
    const result = await api.updateAdminSiteCapability(platformId, patch);
    if (!result.ok) {
      row.saveState = "error";
      row.saveError = envelopeMessage(result.data, "保存失败，请稍后重试");
      return { ok: false };
    }
    const capability = result.data && result.data.capability;
    if (capability && typeof capability.platformId === "string") {
      row.captions = capability.captions === true;
      row.asr = capability.asr === true;
      row.enabled = capability.enabled === true;
      row.saved = { captions: row.captions, asr: row.asr, enabled: row.enabled };
    }
    row.saveState = "saved";
    row.saveError = null;
    refreshDiffs();
    return { ok: true };
  }

  /** Full wipe for the next session (logout / login as another account). */
  function reset() {
    view = "idle";
    rows = [];
    error = null;
    loading = false;
  }

  return { getState, load, setToggle, patchFor, saveRow, reset };
}
