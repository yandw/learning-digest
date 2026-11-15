/**
 * The panel AI's server-side client (ticket 6.6, issue #91; contract-r4
 * §6/§7): path builders, the rolling-summary tick rhythm, the overview and
 * digest payload parsers, the digest→report-artifact mapping the panel and
 * report page render, the explain body builder, and the shared error
 * verdict classifier. Success shapes are pinned to the REAL contract
 * fixtures, so the client and the contract can never drift apart.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const panelAi = require("../panel-ai.js");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const overviewFixtures = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "contracts", "fixtures", "session-overview-examples.json"),
    "utf8",
  ),
);
const digestFixtures = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "contracts", "fixtures", "session-digest-examples.json"),
    "utf8",
  ),
);
const errorFixtures = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "contracts", "fixtures", "error-examples.json"),
    "utf8",
  ),
);

function sample(fixtures, id) {
  const found = fixtures.samples.find((entry) => entry.id === id);
  assert.ok(found, `fixture ${id} must exist`);
  return found;
}

// --- paths ---------------------------------------------------------------------

test("panel AI paths encode the opaque session id and use the contract routes", () => {
  assert.equal(
    panelAi.rollingSummaryPath("ses_01JABC0033"),
    "/v1/sessions/ses_01JABC0033/rolling-summary",
  );
  assert.equal(
    panelAi.overviewPath("ses_01JABC0033"),
    "/v1/sessions/ses_01JABC0033/overview",
  );
  assert.equal(
    panelAi.digestPath("ses_01JABC0036"),
    "/v1/sessions/ses_01JABC0036/digest",
  );
  assert.equal(panelAi.explainPath(), "/v1/ai/explain");
  // A hostile id must not change the path shape (§1 opaque ids).
  assert.equal(
    panelAi.rollingSummaryPath("../other/session"),
    `/v1/sessions/${encodeURIComponent("../other/session")}/rolling-summary`,
  );
});

// --- tick rhythm (the retired PoC debounce, cursor externalized) -----------------

// Ten 90-second records = 15 minutes of coverage, the default-interval
// boundary the PoC used.
function coverageRecords(count = 10, startSeconds = 0) {
  const records = [];
  for (let i = 0; i < count; i++) {
    records.push({ text: `第 ${i + 1} 段`, start: startSeconds + i * 90, duration: 90 });
  }
  return records;
}

test("isRollingSummaryDue fires when new coverage reaches the interval and the debounce", () => {
  assert.equal(
    panelAi.isRollingSummaryDue({
      state: { transcriptRecords: coverageRecords() },
      cursorSeconds: 0,
      intervalMinutes: 15,
    }),
    true,
  );
});

test("isRollingSummaryDue stays quiet below either bar", () => {
  // Two records: far below both the coverage and the debounce bars.
  assert.equal(
    panelAi.isRollingSummaryDue({
      state: {
        transcriptRecords: [
          { text: "第一段", start: 0, duration: 60 },
          { text: "第二段", start: 60, duration: 60 },
        ],
      },
      cursorSeconds: 0,
      intervalMinutes: 15,
    }),
    false,
  );
  // Enough records, not enough coverage.
  assert.equal(
    panelAi.isRollingSummaryDue({
      state: { transcriptRecords: coverageRecords(10, 0).map((r) => ({ ...r, duration: 30 })) },
      cursorSeconds: 0,
      intervalMinutes: 15,
    }),
    false,
    "coverage below the interval never fires",
  );
  // Enough coverage, not enough new records.
  assert.equal(
    panelAi.isRollingSummaryDue({
      state: { transcriptRecords: coverageRecords(3) },
      cursorSeconds: 0,
      intervalMinutes: 5,
    }),
    false,
    "fewer than 10 new records never fires",
  );
});

test("isRollingSummaryDue honors the server cursor so covered material does not retrigger", () => {
  // The first 10 records are covered by the last server Topic (cursor at
  // 900s); only one new record exists since.
  assert.equal(
    panelAi.isRollingSummaryDue({
      state: { transcriptRecords: [...coverageRecords(), coverageRecords(1, 900)] },
      cursorSeconds: 900,
      intervalMinutes: 15,
    }),
    false,
  );
  // Ten NEW records past the cursor do fire.
  assert.equal(
    panelAi.isRollingSummaryDue({
      state: { transcriptRecords: [...coverageRecords(), ...coverageRecords(10, 900)] },
      cursorSeconds: 900,
      intervalMinutes: 15,
    }),
    true,
  );
  // Failure-marker records stay in every window (the PoC convention): they
  // count toward coverage so a summary can mention the gap.
  assert.equal(
    panelAi.isRollingSummaryDue({
      state: {
        transcriptRecords: [
          ...coverageRecords(10),
          { text: "[语音转录失败]", start: 900, duration: 120, failed: true },
        ],
      },
      cursorSeconds: 0,
      intervalMinutes: 15,
    }),
    true,
  );
});

// --- overview (contract-r4 §6.1) --------------------------------------------------

test("parseOverview accepts the contract fixture verbatim", () => {
  const body = sample(overviewFixtures, "api-rolling-summary-append").response.body;
  const parsed = panelAi.parseOverview(body);
  assert.ok(parsed, "the fixture parses");
  assert.equal(parsed.sessionId, "ses_01JABC0033");
  assert.equal(parsed.topics.length, 2);
  assert.equal(parsed.lastCoveredMs, 150000);
  assert.deepEqual(parsed.generation, { provider: "qwen", model: "qwen-plus", inputChars: 1470 });
  assert.equal(parsed.generatedAt, "2026-11-10T10:05:00Z");
  assert.equal(parsed.topics[1].continuation, true);
});

test("parseOverview rejects malformed payloads and drops malformed entries", () => {
  assert.equal(panelAi.parseOverview(null), null);
  assert.equal(panelAi.parseOverview({}), null);
  assert.equal(panelAi.parseOverview({ overview: { topics: "no" } }), null);
  // One malformed entry is dropped, the usable one stays.
  const partial = panelAi.parseOverview({
    overview: {
      sessionId: "ses_x",
      lastCoveredMs: 60000,
      generation: { provider: "qwen", model: "qwen-plus", inputChars: 10 },
      generatedAt: "2026-11-10T10:05:00Z",
      topics: [
        { index: 1, startMs: 0, endMs: 60000, title: "导论", text: "开场。" },
        { index: 2, startMs: 90000, endMs: 50000, title: "倒置", text: "end 在 start 前。" },
        { index: 3, startMs: 60000, endMs: 90000, title: "", text: "无标题。" },
      ],
    },
  });
  assert.ok(partial);
  assert.equal(partial.topics.length, 1);
});

test("overviewLiveTopics maps the server millisecond timeline to panel seconds", () => {
  const body = sample(overviewFixtures, "api-rolling-summary-append").response.body;
  const topics = panelAi.overviewLiveTopics(panelAi.parseOverview(body));
  assert.deepEqual(topics, [
    { start: 0, end: 60, title: "开场回顾与点积注意力", text: "本段先回顾上一课留下的三个问题，随后进入注意力分数的计算：把查询向量和键向量做点积。" },
    {
      start: 90,
      end: 150,
      title: "长序列处理与多头结构",
      text: "本段补充注意力机制在长序列下的处理思路，并延伸到多头注意力的并行结构。",
      continuation: true,
    },
  ]);
});

test("overviewCursorSeconds floors the server cursor into panel seconds", () => {
  const body = sample(overviewFixtures, "api-rolling-summary-append").response.body;
  assert.equal(
    panelAi.overviewCursorSeconds(panelAi.parseOverview(body)),
    150,
  );
  assert.equal(panelAi.overviewCursorSeconds(null), 0);
});

// --- digest (contract-r4 §7.1) -----------------------------------------------------

test("parseDigest accepts the contract fixture with the five fixed keys", () => {
  const body = sample(digestFixtures, "api-session-digest-generate").response.body;
  const parsed = panelAi.parseDigest(body);
  assert.ok(parsed, "the fixture parses");
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["categories", "generatedAt", "generation", "overview", "quotes", "sessionId", "todos", "topics"],
    "the five report keys plus the envelope fields",
  );
  assert.equal(parsed.overview.length, 2);
  assert.equal(parsed.topics.length, 1);
  assert.deepEqual(parsed.topics[0].bullets, [
    "回顾上一课留下的三个问题",
    "注意力分数的计算：查询向量与键向量做点积",
  ]);
  assert.equal(parsed.topics[0].startMs, 0);
  assert.equal(parsed.topics[0].endMs, 60000);
  assert.deepEqual(parsed.categories[0], {
    title: "注意力机制基础",
    points: ["注意力分数用点积衡量查询与键的相似度", "分数计算建立在上一课的问题清单之上"],
  });
  assert.equal(parsed.quotes.length, 2);
  assert.deepEqual(parsed.todos, []);
});

test("parseDigest rejects malformed payloads", () => {
  assert.equal(panelAi.parseDigest(null), null);
  assert.equal(panelAi.parseDigest({}), null);
  assert.equal(panelAi.parseDigest({ digest: { overview: "no" } }), null);
});

test("digestToReportArtifact maps the server digest into the report artifact the panel renders", () => {
  const body = sample(digestFixtures, "api-session-digest-generate").response.body;
  const digest = panelAi.parseDigest(body);
  const artifact = panelAi.digestToReportArtifact({ digest, sessionId: "s_local1" });

  assert.equal(artifact.sessionId, "s_local1");
  assert.equal(artifact.meta, null);
  assert.equal(artifact.generatedAtMs, Date.parse("2026-11-10T11:20:00Z"));
  // The report the renderers consume: the same five keys, the source
  // timeline converted from milliseconds to the panel's seconds.
  assert.deepEqual(artifact.report.overview, digest.overview);
  assert.deepEqual(artifact.report.topics, [
    {
      start: 0,
      end: 60,
      title: "开场回顾与点积注意力",
      bullets: ["回顾上一课留下的三个问题", "注意力分数的计算：查询向量与键向量做点积"],
      summary: "本段先回顾上一课的问题，随后进入注意力分数的计算。",
    },
  ]);
  assert.deepEqual(artifact.report.quotes, [
    { start: 0, text: "欢迎来到这一节，我们先回顾上一课留下的三个问题" },
    { start: 30, text: "注意力分数的计算，就是把查询向量和键向量做点积" },
  ]);
  assert.deepEqual(artifact.report.categories, digest.categories);
  assert.deepEqual(artifact.report.todos, []);
});

test("digestToReportArtifact falls back to now when the stamp is unreadable", () => {
  const artifact = panelAi.digestToReportArtifact({
    digest: panelAi.parseDigest({
      digest: {
        sessionId: "ses_x",
        overview: [],
        topics: [],
        categories: [],
        quotes: [],
        todos: [],
        generation: { provider: "qwen", model: "qwen-plus", inputChars: 1 },
        generatedAt: "not-a-date",
      },
    }),
    sessionId: "s_local1",
  });
  assert.equal(typeof artifact.generatedAtMs, "number");
  assert.ok(Number.isFinite(artifact.generatedAtMs));
});

// --- explain (contract-r4 §7.2) -----------------------------------------------------

test("buildExplainBody sends the text and omits an empty context", () => {
  assert.deepEqual(
    panelAi.buildExplainBody({ text: "把查询向量和键向量做点积", context: "注意力分数的计算先从相似度开始" }),
    { text: "把查询向量和键向量做点积", context: "注意力分数的计算先从相似度开始" },
  );
  assert.deepEqual(panelAi.buildExplainBody({ text: "选中的文字" }), { text: "选中的文字" });
  assert.deepEqual(panelAi.buildExplainBody({ text: "  ", context: "上下文" }), null);
  assert.deepEqual(panelAi.buildExplainBody({}), null);
});

test("parseExplanation reads the contract fixture's explanation", () => {
  const body = sample(digestFixtures, "api-ai-explain").response.body;
  assert.equal(
    panelAi.parseExplanation(body),
    "点积衡量查询向量与键向量的对齐程度，对齐越高、注意力分数越大。",
  );
  assert.equal(panelAi.parseExplanation({}), null);
  assert.equal(panelAi.parseExplanation({ explanation: "  " }), null);
});

// --- verdicts (the §1 envelope, contract-r4 §6.4/§7.4) -------------------------------

function errorSample(id) {
  return sample(errorFixtures, id).response;
}

test("classifyPanelAiOutcome routes the contract error codes to panel verdicts", () => {
  // 401 → the P7 unauthorized handoff.
  const unauthorized = panelAi.classifyPanelAiOutcome({
    status: errorSample("error-rolling-summary-unauthorized").status,
    data: errorSample("error-rolling-summary-unauthorized").body,
  });
  assert.equal(unauthorized.kind, "unauthorized");
  assert.equal(unauthorized.message, "未登录或凭据缺失");

  // 404 overview_not_generated / digest_not_generated → notGenerated.
  const notGenerated = panelAi.classifyPanelAiOutcome({
    status: errorSample("error-overview-not-generated").status,
    data: errorSample("error-overview-not-generated").body,
  });
  assert.equal(notGenerated.kind, "notGenerated");
  assert.equal(notGenerated.code, "overview_not_generated");
  assert.equal(notGenerated.message, "这次学习还没有生成过概览，先发起一次滚动摘要");

  // Cross-account/unknown 404 (D2) → notFound.
  const crossAccount = panelAi.classifyPanelAiOutcome({
    status: errorSample("error-digest-cross-account").status,
    data: errorSample("error-digest-cross-account").body,
  });
  assert.equal(crossAccount.kind, "notFound");
  assert.equal(crossAccount.message, "学习记录不存在或无权访问");

  // 409 no_session_transcript_to_summarize → noTranscript.
  const noTranscript = panelAi.classifyPanelAiOutcome({
    status: errorSample("error-digest-no-transcript").status,
    data: errorSample("error-digest-no-transcript").body,
  });
  assert.equal(noTranscript.kind, "noTranscript");
  assert.equal(noTranscript.message, "这次学习还没有可总结的逐字稿记录，先归档后再生成");

  // 409 session_not_finished → notFinished.
  const notFinished = panelAi.classifyPanelAiOutcome({
    status: errorSample("error-digest-not-finished").status,
    data: errorSample("error-digest-not-finished").body,
  });
  assert.equal(notFinished.kind, "notFinished");
  assert.equal(notFinished.code, "session_not_finished");

  // 502 → failed (AI provider failure, retry-safe).
  const failed = panelAi.classifyPanelAiOutcome({
    status: errorSample("error-digest-failed").status,
    data: errorSample("error-digest-failed").body,
  });
  assert.equal(failed.kind, "failed");
  assert.equal(failed.message, "纪要生成失败，请稍后重试；本次尝试不改变已有纪要");

  // 400 validation_failed → invalid.
  const invalid = panelAi.classifyPanelAiOutcome({
    status: errorSample("error-explain-text-too-long").status,
    data: errorSample("error-explain-text-too-long").body,
  });
  assert.equal(invalid.kind, "invalid");

  // Any other status → the plain error verdict with the envelope message.
  const other = panelAi.classifyPanelAiOutcome({
    status: 403,
    data: { error: { code: "forbidden", message: "禁止访问" } },
  });
  assert.equal(other.kind, "error");
  assert.equal(other.message, "禁止访问");
});

test("classifyPanelAiOutcome marks 2xx ok and keeps the failure envelope verbatim on odd bodies", () => {
  assert.equal(panelAi.classifyPanelAiOutcome({ status: 201, data: {} }).kind, "ok");
  assert.equal(panelAi.classifyPanelAiOutcome({ status: 200, data: {} }).kind, "ok");
  // A non-JSON body parses to null; the verdict still carries a fallback
  // message instead of the envelope.
  const odd = panelAi.classifyPanelAiOutcome({ status: 502, data: null, fallback: "生成失败" });
  assert.equal(odd.kind, "failed");
  assert.equal(odd.message, "生成失败");
  // Network failures carry their own message.
  const network = panelAi.classifyPanelAiOutcome({ network: true, networkMessage: "fetch failed" });
  assert.equal(network.kind, "network");
  assert.equal(network.message, "fetch failed");
});
