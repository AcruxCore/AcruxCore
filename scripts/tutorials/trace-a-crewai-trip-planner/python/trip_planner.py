"""
Trace a CrewAI trip-planning crew via OTLP -- no AcruxCore code in the crew itself.

Run:
  export OPENAI_API_KEY=sk-...
  export TAVILY_API_KEY=tvly-...
  export ACRUXCORE_API_KEY=acx_sk_...
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python trip_planner.py
"""
from acruxcore.otel import register
from openinference.instrumentation import using_session

from dotenv import load_dotenv

load_dotenv()

# --- The only tracing code in this file. Everything below it is a normal ---
# --- CrewAI crew -- nothing in it knows AcruxCore exists.                ---
# CrewAI orchestrates agents/tasks/tools itself, but calls the model through
# the `openai` SDK directly unless the optional `crewai[litellm]` extra is
# installed -- so the LLM spans (model, tokens, cost) need instrument="openai"
# too, not just "crewai".
tracer_provider = register(
    service_name="crewai-trip-planner",
    instrument=["crewai", "openai"],
)
# ---------------------------------------------------------------------------

from crewai import Agent, Crew, Process, Task  # noqa: E402  (import after instrumentation is wired)
from crewai_tools import TavilySearchTool  # noqa: E402

MODEL = "gpt-4o-mini"

researcher = Agent(
    role="Destination Researcher",
    goal="Find concrete, well-reviewed attractions, restaurants, and neighborhoods for a trip",
    backstory="A travel researcher who always names specific places, never vague categories.",
    tools=[TavilySearchTool(max_results=5)],
    llm=MODEL,
    verbose=True,
)

planner = Agent(
    role="Itinerary Planner",
    goal="Turn research into a clear, day-by-day itinerary",
    backstory="A trip planner who sequences activities sensibly by location and pace.",
    llm=MODEL,
    verbose=True,
)


def build_crew(request: str, prior_itinerary: str | None = None) -> Crew:
    research_task = Task(
        description=f"Research attractions, food, and neighborhoods for: {request}",
        expected_output="A list of specific attractions, restaurants, and neighborhoods with brief notes.",
        agent=researcher,
    )
    plan_description = "Using the research, write a day-by-day itinerary that satisfies: " + request
    if prior_itinerary:
        # Turn 2 is a genuine revision, not just a same-session relabeling: the
        # planner sees turn 1's real output, not just a description of it.
        plan_description = (
            f"Here is the itinerary from the previous turn:\n\n{prior_itinerary}\n\n"
            f"Using the research, revise it to satisfy this new request: {request}"
        )
    plan_task = Task(
        description=plan_description,
        expected_output="A day-by-day itinerary (Day 1, Day 2, Day 3) with specific activities.",
        agent=planner,
        context=[research_task],
    )
    return Crew(agents=[researcher, planner], tasks=[research_task, plan_task], process=Process.sequential)


def main() -> None:
    session_id = "crewai-trip-planner-demo"

    with using_session(session_id):
        crew_1 = build_crew("Plan a 3-day trip to Lisbon focused on food and architecture.")
        result_1 = crew_1.kickoff()
    print("\n=== Turn 1 itinerary ===\n")
    print(result_1)

    with using_session(session_id):
        crew_2 = build_crew(
            "Revise the 3-day Lisbon itinerary: make day 2 more relaxed and add one hands-on cooking class.",
            prior_itinerary=str(result_1),
        )
        result_2 = crew_2.kickoff()
    print("\n=== Turn 2 itinerary (refinement) ===\n")
    print(result_2)

    print(f"\nsession.id used for both turns: {session_id}")
    tracer_provider.force_flush()


if __name__ == "__main__":
    main()
