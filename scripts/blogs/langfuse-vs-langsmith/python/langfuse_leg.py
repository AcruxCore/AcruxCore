"""Langfuse leg: the same scope-check app, traced and evaluated with Langfuse.

    pip install langfuse openai python-dotenv
    env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST, ZAI_API_KEY

    python langfuse_leg.py push-prompts --version 1 --label production
    python langfuse_leg.py push-dataset
    python langfuse_leg.py run --id msg-06
    python langfuse_leg.py experiment --label production --name v1
    python langfuse_leg.py live
"""

import argparse
import asyncio
import json
import time

from common import API_KEY, BASE_URL, PROMPT_NAMES, load_messages, load_prompt_file
from pipeline import build_app
from scoring import items_exact, judge_reply, total_exact

# --- instrumentation: everything Langfuse-specific the app needs -------------------------
from langfuse import Evaluation, get_client, observe
from langfuse.openai import OpenAI  # drop-in OpenAI client that traces every call

langfuse = get_client()
client = OpenAI(api_key=API_KEY, base_url=BASE_URL, max_retries=5, timeout=180)


def make_app(label: str = "production", only: set[str] | None = None):
    def get_prompt(name: str):  # `only` limits `label` to some prompts; the rest stay on production
        prompt = langfuse.get_prompt(name, label=label if not only or name in only else "production", type="chat")
        return prompt.prompt, {"langfuse_prompt": prompt}  # links the call to the version

    def step(name: str, kind: str):
        return observe(name=name, as_type="tool" if kind == "tool" else "span")

    return build_app(get_prompt, client, step)
# --- end instrumentation -------------------------------------------------------------------

DATASET = "scope-check"


def push_prompts(version: int, label: str | None, names: list[str] = PROMPT_NAMES):
    for name in names:
        prompt = langfuse.create_prompt(
            name=name, type="chat", prompt=load_prompt_file(name, version),
            labels=[label] if label else [], commit_message=f"v{version} from prompts/{name}.v{version}.json",
        )
        print(name, "-> Langfuse version", prompt.version, "labels", prompt.labels)


def push_dataset():
    langfuse.create_dataset(name=DATASET, description="30 client messages with expected items and totals")
    for m in load_messages():
        langfuse.create_dataset_item(dataset_name=DATASET, id=f"{DATASET}-{m['id']}", input=m["input"],
                                     expected_output=m["expected"], metadata={"message_id": m["id"]})
    langfuse.flush()
    print("dataset", DATASET, "items", len(load_messages()))


def run_one(message_id: str):
    message = next(m for m in load_messages() if m["id"] == message_id)
    started = time.time()
    result = make_app()(**message["input"])
    seconds = round(time.time() - started, 1)
    langfuse.flush()
    print(json.dumps({"seconds": seconds, **result}, indent=1))


def experiment(label: str, name: str, concurrency: int, sync: bool = False, only: set[str] | None = None):
    app = make_app(label, only)
    judge = langfuse.get_prompt("scope-judge", label=label if not only or "scope-judge" in only else "production",
                                type="chat")

    # run_experiment calls the task inside its event loop. A plain def blocks that loop, so items
    # run one at a time whatever max_concurrency says. An async task that hands the work to a
    # thread lets max_concurrency items run at once.
    def sync_task(*, item, **kwargs):
        return app(**item.input)

    async def async_task(*, item, **kwargs):
        return await asyncio.to_thread(app, **item.input)

    def items_eval(*, output, expected_output, **kwargs):
        return Evaluation(name="items_exact", value=float(items_exact(output["items"], expected_output["items"])))

    def total_eval(*, output, expected_output, **kwargs):
        return Evaluation(name="total_exact", value=float(total_exact(output["total"], expected_output["total"])))

    async def judge_eval(*, input, output, expected_output, **kwargs):
        verdict = await asyncio.to_thread(judge_reply, client, judge.prompt, input["message"], expected_output,
                                          output["reply"], {"langfuse_prompt": judge})
        return Evaluation(name="reply_judge", value=float(verdict.get("verdict") == "PASS"),
                          comment=verdict.get("reason"))

    dataset = langfuse.get_dataset(DATASET)
    started = time.time()
    result = dataset.run_experiment(name=name, run_name=name, task=sync_task if sync else async_task,
                                    evaluators=[items_eval, total_eval, judge_eval],
                                    max_concurrency=concurrency, metadata={"prompt_label": label})
    langfuse.flush()
    print(result.format())
    print("wall seconds", round(time.time() - started, 1))
    return result


def queue(run_name: str):
    """Put every trace of one experiment run into a new annotation queue for human review."""
    from langfuse.api import AnnotationQueueObjectType, ScoreConfigDataType
    config = langfuse.api.score_configs.create(name="human_reply_ok", data_type=ScoreConfigDataType.BOOLEAN,
                                               description="Would you send this reply to the client as is?")
    review = langfuse.api.annotation_queues.create_queue(name=f"review-{run_name}", score_config_ids=[config.id],
                                                         description=f"Human review of experiment {run_name}")
    run = langfuse.api.datasets.get_run(DATASET, run_name)
    for item in run.dataset_run_items:
        langfuse.api.annotation_queues.create_queue_item(review.id, object_id=item.trace_id,
                                                         object_type=AnnotationQueueObjectType.TRACE)
    print("queue", review.id, "items", len(run.dataset_run_items))


def live(label: str):
    app = make_app(label)
    for m in load_messages():
        started = time.time()
        result = app(**m["input"])
        print(m["id"], round(time.time() - started, 1), "s total", result["total"])
    langfuse.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("push-prompts"); p.add_argument("--version", type=int, default=1); p.add_argument("--label")
    p.add_argument("--names", help="comma-separated prompt names (default: all four)")
    sub.add_parser("push-dataset")
    p = sub.add_parser("run"); p.add_argument("--id", default="msg-06")
    p = sub.add_parser("experiment"); p.add_argument("--label", default="production"); p.add_argument("--name", required=True)
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--sync", action="store_true", help="plain def task (runs items one at a time)")
    p.add_argument("--only", help="comma-separated prompts that use --label; others use production")
    p = sub.add_parser("live"); p.add_argument("--label", default="production")
    p = sub.add_parser("queue"); p.add_argument("--run", required=True)
    a = parser.parse_args()
    if a.cmd == "push-prompts": push_prompts(a.version, a.label, a.names.split(",") if a.names else PROMPT_NAMES)
    elif a.cmd == "push-dataset": push_dataset()
    elif a.cmd == "run": run_one(a.id)
    elif a.cmd == "experiment": experiment(a.label, a.name, a.concurrency, a.sync, set(a.only.split(",")) if a.only else None)
    elif a.cmd == "live": live(a.label)
    elif a.cmd == "queue": queue(a.run)
