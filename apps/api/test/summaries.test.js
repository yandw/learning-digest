/**
 * Course summary generation endpoints (contract-r3.md §2.1–2.3, §3.1–3.3;
 * decisions D16/D17/D18; ticket 3.2, issue #74). Seams under test: the
 * three HTTP endpoints POST /v1/resources/{id}/summaries,
 * GET /v1/resources/{id}/summaries, GET /v1/summaries/{id} — plus the
 * AI Provider seam boundary (stub by default; failing/fault-injecting
 * providers for the failure paths; no external network).
 *
 * Pinned here: generation aggregates ALL archived material (records/gaps/
 * notes, D17), every POST creates a NEW record (contract-r3 §1 幂等例外),
 * the citation reconciliation drops anything that does not resolve to a
 * real archived record (§2.2), failures land nothing (D16 不落脏数据),
 * and usage accrues only on success (D18).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers/harness");
const { seedFileWith } = require("./helpers/accounts");
const { authHeader, openAccountWithId } = require("./helpers/sessions");
const { createStubProvider } = require("../lib/ai-providers");

const EMAIL_A = "summary-a@example.com";
const EMAIL_B = "summary-b@example.com";

const RECORDS = [
  { startMs: 30000, endMs: 60000, text: "注意力分数的计算，就是把查询向量和键向量做点积" },
  { startMs: 60000, endMs: 90000, text: "上一节我们留了一个问题：为什么要缩放点积" },
];

/**
 * Start an app with two accounts. The AI provider is injectable per test
 * (defaults to the real stub). Returns { harness, a, b } with each account
 * carrying { token, accountId }.
 */
async function startSummaryApp({ provider } = {}) {
  const harness = await startApp({
    seedFile: seedFileWith([EMAIL_A, EMAIL_B]),
    ...(provider ? { aiProvider: provider } : {}),
  });
  const a = await openAccountWithId(harness, EMAIL_A);
  const b = await openAccountWithId(harness, EMAIL_B);
  return { harness, a, b };
}

/**
 * Favorite a fixture source and archive captions + finish on a new
 * session (public flow only). With `records: []` the session stays
 * record-less (gaps-only when gaps are reported) — the 409 material.
 */
async function favoriteAndArchive(
  harness,
  token,
  { records, gaps = [], finish = true, label, url = "https://www.bilibili.com/video/BV1ab411L78c?p=2" },
) {
  const created = await harness.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: {
      url,
      title: `注意力机制详解 P2：自注意力（${label}）`,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const { resource, source } = created.json;
  const sessionResponse = await harness.request(
    "POST",
    `/v1/sources/${source.id}/sessions`,
    { headers: authHeader(token), body: {} },
  );
  assert.equal(sessionResponse.status, 201);
  const session = sessionResponse.json.session;

  if (records.length > 0) {
    const archived = await harness.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: { segments: records.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })) },
    });
    assert.equal(archived.status, 201, JSON.stringify(archived.json));
  }
  if (finish) {
    const finished = await harness.request("POST", `/v1/sessions/${session.id}/finish`, {
      headers: authHeader(token),
      body: gaps.length > 0 ? { gaps } : {},
    });
    assert.equal(finished.status, 200);
  }
  return { resource, source, session };
}

async function generate(harness, token, resourceId) {
  return harness.request("POST", `/v1/resources/${resourceId}/summaries`, {
    headers: authHeader(token),
    body: {},
  });
}

