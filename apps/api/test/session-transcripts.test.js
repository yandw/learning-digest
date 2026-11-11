/**
 * Captions direct archive + transcript view (Ticket 2.2, issue #65;
 * contract-r2.md §3.3, §2.5; decisions D15).
 *
 * Seam: the /v1 HTTP endpoints against the round-2 fixtures, plus the
 * lib/transcripts.js write seam that ticket 2.3's audio/worker endpoints
 * will call (claimAudioOrigin) — the HTTP audio-segments endpoint itself is
 * 2.3's ticket, so its side of the D15 origin lock is exercised at lib
 * level here until that ticket lands its routes.
 *
 * D15 semantics pinned here: captions archive as-read (no server-side gap
 * inference), first submission locks origin "captions", a resend answers
 * 200 with the stored content (首存为准, never overwritten or appended),
 * the reverse submission after an asr lock is 409 transcript_origin_conflict
 * (both directions), and a finished session accepts no captions at all.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp } = require("./helpers/harness");
const { seedFileWith, openAccount } = require("./helpers/accounts");
const {
  claimAudioOrigin,
  upsertAudioSegment,
  applySegmentTranscribing,
  applySegmentDone,
  applySegmentFailed,
} = require("../lib/transcripts");

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "contracts", "fixtures");
const sessionExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "session-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);
const errorExampleById = new Map(
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "error-examples.json"), "utf8"))
    .samples.map((s) => [s.id, s]),
);

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function createFixtureSource(app, token) {
  const created = await app.request("POST", "/v1/resources", {
    headers: authHeader(token),
    body: {
      url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
      title: "注意力机制详解 P2：自注意力",
    },
  });
  assert.equal(created.status, 201);
  return created.json;
}

/** Open a session on the fixture source (default fixture start 08:00Z). */
async function openSession(app, token, sourceId, clock) {
  if (clock) {
    clock.ms = Date.parse("2026-11-10T08:00:00Z");
  }
  const created = await app.request("POST", `/v1/sources/${sourceId}/sessions`, {
    headers: authHeader(token),
    body: {},
  });
  assert.equal(created.status, 201);
  return created.json.session;
}

test("POST /v1/sessions/{id}/captions archives as-read and locks origin (api-session-captions-archive)", async () => {
  const example = sessionExampleById.get("api-session-captions-archive");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, clock);

    const response = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, {
      transcript: {
        ...example.response.body.transcript,
        sessionId: session.id,
        sourceId: source.id,
        resourceId: resource.id,
      },
    });

    // The first archive locked the session's path (D15): the Session now
    // reports origin "captions".
    assert.equal(response.json.transcript.origin, "captions");
    const me = await app.request("GET", "/v1/me", { headers: authHeader(token) });
    assert.equal(me.status, 200);
  } finally {
    await app.close();
  }
});

test("a captions resend answers 200 with the stored archive (api-session-captions-resend-idempotent)", async () => {
  const archive = sessionExampleById.get("api-session-captions-archive");
  const resend = sessionExampleById.get("api-session-captions-resend-idempotent");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, clock);

    const first = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: archive.request.body,
    });
    assert.equal(first.status, 201);

    // The byte-identical resend (network drop retry) answers 200 with the
    // same archived transcript.
    const again = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: resend.request.body,
    });
    assert.equal(again.status, resend.response.status);
    assert.deepEqual(again.json, {
      transcript: {
        ...resend.response.body.transcript,
        sessionId: session.id,
        sourceId: source.id,
        resourceId: resource.id,
      },
    });

    // 首存为准: even a resend with DIFFERENT segments answers with the
    // stored archive — never overwritten, never appended.
    const different = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: {
        segments: [{ startMs: 0, endMs: 1000, text: "不应落库的字幕" }],
      },
    });
    assert.equal(different.status, 200);
    assert.deepEqual(
      different.json.transcript.records,
      first.json.transcript.records,
      "the first submission stays the archive",
    );
    assert.equal(different.json.transcript.records.length, 2);
  } finally {
    await app.close();
  }
});

