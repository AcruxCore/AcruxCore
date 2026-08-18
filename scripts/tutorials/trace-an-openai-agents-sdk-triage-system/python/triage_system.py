"""
Trace an OpenAI Agents SDK support-triage system via OTLP -- no AcruxCore SDK involved
in the agents themselves.

A Triage agent hands off to a Billing agent or a Tech-support agent, each with
its own tool. The only AcruxCore-specific code in this file is the three lines
under "OTel + OpenInference wiring" below -- everything else is plain OpenAI
Agents SDK code.

Requires:
  pip install openai-agents 'acruxcore[otel]' openinference-instrumentation-openai-agents python-dotenv

Env vars (exported directly, or via a .env file anywhere above this script --
python-dotenv searches upward for one):
  OPENAI_API_KEY       -- real OpenAI key, calls gpt-4o-mini
  ACRUXCORE_API_KEY    -- e.g. acx_sk_...
  ACRUXCORE_BASE_URL   -- e.g. https://api.acruxcore.com/api/v1
"""

import asyncio

from dotenv import load_dotenv

load_dotenv()

from acruxcore.otel import register
from agents import Agent, Runner, function_tool
from openinference.instrumentation import using_session

# --- OTel + OpenInference wiring -------------------------------------------
# instrument=["openai_agents"] replaces the Agents SDK's default trace
# processor (which reports to platform.openai.com) with the OpenInference one
# -- there is no separate "disable" step, and calling set_tracing_disabled()
# would disable the SDK's whole tracing pipeline, silently starving this
# processor too. Nothing below this block is AcruxCore-specific.
provider = register(
    service_name="support-triage-agents-sdk",
    instrument=["openai_agents"],
)
# -----------------------------------------------------------------------------

MOCK_SUBSCRIPTIONS = {
    "alex@example.com": {"tier": "Pro", "renewed_on": "2026-08-01", "last_charge_usd": 49.00},
}

MOCK_ORDERS = {
    "A1234": {"status": "delivered", "app_version": "3.4.1", "known_crash_bug": True},
}


@function_tool
def check_subscription(customer_email: str) -> str:
    """Look up a customer's subscription tier and most recent charge.

    Args:
        customer_email: The customer's account email address.
    """
    record = MOCK_SUBSCRIPTIONS.get(customer_email)
    if not record:
        return f"No subscription found for {customer_email}."
    return (
        f"{customer_email} is on the {record['tier']} plan, renewed {record['renewed_on']}, "
        f"last charge ${record['last_charge_usd']:.2f}."
    )


@function_tool
def lookup_order(order_id: str) -> str:
    """Look up an order's delivery status and the app version tied to it.

    Args:
        order_id: The order identifier, e.g. "A1234".
    """
    record = MOCK_ORDERS.get(order_id)
    if not record:
        return f"No order found with id {order_id}."
    crash_note = (
        " This app version has a known crash bug, already fixed in the latest release."
        if record["known_crash_bug"]
        else ""
    )
    return f"Order {order_id} was {record['status']} on app version {record['app_version']}.{crash_note}"


billing_agent = Agent(
    name="Billing",
    handoff_description="Handles subscription, billing, and charge questions.",
    instructions=(
        "You help with billing questions. Use check_subscription to look up the "
        "customer's plan and charges before answering. Be concise."
    ),
    tools=[check_subscription],
    model="gpt-4o-mini",
)

tech_support_agent = Agent(
    name="Tech Support",
    handoff_description="Handles app crashes, bugs, and order/delivery status.",
    instructions=(
        "You help with technical issues and order status. Use lookup_order to "
        "check the order before answering. Be concise."
    ),
    tools=[lookup_order],
    model="gpt-4o-mini",
)

triage_agent = Agent(
    name="Triage",
    instructions=(
        "Route the customer to Billing for subscription/charge questions, or to "
        "Tech Support for app/order problems. Do not answer directly yourself."
    ),
    handoffs=[billing_agent, tech_support_agent],
    model="gpt-4o-mini",
)


async def main() -> None:
    session_id = "support-triage-demo-session"

    with using_session(session_id):
        turn1 = await Runner.run(
            triage_agent,
            "I was charged twice this month, can you check my subscription? My email is alex@example.com",
        )
        print("--- Turn 1 (expect Billing handoff) ---")
        print(turn1.final_output)

        turn2_input = turn1.to_input_list() + [
            {
                "role": "user",
                "content": (
                    "Also my app keeps crashing on order #A1234, can you check that order's status?"
                ),
            }
        ]
        turn2 = await Runner.run(triage_agent, turn2_input)
        print("\n--- Turn 2 (expect Tech Support handoff) ---")
        print(turn2.final_output)

    print(f"\nsession.id used for both turns: {session_id}")

    provider.force_flush()


if __name__ == "__main__":
    asyncio.run(main())
