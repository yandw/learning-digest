# PoC Evaluation Report — Speech Providers, Live Path, Go/No-Go

Ticket: #20 · Branch: `ticket/20-eval-report` · Base: `poc/integration` with #11–#19 merged
Date: 2026-11-07 · Tests at evaluation time: 183 pass / 0 fail (`npm test`)

## 1. Scope and method

This report is the PoC deliverable that decides what happens next. It compares the
three Speech Providers implemented in #11/#17/#19 (Groq, Tencent Cloud ASR,
Aliyun NLS), validates what the unified live/replay micro-batch pipeline can
guarantee today, and frames the go/no-go decision on the post-PoC architecture.

Hard rule observed throughout: **no fabricated measurements**. No real audio was
run through any provider during the PoC (no credentials, no real xiaoe-tech
session). Every fact in this report is either:

- **code-verifiable** (traceable to a file and line in this repo), or
- **TODO(manual)** — a measurement only the user can perform on a real lesson,
  with exact step-by-step instructions.

Where a fact comes from a provider's published documentation, the doc is cited
and the claim is marked as documentation-sourced, not measurement.

## 2. Provider comparison

> **Amendment (2026-11-07, after this report):** the Aliyun NLS provider was
> removed and replaced by **Aliyun Bailian Qwen ASR** (`qwen3-asr-flash`, OpenAI-compatible
> chat-completions with an `input_audio` Data URI). One service-scoped API key, no request
> signing or token dance; documented limit ≤ 5 min / ≤ 10 MB (base64) per request, so the
> default 120 s Segment fits. The Aliyun NLS column below is kept as the historical
> record of what this report evaluated; the Qwen provider's own live measurements are
> still TODO(manual) under the same procedure.


### 2.1 Code-verifiable rows

