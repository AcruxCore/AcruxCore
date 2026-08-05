"""
Manage a tool's shell and versions directly via the SDK -- Python.

Walks the full tool-catalog lifecycle end to end:

  1. Create a tool shell (no schema/executor yet).
  2. Commit v1 with a `client` executor -- the tool's first version, so both
     the `production` and `staging` aliases are minted automatically.
  3. Commit v2 with an `http` executor pointing at a public, no-auth endpoint
     -- later versions mint no new aliases.
  4. Commit v3 with only a `changelog` (no `description`) -- the API warns
     that the description was likely left out by mistake.
  5. List the tool's versions -- list items omit `parameters_schema`/`executor`.
  6. Fetch v2 directly to see its full `executor`.
  7. Promote `production` to v2.
  8. Read call analytics (likely empty -- nothing executed here).
  9. Delete the tool -- cleanup, no litter left in the catalog.

Requires:
  pip install acruxcore

Env:
  ACRUXCORE_API_KEY   -- required
  ACRUXCORE_BASE_URL  -- required, no default (e.g. http://localhost:3001/api/v1)
"""
import asyncio
import time

from acruxcore import AcruxCore


def section(number, title):
    print(f"\n{'=' * 64}\n{number}. {title}\n{'=' * 64}")


async def main():
    async with AcruxCore() as hub:
        tool_name = f"get_stock_price_{int(time.time() * 1000)}"

        # 1. Create a tool shell ------------------------------------------------
        section(1, "Create a tool shell")
        tool = await hub.tools.create(
            tool_name, description="Looks up the latest quoted price for a stock ticker."
        )
        print(f"tool id      : {tool.id}")
        print(f"tool name    : {tool.name}")

        parameters_schema = {
            "type": "object",
            "properties": {"ticker": {"type": "string", "description": "Stock ticker, e.g. AAPL."}},
            "required": ["ticker"],
        }

        # Steps 2-8 run inside a try/finally so a failure partway through (a
        # transient network blip, a bad executor shape, ...) still deletes the
        # shell created in step 1 -- no orphaned tool left behind either way.
        try:
            # 2. Commit v1 -- client executor ---------------------------------------
            section(2, "Commit v1 (client executor)")
            v1 = await hub.tools.commit_version(
                tool.id,
                parameters_schema,
                {"type": "client"},
                description="v1: caller's own app resolves the price.",
            )
            print(f"version      : {v1.version_number}")
            print(f"has aliases? : {v1.aliases is not None}")
            if v1.aliases:
                print(f"aliases      : {[f'{a.alias} -> v{a.version_number}' for a in v1.aliases]}")

            # 3. Commit v2 -- http executor ------------------------------------------
            section(3, "Commit v2 (http executor)")
            http_executor = {
                "type": "http",
                "url": "https://httpbin.org/get",
                "method": "GET",
                "headers": [],
                "query": [{"name": "ticker", "value": "{{ticker}}"}],
                "argMapping": [{"arg": "ticker", "in": "query"}],
            }
            v2 = await hub.tools.commit_version(
                tool.id,
                parameters_schema,
                http_executor,
                description="v2: resolves the price via a public HTTP endpoint.",
            )
            print(f"version      : {v2.version_number}")
            print(f"has aliases? : {v2.aliases is not None}")

            # 4. Commit v3 -- changelog only, no description -------------------------
            section(4, "Commit v3 (changelog only, no description)")
            v3 = await hub.tools.commit_version(
                tool.id,
                parameters_schema,
                http_executor,
                changelog="Swapped the price feed to a different upstream (no schema change).",
            )
            print(f"version      : {v3.version_number}")
            print(f"warnings     : {v3.warnings}")

            # 5. List versions --------------------------------------------------------
            section(5, "List versions")
            versions = await hub.tools.list_versions(tool.id)
            print(f"total        : {versions.total}")
            # ToolVersionListItem's own fields (see acruxcore/types.py) simply don't
            # include parameters_schema/executor -- print one item to show exactly
            # what a list entry carries.
            print(f"first item   : {versions.data[0]}")

            # 6. Get version 2 specifically ---------------------------------------------
            section(6, "Get version 2")
            fetched_v2 = await hub.tools.get_version(tool.id, 2)
            print(f"v2 executor  : {fetched_v2.executor}")

            # 7. Promote production to v2 -----------------------------------------------
            section(7, "Promote production to v2")
            promoted = await hub.tools.promote_alias(tool.id, "production", 2)
            print(f"alias        : {promoted.alias}")
            print(f"now points at: v{promoted.version_number}")

            # 8. Read analytics ------------------------------------------------------------
            section(8, "Read analytics")
            analytics = await hub.tools.analytics()
            print(f"analytics    : {analytics}")
        finally:
            # 9. Delete the tool -- cleanup, runs even if a step above raised ---------
            section(9, "Delete the tool (cleanup)")
            await hub.tools.delete(tool.id)
            print(f"deleted tool : {tool.id}")


if __name__ == "__main__":
    asyncio.run(main())
