"""BYO (bring-your-own-key) provider helpers: the span's display label, the config
check every BYO call runs first, and the name ``max_tokens`` is sent under."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Dict, Optional
from urllib.parse import urlparse

from .errors import MISSING_API_KEY, MISSING_BASE_URL, VALIDATION_ERROR, AcruxCoreError

if TYPE_CHECKING:
    from .types import ProviderConfig

#: The values ``provider["kind"]`` may take. ``ProviderKind`` is a ``Literal``, which
#: Python does not check at runtime, so :func:`check_provider_config` checks it here.
_PROVIDER_KINDS = ("openai", "openai_compatible")


def infer_provider_name(base_url: str) -> str:
    """Return a BYO base URL's hostname, unmodified — a best-effort display
    label for the span's ``provider`` field, so gateway and BYO traces can be
    filtered/grouped the same way in the dashboard. Not a validated enum.

    Display only. The wire format never reads it: :func:`byo_max_tokens_field` parses
    the host itself, so a change to this label cannot change what is sent.

    :param base_url: The BYO provider's base URL.
    :returns: The base URL's hostname, or the raw string when it has none.
    """
    return urlparse(base_url).hostname or base_url


def check_provider_config(provider: ProviderConfig) -> None:
    """Refuse a BYO provider config that cannot be sent, before anything is sent.

    :param provider: The BYO provider for this call.
    :raises AcruxCoreError: ``MISSING_API_KEY`` or ``MISSING_BASE_URL`` when either is
        empty. ``VALIDATION_ERROR`` when ``base_url`` does not parse as an http(s) URL
        with a host, or when ``kind`` is set to anything but ``"openai"`` or
        ``"openai_compatible"``. A near-miss ``kind`` such as ``"OpenAI"`` is refused
        rather than ignored, since ignoring it would silently send the wrong field name.
    """
    if not provider.get("api_key"):
        raise AcruxCoreError(
            "acruxcore: provider api_key is required for a BYO (direct-provider) call.",
            MISSING_API_KEY,
        )
    base_url = provider.get("base_url")
    if not base_url:
        raise AcruxCoreError(
            "acruxcore: provider base_url is required for a BYO (direct-provider) call.",
            MISSING_BASE_URL,
        )
    if _parse_host(base_url) is None:
        raise AcruxCoreError(
            f'acruxcore: provider.base_url "{base_url}" is not a valid http(s) URL.',
            VALIDATION_ERROR,
        )
    if "kind" in provider and provider["kind"] not in _PROVIDER_KINDS:
        raise AcruxCoreError(
            f"acruxcore: provider['kind'] is {provider['kind']!r}; it must be "
            f"'openai' or 'openai_compatible', or left out.",
            VALIDATION_ERROR,
        )


def byo_max_tokens_field(provider: ProviderConfig) -> str:
    """The body field a BYO call uses for the caller's ``max_tokens``.

    OpenAI renamed ``max_tokens`` to ``max_completion_tokens``, and its reasoning models
    (gpt-5, the o-series) refuse the old name with a 400. Every OpenAI model accepts the
    new name. Many OpenAI-compatible servers know only the old name. This is the same
    split the gateway's OpenAI adapter makes between ``openai`` and ``openai_compatible``.
    A gateway call never asks: it always sends ``max_tokens``, which the gateway maps
    per provider.

    ``provider["kind"]`` decides when it is set, which covers Azure OpenAI and proxies
    in front of OpenAI. When it is not set, the host decides: OpenAI's own hosts get
    the new name. A base URL with no parseable host gets ``max_tokens``;
    :func:`check_provider_config` refuses it before the request is sent.

    :param provider: The BYO provider for this call.
    :returns: ``"max_completion_tokens"`` or ``"max_tokens"``.
    """
    kind = provider.get("kind")
    if kind:
        return "max_completion_tokens" if kind == "openai" else "max_tokens"
    host = _parse_host(provider.get("base_url") or "")
    return "max_completion_tokens" if host is not None and _is_openai_host(host) else "max_tokens"


def max_tokens_refusal_hint(sent: Dict[str, Any], error_body: Any) -> str:
    """A hint to add to a BYO provider's error when it refused ``max_tokens`` and asked
    for ``max_completion_tokens``: the case of a proxy or Azure in front of OpenAI that
    the host check cannot recognise.

    :param sent: The body the SDK sent.
    :param error_body: The provider's parsed error body, or ``None``.
    :returns: The hint, starting with ``" — "``, or ``""`` when it does not apply.
    """
    if "max_tokens" not in sent or error_body is None:
        return ""
    if "max_completion_tokens" not in json.dumps(error_body, default=str):
        return ""
    return (
        " — this provider wants max_completion_tokens; set provider['kind'] to 'openai' "
        "to send max_tokens= under that name."
    )


def _parse_host(url: str) -> Optional[str]:
    """The hostname of an http(s) URL, or ``None`` when there is none. A schemeless
    string such as ``api.openai.com`` has no host here, matching the TypeScript SDK."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not host:
        return None
    return host


def _is_openai_host(hostname: str) -> bool:
    """True for OpenAI's own API hosts: ``api.openai.com``, or a data-residency host
    under it such as ``eu.api.openai.com``. Case and a trailing dot are ignored."""
    host = hostname.lower().rstrip(".")
    return host == "api.openai.com" or host.endswith(".api.openai.com")
