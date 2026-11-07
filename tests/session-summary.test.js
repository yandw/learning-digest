const test = require("node:test");
const assert = require("node:assert/strict");

const summary = require("../session-summary.js");
const pipeline = require("../session-pipeline.js");

function activeSessionWithRecords(records, topics = []) {
  let state = pipeline.createSession({ sessionId: "s_test" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-0",
    records,
  });
  // Topics are JSON-plain state data; attaching them literally keeps these
  // tests independent of the append event under test in session-pipeline.test.js.
  return { ...state, topics };
}

test("coveredUntilFor returns the timeline end of the summarized records", () => {
  assert.equal(summary.coveredUntilFor([]), 0);
  assert.equal(
    summary.coveredUntilFor([
      { text: "a", start: 0, duration: 60 },
      { text: "b", start: 60, duration: 90 },
    ]),
    150,
  );
});

// --- Topic tick trigger: content-driven (coverage >= interval AND >= 10 records)

// Ten 90-second records exactly fill the default 15-minute interval.
function record(start, duration = 90) {
  return { text: `记录 ${start}`, start, duration };
}

test("a Topic tick is due when new Transcript coverage reaches the interval with enough records", () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(record(i * 90));
  const state = activeSessionWithRecords(records);

  assert.equal(
    summary.isTopicTickDue({ state, intervalMinutes: 15 }),
    true,
  );
});

test("a Topic tick below the interval boundary is not due", () => {
  const records = [];
  for (let i = 0; i < 9; i++) records.push(record(i * 100));
  // 9 records x 100s = 900s of coverage, but also below the record debounce.
  records.push(record(890, 9)); // coverage ends at 899s with 10 records
  const state = activeSessionWithRecords(records);

  assert.equal(
    summary.isTopicTickDue({ state, intervalMinutes: 15 }),
    false,
  );
});

test("a Topic tick is debounced until at least 10 new Transcript records exist", () => {
  const records = [];
  for (let i = 0; i < 9; i++) records.push(record(i * 100)); // 900s coverage
  const nineRecords = activeSessionWithRecords(records);
  assert.equal(
    summary.isTopicTickDue({ state: nineRecords, intervalMinutes: 15 }),
    false,
    "coverage reached the interval but only 9 records exist",
  );

  const tenRecords = activeSessionWithRecords([...records, record(900)]);
  assert.equal(
    summary.isTopicTickDue({ state: tenRecords, intervalMinutes: 15 }),
    true,
  );
});

test("a Topic tick is not due when the Transcript is quiet since the last tick", () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(record(i * 90));
  const state = activeSessionWithRecords(records, [
    { start: 0, end: 900, title: "导论", text: "课程开场。" },
  ]);

  assert.equal(
    summary.isTopicTickDue({ state, intervalMinutes: 15 }),
    false,
    "Topics already cover the whole Transcript",
  );
});

test("a Topic tick is not due when there is no Transcript at all", () => {
  const state = activeSessionWithRecords([]);
  assert.equal(summary.isTopicTickDue({ state, intervalMinutes: 15 }), false);
});

test("the trigger cursor derives from the Topics, not from the wall clock", () => {
  const before = [];
  for (let i = 0; i < 10; i++) before.push(record(i * 60)); // 0..600 covered
  const after = [];
  for (let i = 0; i < 10; i++) after.push(record(600 + i * 90)); // 600..1500
  const covered = [
    { start: 0, end: 600, title: "导论", text: "课程开场。" },
  ];

  const shortTail = activeSessionWithRecords([...before, ...after], covered);
  // Only 300s of records past the Topic cursor: not due even though the
  // whole Transcript reaches 1500s.
  const shortState = activeSessionWithRecords(
    [...before, ...after.slice(0, 4)],
    covered,
  );

  assert.equal(
    summary.isTopicTickDue({ state: shortTail, intervalMinutes: 15 }),
    true,
    "900s of new Transcript past the Topic cursor is due",
  );
  assert.equal(
    summary.isTopicTickDue({ state: shortState, intervalMinutes: 15 }),
    false,
    "300s past the cursor is below the interval",
  );
});

