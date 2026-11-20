"""Convenience wiring for AcruxCore's OTLP trace ingestion endpoint.

AcruxCore accepts traces from any OpenTelemetry (OTel) source at
``POST /api/v1/traces/otlp`` — CrewAI, the OpenAI Agents SDK, LangChain, LlamaIndex,
or a hand-rolled OTel pipeline all work with nothing but a ``TracerProvider``, a
``BatchSpanProcessor``, and an OTLP exporter pointed at that endpoint. This module
is optional sugar over that same wiring: it does not change what the endpoint
accepts, and a hand-written pipeline (as shown in the OTLP tracing tutorials) works
identically.

Requires the ``otel`` extra — ``pip install acruxcore[otel]`` — since
``opentelemetry-sdk`` is not a runtime dependency of the base package. Framework
auto-instrumentation via ``instrument=[...]`` additionally requires that
framework's own ``openinference-instrumentation-*`` package; :func:`register`
raises a clear error naming the missing package rather than installing it for you.
"""

from __future__ import annotations

import importlib
import os
import secrets
from typing import TYPE_CHECKING, Any, Dict, Optional, Sequence, Tuple

from .errors import (
    INSTRUMENTOR_NOT_INSTALLED,
    MISSING_API_KEY,
    MISSING_BASE_URL,
    OTEL_NOT_AVAILABLE,
    UNKNOWN_INSTRUMENTOR,
    AcruxCoreError,
)
from .steps import set_step_context_bridge

if TYPE_CHECKING:
    from opentelemetry.sdk.trace import TracerProvider

#: module path, OpenInference instrumentor class name, pip package to install.
_InstrumentorEntry = Tuple[str, str, str]

_INSTRUMENTOR_REGISTRY: Dict[str, _InstrumentorEntry] = {
    "openai": (
        "openinference.instrumentation.openai",
        "OpenAIInstrumentor",
        "openinference-instrumentation-openai",
    ),
    "openai_agents": (
        "openinference.instrumentation.openai_agents",
        "OpenAIAgentsInstrumentor",
        "openinference-instrumentation-openai-agents",
    ),
    "crewai": (
        "openinference.instrumentation.crewai",
        "CrewAIInstrumentor",
        "openinference-instrumentation-crewai",
    ),
    "langchain": (
        "openinference.instrumentation.langchain",
        "LangChainInstrumentor",
        "openinference-instrumentation-langchain",
    ),
    "llama_index": (
        "openinference.instrumentation.llama_index",
        "LlamaIndexInstrumentor",
        "openinference-instrumentation-llama-index",
    ),
}

#: Framework names accepted by ``register(instrument=[...])``, sorted for display.
SUPPORTED_FRAMEWORKS: Tuple[str, ...] = tuple(sorted(_INSTRUMENTOR_REGISTRY))


def register(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    *,
    service_name: str = "acruxcore-instrumented-app",
    instrument: Optional[Sequence[str]] = None,
    set_global: bool = True,
) -> "TracerProvider":
    """Build an OTel ``TracerProvider`` that exports straight to AcruxCore.

    Collapses the ``TracerProvider`` + ``BatchSpanProcessor`` + ``OTLPSpanExporter``
    wiring every OTLP tracing tutorial hand-writes into one call, and optionally
    turns on a named framework's own OpenInference instrumentor against the
    resulting provider.

    :param api_key: AcruxCore API key. Fallback: ``ACRUXCORE_API_KEY``.
    :param base_url: AcruxCore API base URL, e.g.
        ``https://api.acruxcore.com/api/v1``. Fallback: ``ACRUXCORE_BASE_URL``.
    :param service_name: Reported as the OTel ``service.name`` resource attribute.
    :param instrument: Framework names to auto-instrument against the returned
        provider, e.g. ``["crewai", "openai"]`` — CrewAI calls the plain OpenAI
        SDK by default, so both are needed together for cost/token data. See
        :data:`SUPPORTED_FRAMEWORKS` for the full list. Each name's
        ``openinference-instrumentation-*`` package must already be installed;
        this only calls its ``.instrument(tracer_provider=...)``, it never
        installs anything.
    :param set_global: Also install the provider as the process-wide default via
        ``opentelemetry.trace.set_tracer_provider`` (default ``True``), so an
        instrumentor or manual ``trace.get_tracer(...)`` call that doesn't take
        an explicit provider still exports to AcruxCore. While this provider is the
        process-wide one, an open ``client.traces.step`` is also the active OTel span,
        so an instrumented call inside a step lands in the step's trace as its child.
    :returns: The configured ``TracerProvider`` — pass it to instrumentors you
        wire yourself, or to ``openinference.instrumentation.using_session``.
    :raises AcruxCoreError: ``OTEL_NOT_AVAILABLE`` if the ``otel`` extra isn't
        installed; ``MISSING_API_KEY`` / ``MISSING_BASE_URL`` if required config
        is absent; ``UNKNOWN_INSTRUMENTOR`` for a name outside
        :data:`SUPPORTED_FRAMEWORKS`; ``INSTRUMENTOR_NOT_INSTALLED`` if that
        framework's OpenInference package isn't installed.
    """
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as exc:
        raise AcruxCoreError(
            "acruxcore.otel.register() needs the 'otel' extra: "
            "pip install acruxcore[otel]",
            OTEL_NOT_AVAILABLE,
        ) from exc

    resolved_key = api_key or os.environ.get("ACRUXCORE_API_KEY")
    if not resolved_key:
        raise AcruxCoreError(
            "acruxcore.otel.register(): api_key is required. Pass it or set "
            "ACRUXCORE_API_KEY.",
            MISSING_API_KEY,
        )

    resolved_base = base_url or os.environ.get("ACRUXCORE_BASE_URL")
    if not resolved_base:
        raise AcruxCoreError(
            "acruxcore.otel.register(): base_url is required. Pass it or set "
            "ACRUXCORE_BASE_URL.",
            MISSING_BASE_URL,
        )

    endpoint = f"{resolved_base.rstrip('/')}/traces/otlp"
    provider = TracerProvider(resource=Resource.create({SERVICE_NAME: service_name}))
    exporter = OTLPSpanExporter(
        endpoint=endpoint,
        headers={"Authorization": f"Bearer {resolved_key}"},
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))

    if set_global:
        trace.set_tracer_provider(provider)
    _bridge_steps_to_otel(provider)

    for name in instrument or ():
        _instrument_framework(name, provider)

    return provider


