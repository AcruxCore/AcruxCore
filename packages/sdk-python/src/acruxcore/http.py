"""Async HTTP helper with the SDK's retry policy.

Mirrors the TypeScript SDK's ``fetch.ts``: retries on network-level errors,
HTTP 429 (rate limit), and HTTP 5xx. Other 4xx are returned immediately for the
caller to interpret. Total attempts = ``1 + max_retries``.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

import httpx


async def request_with_retry(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    content: Optional[bytes] = None,
    max_retries: int = 1,
    retry_interval_ms: int = 500,
) -> httpx.Response:
    """Perform an HTTP request, retrying transient failures.

    Retries on network-level errors (``httpx.TransportError``), HTTP 429
    (rate limit), and HTTP 5xx. Does **not** retry other 4xx — returns those
    immediately so the caller can read the error body. After exhausting retries
    on a 429 or 5xx it returns the last response (so the body is still readable).

    :param client: The shared :class:`httpx.AsyncClient`.
    :param method: HTTP method.
    :param url: Absolute URL.
    :param headers: Request headers.
    :param content: Raw request body bytes (already JSON-encoded), or ``None``.
    :param max_retries: Additional attempts after the first failure.
    :param retry_interval_ms: Fixed delay between attempts, in milliseconds.
    :returns: The response from the last attempt.
    :raises httpx.TransportError: If every attempt fails at the network level.
    """
    total_attempts = 1 + max_retries
    last_error: Optional[BaseException] = None

    for attempt in range(total_attempts):
        if attempt > 0:
            await asyncio.sleep(retry_interval_ms / 1000)

        try:
            response = await client.request(method, url, headers=headers, content=content)
        except httpx.TransportError as err:
            last_error = err
            if attempt < total_attempts - 1:
                continue
            raise

        # 429 (rate limit) retries like a 5xx — the gateway used to absorb this via
        # fallback routing across providers; a direct BYO call has no such routing.
        is_retryable = response.status_code == 429 or response.status_code >= 500

        # Other 4xx: do not retry — return immediately for the caller to handle.
        if 400 <= response.status_code < 500 and not is_retryable:
            return response

        # 429/5xx: retry while attempts remain, else return the last response.
        if is_retryable:
            last_error = httpx.HTTPStatusError(
                f"HTTP {response.status_code}", request=response.request, response=response
            )
            if attempt < total_attempts - 1:
                continue
            return response

        # 2xx / 3xx: success.
        return response

    # Unreachable in practice.
    assert last_error is not None
    raise last_error
