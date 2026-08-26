import asyncio
from acruxcore import AcruxCore


async def main() -> None:
    async with AcruxCore() as hub:
        stream = await hub.gateway.stream(
            "claude-haiku",
            [{"role": "user", "content": "In one sentence, what makes a good data analyst?"}],
        )
        async for chunk in stream:
            print(chunk.delta.get("content", "") or "", end="", flush=True)
        print()


if __name__ == "__main__":
    asyncio.run(main())
