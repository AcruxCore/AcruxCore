"""Send the same synthetic agent traces to any OTLP/HTTP endpoint.

Each trace is one agent turn with three spans: a root `agent-run`, an
`llm-call` child carrying a chat prompt and answer (~1.6 KB of text), and a
`tool-call` child (~0.3 KB). Content is deterministic so every tool receives
byte-for-byte the same payloads.

Usage:
  python load.py --endpoint http://localhost:6006/v1/traces \
      [--header 'Authorization=Basic xyz'] [--traces 1000]
"""
import argparse
import json
import time

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

SYSTEM = (
    "You are a support agent for an online bookshop. Answer in two or three "
    "sentences. If an order is late, look it up with the order tool first."
)
ANSWER = (
    "Your order #{n} left our warehouse on Monday and is with the courier. "
    "The tracking page shows it arriving on Thursday before 6 pm. If it has "
    "not arrived by Friday, reply here and I will send a replacement at no cost."
)


def question(n: int) -> str:
    return (
        f"Hi, I ordered three paperbacks last week (order #{n}) and the site "
        "still says 'processing'. I need them for a book club on Friday. Can "
        "you tell me where the parcel is and whether it will arrive in time? "
        "I paid for standard shipping, not express."
    ) * 2


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--endpoint", required=True)
    p.add_argument("--header", action="append", default=[])
    p.add_argument("--traces", type=int, default=1000)
    p.add_argument("--service", default="bookshop-support-agent")
    a = p.parse_args()

    headers = dict(h.split("=", 1) for h in a.header)
    provider = TracerProvider(resource=Resource.create({"service.name": a.service}))
    exporter = OTLPSpanExporter(endpoint=a.endpoint, headers=headers, timeout=30)
    provider.add_span_processor(
        BatchSpanProcessor(exporter, max_queue_size=20000, max_export_batch_size=256)
    )
    tracer = provider.get_tracer("selfhost-bench")

    t0 = time.time()
    for n in range(1, a.traces + 1):
        q = question(10000 + n)
        ans = ANSWER.format(n=10000 + n)
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}]
        with tracer.start_as_current_span("agent-run") as root:
            root.set_attribute("openinference.span.kind", "AGENT")
            root.set_attribute("input.value", q)
            root.set_attribute("output.value", ans)
            with tracer.start_as_current_span("llm-call") as llm:
                llm.set_attribute("openinference.span.kind", "LLM")
                llm.set_attribute("gen_ai.system", "openai")
                llm.set_attribute("gen_ai.operation.name", "chat")
                llm.set_attribute("gen_ai.request.model", "gpt-4o-mini")
                llm.set_attribute("gen_ai.usage.input_tokens", 182)
                llm.set_attribute("gen_ai.usage.output_tokens", 61)
                llm.set_attribute("llm.model_name", "gpt-4o-mini")
                llm.set_attribute("llm.token_count.prompt", 182)
                llm.set_attribute("llm.token_count.completion", 61)
                llm.set_attribute("input.value", json.dumps({"messages": messages}))
                llm.set_attribute("input.mime_type", "application/json")
                llm.set_attribute("output.value", ans)
            with tracer.start_as_current_span("tool-call") as tool:
                tool.set_attribute("openinference.span.kind", "TOOL")
                tool.set_attribute("tool.name", "lookup_order")
                tool.set_attribute("input.value", json.dumps({"order_id": 10000 + n}))
                tool.set_attribute(
                    "output.value",
                    json.dumps({"status": "in_transit", "carrier": "DHL", "eta": "Thursday"}),
                )
    provider.force_flush(120_000)
    provider.shutdown()
    print(json.dumps({"traces": a.traces, "spans": a.traces * 3, "seconds": round(time.time() - t0, 1)}))


if __name__ == "__main__":
    main()
