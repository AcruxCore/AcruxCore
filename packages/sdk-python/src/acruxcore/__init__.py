"""Async Python SDK for Acrux Core.

Runtime prompt render, gateway chat (with streaming), client-side tool loops,
trace reporting, and feedback — full parity with the TypeScript SDK.

Example::

    import asyncio
    from acruxcore import AcruxCore

    async def main():
        async with AcruxCore(api_key=..., base_url="http://localhost:3001/api/v1") as hub:
            result = await hub.render_prompt("greeting", "production", {"name": "Alice"})
            print(result.messages)

    asyncio.run(main())
"""

from . import tooling as acrux  # noqa: F401 — enables the `@acrux.tool` spelling
from .client import AcruxCore, AsyncChatStream
from .errors import (
    API_ERROR,
    MISSING_API_KEY,
    MISSING_BASE_URL,
    MISSING_DISPATCH,
    MISSING_VARIABLES,
    NETWORK_ERROR,
    PROVIDER_ERROR,
    TOOL_SCHEMA_ERROR,
    AcruxCoreError,
    ToolSchemaError,
)
from .response_format import pydantic_response_format
from .tooling import ToolSpec, spec_of, tool
from .types import (
    ChatChunk,
    ChatResult,
    ChatUsage,
    FeedbackResult,
    GatewayCallMeta,
    GetTraceResult,
    IngestSpan,
    ListTracesResult,
    Message,
    ProviderConfig,
    RenderResult,
    ResolvedTool,
    ResponseFormat,
    RunToolLoopResult,
    ToolCall,
    ToolChoice,
    ToolDefinition,
    ToolExecuteResult,
    ToolRef,
    ToolSyncResult,
    TraceInput,
    TraceResult,
    TraceSpan,
    TraceSummary,
)

__version__ = "0.6.6"

__all__ = [
    "AcruxCore",
    "AsyncChatStream",
    "AcruxCoreError",
    "acrux",
    "tool",
    "ToolSpec",
    "spec_of",
    "pydantic_response_format",
    "ToolSchemaError",
    "TOOL_SCHEMA_ERROR",
    "MISSING_DISPATCH",
    "API_ERROR",
    "MISSING_API_KEY",
    "MISSING_BASE_URL",
    "MISSING_VARIABLES",
    "NETWORK_ERROR",
    "PROVIDER_ERROR",
    "ChatChunk",
    "ChatResult",
    "ChatUsage",
    "FeedbackResult",
    "GatewayCallMeta",
    "GetTraceResult",
    "IngestSpan",
    "ListTracesResult",
    "Message",
    "ProviderConfig",
    "RenderResult",
    "ResolvedTool",
    "ResponseFormat",
    "RunToolLoopResult",
    "ToolCall",
    "ToolChoice",
    "ToolDefinition",
    "ToolExecuteResult",
    "ToolRef",
    "ToolSyncResult",
    "TraceInput",
    "TraceResult",
    "TraceSpan",
    "TraceSummary",
    "__version__",
]
