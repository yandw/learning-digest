# Learning Digest

A Chrome side panel that turns course content on any learning platform into a learning resource: segment-by-segment transcription, rolling summaries, and a full-session digest. Platform and speech-to-text providers are both switchable.

## Language

**Session**:
One continuous learning act, from the user pressing "start learning" to pressing "end". Corresponds to one lesson (typically 2–3 hours). Deliberately has no Course-level grouping.
_Avoid_: Lesson, class, recording

**Segment**:
A fixed-length slice of the session's audio (about 2 minutes), the smallest unit submitted to speech-to-text exactly once. Segment length is provider-dependent and user-configurable.
_Avoid_: Chunk, clip, fragment

**Transcript**:
The timestamped text of what is said in a Session, assembled Segment by Segment. The single input for every AI feature (rolling summary, digest, notes).
_Avoid_: Subtitles text, script, 逐字稿 (in English docs)

**Rolling Summary**:
The periodically refreshed running summary of the Session so far, produced by merging the previous Rolling Summary with the current period's new Transcript. Only the latest one is kept.
_Avoid_: Interim summary, periodic digest, running notes

**Session Digest**:
The final full-length output generated when a Session ends, built from the latest Rolling Summary plus any Transcript not yet covered by it.
_Avoid_: Final summary, complete overview

**Source Platform**:
A switchable adapter for one learning platform (first: xiaoe-tech.com). Identifies its pages, locates the media, and exposes platform-specific capture to the rest of the extension. New platforms plug in without touching the core pipeline.
_Avoid_: Adapter, connector, integration, channel

**Speech Provider**:
A switchable speech-to-text service (Groq, Tencent Cloud ASR, Aliyun ASR) with its own credentials and endpoint, responsible for turning one Segment's audio into Transcript records.
_Avoid_: ASR provider, transcription provider, STT

**AI Provider**:
The external chat-completion service used for Rolling Summary, Session Digest, Translation, Explain, and note cleanup. Configured with its own base URL, API key, and model. Distinct from Speech Provider.
_Avoid_: LLM provider, model provider
