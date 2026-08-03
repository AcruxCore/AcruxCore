"""Best-effort display label for a BYO (bring-your-own-key) provider."""

from __future__ import annotations

from urllib.parse import urlparse


def infer_provider_name(base_url: str) -> str:
    """Return a BYO base URL's hostname, unmodified — a best-effort display
    label for the span's ``provider`` field, so gateway and BYO traces can be
    filtered/grouped the same way in the dashboard. Not a validated enum.

    :param base_url: The BYO provider's base URL.
    :returns: The base URL's hostname, unmodified.
    """
    return urlparse(base_url).hostname or base_url