test("records before the Topic cursor never count toward the trigger", () => {
  // 20 records cover 0..1200s but Topics already cover 0..600; the new
  // window holds only 10 records x 60s = 600s of coverage: not due at 15min.
  const records = [];
  for (let i = 0; i < 20; i++) records.push(record(i * 60));
  const state = activeSessionWithRecords(records, [
    { start: 0, end: 600, title: "导论", text: "课程开场。" },
  ]);

  assert.equal(
    summary.isTopicTickDue({ state, intervalMinutes: 15 }),
    false,
  );
});

// --- Block input assembly: new Transcript + overlap tail + existing titles

test("with no Topics, every Transcript record is new input and the overlap tail is empty", () => {
  const state = activeSessionWithRecords([
    { text: "first", start: 0, duration: 60 },
    { text: "second", start: 60, duration: 60 },
  ]);

  const input = summary.assembleTopicBlockInput(state);

  assert.equal(input.cursor, 0);
  assert.deepEqual(
    input.newTranscript.map((r) => r.text),
    ["first", "second"],
  );
  assert.deepEqual(input.overlapTail, []);
  assert.deepEqual(input.existingTopicTitles, []);
});

test("block input keeps records at or after the Topic cursor and adds a 2-minute context tail", () => {
  const state = activeSessionWithRecords(
    [
      { text: "way before", start: 100, duration: 60 }, // ends 160: outside tail
      { text: "ends at cutoff", start: 370, duration: 110 }, // ends 480: nothing after cutoff
      { text: "tail start", start: 380, duration: 101 }, // ends 481: inside tail
      { text: "spans cursor", start: 590, duration: 20 }, // 590..610: context only
      { text: "new content", start: 600, duration: 60 }, // at cursor: new input
    ],
    [{ start: 0, end: 600, title: "导论", text: "课程开场。" }],
  );

  const input = summary.assembleTopicBlockInput(state);

  assert.equal(input.cursor, 600);
  assert.deepEqual(
    input.newTranscript.map((r) => r.text),
    ["new content"],
  );
  assert.deepEqual(
    input.overlapTail.map((r) => r.text),
    ["tail start", "spans cursor"],
  );
  assert.deepEqual(input.existingTopicTitles, ["导论"]);
});

test("the overlap tail covers only the last two minutes before the cursor", () => {
  const state = activeSessionWithRecords(
    [
      { text: "three minutes early", start: 340, duration: 100 }, // ends 440
      { text: "just inside", start: 470, duration: 100 }, // 470..570
      { text: "touching cursor", start: 580, duration: 20 }, // 580..600
    ],
    [{ start: 0, end: 600, title: "导论", text: "课程开场。" }],
  );

  const input = summary.assembleTopicBlockInput(state);

  assert.deepEqual(
    input.overlapTail.map((r) => r.text),
    ["just inside", "touching cursor"],
  );
});

test("existing Topic titles arrive in timeline order for continuation detection", () => {
  const state = activeSessionWithRecords(
    [{ text: "new", start: 900, duration: 60 }],
    [
      { start: 0, end: 300, title: "导论", text: "开场。" },
      { start: 300, end: 900, title: "二次函数", text: "讲解了二次函数。" },
    ],
  );

  const input = summary.assembleTopicBlockInput(state);

  assert.deepEqual(input.existingTopicTitles, ["导论", "二次函数"]);
});

