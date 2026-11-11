/**
 * runLoop — the worker main loop (ticket 2.3, decision D13): poll claim,
 * drain what it gets, sleep when idle, back off on cycle errors. Poll
 * interval and backoff are configurable (deployment config, not contract).
 *
 * Seam: runLoop({ client, provider, sleepImpl, maxCycles }) — sleepImpl is
 * injected so tests are instant and deterministic; maxCycles bounds the
 * loop for tests (the production entry runs unbounded).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { runLoop } = require("../lib/loop");

/** Client that serves `pages` of claimed tasks, then stays empty. */
function scriptedClient(pages, onCycle) {
  let page = 0;
  return {
    async claim() {
      const tasks = page < pages.length ? pages[page] : [];
      page += 1;
      if (onCycle) onCycle(page);
      return { tasks };
    },
    async submitResult(taskId, body) {
      return { taskId, status: body.status };
    },
  };
}

const PROVIDER = { id: "stub", transcribe: async () => [{ startMs: 0, endMs: 1000, text: "t" }] };

function task(id) {
  return { taskId: id, sessionId: "s", sourceId: "r", segmentIndex: 0, startMs: 0, endMs: 30000, audioMimeType: "m", audioBase64: "YQ==" };
}

test("runLoop: drains tasks, then idles on the poll interval until the cycle budget ends", async () => {
  const sleeps = [];
  const sleepImpl = async (ms) => sleeps.push(ms);
  const client = scriptedClient([[task("tsk_a"), task("tsk_b")]]);

  const summary = await runLoop({
    client,
    provider: PROVIDER,
    pollIntervalMs: 5000,
    maxCycles: 4,
    sleepImpl,
  });

  assert.deepEqual(summary, { cycles: 4, done: 2, failed: 0 });
  // After the working cycle the loop polls again immediately; the idle
  // cycles sleep, but the final cycle exits without sleeping.
  assert.deepEqual(sleeps, [5000, 5000]);
});

test("runLoop: a cycle error logs and backs off, then keeps polling", async () => {
  const sleeps = [];
  const sleepImpl = async (ms) => sleeps.push(ms);
  const logs = [];
  let calls = 0;
  const client = {
    async claim() {
      calls += 1;
      if (calls === 1) {
        throw new Error("api unreachable");
      }
      return { tasks: [] };
    },
    async submitResult(taskId, body) {
      return { taskId, status: body.status };
    },
  };

  const summary = await runLoop({
    client,
    provider: PROVIDER,
    pollIntervalMs: 5000,
    errorBackoffMs: 15000,
    maxCycles: 3,
    sleepImpl,
    log: (line) => logs.push(line),
  });

  assert.deepEqual(summary, { cycles: 3, done: 0, failed: 0 });
  // The error cycle backs off with the (longer) error interval; the idle
  // cycle sleeps the poll interval.
  assert.deepEqual(sleeps, [15000, 5000]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /api unreachable/);
});

test("runLoop: provider-level failures still count as processed (task-level, not cycle-level)", async () => {
  const client = scriptedClient([[task("tsk_x")]]);
  const summary = await runLoop({
    client,
    provider: {
      id: "qwen",
      transcribe: async () => {
        throw new Error("HTTP 429");
      },
    },
    maxCycles: 2,
    sleepImpl: async () => {},
  });
  assert.deepEqual(summary, { cycles: 2, done: 0, failed: 1 });
});
