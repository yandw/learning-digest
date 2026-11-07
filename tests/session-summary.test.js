const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const summary = require("../session-summary.js");
const pipeline = require("../session-pipeline.js");

// The runtime templates (#33) live in prompts/*.md; the background layer
// loads their sections through loadPromptSection and injects them into the
// pure builders. These tests load them the same way (## heading -> fenced
// block), so the contract markers asserted below are the shipped copy.
function promptSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker) + marker.length;
  const next = markdown.indexOf("\n## ", start);
  const section = markdown.slice(start, next === -1 ? markdown.length : next);
  return section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/)[1];
}

const promptsDir = path.join(__dirname, "..", "prompts");
const topicTickMarkdown = fs.readFileSync(path.join(promptsDir, "topic-tick.md"), "utf8");
const sessionReportMarkdown = fs.readFileSync(path.join(promptsDir, "session-report.md"), "utf8");

const TICK_TEMPLATE = {
  systemPrompt: promptSection(topicTickMarkdown, "System prompt"),
  userPrompt: promptSection(topicTickMarkdown, "User prompt"),
  firstBatchUserPrompt: promptSection(topicTickMarkdown, "First batch user prompt"),
};

const REPORT_TEMPLATE = {
  systemPrompt: promptSection(sessionReportMarkdown, "System prompt"),
  userPrompt: promptSection(sessionReportMarkdown, "User prompt"),
  userPromptWithoutTopics: promptSection(sessionReportMarkdown, "User prompt without topics"),
};

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

// --- Tick input assembly: new Transcript + overlap tail + existing titles

test("with no Topics, every Transcript record is new input and the overlap tail is empty", () => {
  const state = activeSessionWithRecords([
    { text: "first", start: 0, duration: 60 },
    { text: "second", start: 60, duration: 60 },
  ]);

  const input = summary.assembleTopicTickInput(state);

  assert.equal(input.cursor, 0);
  assert.deepEqual(
    input.newTranscript.map((r) => r.text),
    ["first", "second"],
  );
  assert.deepEqual(input.overlapTail, []);
  assert.deepEqual(input.existingTopicTitles, []);
});

test("tick input keeps records at or after the Topic cursor and adds a 2-minute context tail", () => {
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

  const input = summary.assembleTopicTickInput(state);

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

  const input = summary.assembleTopicTickInput(state);

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

  const input = summary.assembleTopicTickInput(state);

  assert.deepEqual(input.existingTopicTitles, ["导论", "二次函数"]);
});

test("failure-marker records inside the new window stay in the tick input", () => {
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

  const input = summary.assembleTopicTickInput(state);

  assert.equal(input.newTranscript.length, 2);
  assert.equal(input.newTranscript[0].failed, true);
  assert.equal(input.newTranscript[1].text, "after the gap");
});

// --- Topic tick prompt: the JSON Topic contract in Chinese