test("captions on an asr-locked session is 409 transcript_origin_conflict (error-transcript-origin-conflict)", async () => {
  const example = errorExampleById.get("error-transcript-origin-conflict");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, null);

    // The fixture precondition (ses_0033 already locked asr by its audio
    // segments) via the ticket-2.3 write seam.
    claimAudioOrigin({ store: app.store, session: app.store.get("sessions", session.id) });
    assert.equal(app.store.get("sessions", session.id).origin, "asr");

    const response = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: example.request.body,
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, example.response.body);

    // The rejected captions did not touch the archive: the session's origin
    // stays asr and no transcript document appeared.
    assert.equal(app.store.get("sessions", session.id).origin, "asr");
  } finally {
    await app.close();
  }
});

test("the reverse D15 direction — claiming asr on a captions-locked session — is the same 409", async () => {
  const conflict = errorExampleById.get("error-transcript-origin-conflict");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, null);

    const archived = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: sessionExampleById.get("api-session-captions-archive").request.body,
    });
    assert.equal(archived.status, 201);

    // Ticket 2.3's first audio segment calls claimAudioOrigin; on a
    // captions-locked session that is the same 409 code (mirror message).
    assert.throws(
      () => claimAudioOrigin({ store: app.store, session: app.store.get("sessions", session.id) }),
      (error) =>
        error.status === conflict.response.status &&
        error.code === "transcript_origin_conflict",
    );
  } finally {
    await app.close();
  }
});

test("captions on a finished session is 409 session_already_finished", async () => {
  const alreadyFinished = errorExampleById.get("error-session-finish-already-finished");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, clock);

    const finished = await app.request("POST", `/v1/sessions/${session.id}/finish`, {
      headers: authHeader(token),
      body: {},
    });
    assert.equal(finished.status, 200);

    // 已结束不再接收 (§3.3): even a resend of valid segments is the 409.
    const response = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: sessionExampleById.get("api-session-captions-archive").request.body,
    });
    assert.equal(response.status, alreadyFinished.response.status);
    assert.deepEqual(response.json, alreadyFinished.response.body);
  } finally {
    await app.close();
  }
});

test("invalid caption segments are validation_failed 400s", async () => {
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, null);
    const post = (body) =>
      app.request("POST", `/v1/sessions/${session.id}/captions`, {
        headers: authHeader(token),
        body,
      });

    const cases = [
      ["missing segments", {}],
      ["segments not an array", { segments: { startMs: 0 } }],
      ["segment item not an object", { segments: [138000] }],
      ["missing startMs", { segments: [{ endMs: 159000, text: "x" }] }],
      ["missing endMs", { segments: [{ startMs: 138000, text: "x" }] }],
      ["missing text", { segments: [{ startMs: 138000, endMs: 159000 }] }],
      ["empty text", { segments: [{ startMs: 138000, endMs: 159000, text: "" }] }],
      ["non-string text", { segments: [{ startMs: 138000, endMs: 159000, text: 3 }] }],
      ["negative startMs", { segments: [{ startMs: -1, endMs: 159000, text: "x" }] }],
      ["endMs below startMs", { segments: [{ startMs: 159000, endMs: 138000, text: "x" }] }],
    ];
    for (const [label, body] of cases) {
      const response = await post(body);
      assert.equal(response.status, 400, label);
      assert.equal(response.json.error.code, "validation_failed", label);
    }

    // §2.2 records: endMs >= startMs — an exactly-zero-length caption
    // segment is legal per the contract, on a fresh session.
    const second = await openSession(app, token, source.id, null);
    const zeroLength = await app.request("POST", `/v1/sessions/${second.id}/captions`, {
      headers: authHeader(token),
      body: { segments: [{ startMs: 138000, endMs: 138000, text: "零长段合法" }] },
    });
    assert.equal(zeroLength.status, 201);

    // A rejected first archive must not have locked the origin: an empty
    // segments array is still a legal first submission (原样归档) and
    // answers 201 with zero records.
    const third = await openSession(app, token, source.id, null);
    const emptyFirst = await app.request("POST", `/v1/sessions/${third.id}/captions`, {
      headers: authHeader(token),
      body: { segments: [] },
    });
    assert.equal(emptyFirst.status, 201);
    assert.deepEqual(emptyFirst.json.transcript.records, []);
    assert.equal(emptyFirst.json.transcript.origin, "captions");
  } finally {
    await app.close();
  }
});