| Row | Groq (whisper-large-v3-turbo) | Tencent Cloud ASR (SentenceRecognition) | Aliyun NLS (一句话识别 RESTful) |
| --- | --- | --- | --- |
| API model used | `POST {baseUrl}/audio/transcriptions`, OpenAI-compatible; defaults `https://api.groq.com/openai/v1` / `whisper-large-v3-turbo` (`speech-providers.js`, Groq provider) | `SentenceRecognition`, Version `2019-06-14`, `POST https://asr.tencentcloudapi.com/`, JSON body with base64 audio (`speech-providers.js`, Tencent provider) | `POST https://nls-gateway-<region>.aliyuncs.com/stream/v1/asr?appkey=...&format=...&sample_rate=16000`, binary body (`speech-providers.js`, Aliyun provider) |
| Audio limits per request | No client-side limit enforced. Provider-side limits (file size / duration) are **not recorded in code**; confirm against Groq's published limits before testing: **TODO(manual)** | Documented ≤ 60 s and ≤ 3 MB after base64 (cloud.tencent.com/document/product/1093/35646, updated 2025-12-30, cited in code) | Documented ≤ 1 minute, mono 16-bit, 8000/16000 Hz (help.aliyun.com/zh/isi/user-guide/restful-api-2, cited in code); implementation sends `sample_rate=16000` always |
| Formats vs capture output | Capture records `audio/webm;codecs=opus` (`offscreen.js` `MIME_TYPE`). Groq receives the Blob as-is via multipart upload; OpenAI-compatible endpoints accept webm. Format fit: **nominal, confirm in live test** | Documented: wav / pcm / ogg-opus / speex / silk / mp3 / m4a / aac / amr. webm (EBML) is **not** documented; `detectVoiceFormat` optimistically labels webm/opus as `ogg-opus`. **Risk row R1** | Documented: pcm / wav / opus / speex / amr / mp3 / aac. webm (EBML) is **not** documented; `detectAudioFormat` optimistically labels webm/opus as `opus`, unknown → `pcm`. **Risk row R1** |
| Records per Segment | `verbose_json` `segments` parsed into multiple Transcript records with per-segment offsets and language, reusing `alignChunkSegments` | Exactly one record per Segment; `start: 0` (segment-relative); duration from `ytdSegmentDuration` Blob hint, else provider-reported `AudioDuration`, else 0; no language field | Exactly one record per Segment; `start: 0` (segment-relative); duration from `ytdSegmentDuration` Blob hint, else 0 (response carries no duration); no language field |
| Authentication model | `Authorization: Bearer <apiKey>`; single service-scoped key; optional baseUrl/model overrides (also covers local faster-whisper servers) | TC3-HMAC-SHA256 request signing **inside the extension** with long-term SecretId/SecretKey; date in UTC; only `content-type;host` signed (matching ASR call examples) | Two-step: AccessKey pair signs a `CreateToken` POP RPC (HMAC-SHA1); short-lived token cached per AccessKey+region until 1 min before provider-reported `ExpireTime`; audio request authenticates with `X-NLS-Token` |
| Credential fields on options page | apiKey (password, required), baseUrl, model | secretId + secretKey (both password, required), region (default `ap-guangzhou`), engineModelType (default `16k_zh`) | accessKeyId + accessKeySecret (password, required), appKey (typed password for the required-field check; not a secret, commented in code), region (default `cn-shanghai`) |
| Credential exposure conclusion | Service-scoped LLM-style key; lowest exposure of the three under the BYO model. Keys live in `chrome.storage.local`, are sent only to the configured endpoint over TLS. | **Highest exposure**: long-term cloud key is **account-wide**, not service-scoped; Tencent's docs assume server-side custody ("避免泄露，否则将危及财产安全"). PoC accepts under the same BYO model as the AI Provider; before release, users should mint a CAM sub-account restricted to ASR, and the STS token flow (`X-TC-Token`, one optional credential field) is the production shape. Full assessment: issue #17 comment. | Account-wide long-term AccessKey pair; audio request itself uses a short-lived token, a modest reduction vs Tencent. Aliyun docs also assume server-side custody. Same PoC acceptance, same production target: RAM sub-account + STS, absorbable as one optional credential field. Full assessment: issue #19 comment. |
| Signing verification status | n/a (Bearer token) | Pure signing core verified against the official doc's worked example stages and RFC 4231 / FIPS 180-2 vectors; the doc's *final* signature uses a masked key and cannot be reproduced, so **re-verify end to end (API Explorer 签名串生成) before real use: TODO(manual)** | POP signature verified byte-for-byte against the official worked example (`yqWsF0aPGrECmuwTfALUIl0JM9M=`) and RFC 2202; doc rendering discrepancy resolved in favor of the published signature value / pop-core SDK (documented in code) |
| Works with default 120 s Segment? | Yes (subject to Groq's size limit, see row 2) | **No** — documented cap is 60 s; the default 120 s Segment exceeds it. Capture has no provider-dependent slicing; Segment length must be lowered to ≤ 60 s first (and there is no options UI for it; see Deviation D2 and Blocker B1) | **No** — documented cap is 1 minute; same situation as Tencent |
| Usable from the UI today? | Yes — select Groq, enter key, start | **Blocked at session start**: `handleStartLearning` only checks `credentials.apiKey` (`background.js`), so a correctly configured Tencent credential set (secretId/secretKey, no apiKey field) is refused with "Add a Speech Provider API key in Settings first." See Blocker B2 | **Blocked at session start**, same gate as Tencent (Aliyun's fields also carry no `apiKey`) |

### 2.2 Measurement rows — TODO(manual)

Fill every cell below on one and the same real xiaoe-tech lesson before drawing
conclusions. Suggested lesson: one 2–3 h Mandarin replay (replay pages give video
timestamps, so ground-truth alignment is easy). Run each provider over the same
lesson, one Session per provider.

| Measurement | Groq | Tencent | Aliyun |
| --- | --- | --- | --- |
| Quality on Mandarin course speech (WER + qualitative) | TODO(manual) | TODO(manual) | TODO(manual) |
| Per-Segment latency (median / p90) | TODO(manual) | TODO(manual) | TODO(manual) |
| Cost per 2–3 h lesson (audio + share of summary AI cost) | TODO(manual) | TODO(manual) | TODO(manual) |
| Request-level success rate (failed-Segment markers ÷ total Segments) | TODO(manual) | TODO(manual) | TODO(manual) |

#### How to measure quality (same procedure for all three)

1. Pick the lesson. Note its total audio duration. Use a replay/course page so
   side-panel timestamps are media positions.
2. Configure the provider in Settings (Groq: key; Tencent: SecretId/SecretKey;
   Aliyun: AccessKey pair + AppKey). For Tencent/Aliyun first lower the Segment
   length to 60 s or less, because both Chinese providers reject > 60 s audio:
   there is no options-page field, so set it through the service worker console
   (see Blocker B1) by writing `segmentLengthSeconds: 60` into the
   `ytd_settings` object in `chrome.storage.local`.
3. Start the Session, let the full lesson run to its end (or at least the first
   45 minutes), then press End learning.
4. Copy the transcript out of the side panel (select all rows) into a text file.
5. Build ground truth for 10 sample Segments spread across the lesson (every
   ~N-th segment): transcribe those stretches yourself, or use the platform's
   own subtitles/courseware if the replay provides them.
6. Compute WER per sample: WER = (substitutions + deletions + insertions) ÷
   words in ground truth. Report the median of the 10 samples.
7. Qualitative pass, one line each: punctuation quality, number/date
   normalization, English technical terms, proper nouns, behavior on the
   `[语音转录失败]` gaps.
8. Also record the risk-row outcome for the Chinese providers: did any Segment
   fail with a format rejection (e.g. Tencent `InvalidParameter`/format errors,
   Aliyun non-`20000000` status)? That is the R1 webm-mapping verdict.

#### How to measure per-Segment latency

1. Start a screen recording (or sit with a stopwatch) at Session start; note the
   wall-clock start time.
2. For 10 consecutive Segments in the middle of the session, record the
   wall-clock moment the transcript row for Segment k first appears in the panel.
3. Segment k's row timestamp shows its Session position `start_k` and its
   content covers `duration_k` (the Segment length you set). Latency_k =
   (row-appear wall time − session-start wall time) − (start_k + duration_k).
4. Report median and p90 across the 10. Sanity-check against the provider
   console: Tencent and Aliyun consoles show per-request timing; Groq's console
   shows request logs.
5. Expected shape from the code: latency ≈ Segment length + cut + upload +
   recognition, i.e. first row at roughly 2 min with the 120 s default (Groq)
   or roughly 1 min with a 60 s Segment (Chinese providers), growing linearly
   if provider latency exceeds the Segment cadence (the pipeline has no
   catch-up/backpressure; Segments dispatch as the position stream emits them).

#### How to measure cost per 2–3 h lesson

1. Before the run, record the provider balance/quota. For Tencent and Aliyun,
   also note the exact per-request/per-second price on the official pricing page
   at the day of the test (these prices change; do not copy a number from this
   report).
2. Run one full 2–3 h lesson. Count Segments from the ended session (panel row
   count, or the segment list in the Session snapshot under
   `ytd_session_<id>` in `chrome.storage.local`).
3. Speech cost:
   - Groq: audio minutes × Groq's per-minute (or per-token) Whisper rate on the
     official pricing page. For a 2.5 h lesson that is 150 audio minutes.
   - Tencent: 一句话识别 is billed per request on Tencent's ASR pricing page;
     cost = successful requests × per-request price. A 2.5 h lesson at 60 s
     Segments is ~150 requests plus the tail.
   - Aliyun: NLS RESTful is billed by usage time on Aliyun's billing page;
     cost = audio seconds × per-second price (2.5 h = 9000 s).
   Cross-check the computed figure against the actual console balance delta and
   record both.
4. Summary AI cost (all providers, secondary): DeepSeek's current rates are in
   README (cache-miss input $0.22/M, cache-hit $0.007/M, output $0.66/M,
   off-peak). From the DeepSeek console usage for the session window, take
   input and output tokens for the rolling-summary ticks plus the final digest
   and compute (input_tokens × input_rate) + (output_tokens × output_rate).
   Note the code-level cost guards already in place: a summary tick is skipped
   when no new Transcript exists, a failed tick waits one interval instead of
   retry-looping, and the digest reuses the rolling summary text verbatim when
   the uncovered tail is empty (no redundant AI call).

#### How to measure request-level success rate

1. From the ended Session snapshot (`ytd_session_<id>` in `chrome.storage.local`
   via the service worker console), count Segments with `status: "failed"` and
   divide by total Segments.
2. Cross-check against the provider console's error logs. Any failure cluster
   at Segment boundaries points at the 60 s cap (if Segment length was left at
   120 s) or at R1 format rejection.

## 3. Live-path validation

### 3.1 What the unified micro-batch pipeline guarantees for live today (code-verified)

- **One code path for live and replay**: the same segmenter, the same
  exactly-once dispatch (`background.js` `dispatchSegment`), the same Session
  state machine. Live differs only in the position source: a 1 s wall-clock
  timer (`LIVE_TICK_MS`) instead of the page-bridge media poll.
- **Wall-clock timestamps**: live rows show elapsed `[h:]mm:ss` since Session
  start; pausing the player does not pause capture (rows keep coming), and a
  live Session ends **only** via the explicit End action (`endActiveSession`),
  never on media end.
- **Exactly-once Segments, resume-safe**: every Segment settles once; a worker
  restart rebuilds the context from the persisted snapshot and done Segments
  are never re-transcribed or double-charged (`ensureCaptureResumed`).
- **Visible failure semantics**: a failed Segment produces a
  `[语音转录失败]` marker record covering its own time range; neighbours are
  untouched; if every Segment failed the Session is treated as having no
  Transcript instead of a transcript of markers.
- **Rolling Summary and Digest on the live path**: the summary timer runs
  during live (default 30 min, clamped [5, 180], 1 min timer floor); the
  Session Digest is generated at end from the rolling summary plus the
  uncovered tail, persisted under `digest_<sessionId>`, and returned with the
  end response. Failure markers stay in the summary/digest windows so gaps are
  acknowledged, not invented around.
- **Display delay is structural, not a bug**: the first transcript row can
  appear only after one full Segment (default 120 s) has been captured, cut,
  uploaded, and recognized; subsequent rows arrive per Segment as long as
  recognition keeps up with capture. Plan live UX around a ~2 min freshness
  floor with the defaults (roughly ~1 min if Segment length is lowered for the
  Chinese providers).

### 3.2 Known open questions for live

1. **Is a 1–2 min transcript display delay acceptable in a live class?** This
   is a product decision only the user can make; it drives the go/no-go
   outcome directly (Section 4). Related: is the deliverable "rows within a
   couple of minutes" (fine for note-taking after class) or "near-real-time
   captions" (micro-batch cannot deliver that at any Segment length that keeps
   cost and request rate sane)?
2. **Pause = paid silence**: live accrues wall-clock audio; a 10 min break
   still produces Segments and provider requests (of silence). Acceptable at
   Groq's price point; at per-request Chinese pricing it doubles request count
   for the same lesson.
3. **Chinese providers on live need the 60 s slicing plus the start-gate fix**
   (Blockers B1/B2) before they can even be measured on the live path.
4. **Failure visibility in live**: a failed Segment mid-live leaves a visible
   gap marker; there is no in-Session retry by design (exactly-once). If a
   provider has a bad patch mid-session, those ranges stay gaps in the digest.

### 3.3 Manual validation checklist for a real xiaoe-tech live session

Prerequisite: provider key configured in Settings, extension loaded unpacked
from this worktree, and (for Tencent/Aliyun) Blockers B1/B2 resolved locally.

1. Open a xiaoe-tech live page (`/live…` or an `l_` resource URL) **during an
   actual broadcast**. The side panel must show Start learning.
2. Press Start learning. No permission prompt is expected (tabCapture is
   silent). Confirm the panel shows the active-session state.
3. Keep the live playing. Transcript rows must appear with wall-clock
   timestamps, the first row after roughly one Segment length (plus provider
   latency). Note the actual delay: this feeds open question 1.
4. Pause the live video player for ~2 min: rows must keep appearing
   (wall-clock), and the audio content of those rows should be silence or
   background. This confirms the pause behavior and its cost implication.
5. Switch to another tab mid-session: rows must keep coming (capture follows
   the tab, not the panel).
6. Close the side panel mid-session, reopen it: the transcript re-syncs from
   storage and the session resumes without re-transcribing finished Segments
   (watch the provider console for re-uploads; there must be none).
7. Reload the extension mid-session (`chrome://extensions` → Reload), reopen
   the panel: capture restarts against the same tab, done Segments are not
   re-sent.
8. Press End learning: the Session ends, the Session Digest appears in the
   panel and is persisted (`digest_<sessionId>`). Confirm the digest mentions
   any gaps from step 4 honestly.
9. Reopen the panel **after** ending: note that the digest is not shown again
   (active-capture pointer is cleared at end; Deviation D7). Decide whether
   that matters enough for the follow-up "last session" UX ticket.
10. Record for the report: provider used, Segment length, total live minutes,
    rows delivered, failed markers, measured display delay (step 3), and the
    provider console's request count for cost computation.

## 4. Go/no-go recommendation framework

This report deliberately does not conclude; it makes the conclusion mechanical
once the TODO(manual) cells in Section 2.2 and the live checklist in Section 3.3
are filled.

### 4.1 Blockers to clear before any provider comparison is meaningful

- **B1 — No provider-dependent Segment slicing.** Both Chinese providers cap
  audio at ~60 s per request; the capture layer always uses the single global
  `segmentLengthSeconds` (default 120, clamped [30, 600]) and has no UI to
  change it. Measuring Tencent/Aliyun requires setting `segmentLengthSeconds`
  to 60 via `chrome.storage.local` (`ytd_settings` object), or a local code
  patch. Production fix: provider-aware default Segment length plus an options
  field.
- **B2 — Start gate only accepts Groq-shaped credentials.** Session start
  refuses any provider whose credential set lacks an `apiKey` field
  (`background.js` `handleStartLearning`), which locks out correctly configured
  Tencent/Aliyun users. Measuring the Chinese providers requires a one-line
  local patch of that gate (check the selected provider's required fields via
  the registry's `credentialFields`), or routing through a Groq-shaped field.
- **B3 — webm/opus optimistic format mapping (risk row R1).** Neither Chinese
  provider documents webm; the providers optimistically label it `ogg-opus` /
  `opus`. The quality/cost runs in Section 2.2 double as the validation: any
  format-rejection cluster answers this risk. If the live APIs reject webm, the
  capture layer must produce a documented container (e.g. transcode to wav, or
  negotiate a recorder MIME the provider accepts) before those providers are
  viable at all.

### 4.2 Scoring criteria (suggested thresholds; adjust to your tolerance)

| Criterion | Suggested threshold | Where it comes from |
| --- | --- | --- |
| Transcription quality | Median WER ≤ 15 % on the sampled Mandarin stretches, with no systematic failure mode (numbers, English terms) you cannot live with | Section 2.2 quality run |
| Latency (replay/course) | Median row delay ≤ 5 min; p90 ≤ 10 min | Section 2.2 latency run |
| Latency (live) | Decide open question 1: is the measured first-row delay (≥ 1 Segment length) acceptable for live note-taking? | Section 3.3 step 3 |
| Cost per 2.5 h lesson | Within your own ceiling; record the number per provider for comparison | Section 2.2 cost run |
| Reliability | Failed-Segment rate ≤ 2 %, no format-rejection cluster | Section 2.2 success-rate run |
| Credential risk | Accepted per the #17/#19 assessments (BYO, locally stored, account-wide keys for the Chinese providers) | Section 2.1 exposure row |

### 4.3 Decision rules

1. **Pick the primary provider** as the one with the best quality within your
   cost ceiling and reliability threshold. If only Groq clears B-free
   (it needs no blockers fixed), that itself is a finding: the Chinese
   providers carry fix-up cost before they can even compete.
2. **Replay/course path: GO on the unified micro-batch pipeline** if the chosen
   provider meets quality/cost/reliability. Nothing in the replay path depends
   on display freshness; the digest at media end is the product.
3. **Live path: conditional.**
   - If the measured live display delay (≥ 1 Segment length, structurally) is
     acceptable for your live use: **GO unified** — one pipeline to maintain,
     exactly-once semantics, no seam change.
   - If live needs near-real-time text: **NO-GO for live on micro-batch**;
     file a follow-up to move live to a streaming ASR provider (Tencent
     实时语音识别 and Aliyun 实时语音识别 are the streaming counterparts of the
     two providers already prototyped). Note the cost: the frozen #11 seam
       `transcribe(segmentAudio, credentials)` is one-shot by design; streaming
       needs either a parallel provider interface (a second seam method such as
       `transcribeStream`) or a seam change, plus capture changes (no more
       per-Segment cut/upload). Replay and course can keep micro-batch, so the
       likely end state is a hybrid, not a wholesale replacement.
4. **File follow-up issues regardless of outcome** for: B1 provider-aware
   slicing + segment-length UI; B2 start-gate generalization; B3/R1 container
   validation and, if needed, transcoding; STS token flows for both Chinese
   providers (production credential shape per #17/#19); digest visibility on
   panel reopen (D7); capture layer setting `ytdSegmentDuration` (D1); and the
   account-wide-key user guidance (dedicated CAM/RAM sub-account) before any
   real release.

## 5. Deviation register

Every deviation recorded during #11–#19 that a reader of this report should not
mistake for a bug or a regression.

| # | Deviation | Origin | Status / impact on evaluation |
| --- | --- | --- | --- |
| D1 | `ytdSegmentDuration` Blob convention: the frozen #11 seam has no slot for Segment duration, so the convention lives as a property on the audio Blob. The capture layer currently never sets it (`dataUrlToBlob` rebuilds a fresh Blob), so Tencent falls back to provider-reported `AudioDuration` and Aliyun records duration 0. | #17, #19 | Aliyun duration-0 records mean the rolling-summary window re-includes the previous boundary record once per tick (bounded, one record of duplication); timestamps themselves still derive from `record.start`. Fix as follow-up; does not block measurements. |
| D2 | Missing segment-length options UI: #16 normalized the `segmentLengthSeconds` setting (default 120, clamp [30, 600]) expecting a #17 UI that never landed; #18 confirmed only the summary-interval field exists. | #16, #17, #18 | Directly causes Blocker B1 for the Chinese providers. |
| D3 | Digest not shown on panel reopen after end: the digest is persisted (`digest_<sessionId>`) and shown to any panel open at end time, but a panel reopened later has no session view because the active-capture pointer is cleared at end. | #18 | PoC-acceptable; "last session" pointer is a follow-up UX ticket. Confirm at checklist step 9. |
| D4 | Prompts as code templates: rolling-summary and digest prompts are pure template literals in `session-summary.js`, not `prompts/*.md` files (those need a browser loader; the spec's pure-module requirement won). | #18 | User-editable prompts would need an extraction behind an injectable loader. No evaluation impact. |
| D5 | Tencent and Aliyun ~60 s per-request caps vs the 120 s default Segment: the capture layer does not slice provider-dependently. | #17, #19 | Blocker B1; both Chinese providers are unusable at defaults. |
| D6 | `l_` page URLs cannot distinguish "currently broadcasting" from "recording", so bare `l_` and `/live…` URLs classify as `live` with wall-clock timestamps; only explicit replay/playback paths get video timestamps. | #16 | Correct by design for safety; matters when validating replay URLs that live in `l_` pages. |
| D7 | Seek-forward during replay produces one Segment containing non-contiguous audio (garbage-in, documented); playback speed other than 1x shifts wall-clock-recorded audio vs position timestamps (not compensated). | #16 | PoC-accepted; note when choosing ground-truth samples. |
| D8 | Live wall-clock accrual: pauses and silence are captured, transcribed, and billed. | #16 | Open question 2; cost runs should note actual live minutes vs wall-clock minutes. |
| D9 | Tencent signing: the doc's published final signature uses a masked key and is not reproducible; all key-independent stages are pinned to the doc vectors. Re-verify end to end before real use. | #17 | TODO(manual) in Section 2.1. |
| D10 | Aliyun POP doc renders StringToSign with literal `&` but its own published signature requires whole-query re-encoding; implementation follows the signature value and pop-core SDK (documented in code and tests). | #19 | Resolved; listed for auditability. |
| D11 | Aliyun Singapore (`ap-southeast-1`) gateway/token symmetry assumed; token doc warns tokens must come from the matching endpoint, which per-region host construction honors. | #19 | Only affects users overriding the region. |
| D12 | Side panel gates its startup on the AI Provider key (pre-#16 behavior): a speech-key-only user sees a config error even though capture itself needs only the Speech Provider key. | #16 | UX follow-up if AI-key-less capture matters. |
| D13 | Rolling-summary tick does not run early at session end even if due; the digest covers the uncovered tail anyway. | #18 | No transcript loss; only timing of the last summary. |
| D14 | Stale `captions.js` references remain in comments of speech-providers.js / session-pipeline.js / session-persistence.js (file retired in #13). | #13 | Cosmetic. |
| D15 | US13 partial, local/OpenAI-compatible endpoints: reaching a non-Groq Speech Provider host requires hand-editing `host_permissions` in manifest.json. A runtime "Request access" flow via `chrome.permissions.request` is not implemented because the release test pins the manifest shape with no `optional_permissions`/`optional_host_permissions` (`tests/release.test.js`), which Chrome requires before any runtime grant. Documented in the options page copy as a known limitation. | #21 (review of US13) | Conscious defer; unblocking it means relaxing the release manifest pin deliberately, not as a side effect. |

## 6. Appendix — reference links

- Issue #17 credential-exposure assessment (comment): https://github.com/yandw/learning-digest/issues/17
- Issue #19 credential-exposure assessment (comment): https://github.com/yandw/learning-digest/issues/19
- Tencent SentenceRecognition doc: https://cloud.tencent.com/document/product/1093/35646
- Tencent TC3-HMAC-SHA256 signing: https://cloud.tencent.com/document/product/213/30654
- Aliyun NLS RESTful API: https://help.aliyun.com/zh/isi/user-guide/restful-api-2
- Groq API (OpenAI-compatible audio transcriptions): https://console.groq.com/docs (limits and pricing live here; look them up on the test day)
- DeepSeek pricing (AI Provider): https://api-docs.deepseek.com/quick_start/pricing (also tabled in README)