test("the Topic prompt demands a JSON array of Topics with seconds and a continuation flag", () => {
  const messages = summary.buildTopicTickMessages(TICK_TEMPLATE, {
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
  const messages = summary.buildTopicTickMessages(TICK_TEMPLATE, {
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
  const messages = summary.buildTopicTickMessages(TICK_TEMPLATE, {
    existingTopicTitles: ["导论", "二次函数"],
    contextTranscriptText: "[14:30] 承接上文",
    newTranscriptText: "[15:00] 继续讲解二次函数",
  });

  assert.match(messages[1].content, /二次函数/);
  assert.match(messages[1].content, /导论/);
});

test("the first Topic tick states there are no previous Topics", () => {
  const messages = summary.buildTopicTickMessages(TICK_TEMPLATE, {
    existingTopicTitles: [],
    contextTranscriptText: "",
    newTranscriptText: "[0:00] 课程开场",
  });

  assert.match(messages[1].content, /没有已有话题/);
});

// --- Template injection: the builders fill placeholders, nothing more (#33)

// A small synthetic template, independent of the shipped prompt copy: it
// pins the injection mechanics (branch selection, variable landing, byte
// structure) without restating the real templates.
const INLINE_TICK_TEMPLATE = {
  systemPrompt: "系统提示词",
  userPrompt:
    "已有：- {existingTopicTitlesLines}；上一个：「{lastTopicTitle}」；回顾：{contextTranscriptText}；新稿：{newTranscriptText}",
  firstBatchUserPrompt: "第一批；回顾：{contextTranscriptText}；新稿：{newTranscriptText}",
};

test("the Topic builder fills the injected template's placeholders with the tick input", () => {
  const messages = summary.buildTopicTickMessages(INLINE_TICK_TEMPLATE, {
    existingTopicTitles: ["导论", "二次函数"],
    contextTranscriptText: "[9:50] 回顾",
    newTranscriptText: "[10:00] 新的内容",
  });

  assert.equal(messages[0].content, "系统提示词");
  assert.match(messages[1].content, /^已有：- 导论\n- 二次函数；/);
  assert.match(messages[1].content, /上一个：「二次函数」；/);
  assert.match(messages[1].content, /回顾：\[9:50\] 回顾；/);
  assert.match(messages[1].content, /新稿：\[10:00\] 新的内容$/);
});

test("the Topic builder picks the first-batch template when no Topics exist", () => {
  const messages = summary.buildTopicTickMessages(INLINE_TICK_TEMPLATE, {
    existingTopicTitles: [],
    contextTranscriptText: "（无）",
    newTranscriptText: "[0:00] 开场",
  });

  assert.equal(messages[1].content, "第一批；回顾：（无）；新稿：[0:00] 开场");
});

test("an empty context falls back to （无） in the injected template", () => {
  const messages = summary.buildTopicTickMessages(INLINE_TICK_TEMPLATE, {
    existingTopicTitles: [],
    contextTranscriptText: "",
    newTranscriptText: "[0:00] 开场",
  });

  assert.equal(messages[1].content, "第一批；回顾：（无）；新稿：[0:00] 开场");
});

test("placeholders without a matching variable stay untouched in the filled prompt", () => {
  const messages = summary.buildTopicTickMessages(
    { ...INLINE_TICK_TEMPLATE, userPrompt: "未知 {unknownPlaceholder} 新稿：{newTranscriptText}" },
    { existingTopicTitles: ["导论"], contextTranscriptText: "", newTranscriptText: "X" },
  );

  assert.equal(messages[1].content, "未知 {unknownPlaceholder} 新稿：X");
});

test("fillPromptTemplate substitutes the given {key} placeholders and nothing else", () => {
  assert.equal(
    summary.fillPromptTemplate("A={a} B={b} C={c}", { a: 1, b: null }),
    "A=1 B= C={c}",
  );
  assert.equal(summary.fillPromptTemplate("no variables", {}), "no variables");
  assert.equal(summary.fillPromptTemplate(undefined, { a: 1 }), "");
});

// --- Tolerant parser: model output -> Topic list (never throws)

const GOOD_TOPIC_LINE =
  '[{"start": 0, "end": 900, "title": "导论", "text": "老师介绍了课程目标。"}]';

test("the parser maps a plain JSON array to Topics", () => {
  assert.deepEqual(summary.parseTopicTick(GOOD_TOPIC_LINE), [
    { start: 0, end: 900, title: "导论", text: "老师介绍了课程目标。" },
  ]);
});

test("the parser keeps an explicit continuation flag and drops it otherwise", () => {
  const topics = summary.parseTopicTick(
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
    summary.parseTopicTick(`好的，以下是话题段：\n\`\`\`json\n${GOOD_TOPIC_LINE}\n\`\`\`\n请查收。`),
    [{ start: 0, end: 900, title: "导论", text: "老师介绍了课程目标。" }],
  );
});

test("the parser repairs the trailing-comma LLM slip", () => {
  assert.deepEqual(
    summary.parseTopicTick(
      '[{"start": 0, "end": 90, "title": "开场", "text": "第一句。",},]',
    ),
    [{ start: 0, end: 90, title: "开场", text: "第一句。" }],
  );
});

test("the parser accepts an object wrapping a topics array", () => {
  assert.deepEqual(
    summary.parseTopicTick('{"topics": [{"start": 0, "end": 90, "title": "开场", "text": "第一句。"}]}'),
    [{ start: 0, end: 90, title: "开场", text: "第一句。" }],
  );
});

test("malformed model output parses to an empty list", () => {
  assert.deepEqual(summary.parseTopicTick("这一段没有可总结的话题。"), []);
  assert.deepEqual(summary.parseTopicTick('{"chapters": []}'), []);
  assert.deepEqual(summary.parseTopicTick("[{"), []);
  assert.deepEqual(summary.parseTopicTick(""), []);
});

test("the parser drops entries that are not valid Topics and keeps the valid ones", () => {
  const topics = summary.parseTopicTick(
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
  const topics = summary.parseTopicTick(
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

// --- End-of-session global pass (#29, ADR 0002): input, prompt, parser

test("global pass input assembles the full Transcript and the live Topic timeline", () => {
  const state = activeSessionWithRecords(
    [
      { text: "opening", start: 0, duration: 60 },
      { text: "closing", start: 60, duration: 60 },
    ],
    [
      { start: 0, end: 60, title: "导论", text: "开场总结。" },
      { start: 60, end: 120, title: "导论", text: "延续总结。", continuation: true },
    ],
  );

  const input = summary.assembleGlobalPassInput(state);

  assert.deepEqual(
    input.transcriptRecords.map((record) => record.text),
    ["opening", "closing"],
  );
  // The live timeline rides along as a merge hint: ranges and titles only.
  assert.deepEqual(input.liveTopics, [
    { start: 0, end: 60, title: "导论" },
    { start: 60, end: 120, title: "导论" },
  ]);
});

test("global pass input tolerates Sessions without records or Topics", () => {
  const input = summary.assembleGlobalPassInput({ sessionId: "s_empty" });
  assert.deepEqual(input.transcriptRecords, []);
  assert.deepEqual(input.liveTopics, []);
});

test("the global pass prompt demands one JSON object with topics, quotes and todos", () => {
  const messages = summary.buildGlobalPassMessages(REPORT_TEMPLATE, {
    transcriptText: "[0:00] 课程开场\n[1:00] 正式内容",
    liveTopics: [{ start: 0, end: 30, title: "导论" }],
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.match(messages[0].content, /JSON/);
  assert.match(messages[0].content, /topics/);
  assert.match(messages[0].content, /quotes/);
  assert.match(messages[0].content, /todos/);
  assert.match(messages[0].content, /summary/);
  assert.match(messages[0].content, /秒/);
});

test("the global pass prompt orders continuation sections merged into whole Topics", () => {
  const messages = summary.buildGlobalPassMessages(REPORT_TEMPLATE, {
    transcriptText: "[0:00] 课程开场",
    liveTopics: [],
  });

  assert.match(messages[0].content, /合并/);
  assert.match(messages[0].content, /延续/);
});

test("the global pass prompt instructs the model to stitch recording-cut artifacts", () => {
  const messages = summary.buildGlobalPassMessages(REPORT_TEMPLATE, {
    transcriptText: "",
    liveTopics: [],
  });

  assert.match(messages[0].content, /截断|切片/);
});

test("the global pass prompt keeps todos conditional on real action items", () => {
  const messages = summary.buildGlobalPassMessages(REPORT_TEMPLATE, {
    transcriptText: "",
    liveTopics: [],
  });

  assert.match(messages[0].content, /行动项/);
  assert.match(messages[0].content, /空数组/);
});

test("the global pass user message carries the full Transcript and the live Topic hint", () => {
  const messages = summary.buildGlobalPassMessages(REPORT_TEMPLATE, {
    transcriptText: "[0:00] 课程开场\n[61:01] 收尾",
    liveTopics: [
      { start: 0, end: 60, title: "导论" },
      { start: 60, end: 120, title: "二次函数" },
    ],
  });

  assert.match(messages[1].content, /课中已识别的话题段/);
  assert.match(messages[1].content, /导论/);
  assert.match(messages[1].content, /\[0:00\] 课程开场/);
  assert.match(messages[1].content, /\[61:01\] 收尾/);
});

test("the global pass user message omits the Topic hint when the timeline is empty", () => {
  const messages = summary.buildGlobalPassMessages(REPORT_TEMPLATE, {
    transcriptText: "[0:00] 课程开场",
    liveTopics: [],
  });

  assert.doesNotMatch(messages[1].content, /课中已识别的话题段/);
});

// Synthetic template for the injection mechanics, as with the Topic builder.
const INLINE_REPORT_TEMPLATE = {
  systemPrompt: "纪要系统提示词",
  userPrompt: "话题：- {liveTopicsLines}\n\n逐字稿：{transcriptText}",
  userPromptWithoutTopics: "仅逐字稿：{transcriptText}",
};

test("the global pass builder fills the live Topics hint and the full Transcript", () => {
  const messages = summary.buildGlobalPassMessages(INLINE_REPORT_TEMPLATE, {
    transcriptText: "[0:00] 开场",
    liveTopics: [
      { start: 0, end: 60, title: "导论" },
      { start: 60, end: 120, title: "二次函数" },
    ],
  });

  assert.equal(messages[0].content, "纪要系统提示词");
  assert.equal(
    messages[1].content,
    "话题：- [0:00–1:00] 导论\n- [1:00–2:00] 二次函数\n\n逐字稿：[0:00] 开场",
  );
});

test("the global pass builder picks the no-topics template on an empty timeline", () => {
  const messages = summary.buildGlobalPassMessages(INLINE_REPORT_TEMPLATE, {
    transcriptText: "[0:00] 开场",
    liveTopics: [],
  });

  assert.equal(messages[1].content, "仅逐字稿：[0:00] 开场");
});

test("an empty Transcript falls back to （无） in the injected template", () => {
  const messages = summary.buildGlobalPassMessages(INLINE_REPORT_TEMPLATE, {
    transcriptText: "",
    liveTopics: [],
  });

  assert.equal(messages[1].content, "仅逐字稿：（无）");
});

const GOOD_REPORT = JSON.stringify({
  topics: [{ start: 0, end: 900, title: "导论", summary: "老师介绍了课程目标。" }],
  quotes: [{ start: 120, text: "学习是一场旅程。" }],
  todos: ["完成课后练习"],
});

test("the global pass parser maps a valid JSON object to the report shape", () => {
  assert.deepEqual(summary.parseGlobalPass(GOOD_REPORT), {
    topics: [{ start: 0, end: 900, title: "导论", summary: "老师介绍了课程目标。" }],
    quotes: [{ start: 120, text: "学习是一场旅程。" }],
    todos: ["完成课后练习"],
  });
});

test("the global pass parser tolerates prose or code fences around the JSON", () => {
  assert.deepEqual(
    summary.parseGlobalPass(`好的，以下是纪要：\n\`\`\`json\n${GOOD_REPORT}\n\`\`\`\n请查收。`),
    {
      topics: [{ start: 0, end: 900, title: "导论", summary: "老师介绍了课程目标。" }],
      quotes: [{ start: 120, text: "学习是一场旅程。" }],
      todos: ["完成课后练习"],
    },
  );
});

test("the global pass parser returns null on malformed output", () => {
  assert.equal(summary.parseGlobalPass("这段没有可整理的内容。"), null);
  assert.equal(summary.parseGlobalPass('[{"start": 0}]'), null);
  assert.equal(summary.parseGlobalPass("[{"), null);
  assert.equal(summary.parseGlobalPass(""), null);
});

test("the global pass parser drops malformed entries and clamps numbers", () => {
  const report = summary.parseGlobalPass(
    JSON.stringify({
      topics: [
        { start: 0, end: 90, title: " 开场 ", summary: " 第一段。 " },
        { start: 90, end: 60, title: "倒置", summary: "end 在 start 之前。" },
        { start: "零", end: 200, title: "非数字", summary: "start 不是数字。" },
        { start: 200, end: 300, title: "", summary: "标题为空。" },
        { start: 300, end: 400, title: "无总结" },
      ],
      quotes: [
        { start: 30.7, text: " 原话一 " },
        { start: "早", text: "非数字时间戳。" },
        { text: "缺时间戳。" },
      ],
      todos: [" 完成练习 ", "", 42, null],
    }),
  );

  assert.deepEqual(report.topics, [
    { start: 0, end: 90, title: "开场", summary: "第一段。" },
  ]);
  assert.deepEqual(report.quotes, [{ start: 30, text: "原话一" }]);
  assert.deepEqual(report.todos, ["完成练习"]);
});

test("the global pass parser accepts missing quotes and todos as empty lists", () => {
  assert.deepEqual(
    summary.parseGlobalPass(
      '{"topics": [{"start": 0, "end": 90, "title": "开场", "summary": "第一段。"}]}',
    ),
    {
      topics: [{ start: 0, end: 90, title: "开场", summary: "第一段。" }],
      quotes: [],
      todos: [],
    },
  );
});


// Background glue for the end-of-session global pass, exercised through the
// same VM seam translation.test.js uses for requestAiCompletion, with fetch
// mocked at the boundary and the real state machine + assembly module
// injected.
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

function mockedAiFetch(capturedRequests, content = "{}", finishReason = "stop") {
  return async (_url, options) => {
    capturedRequests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content }, finish_reason: finishReason }],
      }),
    };
  };
}

const REPORT_JSON = JSON.stringify({
  topics: [{ start: 0, end: 120, title: "导论", summary: "老师介绍了课程目标。" }],
  quotes: [{ start: 30, text: "学习是一场旅程。" }],
  todos: ["完成课后练习"],
});

test("background global pass calls the AI Provider once with the full Transcript and parses the report", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: mockedAiFetch(requests, REPORT_JSON),
  });
  const state = endedSession({
    records: [
      { text: "opening part", start: 0, duration: 60 },
      { text: "closing part", start: 60, duration: 60 },
    ],
  });

  const outcome = await helpers.generateSessionReport(state);

  assert.equal(requests.length, 1, "one global pass, no Rolling Summary input");
  // One global pass over everything the Session captured (ADR 0002).
  assert.match(requests[0].messages[1].content, /\[0:00\] opening part/);
  assert.match(requests[0].messages[1].content, /\[1:00\] closing part/);
  assert.deepEqual(outcome.report, {
    topics: [{ start: 0, end: 120, title: "导论", summary: "老师介绍了课程目标。" }],
    quotes: [{ start: 30, text: "学习是一场旅程。" }],
    todos: ["完成课后练习"],
  });
});

test("background global pass flags a truncated response instead of parsing a broken artifact", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: mockedAiFetch(requests, '{"topics": [', "length"),
  });
  const state = endedSession({
    records: [{ text: "opening part", start: 0, duration: 60 }],
  });

  const outcome = await helpers.generateSessionReport(state);

  assert.equal(outcome.report, null);
  assert.equal(outcome.truncated, true);
});

test("background global pass flags unparseable output as a retryable failure", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: mockedAiFetch(requests, "这段没有可整理的内容。"),
  });
  const state = endedSession({
    records: [{ text: "opening part", start: 0, duration: 60 }],
  });

  const outcome = await helpers.generateSessionReport(state);

  assert.equal(outcome.report, null);
  assert.equal(outcome.truncated, true);
});

test("background global pass is skipped when the Session has no Transcript", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({ fetchImpl: mockedAiFetch(requests) });
  let state = pipeline.createSession({ sessionId: "s_empty" });
  state = pipeline.applyEvent(state, {
    type: "segmentCaptured",
    segment: { id: "seg-0", start: 0, duration: 120 },
  });
  state = pipeline.applyEvent(state, { type: "transcribeFailed", segmentId: "seg-0" });
  state = pipeline.applyEvent(state, { type: "sessionEnd" });

  const outcome = await helpers.generateSessionReport(state);

  assert.equal(outcome.report, null);
  assert.equal(outcome.skipped, "noTranscript");
  assert.equal(requests.length, 0);
});