test("failure-marker records inside the new window stay in the block input", () => {
  let state = pipeline.createSession({ sessionId: "s_markers" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, { type: "transcribeFailed", segmentId: "seg-0" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-1", start: 120, duration: 120 },
  });
  state = pipeline.applyEvent(state, {
    type: "transcribeOk",
    segmentId: "seg-1",
    records: [{ text: "after the gap", start: 120, duration: 120 }],
  });

  const input = summary.assembleTopicBlockInput(state);

  assert.equal(input.newTranscript.length, 2);
  assert.equal(input.newTranscript[0].failed, true);
  assert.equal(input.newTranscript[1].text, "after the gap");
});

// --- Topic block prompt: the JSON Topic contract in Chinese

test("the Topic prompt demands a JSON array of Topics with seconds and a continuation flag", () => {
  const messages = summary.buildTopicBlockMessages({
    existingTopicTitles: [],
    contextTranscriptText: "",
    newTranscriptText: "[0:00] 课程开场",
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.match(messages[0].content, /JSON/);
  assert.match(messages[0].content, /continuation/);
  assert.match(messages[0].content, /秒/);
  assert.match(messages[0].content, /title/);
  assert.match(messages[0].content, /text/);
});

test("the Topic prompt marks the overlap tail as context-only", () => {
  const messages = summary.buildTopicBlockMessages({
    existingTopicTitles: ["导论"],
    contextTranscriptText: "[9:50] 上一段的结尾回顾",
    newTranscriptText: "[10:00] 新的内容",
  });

  assert.match(messages[1].content, /上文回顾/);
  assert.match(messages[1].content, /\[9:50\] 上一段的结尾回顾/);
  assert.match(messages[1].content, /\[10:00\] 新的内容/);
  // The context must never be summarized into new Topics.
  assert.match(messages[0].content, /不要把它们写成新的话题段|不要总结成新的话题段/);
});

test("the Topic prompt anchors continuation detection on the last existing Topic", () => {
  const messages = summary.buildTopicBlockMessages({
    existingTopicTitles: ["导论", "二次函数"],
    contextTranscriptText: "[14:30] 承接上文",
    newTranscriptText: "[15:00] 继续讲解二次函数",
  });

  assert.match(messages[1].content, /二次函数/);
  assert.match(messages[1].content, /导论/);
});

test("the first Topic tick states there are no previous Topics", () => {
  const messages = summary.buildTopicBlockMessages({
    existingTopicTitles: [],
    contextTranscriptText: "",
    newTranscriptText: "[0:00] 课程开场",
  });

  assert.match(messages[1].content, /没有已有话题/);
});

// --- Tolerant parser: model output -> Topic list (never throws)

const GOOD_TOPIC_LINE =
  '[{"start": 0, "end": 900, "title": "导论", "text": "老师介绍了课程目标。"}]';

test("the parser maps a plain JSON array to Topics", () => {
  assert.deepEqual(summary.parseTopicBlock(GOOD_TOPIC_LINE), [
    { start: 0, end: 900, title: "导论", text: "老师介绍了课程目标。" },
  ]);
});

test("the parser keeps an explicit continuation flag and drops it otherwise", () => {
  const topics = summary.parseTopicBlock(
    '[{"start": 0, "end": 90, "title": "开场", "text": "第一句。", "continuation": true},' +
      '{"start": 90, "end": 180, "title": "正题", "text": "第二句。"}]',
  );

  assert.deepEqual(topics, [
    { start: 0, end: 90, title: "开场", text: "第一句。", continuation: true },
    { start: 90, end: 180, title: "正题", text: "第二句。" },
  ]);
});

test("the parser tolerates JSON wrapped in prose or code fences", () => {
  assert.deepEqual(
    summary.parseTopicBlock(`好的，以下是话题段：\n\`\`\`json\n${GOOD_TOPIC_LINE}\n\`\`\`\n请查收。`),
    [{ start: 0, end: 900, title: "导论", text: "老师介绍了课程目标。" }],
  );
});

test("the parser repairs the trailing-comma LLM slip", () => {
  assert.deepEqual(
    summary.parseTopicBlock(
      '[{"start": 0, "end": 90, "title": "开场", "text": "第一句。",},]',
    ),
    [{ start: 0, end: 90, title: "开场", text: "第一句。" }],
  );
});

test("the parser accepts an object wrapping a topics array", () => {
  assert.deepEqual(
    summary.parseTopicBlock('{"topics": [{"start": 0, "end": 90, "title": "开场", "text": "第一句。"}]}'),
    [{ start: 0, end: 90, title: "开场", text: "第一句。" }],
  );
});

test("malformed model output parses to an empty list", () => {
  assert.deepEqual(summary.parseTopicBlock("这一段没有可总结的话题。"), []);
  assert.deepEqual(summary.parseTopicBlock('{"chapters": []}'), []);
  assert.deepEqual(summary.parseTopicBlock("[{"), []);
  assert.deepEqual(summary.parseTopicBlock(""), []);
});

test("the parser drops entries that are not valid Topics and keeps the valid ones", () => {
  const topics = summary.parseTopicBlock(
    "[" +
      '{"start": 0, "end": 90, "title": "开场", "text": "第一句。"},' +
      '{"start": 90, "end": 60, "title": "倒置", "text": "end 在 start 之前。"},' +
      '{"start": "零", "end": 200, "title": "非数字", "text": "start 不是数字。"},' +
      '{"start": 200, "end": 300, "title": "", "text": "标题为空。"},' +
      '{"start": 300, "end": 400, "title": "无总结"},' +
      ']',
  );

  assert.deepEqual(topics, [
    { start: 0, end: 90, title: "开场", text: "第一句。" },
  ]);
});

test("the parser normalizes seconds to non-negative integers and trims strings", () => {
  const topics = summary.parseTopicBlock(
    '[{"start": 10.9, "end": 75.4, "title": " 导论 ", "text": " 开场总结 "}]',
  );

  assert.deepEqual(topics, [
    { start: 10, end: 75, title: "导论", text: "开场总结" },
  ]);
});

test("Transcript formatting stamps records as [m:ss] lines", () => {
  const text = summary.formatTranscriptForPrompt([
    { text: "welcome", start: 0, duration: 30 },
    { text: "middle", start: 65, duration: 30 },
    { text: "late", start: 3661, duration: 30 },
  ]);

  assert.equal(text, "[0:00] welcome\n[1:05] middle\n[61:01] late");
});

test("Session Digest prompt covers the full Transcript in one global pass", () => {
  const messages = summary.buildSessionDigestMessages({
    uncoveredTranscriptText: "[0:00] The whole lesson\n[120:00] Final wrap-up and Q&A",
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[1].content, /\[0:00\] The whole lesson/);
  assert.match(messages[1].content, /\[120:00\] Final wrap-up and Q&A/);
});


// Background glue for the Session Digest, exercised through the same VM seam
// translation.test.js uses for requestAiCompletion, with fetch mocked at the
// boundary and the real state machine + assembly module injected.
const { loadBackgroundHelpers } = require("./helpers/load-background.js");

function endedSession({ records }) {
  let state = pipeline.createSession({ sessionId: "s_digest" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, { type: "transcribeOk", segmentId: "seg-0", records });
  return pipeline.applyEvent(state, { type: "sessionEnd" });
}

function mockedAiFetch(capturedRequests, content = "DIGEST-TEXT") {
  return async (_url, options) => {
    capturedRequests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
}

test("background Session Digest calls the AI Provider with the full Transcript", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({ fetchImpl: mockedAiFetch(requests) });
  const state = endedSession({
    records: [
      { text: "opening part", start: 0, duration: 60 },
      { text: "closing part", start: 60, duration: 60 },
    ],
  });

  const digest = await helpers.generateSessionDigest(state);

  assert.equal(digest.text, "DIGEST-TEXT");
  assert.equal(requests.length, 1);
  // One global pass over everything the Session captured (ADR 0002).
  assert.match(requests[0].messages[1].content, /\[0:00\] opening part/);
  assert.match(requests[0].messages[1].content, /\[1:00\] closing part/);
});

test("background Session Digest is skipped when the Session has no Transcript", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({ fetchImpl: mockedAiFetch(requests) });
  let state = pipeline.createSession({ sessionId: "s_empty" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, { type: "transcribeFailed", segmentId: "seg-0" });
  state = pipeline.applyEvent(state, { type: "sessionEnd" });

  const digest = await helpers.generateSessionDigest(state);

  assert.equal(digest.text, null);
  assert.equal(digest.skipped, "noTranscript");
  assert.equal(requests.length, 0);
});
