"""``client.tools`` — reconcile, resolve and execute catalog tools."""

from __future__ import annotations

import hashlib
import json
import warnings
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Sequence
from urllib.parse import quote, urlencode

from .errors import API_ERROR, AcruxCoreError
from .tooling import ToolSpec, spec_of
from .types import (
    ResolvedTool,
    ToolAliasDetail,
    ToolAnalyticsResult,
    ToolDetail,
    ToolExecuteResult,
    ToolListResult,
    ToolSyncResult,
    ToolVersionDetail,
    ToolVersionListResult,
)

if TYPE_CHECKING:  # avoids a circular import at runtime
    from .client import AcruxCore

#: Max entries in the process-wide sync cache. A deploy syncs a handful of tools;
#: the bound only exists so a pathological caller cannot grow it without limit.
_MAX_SYNC_CACHE = 256

#: Sentinel distinguishing "argument not passed" from "explicit `None`" on
#: :meth:`ToolsNamespace.update`'s ``description`` parameter. The API's
#: `UpdateToolSchema.description` is `nullable().optional()` — three wire states
#: a plain `None` default cannot tell apart: omitting the key (leave the stored
#: value untouched), sending explicit `null` (clear it), or sending a string
#: (set it). A default of `None` would collapse "leave untouched" and "clear it"
#: into the same call shape, so this object identity sentinel stands in for
#: "not passed" instead.
_UNSET: Any = object()

#: spec-hash → ToolSyncResult, so a loop that starts many times per process pays for
#: reconciliation once. Process-wide (not per-client) because the key includes the
#: api-key fingerprint, so two clients for different teams cannot collide.
_sync_cache: "Dict[str, ToolSyncResult]" = {}


def _reset_sync_cache_for_testing() -> None:
    """Clear the process-wide sync cache. Test-only."""
    _sync_cache.clear()


