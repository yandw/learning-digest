const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.js"),
  "utf8",
);

test("the selection toolbar preserves selection and contains pointer events", () => {
  // The toolbar serves both transcript surfaces (legacy rows and session
  // records); the end-to-end behavior lives in tests/panel-ia.test.js.
  assert.match(
    source,
    /function setupExplainFeature\(\) \{[\s\S]*?getElementById\("transcriptList"\);[\s\S]*?getElementById\("sessionTranscript"\);/,
    "the selection wiring covers both transcript surfaces",
  );
  assert.match(
    source,
    /closest\(\s*"\.transcript-entry, \.session-record",?\s*\)/,
    "a selection's timestamp comes from either row shape",
  );
  assert.match(
    source,
    /className = "explain-btn";[\s\S]*?textContent = "解释";[\s\S]*?className = "selection-note-btn";[\s\S]*?textContent = "笔记";/,
  );
  assert.match(
    source,
    /tooltip\.addEventListener\("mousedown", \(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /tooltip\.addEventListener\("mouseup", \(event\) => \{\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /noteButton\.addEventListener\("click", async \(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /action: "saveNote"[\s\S]*?videoId: target\.videoId[\s\S]*?timestamp: selectedTimestamp[\s\S]*?selectedText,/,
    "the note save targets the resolved video or session id",
  );
  assert.match(
    source,
    /tooltip\.style\.top =[\s\S]*tooltip\.style\.left =[\s\S]*tooltip\.style\.display = "flex"/,
    "the toolbar must be positioned before it becomes visible",
  );
});

test("leaving Transcript dismisses its selection actions", () => {
  assert.match(
    source,
    /if \(tabName !== "transcript" && transcriptTabIsActive\(\)\) \{\s*captureCurrentTranscriptScrollTop\(\);\s*dismissSelectionActions\(true\);/,
  );
  assert.match(
    source,
    /function dismissSelectionActions\(clearSelection = false\)[\s\S]*tooltip\.style\.display = "none"[\s\S]*window\.getSelection\(\)\?\.removeAllRanges\(\)/,
  );
});

test("Notes opens at its newest item and Transcript keeps its position", () => {
  assert.match(
    source,
    /if \(tabName === "notes"\)[\s\S]*notesPanelIsActive[\s\S]*contentArea\.scrollTop = 0/,
  );
  assert.match(
    source,
    /if \(tabName === "transcript"\)[\s\S]*contentArea\.scrollTop = lastTranscriptScrollTop/,
  );
});

test("the transcript view restores its saved reading position", () => {
  assert.match(
    source,
    /pendingTranscriptViewState = await loadTranscriptViewState\(videoId\)/,
  );
  assert.match(
    source,
    /function restorePendingTranscriptViewState\(videoId\)[\s\S]*contentArea\.scrollTop = state\.scrollTop;[\s\S]*lastTranscriptScrollTop = state\.scrollTop;/,
  );
  assert.match(
    source,
    /function scheduleTranscriptViewStateSave\(\)[\s\S]*!transcriptTabIsActive\(\)[\s\S]*return;/,
  );
  assert.match(
    source,
    /tabName !== "transcript" && transcriptTabIsActive\(\)[\s\S]*captureCurrentTranscriptScrollTop\(\)/,
  );
});