test("generate: 201 with the full Summary, citation reconciliation keeps verbatim quotes, usage accrues (D18)", async () => {
  const stub = createStubProvider();
  const captured = [];
  // Capturing wrapper delegates to the real stub and records the exact
  // prompt it was handed — the D17/D18 inputChars 口径 is checked against it.
  const provider = {
    id: stub.id,
    model: stub.model,
    async generate(input) {
      captured.push(input);
      return stub.generate(input);
    },
  };
  const { harness, a } = await startSummaryApp({ provider });
  try {
    const { resource, source, session } = await favoriteAndArchive(harness, a.token, {
      records: RECORDS,
      gaps: [{ startMs: 150000, endMs: 210000 }],
      label: "happy",
    });
    const note = await harness.request("POST", `/v1/resources/${resource.id}/notes`, {
      headers: authHeader(a.token),
      body: { clientRequestId: "note-1", text: "3:20 起的例子值得回看", sourceId: source.id, positionMs: 200000 },
    });
    assert.equal(note.status, 201);

    const response = await generate(harness, a.token, resource.id);
    assert.equal(response.status, 201, JSON.stringify(response.json));
    const summary = response.json.summary;
    assert.ok(summary.id);
    assert.equal(summary.resourceId, resource.id);
    assert.equal(typeof summary.content, "string");
    assert.ok(summary.content.includes("注意力机制详解 P2：自注意力（happy）"));
    // generation metadata: the provider identity is recorded, never credentials (D16).
    assert.deepEqual(
      Object.keys(summary.generation).sort(),
      ["inputChars", "model", "provider"],
    );
    assert.equal(summary.generation.provider, "stub");
    assert.equal(typeof summary.generation.model, "string");
    // inputChars = the FULL assembled prompt (system + user, code points,
    // D17/D18) — verified against what the provider actually received.
    assert.equal(captured.length, 1);
    const { system, user } = captured[0];
    const countCodePoints = (text) => [...text].length;
    assert.equal(summary.generation.inputChars, countCodePoints(system) + countCodePoints(user));
    // The assembled user prompt carries the template's 4 variables' material:
    // stamped transcript lines, the gap marker, and the timestamped note.
    assert.ok(user.includes(`[${source.id} 200000] 3:20 起的例子值得回看`));
    assert.ok(system.includes("课程总结"));
    assert.ok(captured[0].user.split("\n").some((line) => /^\[ses_\S+ 30000–60000\] /.test(line)));
    assert.ok(user.includes("已跳过，该范围未取得文本"));

    // Citations: every segmentRef resolves to a real archived record and
    // every quote is a verbatim excerpt; sorted by startMs ascending (§2.2).
    assert.ok(Array.isArray(summary.citations));
    assert.ok(summary.citations.length > 0);
    let previousStart = -1;
    for (const citation of summary.citations) {
      assert.deepEqual(Object.keys(citation).sort(), ["quote", "segmentRef"]);
      assert.deepEqual(Object.keys(citation.segmentRef).sort(), ["endMs", "sessionId", "startMs"]);
      assert.equal(citation.segmentRef.sessionId, session.id);
      const record = RECORDS.find(
        (r) => r.startMs === citation.segmentRef.startMs && r.endMs === citation.segmentRef.endMs,
      );
      assert.ok(record, JSON.stringify(citation));
      assert.ok(record.text.includes(citation.quote), citation.quote);
      assert.ok(citation.segmentRef.startMs > previousStart);
      previousStart = citation.segmentRef.startMs;
    }

    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(summary.generatedAt));

    // Usage accrued exactly once, with the same inputChars (D18).
    const usage = await harness.request("GET", "/v1/usage", { headers: authHeader(a.token) });
    assert.equal(usage.status, 200);
    assert.equal(usage.json.summaryCount, 1);
    assert.equal(usage.json.summaryInputChars, summary.generation.inputChars);
    assert.ok(usage.json.updatedAt);
  } finally {
    await harness.close();
  }
});

test("generate: every POST creates a NEW summary — regenerating without new material is deterministic but separate", async () => {
  const { harness, a } = await startSummaryApp();
  try {
    const { resource } = await favoriteAndArchive(harness, a.token, {
      records: RECORDS,
      label: "repeat",
    });
    const first = await generate(harness, a.token, resource.id);
    assert.equal(first.status, 201);
    const second = await generate(harness, a.token, resource.id);
    assert.equal(second.status, 201);
    assert.notEqual(second.json.summary.id, first.json.summary.id);
    // Same input -> same output (stub determinism, Testing Decisions).
    assert.equal(second.json.summary.content, first.json.summary.content);
    assert.deepEqual(second.json.summary.citations, first.json.summary.citations);
    assert.equal(second.json.summary.generation.inputChars, first.json.summary.generation.inputChars);

    const list = await harness.request("GET", `/v1/resources/${resource.id}/summaries`, {
      headers: authHeader(a.token),
    });
    assert.equal(list.status, 200);
    assert.equal(list.json.summaries.length, 2);
    // Newest first; the list projection carries counts, not the body.
    assert.deepEqual(list.json.summaries[0].id, second.json.summary.id);
    assert.deepEqual(Object.keys(list.json.summaries[0]).sort(), [
      "citationCount",
      "generatedAt",
      "generation",
      "id",
      "resourceId",
    ]);
    assert.equal(list.json.summaries[0].citationCount, first.json.summary.citations.length);

    // Detail: the bare full shape, identical to the generation response.
    const detail = await harness.request("GET", `/v1/summaries/${second.json.summary.id}`, {
      headers: authHeader(a.token),
    });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.summary, second.json.summary);
  } finally {
    await harness.close();
  }
});

