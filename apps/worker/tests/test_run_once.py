"""run_once — one worker cycle (ticket 4.5): claim -> transcribe -> submit.
Ported intent: apps/worker/test/run-once.test.js.

Seam: run_once(client=..., provider=...) with a scripted fake client — the
client is the worker's own HTTP seam (exercised for real against the
loopback API in the chain test), and the provider is the Speech Provider
seam. This file pins the cycle semantics: claim limit 1 per cycle,
timestamp folding onto the source timeline, silence still done, provider
failure -> transcription_failed result, serial processing."""

from worker.run_once import run_once


class FakeClient:
    """Scripted claim responses; submit_result bodies are recorded."""

    def __init__(self, claim_pages):
        self.submissions = []
        self.claim_pages = claim_pages
        self.page = 0

    def claim(self, limit=None):
        tasks = self.claim_pages[min(self.page, len(self.claim_pages) - 1)] or []
        self.page += 1
        return {"tasks": tasks}

    def submit_result(self, task_id, body):
        self.submissions.append({"taskId": task_id, "body": body})
        return {"taskId": task_id, "status": body["status"]}


def task(task_id, segment_index=0, start_ms=0):
    return {
        "taskId": task_id,
        "sessionId": "s",
        "sourceId": "r",
        "segmentIndex": segment_index,
        "startMs": start_ms,
        "endMs": start_ms + 30000,
        "audioMimeType": "m",
        "audioBase64": "YQ==",
    }


def stub_transcribe(**kwargs):
    segment = kwargs["segment"]
    return [
        {"startMs": 0, "endMs": segment["endMs"] - segment["startMs"], "text": "segment text"}
    ]


def test_empty_claim_is_the_idle_cycle():
    client = FakeClient([[]])
    provider_calls = []

    def provider(**kwargs):
        provider_calls.append(kwargs)
        return []

    summary = run_once(client=client, provider={"id": "stub", "transcribe": provider})

    assert summary == {"claimed": 0, "done": 0, "failed": 0}
    assert provider_calls == []
    assert client.submissions == []


def test_transcribes_the_claimed_segment_and_submits_folded_records():
    client = FakeClient(
        [
            [
                {
                    "taskId": "tsk_1",
                    "sessionId": "ses_1",
                    "sourceId": "src_1",
                    "segmentIndex": 1,
                    "startMs": 30000,
                    "endMs": 60000,
                    "audioMimeType": "audio/webm;codecs=opus",
                    "audioBase64": "U29tZV9hdWRpb19ieXRlcw==",
                }
            ]
        ]
    )
    provider_inputs = []

    def provider(**kwargs):
        provider_inputs.append(kwargs)
        return [{"startMs": 0, "endMs": 30000, "text": "注意力分数的计算"}]

    summary = run_once(client=client, provider={"id": "stub", "transcribe": provider})

    assert summary == {"claimed": 1, "done": 1, "failed": 0}
    # The provider receives the claim task verbatim (segment-relative output).
    assert provider_inputs == [
        {
            "audio_base64": "U29tZV9hdWRpb19ieXRlcw==",
            "audio_mime_type": "audio/webm;codecs=opus",
            "segment": {"segmentIndex": 1, "startMs": 30000, "endMs": 60000},
        }
    ]
    # The result carries source-timeline timestamps (worker folds).
    assert client.submissions == [
        {
            "taskId": "tsk_1",
            "body": {
                "status": "done",
                "records": [{"startMs": 30000, "endMs": 60000, "text": "注意力分数的计算"}],
            },
        }
    ]


def test_every_record_of_a_multi_record_transcript_is_folded_onto_the_timeline():
    """Providers that segment internally (local ASR with
    {text, segments: [{start, end, text}]} in seconds -> ms records) return
    several records per task; each one shifts by the task's segment start
    (contract-r2 §1: stored timestamps are all on the source timeline)."""
    client = FakeClient([[task("tsk_multi", segment_index=1, start_ms=30000)]])

    def provider(**kwargs):
        # Segment-relative: two utterances inside the 30s task segment.
        return [
            {"startMs": 0, "endMs": 2500, "text": "第一句。"},
            {"startMs": 2500, "endMs": 12000, "text": "第二句。"},
        ]

    summary = run_once(client=client, provider={"id": "local", "transcribe": provider})

    assert summary == {"claimed": 1, "done": 1, "failed": 0}
    assert client.submissions == [
        {
            "taskId": "tsk_multi",
            "body": {
                "status": "done",
                "records": [
                    {"startMs": 30000, "endMs": 32500, "text": "第一句。"},
                    {"startMs": 32500, "endMs": 42000, "text": "第二句。"},
                ],
            },
        }
    ]


def test_silence_is_submitted_as_done_with_an_empty_records_array():
    client = FakeClient(
        [
            [
                {
                    "taskId": "tsk_silence",
                    "sessionId": "ses_1",
                    "sourceId": "src_1",
                    "segmentIndex": 0,
                    "startMs": 0,
                    "endMs": 30000,
                    "audioMimeType": "audio/webm;codecs=opus",
                    "audioBase64": "",
                }
            ]
        ]
    )
    summary = run_once(
        client=client, provider={"id": "stub", "transcribe": lambda **kwargs: []}
    )
    assert summary == {"claimed": 1, "done": 1, "failed": 0}
    assert client.submissions == [
        {"taskId": "tsk_silence", "body": {"status": "done", "records": []}}
    ]


def test_provider_failure_submits_the_transcription_failed_feedback():
    client = FakeClient([[task("tsk_2", segment_index=2, start_ms=60000)]])

    def failing(**kwargs):
        raise RuntimeError("Qwen Speech Provider request failed with HTTP 429")

    summary = run_once(client=client, provider={"id": "qwen", "transcribe": failing})
    assert summary == {"claimed": 1, "done": 0, "failed": 1}
    assert client.submissions == [
        {
            "taskId": "tsk_2",
            "body": {
                "status": "failed",
                "error": {
                    "code": "transcription_failed",
                    "message": "Qwen Speech Provider request failed with HTTP 429",
                },
            },
        }
    ]


def test_multiple_claimed_tasks_are_processed_serially_in_claim_order():
    client = FakeClient(
        [[task("tsk_a", segment_index=1), task("tsk_b", segment_index=2, start_ms=30000)]]
    )
    order = []

    def provider(**kwargs):
        segment = kwargs["segment"]
        order.append(segment["segmentIndex"])
        return [{"startMs": 0, "endMs": 1000, "text": f"text {segment['segmentIndex']}"}]

    summary = run_once(client=client, provider={"id": "stub", "transcribe": provider})

    assert summary == {"claimed": 2, "done": 2, "failed": 0}
    assert order == [1, 2]
    assert [submission["taskId"] for submission in client.submissions] == ["tsk_a", "tsk_b"]


def test_claim_failure_propagates_to_the_loop():
    class FailingClient:
        def claim(self, limit=None):
            raise RuntimeError("claim unauthorized")

        def submit_result(self, task_id, body):
            raise AssertionError("should not submit")

    try:
        run_once(
            client=FailingClient(),
            provider={"id": "stub", "transcribe": stub_transcribe},
        )
    except RuntimeError as error:
        assert "claim unauthorized" in str(error)
    else:
        raise AssertionError("claim failure must propagate (cycle-level, not task-level)")
