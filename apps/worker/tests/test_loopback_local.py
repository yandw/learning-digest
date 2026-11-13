"""Loopback chain for the local provider (ticket 5.1 acceptance): a minimal
OpenAI-compatible transcription stub on a REAL loopback port (a LAN ASR
service stands in for faster-whisper-server / LocalAI / whisper.cpp; httpx
MockTransport cannot give the provider's real httpx client a socket to
speak multipart over), the real API subprocess, and the worker's real
client + config-built local provider. Walks 上传 -> claim -> local 转写 ->
result write-back -> GET transcript, with a multi-segment response folded
onto the source timeline (contract-r2 §1). No external network."""

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from test_local_provider import parse_multipart
from test_loopback_chain import ChainApp, SEGMENT_BODIES

from worker.config import create_provider_from_config, load_worker_config
from worker.loop import run_loop


class StubTranscriptionServer:
    """POST /v1/audio/transcriptions answering JSON keyed on the uploaded
    audio bytes, so each fixture segment gets a deterministic shape:
    a multi-segment response, a text-only response, and (unmapped) silence.
    Received request fields are recorded for the request-shape assertions."""

    def __init__(self, responses_by_audio: dict[bytes, dict]):
        self.requests = []
        self._responses = responses_by_audio
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                body = self.rfile.read(length)
                fields = parse_multipart(self.headers.get("content-type", ""), body)
                audio = fields["file"]["value"]
                payload = outer._responses.get(audio, {"text": ""})
                outer.requests.append(
                    {
                        "path": self.path,
                        "model": fields["model"]["value"].decode("utf-8"),
                        "language": fields["language"]["value"].decode("utf-8"),
                        "authorization": self.headers.get("Authorization"),
                        "file_content_type": fields["file"]["content_type"],
                        "file_bytes": audio,
                    }
                )
                data = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):  # keep pytest output clean
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def test_local_provider_chain_over_real_loopback_http(tmp_path):
    audio = {
        index: base64.b64decode(SEGMENT_BODIES[index]["audioBase64"])
        for index in (1, 2, 3)
    }
    stub = StubTranscriptionServer(
        {
            audio[1]: {
                "text": "第一句。第二句。",
                "segments": [
                    {"start": 0.0, "end": 2.5, "text": "第一句。"},
                    {"start": 2.5, "end": 5.0, "text": "第二句。"},
                ],
            },
            audio[2]: {"text": "第二段整段。"},
            audio[3]: {"text": "第三段。"},
        }
    )
    chain = ChainApp(tmp_path)
    try:
        account = chain.open_account_with_session()
        # Out of order: 3, 1, 2 — the server places them by segmentIndex.
        for index in [3, 1, 2]:
            assert chain.upload(account, index).status_code == 201

        # The worker config seam selects local (no token -> no Bearer header).
        config = load_worker_config(
            {"LD_WORKER_PROVIDER": "local", "LD_WORKER_LOCAL_BASE_URL": f"http://127.0.0.1:{stub.port}"}
        )
        provider = create_provider_from_config(config)
        assert provider["id"] == "local"

        summary = run_loop(
            client=chain.client,
            provider=provider,
            poll_interval_ms=1,
            max_cycles=4,
        )
        assert summary == {"cycles": 4, "done": 3, "failed": 0}

        # The LAN service saw three multipart transcription calls: the
        # config defaults (whisper-1 + zh), no auth, and the right audio
        # (claims return tasks in segmentIndex order, so 1, 2, 3).
        assert len(stub.requests) == 3
        for call, expected_audio in zip(stub.requests, [audio[1], audio[2], audio[3]]):
            assert call["path"] == "/v1/audio/transcriptions"
            assert call["model"] == "whisper-1"
            assert call["language"] == "zh"
            assert call["authorization"] is None
            assert call["file_content_type"] == "audio/webm;codecs=opus"
            assert call["file_bytes"] == expected_audio

        # The archive: segments folded from provider-relative seconds to
        # source-timeline milliseconds, records sorted by startMs, origin asr.
        view = chain.transcript(account)
        assert [
            {"startMs": r["startMs"], "endMs": r["endMs"], "text": r["text"], "origin": r["origin"]}
            for r in view["records"]
        ] == [
            {"startMs": 30000, "endMs": 32500, "text": "第一句。", "origin": "asr"},
            {"startMs": 32500, "endMs": 35000, "text": "第二句。", "origin": "asr"},
            {"startMs": 60000, "endMs": 90000, "text": "第二段整段。", "origin": "asr"},
            {"startMs": 90000, "endMs": 120000, "text": "第三段。", "origin": "asr"},
        ]
        assert view["pending"] == []
        assert view["failed"] == []
        assert view["gaps"] == []
        assert view["origin"] == "asr"

        # D14: every done task's audio file is gone; the queue is drained.
        assert chain.audio_files() == 0
        assert chain.client.claim(limit=1) == {"tasks": []}
    finally:
        chain.close()
        stub.close()
