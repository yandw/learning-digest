"""Worker config (ticket 4.5; Node ticket 2.3): env wiring only — the
provider seam and the loop are the behavior. Ported intent:
apps/worker/test/config.test.js. apiBase / token / provider / poll interval
come from LD_WORKER_* env vars; the Qwen key from QWEN_API_KEY. A qwen
selection without a key fails at startup (fail fast, not per task).

Ticket 5.8 (#97) adds the config-file layer: apps/worker/config.json (when
it exists) is the base values layer, env overrides it, DEFAULTS fill the
rest. config_file=None keeps the pure env/defaults behavior — unit tests
stay hermetic against a developer's real config.json; the production
entrypoint (worker/main.py) passes DEFAULT_CONFIG_FILE."""

import json

import pytest

from worker.config import (
    create_provider_from_config,
    load_worker_config,
)


def write_config_file(tmp_path, payload):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_defaults_to_the_loopback_api_stub_provider_and_5s_poll():
    config = load_worker_config({})
    assert config == {
        "apiBase": "http://127.0.0.1:8787",
        "token": "",
        "provider": "stub",
        "pollIntervalMs": 5000,
        "errorBackoffMs": None,
        "qwenApiKey": "",
        "qwenBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "qwenModel": "qwen3-asr-flash",
        "qwenTimeoutMs": 120000,
        "localBaseUrl": "",
        "localModel": "whisper-1",
        "localToken": "",
        "localLanguage": "zh",
        "localMimeType": "",
        "localResponseFormat": "verbose_json",
    }


def test_env_overrides_flow_through():
    config = load_worker_config(
        {
            "LD_WORKER_API_BASE": "https://api.example.com",
            "LD_WORKER_TOKEN": "worker-secret",
            "LD_WORKER_PROVIDER": "qwen",
            "LD_WORKER_POLL_INTERVAL_MS": "12000",
            "QWEN_API_KEY": "sk-test",
            "LD_WORKER_QWEN_BASE_URL": "https://mirror.example.com/v1/",
            "LD_WORKER_QWEN_MODEL": "qwen3-asr-flash-test",
            "LD_WORKER_QWEN_TIMEOUT_MS": "90000",
        }
    )
    assert config["apiBase"] == "https://api.example.com"
    assert config["token"] == "worker-secret"
    assert config["provider"] == "qwen"
    assert config["pollIntervalMs"] == 12000
    assert config["qwenApiKey"] == "sk-test"
    assert config["qwenBaseUrl"] == "https://mirror.example.com/v1/"
    assert config["qwenModel"] == "qwen3-asr-flash-test"
    assert config["qwenTimeoutMs"] == 90000


def test_local_env_overrides_flow_through():
    config = load_worker_config(
        {
            "LD_WORKER_PROVIDER": "local",
            "LD_WORKER_LOCAL_BASE_URL": "http://nas.local:9000",
            "LD_WORKER_LOCAL_MODEL": "whisper-large-v3",
            "LD_WORKER_LOCAL_TOKEN": "lan-secret",
            "LD_WORKER_LOCAL_LANGUAGE": "en",
            "LD_WORKER_LOCAL_MIME_TYPE": "audio/wav",
        }
    )
    assert config["provider"] == "local"
    assert config["localBaseUrl"] == "http://nas.local:9000"
    assert config["localModel"] == "whisper-large-v3"
    assert config["localToken"] == "lan-secret"
    assert config["localLanguage"] == "en"
    assert config["localMimeType"] == "audio/wav"


def test_unknown_provider_selection_fails_at_startup():
    config = load_worker_config({})
    config["provider"] = "magic"
    try:
        create_provider_from_config(config)
    except Exception as error:
        assert "unknown LD_WORKER_PROVIDER" in str(error)
    else:
        raise AssertionError("unknown provider must fail at startup")


def test_qwen_without_an_api_key_fails_at_startup():
    # Fail fast, not per task: the factory throws before any request.
    config = load_worker_config({})
    config["provider"] = "qwen"
    try:
        create_provider_from_config(config)
    except Exception as error:
        assert "requires a Bailian API key" in str(error)
    else:
        raise AssertionError("qwen without a key must fail at startup")

    # And with a key it builds.
    config["qwenApiKey"] = "sk-test"
    provider = create_provider_from_config(config)
    assert provider["id"] == "qwen"


def test_stub_provider_builds_without_any_key():
    provider = create_provider_from_config(load_worker_config({}))
    assert provider["id"] == "stub"


