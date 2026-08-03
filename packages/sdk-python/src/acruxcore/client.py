"""The async Acrux Core client — full parity with the TypeScript SDK."""

from __future__ import annotations

import asyncio
import atexit
import codecs
import hashlib
import inspect
import json
import os
import time
import uuid
import warnings
import weakref
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Set, Tuple, Union
from urllib.parse import quote, urlencode, urlparse

import httpx

from .cache import CacheEntry, get_cache
from .errors import (
    API_ERROR,
    MISSING_API_KEY,
    MISSING_BASE_URL,
    MISSING_DISPATCH,
    MISSING_VARIABLES,
    NETWORK_ERROR,
    PROVIDER_ERROR,
    AcruxCoreError,
)
from .http import request_with_retry
from .provider import infer_provider_name
from .response_format import normalize_response_format
from .span_queue import SpanQueue
from .tooling import ToolSpec, spec_of
from .tools_api import ToolsNamespace
from .types import (
    ChatChunk,
    ChatResult,
    ChatUsage,
    FeedbackResult,
    GatewayCallMeta,
    GetTraceResult,
    IngestSpan,
    ListTracesResult,
    Message,
    ProviderConfig,
    RenderResult,
    ResolvedTool,
    ResponseFormat,
    RunToolLoopResult,
    ToolCall,
    ToolChoice,
    ToolDefinition,
    ToolRef,
    TraceInput,
    TraceResult,
)

DEFAULT_CACHE_TTL = 60_000
DEFAULT_MAX_CACHE_SIZE = 500
DEFAULT_MAX_RETRIES = 1
DEFAULT_RETRY_INTERVAL = 500

# A dispatch function may be sync or async.
DispatchFn = Callable[[str, Dict[str, Any]], Union[Any, Awaitable[Any]]]


@dataclass
class _ToolRoute:
    """How one tool name gets executed during a loop.

    Resolved once before the first model call, so a missing ``dispatch`` is a startup
    error rather than something discovered mid-conversation after tokens were spent.

    :param kind: ``'local'`` (a decorated function), ``'http'`` (the platform runs it)
        or ``'dispatch'`` (the caller's fallback handler).
    :param fn: The decorated function, for ``'local'``.
    :param tool_id: The catalog id, for ``'http'`` — what ``execute`` posts to.
    :param alias: The alias this route resolved through.
    :param tool_version_id: ``"<toolId>:<versionNumber>"``, recorded on the tool span
        so a trace can say which version ran.
    """

    kind: str
    fn: Optional[Callable[..., Any]] = None
    tool_id: Optional[str] = None
    alias: Optional[str] = None
    tool_version_id: Optional[str] = None


def _now_iso() -> str:
    """Current UTC time as an ISO-8601 string with an offset (API accepts it)."""
    return datetime.now(timezone.utc).isoformat()


