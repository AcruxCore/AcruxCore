"""Type definitions for the AcruxCore SDK.

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


class PromptMessage(TypedDict):
    """A single chat message in a prompt version's template, for
    :meth:`~acruxcore.prompts_api.PromptsNamespace.commit_version`.

    Purpose-built and narrower than the gateway's :class:`Message`: a prompt
    version's messages are always a nunjucks template string with one of the
    three template-eligible roles — never ``"tool"``, never ``None`` content,
    never ``tool_calls`` — matching the API's ``MessageSchema`` enum. Reusing
    the gateway ``Message`` TypedDict here would type-check a shape the server
    rejects with a 400 at runtime.
    """

    role: Literal["system", "user", "assistant"]
    content: str


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


# --- client.traces / client.sessions -----------------------------------------
#
# Result dataclasses for TracesNamespace and SessionsNamespace (see traces_api.py
# and sessions_api.py). Unlike the TypeScript SDK's `AnalyticsOptions`/
# `FeedbackSummaryOptions`/`ListFeedbackOptions`/`SessionListOptions`, no options
# dataclasses exist here — the Python methods take the same fields as ordinary
# keyword arguments instead, matching this SDK's existing style (see
# `list_traces` in client.py).


@dataclass
class LatencyPercentiles:
    """p50/p95/p99 latency in milliseconds. Each is ``None`` when the group has
    no timed spans."""

    p50: Optional[float]
    p95: Optional[float]
    p99: Optional[float]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "LatencyPercentiles":
        return cls(p50=d.get("p50"), p95=d.get("p95"), p99=d.get("p99"))


@dataclass
class AnalyticsTotals:
    """Aggregate metrics shared by the range-wide totals and each grouped bucket."""

    requests: int
    #: Fraction (0..1) of spans with ``status == 'error'`` — NOT a percentage.
    error_rate: float
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    #: Null-cost spans sum as 0, so this is never ``None`` itself.
    cost_usd: float
    latency_ms: LatencyPercentiles

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AnalyticsTotals":
        return cls(
            requests=d.get("requests", 0),
            error_rate=d.get("errorRate", 0.0),
            prompt_tokens=d.get("promptTokens", 0),
            completion_tokens=d.get("completionTokens", 0),
            total_tokens=d.get("totalTokens", 0),
            cost_usd=d.get("costUsd", 0.0),
            latency_ms=LatencyPercentiles.from_dict(d.get("latencyMs") or {}),
        )


@dataclass
class AnalyticsBucket:
    """One grouped bucket — ``key`` is a day string, model name, session id, or
    prompt-version label. Carries the same metrics as :class:`AnalyticsTotals`."""

    key: str
    requests: int
    error_rate: float
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    latency_ms: LatencyPercentiles

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AnalyticsBucket":
        return cls(
            key=d["key"],
            requests=d.get("requests", 0),
            error_rate=d.get("errorRate", 0.0),
            prompt_tokens=d.get("promptTokens", 0),
            completion_tokens=d.get("completionTokens", 0),
            total_tokens=d.get("totalTokens", 0),
            cost_usd=d.get("costUsd", 0.0),
            latency_ms=LatencyPercentiles.from_dict(d.get("latencyMs") or {}),
        )


@dataclass
class AnalyticsResult:
    """Result of :meth:`~acruxcore.traces_api.TracesNamespace.analytics`."""

    #: Resolved window start, ``YYYY-MM-DD``. Attribute is ``from_`` (with the
    #: trailing underscore) because ``from`` is a Python keyword.
    from_: str
    #: Resolved window end, ``YYYY-MM-DD``.
    to: str
    group_by: str
    totals: AnalyticsTotals
    #: One entry per distinct group key that occurred in the window. A bucket
    #: whose group key is null (e.g. a span with no model) is omitted here
    #: entirely, even though it is still counted in ``totals``.
    buckets: List[AnalyticsBucket] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AnalyticsResult":
        return cls(
            from_=d["from"],
            to=d["to"],
            group_by=d["groupBy"],
            totals=AnalyticsTotals.from_dict(d.get("totals") or {}),
            buckets=[AnalyticsBucket.from_dict(b) for b in (d.get("buckets") or [])],
        )


@dataclass
class TraceFacets:
    """Result of :meth:`~acruxcore.traces_api.TracesNamespace.list_facets` — the
    team's distinct tags and metadata keys."""

    tags: List[str] = field(default_factory=list)
    metadata_keys: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TraceFacets":
        return cls(tags=d.get("tags") or [], metadata_keys=d.get("metadataKeys") or [])


