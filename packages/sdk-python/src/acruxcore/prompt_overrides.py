"""Prompt overrides: run your app on a prompt version that no alias points at yet.

An app asks for a prompt by name and alias (``render("support-agent", "production",
...)``). To test a candidate version in the whole app — retrieval, tools and all —
before moving ``production`` to it, the app's code must not change. So an override is
held in a :class:`contextvars.ContextVar`: inside :func:`pin_prompts` (and inside every
task a local experiment runs with ``prompt_overrides=``), ``prompts.render`` and
``prompts.get_by_alias`` return the pinned version for that prompt name, whatever alias
the code asked for. The alias still decides the tools, so only the template changes.

A context variable, not a global, so a baseline run and a candidate run can share one
client and one event loop at the same time (``experiments.compare_local``) without
seeing each other's pins. ``asyncio`` tasks and ``asyncio.to_thread`` copy the
context, so a pin reaches code the task starts; a thread you start yourself with
``threading.Thread`` does not get it.
"""

from __future__ import annotations

import contextlib
from contextvars import ContextVar
from typing import Dict, Iterator, Mapping, Optional

_PINNED: ContextVar[Optional[Dict[str, int]]] = ContextVar("acruxcore_prompt_overrides", default=None)


def validate_overrides(overrides: Optional[Mapping[str, int]]) -> Dict[str, int]:
    """A checked copy of ``{prompt_name: version_number}``, so a typo fails before a
    local run is created rather than on its first render.

    :param overrides: ``{prompt_name: version_number}``; ``None`` means no pins.
    :returns: A new dict holding the same pins.
    :raises ValueError: A name is empty, or a version is not a positive integer.
    """
    checked: Dict[str, int] = {}
    for name, version in (overrides or {}).items():
        if not isinstance(name, str) or not name:
            raise ValueError("acruxcore: prompt_overrides keys must be prompt names.")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise ValueError(
                f"acruxcore: prompt_overrides[{name!r}] is {version!r}; it must be a version "
                "number such as 7."
            )
        checked[name] = version
    return checked


@contextlib.contextmanager
def pin_prompts(overrides: Mapping[str, int]) -> Iterator[None]:
    """Pin prompt versions by name for the code inside the ``with`` block.

    ::

        with pin_prompts({"support-agent": 7}):
            answer = await my_app(question)   # every render of support-agent uses v7

    Pins nest: an inner block adds to, and may replace, the outer block's pins.

    :param overrides: ``{prompt_name: version_number}``.
    :raises ValueError: A version is not a positive integer.
    """
    merged = {**(_PINNED.get() or {}), **validate_overrides(overrides)}
    token = _PINNED.set(merged)
    try:
        yield
    finally:
        _PINNED.reset(token)


def pinned_version(prompt_name: str) -> Optional[int]:
    """The version pinned for ``prompt_name`` in the current context.

    ``prompts.render`` and ``prompts.get_by_alias`` apply pins on their own. Read
    this when the app renders a prompt some other way — for example a gateway
    request with a ``prompt`` reference, which the gateway renders on the server,
    where no pin can reach it. Add ``version`` only when a pin exists, because
    the gateway rejects ``"version": null``::

        ref = {"name": "support-agent", "alias": "production", "variables": variables}
        if (version := pinned_version("support-agent")) is not None:
            ref["version"] = version

    :param prompt_name: The prompt's exact name, as the pin names it.
    :returns: The pinned version number, or ``None`` when nothing pins it.
    """
    pins = _PINNED.get()
    return pins.get(prompt_name) if pins else None
