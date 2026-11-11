/**
 * The contract's two-generation story (contract-r3.md §1 幂等例外, §3.1;
 * fixtures/summary-examples.json, ticket 3.2, issue #74). Seam under test:
 * the same POST /v1/resources/{id}/summaries endpoint across a catch-up —
 * generate while the third session is still active (未学完可生成), archive
 * the catch-up session, generate again: a NEW record whose citations
 * include the new session's record.
 *
 * The material is the fixtures' verbatim story (session-examples.json +
 * summary-examples.json): the B 站 P2 注意力机制详解 resource with a
 * captions session, two ASR sessions, the skipped gaps, the timestamped
 * note, and the catch-up record. Server-generated ids differ from the
 * fixture ids (they are opaque, contract §1) — the fixture's session
 * ids appear here only as the story's roles (ses_31 captions / ses_32
 * ASR finished / ses_33 ASR active / ses_34 catch-up).
 *
 * The usage numbers follow D18 and reproduce the fixture story's totals:
 * 4 done audio segments x 30s = audioSeconds 120 (transcribing, failed
 * and captions material never count), 2 generations.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers/harness");
const { seedFileWith } = require("./helpers/accounts");
const { makeAudioDir, authHeader, openAccountWithId } = require("./helpers/sessions");
const { createWorkerClient } = require("../../worker/lib/client");
const { runOnce } = require("../../worker/lib/run-once");

const EMAIL = "story@example.com";
const WORKER_TOKEN = "story-worker-token";

// fixtures/summary-examples.json + session-examples.json, verbatim.
const TITLE = "注意力机制详解 P2：自注意力";
const CAPTION_RECORDS = [
  { startMs: 138000, endMs: 159000, text: "这一节我们把注意力分数放到矩阵上看" },
  { startMs: 159000, endMs: 181000, text: "Q K V 三个矩阵各司其职" },
];
const CAPTION_GAP = { startMs: 300000, endMs: 360000 };
const ASR_TEXT_BY_START = {
  60000: "上一节我们留了一个问题：为什么要缩放点积",
  0: "欢迎来到这一节，我们先回顾上一课留下的三个问题",
  30000: "注意力分数的计算，就是把查询向量和键向量做点积",
  120000: "最后我们补一段：注意力机制在长序列下的处理思路",
};
const FIXTURE_QUOTE_1 = "注意力分数的计算，就是把查询向量和键向量做点积";
const FIXTURE_QUOTE_CATCH_UP = "最后我们补一段：注意力机制在长序列下的处理思路";
const FIXTURE_QUOTE_SCALED = "为什么要缩放点积";
const NOTE_TEXT = "3:20 起的例子值得回看";

const SEGMENT = {
  durationMs: 30000,
  audioMimeType: "audio/webm;codecs=opus",
  audioBase64: "U3Rvcnktc2VnbWVudC1hdWRpbw==",
};

/** ASR provider keyed by the segment's source-timeline start; 210000 fails. */
function storyAsrProvider() {
  return {
    id: "story-asr",
    transcribe: async ({ segment }) => {
      if (segment.startMs === 210000) {
        throw new Error("Speech Provider 返回 429，重试后仍失败");
      }
      const text = ASR_TEXT_BY_START[segment.startMs];
      assert.ok(text, `unexpected segment start ${segment.startMs}`);
      return [{ startMs: 0, endMs: segment.endMs - segment.startMs, text }];
    },
  };
}

async function upload(harness, token, sessionId, segmentIndex, startMs) {
  const response = await harness.request(
    "POST",
    `/v1/sessions/${sessionId}/audio-segments`,
    {
      headers: authHeader(token),
      body: { ...SEGMENT, segmentIndex, startMs },
    },
  );
  assert.equal(response.status, 201, JSON.stringify(response.json));
}

async function finishWithGaps(harness, token, sessionId, gaps) {
  const response = await harness.request("POST", `/v1/sessions/${sessionId}/finish`, {
    headers: authHeader(token),
    body: gaps.length > 0 ? { gaps } : {},
  });
  assert.equal(response.status, 200);
}