@dataclass
class FacetValuesResult:
    """Result of :meth:`~acruxcore.traces_api.TracesNamespace.get_facet_values` —
    the team's distinct values for one metadata key. Note the response (and this
    dataclass) carries no ``key`` field, only ``values``."""

    values: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "FacetValuesResult":
        return cls(values=d.get("values") or [])


@dataclass
class TraceSettings:
    """Result of :meth:`~acruxcore.traces_api.TracesNamespace.get_settings` /
    :meth:`~acruxcore.traces_api.TracesNamespace.update_settings`."""

    capture_payloads: bool
    #: ``None`` until the team's settings row has ever been written (lazy default).
    updated_at: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TraceSettings":
        return cls(capture_payloads=bool(d["capturePayloads"]), updated_at=d.get("updatedAt"))


@dataclass
class FeedbackBucket:
    """One grouped bucket in :class:`FeedbackSummaryResult`."""

    key: str
    count: int
    #: Mean of non-null ratings in the bucket; ``None`` when the bucket has no ratings.
    avg_rating: Optional[float]
    #: Count of feedback rows with ``rating < 0`` (thumbs-down).
    down_count: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "FeedbackBucket":
        return cls(
            key=d["key"],
            count=d.get("count", 0),
            avg_rating=d.get("avgRating"),
            down_count=d.get("downCount", 0),
        )


@dataclass
class FeedbackSummaryResult:
    """Result of :meth:`~acruxcore.traces_api.TracesNamespace.get_feedback_summary`.
    A group key with no feedback yet is simply absent from ``buckets``, never a
    zeroed entry."""

    group_by: str
    buckets: List[FeedbackBucket] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "FeedbackSummaryResult":
        return cls(
            group_by=d["groupBy"],
            buckets=[FeedbackBucket.from_dict(b) for b in (d.get("buckets") or [])],
        )


@dataclass
class FeedbackListResult:
    """Result of :meth:`~acruxcore.traces_api.TracesNamespace.list_feedback` —
    team-wide, newest-first, paginated. ``data`` reuses :class:`FeedbackResult`
    (the same row shape the flat ``submit_feedback``/``update_feedback`` methods
    return) rather than a duplicate feedback type."""

    data: List[FeedbackResult]
    total: int
    page: int
    limit: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "FeedbackListResult":
        return cls(
            data=[FeedbackResult.from_dict(f) for f in (d.get("data") or [])],
            total=d.get("total", 0),
            page=d.get("page", 1),
            limit=d.get("limit", 0),
        )


@dataclass
class TraceFeedbackResult:
    """Result of :meth:`~acruxcore.traces_api.TracesNamespace.get_trace_feedback`
    — every feedback row for one trace. Unlike :class:`FeedbackListResult`, this
    envelope carries no ``total``/``page``/``limit``: it is a full, unpaginated
    list scoped to a single trace, despite returning the same row shape
    (:class:`FeedbackResult`)."""

    data: List[FeedbackResult] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TraceFeedbackResult":
        return cls(data=[FeedbackResult.from_dict(f) for f in (d.get("data") or [])])


@dataclass
class SessionSummary:
    """One rolled-up session — a distinct ``sessionId`` for the team, with its
    trace count, summed cost/tokens, and activity time span."""

    session_id: str
    trace_count: int
    #: ``None`` when none of the session's traces carried a cost.
    total_cost_usd: Optional[float]
    total_tokens: int
    #: ISO — earliest ``startedAt`` among the session's traces.
    first_at: str
    #: ISO — latest ``startedAt`` among the session's traces.
    last_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SessionSummary":
        return cls(
            session_id=d["sessionId"],
            trace_count=d.get("traceCount", 0),
            total_cost_usd=d.get("totalCostUsd"),
            total_tokens=d.get("totalTokens", 0),
            first_at=d["firstAt"],
            last_at=d["lastAt"],
        )


@dataclass
class SessionTraceItem:
    """One trace inside a session, as returned nested in
    :class:`SessionDetailResult`. Deliberately NOT :class:`TraceSummary`: this
    shape additionally carries ``tags``, which ``TraceSummary`` (from
    ``GET /traces`` / ``GET /traces/:id``) does not have."""

    id: str
    name: Optional[str]
    session_id: Optional[str]
    status: str
    started_at: str
    ended_at: Optional[str]
    span_count: int
    total_cost_usd: Optional[float]
    total_tokens: int
    tags: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SessionTraceItem":
        return cls(
            id=d["id"],
            name=d.get("name"),
            session_id=d.get("sessionId"),
            status=d["status"],
            started_at=d["startedAt"],
            ended_at=d.get("endedAt"),
            span_count=d.get("spanCount", 0),
            total_cost_usd=d.get("totalCostUsd"),
            total_tokens=d.get("totalTokens", 0),
            tags=d.get("tags") or [],
        )


