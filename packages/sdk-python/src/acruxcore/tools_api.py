"""``client.tools`` — reconcile, resolve and execute catalog tools."""

from __future__ import annotations

import hashlib
import json
import warnings
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Sequence

from .errors import API_ERROR, AcruxCoreError
from .tooling import ToolSpec, spec_of
from .types import ResolvedTool, ToolExecuteResult, ToolSyncResult

if TYPE_CHECKING:  # avoids a circular import at runtime
    from .client import AcruxCore

#: Max entries in the process-wide sync cache. A deploy syncs a handful of tools;
#: the bound only exists so a pathological caller cannot grow it without limit.
_MAX_SYNC_CACHE = 256

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
            results.append(await self.sync_spec(spec, on_conflict=on_conflict))
        return results

    async def sync_spec(self, spec: ToolSpec, *, on_conflict: str = "warn") -> ToolSyncResult:
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
