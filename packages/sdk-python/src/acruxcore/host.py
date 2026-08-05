"""Shared host protocols for all namespace classes.

Every namespace receives a host object conforming to one of these protocols so
it can make authenticated requests without importing the client directly (which
would be a runtime circular import).
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Protocol

import httpx


class NamespaceHost(Protocol):
    """Base protocol shared by all namespace classes."""

    async def _request(
        self,
        method: str,
        path: str,
        body: Any,
        error_context: str,
        extra_headers: Optional[Dict[str, str]] = ...,
    ) -> httpx.Response: ...

    def _parse_json_or_throw(
        self, response: httpx.Response, error_context: str
    ) -> Any: ...

    def _api_key_fingerprint(self) -> str: ...


class GatewayNamespaceHost(NamespaceHost, Protocol):
    """Extended host for the gateway namespace.

    The gateway needs additional client internals for chat/stream/run_tool_loop:
    API key and base URL for BYO provider calls, retry config, the span queue
    for background trace reporting, and the tools namespace for run_tool_loop's
    sync_one/resolve/execute calls.
    """

    @property
    def _api_key(self) -> str: ...

    @property
    def _base_url(self) -> str: ...

    @property
    def _max_retries(self) -> int: ...

    @property
    def _retry_interval(self) -> int: ...

    @property
    def _provider_default(self) -> Optional[Any]: ...

    @property
    def _span_queue(self) -> Any: ...

    @property
    def tools(self) -> Any: ...

    @property
    def _client(self) -> Any: ...

    @property
    def _timeout(self) -> float: ...

    def _auth_headers(self, extra_headers: Optional[Dict[str, str]] = ...) -> Dict[str, str]: ...

    @staticmethod
    def _safe_json(response: Any) -> Any: ...
