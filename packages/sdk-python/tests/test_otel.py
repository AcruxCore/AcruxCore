"""Unit tests for acruxcore.otel.register().

No network call happens here — register() only builds a TracerProvider and an
OTLPSpanExporter; nothing is exported until a span actually finishes and the
BatchSpanProcessor's background thread flushes. Tests inspect the built
objects directly instead.
"""

from __future__ import annotations

from opentelemetry import trace as otel_trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.util._once import Once
import pytest

from acruxcore import AcruxCoreError
from acruxcore.otel import SUPPORTED_FRAMEWORKS, register


def _exporter_of(provider: TracerProvider):
    processors = provider._active_span_processor._span_processors
    assert len(processors) == 1
    assert isinstance(processors[0], BatchSpanProcessor)
    return processors[0].span_exporter


@pytest.fixture(autouse=True)
def _reset_global_tracer_provider():
    # register(set_global=True) mutates process-wide OTel state, and OTel's own
    # set_tracer_provider() only ever takes effect once per process (an internal
    # Once() guard silently no-ops later calls) — both must be reset or later
    # tests silently see an earlier test's provider.
    otel_trace._TRACER_PROVIDER = None
    otel_trace._TRACER_PROVIDER_SET_ONCE = Once()
    yield
    otel_trace._TRACER_PROVIDER = None
    otel_trace._TRACER_PROVIDER_SET_ONCE = Once()


# --- config resolution -------------------------------------------------------


def test_missing_api_key(monkeypatch):
    monkeypatch.delenv("ACRUXCORE_API_KEY", raising=False)
    with pytest.raises(AcruxCoreError) as ei:
        register(base_url="https://x/api/v1")
    assert ei.value.code == "MISSING_API_KEY"


def test_missing_base_url(monkeypatch):
    monkeypatch.delenv("ACRUXCORE_BASE_URL", raising=False)
    with pytest.raises(AcruxCoreError) as ei:
        register(api_key="k")
    assert ei.value.code == "MISSING_BASE_URL"


def test_env_var_fallback(monkeypatch):
    monkeypatch.setenv("ACRUXCORE_API_KEY", "env-key")
    monkeypatch.setenv("ACRUXCORE_BASE_URL", "https://api.acruxcore.com/api/v1")
    provider = register(set_global=False)
    exporter = _exporter_of(provider)
    assert exporter._endpoint == "https://api.acruxcore.com/api/v1/traces/otlp"
    assert exporter._session.headers["Authorization"] == "Bearer env-key"


def test_constructor_args_take_priority_over_env(monkeypatch):
    monkeypatch.setenv("ACRUXCORE_API_KEY", "env-key")
    monkeypatch.setenv("ACRUXCORE_BASE_URL", "https://env-host/api/v1")
    provider = register(
        api_key="explicit-key",
        base_url="https://explicit-host/api/v1",
        set_global=False,
    )
    exporter = _exporter_of(provider)
    assert exporter._endpoint == "https://explicit-host/api/v1/traces/otlp"
    assert exporter._session.headers["Authorization"] == "Bearer explicit-key"


def test_base_url_trailing_slash_stripped():
    provider = register(
        api_key="k", base_url="https://x/api/v1///", set_global=False
    )
    exporter = _exporter_of(provider)
    assert exporter._endpoint == "https://x/api/v1/traces/otlp"


def test_service_name_becomes_resource_attribute():
    provider = register(
        api_key="k",
        base_url="https://x/api/v1",
        service_name="my-crew",
        set_global=False,
    )
    assert provider.resource.attributes["service.name"] == "my-crew"


# --- set_global --------------------------------------------------------------


def test_set_global_true_installs_process_wide_provider():
    provider = register(api_key="k", base_url="https://x/api/v1", set_global=True)
    assert otel_trace.get_tracer_provider() is provider


def test_set_global_false_leaves_process_wide_provider_untouched():
    register(api_key="k", base_url="https://x/api/v1", set_global=False)
    assert not isinstance(otel_trace.get_tracer_provider(), TracerProvider)


# --- instrument=[...] ---------------------------------------------------------


def test_instrument_unknown_framework_raises():
    with pytest.raises(AcruxCoreError) as ei:
        register(
            api_key="k",
            base_url="https://x/api/v1",
            instrument=["not-a-real-framework"],
            set_global=False,
        )
    assert ei.value.code == "UNKNOWN_INSTRUMENTOR"
    assert "not-a-real-framework" in str(ei.value)


def test_instrument_missing_package_raises_with_install_hint(monkeypatch):
    # crewai's OpenInference package is not installed in this test environment —
    # exercises the real ImportError path, not a mock.
    with pytest.raises(AcruxCoreError) as ei:
        register(
            api_key="k",
            base_url="https://x/api/v1",
            instrument=["crewai"],
            set_global=False,
        )
    assert ei.value.code == "INSTRUMENTOR_NOT_INSTALLED"
    assert "openinference-instrumentation-crewai" in str(ei.value)


def test_instrument_known_installed_framework_actually_instruments():
    # openinference-instrumentation-openai IS installed (it's a test dependency —
    # see pyproject.toml [dev]), so this exercises a real instrument() call
    # against a real OpenInference instrumentor class, not just registry lookup.
    from openinference.instrumentation.openai import OpenAIInstrumentor

    provider = register(
        api_key="k",
        base_url="https://x/api/v1",
        instrument=["openai"],
        set_global=False,
    )
    try:
        assert OpenAIInstrumentor().is_instrumented_by_opentelemetry
    finally:
        OpenAIInstrumentor().uninstrument()
    assert isinstance(provider, TracerProvider)


def test_supported_frameworks_lists_openai_and_crewai():
    assert "openai" in SUPPORTED_FRAMEWORKS
    assert "crewai" in SUPPORTED_FRAMEWORKS
    assert "openai_agents" in SUPPORTED_FRAMEWORKS