test("captions on another account's session is the 404 (D2), and 401 without credentials", async () => {
  const crossTranscript = errorExampleById.get("error-cross-account-session-transcript");
  const unauthorized = errorExampleById.get("error-session-create-unauthorized");
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const { source } = await createFixtureSource(app, owner);
    const session = await openSession(app, owner, source.id, null);

    const cross = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(other),
      body: sessionExampleById.get("api-session-captions-archive").request.body,
    });
    assert.equal(cross.status, crossTranscript.response.status);
    assert.deepEqual(cross.json, crossTranscript.response.body);

    const unknown = await app.request("POST", "/v1/sessions/ses_missing/captions", {
      headers: authHeader(other),
      body: { segments: [] },
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, crossTranscript.response.body);

    const noAuth = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      body: { segments: [] },
    });
    assert.equal(noAuth.status, unauthorized.response.status);
    assert.deepEqual(noAuth.json, unauthorized.response.body);
  } finally {
    await app.close();
  }
});

// --- GET /v1/sessions/{id}/transcript (contract-r2 §3.5) ----------------------

/**
 * The asr-path fixture precondition (audio segments + worker results on
 * ses_0033/0032) through ticket 2.3's write seam, seeded from the fixture
 * sample's own values — the same seeding discipline as the P4 tests. Every
 * assertion below still goes through HTTP.
 */
function seedAsrTranscript(store, session, view) {
  claimAudioOrigin({ store, session });
  const projections = [...view.failed, ...view.pending];
  const claimed = new Set(projections.map((p) => p.segmentIndex));
  // Done segments take the lowest indexes the failed/pending projections
  // do not claim: a done segment's index is not observable in the view
  // (only failed[] and pending[] carry one), so any unclaimed index yields
  // the same TranscriptView.
  let nextDoneIndex = 0;
  const nextDoneSegmentIndex = () => {
    while (claimed.has(nextDoneIndex)) {
      nextDoneIndex += 1;
    }
    return nextDoneIndex++;
  };
  for (const record of view.records) {
    const segmentIndex = nextDoneSegmentIndex();
    upsertAudioSegment({
      store,
      sessionId: session.id,
      segment: {
        segmentIndex,
        startMs: record.startMs,
        endMs: record.endMs,
        audioMimeType: "audio/webm;codecs=opus",
      },
    });
    applySegmentDone({ store, sessionId: session.id, segmentIndex, records: [record] });
  }
  for (const failed of view.failed) {
    upsertAudioSegment({
      store,
      sessionId: session.id,
      segment: {
        segmentIndex: failed.segmentIndex,
        startMs: failed.startMs,
        endMs: failed.endMs,
        audioMimeType: "audio/webm;codecs=opus",
      },
    });
    applySegmentFailed({
      store,
      sessionId: session.id,
      segmentIndex: failed.segmentIndex,
      error: failed.error,
    });
  }
  for (const pending of view.pending) {
    upsertAudioSegment({
      store,
      sessionId: session.id,
      segment: {
        segmentIndex: pending.segmentIndex,
        startMs: pending.startMs,
        endMs: pending.endMs,
        audioMimeType: "audio/webm;codecs=opus",
      },
    });
    applySegmentTranscribing({ store, sessionId: session.id, segmentIndex: pending.segmentIndex });
  }
}

