"""The async Acrux Core client — resource-based namespace pattern."""

from __future__ import annotations

import hashlib
import json
import os
import warnings
from typing import Any, Dict, Optional, Set
from urllib.parse import urlparse

import httpx

from .cache import get_cache
from .errors import (
    API_ERROR,
    MISSING_API_KEY,
    MISSING_BASE_URL,
    NETWORK_ERROR,
    AcruxCoreError,
)
from .evaluations import DatasetsNamespace, ExperimentsNamespace, RunsNamespace, OptimizeNamespace
from .gateway_api import GatewayNamespace
from .http import request_with_retry
from .prompts_api import PromptsNamespace
from .sessions_api import SessionsNamespace
from .span_queue import SpanQueue
from .tools_api import ToolsNamespace
from .traces_api import TracesNamespace
from .types import ProviderConfig

DEFAULT_MAX_CACHE_SIZE = 500
DEFAULT_MAX_RETRIES = 1
DEFAULT_RETRY_INTERVAL = 500


def _hash_api_key(api_key: str) -> str:
    """Short, non-reversible fingerprint of an API key for use in cache keys."""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def _is_loopback_host(hostname: Optional[str]) -> bool:
    """True for local-dev hosts where a plaintext base_url is not a security issue."""
    return hostname in ("localhost", "127.0.0.1", "::1")


#: URLs already warned about.
_warned_cleartext_urls: Set[str] = set()


def _warn_if_cleartext_url(url: str, what: str) -> None:
    """Warn, once per URL, when an Authorization-bearing request is about to travel
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


class AcruxCore:
    """Async client for Acrux Core — resource-based namespace pattern.

    Every method is accessed through its domain namespace:
    - ``client.prompts.*`` — prompt lifecycle + render
    - ``client.gateway.*`` — chat, stream, run_tool_loop, flush, aclose
    - ``client.traces.*`` — trace CRUD, analytics, feedback
    - ``client.tools.*`` — tool catalog operations
    - ``client.sessions.*`` — session listing
    - ``client.datasets.*`` / ``client.experiments.*`` / ``client.runs.*`` / ``client.optimize.*`` — evaluations

    Create one instance at process startup and reuse it — the render cache is a
    process-wide singleton and ``max_cache_size`` is set by the first instance.
    Close it with :meth:`aclose` or use it as an async context manager.

    Config resolution per field: constructor arg → environment variable → default.

    :param api_key: API key. Fallback: ``ACRUXCORE_API_KEY``.
    :param base_url: API base URL. Fallback: ``ACRUXCORE_BASE_URL``.
    :param cache_ttl: Milliseconds before a cached render is stale. Default 60000.
    :param max_cache_size: Max LRU entries. Default 500 (first instance wins).
    :param max_retries: Retries on transient failure. Default 1 (2 attempts).
    :param retry_interval: Milliseconds between retries. Default 500.
    :param timeout: Per-request timeout in seconds. Default 30.
    :param transport: An httpx transport (for testing/injection). Optional.
    :param provider: Client-level BYO default.
    :raises AcruxCoreError: ``MISSING_API_KEY`` / ``MISSING_BASE_URL`` if required
        config is absent.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        *,
        cache_ttl: int = 60_000,
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
        self._provider_default: Optional[ProviderConfig] = provider
        self._timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport)

        _warn_if_cleartext_url(self._base_url, "base_url")
        if self._provider_default and self._provider_default.get("base_url"):
            _warn_if_cleartext_url(self._provider_default["base_url"], "provider.base_url")

        get_cache(max_cache_size)

        # Span queue — the gateway owns it, but the client creates it here so the
        # exit-flush hook can reach it.
        self._span_queue = SpanQueue(self._send_trace_batch)

        # Namespace instances
        self.tools = ToolsNamespace(self)
        self.prompts = PromptsNamespace(self, cache_ttl, max_cache_size)
        self.datasets = DatasetsNamespace(self)
        self.experiments = ExperimentsNamespace(self)
        self.runs = RunsNamespace(self)
        self.optimize = OptimizeNamespace(self)
        self.traces = TracesNamespace(self)
        self.sessions = SessionsNamespace(self)
        self.gateway = GatewayNamespace(self)

    # ── host interface ─────────────────────────────────────────────────────

    def _api_key_fingerprint(self) -> str:
        """Short, non-reversible fingerprint of this client's key, for cache keys."""
        return _hash_api_key(self._api_key)

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

    @staticmethod
    def _safe_json(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, json.JSONDecodeError):
            return None

    async def _send_trace_batch(self, batch: list) -> None:
        """Sender the span queue drives. Failures propagate so the queue can warn and drop."""
        response = await request_with_retry(
            self._client,
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

    # ── lifecycle ──────────────────────────────────────────────────────────

    async def __aenter__(self) -> "AcruxCore":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.gateway.aclose()
