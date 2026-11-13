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