test("GET /v1/sessions/{id}/transcript — captions path, finished (api-session-transcript-captions-finished)", async () => {
  const archive = sessionExampleById.get("api-session-captions-archive");
  const example = sessionExampleById.get("api-session-transcript-captions-finished");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, clock);

    const archived = await app.request("POST", `/v1/sessions/${session.id}/captions`, {
      headers: authHeader(token),
      body: archive.request.body,
    });
    assert.equal(archived.status, 201);

    // The fixture session closes at 08:45 with the explicit skip range
    // 300000-360000; the caption hole (181000-300000) stays unmarked (D15).
    clock.ms = Date.parse("2026-11-10T08:45:00Z");
    const finished = await app.request("POST", `/v1/sessions/${session.id}/finish`, {
      headers: authHeader(token),
      body: {
        gaps: example.response.body.gaps.map(({ startMs, endMs }) => ({ startMs, endMs })),
      },
    });
    assert.equal(finished.status, 200);

    const response = await app.request("GET", `/v1/sessions/${session.id}/transcript`, {
      headers: authHeader(token),
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, {
      ...example.response.body,
      sessionId: session.id,
      sourceId: source.id,
      resourceId: resource.id,
    });
  } finally {
    await app.close();
  }
});

test("GET transcript — asr path, active with pending and failed (api-session-transcript-asr-active)", async () => {
  const example = sessionExampleById.get("api-session-transcript-asr-active");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, clock);

    // Fixture precondition via the 2.3 write seam (segments 0-3, two done,
    // one failed, one transcribing).
    seedAsrTranscript(app.store, app.store.get("sessions", session.id), example.response.body);

    const response = await app.request("GET", `/v1/sessions/${session.id}/transcript`, {
      headers: authHeader(token),
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, {
      ...example.response.body,
      sessionId: session.id,
      sourceId: source.id,
      resourceId: resource.id,
    });
  } finally {
    await app.close();
  }
});

test("GET transcript — asr path, finished with gap and failed terminal states (api-session-transcript-asr-finished)", async () => {
  const example = sessionExampleById.get("api-session-transcript-asr-finished");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);

    clock.ms = Date.parse("2026-11-10T09:00:00Z");
    const session = await openSession(app, token, source.id, null);
    seedAsrTranscript(app.store, app.store.get("sessions", session.id), example.response.body);

    clock.ms = Date.parse("2026-11-10T09:45:00Z");
    const finished = await app.request("POST", `/v1/sessions/${session.id}/finish`, {
      headers: authHeader(token),
      body: {
        gaps: example.response.body.gaps.map(({ startMs, endMs }) => ({ startMs, endMs })),
      },
    });
    assert.equal(finished.status, 200);
    // The asr lock from the seam is exactly the fixture's origin.
    assert.equal(finished.json.session.origin, "asr");

    const response = await app.request("GET", `/v1/sessions/${session.id}/transcript`, {
      headers: authHeader(token),
    });
    assert.equal(response.status, example.response.status);
    assert.deepEqual(response.json, {
      ...example.response.body,
      sessionId: session.id,
      sourceId: source.id,
      resourceId: resource.id,
    });
  } finally {
    await app.close();
  }
});

test("GET transcript of another account's session is the 404 (error-cross-account-session-transcript); 401 without credentials", async () => {
  const example = errorExampleById.get("error-cross-account-session-transcript");
  const unauthorized = errorExampleById.get("error-session-create-unauthorized");
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const { source } = await createFixtureSource(app, owner);
    const session = await openSession(app, owner, source.id, null);

    const cross = await app.request("GET", `/v1/sessions/${session.id}/transcript`, {
      headers: authHeader(other),
    });
    assert.equal(cross.status, example.response.status);
    assert.deepEqual(cross.json, example.response.body);

    const unknown = await app.request("GET", "/v1/sessions/ses_missing/transcript", {
      headers: authHeader(other),
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, example.response.body);

    const noAuth = await app.request("GET", `/v1/sessions/${session.id}/transcript`);
    assert.equal(noAuth.status, unauthorized.response.status);
    assert.deepEqual(noAuth.json, unauthorized.response.body);
  } finally {
    await app.close();
  }
});

