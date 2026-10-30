"""Unit tests for acruxcore.otel.register().

register() only builds a TracerProvider and an OTLPSpanExporter; nothing is
exported until a span finishes and the BatchSpanProcessor flushes. Most tests
inspect the built objects directly. The two that check where spans go and with
which key export one real span to a local HTTP server instead: the exporter keeps
its headers in private attributes that moved between releases (issue #558).
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from typing import Dict, Iterator, List

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


@pytest.fixture
def otlp_receiver() -> Iterator[tuple[str, List[Dict[str, str]]]]:
    """A local OTLP endpoint. Yields its base URL and the requests it received
    (path plus headers), so a test can assert on what the exporter really sent."""
    received: List[Dict[str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 (stdlib name)
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            # Header names are case-insensitive, and exporter releases differ.
            headers = {k.lower(): v for k, v in self.headers.items()}
            received.append({"path": self.path, **headers})
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):  # keep pytest output clean
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/api/v1", received
    server.shutdown()
    server.server_close()


def _export_one_span(provider: TracerProvider) -> None:
    provider.get_tracer("test").start_span("probe").end()
    assert provider.force_flush(timeout_millis=5000)


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


def test_env_var_fallback(monkeypatch, otlp_receiver):
    base_url, received = otlp_receiver
    monkeypatch.setenv("ACRUXCORE_API_KEY", "env-key")
    monkeypatch.setenv("ACRUXCORE_BASE_URL", base_url)
    provider = register(set_global=False)
    _export_one_span(provider)
    assert [r["path"] for r in received] == ["/api/v1/traces/otlp"]
    assert received[0]["authorization"] == "Bearer env-key"


def test_constructor_args_take_priority_over_env(monkeypatch, otlp_receiver):
    base_url, received = otlp_receiver
    monkeypatch.setenv("ACRUXCORE_API_KEY", "env-key")
    # Nothing listens on port 1: a span sent here would never reach the receiver.
    monkeypatch.setenv("ACRUXCORE_BASE_URL", "http://127.0.0.1:1/api/v1")
    provider = register(api_key="explicit-key", base_url=base_url, set_global=False)
    _export_one_span(provider)
    assert [r["path"] for r in received] == ["/api/v1/traces/otlp"]
    assert received[0]["authorization"] == "Bearer explicit-key"


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
