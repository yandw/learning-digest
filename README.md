# Learning Digest

[English](README.md) | [简体中文](README.zh-CN.md)

Turn live course audio into a learning resource with segment-by-segment transcription, rolling summaries, and a full-session digest.

Learning Digest is a Chrome side panel for studying long course lessons on learning platforms. You open a lesson, start a Session, and the extension captures the lesson audio in fixed-length Segments, transcribes each Segment exactly once through your chosen Speech Provider, keeps a rolling summary up to date, and builds a full-session digest when the Session ends. A Session is one continuous learning act, typically one lesson of two to three hours.

- Capture lesson audio on supported course platforms (first platform: xiaoe-tech.com) and turn it into a searchable, timestamped Transcript.
- Follow along with a Rolling Summary that is refreshed as new Segments are transcribed.
- Finish with a Session Digest built from the rolling summary and the full transcript.
- Study in the original language, Simplified Chinese, or an aligned bilingual view.
- Save timestamped notes from selected transcript text, and explain selected terms with your own AI key.

Learning Digest is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store, does not include API credits, and does not run a developer-operated server.

## Project status

This repository is an early proof of concept. The platform and provider seams are in place:

- the Session pipeline state machine and per-session persistence;
- the Speech Provider registry (Groq provider included; Tencent Cloud ASR and Aliyun ASR plug into the same seam);
- the AI Provider features (analysis, explanation, translation, notes) inherited from the seed project.

Source Platform capture for xiaoe-tech.com lands in a follow-up ticket. Until then, installing the extension gives you the side panel shell, working AI Provider features against cached transcripts, and full Settings, with no new capture started from course pages.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/learning-digest` on macOS or Linux, or `%USERPROFILE%\Documents\learning-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms. https://github.com/yandw/learning-digest

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/learning-digest` on macOS or Linux, or `%USERPROFILE%\Documents\learning-digest` on Windows.
2. Open the official DeepSeek page below and help you create your own account.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to enter your API keys in the extension's **Settings** page.
5. Explain how the side panel, Session pipeline, and Speech Provider settings fit together.

Keep this folder in the same place after installation. Moving or deleting the source folder breaks the unpacked extension until you load it again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the Learning Digest Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Open [github.com/yandw/learning-digest](https://github.com/yandw/learning-digest).
2. Choose **Code**, then **Download ZIP**.
3. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/learning-digest` on macOS or Linux, or `%USERPROFILE%\Documents\learning-digest` on Windows. You may use a different folder.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the exact project folder you chose, which must contain `manifest.json`.
8. Pin Learning Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the Learning Digest card at `chrome://extensions`, then refresh open course tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

Learning Digest uses your own DeepSeek API key for summaries, explanations, translation, and note features. Session transcription uses a Speech Provider, Groq by default, with its own key.

### Get a DeepSeek API key

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `Learning Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into **DeepSeek API key** in Learning Digest Settings.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

Open **Settings** from the side panel. You can also open the Learning Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

The published version supports DeepSeek V4 Flash as its only AI provider:

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

Learning Digest sends every DeepSeek request in non-thinking mode for responsive, predictable interactions. The endpoint and model are fixed in Settings, so the only AI credential you enter is your DeepSeek API key. To use another provider or model, copy the safe customization prompt in Settings and give it to a coding agent for your local copy. Never add an API key to that prompt or chat.

### Speech Provider key

Session transcription defaults to Groq:

```text
Base URL: https://api.groq.com/openai/v1
Model: whisper-large-v3-turbo
```

Add a Groq API key in the Speech Provider section of Settings. Tencent Cloud ASR and Aliyun ASR can be added to the same registry seam in a local copy.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Use Learning Digest

1. Open a lesson page on a supported course platform (xiaoe-tech.com support lands in a follow-up ticket).
2. Start a Session from the side panel when platform capture is available.
3. Read the timestamped Transcript as Segments are transcribed, or choose **Original**, **中文**, or **双语**.
4. Watch the Rolling Summary refresh as the Session progresses.
5. Open **Overview** for AI-generated chapters and key quotes.
6. Select transcript text when you want an AI explanation, or save it directly as a timestamped note.
7. End the Session to generate the Session Digest.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- The Session pipeline state machine with per-session persistence (resume after closing the tab mid-lesson).
- The Speech Provider seam with the Groq provider.
- AI overviews, selected-text explanations, translation, and local notes against transcripts already in the cache.
- Local notes and a local cache for recent transcript and digest results.
- DeepSeek V4 Flash for all published AI features. Other providers require a local code adaptation and are not supported by this published version.

Source Platform capture for xiaoe-tech.com is under active development and is not part of this snapshot. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

## DeepSeek V4 Flash pricing

As of August 27, 2026, DeepSeek lists these USD prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing):

| Token type | Off-peak | Peak |
| --- | ---: | ---: |
| Cache-hit input | $0.007 | $0.014 |
| Cache-miss input | $0.22 | $0.44 |
| Output | $0.66 | $1.32 |

Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday. All other hours use off-peak rates. Check the official page before relying on these prices.

Session transcription is billed by your Speech Provider. Groq's current Whisper pricing is listed on Groq's official pricing page; a typical lesson costs a small fraction of a cent per hour of audio.

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

Learning Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose.
- Build customized summary templates per course or topic.
- Turn saved notes into a spaced-repetition vocabulary notebook.
- Add another Source Platform adapter (the registry seam is ready).
- Add another Speech Provider (Tencent Cloud ASR, Aliyun ASR).

When you remix, first open the exact Learning Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Working on a guessed or copied folder silently changes nothing in the extension Chrome actually runs.

Read [PRIVACY.md](PRIVACY.md) for the complete data-flow description and [GLOSSARY.md](GLOSSARY.md) for the domain vocabulary (Session, Segment, Transcript, Rolling Summary, Session Digest, Source Platform, Speech Provider, AI Provider).
