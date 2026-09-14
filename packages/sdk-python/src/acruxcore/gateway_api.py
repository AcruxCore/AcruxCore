"""``client.gateway`` — gateway, BYO-provider, and tool-loop operations."""

from __future__ import annotations

import asyncio
import atexit
import codecs
import inspect
import json
import uuid
import warnings
import weakref
from dataclasses import dataclass
from typing import (
    TYPE_CHECKING,
    Any,
    AsyncGenerator,
    Awaitable,
    Callable,
    Dict,
    List,
    Mapping,
    Optional,
    Sequence,
    Set,
    Tuple,
    Union,
    cast,
    overload,
)
from urllib.parse import quote, urlparse

import httpx

from .errors import (
    API_ERROR,
    MISSING_API_KEY,
    MISSING_BASE_URL,
    MISSING_DISPATCH,
    NETWORK_ERROR,
    PROVIDER_ERROR,
    TOOL_SCHEMA_ERROR,
    VALIDATION_ERROR,
    AcruxCoreError,
    server_detail,
)
from .http import request_with_retry
from .provider import infer_provider_name
from .response_format import normalize_response_format
from .span_queue import SpanQueue
from .result_schema import validate_against_schema
from .tooling import ToolSpec, spec_of
from .tool_result import ToolResult
from .types import (
    ChatChunk,
    ChatResult,
    ChatUsage,
    GatewayCallMeta,
    GatewayControl,
    IngestSpan,
    Literal,
    Message,
    ProviderConfig,
    RenderResult,
    ResolvedTool,
    ResponseFormat,
    RunToolLoopResult,
    ToolCall,
    ToolChoice,
    ToolDefinition,
    ToolLoopContentEvent,
    ToolLoopDoneEvent,
    ToolLoopEvent,
    ToolLoopToolCallEvent,
    ToolLoopToolResultEvent,
    ToolRef,
    TraceInput,
)

if TYPE_CHECKING:
    from .host import GatewayNamespaceHost
    from .tools_api import ToolsNamespace

def _gateway_control_body(control: GatewayControl) -> Dict[str, Any]:
    """Map a ``gateway=`` control dict onto the wire's camelCase keys.

    The gateway validates this object strictly, so an unrecognised key comes back as
    a ``400`` rather than being quietly ignored. Both spellings of the retry count are
    read — ``max_retries`` is the Python one, ``maxRetries`` is what the curl examples
    in the docs show, and a caller who copies the latter should not get an error for
    being consistent with our own documentation.

    ``0`` and ``False`` are preserved: each is a deliberate setting, and a truthiness
    check here would delete exactly the value the caller went out of their way to send.

    :param control: The caller's control dict.
    :returns: The wire-shaped object, empty when nothing was set.
    """
    raw = cast(Dict[str, Any], control)
    out: Dict[str, Any] = {}
    max_retries = raw.get("max_retries", raw.get("maxRetries"))
    if max_retries is not None:
        out["maxRetries"] = max_retries
    if raw.get("fallback") is not None:
        out["fallback"] = raw["fallback"]
    return out


# A dispatch function may be sync or async.
DispatchFn = Callable[[str, Dict[str, Any]], Union[Any, "Awaitable[Any]"]]

#: Tool name → the function that runs it, for catalog tools with a ``client`` executor.
#: The functions may be sync or async, and are called with the tool schema's own
#: parameter names as keywords — not with one ``args`` dict.
ClientToolsMap = Mapping[str, Callable[..., Any]]

# Re-export so callers can ``from acruxcore import AsyncChatStream``.
__all__ = ["GatewayNamespace", "AsyncChatStream", "AsyncToolLoopStream"]


