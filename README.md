# Learning Digest

[English](README.md) | [简体中文](README.zh-CN.md)

Turn live course audio into a learning resource with segment-by-segment transcription, rolling summaries, and a full-session digest.

Learning Digest is a personal learning library plus a Chrome side panel for studying long course lessons on learning platforms. You collect a lesson link in the web library or from the extension, start a Session, and the extension captures the lesson audio in fixed-length Segments and sends them to your backend, where the configured Speech Provider transcribes each Segment exactly once. The web library keeps your collection, playback positions, timestamped notes, every Session's Transcript, and on-demand course summaries in one place.

- Collect lesson links on supported course platforms (first platform: xiaoe-tech.com) and any web page, and open the original page in one click.
- Resume study from the last recorded position, or start over; the extension records positions per Source and supports timestamped notes.
- Follow a Session as Segments are transcribed; Bilibili and other video platforms contribute captions directly when available, and captured audio flows through the backend transcription worker otherwise.
- Generate a course summary on demand from everything archived so far, with citations that trace back to the original text and timestamp.
- Study in the original language, Simplified Chinese, or an aligned bilingual view; explain selected terms with AI that runs on your own backend.
- Administrators control what each platform may do from the web library's site administration page: captions, ASR, and a per-platform on/off switch that the extension follows.

The productization line (0.2.x) adds the web library, backend API, transcription worker, and account linking to the frozen proof-of-concept extension (0.1.x). It is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store.

## The four units

| Unit | Location | Role |
| --- | --- | --- |
| Browser extension | `apps/extension/` (`manifest.json`) | account linking, collection, course-tab selection, playback position, notes, captions/audio capture (Chrome MV3 side panel) |
| Web library | `apps/web/` | invite login, collection, library list and detail, transcripts, course summaries, usage, site administration for administrators |
| Backend API | `apps/api/` | identity, resources and sources, sessions, progress, notes, transcripts, summary generation, panel AI (rolling summary, digest, explanations), site capability registry, usage |
| Transcription worker | `apps/worker/` | pulls transcription tasks from the API, runs the Speech Provider, writes timestamped records back |

`contracts/` holds the shared `/v1` interface contract, platform video-ID extraction rules, and JSON fixtures consumed by all units' tests. Domain vocabulary: [GLOSSARY.md](GLOSSARY.md). Data flow: [PRIVACY.md](PRIVACY.md). Contract decisions: [contracts/decisions.md](contracts/decisions.md).

