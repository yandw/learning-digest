# Privacy

Effective: November 7, 2026

Learning Digest is a GitHub-only, bring-your-own-key Chrome extension. It has no Learning Digest account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, Learning Digest handles:

- the session ID and page URL you choose to digest;
- transcript text and timestamps;
- session metadata such as title, course name, description, and duration;
- text you select in the transcript and nearby transcript context;
- content you ask to translate;
- audio Segments you choose to transcribe, sent only to your configured Speech Provider;
- notes you save;
- AI Provider and Speech Provider configuration, including your API keys; and
- cached transcript, digest, and translation results.

## Where data goes

### AI Provider (DeepSeek)

The published version sends AI feature content to DeepSeek V4 Flash at `https://api.deepseek.com`:

- transcript plus relevant title, course, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese
  translation, or requested overview or explanation content.

The endpoint and `deepseek-v4-flash` model are fixed in the published Settings page. You provide one DeepSeek API key. To use another provider or model, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

### Speech Provider

When you run a Session, each Segment's audio is sent directly to the Speech Provider you configured (Groq by default, at `https://api.groq.com`) for transcription. Credentials stay in Chrome's local extension storage and are sent only to that provider.

AI requests go directly from the extension to the configured providers. They are authenticated with the keys you supply. Learning Digest's developer does not proxy or receive these requests.

DeepSeek, Groq, and any other configured provider process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

Learning Digest uses Chrome's local extension storage, not a Learning Digest cloud service.

- AI Provider and Speech Provider settings and API keys remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Session snapshots and recent transcript, digest, and per-segment translation cache entries are stored
  locally. The digest cache is limited to 20 sessions, and entries older than 30 days are
  removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes in Learning Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries; and
- revoke keys in the provider dashboards to stop their future use.

Clearing local data does not delete information already processed or retained by a provider. Use each service's controls for service-side requests.

## Permissions

Learning Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the Learning Digest interface beside the current tab.
- `storage`: store settings, keys, notes, Session snapshots, and cached results locally.
- `*.xiaoe-tech.com` host access: identify course pages and capture lesson audio on the first supported Source Platform.
- DeepSeek host access: provide AI overviews, explanations, and translation through DeepSeek V4 Flash.
- OpenRouter host access: allow AI features to use OpenRouter when it is configured as the AI provider in a local copy.
- Speech Provider host access (default `api.groq.com`): transcribe Session Segments through your configured Speech Provider.

Learning Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

Learning Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
