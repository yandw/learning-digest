import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTranscriptViews, presentTranscript, sessionOriginLabel } from "../public/js/library.js";

// Owner decision 2026-11-17: 一份资料只有一份逐字稿。同一视频的多段
// 学习（sessions）在展示与课程总结输入上都合并成一条共享时间轴，
// 重叠区间去重，不再一份 session 一份副本。

function view(overrides) {
  return {
    sessionId: "ses_x",
    sourceId: "src_1",
    resourceId: "res_1",
    sessionStatus: "finished",
    origin: "asr",
    records: [],
    gaps: [],
    pending: [],
    failed: [],
    ...overrides,
  };
}

test("mergeTranscriptViews keeps one copy of overlapping records, longest text wins", () => {
  const v1 = view({
    sessionId: "ses_1",
    origin: "asr",
    records: [
      { startMs: 0, endMs: 30000, text: "短" },
      { startMs: 30000, endMs: 60000, text: "第二段完全不同的文本内容" },
    ],
  });
  const v2 = view({
    sessionId: "ses_2",
    origin: "asr",
    records: [
      { startMs: 0, endMs: 30000, text: "第一段更加完整的转写文本内容" },
      { startMs: 30000, endMs: 60000, text: "次" },
      { startMs: 60000, endMs: 90000, text: "只在新会话出现的第三段" },
    ],
  });

  const merged = mergeTranscriptViews([v1, v2]);

  assert.deepEqual(
    merged.records.map((r) => [r.startMs, r.text]),
    [
      [0, "第一段更加完整的转写文本内容"],
      [30000, "第二段完全不同的文本内容"],
      [60000, "只在新会话出现的第三段"],
    ],
  );
  assert.equal(merged.records[0].sessionId, "ses_2", "the surviving copy keeps its provenance");
  assert.equal(merged.records[0].origin, "asr");
});

test("mergeTranscriptViews tie-break is deterministic regardless of session order", () => {
  const mk = () => [
    view({ sessionId: "ses_b", origin: "asr", records: [{ startMs: 0, endMs: 30000, text: "完全相同长度的文本乙" }] }),
    view({ sessionId: "ses_a", origin: "asr", records: [{ startMs: 0, endMs: 30000, text: "完全相同长度的文本甲" }] }),
  ];
  const [b1, a1] = mk();
  const [b2, a2] = mk();
  const first = mergeTranscriptViews([a1, b1]);
  const second = mergeTranscriptViews([b2, a2]);
  assert.equal(first.records.length, 1);
  assert.equal(second.records.length, 1);
  assert.equal(first.records[0].sessionId, "ses_a", "equal length + equal origin -> smaller sessionId wins");
  assert.equal(second.records[0].sessionId, "ses_a", "input order must not change the outcome");
});

test("mergeTranscriptViews prefers captions over asr on an equal-length tie", () => {
  const asr = view({ sessionId: "ses_aaa", origin: "asr", records: [{ startMs: 0, endMs: 30000, text: "一样长的转写文本内容啊" }] });
  const captions = view({ sessionId: "ses_zzz", origin: "captions", records: [{ startMs: 0, endMs: 30000, text: "一样长的字幕文本内容哇" }] });
  const merged = mergeTranscriptViews([asr, captions]);
  assert.equal(merged.records[0].origin, "captions", "authored text beats machine text on a tie");
});

test("mergeTranscriptViews folds overlapping gaps and drops record-covered gaps", () => {
  const v1 = view({
    sessionId: "ses_1",
    records: [{ startMs: 0, endMs: 60000, text: "已覆盖区间" }],
    gaps: [{ startMs: 100000, endMs: 160000, reason: "skipped" }],
  });
  const v2 = view({
    sessionId: "ses_2",
    gaps: [
      { startMs: 120000, endMs: 180000, reason: "skipped" },
      { startMs: 200000, endMs: 210000, reason: "skipped" },
    ],
  });

  const merged = mergeTranscriptViews([v1, v2]);

  // 100000–160000 与 120000–180000 折叠成一条（最小 start，最大 end）；
  // 0–60000 区间如有 gap 会被 record 覆盖而不会出现。
  assert.deepEqual(
    merged.gaps.map((g) => [g.startMs, g.endMs]),
    [[100000, 180000], [200000, 210000]],
  );
});

test("mergeTranscriptViews keeps pending rows and dedups failed ranges", () => {
  const active = view({
    sessionId: "ses_live",
    sessionStatus: "active",
    pending: [{ segmentIndex: 4, startMs: 120000, endMs: 150000, status: "transcribing" }],
  });
  const old1 = view({
    sessionId: "ses_old1",
    failed: [{ segmentIndex: 2, startMs: 60000, endMs: 90000, error: { code: "asr_failed", message: "第一次失败" } }],
  });
  const old2 = view({
    sessionId: "ses_old2",
    failed: [{ segmentIndex: 0, startMs: 60000, endMs: 90000, error: { code: "asr_failed", message: "第二次失败" } }],
  });

  const merged = mergeTranscriptViews([active, old1, old2]);

  assert.equal(merged.sessionStatus, "active", "an active session keeps the merged view live");
  assert.equal(merged.pending.length, 1);
  assert.equal(merged.failed.length, 1, "same-range failures collapse to one row");
  assert.equal(merged.failed[0].error.message, "第一次失败", "first occurrence kept");
});