test("generate: no archived transcript text -> 409 no_transcript_to_summarize, provider never called, nothing recorded", async () => {
  let providerCalls = 0;
  const provider = {
    id: "spy",
    model: "spy-1",
    async generate() {
      providerCalls += 1;
      return { content: "不应出现", citations: [] };
    },
  };
  const { harness, a } = await startSummaryApp({ provider });
  try {
    // An active session with nothing archived yet.
    const untouched = await favoriteAndArchive(harness, a.token, {
      records: [],
      finish: false,
      label: "untouched",
    });
    // A finished session whose only transcript content is a reported gap
    // (D17: gaps are markers, not text — "只有 gaps 同样算无文本").
    const gapOnly = await favoriteAndArchive(harness, a.token, {
      records: [],
      gaps: [{ startMs: 30000, endMs: 60000 }],
      label: "gap-only",
      url: "https://www.bilibili.com/video/BV1ab411L78c?p=3",
    });

    for (const { resource } of [untouched, gapOnly]) {
      const response = await generate(harness, a.token, resource.id);
      assert.equal(response.status, 409, JSON.stringify(response.json));
      assert.equal(response.json.error.code, "no_transcript_to_summarize");
      assert.equal(
        response.json.error.message,
        "这门资料还没有可总结的逐字稿，先学习并归档后再生成",
      );
    }
    assert.equal(providerCalls, 0, "the AI provider must not be called without transcript text");

    const usage = await harness.request("GET", "/v1/usage", { headers: authHeader(a.token) });
    assert.deepEqual(usage.json, {
      audioSeconds: 0,
      summaryCount: 0,
      summaryInputChars: 0,
      updatedAt: null,
    });
  } finally {
    await harness.close();
  }
});

test("generate: provider failure -> 502 summary_generation_failed, no summary, no usage (D16 不落脏数据); retry works", async () => {
  const stub = createStubProvider();
  let failNext = true;
  const flaky = {
    id: "flaky",
    model: "flaky-1",
    async generate(input) {
      if (failNext) {
        throw new Error("provider timeout after 120s");
      }
      return stub.generate(input);
    },
  };
  const { harness, a } = await startSummaryApp({ provider: flaky });
  try {
    const { resource } = await favoriteAndArchive(harness, a.token, { records: RECORDS, label: "flaky" });

    const failed = await generate(harness, a.token, resource.id);
    assert.equal(failed.status, 502);
    assert.equal(failed.json.error.code, "summary_generation_failed");
    assert.equal(
      failed.json.error.message,
      "总结生成失败，请稍后重试；本次尝试不产生总结记录",
    );

    // Nothing landed: the list is empty, usage shows nothing (D18).
    const list = await harness.request("GET", `/v1/resources/${resource.id}/summaries`, {
      headers: authHeader(a.token),
    });
    assert.deepEqual(list.json, { summaries: [] });
    const usage = await harness.request("GET", "/v1/usage", { headers: authHeader(a.token) });
    assert.deepEqual(usage.json, {
      audioSeconds: 0,
      summaryCount: 0,
      summaryInputChars: 0,
      updatedAt: null,
    });

    // Retry (provider recovers) succeeds as a normal generation.
    failNext = false;
    const retried = await generate(harness, a.token, resource.id);
    assert.equal(retried.status, 201);
    const usageAfter = await harness.request("GET", "/v1/usage", { headers: authHeader(a.token) });
    assert.equal(usageAfter.json.summaryCount, 1);
  } finally {
    await harness.close();
  }
});