The extension and web library are plain HTML, CSS, and JavaScript with no build step. The service layer (backend API and transcription worker) is Python 3.12+ run with [uv](https://docs.astral.sh/uv/) (`uv sync` installs each unit's dependencies on first run). Node 20 or newer is needed only for the web library's dev server and the extension tooling (global `fetch`, `AbortSignal.timeout`).

## Run the four units (development)

One command manages the three server processes for local acceptance: `scripts/dev.sh start|status|logs|stop|restart` (ports default to 8787/8080, override with `API_PORT`/`WEB_PORT`; logs live in `/tmp/learning-digest-dev/logs/`). The manual steps below show what it does.

Four processes in four terminals. Install [uv](https://docs.astral.sh/uv/) first; `uv sync` below is idempotent.

1. Register an invited email (before starting the API):

```bash
cd apps/api
uv sync
uv run python -m app.invites add you@example.com   # repeatable; `list` to inspect
```

2. Start the API (port 8787):

```bash
cd apps/api
uv run python -m app.main   # uvicorn entry; state in data/state.json, dev mailer writes data/outbox.jsonl
```

3. Start the transcription worker (pull model; deterministic stub provider by default):

```bash
cd apps/worker
uv sync
uv run python -m worker.main   # token comes from apps/worker/config.json (copy config.example.json first)
# Env overrides still work, for example:
#   LD_WORKER_TOKEN=... LD_WORKER_PROVIDER=qwen QWEN_API_KEY=sk-... uv run python -m worker.main
#   LD_WORKER_PROVIDER=local LD_WORKER_LOCAL_BASE_URL=http://<host>:<port> uv run python -m worker.main
```

Give the API and the worker one shared token: fill `workerToken` in `apps/api/config.json` and `token` in `apps/worker/config.json` with the same value (see Service configuration files above; unset everywhere means the worker endpoints answer 401). Real ASR: Bailian cloud (`provider: "qwen"` + `qwenApiKey`, or env `LD_WORKER_PROVIDER=qwen QWEN_API_KEY=sk-...`) or a self-hosted service (`provider: "local"` + `localBaseUrl`, see Self-hosted / LAN ASR below).

4. Start the web library (port 8080, proxies `/v1` to the API):

```bash
cd apps/web
npm start          # LD_API_UPSTREAM defaults to http://127.0.0.1:8787
```

5. Load the extension: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select the exact `apps/extension` folder (the one containing `manifest.json`). The extension Settings page exposes the 学习服务 base URLs; the defaults already point at the local development servers.

6. Walk the flow: open `http://127.0.0.1:8080`, log in with the invited email, take the verification code from the dev outbox (`data/outbox.jsonl` next to `apps/api/`, also printed to the API's stdout), then open the extension side panel and follow the authorization guide. After linking, open a lesson page, save it from the panel, start a Session, and watch playback positions, transcripts, and summaries land in the web library.

Real email delivery, real ASR, and real AI generation are stubbed until configured: the dev mailer writes codes to the outbox file, the worker defaults to the stub Speech Provider, and the API defaults to the stub AI Provider. Real providers need the keys from the service configuration files or the environment tables.

## Testing

```bash
npm test                              # extension (apps/extension/tests/), 698 cases
node --test contracts/                # shared contract fixtures, 71 cases
cd apps/api    && uv run pytest tests/ -q  # API, 271 cases
cd apps/worker && uv run pytest tests/ -q  # worker, 43 cases
cd apps/web    && npm test            # web, 174 cases
npm run check               # release-shape check (manifest, allowlist, importScripts, content_scripts)
npm run package             # zip the extension
```

All suites pass (1257 cases at the current tip) with no external network: HTTP tests bind loopback ephemeral ports, and the ASR/AI tests use deterministic stub providers or injected `fetch`, so CI needs no keys.

The complete test-case list, grouped by unit and feature area with the verifying file for every automated case, plus the manual acceptance cases and known-limitation observations, is in [docs/test-cases.md](docs/test-cases.md). Manual acceptance checklists (real platforms, real keys, tabCapture authorization) live in [docs/round1-acceptance.md](docs/round1-acceptance.md) and [docs/round2-acceptance.md](docs/round2-acceptance.md).

## Service configuration files

The API and the worker each read an optional runtime config file next to their code: `apps/api/config.json` and `apps/worker/config.json`. Both are gitignored: copy the committed examples and fill in your own values:

```bash
cd apps/api    && cp config.example.json config.json
cd apps/worker && cp config.example.json config.json
```

Every field follows the same precedence: **environment variable > config file > built-in default**. A missing `config.json` is fine (the defaults and any exported env apply); an invalid one fails at startup with the file path named. The config file holds the same settings as the environment tables below, keyed by these camelCase names.

### apps/api/config.json

| Field | Default | Purpose |
| --- | --- | --- |
| `workerToken` | unset (worker endpoints 401) | worker service credential for `/v1/worker/tasks/*`; must match the worker's `token` |
| `aiProvider` | `stub` | `qwen` = Bailian compatible-mode for course summaries and the panel AI features (rolling summary, digest, explanations) |
| `aiApiKey` | unset | Bailian key for `aiProvider: "qwen"`, serving course summaries and panel AI from this one server-side seam, separate from the worker's speech key |
| `aiModel` | `qwen3.8-flash` | model override |
| `aiBaseUrl` | Bailian compatible-mode | endpoint override |
| `aiTimeoutMs` | `120000` | per-generation fetch timeout |
| `courseSummaryPrompt` | `relationship` | Default to chapter relationship diagrams. Set `detailed` to use the detailed prompt, then restart the API. [Comparison samples](docs/evidence/course-summary-variants/) |
| `stateFile` | `data/state.json` | embedded store override (relative paths resolve against the API's start directory) |
| `inviteSeed` | `data/invites.seed.json` | invited-email seed override |
| `outboxFile` | `data/outbox.jsonl` | dev-mailer outbox override (verification codes) |
| `audioDir` | system temp dir | temp audio for uploaded segments (deleted on success) |

The listen port is not a config-file field: `scripts/dev.sh` owns `PORT`.

### apps/worker/config.json

| Field | Default | Purpose |
| --- | --- | --- |
| `apiBase` | `http://127.0.0.1:8787` | API base |
| `token` | unset | worker service credential; must match the API's `workerToken` |
| `provider` | `stub` | `qwen` = Bailian qwen3-asr-flash; `local` = self-hosted OpenAI-compatible transcription |
| `pollIntervalMs` | `5000` | idle poll interval |
| `errorBackoffMs` | poll interval | sleep after a failed cycle |
| `qwenApiKey` | unset | Bailian speech key (required when the provider is `qwen`; checked at startup) |
| `qwenBaseUrl` | Bailian compatible-mode | endpoint override |
| `qwenModel` | `qwen3-asr-flash` | model override |
| `qwenTimeoutMs` | `120000` | per-request ASR timeout |
| `localBaseUrl` | unset | self-hosted / LAN ASR endpoint (`local` provider; required when selected) |
| `localModel` | `whisper-1` | local transcription model |
| `localToken` | unset | optional Bearer token for the local service |
| `localLanguage` | `zh` | transcription language hint |
| `localMimeType` | unset | audio MIME override for picky services |
| `localResponseFormat` | `verbose_json` | local transcription response format |

Credential hygiene: the `config.json` files hold real keys and never enter the repository (they are gitignored; the `config.example.json` files carry placeholders only). `scripts/dev.sh` does not invent a dev token: it starts both services with whatever the config files and your exported env provide, so with neither a config file nor env the worker endpoints fail closed (401). Put the same non-placeholder token in both files and the worker can claim tasks.

## Environment variables

These are the same settings as the config files above with their variable names. The order is **environment variable > config file > built-in default**: a variable overrides its config-file field; both override the defaults below. Env stays the tool for CI, tests, and one-off overrides.

### apps/api (`app/main.py`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | listen port (`0` = ephemeral) |
| `LD_API_STATE_FILE` | `data/state.json` | embedded store (read once at startup) |
| `LD_API_INVITE_SEED` | `data/invites.seed.json` | invited-email seed |
| `LD_API_OUTBOX_FILE` | `data/outbox.jsonl` | dev-mailer outbox (verification codes) |
| `LD_API_WORKER_TOKEN` | unset (worker endpoints 401) | worker service credential for `/v1/worker/tasks/*` |
| `LD_API_AUDIO_DIR` | system temp dir | temp audio for uploaded segments (deleted on success) |
| `LD_AI_PROVIDER` | `stub` | `qwen` = Bailian compatible-mode for course summaries and the panel AI features (rolling summary, digest, explanations) |
| `LD_AI_API_KEY` | unset | Bailian key for `LD_AI_PROVIDER=qwen`, serving course summaries and panel AI from this one server-side seam, separate from the worker's speech key |
| `LD_AI_MODEL` | `qwen3.8-flash` | model override |
| `LD_AI_BASE_URL` | Bailian compatible-mode | endpoint override |
| `LD_AI_TIMEOUT_MS` | `120000` | per-generation fetch timeout |
| `LD_COURSE_SUMMARY_PROMPT` | `relationship` | Overrides the configured summary prompt variant. Also accepts `detailed`. |

### apps/worker (`worker/main.py`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `LD_WORKER_API_BASE` | `http://127.0.0.1:8787` | API base |
| `LD_WORKER_TOKEN` | unset | worker service credential (must match the API's `LD_API_WORKER_TOKEN`) |
| `LD_WORKER_PROVIDER` | `stub` | `qwen` = Bailian qwen3-asr-flash; `local` = self-hosted OpenAI-compatible transcription |
| `QWEN_API_KEY` | unset | Bailian speech key (required when the provider is `qwen`; checked at startup) |
| `LD_WORKER_POLL_INTERVAL_MS` | `5000` | idle poll interval |
| `LD_WORKER_ERROR_BACKOFF_MS` | poll interval | sleep after a failed cycle |
| `LD_WORKER_QWEN_BASE_URL`, `LD_WORKER_QWEN_MODEL` | Bailian, `qwen3-asr-flash` | endpoint/model overrides |
| `LD_WORKER_QWEN_TIMEOUT_MS` | `120000` | per-request ASR timeout (httpx's 5s default is too short for a 30s segment) |
| `LD_WORKER_LOCAL_BASE_URL` | unset | self-hosted / LAN ASR endpoint (`local` provider; required when selected) |
| `LD_WORKER_LOCAL_MODEL`, `LD_WORKER_LOCAL_LANGUAGE`, `LD_WORKER_LOCAL_TOKEN`, `LD_WORKER_LOCAL_MIME_TYPE`, `LD_WORKER_LOCAL_RESPONSE_FORMAT` | `whisper-1`, `zh`, unset, unset, `verbose_json` | local provider tuning |
| `LD_WORKER_LOCAL_BASE_URL` | unset | self-hosted ASR service base URL (required when the provider is `local`; missing fails at startup) |
| `LD_WORKER_LOCAL_MODEL`, `LD_WORKER_LOCAL_LANGUAGE` | `whisper-1`, `zh` | local transcription model and language |
| `LD_WORKER_LOCAL_TOKEN`, `LD_WORKER_LOCAL_MIME_TYPE` | unset | optional Bearer token and audio MIME override for the local service |

### apps/web (`server.js`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | listen port |
| `LD_API_UPSTREAM` | `http://127.0.0.1:8787` | `/v1` proxy target |

### Browser extension (Settings page)

The extension keeps on the device only what belongs there: the session and Segment settings, and the 学习服务 base URLs used for account linking. Panel AI (rolling summary, digest, explanations), course summaries, and Session transcription all run server-side with server-configured keys; no AI or Speech Provider key is stored in the extension, and the settings migration removes legacy ASR and AI keys on first read. Settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/learning-digest` on macOS or Linux, or `%USERPROFILE%\Documents\learning-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms. https://github.com/yandw/learning-digest

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/learning-digest` on macOS or Linux, or `%USERPROFILE%\Documents\learning-digest` on Windows.
2. Open the official Alibaba Cloud Bailian page below and help you create your own account.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Help you set your API keys in your own backend's configuration files (the gitignored `config.json` files) or environment variables: the transcription worker's speech key and the API's AI key. The extension's **Settings** page has no key fields.
5. Explain how the side panel, Session pipeline, and the server-configured keys fit together.

Keep this folder in the same place after installation. Moving or deleting the source folder breaks the unpacked extension until you load it again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly into the backend configuration files or commands on your own machine. Your coding agent can point to the right environment variable without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Open [github.com/yandw/learning-digest](https://github.com/yandw/learning-digest).
2. Choose **Code**, then **Download ZIP**.
3. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/learning-digest` on macOS or Linux, or `%USERPROFILE%\Documents\learning-digest` on Windows. You may use a different folder.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the exact project folder you chose, which must contain `manifest.json` (for this repository: the `apps/extension` folder).
8. Pin Learning Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the Learning Digest card at `chrome://extensions`, then refresh open course tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

Learning Digest runs all of its AI on your own backend: course summaries, the panel's rolling summaries and digests, and explanations of selected text all use the AI provider configured on the API (through `apps/api/config.json` or environment variables). Session transcription uses the Speech Provider configured on the transcription worker the same way. The browser extension has no key fields and never talks to an AI or Speech Provider itself.

### Get an AI provider API key

1. Open the official [Alibaba Cloud Bailian console](https://bailian.console.aliyun.com/).
2. Sign in or create an Alibaba Cloud account when prompted, and activate Bailian (Model Studio) if asked.
3. Create an API key, give it a recognizable name such as `Learning Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Set it as `aiApiKey` in the API's `apps/api/config.json` (with `"aiProvider": "qwen"`), where it serves course summaries and the panel AI features. The environment variable `LD_AI_API_KEY` (with `LD_AI_PROVIDER=qwen`) works too and wins if both are set.
6. If Bailian reports insufficient quota, top up in your Bailian account and try again.

See the [official Alibaba Cloud Model Studio documentation](https://help.aliyun.com/zh/model-studio/) for current account and API details.

Keys exist only on your backend, inside the two gitignored config files or the processes' environment: put `aiApiKey` in `apps/api/config.json` and `qwenApiKey` in `apps/worker/config.json`. Never commit them; the `.gitignore` rule is your guard (the committed `config.example.json` files carry placeholders only). Never paste a key into an AI chat, a versioned file, a screenshot, or a public message.

The published version uses Alibaba Cloud Bailian with the qwen3.8-flash model as its AI provider:

```text
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen3.8-flash
```

Learning Digest sends every request in non-thinking mode for responsive, predictable interactions. The endpoint and model are fixed in the API's published configuration, so the only AI credential you enter is your Bailian API key in the API's config file (or environment). To use another provider or model, change the `ai*` fields in `apps/api/config.json` (or the `LD_AI_*` variables) or ask a coding agent to adapt your local copy. Never add an API key to that prompt or chat.

### Speech Provider key (backend)

Session transcription defaults to Qwen ASR on Alibaba Cloud Bailian, configured in the transcription worker (through `apps/worker/config.json` or environment variables):

```text
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen3-asr-flash
```

Set `"provider": "qwen"` and `qwenApiKey` in the worker's config file (env: `LD_WORKER_PROVIDER=qwen`, `QWEN_API_KEY`), and give the API and the worker a shared token pair: `workerToken` in `apps/api/config.json` matching `token` in `apps/worker/config.json` (env: `LD_API_WORKER_TOKEN` / `LD_WORKER_TOKEN`). The AI key on the API (`aiProvider: "qwen"` plus `aiApiKey`) serves course summaries and the panel AI features from one seam. Until these are set, the worker and the API run deterministic stub providers so the whole flow can be exercised without keys.

### Self-hosted / LAN ASR

Transcription can also run entirely on your own hardware, touching no cloud API: point the worker at a self-hosted, OpenAI-compatible transcription service (faster-whisper-server, LocalAI, and whisper.cpp server all speak this shape) with `"provider": "local"` and `localBaseUrl: "http://<host>:<port>"` in the worker's config file (env: `LD_WORKER_PROVIDER=local`, `LD_WORKER_LOCAL_BASE_URL=http://<host>:<port>`). The worker posts multipart audio to `{base}/v1/audio/transcriptions` with the model and language (defaults `whisper-1` and `zh`) and, when `localToken` (env `LD_WORKER_LOCAL_TOKEN`) is set, a Bearer token. `localMimeType` (env `LD_WORKER_LOCAL_MIME_TYPE`) overrides the audio MIME type for services that are picky about containers (wav/webm are common). A `local` selection without a base URL fails at startup, the same fail-fast rule as a `qwen` selection without a key.

## Use Learning Digest

1. Log in to the web library with an invited email and link the extension from the authorization page.
2. Collect a lesson link (paste it in the web library or save the current page from the panel). A disabled platform (site administration) can still be collected but not studied.
3. Open the lesson page, pick its tab in the panel, and start a Session. The panel checks the server's site capability table first, so a platform your administrator disabled refuses to start with 站点未开放学习.
4. Read the timestamped Transcript as Segments complete, or choose **Original**, **中文**, or **双语**.
5. Watch the Rolling Summary refresh as the Session progresses; the panel asks your backend to extend the topic timeline as new transcript lands, and the Overview view reads back the same server data.
6. Select transcript text when you want an AI explanation, or save it directly as a timestamped note. Explanations are answered by the API's AI provider.
7. End the Session to generate the Session Digest; the API produces it and the panel renders the report, with everything readable from the web library.
8. Generate a course summary whenever you like, unfinished courses included, and regenerate after more study.
9. Administrators (accounts invited with the `--admin` flag) see a 站点管理 page in the web library to switch each platform's captions, ASR, and enabled flags; the extension follows the saved table.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Invited email + verification-code login on the web library, with the extension linked as one credential group that signs out together.
- Collection with platform-aware source matching, per-Source playback positions with optimistic concurrency, and timestamped notes.
- Session transcription through the backend worker: Bilibili-style captions archived directly when available, captured audio through the configured Speech Provider otherwise, at roughly 30 seconds per Segment.
- Course summaries generated on demand from all archived transcripts and notes, with citations that trace back to the original text and timestamp, and a usage panel.
- Panel AI features (rolling summary timeline, session digest, explanations) answered by the backend API, sharing the server's AI provider configuration with course summaries.
- Site capability administration: administrators switch per-platform captions/ASR/enabled flags from the web library, and the extension gates Session starts on the server's table.

Real-lesson provider evaluation from the PoC is tracked in [docs/poc-evaluation.md](docs/poc-evaluation.md). Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

## AI pricing

Bailian uses tiered pricing for `qwen3.8-flash`: the per-million-token rate depends on the input token size of each request. Current rates are listed on the [official model pricing page](https://help.aliyun.com/zh/model-studio/model-pricing). Check the official page before relying on these prices.

Session transcription is billed by your Speech Provider. A typical lesson costs a small fraction of a cent per hour of audio at current flash-model rates.

## Manual acceptance

Automated suites verify logic against contracts and stubs. Phase-one acceptance additionally requires real-platform walkthroughs (four-platform sample videos, background-tab tabCapture authorization, at least one real-ASR end-to-end run). The checklists are in [docs/round1-acceptance.md](docs/round1-acceptance.md) and [docs/round2-acceptance.md](docs/round2-acceptance.md).

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

Learning Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose.
- Build customized summary templates per course or topic.
- Turn saved notes into a spaced-repetition vocabulary notebook.
- Add another Source Platform adapter (the registry seam is ready).
- Group sources into courses; the Resource and Source model already reserves the relationship.

When you remix, first open the exact Learning Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Working on a guessed or copied folder silently changes nothing in the extension Chrome actually runs.

Read [PRIVACY.md](PRIVACY.md) for the complete data-flow description and [GLOSSARY.md](GLOSSARY.md) for the domain vocabulary (Session, Segment, Transcript, Rolling Summary, Session Digest, Source Platform, Speech Provider, AI Provider).