class _OtelStepBridge:
    """Makes ``client.traces.step`` the active OTel span while it runs (issue #797).

    So an instrumented call inside a step (an ``openai`` call, say) becomes the step's
    child in the step's trace, instead of a trace of its own. Mirrors
    ``bridgeStepsToOtel`` in the TypeScript SDK (sdk-faq Q66).

    The step's UUID trace id, without dashes, is a valid OTel trace id, and the OTLP
    receiver turns it back into the same UUID. Step span ids switch to OTel's 16-hex
    shape, so the parent id an OTel span records is exactly the id the step reports.

    The bridge stands aside, and the step runs in the OTel context it was entered from,
    in two cases:

    - A recording OTel span is already active, such as a LangChain tool span around a
      decorated tool function. Replacing it would move the spans inside the step out of
      the framework's trace. Only the bridge's own step contexts are non-recording, so a
      recording span is always someone else's.
    - ``provider`` is not the process-wide tracer provider, because another one (Sentry,
      say) was set first or ``set_global=False`` was passed. The step context is
      process-wide, so every other tracer would otherwise take the step as its parent:
      a parent that tracer never receives. Checked on every step, so setting the
      provider globally later still turns the bridge on.
    """

    def __init__(self, provider: "TracerProvider") -> None:
        from opentelemetry import context, trace

        self._provider = provider
        self._context = context
        self._trace = trace

    def new_span_id(self) -> str:
        # OTel treats an all-zero span id as invalid; 2**-64 odds, but never send one.
        while True:
            span_id = secrets.token_hex(8)
            if span_id != "0" * 16:
                return span_id

    def enter(self, trace_id: str, span_id: str) -> Any:
        trace = self._trace
        if trace.get_current_span().is_recording() or trace.get_tracer_provider() is not self._provider:
            return None
        parent = trace.NonRecordingSpan(
            trace.SpanContext(
                trace_id=int(trace_id.replace("-", ""), 16),
                span_id=int(span_id, 16),
                is_remote=False,
                trace_flags=trace.TraceFlags(trace.TraceFlags.SAMPLED),
            )
        )
        return self._context.attach(trace.set_span_in_context(parent))

    def exit(self, token: Any) -> None:
        self._context.detach(token)


def _bridge_steps_to_otel(provider: "TracerProvider") -> None:
    """Install :class:`_OtelStepBridge` for ``provider`` as the process's step bridge."""
    set_step_context_bridge(_OtelStepBridge(provider))


def _instrument_framework(name: str, provider: "TracerProvider") -> None:
    """Look up and call one framework's OpenInference instrumentor by name."""
    entry = _INSTRUMENTOR_REGISTRY.get(name)
    if entry is None:
        raise AcruxCoreError(
            f"acruxcore.otel: unknown framework {name!r}. Supported: "
            f"{', '.join(SUPPORTED_FRAMEWORKS)}.",
            UNKNOWN_INSTRUMENTOR,
        )
    module_path, class_name, pip_package = entry
    try:
        module = importlib.import_module(module_path)
    except ImportError as exc:
        raise AcruxCoreError(
            f"acruxcore.otel: instrument={name!r} needs {pip_package!r}. Install "
            f"it with: pip install {pip_package}",
            INSTRUMENTOR_NOT_INSTALLED,
        ) from exc
    instrumentor_cls = getattr(module, class_name)
    instrumentor_cls().instrument(tracer_provider=provider)