test("generate: 401 without credentials; unknown and cross-account resources are the same 404 (D2)", async () => {
  const { harness, a, b } = await startSummaryApp();
  try {
    const { resource } = await favoriteAndArchive(harness, a.token, { records: RECORDS, label: "iso" });
    const generated = await generate(harness, a.token, resource.id);
    assert.equal(generated.status, 201);
    const summaryId = generated.json.summary.id;

    const anonymous = await harness.request("POST", `/v1/resources/${resource.id}/summaries`, { body: {} });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.json.error, { code: "unauthorized", message: "未登录或凭据缺失" });
    const anonymousList = await harness.request("GET", `/v1/resources/${resource.id}/summaries`);
    const anonymousDetail = await harness.request("GET", `/v1/summaries/${summaryId}`);
    assert.equal(anonymousList.status, 401);
    assert.equal(anonymousDetail.status, 401);

    const crossGenerate = await generate(harness, b.token, resource.id);
    assert.equal(crossGenerate.status, 404);
    assert.deepEqual(crossGenerate.json.error, { code: "not_found", message: "资源不存在或无权访问" });
    const crossList = await harness.request("GET", `/v1/resources/${resource.id}/summaries`, {
      headers: authHeader(b.token),
    });
    assert.equal(crossList.status, 404);
    const crossDetail = await harness.request("GET", `/v1/summaries/${summaryId}`, {
      headers: authHeader(b.token),
    });
    assert.equal(crossDetail.status, 404);
    assert.deepEqual(crossDetail.json.error, { code: "not_found", message: "总结不存在或无权访问" });
    const unknownDetail = await harness.request("GET", "/v1/summaries/sum_does_not_exist", {
      headers: authHeader(a.token),
    });
    assert.equal(unknownDetail.status, 404);
  } finally {
    await harness.close();
  }
});

test("generate: accounts are isolated — B's generations never appear in A's list or usage", async () => {
  const { harness, a, b } = await startSummaryApp();
  try {
    const mine = await favoriteAndArchive(harness, a.token, { records: RECORDS, label: "mine" });
    const theirs = await favoriteAndArchive(harness, b.token, { records: RECORDS, label: "theirs" });

    assert.equal((await generate(harness, a.token, mine.resource.id)).status, 201);
    assert.equal((await generate(harness, b.token, theirs.resource.id)).status, 201);
    assert.equal((await generate(harness, b.token, theirs.resource.id)).status, 201);

    const myList = await harness.request("GET", `/v1/resources/${mine.resource.id}/summaries`, {
      headers: authHeader(a.token),
    });
    assert.equal(myList.json.summaries.length, 1);
    const bList = await harness.request("GET", `/v1/resources/${theirs.resource.id}/summaries`, {
      headers: authHeader(b.token),
    });
    assert.equal(bList.json.summaries.length, 2);

    const aUsage = await harness.request("GET", "/v1/usage", { headers: authHeader(a.token) });
    assert.equal(aUsage.json.summaryCount, 1);
    const bUsage = await harness.request("GET", "/v1/usage", { headers: authHeader(b.token) });
    assert.equal(bUsage.json.summaryCount, 2);
  } finally {
    await harness.close();
  }
});