test("mergeTranscriptViews skips null views (still loading) without throwing", () => {
  const merged = mergeTranscriptViews([null, undefined, view({ records: [{ startMs: 0, endMs: 1000, text: "x" }] })]);
  assert.equal(merged.records.length, 1);
});

test("mergeTranscriptViews keeps every sliding-window position (neighbours overlap ~50%)", () => {
  // YouTube caption chunks advance by roughly half their width, so each
  // record overlaps its neighbours. Plain-overlap clustering chains the
  // whole session into ONE record; only near-duplicates (≥80% coverage)
  // may merge. Regression: the merged 逐字稿 collapsed to a single row.
  const v1 = view({
    sessionId: "ses_1",
    origin: "captions",
    records: [
      { startMs: 0, endMs: 4040, text: "短文本甲" },
      { startMs: 1800, endMs: 6120, text: "中段文本" },
      { startMs: 4040, endMs: 8200, text: "长" },
    ],
  });
  const v2 = view({
    sessionId: "ses_2",
    origin: "captions",
    records: [
      { startMs: 0, endMs: 4040, text: "短" },
      { startMs: 1800, endMs: 6120, text: "中" },
    ],
  });

  const merged = mergeTranscriptViews([v1, v2]);

  assert.deepEqual(
    merged.records.map((r) => r.text),
    ["短文本甲", "中段文本", "长"],
    "three distinct positions survive; the exact copy dedups to the longest text",
  );
  assert.equal(merged.records[0].sessionId, "ses_1", "the longer original keeps the seat");
});

test("presentTranscript renders the merged view with per-record origin labels", () => {
  const captions = view({
    sessionId: "ses_c",
    origin: "captions",
    records: [{ startMs: 0, endMs: 30000, text: "字幕第一段" }],
  });
  const asr = view({
    sessionId: "ses_a",
    origin: "asr",
    records: [{ startMs: 0, endMs: 30000, text: "语音转写第一段更完整的文本" }],
  });
  const entries = presentTranscript(mergeTranscriptViews([captions, asr]), []);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "语音转写第一段更完整的文本");
  assert.equal(sessionOriginLabel(entries[0].origin), "语音转写");
});

test("presentTranscript keeps organized paragraphs and links their sentences to the right source", () => {
  const captions = view({
    sessionId: "ses_c",
    sourceId: "src_2",
    origin: "captions",
    records: [{ startMs: 0, endMs: 30000, text: "分集原字幕" }],
  });
  const organized = view({
    records: [
      { startMs: 0, endMs: 30000, text: "如果输入" },
      { startMs: 30000, endMs: 60000, text: "足够就继续否则先" },
    ],
    organized: { status: "ready", paragraphs: [{ sentences: [
      { text: "如果输入足够，就继续。", startMs: 0, endMs: 60000, spans: [
        { recordIndex: 0, startMs: 0, endMs: 30000 },
        { recordIndex: 1, startMs: 30000, endMs: 60000 },
      ] },
      { text: "否则先", startMs: 30000, endMs: 60000, spans: [
        { recordIndex: 1, startMs: 30000, endMs: 60000 },
      ] },
    ] }] },
  });
  const sources = [
    { id: "src_1", platformId: "youtube", url: "https://www.youtube.com/watch?v=lesson" },
    { id: "src_2", platformId: "bilibili", url: "https://www.bilibili.com/video/BV1ab411L78c?p=2" },
  ];

  const entries = presentTranscript(mergeTranscriptViews([captions, organized]), sources);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.text === "分集原字幕").jumpUrl,
    "https://www.bilibili.com/video/BV1ab411L78c?p=2&t=0");
  assert.deepEqual(entries.find((entry) => entry.sentences).sentences.map(({ text, jumpUrl }) => [text, jumpUrl]), [
    ["如果输入足够，就继续。", "https://www.youtube.com/watch?v=lesson&t=0s"],
    ["否则先", "https://www.youtube.com/watch?v=lesson&t=30s"],
  ]);
});

test("presentTranscript keeps organized and raw ranges in a partially organized session", () => {
  const records = [
    { startMs: 0, endMs: 15000, text: "已整理" },
    { startMs: 15000, endMs: 30000, text: "原始转写" },
  ];
  const transcript = view({
    records,
    organized: { status: "partial", paragraphs: [
      { sentences: [{ ...records[0], text: "已整理。" }] },
      { status: "raw", sentences: [records[1]] },
    ] },
  });

  const entries = presentTranscript(mergeTranscriptViews([transcript]), []);
  assert.deepEqual(entries.map((entry) => entry.sentences[0].text), ["已整理。", "原始转写"]);
  assert.equal(entries[1].detail, "此段显示原始转写");
});