def _hash_api_key(api_key: str) -> str:
    """Short, non-reversible fingerprint of an API key for use in cache keys."""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def _hash_variables(variables: Dict[str, Any]) -> str:
    """Fingerprint the variables a render used, so they take part in the cache key.

    Without this, a second render of the same prompt with different variables is
    served the first render's output. ``sort_keys`` makes the digest independent of
    key order at every depth; ``default=str`` keeps a non-JSON-serialisable value
    (a ``datetime``, say) from raising instead of rendering.

    :param variables: The template variables passed to the render endpoint.
    :returns: A 16-hex-character digest, stable across key insertion order.
    """
    canonical = json.dumps(variables, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _is_loopback_host(hostname: Optional[str]) -> bool:
    """True for local-dev hosts where a plaintext base_url is not a security issue."""
    return hostname in ("localhost", "127.0.0.1", "::1")


#: URLs already warned about, so the check can run per call (the BYO provider path runs
#: once per completion — and once per round inside ``run_tool_loop``) while still warning
#: at most once per distinct URL instead of flooding stderr.
_warned_cleartext_urls: Set[str] = set()


def _warn_if_cleartext_url(url: str, what: str) -> None:
    """Warn, once per URL, when an ``Authorization``-bearing request is about to travel
    over cleartext HTTP to a non-loopback host.

    Originally only the platform ``base_url`` was checked; the BYO path sends the
    caller's *provider* key as a Bearer token to a caller-supplied URL, so it needs the
    same guard. A warning rather than a hard error, so legitimate local-dev endpoints
    (``http://localhost:11434`` and friends) keep working unprompted.

    :param url: The base URL about to receive a Bearer token.
    :param what: How to name it in the message (e.g. ``base_url``, ``provider.base_url``).
    """
    parsed = urlparse(url)
    # An unparseable / scheme-less URL is the caller's problem to discover from the
    # request itself failing — not something to warn (or raise) about here.
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


#: Live clients that may still have spans to send, held weakly so an abandoned client can
#: still be collected. One shared ``atexit`` hook serves all of them, rather than a
#: per-instance registration that would keep every client alive for the life of the process.
_clients_awaiting_exit_flush: "weakref.WeakSet[AcruxCore]" = weakref.WeakSet()
_exit_hook_registered = False


def _flush_all_at_exit() -> None:
    """Drain every live client's span queue as the interpreter exits.

    ``atexit`` is the only hook available for the case that actually motivates this: a
    script that answers one question and returns, whose event loop ``asyncio.run`` closes
    with spans still buffered. Deliberately NOT a ``SIGINT``/``SIGTERM`` handler — those
    belong to the application, not to a library.
    """
    for client in list(_clients_awaiting_exit_flush):
        client._drain_at_exit()


def _register_exit_flush(client: "AcruxCore") -> None:
    """Enrol a client in the shared exit drain, installing the hook on first use."""
    global _exit_hook_registered
    _clients_awaiting_exit_flush.add(client)
    if not _exit_hook_registered:
        atexit.register(_flush_all_at_exit)
        _exit_hook_registered = True


class AcruxCore:
    """Async client for Acrux Core — prompt render, gateway chat, tool loops,
    traces, and feedback.

    Create one instance at process startup and reuse it — the render cache is a
    process-wide singleton and ``max_cache_size`` is set by the first instance.
    Close it with :meth:`aclose` or use it as an async context manager.

    Config resolution per field: constructor arg → environment variable → default.

    :param api_key: API key. Fallback: ``ACRUXCORE_API_KEY``.
    :param base_url: API base URL, e.g. ``http://localhost:3001/api/v1``.
        Fallback: ``ACRUXCORE_BASE_URL``.
    :param cache_ttl: Milliseconds before a cached render is stale. Default 60000.
        Renders are cached per ``(api_key, prompt, alias, variables)``. Pass ``0`` to
        disable caching entirely — every ``render_prompt`` call then hits the API.
    :param max_cache_size: Max LRU entries. Default 500 (first instance wins).
    :param max_retries: Retries on transient failure. Default 1 (2 attempts).
    :param retry_interval: Milliseconds between retries. Default 500.
    :param timeout: Per-request timeout in seconds. Default 30.
    :param transport: An httpx transport (for testing/injection). Optional.
    :param provider: Client-level BYO default — when set (and no per-call
        ``provider=`` overrides it), ``chat()``/``run_tool_loop()`` call this
        provider directly instead of our gateway. ``api_key`` is sent only to
        ``base_url``, never to us.
    :raises AcruxCoreError: ``MISSING_API_KEY`` / ``MISSING_BASE_URL`` if required
        config is absent.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        *,
        cache_ttl: int = DEFAULT_CACHE_TTL,
        max_cache_size: int = DEFAULT_MAX_CACHE_SIZE,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_interval: int = DEFAULT_RETRY_INTERVAL,
        timeout: float = 30.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        provider: Optional[ProviderConfig] = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("ACRUXCORE_API_KEY")
        if not resolved_key:
            raise AcruxCoreError(
                "acruxcore: api_key is required. Pass it in the constructor or set "
                "ACRUXCORE_API_KEY.",
                MISSING_API_KEY,
            )

        resolved_base = base_url or os.environ.get("ACRUXCORE_BASE_URL")
        if not resolved_base:
            raise AcruxCoreError(
                "acruxcore: base_url is required. Pass it in the constructor or set "
                "ACRUXCORE_BASE_URL.",
                MISSING_BASE_URL,
            )

        self._api_key = resolved_key
        self._base_url = resolved_base.rstrip("/")
        self._cache_ttl = cache_ttl
        self._max_retries = max_retries
        self._retry_interval = retry_interval
        #: Client-level BYO default. A per-call `provider=` on chat()/run_tool_loop()
        #: overrides this.
        self._provider_default: Optional[ProviderConfig] = provider
        self._timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport)
        # Keep references to background refresh tasks so they aren't GC'd mid-flight.
        self._bg_tasks: Set["asyncio.Task[Any]"] = set()
        #: Buffer the internal auto-reports drain through, so a model call never waits on
        #: telemetry. The public ``trace()`` does not use it — callers await that one for
        #: its returned ``trace_id``.
        self._span_queue = SpanQueue(self._send_trace_batch)
        _register_exit_flush(self)

        _warn_if_cleartext_url(self._base_url, "base_url")
        # A client-level BYO provider default gets the same check up front; a per-call
        # `provider=` is checked when that call is actually made.
        if self._provider_default and self._provider_default.get("base_url"):
            _warn_if_cleartext_url(self._provider_default["base_url"], "provider.base_url")

        get_cache(max_cache_size)

        #: Catalog operations — see :class:`~acruxcore.tools_api.ToolsNamespace`.
        self.tools = ToolsNamespace(self)

    def _auth_headers(
        self, extra_headers: Optional[Dict[str, str]] = None
    ) -> Dict[str, str]:
        """Shared header shape for every authenticated request this client makes."""
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)
        return headers

    def _api_key_fingerprint(self) -> str:
        """Short, non-reversible fingerprint of this client's key, for cache keys."""
        return _hash_api_key(self._api_key)

    # --- lifecycle ---------------------------------------------------------

    async def flush(self) -> None:
        """Wait until every trace this client reported in the background has been sent.

        ``chat()``, streaming ``chat()`` and ``run_tool_loop()`` hand back their result
        without waiting for the trace write, so call this before reading the traces API
        back — in a test, or in code that polls for the span it just produced. A script
        that simply returns from ``main()`` does not need it: the SDK drains at exit.

        Never raises for a telemetry failure — those are warned about, not propagated.
        """
        await self._span_queue.flush()

    async def aclose(self) -> None:
        """Flush pending traces and close the underlying HTTP client. Call once when done.

        A long-running server should call this in the shutdown path it already has; the SDK
        deliberately installs no signal handlers of its own.
        """
        await self._span_queue.close()
        _clients_awaiting_exit_flush.discard(self)
        await self._client.aclose()

    def _drain_at_exit(self) -> None:
        """Send whatever is still buffered as the interpreter exits.

        Runs after the caller's event loop may already be closed, so it cannot simply
        await. With a loop still running, the process is mid-shutdown and owns its own
        teardown — ``aclose()``/``__aexit__`` is the correct hook there, so this leaves the
        queue alone. With no loop, it drains the remainder on a fresh one.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            return

        pending = self._span_queue.take_pending()
        if not pending:
            return
        try:
            asyncio.run(self._drain_on_a_fresh_loop(pending))
        except Exception:  # noqa: BLE001 — an atexit hook must never raise
            pass

    async def _drain_on_a_fresh_loop(self, pending: List[Dict[str, Any]]) -> None:
        """Re-send buffered entries with a brand-new HTTP client on a brand-new loop.

        ``self._client``'s connection pool belongs to the event loop that has just closed,
        so reusing it here fails outright — a fresh client is the only thing that can still
        reach the API. Batching, merging and the span cap are reused by running the
        entries back through a throwaway queue.

        :param pending: Entries taken out of the live queue, oldest first.
        """
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            queue = SpanQueue(lambda batch: self._post_traces(client, batch))
            for item in pending:
                queue.enqueue(item)
            await queue.flush()

    async def __aenter__(self) -> "AcruxCore":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    # --- render_prompt (SWR cache) ----------------------------------------

    async def render_prompt(
        self,
        name: str,
        alias: str,
        variables: Optional[Dict[str, Any]] = None,
    ) -> RenderResult:
        """Render a stored prompt by name + alias.

        Cached per ``(api_key, name, alias, variables)``. Fresh hit returns
        immediately; stale hit returns the cached value and fires a background
        refresh; cold miss fetches. If the API is unreachable but a stale entry
        exists, the stale value is served with a warning. A ``cache_ttl`` of ``0``
        (or less) turns caching off entirely — every call goes to the API and
        nothing is stored, which also gives up that serve-stale behaviour.

        :param name: Prompt name (slug, not id).
        :param alias: Alias to resolve (e.g. ``production``).
        :param variables: Template variables.
        :returns: ``RenderResult(messages, tools, model)``; ``tools`` is ``[]`` if
            none, and ``model`` is the version's bound default model (or ``None``)
            so you can run the prompt on its bound model without hardcoding one.
        :raises AcruxCoreError: ``MISSING_VARIABLES`` if required variables are
            absent; ``API_ERROR`` for other HTTP errors; ``NETWORK_ERROR`` if the
            API is unreachable and no stale entry exists.
        """
        variables = variables or {}

        # A non-positive TTL means "never serve a cached render" — skip the read and
        # pass no key so _fetch_and_cache skips the write too, instead of filling the
        # LRU with entries no read path will ever consult.
        if self._cache_ttl <= 0:
            return await self._fetch_and_cache(name, alias, variables, None)

        cache = get_cache(DEFAULT_MAX_CACHE_SIZE)
        cache_key = (
            f"{_hash_api_key(self._api_key)}:{name}:{alias}:{_hash_variables(variables)}"
        )
        now = time.time() * 1000

        cached = cache.get(cache_key)
        if cached is not None:
            age = now - cached.fetched_at
            if age < self._cache_ttl:
                return cached.value
            # Stale — serve immediately, refresh in the background.
            self._spawn_background_refresh(name, alias, variables, cache_key)
            return cached.value

        return await self._fetch_and_cache(name, alias, variables, cache_key)

    def _spawn_background_refresh(
        self, name: str, alias: str, variables: Dict[str, Any], cache_key: str
    ) -> None:
        try:
            task = asyncio.ensure_future(
                self._fetch_and_cache(name, alias, variables, cache_key)
            )
        except RuntimeError:
            # No running loop — nothing to schedule against; keep serving stale.
            return

        self._bg_tasks.add(task)

        def _done(t: "asyncio.Task[Any]") -> None:
            self._bg_tasks.discard(t)
            exc = t.exception() if not t.cancelled() else None
            if exc is not None:
                print(
                    f'[acruxcore] Background refresh failed for "{name}/{alias}" '
                    f"— continuing to serve stale: {exc}"
                )

        task.add_done_callback(_done)

    async def _fetch_and_cache(
        self, name: str, alias: str, variables: Dict[str, Any], cache_key: Optional[str]
    ) -> RenderResult:
        path = f"/prompts/{quote(name, safe='')}/{quote(alias, safe='')}/render"
        try:
            response = await self._raw_request("POST", path, {"variables": variables})
        except httpx.TransportError as err:
            raise AcruxCoreError(
                f'acruxcore: network error fetching "{name}/{alias}" — {err}',
                NETWORK_ERROR,
            )

        if response.status_code >= 400:
            body = self._safe_json(response)
            if response.status_code == 400 and isinstance(body, dict):
                error_field = body.get("error")
                missing = (
                    error_field.get("missing")
                    if isinstance(error_field, dict)
                    else None
                )
                if isinstance(missing, list):
                    raise AcruxCoreError(
                        "acruxcore: missing required template variables: "
                        + ", ".join(str(m) for m in missing),
                        MISSING_VARIABLES,
                        400,
                        body,
                    )
            raise AcruxCoreError(
                f'acruxcore API error {response.status_code} for "{name}/{alias}"',
                API_ERROR,
                response.status_code,
                body,
            )

        data = response.json()
        value = RenderResult(
            messages=data.get("messages", []),
            tools=data.get("tools") or [],
            model=data.get("model"),
            version_id=data.get("versionId"),
            version_number=data.get("versionNumber"),
        )
        if cache_key is not None:
            get_cache(DEFAULT_MAX_CACHE_SIZE).set(
                cache_key, CacheEntry(value=value, fetched_at=time.time() * 1000)
            )
        return value

    # --- trace (write) -----------------------------------------------------

    async def trace(self, input: TraceInput) -> TraceResult:
        """Report a trace (a group of spans) to Acrux Core.

        A single-trace convenience over the batch endpoint. Omit ``traceId`` to
        mint a new trace; pass one to append spans to it. Never cached.

        :param input: The trace and its spans.
        :returns: ``TraceResult(trace_id)``.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if unreachable; ``API_ERROR``
            for a non-2xx response.
        """
        try:
            response = await self._raw_request("POST", "/traces", {"traces": [input]})
        except httpx.TransportError as err:
            raise AcruxCoreError(
                f"acruxcore: network error reporting trace — {err}", NETWORK_ERROR
            )

        if response.status_code >= 400:
            raise AcruxCoreError(
                f"acruxcore API error {response.status_code} reporting trace",
                API_ERROR,
                response.status_code,
                self._safe_json(response),
            )

        data = response.json()
        return TraceResult(trace_id=data["traceIds"][0])

    async def _post_traces(
        self, client: httpx.AsyncClient, batch: List[Dict[str, Any]]
    ) -> None:
        """Send one batch of trace reports as a single ``POST /traces``.

        Takes the HTTP client explicitly because the interpreter-exit drain has to use a
        fresh one — the live client's pool belongs to a loop that has already closed.

        :param client: HTTP client to send with.
        :param batch: Trace entries to send in one request.
        :raises AcruxCoreError: ``API_ERROR`` on a non-2xx response.
        :raises httpx.TransportError: If the API cannot be reached after retries.
        """
        response = await request_with_retry(
            client,
            "POST",
            f"{self._base_url}/traces",
            headers=self._auth_headers(),
            content=json.dumps({"traces": batch}).encode("utf-8"),
            max_retries=self._max_retries,
            retry_interval_ms=self._retry_interval,
        )
        if response.status_code >= 400:
            raise AcruxCoreError(
                f"acruxcore API error {response.status_code} reporting traces",
                API_ERROR,
                response.status_code,
                self._safe_json(response),
            )

    async def _send_trace_batch(self, batch: List[Dict[str, Any]]) -> None:
        """Sender the span queue drives. Failures propagate so the queue can warn and drop.

        :param batch: Trace entries to send in one request.
        :raises AcruxCoreError: ``API_ERROR`` on a non-2xx response.
        :raises httpx.TransportError: If the API cannot be reached after retries.
        """
        await self._post_traces(self._client, batch)

    # --- chat --------------------------------------------------------------

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

        By default this calls our gateway. If ``provider=`` is set (or, absent
        that, the client's own ``provider`` default from the constructor), this
        instead calls that BYO provider's ``base_url`` directly, skipping the
        gateway entirely — see :class:`ProviderConfig`.

        No tool-dispatch loop: if the model returns ``tool_calls`` they are handed
        back raw on ``result.message["tool_calls"]``; use :meth:`run_tool_loop` to
        dispatch them. On the BYO path there is no gateway trace to adopt, so a
        fresh trace id and span ref are minted locally and ``cost_usd``/``cache``
        are always ``None`` (the gateway never saw the call).

        Auto-traces with one ``llm`` span when a BYO ``provider`` is configured
        (``trace`` defaults to ``True`` in that case) — the gateway path stays
        untraced by default (the gateway records its own span there), but an
        explicit ``trace=True`` or ``trace={"trace_id": ...}`` on either path
        makes this method report an additional client-side trace. Pass
        ``trace=False`` to opt a BYO call out. Pass ``trace={"trace_id": ...,
        "session_id": ...}`` to append this call's span to an existing trace
        (e.g. one returned by an earlier ``chat()`` call) instead of minting a
        new one. Trace reporting is best-effort: a failure is logged and does
        not raise or affect the returned result.

        Opting in on the **gateway** path always produces a SECOND span in
        addition to the gateway's own recorded completion (and a second trace,
        unless you point ``trace={"trace_id": ...}`` at the gateway's own trace
        id): the span reported here mints a fresh span id rather than reusing
        the gateway's, because the gateway has already persisted a span under
        its own id and ``spans`` is unique on ``(trace id, span ref)``. So a
        gateway-path opt-in is for adding your own view of the call — it never
        replaces or de-duplicates the gateway's span.

        Streaming (``stream=True``) with a ``provider`` set streams the BYO
        endpoint's SSE response directly — never through our gateway —
        requesting ``stream_options: {"include_usage": True}`` so the final
        frame carries token usage. Content and ``tool_calls`` are accumulated
        across chunks and, once the stream ends, the same auto-trace default as
        above reports one ``llm`` span with the assembled output and usage
        (deferred until then, since streaming has no single response to trace
        at return time). Streaming without a ``provider`` set is unchanged: it
        streams our gateway and reports no client-side trace.

        :param model: Model id.
        :param messages: Chat messages.
        :param tools: Inline OpenAI-shaped tool definitions.
        :param tool_refs: Catalog tool references (``{"name", "alias"}``).
        :param tool_choice: How the model should use tools.
        :param response_format: Structured-output format (OpenAI-shaped
            ``response_format``). Mutually exclusive with ``tools``/``tool_choice``/
            ``tool_refs`` on the same gateway request — the gateway rejects a request
            carrying both with a 400 ``VALIDATION_ERROR``, whether the tools are
            inline, resolved from ``tool_refs``, or auto-attached from a stored
            prompt version.
        :param temperature: Sampling temperature.
        :param max_tokens: Max completion tokens.
        :param stream: When ``True``, returns an async iterator of
            :class:`ChatChunk` instead of a :class:`ChatResult`.
        :param provider: Per-call BYO override; wins over the client's ``provider``
            default. When set (here or as the client default), the call goes
            directly to ``provider["base_url"]`` instead of our gateway.
        :param prompt_version_id: Recorded on the auto-traced span as
            ``promptVersionId`` when tracing is enabled. Has no effect otherwise.
        :param trace: ``True``/``False`` or ``{"trace_id", "session_id"}``.
            Defaults to ``True`` when a BYO ``provider`` is configured (here or as
            the client default) and ``False`` on the gateway path. Pass a dict to
            thread this call's span onto an existing trace and/or session.
        :returns: A :class:`ChatResult`, or an async iterator of chunks when
            ``stream=True``.
        :raises AcruxCoreError: ``MISSING_API_KEY`` or ``MISSING_BASE_URL`` if a
            BYO provider is configured (``provider`` here or the client default) but
            lacks the required ``api_key`` or ``base_url``; ``NETWORK_ERROR`` /
            ``API_ERROR`` (e.g. 403 ``MODEL_NOT_ALLOWED``, 402 ``BUDGET_EXCEEDED``)
            on the gateway path; ``PROVIDER_ERROR`` for a non-2xx response from a
            BYO provider endpoint (``provider`` here or the client-level default)
            on the BYO path.
        """
        provider_config = provider or self._provider_default
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

        # Thread trace tags/metadata to the gateway so the trace is tagged server-side.
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
            # On the gateway path, result.gateway.span_ref is the span the GATEWAY already
            # persisted server-side for this completion — reusing it here would collide
            # with that row under `spans`' unique (traceId, spanRef) constraint (the
            # ingest endpoint has no upsert, so the insert 500s and this best-effort
            # report silently records nothing). Only the BYO path's freshly-minted
            # span_ref (from _complete_via_provider, nothing persisted under it yet) is
            # safe to reuse as-is — and reusing it there keeps the id in the returned
            # `result.gateway` metadata consistent with what actually got posted.
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
            # Enqueued, not awaited: the caller has their answer already and nothing in
            # their application depends on the write. Delivery is best-effort: the queue
            # keeps order and warns once per failure kind, the transport retries transient
            # failures, but a batch that still fails is dropped, and the oldest spans go
            # once the buffer is over its memory cap. ``flush()`` is how a caller waits for
            # what is buffered (see SpanQueue).
            self._span_queue.enqueue(payload)

        return result

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
            # Resolve a pydantic-built marker (from acruxcore.pydantic_response_format)
            # to the OpenAI-shaped wire dict here — the single chokepoint every chat /
            # run_tool_loop / streaming / BYO round-trip funnels through.
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
        response = await self._request(
            "POST", "/gateway/chat/completions", body, "calling chat completions", extra_headers
        )
        gateway = self._read_gateway_meta(response)
        data = self._parse_json_or_throw(response, "calling chat completions")
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
        """One non-streaming completion sent DIRECTLY to a BYO provider's base_url —
        never through our gateway. ``provider_config["api_key"]`` is sent only to
        ``provider_config["base_url"]``, never to us. Mints its own trace id + llm
        span ref (no ``x-gateway-*`` headers exist on this path) so the returned
        ``gateway`` field has the same shape callers already read from the gateway
        path.
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
                self._client, "POST", url, headers=headers, content=content,
                max_retries=self._max_retries, retry_interval_ms=self._retry_interval,
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
                self._safe_json(response),
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
        url = f"{self._base_url}/gateway/chat/completions"
        headers = self._auth_headers(extra_headers)
        content = json.dumps(body).encode("utf-8")

        total_attempts = 1 + self._max_retries
        for attempt in range(total_attempts):
            if attempt > 0:
                await asyncio.sleep(self._retry_interval / 1000)
            try:
                async with self._client.stream(
                    "POST", url, headers=headers, content=content
                ) as response:
                    # 429 retries like a 5xx, matching `request_with_retry` (which every
                    # non-streaming caller goes through) and `_stream_via_provider`.
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
                            self._safe_json(response),
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
        """Stream a BYO provider's ``/chat/completions`` directly — never through our
        gateway. Requests ``stream_options.include_usage`` so the final SSE frame
        carries token usage. Content is accumulated across chunks, and
        ``delta.tool_calls`` fragments are accumulated too (keyed by the wire
        ``index`` that correlates them across frames) — a streamed turn never
        yields a whole message, so without this the trace payload for a
        tool-calling turn would record an empty output. Each yielded
        :class:`ChatChunk` still forwards its frame's raw, unmerged ``delta``,
        exactly as received. When tracing is enabled, reports one ``llm`` span at
        stream end with the assembled content and (if any) assembled tool calls.

        Retries apply only until the first chunk reaches the caller — a completion
        cannot be resumed from an offset, so replaying one that has already delivered
        output would duplicate it. After that point a broken stream raises
        ``NETWORK_ERROR`` instead.
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
        # A streamed turn has no single response object, so this is the only record of
        # WHY the stream ended (`stop` vs `length` vs `tool_calls`) — it goes on the
        # span's `attributes` rather than its `output`, which stays message-shaped.
        final_finish_reason: Optional[str] = None
        usage: Optional[Dict[str, Any]] = None
        # Tool-call fragments, keyed by the wire `index` that correlates them across
        # frames. A streamed turn never yields a whole message, so without this the
        # trace payload for a tool-calling turn would record an empty output.
        tool_call_parts: Dict[int, Dict[str, str]] = {}

        total_attempts = 1 + self._max_retries
        # A retry is only safe until the first chunk reaches the caller. Once a
        # ChatChunk has been yielded, replaying the request would hand the caller a
        # second completion on top of the partial first one, and the span below would
        # record both concatenated. Node gets this for free — `fetchWithRetry` only
        # ever retries connection setup, never stream consumption — so this flag is
        # what keeps the two SDKs behaving the same way.
        yielded_any = False
        for attempt in range(total_attempts):
            if attempt > 0:
                await asyncio.sleep(self._retry_interval / 1000)
            # Reset per attempt so a retried request never accumulates on top of the
            # previous attempt's state.
            accumulated_content = ""
            final_model = model
            final_finish_reason = None
            usage = None
            tool_call_parts = {}
            try:
                async with self._client.stream("POST", url, headers=headers, content=content) as response:
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
                            self._safe_json(response),
                        )

                    decoder = codecs.getincrementaldecoder("utf-8")()
                    buffer = ""
                    # `[DONE]` ends the response, but it only breaks the frame loop —
                    # this carries that out to the read loop so we stop reading instead
                    # of blocking for a close that a keep-alive proxy may never send.
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
            # Enqueued, not awaited — see the note at chat()'s own auto-report.
            self._span_queue.enqueue(trace_payload)

    # --- run_tool_loop -----------------------------------------------------

    async def _prepare_tool_routes(
        self,
        tools: Optional[Sequence[Callable[..., Any]]],
        tool_refs: Optional[List[ToolRef]],
        dispatch: Optional[DispatchFn],
        sync: bool,
    ) -> Tuple[Dict[str, _ToolRoute], List[ToolRef], List[ToolDefinition]]:
        """Reconcile and resolve once, returning the name→runner table and refs to send.

        Runs before the first model call on purpose: every failure mode here (an
        unsyncable spec, an unresolvable ref, a missing dispatch) is cheaper to hit
        now than three turns into a conversation.

        :param tools: Functions decorated with ``@acrux.tool``.
        :param tool_refs: Caller-supplied catalog references.
        :param dispatch: Fallback runner, used for ``client`` refs with no local match.
        :param sync: Whether to reconcile ``tools`` with the catalog first.
        :returns: ``(routes, refs, inlined_schemas)`` — ``refs`` is what goes on the
            wire as ``tool_refs`` for the gateway path, and includes one entry per
            decorated tool. ``inlined_schemas`` is the full JSON-Schema ``tools``
            shape for every declared/ref-resolved tool, used instead of ``refs``
            when calling a BYO provider directly (it has no server-side catalog to
            resolve refs against).
        :raises AcruxCoreError: ``API_ERROR`` when something in ``tools`` is not
            decorated; ``MISSING_DISPATCH`` when a ``client`` ref has neither a
            decorated function nor a ``dispatch`` to fall back on.
        """
        routes: Dict[str, _ToolRoute] = {}
        refs: List[ToolRef] = []
        inlined_schemas: List[Dict[str, Any]] = []

        # 1) Decorated tools. Always client-side, so no resolve round-trip is needed —
        # sync already guarantees the catalog holds this exact spec.
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
                result = await self.tools.sync_spec(spec)
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

        # 2) Caller-supplied catalog refs. One batch resolve tells us who runs each.
        caller_refs = list(tool_refs or [])
        if caller_refs:
            resolved: List[ResolvedTool] = await self.tools.resolve(caller_refs)
            for ref, item in zip(caller_refs, resolved):
                name = item.name
                version_id = f"{item.tool_id}:{item.version_number}"
                if name in routes:
                    # A decorated function of the same name wins: the caller wrote the
                    # body, so running it elsewhere would ignore their code.
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
        """Run the full tool-calling loop, then — when ``response_format`` is also given —
        shape the gathered facts into one typed answer.

        Calls the model, runs whatever tools it asks for, appends the results, and repeats
        until the model stops calling tools or ``max_iterations`` is reached. Tools requested
        in a single turn run **concurrently**, with their results appended in call order. See
        :meth:`_run_tool_loop_gather` for the per-round tracing and BYO-provider mechanics.

        Pass ``response_format`` alongside ``tools``/``tool_defs``/``tool_refs`` and the SDK
        runs the gather loop with the format stripped, then one follow-up call with
        ``response_format`` set and no tools to shape the final typed answer — both on one
        trace. The gateway rejects ``tools`` + ``response_format`` on a single request
        (Anthropic fakes ``response_format`` as a forced tool that cannot share a request with
        real tools), so the SDK splits the two rather than making the caller do it.
        ``response_format`` alone (no tools) is one call; ``tools`` alone is unchanged.

        :returns: :class:`RunToolLoopResult`. With shaping, ``content`` is the shaped JSON and
            ``messages`` includes the shaping exchange; ``iterations`` counts only the gather
            rounds.
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

        # Phase 2: shape phase 1's gathered facts into the typed response_format answer, on
        # the SAME trace, with no tools attached. Seed the gather with phase 1's trace id by
        # threading it through the `trace` dict (the gather reads `trace_id` from it), drop
        # the trailing free-text assistant turn, and nudge the model to emit the JSON the
        # schema asks for.
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
        """Run the full tool-calling loop — against the gateway, or directly against a
        BYO provider when ``provider=`` (or the client's own ``provider`` default) is set.

        Calls the model, runs whatever tools it asks for, appends the results, and
        repeats until the model stops calling tools or ``max_iterations`` is reached.
        Tools requested in a single turn run **concurrently**, with their results
        appended in call order.

        **Who runs a tool** is decided once, before the first model call:

        =========================================  ==================================
        Source                                     Runs where
        =========================================  ==================================
        ``tools=[decorated_fn]``                    The decorated function, locally
        ``tool_refs`` resolving to ``http``         On the platform, via the executor
        ``tool_refs`` resolving to ``client``       A matching decorated function, else
                                                    ``dispatch``
        ``tool_defs=[raw_dict]``                    ``dispatch``
        =========================================  ==================================

        A ``client`` executor with no decorated match and no ``dispatch`` raises
        ``MISSING_DISPATCH`` **before** the model is called, so the failure costs no
        tokens.

        On the gateway path, decorated tools are passed as ``tool_refs``, never as an
        inline schema: the model is served the schema the catalog holds, so the
        derived schema and the served schema cannot drift apart. On the BYO path
        there is no server-side catalog to resolve a ``tool_refs`` entry against, so
        every tool — decorated, ref-resolved, and raw ``tool_defs`` — is sent inline
        as a full JSON-Schema ``tools`` definition instead. Because there is no
        gateway to record its own ``llm`` span there, the SDK reports one ``llm``
        span per round-trip itself (stamped with ``prompt_version_id``, ``output``
        set to the round's full assistant message including any ``tool_calls``) in
        addition to the usual ``tool`` spans, all threaded onto the same trace.
        Each BYO ``llm`` span is reported as its round returns rather than held to
        the end, so a long-running loop is observable while it runs. Only the *first*
        round's span is awaited, and only when a platform-run (``http``) tool can
        execute during this loop: that one round-trip guarantees the trace row exists
        before the platform writes its own span under it. Every later round is queued
        in the background — ``parentSpanRef`` is not a foreign key, so a tool span
        stored ahead of its parent ``llm`` span still nests correctly once that span
        is flushed.

        Auto-reports one trace (``trace=True`` by default). On the gateway path the
        gateway records an ``llm`` span per round-trip and the SDK adds a ``tool``
        span per locally-run tool; a platform-side execution gets its span from the
        platform, so the SDK does not report one for it.

        :param model: Model id.
        :param messages: Seed messages.
        :param tools: Functions decorated with ``@acrux.tool``.
        :param tool_defs: Raw OpenAI-shaped tool definitions, sent inline. These
            always route to ``dispatch``.
        :param tool_refs: Catalog references, ``{"name", "alias"}``.
        :param dispatch: ``(name, args) -> result`` (sync or async). Needed only for
            ``tool_defs`` and for ``client`` refs with no decorated match.
        :param sync: Reconcile ``tools`` with the catalog before the first model call.
            Pass ``False`` when a deploy step already synced them and you want the
            loop to make no catalog writes.
        :param max_iterations: Max round-trips (default 10).
        :param temperature: Sampling temperature.
        :param max_tokens: Max completion tokens.
        :param response_format: Structured-output format sent on every round of THIS gather.
            This is the *effective* per-round format: :meth:`run_tool_loop` passes ``None``
            during the tool-gathering phase and the caller's format during the shaping phase,
            since the gateway rejects ``tools`` + ``response_format`` on one request.
        :param trace: ``True``/``False`` or ``{"trace_id", "name", "session_id"}``.
        :param provider: Per-call BYO override; wins over the client's ``provider``
            default. When set (here or as the client default), every round-trip goes
            directly to ``provider["base_url"]`` instead of our gateway.
        :param prompt_version_id: Recorded on each BYO-path ``llm`` span as
            ``promptVersionId`` when tracing is enabled. Has no effect on the gateway
            path (the gateway's own span already carries it).
        :returns: :class:`RunToolLoopResult`.
        :raises AcruxCoreError: ``MISSING_DISPATCH`` when a tool has no runner;
            ``API_ERROR`` on a non-2xx gateway, sync, resolve or execute response;
            ``PROVIDER_ERROR`` on a non-2xx response from a BYO provider endpoint.
        :raises Exception: Whatever a tool function or ``dispatch`` raises propagates
            out — the tool span is still recorded and the trace reported first.
        """
        routes, effective_refs, inlined_schemas = await self._prepare_tool_routes(
            tools, tool_refs, dispatch, sync
        )

        provider_config = provider or self._provider_default
        # A BYO provider has no server-side catalog to resolve tool_refs against, so
        # every tool — decorated, ref-resolved, and raw tool_defs — must be inlined
        # as a full schema.
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
        # Only TOOL spans are batched here — on the gateway path the gateway owns the
        # `llm` spans (with payloads), so reposting them would double-count, and on the
        # BYO path each round's `llm` span is reported below as that round returns,
        # rather than deferred into this list.
        tool_spans: List[IngestSpan] = []
        trace_id: Optional[str] = trace_conf.get("trace_id")

        for i in range(max_iterations):
            extra_headers: Optional[Dict[str, str]] = None
            # Skipped entirely on the BYO path: these headers are only ever handed to
            # `_complete_once`, i.e. to the gateway.
            if trace_enabled and provider_config is None:
                # Percent-encode the free-text name (headers are ISO-8859-1; the
                # gateway decodes it). trace_id is an ASCII UUID.
                extra_headers = {"x-trace-name": quote(trace_name, safe="")}
                if trace_id:
                    extra_headers["x-trace-id"] = trace_id
                # Send the session id so the gateway stamps it when it CREATES the
                # trace — otherwise the trace is born session-less and the run never
                # shows under a session. The gateway reads this header raw, so pass
                # the id as-is (session ids are plain identifiers).
                if session_id:
                    extra_headers["x-session-id"] = session_id
                # Forward trace-level tags and metadata to the gateway.
                tags = trace_conf.get("tags")
                if tags:
                    extra_headers["x-trace-tags"] = ", ".join(tags)
                metadata = trace_conf.get("metadata")
                if metadata:
                    extra_headers["x-trace-metadata"] = json.dumps(metadata)

            # Captured BEFORE the completion call, so the BYO `llm` span below reports the
            # round's real latency. Stamping `startTime` after the call returned (next to
            # `endTime`) made every BYO tool-loop span land with latency_ms: 0, since the
            # ingest endpoint derives latency from exactly that difference.
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

            # Adopt the trace on the first round; reuse it thereafter. On the gateway
            # path this is the gateway's own trace id; on the BYO path it's the id
            # `_complete_via_provider` mints locally for this round (only the first
            # round's id is kept).
            if trace_enabled and not trace_id:
                trace_id = result.gateway.trace_id
            llm_span_ref = result.gateway.span_ref

            # The gateway reports its own `llm` span for a gateway round-trip, so the
            # SDK adds only `tool` spans there. A BYO round-trip has no such
            # server-side span — mirror chat()'s auto-trace here so each round's
            # completion (including any tool_calls in its output) is still visible
            # on the trace.
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
                # Reported IMMEDIATELY (not deferred into `tool_spans`, which is only
                # posted at loop end) so the trace and this round's `llm` span already
                # exist server-side before any http-executor tool in this round dispatches
                # mid-loop. Otherwise POST /tools/:id/execute finds no trace under the
                # client-minted id, creates it itself named `tool:<toolName>`, and drops
                # the supplied parent_span_id — leaving the tool span orphaned at the root
                # of a mis-named trace (apps/api/src/tools/execute/execute.service.ts).
                llm_trace_payload: TraceInput = {"name": trace_name, "spans": [llm_span]}
                if trace_id:
                    llm_trace_payload["traceId"] = trace_id
                if session_id:
                    llm_trace_payload["sessionId"] = session_id
                # Round 0 is AWAITED, and only when a server-side (http) tool can
                # dispatch during this loop: the platform resolves the trace by id, and a
                # missing row is created as `tool:<name>` with the supplied parent dropped.
                # Awaiting here guarantees the trace row exists before the first dispatch.
                #
                # Later rounds never need it — parentSpanRef is a plain nullable string,
                # not a foreign key, and the server-written tool span skips the ingest
                # parent check, so a tool span stored before its parent llm span still
                # nests once that span is flushed. That bounds the worst case at one
                # round-trip per loop instead of one per round, and at zero when every
                # tool runs client-side.
                must_await_trace_open = i == 0 and any(
                    r.kind == "http" for r in routes.values()
                )
                if must_await_trace_open:
                    try:
                        await self.trace(llm_trace_payload)
                    except Exception as err:  # best-effort — never break the loop's result
                        warnings.warn(
                            "[acruxcore] run_tool_loop llm-span report failed — continuing "
                            f"without it: {err}",
                            stacklevel=2,
                        )
                else:
                    self._span_queue.enqueue(llm_trace_payload)

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

            # Run all tool calls concurrently (like Promise.allSettled).
            async def _run_call(call: Dict[str, Any], call_index: int) -> Message:
                name = call["function"]["name"]
                args: Dict[str, Any] = {}
                try:
                    parsed = json.loads(call["function"].get("arguments") or "{}")
                    if isinstance(parsed, dict):
                        args = parsed
                except (ValueError, TypeError):
                    pass  # keep {}

                route = routes.get(name)

                # A server-side execution is traced BY the platform, with the version
                # that ran and the real payloads. Reporting a span here too would show
                # one execution as two.
                if route is not None and route.kind == "http":
                    executed = await self.tools.execute(
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
                        # Keyword expansion, so the decorated function's own parameter
                        # names bind: the signature and the schema cannot disagree,
                        # because one was derived from the other.
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
                # attributes now carry the version that ran and who ran it, which is
                # what a tool span used to be missing entirely.
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
        """Append run_tool_loop's tool spans onto the shared trace the llm spans live in.

        No-op when tracing is disabled or no tool ran. Enqueued rather than awaited, so the
        loop's result is not held up by its own telemetry; the queue drains it on the next
        turn of the event loop. Synchronous for that reason — every call site reads as the
        non-blocking hand-off it now is.

        :param trace_enabled: Whether this loop is tracing at all.
        :param trace_id: The trace the spans belong to, if one has been adopted.
        :param name: Trace name, used only if the trace row does not exist yet.
        :param session_id: Session to stamp on the trace, if any.
        :param spans: The tool spans to report.
        """
        if not trace_enabled or len(spans) == 0:
            return
        payload: TraceInput = {"name": name, "spans": spans}
        if trace_id:
            payload["traceId"] = trace_id
        if session_id:
            payload["sessionId"] = session_id
        self._span_queue.enqueue(payload)

    # --- feedback ----------------------------------------------------------

    async def submit_feedback(
        self,
        trace_id: str,
        *,
        span_id: Optional[str] = None,
        rating: Optional[int] = None,
        label: Optional[str] = None,
        comment: Optional[str] = None,
        source: Optional[str] = None,
    ) -> FeedbackResult:
        """Attach feedback (rating and/or label and/or comment) to a trace or span.

        :param trace_id: The trace id.
        :param span_id: Scope feedback to one span instead of the whole trace.
        :param rating: -1..5.
        :param label: A short label.
        :param comment: Free text.
        :param source: ``user`` | ``developer`` | ``end_user`` | ``api``.
        :returns: The created feedback row.
        :raises AcruxCoreError: On a non-2xx response.
        """
        body: Dict[str, Any] = {}
        if span_id is not None:
            body["spanId"] = span_id
        if rating is not None:
            body["rating"] = rating
        if label is not None:
            body["label"] = label
        if comment is not None:
            body["comment"] = comment
        if source is not None:
            body["source"] = source
        response = await self._request(
            "POST", f"/traces/{quote(trace_id, safe='')}/feedback", body, "submitting feedback"
        )
        return FeedbackResult.from_dict(self._parse_json_or_throw(response, "submitting feedback"))

    async def update_feedback(
        self,
        trace_id: str,
        feedback_id: str,
        *,
        rating: Optional[Any] = ...,
        label: Optional[Any] = ...,
        comment: Optional[Any] = ...,
    ) -> FeedbackResult:
        """Edit a feedback row in place (author only).

        Pass a value to change a field, ``None`` to clear it, or omit it to leave
        it unchanged.

        :param trace_id: The trace id.
        :param feedback_id: The feedback row id.
        :param rating: New rating, or ``None`` to clear. Omit to keep.
        :param label: New label, or ``None`` to clear. Omit to keep.
        :param comment: New comment, or ``None`` to clear. Omit to keep.
        :returns: The updated feedback row.
        :raises AcruxCoreError: On a non-2xx response (403 not author, 404 unknown).
        """
        body: Dict[str, Any] = {}
        if rating is not ...:
            body["rating"] = rating
        if label is not ...:
            body["label"] = label
        if comment is not ...:
            body["comment"] = comment
        response = await self._request(
            "PATCH",
            f"/traces/{quote(trace_id, safe='')}/feedback/{quote(feedback_id, safe='')}",
            body,
            "updating feedback",
        )
        return FeedbackResult.from_dict(self._parse_json_or_throw(response, "updating feedback"))

    # --- reading traces back ----------------------------------------------

    async def get_trace(self, trace_id: str) -> GetTraceResult:
        """Read back a full trace: its header plus every span as a parent/child tree.

        :param trace_id: The trace id.
        :returns: :class:`GetTraceResult`.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 if unknown.
        """
        response = await self._request(
            "GET", f"/traces/{quote(trace_id, safe='')}", None, "reading trace"
        )
        return GetTraceResult.from_dict(self._parse_json_or_throw(response, "reading trace"))

    async def list_traces(
        self,
        *,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        status: Optional[str] = None,
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        prompt_version_id: Optional[str] = None,
        min_latency_ms: Optional[int] = None,
        min_cost_usd: Optional[float] = None,
        min_tokens: Optional[int] = None,
        q: Optional[str] = None,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> ListTracesResult:
        """List traces, newest first, with optional filters.

        :param from_: ISO start of the time range (maps to ``from``).
        :param to: ISO end of the time range.
        :param status: Filter by span status.
        :param model: Filter by model.
        :param session_id: Filter by session id.
        :param prompt_version_id: Filter by prompt version id.
        :param min_latency_ms: Minimum latency.
        :param min_cost_usd: Minimum cost.
        :param min_tokens: Minimum total tokens.
        :param q: Free-text search.
        :param page: 1-based page number.
        :param limit: Page size.
        :returns: :class:`ListTracesResult`.
        :raises AcruxCoreError: On a non-2xx response.
        """
        params: Dict[str, str] = {}
        if from_:
            params["from"] = from_
        if to:
            params["to"] = to
        if status:
            params["status"] = status
        if model:
            params["model"] = model
        if session_id:
            params["session_id"] = session_id
        if prompt_version_id:
            params["prompt_version_id"] = prompt_version_id
        if min_latency_ms is not None:
            params["min_latency_ms"] = str(min_latency_ms)
        if min_cost_usd is not None:
            params["min_cost_usd"] = str(min_cost_usd)
        if min_tokens is not None:
            params["min_tokens"] = str(min_tokens)
        if q:
            params["q"] = q
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)

        qs = urlencode(params)
        path = f"/traces?{qs}" if qs else "/traces"
        response = await self._request("GET", path, None, "listing traces")
        return ListTracesResult.from_dict(self._parse_json_or_throw(response, "listing traces"))

    # --- internal HTTP helpers --------------------------------------------

    async def _raw_request(
        self, method: str, path: str, body: Optional[Dict[str, Any]] = None
    ) -> httpx.Response:
        """Authenticated request that lets :class:`httpx.TransportError` propagate."""
        url = f"{self._base_url}{path}"
        headers = self._auth_headers()
        content = json.dumps(body).encode("utf-8") if body is not None else None
        return await request_with_retry(
            self._client, method, url, headers=headers, content=content,
            max_retries=self._max_retries, retry_interval_ms=self._retry_interval,
        )

    async def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]],
        error_context: str,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> httpx.Response:
        """Authenticated request that maps transport errors to ``NETWORK_ERROR``."""
        url = f"{self._base_url}{path}"
        headers = self._auth_headers(extra_headers)
        content = json.dumps(body).encode("utf-8") if body is not None else None
        try:
            return await request_with_retry(
                self._client, method, url, headers=headers, content=content,
                max_retries=self._max_retries, retry_interval_ms=self._retry_interval,
            )
        except httpx.TransportError as err:
            raise AcruxCoreError(
                f"acruxcore: network error {error_context} — {err}", NETWORK_ERROR
            )

    def _parse_json_or_throw(self, response: httpx.Response, error_context: str) -> Any:
        """Raise ``API_ERROR`` for a non-2xx response; otherwise return parsed JSON."""
        if response.status_code >= 400:
            raise AcruxCoreError(
                f"acruxcore API error {response.status_code} {error_context}",
                API_ERROR,
                response.status_code,
                self._safe_json(response),
            )
        return response.json()

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

    @staticmethod
    def _safe_json(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, json.JSONDecodeError):
            return None


class AsyncChatStream:
    """Async iterator over a streaming :meth:`AcruxCore.chat` call.

    Returned by ``chat(..., stream=True)``. Iterate it with ``async for``::

        async for chunk in await client.chat(model, messages, stream=True):
            print(chunk.delta.get("content", ""), end="")
    """

    def __init__(
        self,
        client: "AcruxCore",
        body: Dict[str, Any],
        *,
        provider_config: Optional["ProviderConfig"] = None,
        model: Optional[str] = None,
        messages: Optional[List[Message]] = None,
        prompt_version_id: Optional[str] = None,
        trace_opt: Union[bool, Dict[str, Any], None] = None,
    ) -> None:
        if provider_config is not None:
            self._gen = client._stream_via_provider(
                model or body.get("model"), messages or body.get("messages") or [], body,
                provider_config, prompt_version_id, trace_opt if trace_opt is not None else True,
            )
        else:
            # Thread trace tags/metadata to the gateway for streaming calls.
            stream_headers: Optional[Dict[str, str]] = None
            if isinstance(trace_opt, dict):
                stream_headers = {}
                tags = trace_opt.get("tags")
                if tags:
                    stream_headers["x-trace-tags"] = ", ".join(tags)
                metadata = trace_opt.get("metadata")
                if metadata:
                    stream_headers["x-trace-metadata"] = json.dumps(metadata)
            self._gen = client._stream_chat(body, stream_headers)

    def __aiter__(self) -> "AsyncChatStream":
        return self

    async def __anext__(self) -> ChatChunk:
        return await self._gen.__anext__()
