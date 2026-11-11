/**
 * Account usage accounting (contract-r3.md §2.4/§3.4; decision D18,
 * ticket 3.2). One "usage" row per account, keyed by accountId:
 *
 *   { accountId, audioMs, summaryCount, summaryInputChars, updatedAt, updatedAtMs }
 *
 * D18 口径 (record-only, no billing): the two recording timepoints are both
 * "the moment a product lands" —
 * - audioMs accrues when an audio segment task FIRST reaches done (the
 *   write-back's 首存为准 replay path never re-records; callers in
 *   lib/audio-jobs.js sit behind that gate). Read as
 *   audioSeconds = floor(audioMs / 1000), so fractional seconds only round
 *   once at the account level. Transcribing and failed segments never
 *   reach this module; a silent segment (done with records: []) does.
 * - summaryCount/summaryInputChars accrue when a summary generation lands
 *   (201, lib/summaries.js); a failed generation records nothing.
 *
 * Monotonic by contract (no delete endpoints); updatedAt advances only on
 * a recording write — before the first write the projection reports
 * updatedAt: null ("nothing counted yet").
 */
const { isoSeconds } = require("./notes");

function emptyUsage(accountId) {
  return {
    accountId,
    audioMs: 0,
    summaryCount: 0,
    summaryInputChars: 0,
    updatedAt: null,
    updatedAtMs: null,
  };
}

/** Load one account's usage row, or null when nothing was ever recorded. */
function loadUsage(store, accountId) {
  return store.get("usage", accountId);
}

/** Record audio duration (ms) against the account (D18: first-done gate lives with the caller). */
function recordAudioSeconds({ store, accountId, durationMs, now }) {
  const row = loadUsage(store, accountId) || emptyUsage(accountId);
  row.audioMs += durationMs;
  const atMs = now();
  row.updatedAt = isoSeconds(atMs);
  row.updatedAtMs = atMs;
  store.set("usage", accountId, row);
  return row;
}

/** Record one successful summary generation (D18: count +1, inputChars summed). */
function recordSummaryGeneration({ store, accountId, inputChars, now }) {
  const row = loadUsage(store, accountId) || emptyUsage(accountId);
  row.summaryCount += 1;
  row.summaryInputChars += inputChars;
  const atMs = now();
  row.updatedAt = isoSeconds(atMs);
  row.updatedAtMs = atMs;
  store.set("usage", accountId, row);
  return row;
}

/** Contract §2.4 projection — the bare Usage body of GET /v1/usage. */
function usageView({ store, accountId }) {
  const row = loadUsage(store, accountId);
  return {
    audioSeconds: row ? Math.floor(row.audioMs / 1000) : 0,
    summaryCount: row ? row.summaryCount : 0,
    summaryInputChars: row ? row.summaryInputChars : 0,
    updatedAt: row ? row.updatedAt : null,
  };
}

module.exports = { recordAudioSeconds, recordSummaryGeneration, usageView };
