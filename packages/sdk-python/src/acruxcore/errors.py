"""Error type raised by every AcruxCore SDK operation."""

from __future__ import annotations

from typing import Any, Optional

# Machine-readable error codes. Mirrors the TypeScript SDK's ``acruxcoreErrorCode``.
ErrorCode = str
MISSING_API_KEY: ErrorCode = "MISSING_API_KEY"
MISSING_BASE_URL: ErrorCode = "MISSING_BASE_URL"
NETWORK_ERROR: ErrorCode = "NETWORK_ERROR"
API_ERROR: ErrorCode = "API_ERROR"
MISSING_VARIABLES: ErrorCode = "MISSING_VARIABLES"
#: A decorated function's type hints could not be converted to a JSON Schema.
TOOL_SCHEMA_ERROR: ErrorCode = "TOOL_SCHEMA_ERROR"
#: A tool call needs a ``dispatch`` function and none was supplied.
MISSING_DISPATCH: ErrorCode = "MISSING_DISPATCH"
#: BYO: a non-2xx response from the caller's own provider endpoint.
PROVIDER_ERROR: ErrorCode = "PROVIDER_ERROR"
#: A pydantic model was passed as ``response_format`` but pydantic is not installed.
PYDANTIC_NOT_AVAILABLE: ErrorCode = "PYDANTIC_NOT_AVAILABLE"


class AcruxCoreError(Exception):
    """Raised by every AcruxCore SDK operation.

    Always branch on :attr:`code` for programmatic handling. For
    ``MISSING_VARIABLES`` errors, ``error.body["error"]["missing"]`` holds the
    array of absent template-variable names.

    :param message: Human-readable description.
    :param code: Machine-readable code — one of ``MISSING_API_KEY``,
        ``MISSING_BASE_URL``, ``NETWORK_ERROR``, ``API_ERROR``,
        ``MISSING_VARIABLES``.
    :param status_code: HTTP status code, when the error came from an HTTP call.
        ``None`` for the constructor and network errors.
    :param body: Parsed API response body, when available.
    """

    def __init__(
        self,
        message: str,
        code: ErrorCode,
        status_code: Optional[int] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.status_code: Optional[int] = status_code
        self.body: Any = body

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return (
            f"AcruxCoreError(code={self.code!r}, status_code={self.status_code!r}, "
            f"message={str(self)!r})"
        )


class ToolSchemaError(AcruxCoreError):
    """Raised at DECORATION time when a tool's interface cannot be derived.

    A subclass rather than a bare :class:`AcruxCoreError` because this one fires
    during import, far from any API call, and a reader of the traceback needs to
    see immediately that the problem is a type hint and not the network.

    :param message: What could not be derived, and which parameter caused it.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message, TOOL_SCHEMA_ERROR)
