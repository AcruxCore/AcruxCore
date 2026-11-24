"""Send synthetic agent traces to an OTLP/HTTP endpoint, with backpressure.

Each trace is one agent turn with three spans: a root `agent-run`, an `llm-call`
child carrying a chat prompt and answer (~1.6 KB of text) and a `tool-call` child
(~0.3 KB). The content matches the 17 October 2026 self-hosting measurement, so
every tool receives byte-for-byte the same payloads.

Unlike a BatchSpanProcessor, which silently drops spans when its queue is full,
this sender exports each batch synchronously and retries until the server
accepts it. The time it reports is therefore the time the server took to
*accept* every span, and no span is ever lost on the client side.

  python load.py --endpoint URL [--header K=V] --traces 10000 --workers 4 --offset 0

Prints one JSON line: traces, spans, seconds, accepted spans per second, retries.
"""
import argparse
import json
import multiprocessing as mp
import time

from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import SpanExportResult

SYSTEM = (
    "You are a support agent for an online bookshop. Answer in two or three "
    "sentences. If an order is late, look it up with the order tool first."
)
ANSWER = (
    "Your order #{n} left our warehouse on Monday and is with the courier. "
    "The tracking page shows it arriving on Thursday before 6 pm. If it has "
    "not arrived by Friday, reply here and I will send a replacement at no cost."
)
BATCH = 300  # spans per export request (100 traces)


def question(n: int) -> str:
    return (
        f"Hi, I ordered three paperbacks last week (order #{n}) and the site "
        "still says 'processing'. I need them for a book club on Friday. Can "
        "you tell me where the parcel is and whether it will arrive in time? "
        "I paid for standard shipping, not express."
    ) * 2


class SyncBatcher(SpanProcessor):
    """Collect ended spans and export them in fixed batches, retrying until accepted."""

    def __init__(self, exporter: OTLPSpanExporter) -> None:
        self.exporter = exporter
        self.buf: list = []
        self.retries = 0

    def on_end(self, span) -> None:
        self.buf.append(span)
        if len(self.buf) >= BATCH:
            self.flush()

    def flush(self) -> None:
        if not self.buf:
            return
        failures, first_fail = 0, None
        while self.exporter.export(self.buf) != SpanExportResult.SUCCESS:
            self.retries += 1
            failures += 1
            first_fail = first_fail or time.time()
            # A 4xx (bad key) never recovers, and a server whose backend was OOM-killed can hang
            # each attempt for the full timeout; give up instead of retrying for an hour.
            if failures >= 30 or time.time() - first_fail > 600:
                raise RuntimeError(f"batch rejected {failures} times over {time.time() - first_fail:.0f} s")
            time.sleep(1)
        self.buf = []

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        self.flush()
        return True


def worker(args: tuple) -> int:
    endpoint, headers, start, count, service = args
    provider = TracerProvider(resource=Resource.create({"service.name": service}))
    batcher = SyncBatcher(OTLPSpanExporter(endpoint=endpoint, headers=headers, timeout=120))
    provider.add_span_processor(batcher)
    tracer = provider.get_tracer("selfhost-bench")
    for n in range(start, start + count):
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
    batcher.flush()
    return batcher.retries


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--endpoint", required=True)
    p.add_argument("--header", action="append", default=[])
    p.add_argument("--traces", type=int, default=1000)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--offset", type=int, default=0, help="first trace number, so runs never repeat content")
    p.add_argument("--service", default="bookshop-support-agent")
    a = p.parse_args()
    headers = dict(h.split("=", 1) for h in a.header)
    per = a.traces // a.workers
    jobs = [(a.endpoint, headers, a.offset + i * per, per, a.service) for i in range(a.workers)]
    t0 = time.time()
    with mp.Pool(a.workers) as pool:
        retries = sum(pool.map(worker, jobs))
    secs = time.time() - t0
    total = per * a.workers
    print(json.dumps({"traces": total, "spans": total * 3, "seconds": round(secs, 1),
                      "spans_per_s": round(total * 3 / secs), "retries": retries}))


if __name__ == "__main__":
    main()
