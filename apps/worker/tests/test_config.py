"""Worker config (ticket 4.5; Node ticket 2.3): env wiring only — the
provider seam and the loop are the behavior. Ported intent:
apps/worker/test/config.test.js. apiBase / token / provider / poll interval
come from LD_WORKER_* env vars; the Qwen key from QWEN_API_KEY. A qwen
selection without a key fails at startup (fail fast, not per task)."""

from worker.config import create_provider_from_config, load_worker_config


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
        "localBaseUrl": "",
        "localModel": "whisper-1",
        "localToken": "",
        "localLanguage": "zh",
        "localMimeType": "",
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
        }
    )
    assert config["apiBase"] == "https://api.example.com"
    assert config["token"] == "worker-secret"
    assert config["provider"] == "qwen"
    assert config["pollIntervalMs"] == 12000
    assert config["qwenApiKey"] == "sk-test"
    assert config["qwenBaseUrl"] == "https://mirror.example.com/v1/"
    assert config["qwenModel"] == "qwen3-asr-flash-test"


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