@dataclass
class SessionListResult:
    """Result of :meth:`~acruxcore.sessions_api.SessionsNamespace.list` —
    paginated, one entry per session."""

    data: List[SessionSummary]
    total: int
    page: int
    limit: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SessionListResult":
        return cls(
            data=[SessionSummary.from_dict(s) for s in (d.get("data") or [])],
            total=d.get("total", 0),
            page=d.get("page", 1),
            limit=d.get("limit", 0),
        )


@dataclass
class SessionDetailResult:
    """Result of :meth:`~acruxcore.sessions_api.SessionsNamespace.get` — one
    session's summary plus its traces."""

    session: SessionSummary
    traces: List[SessionTraceItem] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SessionDetailResult":
        return cls(
            session=SessionSummary.from_dict(d.get("session") or {}),
            traces=[SessionTraceItem.from_dict(t) for t in (d.get("traces") or [])],
        )


@dataclass
class PromptDetail:
    """Shape of a prompt returned by ``create``/``get``/``update``."""

    id: str
    name: str
    description: Optional[str]
    team_id: str
    created_by: str
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PromptDetail":
        return cls(
            id=d["id"],
            name=d["name"],
            description=d.get("description"),
            team_id=d["teamId"],
            created_by=d["createdBy"],
            created_at=d["createdAt"],
        )


@dataclass
class PromptListItem:
    """Shape of a prompt in :class:`PromptListResult` — narrower than
    :class:`PromptDetail` (no ``team_id``/``created_by``)."""

    id: str
    name: str
    description: Optional[str]
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PromptListItem":
        return cls(
            id=d["id"],
            name=d["name"],
            description=d.get("description"),
            created_at=d["createdAt"],
        )


@dataclass
class PromptListResult:
    """Result of :meth:`~acruxcore.prompts_api.PromptsNamespace.list` — a page of prompts."""

    data: List[PromptListItem]
    total: int
    page: int
    limit: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PromptListResult":
        return cls(
            data=[PromptListItem.from_dict(p) for p in (d.get("data") or [])],
            total=d.get("total", 0),
            page=d.get("page", 1),
            limit=d.get("limit", 0),
        )


@dataclass
class AliasDetail:
    """An alias pointing at one immutable version, from a promote or list call."""

    id: str
    alias: str
    version_id: str
    version_number: int
    updated_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AliasDetail":
        return cls(
            id=d["id"],
            alias=d["alias"],
            version_id=d["versionId"],
            version_number=d["versionNumber"],
            updated_at=d["updatedAt"],
        )


@dataclass
class VersionListItem:
    """Shape of a version in :class:`VersionListResult` — omits ``messages``/
    ``prompt_id`` to keep list pages small."""

    id: str
    version_number: int
    variables: List[str]
    created_by: str
    created_at: str
    #: The bound default model's current ``publicName``, or ``None`` if unbound.
    model: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "VersionListItem":
        return cls(
            id=d["id"],
            version_number=d["versionNumber"],
            variables=d.get("variables") or [],
            created_by=d["createdBy"],
            created_at=d["createdAt"],
            model=d.get("model"),
        )


@dataclass
class VersionListResult:
    """Result of :meth:`~acruxcore.prompts_api.PromptsNamespace.list_versions` —
    a page of versions."""

    data: List[VersionListItem]
    total: int
    page: int
    limit: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "VersionListResult":
        return cls(
            data=[VersionListItem.from_dict(v) for v in (d.get("data") or [])],
            total=d.get("total", 0),
            page=d.get("page", 1),
            limit=d.get("limit", 0),
        )