test("transcript reads are idempotent and states are monotonic across polls (D12)", async () => {
  const example = sessionExampleById.get("api-session-transcript-asr-active");
  const app = await startApp({ seedFile: seedFileWith(["learner@example.com"]) });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { source } = await createFixtureSource(app, token);
    const session = await openSession(app, token, source.id, null);
    seedAsrTranscript(app.store, app.store.get("sessions", session.id), example.response.body);

    const get = () =>
      app.request("GET", `/v1/sessions/${session.id}/transcript`, { headers: authHeader(token) });

    const first = await get();
    assert.equal(first.status, 200);
    const second = await get();
    assert.deepEqual(second.json, first.json, "polling answers the same view");

    // done/failed are terminal: a repeated worker result must not revert
    // or duplicate anything.
    applySegmentDone({
      store: app.store,
      sessionId: session.id,
      segmentIndex: 0,
      records: [{ startMs: 0, endMs: 30000, text: "不应重复落库" }],
    });
    const after = await get();
    assert.deepEqual(after.json, first.json, "terminal states do not regress");
  } finally {
    await app.close();
  }
});

// --- GET /v1/resources/{id} sessions[] extension (contract-r2 §3.6) ----------

test("resource detail lists past sessions newest first with transcript summaries (api-resource-detail-with-sessions)", async () => {
  const captionsArchive = sessionExampleById.get("api-session-captions-archive");
  const captionsFinished = sessionExampleById.get("api-session-transcript-captions-finished");
  const asrFinished = sessionExampleById.get("api-session-transcript-asr-finished");
  const asrActive = sessionExampleById.get("api-session-transcript-asr-active");
  const example = sessionExampleById.get("api-resource-detail-with-sessions");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");

    // 08:00: the fixture Resource + Source, and ses_0031 (captions path).
    clock.ms = Date.parse("2026-11-10T08:00:00Z");
    const { resource, source } = await createFixtureSource(app, token);
    const ses31 = await openSession(app, token, source.id, null);
    const archived = await app.request("POST", `/v1/sessions/${ses31.id}/captions`, {
      headers: authHeader(token),
      body: captionsArchive.request.body,
    });
    assert.equal(archived.status, 201);

    // 08:30: the fixture note.
    clock.ms = Date.parse("2026-11-10T08:30:00Z");
    const note = await app.request("POST", `/v1/resources/${resource.id}/notes`, {
      headers: authHeader(token),
      body: {
        clientRequestId: "note-req-001",
        text: example.response.body.notes[0].text,
        sourceId: source.id,
        positionMs: example.response.body.notes[0].positionMs,
      },
    });
    assert.equal(note.status, 201);

    // 08:45: close ses_0031 with its explicit skip range.
    clock.ms = Date.parse("2026-11-10T08:45:00Z");
    const finish31 = await app.request("POST", `/v1/sessions/${ses31.id}/finish`, {
      headers: authHeader(token),
      body: {
        gaps: captionsFinished.response.body.gaps.map(({ startMs, endMs }) => ({ startMs, endMs })),
      },
    });
    assert.equal(finish31.status, 200);

    // 09:00-09:45: ses_0032 (asr, finished with gap + failed terminal).
    clock.ms = Date.parse("2026-11-10T09:00:00Z");
    const ses32 = await openSession(app, token, source.id, null);
    seedAsrTranscript(app.store, app.store.get("sessions", ses32.id), asrFinished.response.body);
    clock.ms = Date.parse("2026-11-10T09:45:00Z");
    const finish32 = await app.request("POST", `/v1/sessions/${ses32.id}/finish`, {
      headers: authHeader(token),
      body: {
        gaps: asrFinished.response.body.gaps.map(({ startMs, endMs }) => ({ startMs, endMs })),
      },
    });
    assert.equal(finish32.status, 200);

    // 10:00: ses_0033 (asr, active, pending + failed).
    clock.ms = Date.parse("2026-11-10T10:00:00Z");
    const ses33 = await openSession(app, token, source.id, null);
    seedAsrTranscript(app.store, app.store.get("sessions", ses33.id), asrActive.response.body);

    // The fixture detail's progress chain end state (P4 seeding discipline).
    app.store.set("progress", source.id, { positionMs: 250000, revision: 2 });

    const response = await app.request("GET", `/v1/resources/${resource.id}`, {
      headers: authHeader(token),
    });
    assert.equal(response.status, example.response.status);

    // The round-1 three-key shape is unchanged; each key matches the
    // fixture values modulo the live ids.
    assert.deepEqual(response.json.resource, {
      ...example.response.body.resource,
      id: resource.id,
    });
    assert.equal(response.json.sources.length, 1);
    assert.deepEqual(response.json.sources[0], {
      ...example.response.body.sources[0],
      id: source.id,
      resourceId: resource.id,
      progress: { positionMs: 250000, revision: 2 },
    });
    assert.equal(response.json.notes.length, 1);
    assert.equal(response.json.notes[0].createdAt, example.response.body.notes[0].createdAt);
    assert.equal(response.json.notes[0].text, example.response.body.notes[0].text);
    assert.equal(response.json.notes[0].positionMs, example.response.body.notes[0].positionMs);

    // The extension: sessions[] newest first, each = Session + transcript
    // summary counts, fixture values verbatim modulo the live ids.
    const liveIds = new Map([
      [example.response.body.sessions[0].id, ses33.id],
      [example.response.body.sessions[1].id, ses32.id],
      [example.response.body.sessions[2].id, ses31.id],
    ]);
    assert.deepEqual(
      response.json.sessions,
      example.response.body.sessions.map((session) => ({
        ...session,
        id: liveIds.get(session.id),
        sourceId: source.id,
        resourceId: resource.id,
      })),
    );
  } finally {
    await app.close();
  }
});

