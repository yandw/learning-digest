/**
 * Worker main loop (ticket 2.3; decision D13: pull model, no push, no
 * heartbeat). Poll -> runOnce -> sleep while idle; cycle errors (API
 * unreachable, credential rejected) log and back off; task errors never
 * reach the loop (runOnce turns them into result write-backs).
 *
 * Poll interval and error backoff are deployment config, not contract
 * constants. maxCycles/sleepImpl are test seams — the production entry
 * runs unbounded with the real timer.
 */
const { runOnce } = require("./run-once");

/**
 * @param {object} deps
 * @param {object} deps.client API client (claim / submitResult)
 * @param {object} deps.provider Speech Provider
 * @param {number} [deps.pollIntervalMs] idle sleep between polls (default 5000)
 * @param {number} [deps.errorBackoffMs] sleep after a failed cycle (default pollIntervalMs)
 * @param {(line: string) => void} [deps.log] operator log sink
 * @param {number} [deps.maxCycles] test seam: stop after N cycles
 * @param {(ms: number) => Promise<void>} [deps.sleepImpl] test seam: instant sleep
 * @returns {Promise<{cycles: number, done: number, failed: number}>}
 */
async function runLoop({
  client,
  provider,
  pollIntervalMs = 5000,
  errorBackoffMs,
  log = () => {},
  maxCycles = Number.POSITIVE_INFINITY,
  sleepImpl,
}) {
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const backoff = errorBackoffMs || pollIntervalMs;

  let cycles = 0;
  let done = 0;
  let failed = 0;
  while (cycles < maxCycles) {
    cycles += 1;
    let summary;
    try {
      summary = await runOnce({ client, provider });
    } catch (error) {
      log(`[worker] cycle failed: ${error && error.message ? error.message : error}; retrying in ${backoff}ms`);
      if (cycles < maxCycles) {
        await sleep(backoff);
      }
      continue;
    }
    done += summary.done;
    failed += summary.failed;
    if (summary.claimed === 0 && cycles < maxCycles) {
      await sleep(pollIntervalMs);
    }
  }
  return { cycles, done, failed };
}

module.exports = { runLoop };
