# Privacy

Effective: November 15, 2026

Learning Digest is a GitHub-only, bring-your-own-key project. It has no Learning Digest account, developer-operated backend, analytics, advertising, or telemetry. You run the learning service (backend API, transcription worker, web library) yourself; all AI and speech-transcription processing happens inside that self-deployed service, under your own accounts and keys.

## Data the extension handles

Depending on the feature you use, Learning Digest handles:

- the session ID and page URL you choose to digest;
- transcript text and timestamps;
- session metadata such as title, course name, description, and duration;
- text you select in the transcript and nearby transcript context;
- content you ask to explain;
- audio Segments you choose to transcribe, sent only to your own backend API;
- notes you save;
- your learning service base URLs, session and Segment settings; and
- cached transcript, digest, and session-snapshot results.

No AI Provider or Speech Provider API key is stored in, or entered into, the extension. Provider keys live only in the environment of your own backend processes.

## Where data goes

### Your learning service first

The browser extension talks only to the learning service base URLs you configure (the backend API and the web library) and to the course platform pages themselves. It does not call any AI or Speech Provider directly.

### AI processing (backend API, Alibaba Cloud Bailian by default)

All AI features run on the API process of your own backend, which sends the AI requests to the configured provider (the published version uses Alibaba Cloud Bailian at `https://dashscope.aliyuncs.com/compatible-mode/v1`, serving the qwen3.8-flash model):

- transcript plus session context for the panel's rolling summary topics and the session digest;
- requested explanation content for selected text; and
- aggregated transcripts and notes for course summaries.

The endpoint and `qwen3.8-flash` model are fixed in the published backend configuration. You provide one Bailian API key as the API's `LD_AI_API_KEY` environment variable. To use another provider or model, you adapt your own local source copy. Your coding agent can help, and the repository warns you never to include an API key in that prompt or chat.

### Speech Provider (transcription worker)

When you run a Session, each Segment's audio is sent to your backend API, which queues a transcription task. Your transcription worker pulls the task and sends the audio onward to the Speech Provider configured in its environment (Qwen ASR on Alibaba Cloud Bailian by default, at `https://dashscope.aliyuncs.com`). The worker holds the speech credentials; the extension never sees or sends them.

AI and ASR requests are therefore made by your self-deployed backend processes, authenticated with the keys you configured there. Learning Digest's developer does not proxy or receive these requests.

Alibaba Cloud Bailian, and any other configured provider, process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

Learning Digest uses Chrome's local extension storage, not a Learning Digest cloud service.

- The extension stores settings and the learning service base URLs, never provider API keys. A settings migration removes legacy AI and speech keys left by earlier versions the first time it reads them.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Session snapshots and recent transcript, digest, and per-segment translation cache entries are stored
  locally. The digest cache is limited to 20 sessions, and entries older than 30 days are
  removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

Your backend also stores data: accounts, resources, notes, transcripts, summaries, digests, and usage counters live in the API's state file, and temporary audio Segments in the API's audio directory. Delete that state (and the audio directory) to remove it.

To remove data:

- delete individual saved notes in Learning Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, notes, and cache entries;
- revoke keys in the provider dashboards to stop their future use; and
- delete the API's state file to erase the server-side copies.

Clearing local data does not delete information already processed or retained by a provider. Use each service's controls for service-side requests.

## Permissions

Learning Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the Learning Digest interface beside the current tab.
- `storage`: store settings, notes, Session snapshots, and cached results locally.
- `tabs`: list course tabs so you can pick the one to study, and detect a studied tab closing.
- `tabCapture` and `offscreen`: capture the studied tab's audio when a Session uses the ASR path.
- `*.xiaoe-tech.com` host access: identify course pages and capture lesson audio on the first supported Source Platform.
- Legacy host permissions (`dashscope.aliyuncs.com`, `openrouter.ai`, `api.deepseek.com`): left over from versions where the extension called AI and speech providers directly. The shipped flows no longer contact these origins from the browser; AI and transcription run on your backend. They remain declared for local-copy compatibility and can be removed in your own copy.

Learning Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

Learning Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