@dataclass
class VersionDetail:
    """Shape of a version from
    :meth:`~acruxcore.prompts_api.PromptsNamespace.commit_version` or
    :meth:`~acruxcore.prompts_api.PromptsNamespace.get_version`.

    :param aliases: Every alias created alongside this version. Present ONLY
        when this is the prompt's first version (both ``production`` and
        ``staging`` are minted and point at it) — every later commit returns
        ``None``, since committing never moves an alias by itself. Also always
        ``None`` from :meth:`~acruxcore.prompts_api.PromptsNamespace.get_version`,
        which never includes it.
    """

    id: str
    prompt_id: str
    version_number: int
    messages: List[Dict[str, Any]]
    variables: List[str]
    #: The bound default model's current ``publicName``, or ``None`` if unbound.
    model: Optional[str]
    created_by: str
    created_at: str
    aliases: Optional[List[AliasDetail]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "VersionDetail":
        aliases_raw = d.get("aliases")
        return cls(
            id=d["id"],
            prompt_id=d["promptId"],
            version_number=d["versionNumber"],
            messages=d.get("messages") or [],
            variables=d.get("variables") or [],
            model=d.get("model"),
            created_by=d["createdBy"],
            created_at=d["createdAt"],
            aliases=(
                [AliasDetail.from_dict(a) for a in aliases_raw]
                if aliases_raw is not None
                else None
            ),
        )


@dataclass
class DiffResult:
    """Result of :meth:`~acruxcore.prompts_api.PromptsNamespace.diff` — a unified
    diff between two versions."""

    #: Unified diff string.
    diff: str
    from_version: int
    to_version: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DiffResult":
        return cls(
            diff=d["diff"],
            from_version=d["fromVersion"],
            to_version=d["toVersion"],
        )


@dataclass
class ExportedPromptDetail:
    """The ``prompt`` sub-object of an :class:`ExportedPromptVersion`."""

    name: str
    description: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ExportedPromptDetail":
        return cls(name=d["name"], description=d.get("description"))


@dataclass
class ExportedVersionDetail:
    """The ``version`` sub-object of an :class:`ExportedPromptVersion`."""

    version_number: int
    messages: List[Dict[str, Any]]
    variables: List[str]
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ExportedVersionDetail":
        return cls(
            version_number=d["versionNumber"],
            messages=d.get("messages") or [],
            variables=d.get("variables") or [],
            created_at=d["createdAt"],
        )


@dataclass
class ExportedPromptVersion:
    """The portable export format for a single prompt version, from
    :meth:`~acruxcore.prompts_api.PromptsNamespace.export_version`
    (``schema_version`` is always ``1``).
    """

    schema_version: int
    exported_at: str
    prompt: ExportedPromptDetail
    version: ExportedVersionDetail

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ExportedPromptVersion":
        return cls(
            schema_version=d["schemaVersion"],
            exported_at=d["exportedAt"],
            prompt=ExportedPromptDetail.from_dict(d.get("prompt") or {}),
            version=ExportedVersionDetail.from_dict(d.get("version") or {}),
        )

    def to_import_body(self) -> Dict[str, Any]:
        """Rebuilds the API's wire-shape (camelCase) dict that
        :meth:`~acruxcore.prompts_api.PromptsNamespace.import_prompt` expects.

        This dataclass's own attributes are snake_case (this codebase's
        convention for every wire-facing response type), so a plain
        ``dataclasses.asdict()`` on an :class:`ExportedPromptVersion` would
        produce ``schema_version``/``exported_at``/``version_number`` keys
        instead of the ``schemaVersion``/``exportedAt``/``versionNumber`` keys
        the import endpoint's ``ImportBodySchema`` actually requires — this
        method is the correct bridge instead.
        """
        return {
            "schemaVersion": self.schema_version,
            "exportedAt": self.exported_at,
            "prompt": {"name": self.prompt.name, "description": self.prompt.description},
            "version": {
                "versionNumber": self.version.version_number,
                "messages": self.version.messages,
                "variables": self.version.variables,
                "createdAt": self.version.created_at,
            },
        }


@dataclass
class ImportPromptResultPrompt:
    """The ``prompt`` sub-object of an :class:`ImportPromptResult`."""

    id: str
    name: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ImportPromptResultPrompt":
        return cls(id=d["id"], name=d["name"])


@dataclass
class ImportPromptResultVersion:
    """The ``version`` sub-object of an :class:`ImportPromptResult`."""

    id: str
    version_number: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ImportPromptResultVersion":
        return cls(id=d["id"], version_number=d["versionNumber"])


@dataclass
class ImportPromptResult:
    """Result of :meth:`~acruxcore.prompts_api.PromptsNamespace.import_prompt`.
    ``prompt.name`` may differ from the input on a name collision — the server
    appends ``-imported-<unix_ms>`` rather than rejecting the import.
    """

    prompt: ImportPromptResultPrompt
    version: ImportPromptResultVersion

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ImportPromptResult":
        return cls(
            prompt=ImportPromptResultPrompt.from_dict(d.get("prompt") or {}),
            version=ImportPromptResultVersion.from_dict(d.get("version") or {}),
        )


@dataclass
class ToolDetail:
    """A catalog tool's shell (no schema/executor — those live on its versions).

    :param id: The tool's id.
    :param name: Matches ``^[a-zA-Z0-9_-]{1,64}$``, unique per team.
    :param description: Human-readable description, or ``None``.
    :param team_id: The owning team.
    :param created_by: The user id that created it.
    :param created_at: ISO-8601 creation timestamp.
    """

    id: str
    name: str
    description: Optional[str]
    team_id: str
    created_by: str
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolDetail":
        return cls(
            id=d["id"],
            name=d["name"],
            description=d.get("description"),
            team_id=d["teamId"],
            created_by=d["createdBy"],
            created_at=d["createdAt"],
        )


@dataclass
class ToolListResult:
    """A page of tools, from ``GET /tools``.

    List items carry the SAME full shape as ``GET``/``POST`` — unlike prompts,
    there is no narrower list-item DTO for tools.
    """

    data: List[ToolDetail]
    total: int
    page: int
    limit: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolListResult":
        return cls(
            data=[ToolDetail.from_dict(t) for t in (d.get("data") or [])],
            total=d.get("total", 0),
            page=d.get("page", 1),
            limit=d.get("limit", 0),
        )


@dataclass
class ToolAliasDetail:
    """An alias's current state, from a promote call or embedded in a version commit."""

    id: str
    alias: str
    version_id: str
    version_number: int
    updated_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolAliasDetail":
        return cls(
            id=d["id"],
            alias=d["alias"],
            version_id=d["versionId"],
            version_number=d["versionNumber"],
            updated_at=d["updatedAt"],
        )


@dataclass
class ToolVersionDetail:
    """One immutable tool version, with its full schema and executor.

    :param source: ``'dashboard'``, ``'api'``, or ``'code'`` — mirrors the API's
        ``ToolVersionSource`` enum; only :meth:`~acruxcore.tools_api.ToolsNamespace.sync`
        (``POST /tools/sync``) can write ``'code'``.
    :param aliases: Present ONLY when this is the tool's first version — both
        ``production`` and ``staging`` are minted and point at it. Every later
        commit's response has no ``aliases`` at all (``None``, not empty).
    :param warnings: Present only when this commit has a ``changelog`` but no
        ``description`` (a likely omission, not an error). Absent otherwise.
    """

    id: str
    tool_id: str
    version_number: int
    description: Optional[str]
    changelog: Optional[str]
    source: str
    parameters_schema: Dict[str, Any]
    executor: Dict[str, Any]
    created_by: str
    created_at: str
    aliases: Optional[List["ToolAliasDetail"]] = None
    warnings: Optional[List[str]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolVersionDetail":
        aliases = d.get("aliases")
        return cls(
            id=d["id"],
            tool_id=d["toolId"],
            version_number=d["versionNumber"],
            description=d.get("description"),
            changelog=d.get("changelog"),
            source=d["source"],
            parameters_schema=d.get("parametersSchema") or {},
            executor=d.get("executor") or {},
            created_by=d["createdBy"],
            created_at=d["createdAt"],
            aliases=[ToolAliasDetail.from_dict(a) for a in aliases] if aliases is not None else None,
            warnings=d.get("warnings"),
        )


@dataclass
class ToolVersionListItem:
    """One version as it appears in :class:`ToolVersionListResult` — omits
    ``parameters_schema``/``executor`` to keep pages small."""

    id: str
    tool_id: str
    version_number: int
    description: Optional[str]
    changelog: Optional[str]
    source: str
    created_by: str
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolVersionListItem":
        return cls(
            id=d["id"],
            tool_id=d["toolId"],
            version_number=d["versionNumber"],
            description=d.get("description"),
            changelog=d.get("changelog"),
            source=d["source"],
            created_by=d["createdBy"],
            created_at=d["createdAt"],
        )


@dataclass
class ToolVersionListResult:
    """A page of a tool's versions, newest first."""

    data: List[ToolVersionListItem]
    total: int
    page: int
    limit: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolVersionListResult":
        return cls(
            data=[ToolVersionListItem.from_dict(v) for v in (d.get("data") or [])],
            total=d.get("total", 0),
            page=d.get("page", 1),
            limit=d.get("limit", 0),
        )


@dataclass
class ToolStat:
    """Aggregated call stats for one tool, from ``GET /tools/analytics``."""

    tool_name: str
    calls: int
    error_rate: float
    p50_ms: Optional[int]
    p95_ms: Optional[int]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolStat":
        return cls(
            tool_name=d["toolName"],
            calls=d["calls"],
            error_rate=d["errorRate"],
            p50_ms=d.get("p50Ms"),
            p95_ms=d.get("p95Ms"),
        )


@dataclass
class ToolAnalyticsResult:
    """Result of ``GET /tools/analytics`` — one entry per tool with calls in the window."""

    data: List[ToolStat]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolAnalyticsResult":
        return cls(data=[ToolStat.from_dict(s) for s in (d.get("data") or [])])
