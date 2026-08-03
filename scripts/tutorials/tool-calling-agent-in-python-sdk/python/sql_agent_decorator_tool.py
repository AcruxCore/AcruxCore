import asyncio
import sqlite3

from acruxcore import AcruxCore, acrux

DB_PATH = "store.db"
PROMPT = "sql-analyst-agent"


@acrux.tool
async def query_database(sql: str) -> list[dict]:
    """Run a read-only SQL SELECT against the store database.

    Args:
        sql: A single read-only SQLite SELECT statement.
    """
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


async def ask(hub: AcruxCore, question: str) -> str:
    rendered = await hub.render_prompt(PROMPT, "production")
    messages = [*rendered.messages, {"role": "user", "content": question}]
    result = await hub.run_tool_loop(
        rendered.model,
        messages,
        tools=[query_database],
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
