"""``client.sessions`` — session listing and detail."""

from __future__ import annotations

from typing import TYPE_CHECKING, Dict, Optional
from urllib.parse import quote, urlencode

from .types import SessionDetailResult, SessionListResult

if TYPE_CHECKING:  # avoids a circular import at runtime
    from .client import AcruxCore


class SessionsNamespace:
    """The sessions read surface, reached as ``client.sessions``. Sessions are
    mounted at ``/api/v1/sessions`` — a sibling path to ``/api/v1/traces``, not
    nested under it — so this is its own namespace rather than folded into
    :class:`~acruxcore.traces_api.TracesNamespace`.

    :param client: The owning client, used for its request/parse helpers.
    """

    def __init__(self, client: "AcruxCore") -> None:
        self._client = client

    async def list(
        self,
        *,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        page: Optional[int] = None,
        limit: Optional[int] = None,
        q: Optional[str] = None,
    ) -> SessionListResult:
        """Lists the team's sessions (rolled up by ``sessionId``),
        newest-activity-first. Wraps ``GET /sessions``.

        :param from_: ISO date/datetime, inclusive lower bound on trace
            activity (wire key ``from``). Omitted means the server's
            last-30-days default.
        :param to: ISO date/datetime, exclusive upper bound on trace activity.
        :param page: 1-based page number. Defaults server-side to 1.
        :param limit: Page size, capped at 100 server-side. Defaults
            server-side to 20.
        :param q: Case-insensitive substring match on the session id.
        :returns: :class:`~acruxcore.types.SessionListResult` — one entry per
            session.
        :raises AcruxCoreError: ``API_ERROR`` — 400 ``VALIDATION_ERROR`` for an
            unparseable ``from``/``to``, or ``limit`` over 100.
        """
        params: Dict[str, str] = {}
        if from_ is not None:
            params["from"] = from_
        if to is not None:
            params["to"] = to
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)
        if q is not None:
            params["q"] = q

        qs = urlencode(params)
        path = f"/sessions?{qs}" if qs else "/sessions"
        response = await self._client._request("GET", path, None, "listing sessions")
        return SessionListResult.from_dict(
            self._client._parse_json_or_throw(response, "listing sessions")
        )

    async def get(self, session_id: str) -> SessionDetailResult:
        """Reads one session's rolled-up summary plus every trace in it. Wraps
        ``GET /sessions/:id``.

        :param session_id: The caller-chosen session id (not a UUID — it can
            contain characters needing encoding, so this is always
            percent-encoded).
        :returns: :class:`~acruxcore.types.SessionDetailResult` — ``session``
            plus ``traces``. ``traces`` items are
            :class:`~acruxcore.types.SessionTraceItem`, NOT
            :class:`~acruxcore.types.TraceSummary` — they additionally carry
            ``tags``.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 if the
            team has no trace with that session id.
        """
        response = await self._client._request(
            "GET",
            f"/sessions/{quote(session_id, safe='')}",
            None,
            "reading session",
        )
        return SessionDetailResult.from_dict(
            self._client._parse_json_or_throw(response, "reading session")
        )
