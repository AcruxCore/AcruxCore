import asyncio
import sqlite3

from acruxcore import AcruxCore

DB_PATH = "store.db"
PROMPT = "sql-analyst-agent"


def query_database(sql: str) -> list[dict]:
    """Run one read-only SELECT against the local store and return rows as dicts."""
    statement = sql.strip().rstrip(";").strip()
    if not statement.lower().startswith("select"):
        raise ValueError("Only read-only SELECT statements are allowed.")
    if ";" in statement:
        raise ValueError("Only a single statement is allowed.")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in conn.execute(statement).fetchall()]
    finally:
        conn.close()


def run_query_database(sql: str) -> list[dict]:
    """The `client_tools` entry for the dashboard-authored tool.

    The parameter name is the catalog schema's own field, `sql`, because that is how
    the function is called -- `run_query_database(sql=...)`, not one args dict.
    """
    print(f"  → query_database: {sql}")
    return query_database(sql)


#: Keyed by catalog tool name. The catalog holds this tool's schema and deliberately no
#: body, so the map is the whole of what this app contributes.
CLIENT_TOOLS = {"query_database": run_query_database}


async def ask(hub: AcruxCore, question: str) -> str:
    rendered = await hub.prompts.render(PROMPT, "production")
    messages = [*rendered.messages, {"role": "user", "content": question}]
    result = await hub.gateway.run_prompt_with_tools(
        rendered,
        messages=messages,
        client_tools=CLIENT_TOOLS,
        trace={"name": "sql-analyst-agent", "session_id": "sql-agent-demo"},
    )
    print(f"  (trace {result.trace_id})")
    return result.content


async def main() -> None:
    async with AcruxCore() as hub:
        for question in [
            "Which product generated the most total revenue, and how much?",
            "How many total units were ordered in June 2026?",
        ]:
            print(f"\nQ: {question}")
            print(f"A: {await ask(hub, question)}")


if __name__ == "__main__":
    asyncio.run(main())
