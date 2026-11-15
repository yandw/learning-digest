"""App config (ticket 5.8, issue #97): the config-file layer. The seam is
`load_config(env, config_file)` — apps/api/config.json (when it exists)
holds base values keyed by the camelCase names, environment variables
override them, the built-in defaults fill the rest. A missing file is the
pre-5.8 behavior (env/defaults only); invalid JSON fails at startup with
the file path. config_file=None keeps the loader off the filesystem — unit
tests stay hermetic against a developer's real config.json; the production
entrypoint (app/main.py) passes DEFAULT_CONFIG_FILE. PORT stays
script-managed (dev.sh) and is never a config-file field."""

import json
import os
import tempfile

import pytest

from app.config import DEFAULT_CONFIG_FILE, load_config

API_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write_config_file(tmp_path, payload):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def test_load_config_defaults_match_the_entrypoint_tables():
    config = load_config({})
    assert config["workerToken"] == ""
    assert config["aiProvider"] == ""
    assert config["aiApiKey"] == ""
    assert config["aiModel"] == ""
    assert config["aiBaseUrl"] == ""
    assert config["aiTimeoutMs"] == 120000
    # The data-path defaults are the pre-5.8 entrypoint defaults: files
    # next to the API package (data/state.json, invites seed, outbox) and
    # the system temp audio directory.
    assert config["stateFile"] == os.path.join(API_ROOT, "data", "state.json")
    assert config["inviteSeed"] == os.path.join(API_ROOT, "data", "invites.seed.json")
    assert config["outboxFile"] == os.path.join(API_ROOT, "data", "outbox.jsonl")
    assert config["audioDir"] == os.path.join(tempfile.gettempdir(), "ld-api-audio")


def test_missing_config_file_changes_nothing(tmp_path):
    config = load_config({}, config_file=str(tmp_path / "config.json"))
    assert config == load_config({})


def test_config_file_values_form_the_base_layer(tmp_path):
    path = write_config_file(
        tmp_path,
        {
            "_comment": "field docs live in README (服务配置文件)",
            "workerToken": "file-worker-secret",
            "aiProvider": "qwen",
            "aiApiKey": "sk-file",
            "aiModel": "qwen3.8-flash",
            "aiBaseUrl": "https://file.example.com/v1",
            "aiTimeoutMs": 90000,
            "stateFile": str(tmp_path / "state.json"),
            "inviteSeed": str(tmp_path / "seed.json"),
            "outboxFile": str(tmp_path / "outbox.jsonl"),
            "audioDir": str(tmp_path / "audio"),
        },
    )
    config = load_config({}, config_file=path)
    assert config["workerToken"] == "file-worker-secret"
    assert config["aiProvider"] == "qwen"
    assert config["aiApiKey"] == "sk-file"
    assert config["aiModel"] == "qwen3.8-flash"
    assert config["aiBaseUrl"] == "https://file.example.com/v1"
    assert config["aiTimeoutMs"] == 90000
    assert config["stateFile"] == str(tmp_path / "state.json")
    assert config["inviteSeed"] == str(tmp_path / "seed.json")
    assert config["outboxFile"] == str(tmp_path / "outbox.jsonl")
    assert config["audioDir"] == str(tmp_path / "audio")


def test_env_overrides_the_config_file(tmp_path):
    # Precedence env > file > defaults; the file still supplies what env
    # did not set.
    path = write_config_file(
        tmp_path,
        {
            "workerToken": "file-worker-secret",
            "aiProvider": "qwen",
            "aiApiKey": "sk-file",
            "aiTimeoutMs": 90000,
            "stateFile": str(tmp_path / "file-state.json"),
        },
    )
    config = load_config(
        {
            "LD_API_WORKER_TOKEN": "env-worker-secret",
            "LD_AI_PROVIDER": "local-qwen",
            "LD_AI_API_KEY": "sk-env",
            "LD_AI_TIMEOUT_MS": "60000",
            "LD_API_STATE_FILE": str(tmp_path / "env-state.json"),
        },
        config_file=path,
    )
    assert config["workerToken"] == "env-worker-secret"
    assert config["aiProvider"] == "local-qwen"
    assert config["aiApiKey"] == "sk-env"
    assert config["aiTimeoutMs"] == 60000
    assert config["stateFile"] == str(tmp_path / "env-state.json")
    assert config["aiModel"] == ""


def test_invalid_json_in_config_file_fails_fast_with_the_path(tmp_path):
    path = tmp_path / "config.json"
    path.write_text('{"workerToken": "unterminated', encoding="utf-8")
    with pytest.raises(ValueError) as error:
        load_config({}, config_file=str(path))
    assert str(path) in str(error.value)
    assert "JSON" in str(error.value)


def test_non_object_config_file_fails_fast_with_the_path(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(ValueError) as error:
        load_config({}, config_file=str(path))
    assert str(path) in str(error.value)


def test_default_config_file_points_at_apps_api_config_json():
    assert os.path.basename(DEFAULT_CONFIG_FILE) == "config.json"
    assert os.path.basename(os.path.dirname(DEFAULT_CONFIG_FILE)) == "api"
    assert os.path.exists(os.path.join(os.path.dirname(DEFAULT_CONFIG_FILE), "pyproject.toml"))


def test_build_app_wires_config_file_values_into_the_context(tmp_path):
    # The production entrypoint reads the same layer: the worker credential
    # and AI settings from config.json reach the app config, and the store /
    # mailer / seed files come from the file's path fields (worker endpoints
    # still fail closed when the token is set nowhere).
    from app.main import build_app

    path = write_config_file(
        tmp_path,
        {
            "workerToken": "file-worker-secret",
            "aiApiKey": "sk-file",
            "aiTimeoutMs": 90000,
            "stateFile": str(tmp_path / "state.json"),
            "inviteSeed": str(tmp_path / "seed.json"),
            "outboxFile": str(tmp_path / "outbox.jsonl"),
            "audioDir": str(tmp_path / "audio"),
        },
    )
    app = build_app({}, config_file=path)
    ctx = app.state.ctx
    assert ctx.config.worker_token == "file-worker-secret"
    assert ctx.config.ai_api_key == "sk-file"
    assert ctx.config.ai_timeout_ms == 90000
    assert ctx.config.audio_dir == str(tmp_path / "audio")
    assert ctx.store.file == str(tmp_path / "state.json")
    assert ctx.seed_file == str(tmp_path / "seed.json")


def test_build_app_without_a_config_file_keeps_the_env_only_behavior(tmp_path):
    # Zero breakage: env wiring alone behaves exactly as before ticket 5.8.
    from app.main import build_app

    app = build_app(
        {
            "LD_API_STATE_FILE": str(tmp_path / "state.json"),
            "LD_API_INVITE_SEED": str(tmp_path / "seed.json"),
            "LD_API_OUTBOX_FILE": str(tmp_path / "outbox.jsonl"),
            "LD_API_WORKER_TOKEN": "env-worker-secret",
        }
    )
    ctx = app.state.ctx
    assert ctx.config.worker_token == "env-worker-secret"
    assert ctx.store.file == str(tmp_path / "state.json")
    assert ctx.seed_file == str(tmp_path / "seed.json")
