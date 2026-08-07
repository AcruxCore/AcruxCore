"""``client.traces`` — analytics, facet discovery, payload-capture settings, and
feedback summary/list."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional, Union
from urllib.parse import quote, urlencode

from .types import (
    AnalyticsResult,
    FacetValuesResult,
    FeedbackListResult,
    FeedbackResult,
    FeedbackSummaryResult,
    GetTraceResult,
    ListTracesResult,
    TraceFacets,
    TraceFeedbackResult,
    TraceResult,
    TraceSettings,
)

if TYPE_CHECKING:  # avoids a circular import at runtime
    from .client import AcruxCore


class TracesNamespace:
    """Trace-domain-wide reads — analytics, facet discovery, payload-capture
    settings, and feedback summary/list — reached as ``client.traces``.

    Held as a separate object rather than more flat methods on
    :class:`~acruxcore.client.AcruxCore` so the client's surface stays readable
    as this domain grows. The existing flat ``trace``/``get_trace``/
    ``list_traces``/``submit_feedback``/``update_feedback`` methods stay on
    :class:`~acruxcore.client.AcruxCore` itself — this namespace is purely
    additive.

    :param client: The owning client, used for its request/parse helpers.
    """

    def __init__(self, client: "AcruxCore") -> None:
        self._client = client

    async def analytics(
        self,
        *,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        group_by: Optional[str] = None,
        kind: Optional[str] = None,
        model: Optional[str] = None,
    ) -> AnalyticsResult:
        """Aggregate volume / error-rate / token / cost / latency metrics over
        every span (gateway completions AND SDK-reported spans — a superset of
        the gateway-only usage numbers). Wraps ``GET /traces/analytics``.

        :param from_: ISO date/datetime, inclusive lower bound on ``startedAt``
            (sent on the wire as ``from`` — named with a trailing underscore
            here because ``from`` is a Python keyword). Omitted means the
            server's last-30-days default.
        :param to: ISO date/datetime, exclusive upper bound on ``startedAt``.
        :param group_by: Aggregation dimension — ``'day'``, ``'model'``,
            ``'session'``, or ``'prompt_version'``. Defaults server-side to
            ``'day'``.
        :param kind: Narrows to spans of one kind (``'llm'``, ``'tool'``, ...).
        :param model: Narrows to spans reported with this exact model string.
        :returns: :class:`~acruxcore.types.AnalyticsResult` — totals across the
            resolved window plus one bucket per group key. A bucket whose group
            key is null (e.g. a span with no model) is omitted from ``buckets``
            but its span is still counted in ``totals``.
        :raises AcruxCoreError: ``API_ERROR`` — 400 ``VALIDATION_ERROR`` for an
            invalid ``group_by``/``kind``, an unparseable ``from``/``to``, or
            ``from`` after ``to``.
        """
        params: Dict[str, str] = {}
        if from_ is not None:
            params["from"] = from_
        if to is not None:
            params["to"] = to
        if group_by is not None:
            params["group_by"] = group_by
        if kind is not None:
            params["kind"] = kind
        if model is not None:
            params["model"] = model

        qs = urlencode(params)
        path = f"/traces/analytics?{qs}" if qs else "/traces/analytics"
        response = await self._client._request("GET", path, None, "reading trace analytics")
        return AnalyticsResult.from_dict(
            self._client._parse_json_or_throw(response, "reading trace analytics")
        )

    async def list_facets(self) -> TraceFacets:
        """The team's distinct tags and metadata keys, for populating filter
        pickers. Wraps ``GET /traces/facets``.

        :returns: :class:`~acruxcore.types.TraceFacets` — ``tags`` and
            ``metadata_keys``, each alphabetical.
        :raises AcruxCoreError: On a non-2xx response.
        """
        response = await self._client._request(
            "GET", "/traces/facets", None, "listing trace facets"
        )
        return TraceFacets.from_dict(
            self._client._parse_json_or_throw(response, "listing trace facets")
        )

    async def get_facet_values(self, key: str) -> FacetValuesResult:
        """The team's distinct values for one metadata key. Wraps
        ``GET /traces/facets/values``.

        :param key: The metadata key to enumerate values for. Always required —
            there is no "list every key's values" mode.
        :returns: :class:`~acruxcore.types.FacetValuesResult` — alphabetical
            ``values``. Note the response carries no ``key`` field, only
            ``values``.
        :raises AcruxCoreError: ``API_ERROR`` — 400 ``VALIDATION_ERROR``
            ("key is required.") when ``key`` is an empty string.
        """
        response = await self._client._request(
            "GET",
            f"/traces/facets/values?key={quote(key, safe='')}",
            None,
            "reading trace facet values",
        )
        return FacetValuesResult.from_dict(
            self._client._parse_json_or_throw(response, "reading trace facet values")
        )

    async def get_settings(self) -> TraceSettings:
        """Reads the team's trace payload-capture default. Wraps
        ``GET /traces/settings``.

        :returns: :class:`~acruxcore.types.TraceSettings`. ``updated_at`` is
            ``None`` until the team's settings row has ever been written — the
            lazy default it reads back as is
            ``TraceSettings(capture_payloads=True, updated_at=None)``.
        :raises AcruxCoreError: On a non-2xx response.
        """
        response = await self._client._request(
            "GET", "/traces/settings", None, "reading trace settings"
        )
        return TraceSettings.from_dict(
            self._client._parse_json_or_throw(response, "reading trace settings")
        )

    async def update_settings(self, capture_payloads: bool) -> TraceSettings:
        """Toggles the team's trace payload-capture default. Wraps
        ``PUT /traces/settings``.

        :param capture_payloads: The new default. A single boolean, not an
            options object, since the endpoint takes exactly this one field.
        :returns: The updated settings, with ``updated_at`` now a real timestamp.
        :raises AcruxCoreError: ``API_ERROR`` — 400 ``VALIDATION_ERROR`` if the
            body is not a boolean; 403 when the caller is a team-scoped API key
            (no user identity) or a personal key/session belonging to a
            non-owner/admin member — a personal key minted by an owner/admin
            succeeds.
        """
        response = await self._client._request(
            "PUT",
            "/traces/settings",
            {"capturePayloads": capture_payloads},
            "updating trace settings",
        )
        return TraceSettings.from_dict(
            self._client._parse_json_or_throw(response, "updating trace settings")
        )

    async def get_feedback_summary(
        self,
        *,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        group_by: Optional[str] = None,
    ) -> FeedbackSummaryResult:
        """Average rating and counts grouped by prompt version or model. Wraps
        ``GET /traces/feedback/summary``.

        :param from_: ISO date/datetime, inclusive lower bound (wire key
            ``from``).
        :param to: ISO date/datetime, exclusive upper bound.
        :param group_by: Aggregation dimension — ``'prompt_version'`` or
            ``'model'``. Defaults server-side to ``'prompt_version'``.
        :returns: :class:`~acruxcore.types.FeedbackSummaryResult`. A group key
            with no feedback yet is simply absent from ``buckets``, never a
            zeroed entry.
        :raises AcruxCoreError: ``API_ERROR`` — 400 ``VALIDATION_ERROR`` for an
            invalid ``group_by`` or an unparseable ``from``/``to``.
        """
        params: Dict[str, str] = {}
        if from_ is not None:
            params["from"] = from_
        if to is not None:
            params["to"] = to
        if group_by is not None:
            params["group_by"] = group_by

        qs = urlencode(params)
        path = f"/traces/feedback/summary?{qs}" if qs else "/traces/feedback/summary"
        response = await self._client._request("GET", path, None, "reading feedback summary")
        return FeedbackSummaryResult.from_dict(
            self._client._parse_json_or_throw(response, "reading feedback summary")
        )

    async def list_feedback(
        self,
        *,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> FeedbackListResult:
        """Team-wide feedback feed, newest-first, paginated. Wraps
        ``GET /traces/feedback``.

        :param page: 1-based page number. Defaults server-side to 1.
        :param limit: Page size, capped at 100 server-side. Defaults
            server-side to 20.
        :returns: :class:`~acruxcore.types.FeedbackListResult` — every feedback
            row across the team, not scoped to one trace (see
            :meth:`get_trace_feedback` for that).
        :raises AcruxCoreError: On a non-2xx response.
        """
        params: Dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)

        qs = urlencode(params)
        path = f"/traces/feedback?{qs}" if qs else "/traces/feedback"
        response = await self._client._request("GET", path, None, "listing feedback")
        return FeedbackListResult.from_dict(
            self._client._parse_json_or_throw(response, "listing feedback")
        )

    async def get_trace_feedback(self, trace_id: str) -> TraceFeedbackResult:
        """Every feedback row for one trace. Wraps
        ``GET /traces/:id/feedback``.

        :param trace_id: The trace to read feedback for.
        :returns: :class:`~acruxcore.types.TraceFeedbackResult` — an
            unpaginated, full list for this one trace. This is a DIFFERENT
            envelope shape from :meth:`list_feedback`'s ``{data, total, page,
            limit}``, despite both returning the same row shape
            (:class:`~acruxcore.types.FeedbackResult`): there is no
            ``total``/``page``/``limit`` here.
        :raises AcruxCoreError: On a non-2xx response.
        """
        response = await self._client._request(
            "GET",
            f"/traces/{quote(trace_id, safe='')}/feedback",
            None,
            "reading trace feedback",
        )
        return TraceFeedbackResult.from_dict(
            self._client._parse_json_or_throw(response, "reading trace feedback")
        )

    # ── Trace CRUD (moved from flat client methods) ───────────────────────

    async def ingest(self, input: Dict[str, Any]) -> TraceResult:
        """Report a trace (a group of spans) to AcruxCore.

        A single-trace convenience over the batch endpoint. Omit ``traceId`` to
        mint a new trace; pass one to append spans to it. Never cached.

        :param input: The trace and its spans.
        :returns: ``TraceResult(trace_id)``.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if unreachable; ``API_ERROR``
            for a non-2xx response.
        """
        from .errors import API_ERROR, NETWORK_ERROR, AcruxCoreError
        from .http import request_with_retry
        import httpx, json

        try:
            response = await self._client._request("POST", "/traces", {"traces": [input]}, "reporting trace")
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

    async def get(self, trace_id: str) -> GetTraceResult:
        """Read back a full trace: its header plus every span as a parent/child tree.

        :param trace_id: The trace id.
        :returns: :class:`~acruxcore.types.GetTraceResult`.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 if unknown.
        """
        response = await self._client._request(
            "GET", f"/traces/{quote(trace_id, safe='')}", None, "reading trace"
        )
        return GetTraceResult.from_dict(self._client._parse_json_or_throw(response, "reading trace"))

    async def list(
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
        :returns: :class:`~acruxcore.types.ListTracesResult`.
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
        response = await self._client._request("GET", path, None, "listing traces")
        return ListTracesResult.from_dict(self._client._parse_json_or_throw(response, "listing traces"))

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
        response = await self._client._request(
            "POST", f"/traces/{quote(trace_id, safe='')}/feedback", body, "submitting feedback"
        )
        return FeedbackResult.from_dict(self._client._parse_json_or_throw(response, "submitting feedback"))

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
        response = await self._client._request(
            "PATCH",
            f"/traces/{quote(trace_id, safe='')}/feedback/{quote(feedback_id, safe='')}",
            body,
            "updating feedback",
        )
        return FeedbackResult.from_dict(self._client._parse_json_or_throw(response, "updating feedback"))

    @staticmethod
    def _safe_json(response: Any) -> Any:
        """Safely parse JSON from a response, returning None on failure."""
        import json
        try:
            return response.json()
        except (ValueError, json.JSONDecodeError):
            return None
