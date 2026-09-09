"""Prints the span-type vocabulary each observability SDK actually accepts.

This backs the one claim in the comparison that a reader is most likely to
doubt, and that documentation pages get wrong most often: how many distinct
span (or observation, or run) types each platform lets you tag a step with.

Every value is read out of the installed package, not from a docs page — so
this reports whatever versions you have, and a count that disagrees with the
article is information rather than an error. Versions are printed alongside.

A platform whose SDK isn't installed is reported as missing and skipped; it is
never guessed at.

Run:
  python scripts/others/rag-agent-observability-comparison/python/span_type_survey.py

Needs: whichever of these you want surveyed —
  pip install mlflow openinference-semantic-conventions langfuse acruxcore opik
"""

from __future__ import annotations

import importlib.metadata
import typing


def _version(dist: str) -> str:
    """Installed version of a distribution, or '?' when it can't be determined."""
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return "?"


def _flatten_literal(annotation: object) -> list[str]:
    """Collect every string in a Literal, including Literals nested inside unions.

    Langfuse composes its observation type from several Literals, so
    ``typing.get_args`` alone returns inner aliases rather than the strings.
    """
    found: list[str] = []
    for arg in typing.get_args(annotation):
        if isinstance(arg, str):
            found.append(arg)
        else:
            found.extend(_flatten_literal(arg))
    return found


def mlflow_types() -> list[str]:
    """MLflow exposes its vocabulary as string constants on one class."""
    from mlflow.entities import SpanType

    return [v for k, v in vars(SpanType).items() if not k.startswith("_") and isinstance(v, str)]


def phoenix_types() -> list[str]:
    """Phoenix's kinds arrive via the OpenInference convention, not a Phoenix API."""
    from openinference.semconv.trace import OpenInferenceSpanKindValues

    return [e.value for e in OpenInferenceSpanKindValues]


def langfuse_types() -> list[str]:
    """Langfuse's `as_type` accepts a composed Literal, so it needs flattening."""
    from langfuse._client.span import ObservationTypeLiteral

    return sorted(set(_flatten_literal(ObservationTypeLiteral)))


def acruxcore_types() -> list[str]:
    """AcruxCore's SpanKind is a plain Literal in the SDK's type module."""
    from acruxcore.types import SpanKind

    return list(typing.get_args(SpanKind))


def opik_types() -> list[str]:
    """Opik's SpanType is a Literal alias."""
    from opik.types import SpanType

    return list(typing.get_args(SpanType))


#: label, distribution name for the version, and the reader.
SURVEY = [
    ("MLflow", "mlflow", "mlflow.entities.SpanType", mlflow_types),
    ("Phoenix", "openinference-semantic-conventions", "OpenInferenceSpanKindValues", phoenix_types),
    ("Langfuse", "langfuse", "ObservationTypeLiteral", langfuse_types),
    ("AcruxCore", "acruxcore", "acruxcore.types.SpanKind", acruxcore_types),
    ("Opik", "opik", "opik.types.SpanType", opik_types),
]


def main() -> None:
    rows: list[tuple[str, int, str, str, list[str]]] = []
    missing: list[tuple[str, str]] = []

    for label, dist, where, reader in SURVEY:
        try:
            values = reader()
        except Exception as exc:  # noqa: BLE001 - a missing SDK is reported, not guessed
            missing.append((label, f"{type(exc).__name__}: {exc}"))
            continue
        rows.append((label, len(values), _version(dist), where, sorted(values)))

    rows.sort(key=lambda r: r[1], reverse=True)

    print(f"{'Platform':<12}{'Types':>6}  {'Version':<12}Source")
    print("-" * 74)
    for label, count, version, where, _ in rows:
        print(f"{label:<12}{count:>6}  {version:<12}{where}")

    print()
    for label, _, _, _, values in rows:
        print(f"{label}: {', '.join(values)}")

    if missing:
        print("\nNot installed, so not surveyed:")
        for label, why in missing:
            print(f"  {label} — {why}")

    print(
        "\nHelicone has no entry: it captures LLM calls through a request-path proxy "
        "and ships no concept of a non-LLM span."
    )


if __name__ == "__main__":
    main()