test("a resource with no sessions answers the round-1 detail shape plus an empty sessions array", async () => {
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);

    const response = await app.request("GET", `/v1/resources/${resource.id}`, {
      headers: authHeader(token),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.resource, {
      id: resource.id,
      title: "注意力机制详解 P2：自注意力",
      kind: "video",
      createdAt: "1970-01-01T00:00:00Z",
    });
    assert.deepEqual(response.json.notes, []);
    assert.deepEqual(response.json.sessions, []);
  } finally {
    await app.close();
  }
});

// --- multi-Session / multi-account isolation (user story 20) -----------------

test("multiple sessions on one source do not bleed into each other", async () => {
  const captionsArchive = sessionExampleById.get("api-session-captions-archive");
  const captionsFinished = sessionExampleById.get("api-session-transcript-captions-finished");
  const clock = { ms: 0 };
  const app = await startApp({
    seedFile: seedFileWith(["learner@example.com"]),
    now: () => clock.ms,
  });
  try {
    const token = await openAccount(app, "learner@example.com");
    const { resource, source } = await createFixtureSource(app, token);

    // Session A (08:00) archives captions and finishes with a gap;
    // session B (09:00) never receives any transcript submission.
    clock.ms = Date.parse("2026-11-10T08:00:00Z");
    const sessionA = await openSession(app, token, source.id, null);
    const archived = await app.request("POST", `/v1/sessions/${sessionA.id}/captions`, {
      headers: authHeader(token),
      body: captionsArchive.request.body,
    });
    assert.equal(archived.status, 201);
    clock.ms = Date.parse("2026-11-10T08:45:00Z");
    const finishA = await app.request("POST", `/v1/sessions/${sessionA.id}/finish`, {
      headers: authHeader(token),
      body: {
        gaps: [{ startMs: 300000, endMs: 360000 }],
      },
    });
    assert.equal(finishA.status, 200);

    clock.ms = Date.parse("2026-11-10T09:00:00Z");
    const sessionB = await openSession(app, token, source.id, null);

    // B's transcript is its own empty view — none of A's records, gaps or
    // finished state leak into it.
    const transcriptB = await app.request("GET", `/v1/sessions/${sessionB.id}/transcript`, {
      headers: authHeader(token),
    });
    assert.equal(transcriptB.status, 200);
    assert.deepEqual(transcriptB.json, {
      sessionId: sessionB.id,
      sourceId: source.id,
      resourceId: resource.id,
      sessionStatus: "active",
      origin: null,
      records: [],
      gaps: [],
      pending: [],
      failed: [],
    });

    // A's transcript keeps its archive; the two views are independent.
    const transcriptA = await app.request("GET", `/v1/sessions/${sessionA.id}/transcript`, {
      headers: authHeader(token),
    });
    assert.deepEqual(transcriptA.json, {
      ...captionsFinished.response.body,
      sessionId: sessionA.id,
      sourceId: source.id,
      resourceId: resource.id,
    });

    // B was untouched by A's finish: it is still active and finishable.
    clock.ms = Date.parse("2026-11-10T09:30:00Z");
    const finishB = await app.request("POST", `/v1/sessions/${sessionB.id}/finish`, {
      headers: authHeader(token),
      body: {},
    });
    assert.equal(finishB.status, 200);
    assert.equal(finishB.json.session.status, "finished");

    // The resource detail lists both, newest first, with per-session
    // summaries that do not mix.
    const detail = await app.request("GET", `/v1/resources/${resource.id}`, {
      headers: authHeader(token),
    });
    assert.deepEqual(
      detail.json.sessions.map((s) => [s.id, s.status, s.transcript]),
      [
        [sessionB.id, "finished", { recordCount: 0, gapCount: 0, failedCount: 0 }],
        [sessionA.id, "finished", { recordCount: 2, gapCount: 1, failedCount: 0 }],
      ],
    );
  } finally {
    await app.close();
  }
});

