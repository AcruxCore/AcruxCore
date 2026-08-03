"""Type definitions for the Acrux Core SDK.

Wire-facing structures you *pass in* (messages, tool definitions, spans) are
``TypedDict``\\s — plain dicts at runtime, so they serialize straight to JSON.
Structures the SDK *returns* are ``dataclass``\\es with attribute access and a
``from_dict`` builder that maps the API's camelCase JSON keys to snake_case
Python attributes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

try:  # Python 3.11+
    from typing import TypedDict, Literal
except ImportError:  # pragma: no cover
    from typing_extensions import TypedDict, Literal  # type: ignore

# --- Enums (as string literals, mirroring the API) -------------------------

SpanKind = Literal["llm", "tool", "retrieval", "embedding", "agent", "chain", "other"]
SpanStatus = Literal["ok", "error", "unset"]
Role = Literal["system", "user", "assistant", "tool"]


# --- Wire-in TypedDicts ----------------------------------------------------


class ToolCallFunction(TypedDict):
    """The ``function`` payload of a tool call. ``arguments`` is a JSON string."""

    name: str
    arguments: str


class ToolCall(TypedDict):
    """A tool call emitted by the model."""

    id: str
    type: Literal["function"]
    function: ToolCallFunction


class Message(TypedDict, total=False):
    """A single chat message.

    ``role`` and ``content`` are always present (``content`` may be ``None`` for
    an assistant turn that only calls tools). ``tool_calls`` appears on assistant
    turns that call tools; ``tool_call_id`` on ``tool`` result messages.
    """

    role: Role
    content: Optional[str]
    tool_calls: List[ToolCall]
    tool_call_id: str


class ToolFunctionDef(TypedDict, total=False):
    name: str
    description: str
    parameters: Dict[str, Any]


class ToolDefinition(TypedDict):
    """An OpenAI-shaped tool (function) definition."""

    type: Literal["function"]
    function: ToolFunctionDef


class ToolRef(TypedDict, total=False):
    """A reference to a catalog tool by name (+ optional alias)."""

    name: str
    alias: str


class ProviderConfig(TypedDict):
    """BYO (bring-your-own-key) provider config.

    Present on a ``chat()``/``run_tool_loop()`` call (or the client's default)
    routes the call directly to ``base_url`` instead of our gateway — the gateway
    hop is skipped entirely, and ``api_key`` is sent only to ``base_url``, never
    to us.
    """

    base_url: str
    api_key: str


# ``ToolChoice`` — how the model should use tools.
ToolChoice = Union[Literal["auto", "none", "required"], Dict[str, Any]]

# ``ResponseFormat`` — structured-output response format (OpenAI-shaped
# ``response_format``), passed straight through to the gateway. ``"json_schema"``
# asks the model for a specific typed shape: the gateway translates the format to
# each provider's native structured-output mode (OpenAI/Gemini natively; Anthropic
# via a forced tool call under the hood, invisible to the caller) and relies on the
# *provider* to honor it. The gateway does NOT validate the model's returned
# content against ``json_schema["schema"]`` itself, so if schema conformance is
# load-bearing, parse and validate the returned content on your side.
#
# Mutually exclusive with ``tools``/``tool_choice``/``tool_refs`` on the same gateway
# request — the gateway rejects a request carrying both with a 400
# ``VALIDATION_ERROR``, whether the tools are inline, resolved from ``tool_refs``, or
# auto-attached from a stored prompt version (the gateway re-checks after resolving
# all three, so there's no combination that slips through). Pass both to
# ``acruxcore.run_tool_loop`` and the SDK handles it for you: it gathers with ``tools``
# and no ``response_format``, then makes one follow-up call with ``response_format`` set
# and no tools to shape the final typed answer, both on one trace. Only ``chat()``
# callers — who manage their own messages — must keep the two apart manually.
#
# Two ways to build one. Either hand-write the OpenAI-shaped dict directly (zero
# dependencies), or build it from a pydantic v2 ``BaseModel`` via
# :func:`acruxcore.pydantic_response_format` — typed, with ``Field(description=...)``
# guidance the model reads per-field. The dict form is the wire shape; the pydantic
# helper just produces that same dict, so the two are interchangeable.
ResponseFormat = Dict[str, Any]


class SpanUsage(TypedDict, total=False):
    promptTokens: int
    completionTokens: int
    totalTokens: int


class IngestSpan(TypedDict, total=False):
    """One OTel-shaped span to report via :meth:`AcruxCore.trace`.

    ``span_id`` is a caller-chosen opaque id, unique within its trace;
    ``parentSpanId`` links to another span's ``spanId``. Keys are camelCase
    because they are sent to the API verbatim.
    """

    spanId: str
    parentSpanId: str
    name: str
    kind: SpanKind
    status: SpanStatus
    startTime: str  # ISO-8601 with tz offset or Z
    endTime: str
    model: str
    provider: str
    usage: SpanUsage
    costUsd: float
    promptVersionId: str
    input: Any
    output: Any
    attributes: Dict[str, Any]
    error: str


class TraceInput(TypedDict, total=False):
    """Input to :meth:`AcruxCore.trace`.

    Omit ``traceId`` to mint a new trace; pass one to append spans to it.
    """

    traceId: str
    sessionId: str
    name: str
    capturePayloads: bool
    tags: List[str]
    metadata: Dict[str, Any]
    spans: List[IngestSpan]


# --- Returned dataclasses --------------------------------------------------


@dataclass
class ChatUsage:
    """Token usage from the gateway's OpenAI-shaped ``usage`` object."""

    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


@dataclass
class GatewayCallMeta:
    """Metadata the gateway stamps on every ``/gateway/chat/completions`` call."""

    request_id: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    #: Parsed from ``x-gateway-cost-usd``; ``None`` when absent (streaming, unpriced).
    cost_usd: Optional[float] = None
    cache: Optional[str] = None
    #: The trace this call's ``llm`` span landed in (``x-gateway-trace-id``).
    trace_id: Optional[str] = None
    #: Opaque ref of the ``llm`` span the gateway recorded (``x-gateway-span-id``).
    span_ref: Optional[str] = None


@dataclass
class RenderResult:
    """Result of :meth:`AcruxCore.render_prompt`."""

    messages: List[Message]
    tools: List[ToolDefinition] = field(default_factory=list)
    #: The prompt version's bound default model, or ``None`` when none is set.
    #: Pass it to :meth:`AcruxCore.chat` / :meth:`AcruxCore.run_tool_loop` to run
    #: the prompt on its bound model instead of hardcoding one.
    model: Optional[str] = None
    #: The resolved prompt version's id, or ``None`` if the server response omitted it
    #: (defensive default; the render endpoint always includes it). Pass to
    #: :meth:`AcruxCore.chat` / :meth:`AcruxCore.run_tool_loop` as ``prompt_version_id``
    #: for trace lineage.
    version_id: Optional[str] = None
    #: The resolved prompt version's number (matches version_id 1:1), or ``None``.
    version_number: Optional[int] = None


@dataclass
class ChatResult:
    """Result of a non-streaming :meth:`AcruxCore.chat` call."""

    id: str
    model: str
    #: The assistant's text; ``None`` when the turn only calls tools.
    content: Optional[str]
    #: The full assistant message, including any ``tool_calls`` (never dispatched).
    message: Message
    finish_reason: Optional[str]
    gateway: GatewayCallMeta
    usage: Optional[ChatUsage] = None


@dataclass
class ChatChunk:
    """One SSE chunk from a streaming :meth:`AcruxCore.chat` call."""

    id: str
    model: str
    delta: Dict[str, Any]
    finish_reason: Optional[str]


@dataclass
class RunToolLoopResult:
    """Result of :meth:`AcruxCore.run_tool_loop`."""

    content: str
    messages: List[Message]
    iterations: int
    stopped_at_limit: bool
    #: The trace id spans were reported under, or ``None`` when ``trace=False``.
    trace_id: Optional[str] = None


@dataclass
class TraceResult:
    """Result of :meth:`AcruxCore.trace` — the resolved trace id."""

    trace_id: str


@dataclass
class FeedbackResult:
    """A feedback row as returned by the traces feedback endpoints."""

    id: str
    trace_id: Optional[str]
    span_id: Optional[str]
    rating: Optional[int]
    label: Optional[str]
    comment: Optional[str]
    source: Optional[str]
    created_by: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "FeedbackResult":
        return cls(
            id=d.get("id"),
            trace_id=d.get("traceId"),
            span_id=d.get("spanId"),
            rating=d.get("rating"),
            label=d.get("label"),
            comment=d.get("comment"),
            source=d.get("source"),
            created_by=d.get("createdBy"),
            created_at=d.get("createdAt"),
            updated_at=d.get("updatedAt"),
            raw=d,
        )


@dataclass
class TraceSummary:
    """Trace header, as returned by ``GET /traces/:id`` and ``GET /traces``."""

    id: str
    name: Optional[str]
    session_id: Optional[str]
    status: Optional[str]
    started_at: Optional[str]
    ended_at: Optional[str]
    span_count: Optional[int]
    total_cost_usd: Optional[float]
    total_tokens: Optional[int]
    duration_ms: Optional[int] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TraceSummary":
        return cls(
            id=d.get("id"),
            name=d.get("name"),
            session_id=d.get("sessionId"),
            status=d.get("status"),
            started_at=d.get("startedAt"),
            ended_at=d.get("endedAt"),
            span_count=d.get("spanCount"),
            total_cost_usd=d.get("totalCostUsd"),
            total_tokens=d.get("totalTokens"),
            duration_ms=d.get("durationMs"),
            raw=d,
        )


@dataclass
class TraceSpan:
    """One span in the tree returned by ``GET /traces/:id``, nested via ``children``."""

    span_id: str
    parent_span_id: Optional[str]
    kind: Optional[str]
    name: Optional[str]
    status: Optional[str]
    started_at: Optional[str]
    ended_at: Optional[str]
    latency_ms: Optional[int]
    model: Optional[str]
    provider: Optional[str]
    prompt_tokens: Optional[int]
    completion_tokens: Optional[int]
    total_tokens: Optional[int]
    cost_usd: Optional[float]
    prompt_version_id: Optional[str]
    gateway_request_id: Optional[str]
    error_message: Optional[str]
    attributes: Dict[str, Any] = field(default_factory=dict)
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    payload: Optional[Dict[str, Any]] = None
    children: List["TraceSpan"] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TraceSpan":
        return cls(
            span_id=d.get("spanId"),
            parent_span_id=d.get("parentSpanId"),
            kind=d.get("kind"),
            name=d.get("name"),
            status=d.get("status"),
            started_at=d.get("startedAt"),
            ended_at=d.get("endedAt"),
            latency_ms=d.get("latencyMs"),
            model=d.get("model"),
            provider=d.get("provider"),
            prompt_tokens=d.get("promptTokens"),
            completion_tokens=d.get("completionTokens"),
            total_tokens=d.get("totalTokens"),
            cost_usd=d.get("costUsd"),
            prompt_version_id=d.get("promptVersionId"),
            gateway_request_id=d.get("gatewayRequestId"),
            error_message=d.get("errorMessage"),
            attributes=d.get("attributes") or {},
            tags=d.get("tags") or [],
            metadata=d.get("metadata") or {},
            payload=d.get("payload"),
            children=[cls.from_dict(c) for c in (d.get("children") or [])],
            raw=d,
        )


@dataclass
class GetTraceResult:
    """Result of :meth:`AcruxCore.get_trace` — the trace header plus its span tree."""

    trace: TraceSummary
    spans: List[TraceSpan]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GetTraceResult":
        return cls(
            trace=TraceSummary.from_dict(d.get("trace") or {}),
            spans=[TraceSpan.from_dict(s) for s in (d.get("spans") or [])],
        )


@dataclass
class ListTracesResult:
    """Result of :meth:`AcruxCore.list_traces` — a page of trace summaries."""

    data: List[TraceSummary]
    total: int
    page: int
    limit: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ListTracesResult":
        return cls(
            data=[TraceSummary.from_dict(t) for t in (d.get("data") or [])],
            total=d.get("total", 0),
            page=d.get("page", 1),
            limit=d.get("limit", 0),
        )


@dataclass
class ToolSyncResult:
    """Outcome of one ``POST /tools/sync`` call.

    :param tool_id: The catalog tool, created by the call if the name was new.
    :param version_number: The version the alias points at after the call.
    :param committed: ``False`` when the submitted spec already matched the live one.
    :param alias: The alias that now points at ``version_number``.
    :param superseded_source: ``'dashboard'`` when this commit replaced a
        dashboard-authored version — a hand edit has stopped being live. ``None``
        otherwise.
    """

    tool_id: str
    version_number: int
    committed: bool
    alias: str
    superseded_source: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolSyncResult":
        return cls(
            tool_id=d["toolId"],
            version_number=d["versionNumber"],
            committed=bool(d["committed"]),
            alias=d["alias"],
            superseded_source=d.get("supersededSource"),
        )


@dataclass
class ResolvedTool:
    """One resolved catalog tool, from ``POST /tools/resolve``.

    :param tool_id: The tool's id — what :meth:`AcruxCore.tools.execute` needs.
    :param version_number: The version the ref's alias resolved to.
    :param executor_type: ``'client'`` (you run it) or ``'http'`` (the platform can).
    :param function: The OpenAI-shaped ``{name, description?, parameters}``.
    """

    tool_id: str
    version_number: int
    executor_type: str
    function: Dict[str, Any]

    @property
    def name(self) -> str:
        """The function name the model calls."""
        return str(self.function["name"])

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ResolvedTool":
        return cls(
            tool_id=d["toolId"],
            version_number=d["versionNumber"],
            executor_type=d["executorType"],
            function=d["function"],
        )


@dataclass
class ToolExecuteResult:
    """Outcome of a server-side tool execution (``POST /tools/:id/execute``).

    :param result: The tool's (possibly response-transformed) return value.
    :param status: The upstream HTTP status the executor saw.
    :param latency_ms: Server-measured wall-clock duration.
    :param tool_version_id: The version that actually ran.
    """

    result: Any
    status: int
    latency_ms: int
    tool_version_id: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolExecuteResult":
        return cls(
            result=d.get("result"),
            status=d["status"],
            latency_ms=d["latencyMs"],
            tool_version_id=d["toolVersionId"],
        )