def _spec_hash(spec: ToolSpec, api_key_fingerprint: str) -> str:
    """Stable fingerprint of everything a sync would send, plus which team it goes to.

    :param spec: The spec whose wire payload to fingerprint.
    :param api_key_fingerprint: Non-reversible fingerprint of the calling client's key,
        so two clients pointed at different teams never share a cache entry.
    :returns: A hex sha256 digest.
    """
    payload = json.dumps(
        {
            "k": api_key_fingerprint,
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.parameters_schema,
            "executor": spec.executor,
            "alias": spec.alias,
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class ToolsNamespace:
    """Catalog operations, reached as ``client.tools``.

    Held as a separate object rather than more methods on :class:`AcruxCore` so the
    client's surface stays readable as the catalog grows.

    :param client: The owning client, used for its request/parse helpers and its key.
    """

    def __init__(self, client: "AcruxCore") -> None:
        self._client = client

    async def sync(
        self,
        fns: Sequence[Callable[..., Any]],
        *,
        on_conflict: str = "warn",
    ) -> List[ToolSyncResult]:
        """Reconcile decorated functions with the catalog.

        Idempotent, and cached per process on the spec's hash: calling it twice with
        an unchanged function makes one request. Tools are reconciled sequentially, so
        a failure on the second one leaves the first already committed — the endpoint
        is per-tool atomic, not per-batch.

        :param fns: Functions decorated with ``@acrux.tool``.
        :param on_conflict: ``'warn'`` (default) emits a warning when a commit
            supersedes a dashboard-authored version; ``'error'`` raises instead. Warn
            is the default deliberately: a hard failure would let any dashboard
            experiment block the next deploy.
        :returns: One :class:`~acruxcore.types.ToolSyncResult` per function, in input
            order.
        :raises AcruxCoreError: A function is not decorated, the API rejects a spec,
            or ``on_conflict='error'`` and a dashboard version was superseded.
        """
        results: List[ToolSyncResult] = []
        for fn in fns:
            spec = spec_of(fn)
            if spec is None:
                name = getattr(fn, "__name__", repr(fn))
                raise AcruxCoreError(
                    f"acruxcore: '{name}' is not a tool. Decorate it with @acrux.tool, or pass a "
                    "raw OpenAI tool definition as tool_defs= instead of tools=.",
                    API_ERROR,
                )
            results.append(await self.sync_one(spec, on_conflict=on_conflict))
        return results

    async def sync_one(self, spec: ToolSpec, *, on_conflict: str = "warn") -> ToolSyncResult:
        """Reconcile one :class:`~acruxcore.tooling.ToolSpec`. See :meth:`sync`.

        :param spec: The spec to reconcile.
        :param on_conflict: ``'warn'`` or ``'error'``.
        :returns: The sync outcome. A cache hit reports ``committed=False``, because
            nothing was committed by *this* call.
        :raises AcruxCoreError: On a non-2xx response, or on a superseded dashboard
            version when ``on_conflict='error'``.
        """
        key = _spec_hash(spec, self._client._api_key_fingerprint())
        cached = _sync_cache.get(key)
        if cached is not None:
            return ToolSyncResult(
                tool_id=cached.tool_id,
                version_number=cached.version_number,
                committed=False,
                alias=cached.alias,
                superseded_source=None,
            )

        body: Dict[str, Any] = {
            "name": spec.name,
            "parametersSchema": spec.parameters_schema,
            "executor": spec.executor,
            "alias": spec.alias,
            "source": "code",
        }
        # A function with no docstring sends NO description key, which is what hands
        # ownership of the model-facing text to the dashboard. Sending null instead
        # would erase whatever was written there.
        if spec.description is not None:
            body["description"] = spec.description
        if spec.changelog is not None:
            body["changelog"] = spec.changelog

        response = await self._client._request("POST", "/tools/sync", body, "syncing tool")
        result = ToolSyncResult.from_dict(
            self._client._parse_json_or_throw(response, "syncing tool")
        )

        if result.superseded_source == "dashboard":
            message = (
                f"acruxcore: syncing '{spec.name}' committed v{result.version_number} from code and "
                f"moved '{result.alias}' to it, superseding a version edited in the dashboard. That "
                f"version still exists and can be promoted back from the tool's version list."
            )
            if on_conflict == "error":
                raise AcruxCoreError(message, API_ERROR)
            warnings.warn(message, stacklevel=3)

        if len(_sync_cache) >= _MAX_SYNC_CACHE:
            _sync_cache.clear()
        _sync_cache[key] = result
        return result

    async def resolve(self, refs: Sequence[Dict[str, Any]]) -> List[ResolvedTool]:
        """Resolve catalog refs to schemas plus executor types, in one request.

        :param refs: ``[{"name": ..., "alias": ...}]``; ``alias`` defaults to
            ``production`` server-side.
        :returns: One :class:`~acruxcore.types.ResolvedTool` per ref, in input order.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 when any ref
            does not resolve; ``body['error']['refs']`` names every failure.
        """
        payload = [
            {"name": r["name"], **({"alias": r["alias"]} if r.get("alias") else {})} for r in refs
        ]
        response = await self._client._request(
            "POST", "/tools/resolve", {"refs": payload}, "resolving tools"
        )
        data = self._client._parse_json_or_throw(response, "resolving tools")
        return [ResolvedTool.from_dict(item) for item in (data.get("data") or [])]

    async def execute(
        self,
        tool_id: str,
        arguments: Dict[str, Any],
        *,
        alias: Optional[str] = None,
        version_number: Optional[int] = None,
        trace_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
    ) -> ToolExecuteResult:
        """Run a tool's server-side ``http`` executor on the platform.

        The platform writes the ``tool`` span for this call itself — with the version
        that ran and the real payloads — so a caller must NOT also report one, or the
        trace shows the same execution twice.

        :param tool_id: The tool's id, from :meth:`resolve`.
        :param arguments: The model's parsed arguments.
        :param alias: Which alias to run; omitted means the server's default
            (``production``).
        :param version_number: Pin an exact version instead of following an alias.
        :param trace_id: Trace to attach the span to — pass the loop's trace so the
            execution lands in the same waterfall as the ``llm`` spans.
        :param parent_span_id: Span to nest under, normally the ``llm`` span that
            requested the call.
        :returns: The tool's result plus status, latency and the version that ran.
        :raises AcruxCoreError: 404 unknown tool, 422 ``NOT_EXECUTABLE`` (the resolved
            version has no server-side executor), or 400 from the executor itself.
        """
        body: Dict[str, Any] = {"arguments": arguments}
        if alias is not None:
            body["alias"] = alias
        if version_number is not None:
            body["versionNumber"] = version_number
        trace_context: Dict[str, str] = {}
        if trace_id:
            trace_context["traceId"] = trace_id
        if parent_span_id:
            trace_context["parentSpanId"] = parent_span_id
        if trace_context:
            body["traceContext"] = trace_context

        response = await self._client._request(
            "POST", f"/tools/{tool_id}/execute", body, "executing tool"
        )
        return ToolExecuteResult.from_dict(
            self._client._parse_json_or_throw(response, "executing tool")
        )

    async def list(
        self,
        *,
        search: Optional[str] = None,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> ToolListResult:
        """Lists tools for the team, newest first.

        :param search: Optional free-text filter over the tool's name.
        :param page: 1-based page number.
        :param limit: Page size.
        :returns: One page of tools.
        :raises AcruxCoreError: ``API_ERROR`` on a non-2xx response.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        params: Dict[str, str] = {}
        if search is not None:
            params["search"] = search
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)
        qs = urlencode(params)
        path = f"/tools?{qs}" if qs else "/tools"

        response = await self._client._request("GET", path, None, "listing tools")
        return ToolListResult.from_dict(self._client._parse_json_or_throw(response, "listing tools"))

    async def get(self, tool_id: str) -> ToolDetail:
        """Fetches one tool's shell by id.

        :param tool_id: The tool's id (UUID).
        :returns: The tool.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 if the tool
            doesn't exist (or belongs to another team), including after a soft-delete.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        response = await self._client._request(
            "GET", f"/tools/{quote(tool_id, safe='')}", None, "fetching tool"
        )
        return ToolDetail.from_dict(self._client._parse_json_or_throw(response, "fetching tool"))

    async def create(self, name: str, *, description: Optional[str] = None) -> ToolDetail:
        """Creates a new tool shell. A tool has no schema/executor of its own —
        commit a version with :meth:`commit_version` to give it one.

        :param name: Must match ``^[a-zA-Z0-9_-]{1,64}$`` and be unique per team.
        :param description: Optional human-readable description.
        :returns: The created tool.
        :raises AcruxCoreError: ``API_ERROR`` with code ``VALIDATION_ERROR`` (e.g.
            a name that doesn't match the pattern); code ``TOOL_NAME_TAKEN`` (409)
            if a tool with that name already exists in the team; or 403 if the
            caller's role cannot create tools (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        body: Dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description

        response = await self._client._request("POST", "/tools", body, "creating tool")
        return ToolDetail.from_dict(self._client._parse_json_or_throw(response, "creating tool"))

    async def update(
        self,
        tool_id: str,
        *,
        name: Optional[str] = None,
        description: Any = _UNSET,
    ) -> ToolDetail:
        """Updates a tool's ``name`` and/or ``description``. Does not touch its
        versions — versions are immutable and unaffected by renaming the tool
        they belong to.

        :param tool_id: The tool's id.
        :param name: New name, or omit to leave it untouched.
        :param description: Omit to leave the stored description untouched, pass
            ``None`` to clear it, or a string to set it (see the module-level
            ``_UNSET`` sentinel this default resolves to).
        :returns: The updated tool.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown tool; ``VALIDATION_ERROR``
            if neither ``name`` nor ``description`` is set; or 403 if the caller's
            role cannot update tools (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if description is not _UNSET:
            body["description"] = description

        response = await self._client._request(
            "PATCH", f"/tools/{quote(tool_id, safe='')}", body, "updating tool"
        )
        return ToolDetail.from_dict(self._client._parse_json_or_throw(response, "updating tool"))

    async def delete(self, tool_id: str) -> None:
        """Soft-deletes a tool: it stops appearing in :meth:`list`/:meth:`get`,
        but its versions and aliases are preserved (just unreachable) rather than
        removed.

        The endpoint replies ``204 No Content`` on success, which has no body —
        calling ``_parse_json_or_throw`` unconditionally would throw trying to
        parse it, so the success path returns directly and only a non-2xx
        response is parsed (to raise the typed error).

        :param tool_id: The tool's id.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 if the tool
            doesn't exist, or 403 if the caller's role cannot delete tools
            (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        response = await self._client._request(
            "DELETE", f"/tools/{quote(tool_id, safe='')}", None, "deleting tool"
        )
        if response.status_code >= 400:
            self._client._parse_json_or_throw(response, "deleting tool")

    async def commit_version(
        self,
        tool_id: str,
        parameters_schema: Dict[str, Any],
        executor: Dict[str, Any],
        *,
        description: Optional[str] = None,
        changelog: Optional[str] = None,
        source: Optional[str] = None,
    ) -> ToolVersionDetail:
        """Commits a new immutable version for a tool.

        :param tool_id: The tool's id.
        :param parameters_schema: The version's JSON Schema for its arguments.
        :param executor: ``{"type": "client"}`` (the caller's own app runs it) or
            ``{"type": "http", "url", "method", "headers", "query",
            "bodyTemplate"?, "argMapping", "requestTransform"?,
            "responseTransform"?}``. Kept as a plain dict on both input and
            output rather than a typed union — this SDK already keeps
            :attr:`~acruxcore.types.ResolvedTool.function` untyped for the same
            reason, and inventing a Python discriminated union here would be new
            plumbing this codebase doesn't otherwise have.
        :param description: Optional description for this version.
        :param changelog: Optional changelog note for this version.
        :param source: ``'dashboard'`` or ``'api'``; defaults to ``'api'``
            server-side. ``'code'`` is rejected here — only :meth:`sync`
            (``POST /tools/sync``) may write it.
        :returns: The created version. ``aliases`` is present ONLY when this is
            the tool's first version — both ``production`` and ``staging`` are
            minted and point at it; every later commit returns no ``aliases`` at
            all. ``warnings`` is present only when this commit has a
            ``changelog`` but no ``description`` (a likely omission, not an
            error).
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown tool, or
            ``VALIDATION_ERROR`` (e.g. invalid ``executor`` shape, or a
            ``source`` of ``'code'``).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        body: Dict[str, Any] = {"parametersSchema": parameters_schema, "executor": executor}
        if description is not None:
            body["description"] = description
        if changelog is not None:
            body["changelog"] = changelog
        if source is not None:
            body["source"] = source

        response = await self._client._request(
            "POST", f"/tools/{quote(tool_id, safe='')}/versions", body, "committing tool version"
        )
        return ToolVersionDetail.from_dict(
            self._client._parse_json_or_throw(response, "committing tool version")
        )

    async def list_versions(
        self,
        tool_id: str,
        *,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> ToolVersionListResult:
        """Lists a tool's versions, newest first. List items omit
        ``parameters_schema``/``executor`` to keep pages small — use
        :meth:`get_version` for the full content.

        :param tool_id: The tool's id.
        :param page: 1-based page number.
        :param limit: Page size.
        :returns: One page of versions.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown tool.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        params: Dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)
        qs = urlencode(params)
        path = f"/tools/{quote(tool_id, safe='')}/versions"
        if qs:
            path += f"?{qs}"

        response = await self._client._request("GET", path, None, "listing tool versions")
        return ToolVersionListResult.from_dict(
            self._client._parse_json_or_throw(response, "listing tool versions")
        )

    async def get_version(self, tool_id: str, version_number: int) -> ToolVersionDetail:
        """Fetches one version with its full ``parameters_schema``/``executor``.
        Unlike :meth:`commit_version`'s response, this never includes
        ``aliases``/``warnings`` — only the commit response ever has either.

        :param tool_id: The tool's id.
        :param version_number: The version's sequential number (1-based,
            immutable).
        :returns: The version.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown tool or version number.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        response = await self._client._request(
            "GET",
            f"/tools/{quote(tool_id, safe='')}/versions/{quote(str(version_number), safe='')}",
            None,
            "fetching tool version",
        )
        return ToolVersionDetail.from_dict(
            self._client._parse_json_or_throw(response, "fetching tool version")
        )

    async def promote_alias(self, tool_id: str, alias: str, version_number: int) -> ToolAliasDetail:
        """Promotes an alias to point at a specific version — e.g. rolling
        ``production`` forward (or back) to a version already committed. Creates
        the alias if it does not exist yet.

        :param tool_id: The tool's id.
        :param alias: The alias name (e.g. ``'production'``, ``'staging'``, or a
            custom one).
        :param version_number: The version to point the alias at.
        :returns: The alias's new state.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown tool/version, or 403 if
            the caller's role cannot promote (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        response = await self._client._request(
            "POST",
            f"/tools/{quote(tool_id, safe='')}/aliases/{quote(alias, safe='')}/promote",
            {"version_number": version_number},
            "promoting tool alias",
        )
        return ToolAliasDetail.from_dict(
            self._client._parse_json_or_throw(response, "promoting tool alias")
        )

    async def analytics(
        self, *, since: Optional[str] = None, until: Optional[str] = None
    ) -> ToolAnalyticsResult:
        """Reads aggregated call analytics (count, error rate, p50/p95 latency)
        per tool, over an optional time window.

        :param since: Optional ISO-8601 lower bound.
        :param until: Optional ISO-8601 upper bound.
        :returns: One entry per tool that had calls in the window. Empty
            ``data`` when nothing executed, or the window excludes every
            execution.
        :raises AcruxCoreError: ``API_ERROR`` with code ``VALIDATION_ERROR`` on a
            non-ISO-8601 ``since``/``until``.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after
            retries.
        """
        params: Dict[str, str] = {}
        if since is not None:
            params["since"] = since
        if until is not None:
            params["until"] = until
        qs = urlencode(params)
        path = f"/tools/analytics?{qs}" if qs else "/tools/analytics"

        response = await self._client._request("GET", path, None, "fetching tool analytics")
        return ToolAnalyticsResult.from_dict(
            self._client._parse_json_or_throw(response, "fetching tool analytics")
        )
