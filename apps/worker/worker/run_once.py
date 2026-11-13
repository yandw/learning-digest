"""One worker cycle (ticket 4.5; Node ticket 2.3, lib/run-once.js;
contract-r2 §3.7, decision D13/D14): claim one task -> transcribe through
the Speech Provider seam -> submit the result -> summary. Concurrency is 1
(serial); a cycle claims one task and drains it before the next claim, so
a single worker never holds two segments in memory.

Division of labor on timestamps: the provider returns segment-relative
milliseconds; run_once folds them onto the source timeline by adding the
task's segment start (contract-r2 §1: everything the API stores is on the
source video timeline). Silence (records: []) is still done.

Error split: a provider failure is TASK-level and becomes a
transcription_failed result write-back (the contract's only round-2 task
error code, message carrying the provider detail for triage). A submit
failure lands in the same task-level catch and also attempts the failed
write-back instead of propagating — the API's 幂等首存 keeps that safe (if
the done result already landed, the failed write only replays the stored
terminal status), so the risk is bounded. A claim failure, or a failed
write-back that itself fails, is CYCLE-level and propagates to the loop,
which logs and backs off — retrying is the next poll."""

from __future__ import annotations

from typing import Any, Callable


def run_once(*, client: Any, provider: Any) -> dict[str, int]:
    response = client.claim(limit=1)
    tasks = response["tasks"]

    done = 0
    failed = 0
    for task in tasks:
        try:
            relative = provider["transcribe"](
                audio_base64=task["audioBase64"],
                audio_mime_type=task["audioMimeType"],
                segment={
                    "segmentIndex": task["segmentIndex"],
                    "startMs": task["startMs"],
                    "endMs": task["endMs"],
                },
            )
            records = [
                {
                    "startMs": task["startMs"] + record["startMs"],
                    "endMs": task["startMs"] + record["endMs"],
                    "text": record["text"],
                }
                for record in (relative or [])
            ]
            client.submit_result(task["taskId"], {"status": "done", "records": records})
            done += 1
        except Exception as error:
            message = str(error) or type(error).__name__
            client.submit_result(
                task["taskId"],
                {
                    "status": "failed",
                    "error": {"code": "transcription_failed", "message": message},
                },
            )
            failed += 1

    return {"claimed": len(tasks), "done": done, "failed": failed}
