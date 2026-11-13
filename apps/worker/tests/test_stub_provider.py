"""Stub Speech Provider (ticket 4.5; Node ticket 2.3; Testing Decisions:
a replacement Speech Provider makes tests repeatable). Ported intent:
apps/worker/test/stub-provider.test.js.

Seam: provider["transcribe"] — the same interface the real Qwen provider
implements. Deterministic sample text and timestamps so every run is
repeatable; a zero-byte audio input models a silence segment."""

from worker.providers.stub import create_stub_provider


def test_transcribes_one_segment_into_a_deterministic_record():
    provider = create_stub_provider()
    records = provider["transcribe"](
        audio_base64="ZmFrZSBhdWRpbyBieXRlcw==",  # "fake audio bytes"
        audio_mime_type="audio/webm;codecs=opus",
        segment={"segmentIndex": 3, "startMs": 90000, "endMs": 120000},
    )

    # Segment-relative milliseconds: runOnce folds them onto the source
    # timeline, so the provider itself never knows absolute positions.
    assert records == [{"startMs": 0, "endMs": 30000, "text": "stub 转写文本（第 3 段）"}]

    # Repeatable: the same input yields the same output.
    again = provider["transcribe"](
        audio_base64="ZmFrZSBhdWRpbyBieXRlcw==",
        audio_mime_type="audio/webm;codecs=opus",
        segment={"segmentIndex": 3, "startMs": 90000, "endMs": 120000},
    )
    assert records == again


def test_zero_byte_audio_is_a_silence_segment():
    provider = create_stub_provider()
    records = provider["transcribe"](
        audio_base64="",
        audio_mime_type="audio/webm;codecs=opus",
        segment={"segmentIndex": 0, "startMs": 0, "endMs": 30000},
    )
    assert records == []
