# Privacy

Effective: July 28, 2026

YouTube Digest is a GitHub-only, bring-your-own-key Chrome extension. It has no YouTube Digest account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, YouTube Digest handles:

- the canonical URL and video ID of the active YouTube video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- DeepSeek configuration, including your API key;
- retained Speech Transcription provider configuration, including any previously saved API key; and
- cached transcript, digest, and translation results.

## Where data goes

### DeepSeek

The published version sends AI feature content to DeepSeek V4 Flash at `https://api.deepseek.com`:

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese
  translation, or requested overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note.

The endpoint and `deepseek-v4-flash` model are fixed in the published Settings page. You provide one DeepSeek API key. To use another provider or model, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

### Speech Transcription provider

The current version does not perform Speech Transcription: it does not record audio or send audio to Groq or any other transcription provider. Previously saved Speech Transcription settings remain in local extension storage for compatibility but are not used.

AI requests go directly from the extension to DeepSeek. They are authenticated with the key you supply. YouTube Digest's developer does not proxy or receive these requests.

DeepSeek processes data under its own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless its terms and your obligations permit it.

## Local storage and retention

YouTube Digest uses Chrome's local extension storage, not a YouTube Digest cloud service.

- DeepSeek and Speech Transcription settings and API keys remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes in YouTube Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries; and
- revoke keys in the DeepSeek dashboard, or your Speech Transcription provider's dashboard, to stop their future use.

Clearing local data does not delete information already processed or retained by DeepSeek or a Speech Transcription provider. Use each service's controls for service-side requests.

## Permissions

YouTube Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the YouTube Digest interface beside YouTube.
- `storage`: store settings, keys, notes, and cached results locally.
- `tabs`: identify and interact with the active YouTube tab.
- `scripting`: coordinate the extension's YouTube page controls.
- YouTube host access: read the active video's URL, metadata, and caption tracks, and provide timestamp controls.
- DeepSeek host access: provide AI overviews, explanations, translation, and note polishing through DeepSeek V4 Flash.
- OpenRouter host access: allow AI features to use OpenRouter when it is configured as the AI provider in a local copy.
- Speech Transcription provider host access (default `api.groq.com`) remains declared for compatibility with retained settings, but the current version does not use it.

YouTube Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

YouTube Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
