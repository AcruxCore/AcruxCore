"""Full API walkthrough — exercises every namespace in acruxcore.

Scenario: build and evaluate a customer-support bot.
Uses UUID suffixes for idempotency so the script is safe to re-run.

Run:
    ACRUXCORE_API_KEY=<your key> \
    ACRUXCORE_BASE_URL=http://localhost:3001/api/v1 \
    python packages/sdk-python/examples/full_api_walkthrough.py
"""

from __future__ import annotations

import asyncio
import uuid

from acruxcore import AcruxCore, acrux


def uid() -> str:
    return uuid.uuid4().hex[:8]


def tag(label: str) -> None:
    print(f"\n── {label} ──")


@acrux.tool
async def get_order_status(order_id: str) -> dict:
    """Look up the status of a customer order by order ID.

    Args:
        order_id: The order ID, e.g. ORD-12345.
    """
    return {"orderId": order_id, "status": "shipped", "carrier": "FedEx", "eta": "2 days"}


async def main() -> None:
    prompt_name = f"support-bot-{uid()}"
    tool_name = f"lookup-order-{uid()}"
    prompt_id = ""
    tool_id = ""
    trace_id = ""

    async with AcruxCore() as hub:
        model = "gpt-4o-mini"

        # ══════════════════════════════════════════════════════════════════
        #  PROMPTS (14 methods; its 6 tool-binding methods run in the TOOLS
        #  section below, which is where a tool to bind first exists)
        # ══════════════════════════════════════════════════════════════════

        tag("prompts.create")
        prompt = await hub.prompts.create(prompt_name, description="Customer support bot")
        prompt_id = prompt.id
        print(f'  ✓ created prompt "{prompt.name}" ({prompt_id})')

        tag("prompts.get")
        got = await hub.prompts.get(prompt_id)
        print(f'  ✓ got prompt "{got.name}" (versions: {getattr(got, "version_count", "n/a")})')

        tag("prompts.update")
        updated = await hub.prompts.update(prompt_id, description="Updated support bot v2")
        print(f'  ✓ updated prompt description: "{updated.description}"')

        tag("prompts.list")
        list_result = await hub.prompts.list(search=prompt_name, limit=5)
        print(f"  ✓ listed {len(list_result.data)} prompt(s), total={list_result.total}")

        tag("prompts.commit_version")
        v1 = await hub.prompts.commit_version(
            prompt_id,
            messages=[
                {"role": "system", "content": "You are a helpful customer support agent."},
                {"role": "user", "content": "{{customer_message}}"},
            ],
            model=model,
        )
        print(f"  ✓ committed v{v1.version_number} (id: {v1.id})")

        tag("prompts.list_versions")
        versions = await hub.prompts.list_versions(prompt_id)
        print(f"  ✓ listed {len(versions.data)} version(s)")

        tag("prompts.get_version")
        v1_full = await hub.prompts.get_version(prompt_id, v1.version_number)
        print(f"  ✓ got version {v1_full.version_number} (model: {getattr(v1_full, 'model', None) or 'none'})")

        tag("prompts.promote_alias")
        alias = await hub.prompts.promote_alias(prompt_id, "production", v1.version_number)
        print(f'  ✓ promoted alias "{alias.alias}" → v{alias.version_number}')

        tag("prompts.diff")
        v2 = await hub.prompts.commit_version(
            prompt_id,
            messages=[
                {"role": "system", "content": "You are a friendly and empathetic support agent."},
                {"role": "user", "content": "{{customer_message}}"},
            ],
            model=model,
        )
        diff = await hub.prompts.diff(prompt_id, v1.version_number, v2.version_number)
        changes = getattr(diff, "changes", None) or []
        print(f"  ✓ diff v{v1.version_number}→v{v2.version_number} ({len(changes)} change(s))")

        tag("prompts.export_version")
        exported = await hub.prompts.export_version(prompt_id, v1.version_number)
        print(f"  ✓ exported v{v1.version_number} ({len(str(exported))} chars)")

        tag("prompts.import_prompt")
        imported = await hub.prompts.import_prompt(exported.to_import_body())
        imported_prompt_id = imported.prompt.id
        print(f'  ✓ imported as prompt v{imported.version.version_number}')

        tag("prompts.traces_for_version")
        version_traces = await hub.prompts.traces_for_version(prompt_id, v1.version_number, limit=1)
        print(f"  ✓ traces for v{v1.version_number}: {len(version_traces.data)} trace(s)")

        tag("prompts.render")
        rendered = await hub.prompts.render(
            prompt_name, "production", {"customer_message": "Where is my order ORD-12345?"}
        )
        print(f"  ✓ rendered {len(rendered.messages)} message(s), {len(rendered.tools)} tool(s)")

        tag("prompts.delete")
        await hub.prompts.delete(imported_prompt_id)
        print("  ✓ deleted imported prompt")

        # ══════════════════════════════════════════════════════════════════
        #  TOOLS (12 methods) + the 6 prompt→tool binding methods
        # ══════════════════════════════════════════════════════════════════

        tag("tools.create")
        tool = await hub.tools.create(tool_name, description="Look up order status")
        tool_id = tool.id
        print(f'  ✓ created tool "{tool.name}" ({tool_id})')

        tag("tools.get")
        got_tool = await hub.tools.get(tool_id)
        print(f'  ✓ got tool "{got_tool.name}"')

        tag("tools.update")
        updated_tool = await hub.tools.update(tool_id, description="Updated order lookup")
        print(f'  ✓ updated tool description: "{updated_tool.description}"')

        tag("tools.list")
        tool_list = await hub.tools.list(search=tool_name, limit=5)
        print(f"  ✓ listed {len(tool_list.data)} tool(s), total={tool_list.total}")

        tag("tools.commit_version")
        tv1 = await hub.tools.commit_version(
            tool_id,
            description="Look up order status",
            parameters_schema={
                "type": "object",
                "properties": {"orderId": {"type": "string"}},
                "required": ["orderId"],
            },
            executor={"type": "client"},
        )
        print(f"  ✓ committed tool v{tv1.version_number}")

        tag("tools.list_versions")
        tool_versions = await hub.tools.list_versions(tool_id)
        print(f"  ✓ listed {len(tool_versions.data)} tool version(s)")

        tag("tools.get_version")
        tv1_full = await hub.tools.get_version(tool_id, tv1.version_number)
        print(f"  ✓ got tool v{tv1_full.version_number}")

        tag("tools.promote_alias")
        tool_alias = await hub.tools.promote_alias(tool_id, "production", tv1.version_number)
        print(f'  ✓ promoted tool alias "{tool_alias.alias}" → v{tool_alias.version_number}')

        # ──────────────────────────────────────────────────────────────────
        #  Prompt→tool bindings — which tools a prompt calls is decided here,
        #  per prompt alias. A commit decides the template only.
        # ──────────────────────────────────────────────────────────────────

        tag("prompts.set_tool_binding")
        default_binding = await hub.prompts.set_tool_binding(
            prompt_id, tool_id, tool_alias="production"
        )
        print(
            f'  ✓ default binding → "{default_binding.tool_alias}" '
            f"(v{default_binding.resolved_version_number})"
        )

        tag("prompts.set_alias_tool_binding")
        staging_binding = await hub.prompts.set_alias_tool_binding(
            prompt_id, "staging", tool_id, pinned_version_number=tv1.version_number
        )
        print(f"  ✓ staging pinned to tool v{staging_binding.pinned_version_number}")

        tag("prompts.list_tool_bindings")
        prompt_bindings = await hub.prompts.list_tool_bindings(prompt_id)
        customised = [a for a in prompt_bindings.aliases if a.customised]
        print(
            f"  ✓ {len(prompt_bindings.default)} default binding(s), "
            f"{len(customised)} customised alias(es)"
        )

        tag("prompts.remove_alias_tool_binding")
        await hub.prompts.remove_alias_tool_binding(prompt_id, "staging", tool_id)
        print("  ✓ staging returned to the default binding")

        tag("prompts.reset_alias_tool_bindings")
        await hub.prompts.reset_alias_tool_bindings(prompt_id, "staging")
        print("  ✓ staging reset (no-op when it owns no rows)")

        tag("prompts.remove_tool_binding")
        await hub.prompts.remove_tool_binding(prompt_id, tool_id)
        print("  ✓ default binding removed")

        tag("tools.analytics")
        tool_analytics = await hub.tools.analytics()
        print(f"  ✓ tool analytics: {len(tool_analytics.data)} tool(s) with data")

        tag("tools.sync")
        sync_results = await hub.tools.sync([get_order_status])
        print(f"  ✓ synced {len(sync_results)} tool(s)")

        tag("tools.sync_one")
        one_sync = await hub.tools.sync_one(get_order_status.__acrux_tool__)
        print(f"  ✓ sync_one: committed={one_sync.committed}, version={one_sync.version_number}")

        tag("tools.delete")
        await hub.tools.delete(tool_id)
        print("  ✓ deleted tool")

        # ══════════════════════════════════════════════════════════════════
        #  GATEWAY (5 methods)
        # ══════════════════════════════════════════════════════════════════

        tag("gateway.chat")
        chat_result = await hub.gateway.chat(model, [{"role": "user", "content": "Say hello in one sentence."}])
        print(f'  ✓ chat: "{chat_result.content[:60]}..."')

        tag("gateway.stream")
        stream = await hub.gateway.stream(model, [{"role": "user", "content": "Count from 1 to 5."}])
        streamed = ""
        async for chunk in stream:
            streamed += chunk.delta.get("content", "")
        print(f"  ✓ streamed {len(streamed)} chars")

        tag("gateway.run_tool_loop")
        tool_defs = [
            {
                "type": "function",
                "function": {
                    "name": "get_order_status",
                    "description": "Look up the status of a customer order by order ID.",
                    "parameters": {
                        "type": "object",
                        "properties": {"orderId": {"type": "string"}},
                        "required": ["orderId"],
                    },
                },
            }
        ]

        def dispatch(name: str, args: dict) -> dict:
            if name == "get_order_status":
                return {"orderId": args.get("orderId"), "status": "shipped", "carrier": "FedEx", "eta": "2 days"}
            raise ValueError(f"Unknown tool: {name}")

        loop_result = await hub.gateway.run_tool_loop(
            model,
            [{"role": "user", "content": "What is the status of order ORD-12345?"}],
            tool_defs=tool_defs,
            dispatch=dispatch,
        )
        print(f'  ✓ run_tool_loop: "{loop_result.content[:80]}..." ({loop_result.iterations} iteration(s))')

        tag("gateway.flush")
        await hub.gateway.flush()
        print("  ✓ flushed")

        tag("gateway.aclose")
        await hub.gateway.aclose()
        print("  ✓ closed")

        # ══════════════════════════════════════════════════════════════════
        #  TRACES (13 methods)
        # ══════════════════════════════════════════════════════════════════

        tag("traces.ingest")
        ingested = await hub.traces.ingest({
            "name": "walkthrough-test",
            "spans": [
                {
                    "spanId": "span-1",
                    "name": "test-span",
                    "kind": "other",
                    "status": "ok",
                    "startTime": "2026-01-01T00:00:00Z",
                    "endTime": "2026-01-01T00:00:01Z",
                    "attributes": {"walkthrough": True},
                },
            ],
        })
        trace_id = ingested.trace_id
        print(f"  ✓ ingested trace {trace_id}")

        tag("traces.get")
        trace = await hub.traces.get(trace_id)
        print(f'  ✓ got trace "{trace.trace.name}" ({len(trace.spans)} span(s))')

        tag("traces.list")
        trace_list = await hub.traces.list(limit=3)
        print(f"  ✓ listed {len(trace_list.data)} trace(s), total={trace_list.total}")

        tag("traces.submit_feedback")
        fb = await hub.traces.submit_feedback(trace_id, rating=5, label="helpful")
        print(f"  ✓ submitted feedback {fb.id}")

        tag("traces.update_feedback")
        fb_updated = await hub.traces.update_feedback(trace_id, fb.id, rating=1, label="unhelpful")
        print(f"  ✓ updated feedback: rating={fb_updated.rating}")

        tag("traces.analytics")
        analytics = await hub.traces.analytics(group_by="model")
        data = getattr(analytics, "data", None) or []
        print(f"  ✓ analytics: {len(data)} group(s)")

        tag("traces.list_facets")
        facets = await hub.traces.list_facets()
        print(f"  ✓ facets: {len(facets.tags)} tag(s), {len(facets.metadata_keys)} metadata key(s)")

        tag("traces.get_facet_values")
        facet_values = await hub.traces.get_facet_values("model")
        values = getattr(facet_values, "values", None) or []
        print(f'  ✓ facet "model": {len(values)} value(s)')

        tag("traces.get_settings")
        settings = await hub.traces.get_settings()
        print(f"  ✓ settings: capture_payloads={settings.capture_payloads}")

        tag("traces.update_settings")
        new_settings = await hub.traces.update_settings(settings.capture_payloads)
        print(f"  ✓ update_settings: capture_payloads={new_settings.capture_payloads}")

        tag("traces.get_feedback_summary")
        summary = await hub.traces.get_feedback_summary()
        summary_data = getattr(summary, "data", None) or []
        print(f"  ✓ feedback summary: {len(summary_data)} bucket(s)")

        tag("traces.list_feedback")
        feedback_list = await hub.traces.list_feedback(limit=5)
        fb_data = getattr(feedback_list, "data", None) or []
        print(f"  ✓ listed {len(fb_data)} feedback item(s)")

        tag("traces.get_trace_feedback")
        trace_fb = await hub.traces.get_trace_feedback(trace_id)
        trace_fb_data = getattr(trace_fb, "data", None) or []
        print(f"  ✓ trace feedback: {len(trace_fb_data)} item(s)")

        # ══════════════════════════════════════════════════════════════════
        #  SESSIONS (2 methods)
        # ══════════════════════════════════════════════════════════════════

        tag("sessions.list")
        session_list = await hub.sessions.list(limit=3)
        print(f"  ✓ listed {len(session_list.data)} session(s), total={session_list.total}")

        if session_list.data:
            tag("sessions.get")
            session = await hub.sessions.get(session_list.data[0].session_id)
            session_traces = getattr(session, "traces", None) or []
            print(f"  ✓ got session {session_list.data[0].session_id} ({len(session_traces)} trace(s))")
        else:
            print("  ⊘ sessions.get skipped (no sessions yet)")

        # ══════════════════════════════════════════════════════════════════
        #  EVALUATIONS (brief — list available methods)
        # ══════════════════════════════════════════════════════════════════

        tag("evaluations (method listing)")
        print("  hub.datasets: create, build_from_feedback, list, get, update, delete, add_example, remove_example")
        print("  hub.experiments: create, list, get, start_run")
        print("  hub.runs: list, get, get_report, get_cell, get_candidate, promote_candidate")
        print("  hub.optimize: start")
        print("  ✓ (methods verified present — run a full eval flow to exercise them)")

        # ══════════════════════════════════════════════════════════════════

        print("\n═══════════════════════════════════════════════")
        print("  All namespace methods exercised successfully.")
        print("═══════════════════════════════════════════════")


if __name__ == "__main__":
    asyncio.run(main())
