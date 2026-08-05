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
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, List, Optional, Sequence, Set, Tuple, Union
from urllib.parse import quote, urlparse

import httpx

from .errors import (
    API_ERROR,
    MISSING_API_KEY,
    MISSING_BASE_URL,
    MISSING_DISPATCH,
    NETWORK_ERROR,
    PROVIDER_ERROR,
    AcruxCoreError,
)
from .http import request_with_retry
from .provider import infer_provider_name
from .response_format import normalize_response_format
from .span_queue import SpanQueue
from .tooling import ToolSpec, spec_of
from .types import (
    ChatChunk,
    ChatResult,
    ChatUsage,
    GatewayCallMeta,
    IngestSpan,
    Message,
    ProviderConfig,
    ResolvedTool,
    ResponseFormat,
    RunToolLoopResult,
    ToolCall,
    ToolChoice,
    ToolDefinition,
    ToolRef,
    TraceInput,
)

if TYPE_CHECKING:
    from .host import GatewayNamespaceHost
    from .tools_api import ToolsNamespace

# A dispatch function may be sync or async.
DispatchFn = Callable[[str, Dict[str, Any]], Union[Any, "Awaitable[Any]"]]

# Re-export so callers can ``from acruxcore import AsyncChatStream``.
__all__ = ["GatewayNamespace", "AsyncChatStream"]


