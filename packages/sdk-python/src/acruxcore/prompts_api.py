"""``client.prompts`` — prompt and prompt-version lifecycle operations."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional
from urllib.parse import quote, urlencode

from .cache import CacheEntry, get_cache
from .errors import (
    API_ERROR,
    MISSING_VARIABLES,
    NETWORK_ERROR,
    VALIDATION_ERROR,
    AcruxCoreError,
)
from .types import (
    AliasDetail,
    DiffResult,
    ExportedPromptVersion,
    ImportPromptResult,
    ListTracesResult,
    PromptDetail,
    PromptListResult,
    PromptMessage,
    PromptToolBindings,
    RenderResult,
    ToolBindingDetail,
    ToolResolution,
    VersionDetail,
    VersionListResult,
)

if TYPE_CHECKING:  # avoids a circular import at runtime
    from .host import NamespaceHost

#: Default max cache size (first instance wins).
DEFAULT_MAX_CACHE_SIZE = 500

#: Sentinel distinguishing "the caller did not pass description=" (leave the
#: stored value untouched) from an explicit `description=None` (clear it) — see
#: `update()`. `UpdatePromptSchema` in `apps/api/src/prompts/prompts.types.ts`
#: makes `description` `nullable().optional()`, so the wire body has three
#: distinct states (key absent / `null` / a string) that a plain Python `None`
#: default cannot tell apart — `None` would otherwise have to mean both "not
#: provided" and "clear it".
_UNSET: Any = object()


def _hash_api_key(api_key: str) -> str:
    """Short, non-reversible fingerprint of an API key for use in cache keys."""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def _hash_variables(variables: Dict[str, Any]) -> str:
    """Fingerprint the variables a render used, so they take part in the cache key.

    ``sort_keys`` makes the digest independent of key order at every depth;
    ``default=str`` keeps a non-JSON-serialisable value from raising.
    """
    canonical = json.dumps(variables, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _binding_body(
    tool_alias: Optional[str],
    pinned_version_number: Optional[int],
    off: bool,
    *,
    allow_off: bool,
) -> Dict[str, Any]:
    """Builds the wire body for a tool binding, which is snake_case
    (``tool_alias``, ``pinned_version_number``, ``off``) like the rest of the
    prompts API's request bodies.

    The API takes exactly one of the three and 400s otherwise. Checking here
    turns "zero or two targets" into a local ``VALIDATION_ERROR`` naming the
    keyword arguments, instead of an opaque 400 from a round-trip.

    :param allow_off: ``True`` only on the per-alias endpoint — a default binding
        has no default of its own to contradict, so ``off`` is meaningless there.
    """
    given = [
        tool_alias is not None,
        pinned_version_number is not None,
        bool(off),
    ]
    if off and not allow_off:
        raise AcruxCoreError(
            "acruxcore: off=True is only valid for a prompt alias's own binding. To stop "
            "every alias from calling the tool, remove the default binding with "
            "prompts.remove_tool_binding().",
            VALIDATION_ERROR,
        )
    if sum(given) != 1:
        options = "tool_alias=, pinned_version_number=" + (", or off=True" if allow_off else "")
        raise AcruxCoreError(
            f"acruxcore: a tool binding needs exactly one of {options}.",
            VALIDATION_ERROR,
        )

    if tool_alias is not None:
        return {"tool_alias": tool_alias}
    if pinned_version_number is not None:
        return {"pinned_version_number": pinned_version_number}
    return {"off": True}


class PromptsNamespace:
    """Prompt and prompt-version lifecycle operations, reached as ``client.prompts``.

    Held as a separate object rather than more methods on :class:`AcruxCore` so the
    client's surface stays readable as the catalog grows — mirrors
    :class:`~acruxcore.tools_api.ToolsNamespace`.

    :param client: The owning client, used for its request/parse helpers.
    :param cache_ttl: Milliseconds before a cached render is stale. Default 60000.
    :param max_cache_size: Max LRU entries. Default 500.
    """

    def __init__(
        self,
        client: "NamespaceHost",
        cache_ttl: int = 60_000,
        max_cache_size: int = DEFAULT_MAX_CACHE_SIZE,
    ) -> None:
        self._client = client
        self._cache_ttl = cache_ttl
        self._max_cache_size = max_cache_size

    async def list(
        self,
        *,
        search: Optional[str] = None,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> PromptListResult:
        """Lists prompts for the team, newest first.

        :param search: Free-text match against the prompt name.
        :param page: 1-based page number.
        :param limit: Page size.
        :returns: One page of prompts.
        :raises AcruxCoreError: ``API_ERROR`` on a non-2xx response.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        params: Dict[str, str] = {}
        if search is not None:
            params["search"] = search
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)

        qs = urlencode(params)
        path = f"/prompts?{qs}" if qs else "/prompts"
        response = await self._client._request("GET", path, None, "listing prompts")
        return PromptListResult.from_dict(
            self._client._parse_json_or_throw(response, "listing prompts")
        )

    async def get(self, prompt_id: str) -> PromptDetail:
        """Fetches one prompt by id.

        :param prompt_id: The prompt's id (UUID).
        :returns: The prompt.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 if the prompt
            doesn't exist (or belongs to another team).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "GET", f"/prompts/{quote(prompt_id, safe='')}", None, "fetching prompt"
        )
        return PromptDetail.from_dict(
            self._client._parse_json_or_throw(response, "fetching prompt")
        )

    async def create(self, name: str, *, description: Optional[str] = None) -> PromptDetail:
        """Creates a new prompt. A prompt has no messages of its own — commit a
        version with :meth:`commit_version` to give it content.

        :param name: 1-255 chars, unique per team.
        :param description: Up to 2000 chars. Omit for no description.
        :returns: The created prompt.
        :raises AcruxCoreError: ``API_ERROR`` with code ``VALIDATION_ERROR`` (e.g. empty name).
        :raises AcruxCoreError: ``API_ERROR`` 403 if the caller's role cannot create
            prompts (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        body: Dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description
        response = await self._client._request("POST", "/prompts", body, "creating prompt")
        return PromptDetail.from_dict(
            self._client._parse_json_or_throw(response, "creating prompt")
        )

    async def update(
        self,
        prompt_id: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = _UNSET,
    ) -> PromptDetail:
        """Updates a prompt's ``name`` and/or ``description``. Does not touch its
        versions — versions are immutable and unaffected by renaming the prompt
        they belong to.

        ``description`` defaults to the private sentinel :data:`_UNSET`, not
        ``None``: the wire schema distinguishes omitting the key (leave the
        stored description untouched), sending an explicit JSON ``null``
        (clear it), and sending a string (set it) — three states a plain
        ``None`` default cannot express. Leave ``description`` unset to leave
        it untouched; pass ``description=None`` explicitly to clear it; pass a
        string to set it.

        :param prompt_id: The prompt's id.
        :param name: New name. Omit to leave unchanged.
        :param description: New description, or ``None`` to clear the existing
            one. Omit this keyword argument entirely to leave it untouched.
        :returns: The updated prompt.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt, or ``VALIDATION_ERROR``
            if neither ``name`` nor ``description`` is set.
        :raises AcruxCoreError: ``API_ERROR`` 403 if the caller's role cannot update
            prompts (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if description is not _UNSET:
            body["description"] = description
        response = await self._client._request(
            "PATCH", f"/prompts/{quote(prompt_id, safe='')}", body, "updating prompt"
        )
        return PromptDetail.from_dict(
            self._client._parse_json_or_throw(response, "updating prompt")
        )

    async def delete(self, prompt_id: str) -> None:
        """Deletes a prompt and every version/alias under it.

        The endpoint replies ``204 No Content`` on success, which has no body —
        calling ``_parse_json_or_throw`` unconditionally would throw trying to
        parse it, so the success path returns directly and a response is only
        parsed on the error branch (to get the typed error thrown).

        :param prompt_id: The prompt's id.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 if the prompt doesn't exist.
        :raises AcruxCoreError: ``API_ERROR`` 403 if the caller's role cannot delete
            prompts (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "DELETE", f"/prompts/{quote(prompt_id, safe='')}", None, "deleting prompt"
        )
        if response.status_code >= 400:
            self._client._parse_json_or_throw(response, "deleting prompt")

    async def commit_version(
        self,
        prompt_id: str,
        messages: List[PromptMessage],
        *,
        model: Optional[str] = None,
    ) -> VersionDetail:
        """Commits a new immutable version for a prompt.

        A version decides the template only — it says nothing about tools. Which
        tools the prompt calls is decided per prompt alias by
        :meth:`set_tool_binding` and :meth:`set_alias_tool_binding`, so
        committing never changes a tool set.

        :param prompt_id: The prompt's id.
        :param messages: The version's full message list — versions are
            immutable, so this replaces, never patches, the previous version's
            messages. Each item is ``{"role": "system"|"user"|"assistant",
            "content": str}`` — a template-eligible role only, matching the
            API's ``MessageSchema`` (unlike the gateway's chat ``Message``,
            this never accepts ``"tool"``, ``None`` content, or ``tool_calls``).
        :param model: Binds a default gateway model by its ``publicName``; omit
            to leave the version unbound.
        :returns: The created version. ``aliases`` is present ONLY when this is
            the prompt's first version — both ``production`` and ``staging`` are
            minted and point at it; every later commit returns ``aliases=None``.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt, or ``VALIDATION_ERROR``
            (e.g. empty ``messages``).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        body: Dict[str, Any] = {"messages": messages}
        if model is not None:
            body["model"] = model
        response = await self._client._request(
            "POST",
            f"/prompts/{quote(prompt_id, safe='')}/versions",
            body,
            "committing prompt version",
        )
        return VersionDetail.from_dict(
            self._client._parse_json_or_throw(response, "committing prompt version")
        )

    async def list_versions(
        self,
        prompt_id: str,
        *,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> VersionListResult:
        """Lists a prompt's versions, newest first. List items omit ``messages``/
        ``prompt_id`` to keep pages small — use :meth:`get_version` for full content.

        :param prompt_id: The prompt's id.
        :param page: 1-based page number.
        :param limit: Page size.
        :returns: One page of versions.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        params: Dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)

        qs = urlencode(params)
        path = f"/prompts/{quote(prompt_id, safe='')}/versions"
        if qs:
            path += f"?{qs}"
        response = await self._client._request("GET", path, None, "listing prompt versions")
        return VersionListResult.from_dict(
            self._client._parse_json_or_throw(response, "listing prompt versions")
        )

    async def get_version(self, prompt_id: str, version_number: int) -> VersionDetail:
        """Fetches one version with its full message content. Unlike
        :meth:`commit_version`'s response, this never includes ``aliases`` —
        only the commit response ever has it.

        :param prompt_id: The prompt's id.
        :param version_number: The version's sequential number (1-based, immutable).
        :returns: The version.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt or version number.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "GET",
            f"/prompts/{quote(prompt_id, safe='')}/versions/{quote(str(version_number), safe='')}",
            None,
            "fetching prompt version",
        )
        return VersionDetail.from_dict(
            self._client._parse_json_or_throw(response, "fetching prompt version")
        )

    async def diff(self, prompt_id: str, from_version: int, to_version: int) -> DiffResult:
        """Computes a unified diff between two versions' message content.

        :param prompt_id: The prompt's id.
        :param from_version: The earlier version's number.
        :param to_version: The later version's number. ``from_version ==
            to_version`` is a valid no-op request — it returns an empty diff,
            not an error.
        :returns: The unified diff string plus the two version numbers it covers.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt, or if either
            version number doesn't exist.
        :raises AcruxCoreError: ``API_ERROR`` ``VALIDATION_ERROR`` if ``from``/``to``
            is missing or not an integer.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        qs = urlencode({"from": str(from_version), "to": str(to_version)})
        response = await self._client._request(
            "GET",
            f"/prompts/{quote(prompt_id, safe='')}/versions/diff?{qs}",
            None,
            "diffing prompt versions",
        )
        return DiffResult.from_dict(
            self._client._parse_json_or_throw(response, "diffing prompt versions")
        )

    async def promote_alias(
        self, prompt_id: str, alias: str, version_number: int
    ) -> AliasDetail:
        """Promotes an alias to point at a specific version — e.g. rolling
        ``production`` forward (or back) to a version already committed.
        Creates the alias if it does not exist yet.

        :param prompt_id: The prompt's id.
        :param alias: The alias name (e.g. ``'production'``, ``'staging'``, or a
            custom one).
        :param version_number: The version to point the alias at.
        :returns: The alias's new state.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt/version, or 403
            if the caller's role cannot promote (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "POST",
            f"/prompts/{quote(prompt_id, safe='')}/aliases/{quote(alias, safe='')}/promote",
            {"version_number": version_number},
            "promoting prompt alias",
        )
        return AliasDetail.from_dict(
            self._client._parse_json_or_throw(response, "promoting prompt alias")
        )

    async def export_version(
        self, prompt_id: str, version_number: int
    ) -> ExportedPromptVersion:
        """Exports one version as a portable JSON document, suitable for
        :meth:`import_prompt` (e.g. to copy a prompt into another team or
        environment).

        :param prompt_id: The prompt's id.
        :param version_number: The version to export.
        :returns: The export document (``schema_version`` is always ``1``). Call
            :meth:`~acruxcore.types.ExportedPromptVersion.to_import_body` on it
            to get the ``Dict[str, Any]`` :meth:`import_prompt` expects.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt or version number.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "GET",
            f"/prompts/{quote(prompt_id, safe='')}/versions/{quote(str(version_number), safe='')}/export",
            None,
            "exporting prompt version",
        )
        return ExportedPromptVersion.from_dict(
            self._client._parse_json_or_throw(response, "exporting prompt version")
        )

    async def import_prompt(self, export_file: Dict[str, Any]) -> ImportPromptResult:
        """Imports an exported version as a brand-new prompt (version 1) with
        fresh ``production``/``staging`` aliases. Never overwrites an existing
        prompt.

        ``export_file`` is a plain dict in the API's wire shape — matching
        ``ImportBodySchema`` in ``apps/api/src/prompts/import/import.types.ts`` —
        not the :class:`~acruxcore.types.ExportedPromptVersion` dataclass
        :meth:`export_version` returns. This SDK's dataclasses use snake_case
        attributes (this codebase's convention), so a plain
        ``dataclasses.asdict()`` on an ``ExportedPromptVersion`` would produce
        the wrong (snake_case) top-level keys; call its
        ``.to_import_body()`` method instead to get a dict shaped correctly for
        this method, or build one by hand. Required keys: ``schemaVersion``
        (must be ``1``), ``prompt.name`` (non-empty string),
        ``version.messages`` (non-empty list of ``{"role": str, "content":
        str}``). Optional: ``exportedAt``, ``prompt.description``,
        ``version.versionNumber``, ``version.variables``, ``version.createdAt``.

        :param export_file: The import body — see above for required/optional keys.
        :returns: The created prompt + version. ``prompt.name`` may differ from
            ``export_file["prompt"]["name"]`` on a name collision — the server
            appends ``-imported-<unix_ms>`` rather than rejecting the import.
        :raises AcruxCoreError: ``API_ERROR`` with code ``UNSUPPORTED_SCHEMA_VERSION``
            if ``schemaVersion != 1``, or ``VALIDATION_ERROR`` (e.g. empty
            ``version.messages``).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "POST", "/prompts/import", export_file, "importing prompt"
        )
        return ImportPromptResult.from_dict(
            self._client._parse_json_or_throw(response, "importing prompt")
        )

    async def traces_for_version(
        self,
        prompt_id: str,
        version_number: int,
        *,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> ListTracesResult:
        """Lists traces whose reported ``promptVersionId`` matches this version
        — the reverse lookup from a prompt version to what actually ran
        against it. Reuses the platform's existing traces envelope: the
        response is byte-identical to ``GET /traces``, so this returns the
        SDK's existing :class:`~acruxcore.types.ListTracesResult` rather than a
        duplicate type.

        :param prompt_id: The prompt's id.
        :param version_number: The version to look up traces for.
        :param page: 1-based page number.
        :param limit: Page size.
        :returns: One page of trace summaries; ``data=[]``, ``total=0`` when the
            version has never been called.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt or version number.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        params: Dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)

        qs = urlencode(params)
        path = (
            f"/prompts/{quote(prompt_id, safe='')}/versions/"
            f"{quote(str(version_number), safe='')}/traces"
        )
        if qs:
            path += f"?{qs}"
        response = await self._client._request(
            "GET", path, None, "listing traces for prompt version"
        )
        return ListTracesResult.from_dict(
            self._client._parse_json_or_throw(response, "listing traces for prompt version")
        )

    # ── tool bindings ─────────────────────────────────────────────────────

    async def list_tool_bindings(self, prompt_id: str) -> PromptToolBindings:
        """Reads every tool binding for a prompt: the default that aliases
        inherit, plus one entry per prompt alias with the rows that alias owns.

        An alias with ``customised=False`` has no rows of its own and calls
        exactly the ``default`` list — its own ``bindings`` list is empty rather
        than a copy of it.

        :param prompt_id: The prompt's id.
        :returns: The default bindings and every prompt alias.
        :raises AcruxCoreError: ``API_ERROR`` with ``status_code`` 404 if the
            prompt doesn't exist.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "GET",
            f"/prompts/{quote(prompt_id, safe='')}/tools",
            None,
            "listing prompt tool bindings",
        )
        body = self._client._parse_json_or_throw(response, "listing prompt tool bindings")
        return PromptToolBindings.from_dict(body.get("data") or {})

    async def set_tool_binding(
        self,
        prompt_id: str,
        tool_id: str,
        *,
        tool_alias: Optional[str] = None,
        pinned_version_number: Optional[int] = None,
        off: bool = False,
    ) -> ToolBindingDetail:
        """Connects a tool to the prompt as its **default** binding — the one
        every prompt alias uses unless it has a row of its own. Idempotent:
        calling it again for the same tool replaces the target rather than
        adding a second binding.

        :param prompt_id: The prompt's id.
        :param tool_id: The catalog tool's id, from ``tools.resolve`` or the dashboard.
        :param tool_alias: Tool alias to resolve when the prompt runs, e.g.
            ``"production"``. Mutually exclusive with ``pinned_version_number``.
        :param pinned_version_number: Pin an exact tool version instead of
            following one of the tool's aliases.
        :param off: Always rejected here — accepted only so the error can name
            what to use instead. "Off" contradicts a default, and a default has
            no default of its own; use :meth:`remove_tool_binding` to stop every
            alias calling the tool, or :meth:`set_alias_tool_binding` to switch
            it off for one alias.
        :returns: The stored binding, including the tool version it resolves to today.
        :raises AcruxCoreError: ``VALIDATION_ERROR`` if neither or both of
            ``tool_alias``/``pinned_version_number`` is given, or if ``off`` is
            set (rejected locally, before any request).
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt, tool, tool alias
            or pinned version, or 403 if the caller's role cannot bind tools
            (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        body = _binding_body(tool_alias, pinned_version_number, off, allow_off=False)
        response = await self._client._request(
            "PUT",
            f"/prompts/{quote(prompt_id, safe='')}/tools/{quote(tool_id, safe='')}",
            body,
            "setting prompt tool binding",
        )
        return ToolBindingDetail.from_dict(
            self._client._parse_json_or_throw(response, "setting prompt tool binding")
        )

    async def remove_tool_binding(self, prompt_id: str, tool_id: str) -> None:
        """Disconnects a tool from the prompt's default binding, so no alias
        inheriting the default calls it any more. Per-alias rows for the same
        tool are left alone — an alias that set its own binding keeps calling
        the tool.

        The endpoint replies ``204 No Content``, which has no body, so a
        response is only parsed on the error branch (to get the typed error
        thrown).

        :param prompt_id: The prompt's id.
        :param tool_id: The catalog tool's id.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt, or if the prompt
            has no default binding for that tool; 403 if the caller's role cannot
            bind tools.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "DELETE",
            f"/prompts/{quote(prompt_id, safe='')}/tools/{quote(tool_id, safe='')}",
            None,
            "removing prompt tool binding",
        )
        if response.status_code >= 400:
            self._client._parse_json_or_throw(response, "removing prompt tool binding")

    async def set_alias_tool_binding(
        self,
        prompt_id: str,
        alias: str,
        tool_id: str,
        *,
        tool_alias: Optional[str] = None,
        pinned_version_number: Optional[int] = None,
        off: bool = False,
    ) -> ToolBindingDetail:
        """Connects a tool for **one prompt alias only**, overriding whatever the
        default says for that alias. This is how a tool gets rolled out
        (``dev`` gets it first) or runs a different build per environment
        (``dev`` on the tool's ``staging`` alias).

        :param prompt_id: The prompt's id.
        :param alias: The prompt alias this binding applies to, e.g. ``"staging"``.
        :param tool_id: The catalog tool's id.
        :param tool_alias: Tool alias to resolve for this prompt alias.
        :param pinned_version_number: Pin an exact tool version for this prompt alias.
        :param off: ``True`` means this alias deliberately has no such tool, even
            though the default does. Mutually exclusive with the other two.
        :returns: The stored binding for this alias.
        :raises AcruxCoreError: ``VALIDATION_ERROR`` unless exactly one of
            ``tool_alias``/``pinned_version_number``/``off`` is given (rejected
            locally, before any request).
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt, alias, tool, tool
            alias or pinned version, or 403 if the caller's role cannot bind tools.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        body = _binding_body(tool_alias, pinned_version_number, off, allow_off=True)
        response = await self._client._request(
            "PUT",
            f"/prompts/{quote(prompt_id, safe='')}/aliases/{quote(alias, safe='')}"
            f"/tools/{quote(tool_id, safe='')}",
            body,
            "setting prompt alias tool binding",
        )
        return ToolBindingDetail.from_dict(
            self._client._parse_json_or_throw(response, "setting prompt alias tool binding")
        )

    async def remove_alias_tool_binding(
        self, prompt_id: str, alias: str, tool_id: str
    ) -> None:
        """Drops one alias's own binding for a tool, returning that (alias, tool)
        pair to the prompt's default. It does NOT stop the alias calling the tool
        — if the default binds it, the alias inherits it again. Use
        ``set_alias_tool_binding(..., off=True)`` for that.

        :param prompt_id: The prompt's id.
        :param alias: The prompt alias to return to the default.
        :param tool_id: The catalog tool's id.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt, or if that alias
            has no row of its own for the tool; 403 if the caller's role cannot
            bind tools.
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "DELETE",
            f"/prompts/{quote(prompt_id, safe='')}/aliases/{quote(alias, safe='')}"
            f"/tools/{quote(tool_id, safe='')}",
            None,
            "removing prompt alias tool binding",
        )
        if response.status_code >= 400:
            self._client._parse_json_or_throw(response, "removing prompt alias tool binding")

    async def reset_alias_tool_bindings(self, prompt_id: str, alias: str) -> None:
        """Drops every binding one prompt alias owns in a single call, returning
        it wholesale to the prompt's default. Succeeds even when the alias
        already had no rows of its own — it is a reset, not a delete of a
        specific row.

        :param prompt_id: The prompt's id.
        :param alias: The prompt alias to reset.
        :raises AcruxCoreError: ``API_ERROR`` 404 unknown prompt, or 403 if the
            caller's role cannot bind tools (editor and above only).
        :raises AcruxCoreError: ``NETWORK_ERROR`` if the API is unreachable after retries.
        """
        response = await self._client._request(
            "DELETE",
            f"/prompts/{quote(prompt_id, safe='')}/aliases/{quote(alias, safe='')}/tools",
            None,
            "resetting prompt alias tool bindings",
        )
        if response.status_code >= 400:
            self._client._parse_json_or_throw(response, "resetting prompt alias tool bindings")

    # ── render (SWR cache) ────────────────────────────────────────────────

    async def render(
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
            the alias binds none, and ``model`` is the version's bound default
            model (or ``None``).
        :raises AcruxCoreError: ``MISSING_VARIABLES`` if required variables are
            absent; ``API_ERROR`` for other HTTP errors; ``NETWORK_ERROR`` if the
            API is unreachable and no stale entry exists.
        """
        variables = variables or {}

        if self._cache_ttl <= 0:
            return await self._fetch_and_cache(name, alias, variables, None)

        cache = get_cache(self._max_cache_size)
        cache_key = (
            f"{self._client._api_key_fingerprint()}:{name}:{alias}:{_hash_variables(variables)}"
        )
        now = time.time() * 1000

        cached = cache.get(cache_key)
        if cached is not None:
            age = now - cached.fetched_at
            if age < self._cache_ttl:
                return cached.value
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
            return

        def _done(t: "asyncio.Task[Any]") -> None:
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
            response = await self._client._request(
                "POST", path, {"variables": variables}, f'fetching "{name}/{alias}"'
            )
        except Exception as err:
            raise AcruxCoreError(
                f'acruxcore: network error fetching "{name}/{alias}" — {err}',
                NETWORK_ERROR,
            )

        if response.status_code >= 400:
            try:
                body = response.json()
            except (ValueError, json.JSONDecodeError):
                body = None
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
            tool_resolutions=[
                ToolResolution(
                    name=r["name"],
                    alias=r.get("alias"),
                    pinned_version_number=r.get("pinnedVersionNumber"),
                    version_number=r["versionNumber"],
                    source=r.get("source", "default"),
                )
                for r in (data.get("toolResolutions") or [])
            ],
            model=data.get("model"),
            version_id=data.get("versionId"),
            version_number=data.get("versionNumber"),
        )
        if cache_key is not None:
            get_cache(self._max_cache_size).set(
                cache_key, CacheEntry(value=value, fetched_at=time.time() * 1000)
            )
        return value
