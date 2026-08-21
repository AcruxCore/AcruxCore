"""The whole streaming tool loop, with nothing else in the file -- Python.

No tool code, no `tools=`, no formatting: render a prompt, stream it, print each
event as it lands. This works because every tool bound to the prompt's `production`
alias has an `http` executor -- the platform runs those, so there is nothing for
this script to supply.

If a bound tool's version has a `client` executor instead, its code lives in your
process and the platform cannot reach it. The loop then stops before it calls the
model and says so, naming the tool. That is the only case that needs `client_tools=`;
see stream_prompt_tools.py, which handles both.

Requires:
  pip install acruxcore

Env:
  ACRUXCORE_API_KEY   -- required
  ACRUXCORE_BASE_URL  -- required, no default (e.g. http://localhost:3001/api/v1)

Run:
  python stream_minimal.py
"""
import asyncio

from acruxcore import AcruxCore


async def main() -> None:
    async with AcruxCore() as hub:
        rendered = await hub.prompts.render("weather-brief", "production", {"city": "Lisbon"})

        stream = await hub.gateway.run_prompt_with_tools(rendered, stream=True)
        async for chunk in stream:
            print(chunk)

        # The loop reports its trace in the background; wait for that write so the
        # trace is readable the moment this script exits.
        await hub.gateway.flush()


if __name__ == "__main__":
    asyncio.run(main())
