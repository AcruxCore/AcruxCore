"""LangSmith leg: the same scope-check app, traced and evaluated with LangSmith. No LangChain.

    pip install langsmith openai python-dotenv
    env: LANGSMITH_API_KEY, LANGSMITH_ENDPOINT, LANGSMITH_TRACING=true, ZAI_API_KEY

    python langsmith_push_prompts.py --version 1 --tag production   # once; needs langchain-core
    python langsmith_leg.py push-dataset
    python langsmith_leg.py run --id msg-06
    python langsmith_leg.py experiment --tag production --name v1
    python langsmith_leg.py live
"""

import argparse
import json
import os
import time

from openai import OpenAI

from common import API_KEY, BASE_URL, load_messages
from pipeline import build_app
from scoring import items_exact, judge_reply, total_exact

os.environ.setdefault("LANGSMITH_TRACING", "true")
os.environ.setdefault("LANGSMITH_PROJECT", "scope-check")

# --- instrumentation: everything LangSmith-specific the app needs -------------------------
from langsmith import Client, traceable
from langsmith.wrappers import wrap_openai

langsmith = Client()
client = wrap_openai(OpenAI(api_key=API_KEY, base_url=BASE_URL, max_retries=5, timeout=180))
ROLES = {"SystemMessagePromptTemplate": "system", "HumanMessagePromptTemplate": "user",
         "AIMessagePromptTemplate": "assistant"}


def pull_messages(name: str, tag: str):
    """Read a prompt commit without langchain-core: unpack LangChain's serialized manifest."""
    commit = langsmith.pull_prompt_commit(f"{name}:{tag}")
    messages = [{"role": ROLES[m["id"][-1]], "content": m["kwargs"]["prompt"]["kwargs"]["template"]}
                for m in commit.manifest["kwargs"]["messages"]]
    link = {"lc_hub_repo": name, "lc_hub_commit_hash": commit.commit_hash}  # links the call to the commit
    return messages, {"langsmith_extra": {"metadata": link}}


def make_app(tag: str = "production", only: set[str] | None = None):
    def step(name: str, kind: str):
        return traceable(name=name, run_type="tool" if kind == "tool" else "chain")

    # `only` limits `tag` to some prompts; the rest stay on production
    return build_app(lambda name: pull_messages(name, tag if not only or name in only else "production"),
                     client, step)
# --- end instrumentation -------------------------------------------------------------------

DATASET = "scope-check"


def push_dataset():
    dataset = langsmith.create_dataset(DATASET, description="30 client messages with expected items and totals")
    langsmith.create_examples(dataset_id=dataset.id, examples=[
        {"inputs": m["input"], "outputs": m["expected"], "metadata": {"message_id": m["id"]}}
        for m in load_messages()])
    print("dataset", DATASET, "examples", len(load_messages()))


def run_one(message_id: str):
    message = next(m for m in load_messages() if m["id"] == message_id)
    started = time.time()
    result = make_app()(**message["input"])
    seconds = round(time.time() - started, 1)
    langsmith.flush()
    print(json.dumps({"seconds": seconds, **result}, indent=1))


def experiment(tag: str, name: str, concurrency: int, only: set[str] | None = None):
    app = make_app(tag, only)
    judge_messages, judge_link = pull_messages("scope-judge", tag if not only or "scope-judge" in only else "production")

    def target(inputs: dict) -> dict:
        return app(**inputs)

    def items_eval(outputs: dict, reference_outputs: dict) -> dict:
        return {"key": "items_exact", "score": float(items_exact(outputs["items"], reference_outputs["items"]))}

    def total_eval(outputs: dict, reference_outputs: dict) -> dict:
        return {"key": "total_exact", "score": float(total_exact(outputs["total"], reference_outputs["total"]))}

    def judge_eval(inputs: dict, outputs: dict, reference_outputs: dict) -> dict:
        verdict = judge_reply(client, judge_messages, inputs["message"], reference_outputs, outputs["reply"],
                              judge_link)
        return {"key": "reply_judge", "score": float(verdict.get("verdict") == "PASS"),
                "comment": verdict.get("reason")}

    started = time.time()
    results = langsmith.evaluate(target, data=DATASET, evaluators=[items_eval, total_eval, judge_eval],
                                 experiment_prefix=name, max_concurrency=concurrency,
                                 metadata={"prompt_tag": tag, "only": ",".join(sorted(only)) if only else "all"})
    langsmith.flush()
    print("experiment", results.experiment_name)
    print("wall seconds", round(time.time() - started, 1))
    return results


def queue(experiment_name: str):
    """Put every root run of one experiment into a new annotation queue for human review."""
    # A rubric item is kept only if a feedback config with that key exists; otherwise it is dropped silently.
    if "human_reply_ok" not in {f.feedback_key for f in langsmith.list_feedback_configs()}:
        langsmith.create_feedback_config("human_reply_ok", feedback_config={
            "type": "categorical", "categories": [{"value": 1, "label": "send as is"},
                                                  {"value": 0, "label": "needs a fix"}]})
    review = langsmith.create_annotation_queue(
        name=f"review-{experiment_name}", description=f"Human review of experiment {experiment_name}",
        rubric_items=[{"feedback_key": "human_reply_ok",
                       "description": "Would you send this reply to the client as is?"}])
    run_ids = [r.id for r in langsmith.list_runs(project_name=experiment_name, is_root=True)]
    langsmith.add_runs_to_annotation_queue(review.id, run_ids=run_ids)
    print("queue", review.id, "runs", len(run_ids))


def live(tag: str):
    app = make_app(tag)
    for m in load_messages():
        started = time.time()
        result = app(**m["input"])
        print(m["id"], round(time.time() - started, 1), "s total", result["total"])
    langsmith.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("push-dataset")
    p = sub.add_parser("run"); p.add_argument("--id", default="msg-06")
    p = sub.add_parser("experiment"); p.add_argument("--tag", default="production"); p.add_argument("--name", required=True)
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--only", help="comma-separated prompts that use --tag; others use production")
    p = sub.add_parser("live"); p.add_argument("--tag", default="production")
    p = sub.add_parser("queue"); p.add_argument("--experiment", required=True)
    a = parser.parse_args()
    if a.cmd == "push-dataset": push_dataset()
    elif a.cmd == "run": run_one(a.id)
    elif a.cmd == "experiment": experiment(a.tag, a.name, a.concurrency, set(a.only.split(",")) if a.only else None)
    elif a.cmd == "live": live(a.tag)
    elif a.cmd == "queue": queue(a.experiment)
