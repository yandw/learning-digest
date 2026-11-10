# Learning Digest

A personal learning library for saving links to web materials and resuming study at the original Source. The desktop browser extension supports study on the original website.

## Language

### Learning Library

**Resource**:
An item in a learner's personal library, such as a standalone webpage or a lesson. A Resource can have multiple Sources.

**Source**:
A specific webpage or playable version on the original platform through which a learner accesses a Resource. A separately playable part is a distinct Source with its own playback position.

**Platform Video ID**:
The identifier assigned to a video by its original platform. Its scope is that platform.
_Avoid_: Clean ID

**Session**:
One continuous act of learning from a Source. A learner can return to the same Source in multiple Sessions.
_Avoid_: Lesson, class, recording

### Learning Content

**Transcript**:
The timestamped text of speech from a Source. It can cover the whole Source or just the part captured during a Session.
_Avoid_: Script

**Topic**:
A coherent subject covered within a time range of a Transcript.
_Avoid_: Block, chunk, chapter

**Course Summary**:
A learner-requested synthesis of a Resource's available Transcripts and notes. A learner can generate it at any point and request a new summary as more material becomes available.

**Study Guide**:
A learning aid organized around key Topics, with references to the Transcript and relevant portions of the original Source.

### Browser Extension

**Segment**:
A time-bounded slice of captured Session audio submitted for transcription as a unit.
_Avoid_: Chunk, clip, fragment

**Rolling Summary**:
The live, append-only Topic timeline that helps a learner follow what has been covered during a Session.
_Avoid_: Interim summary, merged running summary, periodic digest, running notes

**Session Digest**:
The summary of a completed Session, based on its full Transcript and organized by Topic.
_Avoid_: Final summary, complete overview

**Source Platform**:
A video or learning platform for which Learning Digest recognizes playable media and supports platform-specific learning assistance.
_Avoid_: Adapter, connector, integration, channel

### Providers

**Speech Provider**:
An external service that converts speech into Transcript records.
_Avoid_: ASR provider, transcription provider, STT

**AI Provider**:
An external model service that helps interpret or summarize learning content.
_Avoid_: LLM provider, model provider
