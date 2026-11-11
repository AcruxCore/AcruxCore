"""
Call your provider directly with your own key (BYO) -- Python.

Walks the guide at https://docs.acruxcore.com/docs/guides/call-your-provider-directly.
For each provider whose key is set, the script runs three calls with the
provider's own key, and the SDK reports each one to AcruxCore as a trace:

  1. a plain chat() call
  2. the same call with stream=True
  3. a tool loop: the model calls get_weather for two cities, then answers

OpenAI and OpenRouter use the OpenAI Chat Completions format. Anthropic and
Gemini use their own APIs (Messages and generateContent); the SDK translates.
No provider SDK is needed.

Requires:
  pip install acruxcore

Env:
  ACRUXCORE_API_KEY   -- required, an AcruxCore API key (it sends the traces)
  ACRUXCORE_BASE_URL  -- defaults to https://api.acruxcore.com/api/v1
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY
                      -- set any of them; providers without a key are skipped
  OPENAI_MODEL, ANTHROPIC_MODEL, GEMINI_MODEL, OPENROUTER_MODEL
                      -- optional, override the model used for that provider

Run:
  python call_providers.py
"""
import asyncio
import os

from acruxcore import AcruxCore, acrux
from acruxcore.errors import AcruxCoreError

# Each entry is the same `provider` setting as in the guide, plus the model to call.
# A provider whose key is not set is skipped.
PROVIDERS = {
    "openai": {
        "provider": {"base_url": "https://api.openai.com/v1", "api_key": os.environ.get("OPENAI_API_KEY")},
        "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
    },
    "anthropic": {
        "provider": {"kind": "anthropic", "api_key": os.environ.get("ANTHROPIC_API_KEY")},
        "model": os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5"),
    },
    "gemini": {
        "provider": {"kind": "gemini", "api_key": os.environ.get("GEMINI_API_KEY")},
        "model": os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview"),
    },
    "openrouter": {
        "provider": {"base_url": "https://openrouter.ai/api/v1", "api_key": os.environ.get("OPENROUTER_API_KEY")},
        "model": os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
    },
}

HELLO = [{"role": "user", "content": "Say hello in five words."}]
WEATHER_QUESTION = [{
    "role": "user",
    "content": "What is the weather in Paris and in Rome? Call the tool once per city, then answer in one sentence.",
}]
TEMPERATURES = {"Paris": 18, "Rome": 24}


# The decorator builds the tool definition the model reads from the function itself:
# the name from the function name, the description from the docstring, and the
# parameters from the type hints. The function runs on your machine; the model
# only sees what it returns.
@acrux.tool
async def get_weather(city: str) -> dict:
    """Current weather for one city.

    Args:
        city: City name, e.g. 'Paris'.
    """
    return {"city": city, "temp_c": TEMPERATURES.get(city, 20)}


async def run_provider(hub: AcruxCore, name: str, provider: dict, model: str) -> None:
    print(f"== {name} ({model})")

    reply = await hub.gateway.chat(model, HELLO, provider=provider, trace={"name": f"byo-{name}-chat"})
    print(f"  chat:   {reply.content.strip()!r}  ({reply.usage.prompt_tokens}+{reply.usage.completion_tokens} tokens)")

    text = ""
    stream = await hub.gateway.chat(model, HELLO, provider=provider, stream=True, trace={"name": f"byo-{name}-stream"})
    async for chunk in stream:
        text += chunk.delta.get("content") or ""
    print(f"  stream: {text.strip()!r}")

    loop = await hub.gateway.run_tool_loop(
        model,
        WEATHER_QUESTION,
        tools=[get_weather],
        provider=provider,
        trace={"name": f"byo-{name}-tools"},
    )
    calls = sum(len(m.get("tool_calls") or []) for m in loop.messages if m.get("role") == "assistant")
    print(f"  tools:  {loop.content.strip()!r}  ({calls} tool calls, {loop.iterations} model turns)")


async def main() -> None:
    base_url = os.environ.get("ACRUXCORE_BASE_URL", "https://api.acruxcore.com/api/v1")
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=base_url) as hub:
        for name, entry in PROVIDERS.items():
            if not entry["provider"]["api_key"]:
                print(f"== {name}: skipped, {name.upper()}_API_KEY is not set")
                continue
            try:
                await run_provider(hub, name, entry["provider"], entry["model"])
            except AcruxCoreError as err:
                # A wrong key or a provider quota fails one provider, not the whole run.
                print(f"  failed: {err}")
    # Leaving the `async with` block sends the last traces before the script exits.
    print("Done. Each call is a trace under Traces in the dashboard.")


if __name__ == "__main__":
    asyncio.run(main())