def test_local_without_a_base_url_fails_at_startup():
    # Fail fast, not per task: the factory throws before any request.
    config = load_worker_config({})
    config["provider"] = "local"
    try:
        create_provider_from_config(config)
    except Exception as error:
        assert "LD_WORKER_LOCAL_BASE_URL" in str(error)
    else:
        raise AssertionError("local without a base url must fail at startup")

    # And with a base url it builds.
    config["localBaseUrl"] = "http://nas.local:9000"
    provider = create_provider_from_config(config)
    assert provider["id"] == "local"


def test_local_selection_uses_the_provider_defaults():
    config = load_worker_config({})
    config["provider"] = "local"
    config["localBaseUrl"] = "http://nas.local:9000/"
    provider = create_provider_from_config(config)
    assert provider["id"] == "local"
    # model/language/mime defaults land in the request shape, pinned at the
    # HTTP seam in test_local_provider.py.


def test_missing_config_file_changes_nothing(tmp_path):
    # Zero breakage: without apps/worker/config.json the loader is exactly
    # the pre-5.8 env/defaults loader.
    config = load_worker_config({}, config_file=tmp_path / "config.json")
    assert config == load_worker_config({})


def test_config_file_values_form_the_base_layer(tmp_path):
    path = write_config_file(
        tmp_path,
        {
            "_comment": "field docs live in README (Service configuration files)",
            "apiBase": "https://api.example.com",
            "token": "file-secret",
            "provider": "qwen",
            "pollIntervalMs": 12000,
            "errorBackoffMs": 20000,
            "qwenApiKey": "sk-file",
        },
    )
    config = load_worker_config({}, config_file=path)
    assert config["apiBase"] == "https://api.example.com"
    assert config["token"] == "file-secret"
    assert config["provider"] == "qwen"
    assert config["pollIntervalMs"] == 12000
    assert config["errorBackoffMs"] == 20000
    assert config["qwenApiKey"] == "sk-file"
    # Unknown keys (the _comment pointer) and untouched fields keep the
    # built-in defaults.
    assert config["qwenModel"] == "qwen3-asr-flash"
    assert config["localLanguage"] == "zh"


def test_env_overrides_the_config_file(tmp_path):
    # Precedence env > file > defaults, per ticket 5.8.
    path = write_config_file(
        tmp_path,
        {
            "token": "file-secret",
            "apiBase": "https://file.example.com",
            "provider": "qwen",
            "pollIntervalMs": 12000,
            "qwenApiKey": "sk-file",
        },
    )
    config = load_worker_config(
        {
            "LD_WORKER_TOKEN": "env-secret",
            "LD_WORKER_API_BASE": "https://env.example.com",
            "LD_WORKER_PROVIDER": "local",
            "LD_WORKER_POLL_INTERVAL_MS": "9000",
            "QWEN_API_KEY": "sk-env",
            "LD_WORKER_LOCAL_BASE_URL": "http://nas.local:9000",
        },
        config_file=path,
    )
    assert config["token"] == "env-secret"
    assert config["apiBase"] == "https://env.example.com"
    assert config["provider"] == "local"
    assert config["pollIntervalMs"] == 9000
    assert config["qwenApiKey"] == "sk-env"
    # The file still supplies what env did not set.
    assert config["localModel"] == "whisper-1"


def test_invalid_json_in_config_file_fails_fast_with_the_path(tmp_path):
    path = tmp_path / "config.json"
    path.write_text('{"token": "unterminated', encoding="utf-8")
    with pytest.raises(ValueError) as error:
        load_worker_config({}, config_file=path)
    # Fail fast, with the file path named so the operator can fix it.
    assert str(path) in str(error.value)
    assert "JSON" in str(error.value)


def test_non_object_config_file_fails_fast_with_the_path(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(ValueError) as error:
        load_worker_config({}, config_file=path)
    assert str(path) in str(error.value)


def test_qwen_api_key_from_the_file_builds_the_provider(tmp_path):
    # Key semantics: QWEN_API_KEY env and the file's qwenApiKey are the same
    # seam — either alone satisfies the fail-fast startup check.
    path = write_config_file(tmp_path, {"provider": "qwen", "qwenApiKey": "sk-file"})
    provider = create_provider_from_config(load_worker_config({}, config_file=path))
    assert provider["id"] == "qwen"


def test_default_config_file_points_at_apps_worker_config_json():
    # The production entrypoint wires this path in; it must be the
    # documented location next to pyproject.toml (apps/worker/config.json).
    from worker.config import DEFAULT_CONFIG_FILE

    assert DEFAULT_CONFIG_FILE.name == "config.json"
    assert DEFAULT_CONFIG_FILE.parent.name == "worker"
    assert (DEFAULT_CONFIG_FILE.parent / "pyproject.toml").exists()