async function generate(harness, token, resourceId) {
  return harness.request("POST", `/v1/resources/${resourceId}/summaries`, {
    headers: authHeader(token),
    body: {},
  });
}

test("story: generate while learning is unfinished -> catch-up session -> regenerate cites the new material (fixtures verbatim)", async () => {
  const harness = await startApp({
    seedFile: seedFileWith([EMAIL]),
    config: { audioDir: makeAudioDir(), workerToken: WORKER_TOKEN },
  });
  try {
    const { token } = await openAccountWithId(harness, EMAIL);
    const workerClient = createWorkerClient({
      apiBase: `http://127.0.0.1:${harness.port}`,
      token: WORKER_TOKEN,
    });

    // The resource: the fixture's bilibili P2 lesson.
    const created = await harness.request("POST", "/v1/resources", {
      headers: authHeader(token),
      body: { url: "https://www.bilibili.com/video/BV1ab411L78c?p=2", title: TITLE },
    });
    assert.equal(created.status, 201);
    const { resource, source } = created.json;

    async function newSession() {
      const response = await harness.request("POST", `/v1/sources/${source.id}/sessions`, {
        headers: authHeader(token),
        body: {},
      });
      assert.equal(response.status, 201);
      return response.json.session;
    }

    // ses_31-equivalent: captions path, finished, one skipped range.
    const captionsSession = await newSession();
    const archived = await harness.request("POST", `/v1/sessions/${captionsSession.id}/captions`, {
      headers: authHeader(token),
      body: { segments: CAPTION_RECORDS },
    });
    assert.equal(archived.status, 201);
    await finishWithGaps(harness, token, captionsSession.id, [CAPTION_GAP]);

    // ses_32-equivalent: ASR, finished, one done segment + one skipped range.
    const asrFinishedSession = await newSession();
    await upload(harness, token, asrFinishedSession.id, 0, 60000);
    await finishWithGaps(harness, token, asrFinishedSession.id, [{ startMs: 150000, endMs: 210000 }]);

    // ses_33-equivalent: ASR, left ACTIVE (未学完) — two done segments,
    // one failed segment (transcription_failed), one still pending.
    const asrActiveSession = await newSession();
    await upload(harness, token, asrActiveSession.id, 0, 0);
    await upload(harness, token, asrActiveSession.id, 1, 30000);
    await upload(harness, token, asrActiveSession.id, 2, 210000);
    await upload(harness, token, asrActiveSession.id, 3, 300000); // stays pending

    // Drain exactly the four queued tasks: 3 done + 1 failed.
    let done = 0;
    let failed = 0;
    for (let i = 0; i < 4; i += 1) {
      const summary = await runOnce({ client: workerClient, provider: storyAsrProvider() });
      done += summary.done;
      failed += summary.failed;
    }
    assert.equal(done, 3);
    assert.equal(failed, 1);

    // The timestamped note (fixtures verbatim).
    const note = await harness.request("POST", `/v1/resources/${resource.id}/notes`, {
      headers: authHeader(token),
      body: { clientRequestId: "story-note-1", text: NOTE_TEXT, sourceId: source.id, positionMs: 200000 },
    });
    assert.equal(note.status, 201);

    // --- Generation 1: while the third session is still active. ---
    const first = await generate(harness, token, resource.id);
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const firstSummary = first.json.summary;
    assert.equal(firstSummary.resourceId, resource.id);

    // One citation per archived session, timeline-sorted; the fixture's
    // first quote is reproduced verbatim against the active session.
    assert.equal(firstSummary.citations.length, 3);
    assert.deepEqual(firstSummary.citations[0], {
      quote: FIXTURE_QUOTE_1,
      segmentRef: { sessionId: asrActiveSession.id, startMs: 30000, endMs: 60000 },
    });
    // The fixture's second citation is a verbatim excerpt of the ses_32 record.
    assert.equal(firstSummary.citations[1].segmentRef.sessionId, asrFinishedSession.id);
    assert.equal(firstSummary.citations[1].segmentRef.startMs, 60000);
    assert.ok(firstSummary.citations[1].quote.includes(FIXTURE_QUOTE_SCALED));

    // Content: the stub merges the note and names the uncovered ranges.
    assert.ok(firstSummary.content.includes(NOTE_TEXT));
    assert.ok(firstSummary.content.includes("## 尚未覆盖"));
    assert.ok(firstSummary.content.includes(CAPTION_GAP.startMs.toString()));

    const usageAfterFirst = await harness.request("GET", "/v1/usage", { headers: authHeader(token) });
    assert.equal(usageAfterFirst.json.audioSeconds, 90); // 3 done segments x 30s
    assert.equal(usageAfterFirst.json.summaryCount, 1);
    assert.equal(usageAfterFirst.json.summaryInputChars, firstSummary.generation.inputChars);

    // --- The catch-up (用户故事 29): ses_34-equivalent archives one more
    // record on the same source, finished. ---
    const catchUpSession = await newSession();
    await upload(harness, token, catchUpSession.id, 0, 120000);
    const drained = await runOnce({ client: workerClient, provider: storyAsrProvider() });
    assert.deepEqual(drained, { claimed: 1, done: 1, failed: 0 });
    await finishWithGaps(harness, token, catchUpSession.id, []);

    // The catch-up transcript view carries the fixture record verbatim.
    const catchUpView = await harness.request(
      "GET",
      `/v1/sessions/${catchUpSession.id}/transcript`,
      { headers: authHeader(token) },
    );
    assert.deepEqual(
      catchUpView.json.records.map((r) => ({ startMs: r.startMs, endMs: r.endMs, text: r.text })),
      [{ startMs: 120000, endMs: 150000, text: FIXTURE_QUOTE_CATCH_UP }],
    );

    // --- Generation 2: the aggregation scope grew on its own (D17). ---
    const second = await generate(harness, token, resource.id);
    assert.equal(second.status, 201, JSON.stringify(second.json));
    const secondSummary = second.json.summary;
    assert.notEqual(secondSummary.id, firstSummary.id);

    // Four citations now — the catch-up session's fixture quote is in.
    assert.equal(secondSummary.citations.length, 4);
    assert.deepEqual(secondSummary.citations[2], {
      quote: FIXTURE_QUOTE_CATCH_UP,
      segmentRef: { sessionId: catchUpSession.id, startMs: 120000, endMs: 150000 },
    });
    // Still sorted by startMs across sessions.
    const starts = secondSummary.citations.map((c) => c.segmentRef.startMs);
    assert.deepEqual(starts, [...starts].sort((x, y) => x - y));

    // The content grew with the material; the input grew with it too (D17).
    assert.notEqual(secondSummary.content, firstSummary.content);
    assert.ok(secondSummary.content.includes(FIXTURE_QUOTE_CATCH_UP));
    assert.ok(secondSummary.generation.inputChars > firstSummary.generation.inputChars);

    // History kept: the list is newest-first with the fixture's counts.
    const list = await harness.request("GET", `/v1/resources/${resource.id}/summaries`, {
      headers: authHeader(token),
    });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.json.summaries.map((s) => [s.id, s.citationCount]),
      [[secondSummary.id, 4], [firstSummary.id, 3]],
    );
    const detail = await harness.request("GET", `/v1/summaries/${firstSummary.id}`, {
      headers: authHeader(token),
    });
    assert.deepEqual(detail.json.summary, firstSummary);

    // --- Usage (D18, fixture totals): 4 done ASR segments = 120s; the
    // captions session, the failed segment and the pending one never count. ---
    const usage = await harness.request("GET", "/v1/usage", { headers: authHeader(token) });
    assert.equal(usage.json.audioSeconds, 120);
    assert.equal(usage.json.summaryCount, 2);
    assert.equal(
      usage.json.summaryInputChars,
      firstSummary.generation.inputChars + secondSummary.generation.inputChars,
    );
    assert.ok(usage.json.updatedAt);
  } finally {
    await harness.close();
  }
});

// The summary generation itself runs through the same deterministic stub
// provider as the rest of the suite (config/env default; real AI calls
// stay out of tests, D16). Only the Worker's ASR provider is scripted
// above, so the archived records carry the fixture texts verbatim.
