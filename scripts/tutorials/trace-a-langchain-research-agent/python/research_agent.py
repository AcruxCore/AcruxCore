"""
Trace a LangChain research agent via OTLP -- no AcruxCore code in the agent itself.

Run:
  export OPENAI_API_KEY=sk-...
  export TAVILY_API_KEY=tvly-...
  export ACRUXCORE_API_KEY=acx_sk_...
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python research_agent.py
"""
from acruxcore.otel import register
from openinference.instrumentation import using_session

from dotenv import load_dotenv

load_dotenv()

# --- The only tracing code in this file. Everything below it is a normal ---
# --- LangChain agent -- nothing in it knows AcruxCore exists.             ---
# One instrumentor is enough here, unlike the CrewAI tutorial: the LangChain
# instrumentor hooks LangChain's own callback manager, which already sees the
# model call `ChatOpenAI` makes. Adding instrument=["openai"] on top would
# double-report every LLM span.
tracer_provider = register(
    service_name="langchain-research-agent",
    instrument=["langchain"],
)
# ---------------------------------------------------------------------------

from langchain.agents import create_agent  # noqa: E402  (import after instrumentation is wired)
from langchain_core.tools import tool  # noqa: E402
from langchain_openai import ChatOpenAI  # noqa: E402
from langchain_tavily import TavilySearch  # noqa: E402

MODEL = "gpt-4o-mini"

SYSTEM_PROMPT = (
    "You are a research assistant. Search the web for facts you do not already know, "
    "and name your sources. When a question involves splitting a cost between people "
    "or across months, you MUST use the split_cost tool rather than doing the "
    "arithmetic yourself."
)


@tool
def split_cost(total_amount: float, people: int, months: int) -> str:
    """Split a total cost between people and across months.

    Args:
        total_amount: The full amount for ONE month, in any single currency.
        people: How many people share the cost.
        months: How many months the cost runs for.
    """
    if people <= 0 or months <= 0:
        return "people and months must both be greater than zero"
    grand_total = total_amount * months
    per_person_per_month = total_amount / people
    per_person_total = grand_total / people
    return (
        f"Total for {months} month(s): {grand_total:.2f}. "
        f"Per person per month: {per_person_per_month:.2f}. "
        f"Per person for the whole {months} month(s): {per_person_total:.2f}."
    )


def build_agent():
    """Builds the two-tool ReAct agent. Rebuilt per turn so each run is independent."""
    search = TavilySearch(max_results=5)
    return create_agent(
        model=ChatOpenAI(model=MODEL, temperature=0),
        tools=[search, split_cost],
        system_prompt=SYSTEM_PROMPT,
    )


def run_turn(messages: list) -> str:
    """Invokes the agent on a message list and returns the final assistant text.

    `run_name` is what makes the trace findable: without it LangGraph names every
    root span after the graph class, so the trace list fills with identical
    "LangGraph" rows and you cannot tell one run from another.
    """
    result = build_agent().invoke(
        {"messages": messages},
        config={"run_name": "research-agent"},
    )
    return result["messages"][-1].content


def main() -> None:
    session_id = "langchain-research-agent-demo"

    question_1 = (
        "What does a hot desk at Second Home Lisboa in Lisbon cost per month? "
        "Give the price and the source."
    )
    with using_session(session_id):
        answer_1 = run_turn([{"role": "user", "content": question_1}])
    print("\n=== Turn 1 answer ===\n")
    print(answer_1)

    # Turn 2 carries turn 1's real answer forward, so the model has the price it
    # found and only needs the calculator -- a genuine follow-up, not a fresh
    # question wearing the same session id.
    question_2 = (
        "Four of us want that hot desk for 3 months. What is the total, and the "
        "cost per person per month?"
    )
    with using_session(session_id):
        answer_2 = run_turn(
            [
                {"role": "user", "content": question_1},
                {"role": "assistant", "content": answer_1},
                {"role": "user", "content": question_2},
            ]
        )
    print("\n=== Turn 2 answer (follow-up) ===\n")
    print(answer_2)

    print(f"\nsession.id used for both turns: {session_id}")
    tracer_provider.force_flush()


if __name__ == "__main__":
    main()