test("citation reconciliation: refs that do not resolve to a real archived record are dropped before landing (§2.2)", async () => {
  const provider = {
    id: "messy",
    model: "messy-1",
    async generate() {
      return {
        content: "# 正文照常落库",
        citations: [
          // Valid: exact record, exact quote.
          { quote: "注意力分数的计算，就是把查询向量和键向量做点积", sessionId: "KNOWN", startMs: 30000, endMs: 60000 },
          // Valid: verbatim excerpt (a slice of the record text).
          { quote: "为什么要缩放点积", sessionId: "KNOWN", startMs: 60000, endMs: 90000 },
          // Dead: unknown session id.
          { quote: "注意力分数的计算", sessionId: "ses_unknown", startMs: 30000, endMs: 60000 },
          // Dead: range does not match any record.
          { quote: "注意力分数的计算", sessionId: "KNOWN", startMs: 30000, endMs: 59999 },
          // Dead: paraphrased quote (not a verbatim excerpt).
          { quote: "注意力分数就是点积", sessionId: "KNOWN", startMs: 30000, endMs: 60000 },
          // Dead: endMs <= startMs.
          { quote: "为什么要缩放点积", sessionId: "KNOWN", startMs: 90000, endMs: 90000 },
          // Dead: malformed (missing fields / wrong types).
          { quote: "为什么要缩放点积", sessionId: "KNOWN" },
          "a stray string",
          null,
        ],
      };
    },
  };
  const { harness, a } = await startSummaryApp({ provider });
  try {
    const { resource, session } = await favoriteAndArchive(harness, a.token, {
      records: RECORDS,
      label: "reconcile",
    });
    // The session id is server-generated, so the provider resolves it lazily:
    // two resolvable citations plus seven dead/malformed ones.
    provider.generate = async () => ({
      content: "# 正文照常落库",
      citations: [
        { quote: "注意力分数的计算，就是把查询向量和键向量做点积", sessionId: session.id, startMs: 30000, endMs: 60000 },
        { quote: "为什么要缩放点积", sessionId: session.id, startMs: 60000, endMs: 90000 },
        { quote: "注意力分数的计算", sessionId: "ses_unknown", startMs: 30000, endMs: 60000 },
        { quote: "注意力分数的计算", sessionId: session.id, startMs: 30000, endMs: 59999 },
        { quote: "注意力分数就是点积", sessionId: session.id, startMs: 30000, endMs: 60000 },
        { quote: "为什么要缩放点积", sessionId: session.id, startMs: 90000, endMs: 90000 },
        { quote: "为什么要缩放点积", sessionId: session.id },
        "a stray string",
        null,
      ],
    });

    const response = await generate(harness, a.token, resource.id);
    assert.equal(response.status, 201, JSON.stringify(response.json));
    const summary = response.json.summary;
    // Only the two resolvable citations survive, sorted by startMs (§2.2).
    assert.deepEqual(summary.citations, [
      {
        quote: "注意力分数的计算，就是把查询向量和键向量做点积",
        segmentRef: { sessionId: session.id, startMs: 30000, endMs: 60000 },
      },
      {
        quote: "为什么要缩放点积",
        segmentRef: { sessionId: session.id, startMs: 60000, endMs: 90000 },
      },
    ]);
    assert.equal(summary.content, "# 正文照常落库");
  } finally {
    await harness.close();
  }
});

test("citation reconciliation: all citations invalid -> the summary still lands with an empty citations array", async () => {
  const provider = {
    id: "hallucinating",
    model: "hallucinating-1",
    async generate() {
      return {
        content: "# 只有正文",
        citations: [
          { quote: "编造的话", sessionId: "ses_nowhere", startMs: 1, endMs: 2 },
        ],
      };
    },
  };
  const { harness, a } = await startSummaryApp({ provider });
  try {
    const { resource } = await favoriteAndArchive(harness, a.token, { records: RECORDS, label: "all-dead" });
    const response = await generate(harness, a.token, resource.id);
    assert.equal(response.status, 201);
    assert.deepEqual(response.json.summary.citations, []);
    const list = await harness.request("GET", `/v1/resources/${resource.id}/summaries`, {
      headers: authHeader(a.token),
    });
    assert.equal(list.json.summaries[0].citationCount, 0);
  } finally {
    await harness.close();
  }
});

test("generate: a provider response without a usable content string is 502 (不可解析)", async () => {
  const provider = {
    id: "shapeless",
    model: "shapeless-1",
    async generate() {
      return { citations: [] }; // no content
    },
  };
  const { harness, a } = await startSummaryApp({ provider });
  try {
    const { resource } = await favoriteAndArchive(harness, a.token, { records: RECORDS, label: "shapeless" });
    const response = await generate(harness, a.token, resource.id);
    assert.equal(response.status, 502);
    assert.equal(response.json.error.code, "summary_generation_failed");
    const list = await harness.request("GET", `/v1/resources/${resource.id}/summaries`, {
      headers: authHeader(a.token),
    });
    assert.deepEqual(list.json, { summaries: [] });
  } finally {
    await harness.close();
  }
});