def _now_iso() -> str:
    """Current UTC time as an ISO-8601 string with an offset (API accepts it)."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


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


@dataclass
class _ToolRoute:
    """How one tool name gets executed during a loop."""

    kind: str
    fn: Optional[Callable[..., Any]] = None
    tool_id: Optional[str] = None
    alias: Optional[str] = None
    tool_version_id: Optional[str] = None


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
        # The httpx client is owned by the host — we don't close it here.
        # The host's __aexit__ handles that.

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
        prompt_version_id: Optional[str] = None,
        trace: Union[bool, Dict[str, Any], None] = None,
    ) -> Union[ChatResult, "AsyncChatStream"]:
        """Call the gateway's ``POST /gateway/chat/completions`` once — or, when a
        BYO provider is configured, call that provider's ``base_url`` directly.

        No tool-dispatch loop: if the model returns ``tool_calls`` they are handed
        back raw. Use :meth:`run_tool_loop` to dispatch them.
        """
        provider_config = provider or self._host._provider_default
        body = self._build_chat_body(
            model, messages, tools, tool_refs, tool_choice, response_format, temperature, max_tokens, stream
        )
        if stream:
            if provider_config is not None:
                return AsyncChatStream(
                    self, body,
                    provider_config=provider_config, model=model, messages=messages,
                    prompt_version_id=prompt_version_id, trace_opt=trace,
                )
            return AsyncChatStream(self, body)

        trace_opt = trace if trace is not None else bool(provider_config)
        trace_enabled = trace_opt is not False
        trace_conf: Dict[str, Any] = trace_opt if isinstance(trace_opt, dict) else {}

        trace_headers: Optional[Dict[str, str]] = None
        if trace_enabled and provider_config is None:
            trace_headers = {}
            tags = trace_conf.get("tags")
            if tags:
                trace_headers["x-trace-tags"] = ", ".join(tags)
            metadata = trace_conf.get("metadata")
            if metadata:
                trace_headers["x-trace-metadata"] = json.dumps(metadata)

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
            )

        if trace_enabled:
            span_id = (
                (result.gateway.span_ref or f"chat-{uuid.uuid4()}")
                if provider_config is not None
                else f"chat-{uuid.uuid4()}"
            )
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
        trace: Union[bool, Dict[str, Any], None] = None,
    ) -> "AsyncChatStream":
        """Stream a chat completion — the standalone streaming entry point.

        Equivalent to ``chat(..., stream=True)`` but as a dedicated method.
        """
        return await self.chat(
            model, messages,
            tools=tools, tool_refs=tool_refs, tool_choice=tool_choice,
            response_format=response_format, temperature=temperature, max_tokens=max_tokens,
            stream=True, provider=provider, prompt_version_id=prompt_version_id, trace=trace,
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
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"model": model, "messages": messages}
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
    ) -> ChatResult:
        body = self._build_chat_body(
            model, messages, tools, tool_refs, tool_choice, response_format, temperature, max_tokens, False
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
            raise AcruxCoreError(
                f"acruxcore: provider returned {response.status_code} calling chat completions",
                PROVIDER_ERROR,
                response.status_code,
                self._host._safe_json(response),
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

    async def _stream_chat(self, body: Dict[str, Any], extra_headers: Optional[Dict[str, str]] = None) -> Any:
        """Yield one :class:`ChatChunk` per SSE frame until ``data: [DONE]``."""
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

    async def _stream_via_provider(
        self,
        model: str,
        messages: List[Message],
        body: Dict[str, Any],
        provider_config: ProviderConfig,
        prompt_version_id: Optional[str],
        trace_opt: Union[bool, Dict[str, Any]],
    ) -> Any:
        """Stream a BYO provider's ``/chat/completions`` directly."""
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
                        raise AcruxCoreError(
                            f"acruxcore: provider returned {response.status_code} streaming chat completions",
                            PROVIDER_ERROR,
                            response.status_code,
                            self._host._safe_json(response),
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

        if trace_opt is not False:
            trace_conf: Dict[str, Any] = trace_opt if isinstance(trace_opt, dict) else {}
            assembled_tool_calls: List[ToolCall] = [
                {"id": p["id"], "type": "function", "function": {"name": p["name"], "arguments": p["arguments"]}}
                for _, p in sorted(tool_call_parts.items())
            ]
            output: Dict[str, Any] = {"role": "assistant", "content": accumulated_content}
            if assembled_tool_calls:
                output["tool_calls"] = assembled_tool_calls
            span: IngestSpan = {
                "spanId": str(uuid.uuid4()),
                "name": final_model,
                "kind": "llm",
                "status": "ok",
                "startTime": start_time,
                "endTime": _now_iso(),
                "model": final_model,
                "provider": infer_provider_name(provider_config["base_url"]),
                "input": {"messages": messages},
                "output": output,
            }
            if usage is not None:
                span["usage"] = usage
            if final_finish_reason:
                span["attributes"] = {"finishReason": final_finish_reason}
            if prompt_version_id:
                span["promptVersionId"] = prompt_version_id
            trace_payload: TraceInput = {"name": "chat", "spans": [span]}
            if trace_conf.get("trace_id"):
                trace_payload["traceId"] = trace_conf["trace_id"]
            if trace_conf.get("session_id"):
                trace_payload["sessionId"] = trace_conf["session_id"]
            self._host._span_queue.enqueue(trace_payload)

    # ── run_tool_loop ──────────────────────────────────────────────────────

    async def _prepare_tool_routes(
        self,
        tools: Optional[Sequence[Callable[..., Any]]],
        tool_refs: Optional[List[ToolRef]],
        dispatch: Optional[DispatchFn],
        sync: bool,
    ) -> Tuple[Dict[str, _ToolRoute], List[ToolRef], List[ToolDefinition]]:
        routes: Dict[str, _ToolRoute] = {}
        refs: List[ToolRef] = []
        inlined_schemas: List[Dict[str, Any]] = []

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
                if item.executor_type == "http":
                    routes[name] = _ToolRoute(
                        kind="http",
                        tool_id=item.tool_id,
                        alias=ref.get("alias"),
                        tool_version_id=version_id,
                    )
                elif dispatch is not None:
                    routes[name] = _ToolRoute(
                        kind="dispatch", alias=ref.get("alias"), tool_version_id=version_id
                    )
                else:
                    raise AcruxCoreError(
                        f"acruxcore: tool '{name}' has a client executor, so something has to run "
                        "it, but no implementation was supplied. Pass the decorated function in "
                        "tools=[...], or pass dispatch=.",
                        MISSING_DISPATCH,
                    )
                refs.append(
                    {"name": name, **({"alias": ref["alias"]} if ref.get("alias") else {})}
                )
                inlined_schemas.append({"type": "function", "function": item.function})

        return routes, refs, inlined_schemas

    async def run_tool_loop(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[Sequence[Callable[..., Any]]] = None,
        tool_defs: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        dispatch: Optional[DispatchFn] = None,
        sync: bool = True,
        max_iterations: int = 10,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        response_format: Optional[ResponseFormat] = None,
        trace: Union[bool, Dict[str, Any]] = True,
        provider: Optional[ProviderConfig] = None,
        prompt_version_id: Optional[str] = None,
    ) -> RunToolLoopResult:
        """Run the full tool-calling loop, then — when ``response_format`` is also
        given — shape the gathered facts into one typed answer.
        """
        has_tools = bool(tools or tool_defs or tool_refs)
        shaping = response_format is not None and has_tools

        gathered = await self._run_tool_loop_gather(
            model, messages, tools=tools, tool_defs=tool_defs, tool_refs=tool_refs,
            dispatch=dispatch, sync=sync, max_iterations=max_iterations,
            temperature=temperature, max_tokens=max_tokens,
            response_format=None if shaping else response_format,
            trace=trace, provider=provider, prompt_version_id=prompt_version_id,
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
            prompt_version_id=prompt_version_id,
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

    async def _run_tool_loop_gather(
        self,
        model: str,
        messages: List[Message],
        *,
        tools: Optional[Sequence[Callable[..., Any]]] = None,
        tool_defs: Optional[List[ToolDefinition]] = None,
        tool_refs: Optional[List[ToolRef]] = None,
        dispatch: Optional[DispatchFn] = None,
        sync: bool = True,
        max_iterations: int = 10,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        response_format: Optional[ResponseFormat] = None,
        trace: Union[bool, Dict[str, Any]] = True,
        provider: Optional[ProviderConfig] = None,
        prompt_version_id: Optional[str] = None,
    ) -> RunToolLoopResult:
        routes, effective_refs, inlined_schemas = await self._prepare_tool_routes(
            tools, tool_refs, dispatch, sync
        )

        provider_config = provider or self._host._provider_default
        byo_tool_schemas: Optional[List[ToolDefinition]] = (
            [*(tool_defs or []), *inlined_schemas]
            if provider_config is not None and (tool_defs or inlined_schemas)
            else None
        )

        trace_enabled = trace is not False
        trace_conf: Dict[str, Any] = trace if isinstance(trace, dict) else {}
        trace_name = trace_conf.get("name") or "runToolLoop"
        session_id = trace_conf.get("session_id")

        convo: List[Message] = list(messages)
        tool_spans: List[IngestSpan] = []
        trace_id: Optional[str] = trace_conf.get("trace_id")

        for i in range(max_iterations):
            extra_headers: Optional[Dict[str, str]] = None
            if trace_enabled and provider_config is None:
                extra_headers = {"x-trace-name": quote(trace_name, safe="")}
                if trace_id:
                    extra_headers["x-trace-id"] = trace_id
                if session_id:
                    extra_headers["x-session-id"] = session_id
                tags = trace_conf.get("tags")
                if tags:
                    extra_headers["x-trace-tags"] = ", ".join(tags)
                metadata = trace_conf.get("metadata")
                if metadata:
                    extra_headers["x-trace-metadata"] = json.dumps(metadata)

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
                llm_trace_payload: TraceInput = {"name": trace_name, "spans": [llm_span]}
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
                self._report_tool_spans(
                    trace_enabled, trace_id, trace_name, session_id, tool_spans
                )
                return RunToolLoopResult(
                    content=result.content or "",
                    messages=[*convo, result.message],
                    iterations=i + 1,
                    stopped_at_limit=False,
                    trace_id=trace_id,
                )

            async def _run_call(call: Dict[str, Any], call_index: int) -> Message:
                name = call["function"]["name"]
                args: Dict[str, Any] = {}
                try:
                    parsed = json.loads(call["function"].get("arguments") or "{}")
                    if isinstance(parsed, dict):
                        args = parsed
                except (ValueError, TypeError):
                    pass

                route = routes.get(name)

                if route is not None and route.kind == "http":
                    executed = await self._host.tools.execute(
                        route.tool_id or "",
                        args,
                        alias=route.alias,
                        trace_id=trace_id if trace_enabled else None,
                        parent_span_id=llm_span_ref,
                    )
                    ret = executed.result
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
                        f"acruxcore: the model called '{name}', which has no implementation. Pass "
                        "the decorated function in tools=[...], or pass dispatch=.",
                        MISSING_DISPATCH,
                    )

                tool_span_id = f"tool-{i}-{call_index}"
                tool_start = _now_iso()
                attributes: Dict[str, Any] = {"arguments": args, "executorType": "client"}
                if route is not None and route.tool_version_id:
                    attributes["toolVersionId"] = route.tool_version_id
                try:
                    ret = runner()
                    if inspect.isawaitable(ret):
                        ret = await ret
                except Exception as err:
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
                    raise

                tool_spans.append(
                    {
                        "spanId": tool_span_id,
                        "parentSpanId": llm_span_ref,
                        "name": name,
                        "kind": "tool",
                        "status": "ok",
                        "startTime": tool_start,
                        "endTime": _now_iso(),
                        "input": args,
                        "output": ret,
                        "attributes": attributes,
                    }
                )
                content = ret if isinstance(ret, str) else json.dumps(ret)
                return {"role": "tool", "tool_call_id": call["id"], "content": content}

            settled = await asyncio.gather(
                *[_run_call(call, idx) for idx, call in enumerate(calls)],
                return_exceptions=True,
            )

            failure = next((s for s in settled if isinstance(s, BaseException)), None)
            if failure is not None:
                self._report_tool_spans(
                    trace_enabled, trace_id, trace_name, session_id, tool_spans
                )
                raise failure

            tool_msgs: List[Message] = [s for s in settled]  # type: ignore[misc]
            convo = [*convo, result.message, *tool_msgs]

        self._report_tool_spans(
            trace_enabled, trace_id, trace_name, session_id, tool_spans
        )
        return RunToolLoopResult(
            content="", messages=convo, iterations=max_iterations,
            stopped_at_limit=True, trace_id=trace_id,
        )

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
        trace_opt: Union[bool, Dict[str, Any], None] = None,
    ) -> None:
        if provider_config is not None:
            self._gen = gw._stream_via_provider(
                model or body.get("model"), messages or body.get("messages") or [], body,
                provider_config, prompt_version_id, trace_opt if trace_opt is not None else True,
            )
        else:
            stream_headers: Optional[Dict[str, str]] = None
            if isinstance(trace_opt, dict):
                stream_headers = {}
                tags = trace_opt.get("tags")
                if tags:
                    stream_headers["x-trace-tags"] = ", ".join(tags)
                metadata = trace_opt.get("metadata")
                if metadata:
                    stream_headers["x-trace-metadata"] = json.dumps(metadata)
            self._gen = gw._stream_chat(body, stream_headers)

    def __aiter__(self) -> "AsyncChatStream":
        return self

    async def __anext__(self) -> ChatChunk:
        return await self._gen.__anext__()