test("two accounts studying their own sources keep fully separate session archives", async () => {
  const captionsArchive = sessionExampleById.get("api-session-captions-archive");
  const app = await startApp({
    seedFile: seedFileWith(["owner@example.com", "other@example.com"]),
  });
  try {
    const owner = await openAccount(app, "owner@example.com");
    const other = await openAccount(app, "other@example.com");
    const ownerFavorite = await createFixtureSource(app, owner);

    // The other account favorites the same address: a separate Source under
    // its own account (favorites are account-scoped, D2/D3/D5), and it runs
    // its own session on that Source.
    const otherFavorite = await app.request("POST", "/v1/resources", {
      headers: authHeader(other),
      body: {
        url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
        title: "注意力机制详解 P2：自注意力",
      },
    });
    assert.equal(otherFavorite.status, 201);
    const ownerSession = await openSession(app, owner, ownerFavorite.source.id, null);
    const otherSession = await openSession(app, other, otherFavorite.json.source.id, null);

    const ownerArchive = await app.request(
      "POST",
      `/v1/sessions/${ownerSession.id}/captions`,
      { headers: authHeader(owner), body: captionsArchive.request.body },
    );
    assert.equal(ownerArchive.status, 201);

    // The other account's transcript stays empty — its session, its source,
    // its account scope (D2).
    const otherTranscript = await app.request(
      "GET",
      `/v1/sessions/${otherSession.id}/transcript`,
      { headers: authHeader(other) },
    );
    assert.equal(otherTranscript.status, 200);
    assert.deepEqual(otherTranscript.json.records, []);
    assert.equal(otherTranscript.json.origin, null);
    assert.equal(otherTranscript.json.sourceId, otherFavorite.json.source.id);

    // And each account's resource detail lists only its own session.
    const ownerDetail = await app.request("GET", `/v1/resources/${ownerFavorite.resource.id}`, {
      headers: authHeader(owner),
    });
    assert.deepEqual(
      ownerDetail.json.sessions.map((s) => s.id),
      [ownerSession.id],
    );
    const otherDetail = await app.request(
      "GET",
      `/v1/resources/${otherFavorite.json.resource.id}`,
      { headers: authHeader(other) },
    );
    assert.deepEqual(
      otherDetail.json.sessions.map((s) => s.id),
      [otherSession.id],
    );
  } finally {
    await app.close();
  }
});
