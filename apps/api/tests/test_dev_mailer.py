"""Slice 7: the dev Mailer implementation writes codes to a JSONL outbox
file (and stdout) so tests and the operator can read them until a real
email service account exists. No vendor SDKs ship in this repo. Ported
intent: apps/api/test/dev-mailer.test.js. Seams: the DevMailer file output
plus the HTTP boundary."""

import json
import os

from app.mailer import create_dev_mailer

LEARNER = "learner@example.com"


def test_dev_mailer_appends_the_code_to_the_outbox_file_readable_by_tests(start_app, tmp_path):
    out_file = str(tmp_path / "outbox.jsonl")
    app = start_app(seed_emails=[LEARNER], mailer=create_dev_mailer(out_file=out_file, log=False))
    response = app.request("POST", "/v1/auth/request-code", body={"email": LEARNER})
    assert response.status == 200

    with open(out_file, encoding="utf-8") as fh:
        lines = fh.read().strip().split("\n")
    assert len(lines) == 1
    mail = json.loads(lines[0])
    assert mail["to"] == LEARNER
    assert len(mail["code"]) == 6 and mail["code"].isdigit()
    assert mail["code"] in mail["text"]
    assert mail["sentAt"].startswith("20")


def test_dev_mailer_creates_missing_parent_directories(start_app, tmp_path):
    out_file = str(tmp_path / "nested" / "dir" / "outbox.jsonl")
    app = start_app(seed_emails=[LEARNER], mailer=create_dev_mailer(out_file=out_file, log=False))
    app.request("POST", "/v1/auth/request-code", body={"email": LEARNER})
    assert os.path.exists(out_file)
