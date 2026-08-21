#!/usr/bin/env python3
"""Fail if a docs code fence calls an SDK method that does not exist.

Why this exists: four tutorials shipped Python tabs calling
``hub.prompts.commitVersion()``. The Python SDK only has ``commit_version``, so
every reader who copied one of those blocks got an ``AttributeError``. Two other
tabs called ``hub.gateway.createConnection()`` / ``createModel()``, which exist
in neither SDK — those were invented outright. Both classes of mistake are
invisible to the Docusaurus build, which never executes a fence (issue #327).

What it checks: every ``hub.<...>(`` call inside a fenced code block on the docs
site, resolved against the method names actually defined in the matching SDK
source — snake_case names from ``packages/sdk-python``, camelCase from
``packages/sdk``. A ``python`` fence is checked against the Python SDK and a
``typescript``/``js`` fence against the Node one, which is what catches a Node
name pasted into a Python tab.

Two limits worth knowing before trusting a green run:

- It is a name-existence check, not a signature check. It would not have caught
  the other half of #327 — Node's single-object argument style pasted into
  Python, where the name was fine and the shape was wrong. Running the snippet is
  still the only way to catch that.
- Only calls on a receiver named `hub` are matched (see CALL below). Every docs
  page and both SDK READMEs use that name, so coverage is real rather than
  vacuous — 74 calls across the two READMEs alone. The `acrux.tool` decorator is
  not covered, being a decorator rather than a client method.

Usage:
    python3 scripts/check-doc-sdk-methods.py

Exits 0 when every call resolves, 1 with a report otherwise.
"""

from __future__ import annotations

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

#: Fence languages we check, and which SDK's surface each resolves against.
PYTHON_LANGS = {"python"}
NODE_LANGS = {"typescript", "javascript", "js", "ts"}

FENCE = re.compile(r"^```(\w+)\s*$")

#: Only `hub.` is matched. Every docs page and both SDK READMEs name the client
#: `hub`, and a looser receiver is worse than useless here: matching `client.`
#: too flagged `client.request(...)` on an `httpx.AsyncClient` in a REST snippet,
#: which is not our SDK at all. A false positive in a CI gate gets the gate
#: deleted, so the receiver stays narrow.
CALL = re.compile(r"\bhub\.([A-Za-z_][\w.]*?)\s*\(")

#: Everything scanned. `docs/api` is included because it is published as
#: /api-reference from the same source, and a wrong name there reached
#: production once (`datasets.createFromFeedback`, which never existed).
SCAN_DIRS = [
    "apps/docs/docs",
    "docs/api",
]
SCAN_FILES = [
    "packages/sdk/README.md",
    "packages/sdk-python/README.md",
]


def python_sdk_methods() -> set[str]:
    """Every ``def`` name in the Python SDK's source."""
    src = " ".join(
        p.read_text() for p in (REPO / "packages/sdk-python/src/acruxcore").glob("*.py")
    )
    return set(re.findall(r"def ([a-z_][\w]*)\(", src))


def node_sdk_methods() -> set[str]:
    """Every class method and top-level function name in the Node SDK's source.

    Two-space indentation is what identifies a class member here — good enough
    for a name-existence check, and it needs no TypeScript parser.
    """
    src = " ".join(p.read_text() for p in (REPO / "packages/sdk/src").rglob("*.ts"))
    names = set(re.findall(r"^\s{2}(?:async\s+)?([a-zA-Z_][\w]*)\s*[(<]", src, re.M))
    names |= set(re.findall(r"(?:function|const)\s+([a-zA-Z_][\w]*)", src))
    return names


def main() -> int:
    surfaces = {}
    for lang in PYTHON_LANGS:
        surfaces[lang] = ("Python", python_sdk_methods())
    node = node_sdk_methods()
    for lang in NODE_LANGS:
        surfaces[lang] = ("Node", node)

    docs: list[pathlib.Path] = []
    for d in SCAN_DIRS:
        docs += sorted((REPO / d).rglob("*.mdx"))
        docs += sorted((REPO / d).rglob("*.md"))
    docs += [REPO / f for f in SCAN_FILES if (REPO / f).exists()]

    failures: list[str] = []
    for path in docs:
        lang = None
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            fence = FENCE.match(line.strip())
            if fence:
                lang = fence.group(1)
                continue
            if line.strip() == "```":
                lang = None
                continue
            if lang not in surfaces:
                continue
            sdk_name, known = surfaces[lang]
            for call in CALL.finditer(line):
                chain = call.group(1)
                method = chain.split(".")[-1]
                if method not in known:
                    rel = path.relative_to(REPO)
                    failures.append(
                        f"{rel}:{lineno}: hub.{chain}() is not a {sdk_name} SDK method "
                        f"(fence language: {lang})"
                    )

    if failures:
        print(f"{len(failures)} unknown SDK method call(s) in docs code fences:\n")
        for f in failures:
            print(f"  {f}")
        print(
            "\nFix the call to match the SDK source, or the fence language if the "
            "snippet is in the wrong tab."
        )
        return 1

    print(f"OK — every hub.* call in {len(docs)} docs pages resolves to a real SDK method.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