def _now_iso() -> str:
    """Current UTC time as an ISO-8601 string with an offset (API accepts it)."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _require_model(model: Optional[str]) -> str:
    """Reject a missing model before anything is sent, and say where one comes from.

    ``render()`` returns ``model=None`` for a prompt version with no bound model, and that
    ``None`` used to travel: our own API answers ``model is required``, but a BYO provider
    is called directly and reads a null model as *absent*. OpenRouter then substitutes its
    own default and rejects it, so the caller reads a complaint about a model they never
    named (issue #369). Failing here costs no request and can name both ways to supply one.

    :param model: The model argument as given, possibly ``None`` or blank.
    :returns: The model, stripped of surrounding whitespace.
    :raises AcruxCoreError: ``VALIDATION_ERROR`` when there is no usable model.
    """
    if isinstance(model, str) and model.strip():
        return model.strip()
    raise AcruxCoreError(
        "acruxcore: a model is required. Pass one explicitly, or bind a default model to "
        "the prompt version so render() returns it — rendered.model is None otherwise.",
        VALIDATION_ERROR,
    )


def _assert_raw_tool_defs(tools: Optional[List[ToolDefinition]]) -> None:
    """Reject a function declared with ``@acrux.tool`` handed to :meth:`chat`.

    ``chat()`` and ``run_tool_loop()`` both take ``tools``, and they mean different things
    by it: raw OpenAI definitions here, decorated functions there. Getting them the wrong
    way round used to die inside ``json.dumps`` as ``Object of type function is not JSON
    serializable``, which names neither the argument nor the call that would have run it.

    :param tools: The ``tools`` argument as given.
    :raises AcruxCoreError: ``TOOL_SCHEMA_ERROR`` when any entry is a declared tool.
    """
    if not tools:
        return
    declared = [spec.name for spec in (spec_of(t) for t in tools) if spec is not None]
    if not declared:
        return
    names = ", ".join(repr(n) for n in declared)
    was = "was" if len(declared) == 1 else "were"
    raise AcruxCoreError(
        f"acruxcore: {names} {was} declared with @acrux.tool, and chat() cannot run a tool "
        f"— it only offers one to the model and hands the request back on "
        f"message['tool_calls']. Use run_tool_loop(tools=[...]) to have the SDK run them, "
        f"or pass raw OpenAI definitions here.",
        TOOL_SCHEMA_ERROR,
    )


def _gateway_trace_headers(trace_conf: Dict[str, Any]) -> Dict[str, str]:
    """Turn a ``trace={...}`` config into the ``x-trace-*`` headers the gateway reads.

    Used by every gateway-path call — ``chat()``, its streaming twin, and the tool loop —
    so the same key cannot mean one thing on one method and nothing on another. Passing
    ``trace={"name": ...}`` to ``chat()`` used to be silently ignored while working on
    ``run_tool_loop`` (issue #360).

    A key that is absent produces no header at all, which is the point rather than an
    optimisation: the gateway treats an arriving ``x-trace-name`` as an instruction, so
    sending a default one turns a call that merely *joins* a trace into a call that
    renames it (issue #358).

    Free-text values are percent-encoded because the server decodes them — a raw
    non-ASCII name in an HTTP header is a hard client-side failure.

    :param trace_conf: The caller's ``trace`` dict. Unknown keys are ignored. The private
        ``_default_name`` key is this SDK's own fallback name and travels on the weaker
        ``x-trace-name-if-unset`` channel, never as an instruction.
    :returns: The headers to merge into the gateway request; possibly empty.
    """
    headers: Dict[str, str] = {}
    name = trace_conf.get("name")
    if name:
        headers["x-trace-name"] = quote(name, safe="")
    else:
        # A name this SDK picked, not one the caller chose. The server fills it in only
        # when the trace has no real name yet, so sending it on a call that merely joins
        # a trace is harmless (issue #358).
        default_name = trace_conf.get("_default_name")
        if default_name:
            headers["x-trace-name-if-unset"] = quote(default_name, safe="")
    trace_id = trace_conf.get("trace_id")
    if trace_id:
        headers["x-trace-id"] = trace_id
    session_id = trace_conf.get("session_id")
    if session_id:
        headers["x-session-id"] = session_id
    tags = trace_conf.get("tags")
    if tags:
        headers["x-trace-tags"] = ", ".join(tags)
    metadata = trace_conf.get("metadata")
    if metadata:
        headers["x-trace-metadata"] = json.dumps(metadata)
    return headers


def _is_loopback_host(hostname: Optional[str]) -> bool:
    """True for local-dev hosts where a plaintext base_url is not a security issue."""
    return hostname in ("localhost", "127.0.0.1", "::1")


#: URLs already warned about, so the check can run per call while still warning
#: at most once per distinct URL instead of flooding stderr.
_warned_cleartext_urls: Set[str] = set()


def _warn_if_cleartext_url(url: str, what: str) -> None:
    """Warn, once per URL, when an ``Authorization``-bearing request is about to travel
    over cleartext HTTP to a non-loopback host.
    """
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.hostname:
        return
    if parsed.scheme == "https" or _is_loopback_host(parsed.hostname):
        return
    key = f"{what}:{url}"
    if key in _warned_cleartext_urls:
        return
    _warned_cleartext_urls.add(key)
    warnings.warn(
        f'acruxcore: {what} "{url}" is not HTTPS — the API key and request/response '
        "bodies sent to it will travel in cleartext. Use an https:// URL outside local "
        "development.",
        stacklevel=3,
    )


def _parse_tool_arguments(call: Dict[str, Any]) -> Dict[str, Any]:
    """Parse one tool call's ``arguments`` JSON string into a dict.

    A model that emits malformed or non-object arguments gets ``{}`` rather than an
    exception: the tool then fails (or not) on its own terms, which reads far better
    than a JSON error from inside the SDK.
    """
    try:
        parsed = json.loads(call["function"].get("arguments") or "{}")
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _client_tool_arity_error(
    name: str, fn: Callable[..., Any], function_def: Dict[str, Any]
) -> Optional[str]:
    """Message when ``fn`` cannot receive the tool's required arguments, else ``None``.

    A ``client_tools`` function is called with the schema's own parameter names as
    keywords, so a function written to take one ``args`` dict raises ``TypeError``
    mid-loop — after a model round has already been paid for. Checking the signature up
    front turns that into a wiring error at the call site.

    Deliberately conservative: anything it cannot read confidently — ``**kwargs``, a
    callable with no introspectable signature, a schema with no ``required`` list —
    returns ``None`` rather than guessing, because a false positive here blocks a call
    that would have worked.

    :param name: The tool name, for the message.
    :param fn: The function supplied in ``client_tools``.
    :param function_def: The resolved tool's OpenAI ``function`` object.
    :returns: The error message, or ``None`` when the signature can take the arguments.
    """
    required = ((function_def.get("parameters") or {}).get("required")) or []
    if not required:
        return None

    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return None

    accepted: List[str] = []
    for param in signature.parameters.values():
        if param.kind is inspect.Parameter.VAR_KEYWORD:
            return None
        if param.kind in (
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        ):
            accepted.append(param.name)

    missing = [field for field in required if field not in accepted]
    if not missing:
        return None

    # Required fields keep the schema's own order: that is the order the reader sees in
    # the dashboard, and the order the suggested signature should be written in.
    return (
        f"acruxcore: the function passed in client_tools for '{name}' cannot receive this "
        f"tool's arguments — the catalog schema requires {list(required)} and the function "
        f"accepts {accepted}. A client_tools function is called with the schema's own "
        f"parameter names, so define it as {name}({', '.join(required)}), or accept "
        f"**kwargs."
    )


@dataclass
class _ToolRoute:
    """How one tool name gets executed during a loop."""

    kind: str
    fn: Optional[Callable[..., Any]] = None
    tool_id: Optional[str] = None
    alias: Optional[str] = None
    #: Set instead of ``alias`` when the ref pinned one exact version.
    version_number: Optional[int] = None
    tool_version_id: Optional[str] = None
    #: The catalog's declared result shape, when the resolved version has one.
    result_schema: Optional[Dict[str, Any]] = None
    #: Whether a ``result_schema`` mismatch is a warning or an error.
    result_schema_severity: Optional[str] = None


#: Live clients that may still have spans to send, held weakly so an abandoned
#: client can still be collected.
_clients_awaiting_exit_flush: "weakref.WeakSet[GatewayNamespace]" = weakref.WeakSet()
_exit_hook_registered = False


def _flush_all_at_exit() -> None:
    """Drain every live gateway's span queue as the interpreter exits."""
    for gw in list(_clients_awaiting_exit_flush):
        gw._drain_at_exit()


def _register_exit_flush(gw: "GatewayNamespace") -> None:
    """Enrol a gateway in the shared exit drain, installing the hook on first use."""
    global _exit_hook_registered
    _clients_awaiting_exit_flush.add(gw)
    if not _exit_hook_registered:
        atexit.register(_flush_all_at_exit)
        _exit_hook_registered = True


class GatewayNamespace:
    """Gateway, BYO-provider, and tool-loop operations, reached as ``client.gateway``.

    This namespace owns every method that talks to the gateway or a BYO provider:
    ``chat()``, ``stream()``, ``run_tool_loop()``, ``flush()``, and ``aclose()``.
    It also manages the span queue and the process-exit drain hook.

    :param host: The owning client, used for its request/parse helpers and config.
    """

    def __init__(self, host: "GatewayNamespaceHost") -> None:
        self._host = host
        _register_exit_flush(self)

    # ── lifecycle ──────────────────────────────────────────────────────────

    async def flush(self) -> None:
        """Wait until every trace this client reported in the background has been sent.

        ``chat()``, streaming ``chat()`` and ``run_tool_loop()`` hand back their result
        without waiting for the trace write, so call this before reading the traces API
        back — in a test, or in code that polls for the span it just produced. A script
        that simply returns from ``main()`` does not need it: the SDK drains at exit.

        Never raises for a telemetry failure — those are warned about, not propagated.
        """
        await self._host._span_queue.flush()

    async def aclose(self) -> None:
        """Flush pending traces and release resources. Call once when done.

        A long-running server should call this in the shutdown path it already has; the SDK
        deliberately installs no signal handlers of its own.
        """
        await self._host._span_queue.close()
        _clients_awaiting_exit_flush.discard(self)
        # The httpx client is owned by the host, so closing it is not this method's job.
        # Callers who want the pool closed too want ``AcruxCore.aclose()``, which flushes
        # through here first and then closes the transport.

    def _drain_at_exit(self) -> None:
        """Send whatever is still buffered as the interpreter exits.

        Runs after the caller's event loop may already be closed, so it cannot simply
        await. With a loop still running, the process is mid-shutdown and owns its own
        teardown — ``aclose()``/``__aexit__`` is the correct hook there, so this leaves
        the queue alone. With no loop, it drains the remainder on a fresh one.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            return

        pending = self._host._span_queue.take_pending()
        if not pending:
            return
        try:
            asyncio.run(self._drain_on_a_fresh_loop(pending))
        except Exception:  # noqa: BLE001 — an atexit hook must never raise
            pass

    async def _drain_on_a_fresh_loop(self, pending: List[Dict[str, Any]]) -> None:
        """Re-send buffered entries with a brand-new HTTP client on a brand-new loop."""
        async with httpx.AsyncClient(timeout=self._host._timeout) as client:
            queue = SpanQueue(lambda batch: self._post_traces(client, batch))
            for item in pending:
                queue.enqueue(item)
            await queue.flush()

    # ── trace posting (shared with traces namespace via host) ──────────────

    async def _post_traces(
        self, client: httpx.AsyncClient, batch: List[Dict[str, Any]]
    ) -> None:
        """Send one batch of trace reports as a single ``POST /traces``.

        Takes the HTTP client explicitly because the interpreter-exit drain has to use a
        fresh one — the live client's pool belongs to a loop that has already closed.
        """
        response = await request_with_retry(
            client,
            "POST",
            f"{self._host._base_url}/traces",
            headers=self._host._auth_headers(),
            content=json.dumps({"traces": batch}).encode("utf-8"),
            max_retries=self._host._max_retries,
            retry_interval_ms=self._host._retry_interval,
        )
        if response.status_code >= 400:
            raise AcruxCoreError(
                f"acruxcore API error {response.status_code} reporting traces",
                API_ERROR,
                response.status_code,
                self._host._safe_json(response),
            )

    async def _send_trace_batch(self, batch: List[Dict[str, Any]]) -> None:
        """Sender the span queue drives. Failures propagate so the queue can warn and drop."""
        await self._post_traces(self._host._client, batch)

    # ── chat ───────────────────────────────────────────────────────────────

    async def chat(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        tool_choice: Optional[ToolChoice] = None,
        response_format: Optional[ResponseFormat] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        stream: bool = False,
        provider: Optional[ProviderConfig] = None,
        gateway: Optional[GatewayControl] = None,
        prompt_version_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
        trace: Union[bool, Dict[str, Any], None] = None,
    ) -> Union[ChatResult, "AsyncChatStream"]:
        """Call the gateway's ``POST /gateway/chat/completions`` once — or, when a
        BYO provider is configured, call that provider's ``base_url`` directly.

        No tool-dispatch loop: if the model returns ``tool_calls`` they are handed
        back raw. Use :meth:`run_tool_loop` to dispatch them.

        ``tools`` here is the raw OpenAI shape, not a function declared with
        ``@acrux.tool`` — passing a declared tool raises ``TOOL_SCHEMA_ERROR`` naming the
        call that does run it.

        :param gateway: Per-call gateway controls — ``max_retries`` and ``fallback``, see
            :class:`~acruxcore.types.GatewayControl`. These are what the *gateway* does
            upstream, a different layer from the client's own ``max_retries``, which only
            retries this SDK's request to AcruxCore. Ignored on a BYO-provider call.
        :param prompt_version_id: Which prompt version the messages came from, for trace
            lineage. Send ``variables`` with it.
        :param variables: The values the messages were rendered from. Recorded on the
            ``llm`` span, never sent to a BYO provider. An evaluation dataset example is
            the variables plus the version, so a call naming a version without them can
            never seed one; alongside a version id they are lineage only and are not
            re-rendered. Without a version id, a gateway call instead uses them to fill
            ``{{ placeholders }}`` in the messages sent.
        """
        model = _require_model(model)
        _assert_raw_tool_defs(tools)
        provider_config = provider or self._host._provider_default
        body = self._build_chat_body(
            model, messages, tools, tool_refs, tool_choice, response_format, temperature, max_tokens, stream,
            prompt_version_id=None if provider_config is not None else prompt_version_id,
            variables=None if provider_config is not None else variables,
            gateway=None if provider_config is not None else gateway,
        )
        if stream:
            if provider_config is not None:
                return AsyncChatStream(
                    self, body,
                    provider_config=provider_config, model=model, messages=messages,
                    prompt_version_id=prompt_version_id, variables=variables, trace_opt=trace,
                )
            # `trace_opt` is forwarded on this path too: without it the gateway never saw
            # the name, trace id, session id, tags or metadata of a streamed call.
            return AsyncChatStream(self, body, trace_opt=trace)

        trace_opt = trace if trace is not None else bool(provider_config)
        trace_enabled = trace_opt is not False
        trace_conf: Dict[str, Any] = trace_opt if isinstance(trace_opt, dict) else {}

        # Who writes the ``llm`` span depends on the path, not on whether tracing is on.
        # On the gateway path the gateway writes it server-side, so this SDK's only job is
        # to forward the trace headers; reporting a span of its own here counted every
        # model call twice (issue #360). On the BYO path no gateway sees the call, so the
        # SDK is the only thing that can report it.
        report_span = trace_enabled and provider_config is not None

        trace_headers: Optional[Dict[str, str]] = (
            _gateway_trace_headers(trace_conf) if trace_enabled and provider_config is None else None
        )

        start_time = _now_iso()
        if provider_config is not None:
            result = await self._complete_via_provider(
                model, messages, tools=tools, tool_refs=tool_refs, tool_choice=tool_choice,
                response_format=response_format,
                temperature=temperature, max_tokens=max_tokens, provider_config=provider_config,
            )
        else:
            result = await self._complete_once(
                model, messages, tools=tools, tool_refs=tool_refs, tool_choice=tool_choice,
                response_format=response_format,
                temperature=temperature, max_tokens=max_tokens, extra_headers=trace_headers,
                prompt_version_id=prompt_version_id, variables=variables, gateway=gateway,
            )

        if report_span:
            span_id = result.gateway.span_ref or f"chat-{uuid.uuid4()}"
            trace_id = trace_conf.get("trace_id") or result.gateway.trace_id
            span: IngestSpan = {
                "spanId": span_id,
                "name": result.model,
                "kind": "llm",
                "status": "ok",
                "startTime": start_time,
                "endTime": _now_iso(),
                "model": result.model,
                "input": {"messages": messages},
                "output": result.message,
            }
            if result.gateway.provider:
                span["provider"] = result.gateway.provider
            if result.usage is not None:
                span["usage"] = {
                    "promptTokens": result.usage.prompt_tokens,
                    "completionTokens": result.usage.completion_tokens,
                    "totalTokens": result.usage.total_tokens,
                }
            if result.gateway.cost_usd is not None:
                span["costUsd"] = result.gateway.cost_usd
            if prompt_version_id:
                span["promptVersionId"] = prompt_version_id
            if variables is not None:
                span["variables"] = variables
            payload: TraceInput = {"name": "chat", "spans": [span]}
            if trace_id:
                payload["traceId"] = trace_id
            if trace_conf.get("session_id"):
                payload["sessionId"] = trace_conf["session_id"]
            self._host._span_queue.enqueue(payload)

        return result

    async def stream(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        tool_choice: Optional[ToolChoice] = None,
        response_format: Optional[ResponseFormat] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        provider: Optional[ProviderConfig] = None,
        prompt_version_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
        trace: Union[bool, Dict[str, Any], None] = None,
    ) -> "AsyncChatStream":
        """Stream a chat completion — the standalone streaming entry point.

        Equivalent to ``chat(..., stream=True)`` but as a dedicated method.
        """
        return await self.chat(
            model, messages,
            tools=tools, tool_refs=tool_refs, tool_choice=tool_choice,
            response_format=response_format, temperature=temperature, max_tokens=max_tokens,
            stream=True, provider=provider, prompt_version_id=prompt_version_id,
            variables=variables, trace=trace,
        )  # type: ignore[return-value]

    def _build_chat_body(
        self,
        model: str,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]],
        tool_refs: Optional[List[ToolRef]],
        tool_choice: Optional[ToolChoice],
        response_format: Optional[ResponseFormat],
        temperature: Optional[float],
        max_tokens: Optional[int],
        stream: bool,
        prompt_version_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
        gateway: Optional[GatewayControl] = None,
    ) -> Dict[str, Any]:
        """Build the JSON body for one completion.

        :param prompt_version_id: Which prompt version these messages were rendered
            from. Only ever passed for a GATEWAY call — it is our field, not
            OpenAI's, so sending it to a BYO provider would be sending a stranger a
            field it never asked for. On a BYO call the SDK writes the span itself
            and stamps the lineage there instead.
        :param variables: The values those messages were rendered from, the other half of
            the same lineage — an evaluation dataset example is the variables plus the
            version. Gateway-only for the same reason. Alongside a ``prompt_version_id``
            the gateway records them without re-rendering; without one it uses them to
            fill ``{{ placeholders }}`` in the messages sent.
        :param gateway: Per-call gateway controls. GATEWAY-ONLY for the same reason as
            the two above: a BYO provider has no gateway to control and never asked for
            this field.
        """
        body: Dict[str, Any] = {"model": model, "messages": messages}
        if prompt_version_id:
            body["prompt_version_id"] = prompt_version_id
        if variables is not None:
            body["variables"] = variables
        if tools:
            body["tools"] = tools
        if tool_refs:
            body["tool_refs"] = tool_refs
        if tool_choice:
            body["tool_choice"] = tool_choice
        if response_format:
            body["response_format"] = normalize_response_format(response_format)
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if stream:
            body["stream"] = True
        if gateway:
            body["gateway"] = _gateway_control_body(gateway)
        return body

    async def _complete_once(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        tool_choice: Optional[ToolChoice] = None,
        response_format: Optional[ResponseFormat] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        prompt_version_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
        gateway: Optional[GatewayControl] = None,
    ) -> ChatResult:
        body = self._build_chat_body(
            model, messages, tools, tool_refs, tool_choice, response_format, temperature, max_tokens, False,
            prompt_version_id=prompt_version_id, variables=variables, gateway=gateway,
        )
        response = await self._host._request(
            "POST", "/gateway/chat/completions", body, "calling chat completions", extra_headers
        )
        gateway = self._read_gateway_meta(response)
        data = self._host._parse_json_or_throw(response, "calling chat completions")
        choice = data["choices"][0]
        usage_raw = data.get("usage")
        usage = (
            ChatUsage(
                prompt_tokens=usage_raw.get("prompt_tokens"),
                completion_tokens=usage_raw.get("completion_tokens"),
                total_tokens=usage_raw.get("total_tokens"),
            )
            if usage_raw
            else None
        )
        return ChatResult(
            id=data["id"],
            model=data["model"],
            content=choice["message"].get("content"),
            message=choice["message"],
            finish_reason=choice.get("finish_reason"),
            usage=usage,
            gateway=gateway,
        )

    async def _complete_via_provider(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        tool_choice: Optional[ToolChoice] = None,
        response_format: Optional[ResponseFormat] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        provider_config: ProviderConfig,
    ) -> ChatResult:
        if not provider_config.get("api_key"):
            raise AcruxCoreError(
                "acruxcore: provider api_key is required for a BYO (direct-provider) call.",
                MISSING_API_KEY,
            )
        if not provider_config.get("base_url"):
            raise AcruxCoreError(
                "acruxcore: provider base_url is required for a BYO (direct-provider) call.",
                MISSING_BASE_URL,
            )
        _warn_if_cleartext_url(provider_config["base_url"], "provider.base_url")
        body = self._build_chat_body(
            model, messages, tools, tool_refs, tool_choice, response_format, temperature, max_tokens, False
        )
        base_url = provider_config["base_url"].rstrip("/")
        url = f"{base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {provider_config['api_key']}",
            "Content-Type": "application/json",
        }
        content = json.dumps(body).encode("utf-8")

        try:
            response = await request_with_retry(
                self._host._client, "POST", url, headers=headers, content=content,
                max_retries=self._host._max_retries, retry_interval_ms=self._host._retry_interval,
            )
        except httpx.TransportError as err:
            raise AcruxCoreError(
                f"acruxcore: network error calling provider — {err}", NETWORK_ERROR
            )

        if response.status_code >= 400:
            body = self._host._safe_json(response)
            raise AcruxCoreError(
                f"acruxcore: provider returned {response.status_code} calling chat "
                f"completions{server_detail(body)}",
                PROVIDER_ERROR,
                response.status_code,
                body,
            )

        data = response.json()
        choice = data["choices"][0]
        usage_raw = data.get("usage")
        usage = (
            ChatUsage(
                prompt_tokens=usage_raw.get("prompt_tokens"),
                completion_tokens=usage_raw.get("completion_tokens"),
                total_tokens=usage_raw.get("total_tokens"),
            )
            if usage_raw
            else None
        )
        return ChatResult(
            id=data["id"],
            model=data["model"],
            content=choice["message"].get("content"),
            message=choice["message"],
            finish_reason=choice.get("finish_reason"),
            usage=usage,
            gateway=GatewayCallMeta(
                request_id=data["id"],
                provider=infer_provider_name(provider_config["base_url"]),
                model=data["model"],
                cost_usd=None,
                cache=None,
                trace_id=str(uuid.uuid4()),
                span_ref=str(uuid.uuid4()),
            ),
        )

    async def _stream_chat(
        self,
        body: Dict[str, Any],
        extra_headers: Optional[Dict[str, str]] = None,
        meta_out: Optional[Dict[str, GatewayCallMeta]] = None,
    ) -> Any:
        """Yield one :class:`ChatChunk` per SSE frame until ``data: [DONE]``.

        :param body: The completion body, already carrying ``stream: True``.
        :param extra_headers: Trace-correlation headers to send with the request.
        :param meta_out: When given, ``meta_out["gateway"]`` is filled with the
            response's ``x-gateway-*`` metadata *before* the first chunk is yielded.
            The streaming tool loop needs it that early: the trace id it threads
            through the following rounds comes off these headers.
        """
        url = f"{self._host._base_url}/gateway/chat/completions"
        headers = self._host._auth_headers(extra_headers)
        content = json.dumps(body).encode("utf-8")

        total_attempts = 1 + self._host._max_retries
        for attempt in range(total_attempts):
            if attempt > 0:
                await asyncio.sleep(self._host._retry_interval / 1000)
            try:
                async with self._host._client.stream(
                    "POST", url, headers=headers, content=content
                ) as response:
                    if (
                        response.status_code == 429 or response.status_code >= 500
                    ) and attempt < total_attempts - 1:
                        await response.aread()
                        continue
                    if response.status_code >= 400:
                        await response.aread()
                        raise AcruxCoreError(
                            f"acruxcore API error {response.status_code} streaming chat completions",
                            API_ERROR,
                            response.status_code,
                            self._host._safe_json(response),
                        )

                    if meta_out is not None:
                        meta_out["gateway"] = self._read_gateway_meta(response)

                    decoder = codecs.getincrementaldecoder("utf-8")()
                    buffer = ""
                    async for chunk in response.aiter_bytes():
                        buffer += decoder.decode(chunk)
                        while "\n\n" in buffer:
                            frame, buffer = buffer.split("\n\n", 1)
                            frame = frame.strip()
                            if not frame.startswith("data:"):
                                continue
                            payload = frame[len("data:"):].strip()
                            if payload == "[DONE]":
                                return
                            parsed = json.loads(payload)
                            choices = parsed.get("choices") or [{}]
                            choice = choices[0] if choices else {}
                            yield ChatChunk(
                                id=parsed.get("id"),
                                model=parsed.get("model"),
                                delta=choice.get("delta") or {},
                                finish_reason=choice.get("finish_reason"),
                            )
                    return
            except httpx.TransportError as err:
                if attempt < total_attempts - 1:
                    continue
                raise AcruxCoreError(
                    f"acruxcore: network error streaming chat completions — {err}",
                    NETWORK_ERROR,
                )

    async def _stream_round_via_provider(
        self,
        model: str,
        body: Dict[str, Any],
        provider_config: ProviderConfig,
        state: Dict[str, Any],
    ) -> Any:
        """Stream ONE completion straight from a BYO provider, yielding raw chunks.

        Shared by the public BYO stream and the streaming tool loop, which need the same
        wire handling but file different spans — so the accumulated turn is handed back
        through ``state`` instead of being written to a span here.

        :param model: Requested model, used as the fallback when no frame names one.
        :param body: The completion body; ``stream_options.include_usage`` is added.
        :param provider_config: Where to send it and which key to use.
        :param state: Filled as the stream runs and complete once it ends —
            ``start_time``, ``content``, ``tool_calls``, ``model``, ``finish_reason``
            and ``usage`` (already camelCased for a span payload).
        :raises AcruxCoreError: ``MISSING_API_KEY``/``MISSING_BASE_URL`` on a bad
            config, ``PROVIDER_ERROR`` on a 4xx/5xx, ``NETWORK_ERROR`` on transport
            failure.
        """
        if not provider_config.get("api_key"):
            raise AcruxCoreError(
                "acruxcore: provider api_key is required for a BYO (direct-provider) call.",
                MISSING_API_KEY,
            )
        if not provider_config.get("base_url"):
            raise AcruxCoreError(
                "acruxcore: provider base_url is required for a BYO (direct-provider) call.",
                MISSING_BASE_URL,
            )
        _warn_if_cleartext_url(provider_config["base_url"], "provider.base_url")
        base_url = provider_config["base_url"].rstrip("/")
        url = f"{base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {provider_config['api_key']}",
            "Content-Type": "application/json",
        }
        stream_body = {**body, "stream_options": {"include_usage": True}}
        content = json.dumps(stream_body).encode("utf-8")
        start_time = _now_iso()

        accumulated_content = ""
        final_model = model
        final_finish_reason: Optional[str] = None
        usage: Optional[Dict[str, Any]] = None
        tool_call_parts: Dict[int, Dict[str, str]] = {}

        total_attempts = 1 + self._host._max_retries
        yielded_any = False
        for attempt in range(total_attempts):
            if attempt > 0:
                await asyncio.sleep(self._host._retry_interval / 1000)
            accumulated_content = ""
            final_model = model
            final_finish_reason = None
            usage = None
            tool_call_parts = {}
            try:
                async with self._host._client.stream("POST", url, headers=headers, content=content) as response:
                    if response.status_code == 429 or response.status_code >= 500:
                        if attempt < total_attempts - 1:
                            await response.aread()
                            continue
                    if response.status_code >= 400:
                        await response.aread()
                        body = self._host._safe_json(response)
                        raise AcruxCoreError(
                            f"acruxcore: provider returned {response.status_code} streaming "
                            f"chat completions{server_detail(body)}",
                            PROVIDER_ERROR,
                            response.status_code,
                            body,
                        )

                    decoder = codecs.getincrementaldecoder("utf-8")()
                    buffer = ""
                    stream_done = False
                    async for chunk in response.aiter_bytes():
                        buffer += decoder.decode(chunk)
                        while "\n\n" in buffer:
                            frame, buffer = buffer.split("\n\n", 1)
                            frame = frame.strip()
                            if not frame.startswith("data:"):
                                continue
                            payload = frame[len("data:"):].strip()
                            if payload == "[DONE]":
                                stream_done = True
                                break
                            parsed = json.loads(payload)
                            final_model = parsed.get("model") or final_model
                            if parsed.get("usage"):
                                u = parsed["usage"]
                                usage = {
                                    "promptTokens": u.get("prompt_tokens"),
                                    "completionTokens": u.get("completion_tokens"),
                                    "totalTokens": u.get("total_tokens"),
                                }
                            choices = parsed.get("choices") or []
                            choice = choices[0] if choices else {}
                            if choice.get("finish_reason"):
                                final_finish_reason = choice["finish_reason"]
                            delta = choice.get("delta") or {}
                            if delta.get("content"):
                                accumulated_content += delta["content"]
                            for tc in (delta.get("tool_calls") or []):
                                key = tc.get("index", 0)
                                part = tool_call_parts.setdefault(key, {"id": "", "name": "", "arguments": ""})
                                if tc.get("id"):
                                    part["id"] = tc["id"]
                                fn = tc.get("function") or {}
                                if fn.get("name"):
                                    part["name"] = fn["name"]
                                if fn.get("arguments"):
                                    part["arguments"] += fn["arguments"]
                            yielded_any = True
                            yield ChatChunk(
                                id=parsed.get("id"), model=parsed.get("model"),
                                delta=delta, finish_reason=choice.get("finish_reason"),
                            )
                        if stream_done:
                            break
                    break
            except httpx.TransportError as err:
                if attempt < total_attempts - 1 and not yielded_any:
                    continue
                raise AcruxCoreError(
                    f"acruxcore: network error streaming from provider — {err}", NETWORK_ERROR
                )

        state["start_time"] = start_time
        state["content"] = accumulated_content
        state["model"] = final_model
        state["finish_reason"] = final_finish_reason
        state["usage"] = usage
        state["tool_calls"] = [
            {"id": p["id"], "type": "function", "function": {"name": p["name"], "arguments": p["arguments"]}}
            for _, p in sorted(tool_call_parts.items())
        ]

    async def _stream_via_provider(
        self,
        model: str,
        messages: List[Message],
        body: Dict[str, Any],
        provider_config: ProviderConfig,
        prompt_version_id: Optional[str],
        variables: Optional[Dict[str, Any]],
        trace_opt: Union[bool, Dict[str, Any]],
    ) -> Any:
        """Stream a BYO provider's ``/chat/completions`` directly, then file the span.

        The gateway is bypassed, so nothing server-side records this call — the client
        writes the one ``llm`` span itself, once the stream has ended and the turn is
        fully assembled.
        """
        state: Dict[str, Any] = {}
        async for chunk in self._stream_round_via_provider(model, body, provider_config, state):
            yield chunk

        if trace_opt is not False:
            trace_conf: Dict[str, Any] = trace_opt if isinstance(trace_opt, dict) else {}
            span = self._byo_llm_span(
                state, messages, provider_config, prompt_version_id, variables,
                span_id=str(uuid.uuid4()),
            )
            trace_payload: TraceInput = {"name": "chat", "spans": [span]}
            if trace_conf.get("trace_id"):
                trace_payload["traceId"] = trace_conf["trace_id"]
            if trace_conf.get("session_id"):
                trace_payload["sessionId"] = trace_conf["session_id"]
            self._host._span_queue.enqueue(trace_payload)

    def _byo_llm_span(
        self,
        state: Dict[str, Any],
        messages: List[Message],
        provider_config: ProviderConfig,
        prompt_version_id: Optional[str],
        variables: Optional[Dict[str, Any]],
        *,
        span_id: str,
    ) -> IngestSpan:
        """Build the ``llm`` span for one streamed BYO-provider turn.

        Shared by the public BYO stream and the streaming tool loop so a streamed turn
        records the same span either way — the failure mode this avoids is streaming
        silently costing observability.

        :param state: A completed :meth:`_stream_round_via_provider` state dict.
        :param messages: The conversation sent for this turn (the span's input).
        :param provider_config: Used only to name the provider.
        :param prompt_version_id: Prompt lineage to stamp, when the caller has it.
        :param variables: The values the messages were rendered from — the other half of
            that lineage, and what an evaluation dataset example is built from. Stamped
            whenever the caller has it, for the same reason.
        :param span_id: Id for the span.
        """
        output: Dict[str, Any] = {"role": "assistant", "content": state.get("content") or ""}
        tool_calls: List[ToolCall] = state.get("tool_calls") or []
        if tool_calls:
            output["tool_calls"] = tool_calls
        span: IngestSpan = {
            "spanId": span_id,
            "name": state["model"],
            "kind": "llm",
            "status": "ok",
            "startTime": state["start_time"],
            "endTime": _now_iso(),
            "model": state["model"],
            "provider": infer_provider_name(provider_config["base_url"]),
            "input": {"messages": messages},
            "output": output,
        }
        if state.get("usage") is not None:
            span["usage"] = state["usage"]
        if state.get("finish_reason"):
            span["attributes"] = {"finishReason": state["finish_reason"]}
        if prompt_version_id:
            span["promptVersionId"] = prompt_version_id
        return span

    # ── run_tool_loop ──────────────────────────────────────────────────────

    async def _prepare_tool_routes(
        self,
        tools: Optional[Sequence[Callable[..., Any]]],
        tool_refs: Optional[List[ToolRef]],
        client_tools: Optional[ClientToolsMap],
        dispatch: Optional[DispatchFn],
        sync: bool,
        *,
        inline_schemas: bool = False,
    ) -> Tuple[Dict[str, _ToolRoute], List[ToolRef], List[ToolDefinition]]:
        """Route every tool the caller passed, and build the two shapes a round needs.

        :param tools: ``@acrux.tool``-decorated functions, synced then run locally.
        :param tool_refs: Catalog refs, resolved here for their definitions and executors.
        :param client_tools: Implementations for catalog tools whose executor is
            ``client``, keyed by tool name.
        :param dispatch: Fallback executor for client tools not in ``client_tools``.
        :param sync: Whether ``tools=`` are reconciled with the catalog before the run.
        :param inline_schemas: True on the BYO-provider path, where the returned inline
            schemas are what the model actually reads. Only then is a decorated function
            with no docstring resolved against the catalog, so the dashboard-authored
            description reaches the model the way it does on the gateway path — the
            gateway resolves ``tool_refs`` itself, a BYO provider cannot.
        :returns: ``(routes, refs, inlined_schemas)``.
        :raises AcruxCoreError: When a function is not decorated, when a client tool has
            no implementation, or when a ref does not resolve.
        """
        routes: Dict[str, _ToolRoute] = {}
        refs: List[ToolRef] = []
        inlined_schemas: List[Dict[str, Any]] = []
        # (index into inlined_schemas, ref to resolve) for every synced spec whose
        # function carries no docstring — the catalog owns its description.
        undescribed: List[Tuple[int, ToolRef]] = []

        specs: List[ToolSpec] = []
        for fn in tools or []:
            spec = spec_of(fn)
            if spec is None:
                name = getattr(fn, "__name__", repr(fn))
                raise AcruxCoreError(
                    f"acruxcore: '{name}' passed to tools= is not decorated with @acrux.tool. "
                    "Raw OpenAI tool definitions go in tool_defs=.",
                    API_ERROR,
                )
            specs.append(spec)

        for spec in specs:
            tool_version_id: Optional[str] = None
            if sync:
                result = await self._host.tools.sync_one(spec)
                tool_version_id = f"{result.tool_id}:{result.version_number}"
            routes[spec.name] = _ToolRoute(
                kind="local", fn=spec.fn, alias=spec.alias, tool_version_id=tool_version_id
            )
            refs.append({"name": spec.name, "alias": spec.alias})
            if inline_schemas and not spec.description:
                if tool_version_id is not None:
                    undescribed.append((len(inlined_schemas), {"name": spec.name, "alias": spec.alias}))
                else:
                    warnings.warn(
                        f"acruxcore: tool '{spec.name}' has no docstring and sync=False, so its "
                        f"description cannot be read from the catalog. A BYO provider will see "
                        f"this tool with no description at all. Add a docstring, or leave sync on "
                        f"so the dashboard's description is fetched.",
                        stacklevel=4,
                    )
            inlined_schemas.append({
                "type": "function",
                "function": {
                    "name": spec.name,
                    **({"description": spec.description} if spec.description else {}),
                    "parameters": spec.parameters_schema,
                },
            })

        caller_refs = list(tool_refs or [])
        if caller_refs:
            resolved: List[ResolvedTool] = await self._host.tools.resolve(caller_refs)
            for ref, item in zip(caller_refs, resolved):
                name = item.name
                version_id = f"{item.tool_id}:{item.version_number}"
                if name in routes:
                    continue
                supplied = (client_tools or {}).get(name)
                if item.executor_type == "http":
                    # An entry in client_tools for an http tool is ignored, not flagged: the
                    # platform runs the tool, and one map is expected to serve aliases whose
                    # executor differs — production http, staging client — so warning here
                    # would fire on every correct run of a two-alias script.
                    routes[name] = _ToolRoute(
                        kind="http",
                        tool_id=item.tool_id,
                        alias=ref.get("alias"),
                        version_number=ref.get("version"),
                        tool_version_id=version_id,
                    )
                elif supplied is not None:
                    arity_error = _client_tool_arity_error(name, supplied, item.function)
                    if arity_error is not None:
                        raise AcruxCoreError(arity_error, VALIDATION_ERROR)
                    # A local route, but the definition and the version stamp stay the
                    # catalog's — unlike tools=[fn], which would commit a new version from
                    # the local schema and drop the binding's pin.
                    routes[name] = _ToolRoute(
                        kind="local",
                        fn=supplied,
                        alias=ref.get("alias"),
                        version_number=ref.get("version"),
                        tool_version_id=version_id,
                        result_schema=item.result_schema,
                        result_schema_severity=item.result_schema_severity,
                    )
                elif dispatch is not None:
                    routes[name] = _ToolRoute(
                        kind="dispatch",
                        alias=ref.get("alias"),
                        version_number=ref.get("version"),
                        tool_version_id=version_id,
                    )
                else:
                    # Naming the keys that *were* supplied is what turns a typo'd key from a
                    # puzzle into a one-second fix.
                    held = (
                        f" client_tools held: {sorted(client_tools)}."
                        if client_tools is not None
                        else ""
                    )
                    raise AcruxCoreError(
                        f"acruxcore: tool '{name}' has a client executor, so something has to run "
                        f"it, but no implementation was supplied. Pass it in "
                        f"client_tools={{'{name}': ...}}, or pass dispatch=.{held}",
                        MISSING_DISPATCH,
                    )
                refs.append(
                    {
                        "name": name,
                        **({"alias": ref["alias"]} if ref.get("alias") else {}),
                        **({"version": ref["version"]} if ref.get("version") is not None else {}),
                    }
                )
                inlined_schemas.append({"type": "function", "function": item.function})

        if undescribed:
            # One batched round trip, and only on the BYO path for tools that would
            # otherwise reach the model with no description at all.
            catalog = await self._host.tools.resolve([ref for _, ref in undescribed])
            for (index, ref), item in zip(undescribed, catalog):
                description = (item.function or {}).get("description")
                if description:
                    inlined_schemas[index]["function"]["description"] = description
                else:
                    warnings.warn(
                        f"acruxcore: tool '{ref['name']}' has no description — the function has "
                        f"no docstring and the catalog version behind alias "
                        f"'{ref.get('alias') or 'production'}' carries none either. A BYO provider "
                        f"will see this tool with no description at all, so the model has nothing "
                        f"telling it when to call it. Add a docstring, or write a description on "
                        f"the tool in the dashboard.",
                        stacklevel=4,
                    )

        return routes, refs, inlined_schemas

    @overload
    async def run_tool_loop(
        self,
        model: str,
        messages: List[Message],
        *,
        stream: Literal[False] = False,
        tools: Optional[Sequence[Callable[..., Any]]] = ...,
        tool_defs: Optional[List[ToolDefinition]] = ...,
        tool_refs: Optional[List[ToolRef]] = ...,
        client_tools: Optional[ClientToolsMap] = ...,
        dispatch: Optional[DispatchFn] = ...,
        sync: bool = ...,
        max_iterations: int = ...,
        temperature: Optional[float] = ...,
        max_tokens: Optional[int] = ...,
        response_format: Optional[ResponseFormat] = ...,
        trace: Union[bool, Dict[str, Any]] = ...,
        provider: Optional[ProviderConfig] = ...,
        gateway: Optional[GatewayControl] = ...,
        prompt_version_id: Optional[str] = ...,
        variables: Optional[Dict[str, Any]] = ...,
    ) -> RunToolLoopResult: ...

    @overload
    async def run_tool_loop(
        self,
        model: str,
        messages: List[Message],
        *,
        stream: Literal[True],
        tools: Optional[Sequence[Callable[..., Any]]] = ...,
        tool_defs: Optional[List[ToolDefinition]] = ...,
        tool_refs: Optional[List[ToolRef]] = ...,
        client_tools: Optional[ClientToolsMap] = ...,
        dispatch: Optional[DispatchFn] = ...,
        sync: bool = ...,
        max_iterations: int = ...,
        temperature: Optional[float] = ...,
        max_tokens: Optional[int] = ...,
        response_format: Optional[ResponseFormat] = ...,
        trace: Union[bool, Dict[str, Any]] = ...,
        provider: Optional[ProviderConfig] = ...,
        gateway: Optional[GatewayControl] = ...,
        prompt_version_id: Optional[str] = ...,
        variables: Optional[Dict[str, Any]] = ...,
    ) -> "AsyncToolLoopStream": ...

    async def run_tool_loop(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[Sequence[Callable[..., Any]]] = None,
        tool_defs: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        client_tools: Optional[ClientToolsMap] = None,
        dispatch: Optional[DispatchFn] = None,
        sync: bool = True,
        max_iterations: int = 10,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        response_format: Optional[ResponseFormat] = None,
        trace: Union[bool, Dict[str, Any]] = True,
        provider: Optional[ProviderConfig] = None,
        gateway: Optional[GatewayControl] = None,
        prompt_version_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
        stream: bool = False,
    ) -> Union[RunToolLoopResult, "AsyncToolLoopStream"]:
        """Run the full tool-calling loop, then — when ``response_format`` is also
        given — shape the gathered facts into one typed answer.

        :param variables: The values the messages were rendered from, stamped on every
            ``llm`` span this loop records. Worth passing whenever ``prompt_version_id``
            is, because the two are one fact together: an evaluation dataset example *is*
            the variables plus the version, so a run naming a version without them can
            never seed one. Alongside a version id these are lineage only — the messages
            are already rendered and are not re-rendered. Never sent to a BYO provider.
        :param client_tools: ``{tool_name: function}`` for catalog tools whose executor is
            ``client``, so the loop can run them without a hand-written dispatcher. Only
            ``client`` tools belong here — an ``http`` tool runs on the platform, and
            naming one warns that the function will never be called. Unlike ``tools=``,
            nothing is written to the catalog: the definition, the binding's alias or pin,
            and the version stamp on the tool span all stay the catalog's. Each function is
            called with the schema's own parameter names as keywords, so
            ``search_flights(origin=..., destination=...)`` — not one ``args`` dict.
        :param stream: ``True`` returns an :class:`AsyncToolLoopStream` of typed events
            instead of the finished result, so a UI can show model text as it arrives and
            render "running get_weather…" as its own state::

                async for event in await hub.gateway.run_tool_loop(model, msgs, tools=[fn], stream=True):
                    if event.type == "content":     print(event.delta, end="")
                    elif event.type == "tool_call": print(f"[{event.name}]")

            The last event of a successful stream is ``done``, carrying the same
            :class:`~acruxcore.types.RunToolLoopResult` this method returns unstreamed.
            The trace is identical either way — the gateway files one ``llm`` span per
            round, streamed or not, and the SDK's tool spans hang off it.
        """
        if stream:
            return AsyncToolLoopStream(
                self._run_tool_loop_stream(
                    model, messages, tools=tools, tool_defs=tool_defs, tool_refs=tool_refs,
                    client_tools=client_tools, dispatch=dispatch, sync=sync,
                    max_iterations=max_iterations,
                    temperature=temperature, max_tokens=max_tokens,
                    response_format=response_format, trace=trace, provider=provider,
                    gateway=gateway,
                    prompt_version_id=prompt_version_id, variables=variables,
                )
            )

        has_tools = bool(tools or tool_defs or tool_refs)
        shaping = response_format is not None and has_tools

        gathered = await self._run_tool_loop_gather(
            model, messages, tools=tools, tool_defs=tool_defs, tool_refs=tool_refs,
            client_tools=client_tools, dispatch=dispatch, sync=sync, max_iterations=max_iterations,
            temperature=temperature, max_tokens=max_tokens,
            response_format=None if shaping else response_format,
            trace=trace, provider=provider, gateway=gateway,
            prompt_version_id=prompt_version_id,
            variables=variables,
        )
        if not shaping:
            return gathered

        shape_nudge = "Produce your final response now, as the JSON object defined by the response schema."
        convo = list(gathered.messages)
        if convo and convo[-1].get("role") == "assistant" and not convo[-1].get("tool_calls"):
            convo = convo[:-1]
        convo.append({"role": "user", "content": shape_nudge})
        if trace is False:
            p2_trace: Union[bool, Dict[str, Any]] = False
        elif isinstance(trace, dict):
            p2_trace = {**trace, "trace_id": gathered.trace_id}
        else:
            p2_trace = {"trace_id": gathered.trace_id}
        shaped = await self._run_tool_loop_gather(
            model, convo, tools=None, tool_defs=None, tool_refs=None, dispatch=dispatch,
            sync=False, max_iterations=1, temperature=temperature, max_tokens=max_tokens,
            response_format=response_format, trace=p2_trace, provider=provider,
            gateway=gateway,
            prompt_version_id=prompt_version_id, variables=variables,
        )
        shaped_assistant = shaped.messages[-1] if shaped.messages else None
        final_messages = list(gathered.messages)
        if shaped_assistant:
            final_messages.append({"role": "user", "content": shape_nudge})
            final_messages.append(shaped_assistant)
        return RunToolLoopResult(
            content=shaped.content,
            messages=final_messages,
            iterations=gathered.iterations,
            stopped_at_limit=gathered.stopped_at_limit,
            trace_id=gathered.trace_id or shaped.trace_id,
        )

    @overload
    async def run_prompt_with_tools(
        self,
        rendered: RenderResult,
        *,
        stream: Literal[False] = False,
        model: Optional[str] = ...,
        messages: Optional[List[Message]] = ...,
        tools: Optional[Sequence[Callable[..., Any]]] = ...,
        tool_defs: Optional[List[ToolDefinition]] = ...,
        tool_refs: Optional[List[ToolRef]] = ...,
        client_tools: Optional[ClientToolsMap] = ...,
        dispatch: Optional[DispatchFn] = ...,
        sync: bool = ...,
        max_iterations: int = ...,
        temperature: Optional[float] = ...,
        max_tokens: Optional[int] = ...,
        response_format: Optional[ResponseFormat] = ...,
        trace: Union[bool, Dict[str, Any]] = ...,
        provider: Optional[ProviderConfig] = ...,
        gateway: Optional[GatewayControl] = ...,
        prompt_version_id: Optional[str] = ...,
        variables: Optional[Dict[str, Any]] = ...,
    ) -> RunToolLoopResult: ...

    @overload
    async def run_prompt_with_tools(
        self,
        rendered: RenderResult,
        *,
        stream: Literal[True],
        model: Optional[str] = ...,
        messages: Optional[List[Message]] = ...,
        tools: Optional[Sequence[Callable[..., Any]]] = ...,
        tool_defs: Optional[List[ToolDefinition]] = ...,
        tool_refs: Optional[List[ToolRef]] = ...,
        client_tools: Optional[ClientToolsMap] = ...,
        dispatch: Optional[DispatchFn] = ...,
        sync: bool = ...,
        max_iterations: int = ...,
        temperature: Optional[float] = ...,
        max_tokens: Optional[int] = ...,
        response_format: Optional[ResponseFormat] = ...,
        trace: Union[bool, Dict[str, Any]] = ...,
        provider: Optional[ProviderConfig] = ...,
        gateway: Optional[GatewayControl] = ...,
        prompt_version_id: Optional[str] = ...,
        variables: Optional[Dict[str, Any]] = ...,
    ) -> "AsyncToolLoopStream": ...

    async def run_prompt_with_tools(
        self,
        rendered: RenderResult,
        *,
        model: Optional[str] = None,
        messages: Optional[List[Message]] = None,
        tools: Optional[Sequence[Callable[..., Any]]] = None,
        tool_defs: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        client_tools: Optional[ClientToolsMap] = None,
        dispatch: Optional[DispatchFn] = None,
        sync: bool = True,
        max_iterations: int = 10,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        response_format: Optional[ResponseFormat] = None,
        trace: Union[bool, Dict[str, Any]] = True,
        provider: Optional[ProviderConfig] = None,
        gateway: Optional[GatewayControl] = None,
        prompt_version_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
        stream: bool = False,
    ) -> Union[RunToolLoopResult, "AsyncToolLoopStream"]:
        """Run a rendered prompt's own tools in the loop — the two-line way::

            r = await hub.prompts.render("weather-brief", "staging", {"city": "Lisbon"})
            result = await hub.gateway.run_prompt_with_tools(r)

        Everything the loop needs is already in the render result, so nothing is restated
        at the call site: the model comes from the prompt version's bound model, the
        messages from the render, the tools from the prompt's bindings, and
        ``prompt_version_id`` from the resolved version — that last one is the easy one to
        forget by hand, and forgetting it costs trace lineage silently, since the call
        still works.

        A binding pinned to an exact tool version travels as a pin, not as its alias, so a
        pinned prompt keeps running the build it was pinned to.

        Every keyword is optional and wins over the derived value when passed, so
        ``run_prompt_with_tools(r, model="gpt-4o-mini")`` overrides the bound model. The
        rest pass straight through to :meth:`run_tool_loop`.

        **A prompt with no tools bound still runs**, as a plain completion — the name reads
        slightly wrong there, but erroring would fail an unconfigured prompt for no reason.

        :param rendered: A :class:`~acruxcore.types.RenderResult` from
            :meth:`AcruxCore.render_prompt`.
        :param model: Overrides the version's bound model.
        :param messages: Overrides the rendered messages.
        :param variables: Overrides the variables taken from the render result. Those are
            forwarded for you, which is what lets feedback on the run become an
            evaluation dataset example — pass this only when the messages you supplied
            were rendered from something else.
        :param tool_refs: Overrides the prompt's bindings entirely — pass ``[]`` to run the
            prompt with no tools at all.
        :param client_tools: ``{tool_name: function}`` for the prompt's ``client``-executor
            tools — the way to run them without writing a dispatcher::

                run_prompt_with_tools(r, client_tools={"search_flights": search_flights})

            Only ``client`` tools appear here; the prompt's ``http`` tools run on the
            platform and need nothing from you. See :meth:`run_tool_loop` for the full
            contract.
        :param stream: ``True`` returns an :class:`AsyncToolLoopStream` of typed events,
            exactly as on :meth:`run_tool_loop`.
        :returns: The loop's result, or an event stream when ``stream=True``.
        :raises AcruxCoreError: ``VALIDATION_ERROR`` when the prompt version has no bound
            model and no ``model=`` was passed, or when a ``client_tools`` function cannot
            receive its tool's required arguments; ``MISSING_DISPATCH`` when a bound tool
            has a ``client`` executor and neither ``client_tools`` nor ``dispatch`` can run
            it. Both are raised before the first model call.
        """
        effective_model = model or rendered.model
        if not effective_model:
            raise AcruxCoreError(
                "acruxcore: this prompt version has no bound model, so there is nothing to "
                "run it on. Either bind a default model on the prompt version, or pass "
                "model= to run_prompt_with_tools().",
                VALIDATION_ERROR,
            )

        derived_refs: List[ToolRef] = [
            (
                {"name": r.name, "version": r.pinned_version_number}
                if r.pinned_version_number is not None
                else ({"name": r.name, "alias": r.alias} if r.alias else {"name": r.name})
            )
            for r in rendered.tool_resolutions
        ]

        # Handing over an implementation and resolving nothing to run it is the mistake
        # this method used to keep to itself. The plain-completion fallback is right by
        # default — an unconfigured prompt should not raise — but the caller who passed
        # `client_tools` has said what they expect, and the run answering anyway is how
        # "my tool is never called" becomes a debugging session with no error to search
        # for. A warning rather than a raise: the completion is still a real answer, and
        # raising here would break callers who pass one map across several prompts.
        #
        # What decides whether anything is actually offered to the model is the same
        # three inputs `_prepare_tool_routes` turns into a non-empty route/ref set: a
        # `tools=` function, a resolved catalog ref (bound on the prompt, or passed as
        # tool_refs= and overriding the binding), or a raw `tool_defs=` schema sent
        # straight through. Only `client_tools` and `dispatch` are pure *implementations*
        # with nothing of their own to offer — a `tools=` function or a `tool_defs=`
        # schema is offered and dispatched regardless of whether tool_refs resolved to
        # anything, so checking `derived_refs` alone (the old condition) warned on runs
        # that worked fine.
        effective_tool_refs = tool_refs if tool_refs is not None else derived_refs
        will_offer_tools = bool(tools) or bool(effective_tool_refs) or bool(tool_defs)
        if not will_offer_tools:
            supplied = sorted(client_tools) if client_tools else []
            if supplied or dispatch is not None:
                named = f" for {', '.join(repr(n) for n in supplied)}" if supplied else ""
                warnings.warn(
                    f"acruxcore: you passed tool implementations{named}, but this prompt has "
                    f"no tools bound, so the run is a plain completion and none of them will "
                    f"be called. Connect the tool on the prompt's Tools tab in the dashboard, "
                    f"or pass tool_refs=[{{'name': ...}}] to name it on this call.",
                    stacklevel=2,
                )

        return await self.run_tool_loop(  # type: ignore[call-overload,no-any-return]
            effective_model,
            messages if messages is not None else rendered.messages,
            tools=tools,
            tool_defs=tool_defs,
            tool_refs=effective_tool_refs,
            client_tools=client_tools,
            dispatch=dispatch,
            sync=sync,
            max_iterations=max_iterations,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
            trace=trace,
            provider=provider,
            gateway=gateway,
            prompt_version_id=prompt_version_id or rendered.version_id,
            variables=variables if variables is not None else rendered.variables,
            stream=stream,
        )

    async def _run_tool_loop_gather(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[Sequence[Callable[..., Any]]] = None,
        tool_defs: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        client_tools: Optional[ClientToolsMap] = None,
        dispatch: Optional[DispatchFn] = None,
        sync: bool = True,
        max_iterations: int = 10,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        response_format: Optional[ResponseFormat] = None,
        trace: Union[bool, Dict[str, Any]] = True,
        provider: Optional[ProviderConfig] = None,
        gateway: Optional[GatewayControl] = None,
        prompt_version_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
    ) -> RunToolLoopResult:
        provider_config = provider or self._host._provider_default
        routes, effective_refs, inlined_schemas = await self._prepare_tool_routes(
            tools, tool_refs, client_tools, dispatch, sync,
            inline_schemas=provider_config is not None,
        )

        model = _require_model(model)
        byo_tool_schemas: Optional[List[ToolDefinition]] = (
            [*(tool_defs or []), *inlined_schemas]
            if provider_config is not None and (tool_defs or inlined_schemas)
            else None
        )

        trace_enabled = trace is not False
        trace_conf: Dict[str, Any] = trace if isinstance(trace, dict) else {}
        # "runToolLoop" is this SDK's own default, not a name the caller chose, so it
        # travels on the weaker `x-trace-name-if-unset` channel: the server fills it in
        # only when the trace has no real name yet. A caller's explicit `name` is an
        # instruction and still overwrites (issue #358, phase-3 FAQ Q33).
        trace_name: Optional[str] = trace_conf.get("name")
        # The SDK creates the trace itself on the BYO path, where no server-side default
        # applies, so its own payloads still need a concrete name.
        payload_trace_name = trace_name or "runToolLoop"
        session_id = trace_conf.get("session_id")

        convo: List[Message] = list(messages)
        tool_spans: List[IngestSpan] = []
        trace_id: Optional[str] = trace_conf.get("trace_id")

        # try/finally, not three call sites. The buffered tool spans used to be reported
        # only on the three paths someone remembered to add a call to, so a round that
        # raised — the provider erroring mid-loop — silently discarded every tool span the
        # run had already produced. The trace then showed a run that made no tool calls at
        # all (issue #452).
        try:
            for i in range(max_iterations):
                extra_headers: Optional[Dict[str, str]] = None
                if trace_enabled and provider_config is None:
                    extra_headers = _gateway_trace_headers(
                        {**trace_conf, "name": trace_name, "trace_id": trace_id,
                         "_default_name": "runToolLoop"}
                    )

                round_start_time = _now_iso()
                if provider_config is not None:
                    result = await self._complete_via_provider(
                        model, convo, tools=byo_tool_schemas,
                        response_format=response_format,
                        temperature=temperature, max_tokens=max_tokens,
                        provider_config=provider_config,
                    )
                else:
                    result = await self._complete_once(
                        model, convo, tools=tool_defs, tool_refs=effective_refs or None,
                        response_format=response_format,
                        temperature=temperature, max_tokens=max_tokens, extra_headers=extra_headers,
                        prompt_version_id=prompt_version_id, variables=variables, gateway=gateway,
                    )

                if trace_enabled and not trace_id:
                    trace_id = result.gateway.trace_id
                llm_span_ref = result.gateway.span_ref

                if provider_config is not None and trace_enabled:
                    llm_span_id_for_round = result.gateway.span_ref or f"llm-{i}"
                    llm_span: IngestSpan = {
                        "spanId": llm_span_id_for_round,
                        "name": result.model,
                        "kind": "llm",
                        "status": "ok",
                        "startTime": round_start_time,
                        "endTime": _now_iso(),
                        "model": result.model,
                        "input": {"messages": convo},
                        "output": result.message,
                    }
                    if result.gateway.provider:
                        llm_span["provider"] = result.gateway.provider
                    if result.usage is not None:
                        llm_span["usage"] = {
                            "promptTokens": result.usage.prompt_tokens,
                            "completionTokens": result.usage.completion_tokens,
                            "totalTokens": result.usage.total_tokens,
                        }
                    if prompt_version_id:
                        llm_span["promptVersionId"] = prompt_version_id
                    if variables is not None:
                        llm_span["variables"] = variables
                    llm_trace_payload: TraceInput = {"name": payload_trace_name, "spans": [llm_span]}
                    if trace_id:
                        llm_trace_payload["traceId"] = trace_id
                    if session_id:
                        llm_trace_payload["sessionId"] = session_id
                    must_await_trace_open = i == 0 and any(
                        r.kind == "http" for r in routes.values()
                    )
                    if must_await_trace_open:
                        try:
                            await self._host._request("POST", "/traces", {"traces": [llm_trace_payload]}, "reporting llm span")
                        except Exception as err:
                            warnings.warn(
                                "[acruxcore] run_tool_loop llm-span report failed — continuing "
                                f"without it: {err}",
                                stacklevel=2,
                            )
                    else:
                        self._host._span_queue.enqueue(llm_trace_payload)

                calls = result.message.get("tool_calls") or []
                if result.finish_reason != "tool_calls" or len(calls) == 0:
                    return RunToolLoopResult(
                        content=result.content or "",
                        messages=[*convo, result.message],
                        iterations=i + 1,
                        stopped_at_limit=False,
                        trace_id=trace_id,
                    )

                settled = await asyncio.gather(
                    *[
                        self._dispatch_tool_call(
                            call,
                            call_index=idx,
                            round_index=i,
                            routes=routes,
                            dispatch=dispatch,
                            trace_enabled=trace_enabled,
                            trace_id=trace_id,
                            llm_span_ref=llm_span_ref,
                            tool_spans=tool_spans,
                        )
                        for idx, call in enumerate(calls)
                    ],
                    return_exceptions=True,
                )

                failure = next((s for s in settled if isinstance(s, BaseException)), None)
                if failure is not None:
                    raise failure

                tool_msgs: List[Message] = [s for s in settled]  # type: ignore[misc]
                convo = [*convo, result.message, *tool_msgs]
        finally:
            self._report_tool_spans(
                trace_enabled, trace_id, payload_trace_name, session_id, tool_spans
            )

        return RunToolLoopResult(
            content="", messages=convo, iterations=max_iterations,
            stopped_at_limit=True, trace_id=trace_id,
        )

    async def _run_tool_loop_stream(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[Sequence[Callable[..., Any]]],
        tool_defs: Optional[List[ToolDefinition]],
        tool_refs: Optional[List[ToolRef]],
        client_tools: Optional[ClientToolsMap],
        dispatch: Optional[DispatchFn],
        sync: bool,
        max_iterations: int,
        temperature: Optional[float],
        max_tokens: Optional[int],
        response_format: Optional[ResponseFormat],
        trace: Union[bool, Dict[str, Any]],
        provider: Optional[ProviderConfig],
        gateway: Optional[GatewayControl],
        prompt_version_id: Optional[str],
        variables: Optional[Dict[str, Any]],
    ) -> AsyncGenerator[ToolLoopEvent, None]:
        """The streaming twin of :meth:`_run_tool_loop_gather`, as an event stream.

        Same rounds, same routing, same spans — the only difference is that each round's
        completion is streamed, so model text can be forwarded while the round is still
        running. Tool calls are dispatched through :meth:`_dispatch_tool_call`, the one
        place either loop runs a tool.
        """
        provider_config = provider or self._host._provider_default
        routes, effective_refs, inlined_schemas = await self._prepare_tool_routes(
            tools, tool_refs, client_tools, dispatch, sync,
            inline_schemas=provider_config is not None,
        )

        model = _require_model(model)
        byo_tool_schemas: Optional[List[ToolDefinition]] = (
            [*(tool_defs or []), *inlined_schemas]
            if provider_config is not None and (tool_defs or inlined_schemas)
            else None
        )

        # With tools AND a response_format, the gathered answer is re-asked for as JSON in
        # a final round (the gateway rejects both on one request). Only that round's text
        # is the answer, so the gather rounds' prose is not forwarded — a caller who asked
        # for JSON should not be handed the prose draft first.
        has_tools = bool(routes or tool_defs)
        shaping = response_format is not None and has_tools
        gather_response_format = None if shaping else response_format

        trace_enabled = trace is not False
        trace_conf: Dict[str, Any] = trace if isinstance(trace, dict) else {}
        # "runToolLoop" is this SDK's own default, not a name the caller chose, so it
        # travels on the weaker `x-trace-name-if-unset` channel: the server fills it in
        # only when the trace has no real name yet. A caller's explicit `name` is an
        # instruction and still overwrites (issue #358, phase-3 FAQ Q33).
        trace_name: Optional[str] = trace_conf.get("name")
        # The SDK creates the trace itself on the BYO path, where no server-side default
        # applies, so its own payloads still need a concrete name.
        payload_trace_name = trace_name or "runToolLoop"
        session_id = trace_conf.get("session_id")

        convo: List[Message] = list(messages)
        tool_spans: List[IngestSpan] = []
        state: Dict[str, Any] = {"trace_id": trace_conf.get("trace_id")}
        gathered: Optional[RunToolLoopResult] = None

        # Same try/finally as the blocking loop: a round that raises must not take the
        # tool spans the run already produced down with it (issue #452). An async
        # generator makes this matter more, not less — an abandoned consumer unwinds
        # through `finally` here too.
        try:
            for i in range(max_iterations):
                round_out: Dict[str, Any] = {}
                async for event in self._stream_one_round(
                    model=model,
                    convo=convo,
                    round_index=i,
                    emit_content=not shaping,
                    tool_defs=tool_defs,
                    effective_refs=effective_refs,
                    byo_tool_schemas=byo_tool_schemas,
                    response_format=gather_response_format,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    provider_config=provider_config,
                    gateway=gateway,
                    prompt_version_id=prompt_version_id,
                    variables=variables,
                    trace_enabled=trace_enabled,
                    trace_conf=trace_conf,
                    trace_name=trace_name,
                    payload_trace_name=payload_trace_name,
                    session_id=session_id,
                    state=state,
                    out=round_out,
                ):
                    yield event

                message: Message = round_out["message"]
                calls: List[Dict[str, Any]] = list(message.get("tool_calls") or [])
                trace_id: Optional[str] = state["trace_id"]

                if round_out["finish_reason"] != "tool_calls" or not calls:
                    gathered = RunToolLoopResult(
                        content=message.get("content") or "",
                        messages=[*convo, message],
                        iterations=i + 1,
                        stopped_at_limit=False,
                        trace_id=trace_id,
                    )
                    break

                for call in calls:
                    yield ToolLoopToolCallEvent(
                        id=call["id"],
                        name=call["function"]["name"],
                        arguments=_parse_tool_arguments(call),
                        round=i,
                    )

                # One queue entry per call, whichever way it ended, so a tool that raises
                # before it ever runs (nothing to dispatch it) cannot leave this waiting.
                done_queue: "asyncio.Queue[str]" = asyncio.Queue()
                outcomes: Dict[str, Tuple[Any, Optional[str]]] = {}

                def note(call_id: str, _name: str, result: Any, error: Optional[str]) -> None:
                    outcomes[call_id] = (result, error)

                async def run_one(call: Dict[str, Any], index: int) -> Message:
                    try:
                        return await self._dispatch_tool_call(
                            call,
                            call_index=index,
                            round_index=i,
                            routes=routes,
                            dispatch=dispatch,
                            trace_enabled=trace_enabled,
                            trace_id=trace_id,
                            llm_span_ref=round_out["span_ref"],
                            tool_spans=tool_spans,
                            on_settled=note,
                        )
                    except BaseException as err:
                        outcomes.setdefault(call["id"], (None, str(err)))
                        raise
                    finally:
                        done_queue.put_nowait(call["id"])

                tasks = [asyncio.ensure_future(run_one(c, idx)) for idx, c in enumerate(calls)]
                names = {c["id"]: c["function"]["name"] for c in calls}
                for _ in range(len(tasks)):
                    call_id = await done_queue.get()
                    result, error = outcomes.get(call_id, (None, None))
                    yield ToolLoopToolResultEvent(
                        id=call_id, name=names.get(call_id, ""), round=i, result=result, error=error
                    )

                settled = await asyncio.gather(*tasks, return_exceptions=True)
                failure = next((s for s in settled if isinstance(s, BaseException)), None)
                if failure is not None:
                    raise failure

                convo = [*convo, message, *[s for s in settled]]  # type: ignore[list-item]
            else:
                gathered = RunToolLoopResult(
                    content="",
                    messages=convo,
                    iterations=max_iterations,
                    stopped_at_limit=True,
                    trace_id=state["trace_id"],
                )
        finally:
            self._report_tool_spans(
                trace_enabled, state["trace_id"], payload_trace_name, session_id, tool_spans
            )

        assert gathered is not None  # every path above assigns it

        if not shaping:
            yield ToolLoopDoneEvent(result=gathered)
            return

        # ── shaping round: same nudge as the blocking loop, streamed ────────────
        shape_nudge = (
            "Produce your final response now, as the JSON object defined by the response schema."
        )
        shape_convo = list(gathered.messages)
        if (
            shape_convo
            and shape_convo[-1].get("role") == "assistant"
            and not shape_convo[-1].get("tool_calls")
        ):
            shape_convo = shape_convo[:-1]
        shape_convo.append({"role": "user", "content": shape_nudge})

        shape_out: Dict[str, Any] = {}
        async for event in self._stream_one_round(
            model=model,
            convo=shape_convo,
            round_index=gathered.iterations,
            emit_content=True,
            tool_defs=None,
            effective_refs=[],
            byo_tool_schemas=None,
            response_format=response_format,
            temperature=temperature,
            max_tokens=max_tokens,
            provider_config=provider_config,
            gateway=gateway,
            prompt_version_id=prompt_version_id,
            variables=variables,
            trace_enabled=trace_enabled,
            trace_conf=trace_conf,
            trace_name=trace_name,
            payload_trace_name=payload_trace_name,
            session_id=session_id,
            state=state,
            out=shape_out,
        ):
            yield event

        shaped: Message = shape_out["message"]
        yield ToolLoopDoneEvent(
            result=RunToolLoopResult(
                content=shaped.get("content") or "",
                messages=[*gathered.messages, {"role": "user", "content": shape_nudge}, shaped],
                iterations=gathered.iterations,
                stopped_at_limit=gathered.stopped_at_limit,
                trace_id=state["trace_id"],
            )
        )

    async def _stream_one_round(
        self,
        *,
        model: str,
        convo: List[Message],
        round_index: int,
        emit_content: bool,
        tool_defs: Optional[List[ToolDefinition]],
        effective_refs: List[ToolRef],
        byo_tool_schemas: Optional[List[ToolDefinition]],
        response_format: Optional[ResponseFormat],
        temperature: Optional[float],
        max_tokens: Optional[int],
        provider_config: Optional[ProviderConfig],
        gateway: Optional[GatewayControl],
        prompt_version_id: Optional[str],
        variables: Optional[Dict[str, Any]],
        trace_enabled: bool,
        trace_conf: Dict[str, Any],
        trace_name: Optional[str],
        payload_trace_name: str,
        session_id: Optional[str],
        state: Dict[str, Any],
        out: Dict[str, Any],
    ) -> AsyncGenerator[ToolLoopEvent, None]:
        """Stream one round of a tool loop, yielding its ``content`` events.

        Fills ``out`` with ``message`` (the assembled assistant turn), ``finish_reason``
        and ``span_ref`` (the round's ``llm`` span, which its tool spans parent onto), and
        seeds ``state["trace_id"]`` on the first round so every later round joins the same
        trace.

        :param emit_content: ``False`` accumulates the round's text without forwarding it,
            for the gather rounds of a ``response_format`` run.
        """
        body = self._build_chat_body(
            model,
            convo,
            byo_tool_schemas if provider_config is not None else tool_defs,
            None if provider_config is not None else (effective_refs or None),
            None,
            response_format,
            temperature,
            max_tokens,
            True,
            prompt_version_id=None if provider_config is not None else prompt_version_id,
            variables=None if provider_config is not None else variables,
            gateway=None if provider_config is not None else gateway,
        )

        content_parts: List[str] = []
        tool_call_parts: Dict[int, Dict[str, str]] = {}
        finish_reason: Optional[str] = None

        def take(chunk: ChatChunk) -> Optional[str]:
            """Fold one chunk into the round's accumulators; return new text, if any."""
            nonlocal finish_reason
            if chunk.finish_reason:
                finish_reason = chunk.finish_reason
            delta = chunk.delta or {}
            for tc in delta.get("tool_calls") or []:
                part = tool_call_parts.setdefault(
                    tc.get("index", 0), {"id": "", "name": "", "arguments": ""}
                )
                if tc.get("id"):
                    part["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    part["name"] = fn["name"]
                if fn.get("arguments"):
                    part["arguments"] += fn["arguments"]
            text = delta.get("content")
            if text:
                content_parts.append(text)
            return text

        if provider_config is not None:
            provider_state: Dict[str, Any] = {}
            async for chunk in self._stream_round_via_provider(
                model, body, provider_config, provider_state
            ):
                text = take(chunk)
                if text and emit_content:
                    yield ToolLoopContentEvent(delta=text, round=round_index)

            # No gateway on this path, so nothing server-side recorded the round — the
            # client writes its `llm` span itself, exactly as the blocking BYO loop does.
            if state.get("trace_id") is None:
                state["trace_id"] = str(uuid.uuid4())
            span_ref = str(uuid.uuid4())
            if trace_enabled:
                span = self._byo_llm_span(
                    provider_state, convo, provider_config, prompt_version_id, variables,
                    span_id=span_ref,
                )
                payload: TraceInput = {"name": payload_trace_name, "spans": [span]}
                payload["traceId"] = state["trace_id"]
                if session_id:
                    payload["sessionId"] = session_id
                self._host._span_queue.enqueue(payload)
        else:
            extra_headers: Optional[Dict[str, str]] = None
            if trace_enabled:
                extra_headers = _gateway_trace_headers(
                    {**trace_conf, "name": trace_name, "trace_id": state.get("trace_id"),
                     "session_id": session_id, "_default_name": "runToolLoop"}
                )

            meta: Dict[str, GatewayCallMeta] = {}
            async for chunk in self._stream_chat(body, extra_headers, meta):
                text = take(chunk)
                if text and emit_content:
                    yield ToolLoopContentEvent(delta=text, round=round_index)

            gateway_meta = meta.get("gateway")
            span_ref = gateway_meta.span_ref if gateway_meta else None
            if trace_enabled and state.get("trace_id") is None and gateway_meta:
                state["trace_id"] = gateway_meta.trace_id

        assembled: List[ToolCall] = [
            {
                "id": p["id"],
                "type": "function",
                "function": {"name": p["name"], "arguments": p["arguments"]},
            }
            for _, p in sorted(tool_call_parts.items())
        ]
        message: Message = {"role": "assistant", "content": "".join(content_parts)}
        if assembled:
            message["tool_calls"] = assembled
        out["message"] = message
        out["finish_reason"] = finish_reason
        out["span_ref"] = span_ref

    async def _dispatch_tool_call(
        self,
        call: Dict[str, Any],
        *,
        call_index: int,
        round_index: int,
        routes: Dict[str, _ToolRoute],
        dispatch: Optional[DispatchFn],
        trace_enabled: bool,
        trace_id: Optional[str],
        llm_span_ref: Optional[str],
        tool_spans: List[IngestSpan],
        on_settled: Optional[Callable[[str, str, Any, Optional[str]], None]] = None,
    ) -> Message:
        """Run one tool call the model asked for and return its ``role: "tool"`` message.

        The single place any tool call is executed, shared by the blocking loop and the
        streaming one — routing (``http`` executor on the platform, decorated function
        in-process, or the caller's ``dispatch``), the ``tool`` span, and the error span
        all live here so the two loops cannot drift apart in what they run or record.

        A ``http`` route is executed by the platform, which writes that span itself, so
        this appends nothing to ``tool_spans`` for it — recording one here would show the
        same execution twice in the trace.

        :param call: One entry of the assistant message's ``tool_calls``.
        :param call_index: Position within the round, used to build a unique span id.
        :param round_index: 0-based loop round, likewise part of the span id.
        :param routes: Name → route table from :meth:`_prepare_tool_routes`.
        :param dispatch: The caller's fallback dispatcher, or ``None``.
        :param trace_enabled: ``False`` suppresses trace correlation on a platform execute.
        :param trace_id: Trace the loop is reporting under, for a platform execute.
        :param llm_span_ref: The round's ``llm`` span, which tool spans parent onto.
        :param tool_spans: Accumulator the caller reports once the loop ends.
        :param on_settled: Called as ``(id, name, result, error)`` the moment the tool
            finishes, before this coroutine returns — how the streaming loop emits a
            ``tool_result`` event per tool instead of one batch after all of them.
        :returns: The tool message to append to the conversation.
        :raises AcruxCoreError: ``MISSING_DISPATCH`` when nothing can run the tool.
        """
        name = call["function"]["name"]
        args = _parse_tool_arguments(call)
        route = routes.get(name)

        if route is not None and route.kind == "http":
            executed = await self._host.tools.execute(
                route.tool_id or "",
                args,
                alias=route.alias,
                version_number=route.version_number,
                trace_id=trace_id if trace_enabled else None,
                parent_span_id=llm_span_ref,
            )
            ret = executed.result
            # The platform already wrote this span, classification included — nothing is
            # appended to `tool_spans` for an http route. What it could not do is tell the
            # caller, so the classification is forwarded here.
            if on_settled is not None:
                on_settled(
                    call["id"],
                    name,
                    ret,
                    executed.error.get("message") if executed.error else None,
                )
            content = ret if isinstance(ret, str) else json.dumps(ret)
            return {"role": "tool", "tool_call_id": call["id"], "content": content}

        if route is not None and route.kind == "local" and route.fn is not None:
            local_fn = route.fn

            def runner() -> Any:
                return local_fn(**args)

        elif dispatch is not None:
            caller_dispatch = dispatch

            def runner() -> Any:
                return caller_dispatch(name, args)

        else:
            raise AcruxCoreError(
                f"acruxcore: the model called '{name}', which has no implementation. Pass it "
                f"in client_tools={{'{name}': ...}}, the decorated function in tools=[...], "
                "or pass dispatch=.",
                MISSING_DISPATCH,
            )

        tool_span_id = f"tool-{round_index}-{call_index}"
        tool_start = _now_iso()
        attributes: Dict[str, Any] = {"arguments": args, "executorType": "client"}
        if route is not None and route.tool_version_id:
            attributes["toolVersionId"] = route.tool_version_id
        try:
            ret = runner()
            if inspect.isawaitable(ret):
                ret = await ret
        except Exception as err:
            attributes["errorType"] = "transport"
            attributes["errorDetail"] = str(err)
            tool_spans.append(
                {
                    "spanId": tool_span_id,
                    "parentSpanId": llm_span_ref,
                    "name": name,
                    "kind": "tool",
                    "status": "error",
                    "startTime": tool_start,
                    "endTime": _now_iso(),
                    "input": args,
                    "attributes": attributes,
                    "error": str(err),
                }
            )
            if on_settled is not None:
                on_settled(call["id"], name, None, str(err))
            raise

        # A handler may hand back its own verdict via ToolResult.error/warn. Unwrapping it
        # HERE, in the one place either loop runs a tool, is what keeps the span shape
        # identical to the platform's `http` executor — see
        # apps/api/src/traces/spans/span-failure.ts.
        outcome = ret if isinstance(ret, ToolResult) else None
        if outcome is not None:
            ret = outcome.result

        failure: Optional[Dict[str, Any]] = None
        if outcome is not None:
            failure = {
                "errorType": "tool_declared",
                # The owner's own slug, kept beside the closed-vocabulary `errorType`
                # rather than inside it — see SpanFailure.code in the API's
                # span-failure.ts for why the two stay separate.
                "code": outcome.type,
                "message": outcome.message,
                "fatal": outcome.level == "error",
            }
        elif route is not None and route.result_schema:
            # The catalog's own contract, checked only when the owner declared nothing
            # themselves — an explicit verdict outranks an inferred one.
            mismatch = validate_against_schema(ret, route.result_schema)
            if mismatch:
                failure = {
                    "errorType": "schema_mismatch",
                    "message": mismatch,
                    "fatal": route.result_schema_severity == "error",
                }

        if failure is not None:
            attributes["errorType"] = failure["errorType"]
            if failure.get("code"):
                attributes["errorCode"] = failure["code"]
            attributes["errorDetail"] = failure["message"]
            if not failure["fatal"]:
                attributes["warning"] = {
                    "type": failure.get("code") or failure["errorType"],
                    "message": failure["message"],
                }

        span: IngestSpan = {
            "spanId": tool_span_id,
            "parentSpanId": llm_span_ref,
            "name": name,
            "kind": "tool",
            "status": "error" if failure is not None and failure["fatal"] else "ok",
            "startTime": tool_start,
            "endTime": _now_iso(),
            "input": args,
            "output": ret,
            "attributes": attributes,
        }
        if failure is not None and failure["fatal"]:
            span["error"] = failure["message"]
        tool_spans.append(span)

        # A declared failure does NOT stop the loop. Whether the agent keeps going is the
        # caller's decision; making the trace tell the truth is ours, and conflating the
        # two would change the behaviour of every existing tool.
        if on_settled is not None:
            settled_error = failure["message"] if failure is not None and failure["fatal"] else None
            on_settled(call["id"], name, ret, settled_error)
        content = ret if isinstance(ret, str) else json.dumps(ret)
        return {"role": "tool", "tool_call_id": call["id"], "content": content}

    def _report_tool_spans(
        self,
        trace_enabled: bool,
        trace_id: Optional[str],
        name: str,
        session_id: Optional[str],
        spans: List[IngestSpan],
    ) -> None:
        if not trace_enabled or len(spans) == 0:
            return
        payload: TraceInput = {"name": name, "spans": spans}
        if trace_id:
            payload["traceId"] = trace_id
        if session_id:
            payload["sessionId"] = session_id
        self._host._span_queue.enqueue(payload)

    # ── gateway meta ───────────────────────────────────────────────────────

    def _read_gateway_meta(self, response: httpx.Response) -> GatewayCallMeta:
        """Read the gateway's ``x-gateway-*`` response metadata headers."""
        cost = response.headers.get("x-gateway-cost-usd")
        return GatewayCallMeta(
            request_id=response.headers.get("x-gateway-request-id"),
            provider=response.headers.get("x-gateway-provider"),
            model=response.headers.get("x-gateway-model"),
            cost_usd=float(cost) if cost else None,
            cache=response.headers.get("x-gateway-cache"),
            trace_id=response.headers.get("x-gateway-trace-id"),
            span_ref=response.headers.get("x-gateway-span-id"),
        )


class AsyncChatStream:
    """Async iterator over a streaming chat call.

    Returned by ``client.gateway.chat(..., stream=True)`` or ``client.gateway.stream(...)``.
    Iterate it with ``async for``::

        async for chunk in await client.gateway.stream(model, messages):
            print(chunk.delta.get("content", ""), end="")
    """

    def __init__(
        self,
        gw: GatewayNamespace,
        body: Dict[str, Any],
        *,
        provider_config: Optional[ProviderConfig] = None,
        model: Optional[str] = None,
        messages: Optional[List[Message]] = None,
        prompt_version_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
        trace_opt: Union[bool, Dict[str, Any], None] = None,
    ) -> None:
        if provider_config is not None:
            self._gen = gw._stream_via_provider(
                model or body.get("model"), messages or body.get("messages") or [], body,
                provider_config, prompt_version_id, variables,
                trace_opt if trace_opt is not None else True,
            )
        else:
            stream_headers: Optional[Dict[str, str]] = (
                _gateway_trace_headers(trace_opt) if isinstance(trace_opt, dict) else None
            )
            self._gen = gw._stream_chat(body, stream_headers)

    def __aiter__(self) -> "AsyncChatStream":
        return self

    async def __anext__(self) -> ChatChunk:
        return await self._gen.__anext__()


class AsyncToolLoopStream:
    """Async iterator over a streaming tool loop's events.

    Returned by ``run_tool_loop(..., stream=True)`` and
    ``run_prompt_with_tools(r, stream=True)``. Iterate it with ``async for``::

        async for event in await client.gateway.run_prompt_with_tools(r, stream=True):
            if event.type == "content":
                print(event.delta, end="", flush=True)
            elif event.type == "tool_call":
                print(f"\\n[calling {event.name}]")
            elif event.type == "tool_result":
                print(f"[{event.name} done]")
            elif event.type == "done":
                final = event.result

    Every event carries ``type``, so a ``match`` or an ``if/elif`` chain on it is the
    intended way to read the stream. A tool that raises ends the iteration by re-raising
    the exception, right after emitting its ``tool_result`` event with ``error`` set.
    """

    def __init__(self, gen: AsyncGenerator[ToolLoopEvent, None]) -> None:
        self._gen = gen

    def __aiter__(self) -> "AsyncToolLoopStream":
        return self

    async def __anext__(self) -> ToolLoopEvent:
        return await self._gen.__anext__()

    async def aclose(self) -> None:
        """Stop the loop early and release the underlying stream.

        Only needed when abandoning a stream part-way — iterating it to its ``done``
        event closes it on its own.
        """
        await self._gen.aclose()
