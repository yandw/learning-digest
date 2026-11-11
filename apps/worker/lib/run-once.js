/**
 * One worker cycle (ticket 2.3; contract-r2 §3.7, decision D13/D14):
 * claim one task -> transcribe through the Speech Provider seam -> submit
 * the result -> summary. Concurrency is 1 (serial); a cycle claims one
 * task and drains it before the next claim, so a single worker never
 * holds two segments in memory.
 *
 * Division of labor on timestamps: the provider returns segment-relative
 * milliseconds; runOnce folds them onto the source timeline by adding the
 * task's segment start (contract-r2 §1: everything the API stores is on
 * the source video timeline). Silence (records: []) is still done.
 *
 * Error split: a provider failure is TASK-level and becomes a
 * transcription_failed result write-back (the contract's only round-2
 * task error code, message carrying the provider detail for triage). A
 * claim/submit failure is CYCLE-level and propagates to the loop, which
 * logs and backs off — retrying is the next poll.
 */

/**
 * @param {object} deps
 * @param {object} deps.client API client with claim()/submitResult()
 * @param {object} deps.provider Speech Provider with transcribe()
 * @returns {Promise<{claimed: number, done: number, failed: number}>}
 */
async function runOnce({ client, provider }) {
  const { tasks } = await client.claim({ limit: 1 });

  let done = 0;
  let failed = 0;
  for (const task of tasks) {
    try {
      const relative = await provider.transcribe({
        audioBase64: task.audioBase64,
        audioMimeType: task.audioMimeType,
        segment: {
          segmentIndex: task.segmentIndex,
          startMs: task.startMs,
          endMs: task.endMs,
        },
      });
      const records = (relative || []).map((record) => ({
        startMs: task.startMs + record.startMs,
        endMs: task.startMs + record.endMs,
        text: record.text,
      }));
      await client.submitResult(task.taskId, { status: "done", records });
      done += 1;
    } catch (error) {
      await client.submitResult(task.taskId, {
        status: "failed",
        error: {
          code: "transcription_failed",
          message: error && error.message ? error.message : String(error),
        },
      });
      failed += 1;
    }
  }

  return { claimed: tasks.length, done, failed };
}

module.exports = { runOnce };
