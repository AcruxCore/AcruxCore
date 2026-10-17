"""AcruxCore leg written with the acruxcore Python SDK, instead of plain HTTP calls.

The SDK calls z.ai itself (bring your own key, the same position as the other two legs) and
reports each model call under the step it ran in.

Needs acruxcore 0.18.0 or newer (it uses AcruxCoreSync, traces.step and prompts.get_by_alias).

    pip install acruxcore openai httpx python-dotenv
    python acruxcore_sdk_leg.py run --id msg-06
    python acruxcore_sdk_leg.py experiment --name sdk-v1

Commands and records are the same as acruxcore_leg.py; only the instrumentation block differs.
"""

import argparse
import functools

import acruxcore_leg as base
from acruxcore_leg import ACX_BASE_URL, ACX_KEY
from common import API_KEY, BASE_URL
from pipeline import build_app

# --- instrumentation: everything AcruxCore-specific the app needs -------------------------
from types import SimpleNamespace
from acruxcore import AcruxCoreSync

hub = AcruxCoreSync(ACX_KEY, ACX_BASE_URL, timeout=180,
                    provider={"base_url": BASE_URL, "api_key": API_KEY})


def _create(*, model, messages, acx_prompt_version=None, **params):  # a z.ai call, traced
    result = hub.gateway.chat(model, messages, prompt_version_id=acx_prompt_version, **params)
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=result.content))])


client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=_create)))


def step(name: str, kind: str):
    return hub.traces.step(name, kind=kind)


def make_app(alias: str = "production", only: set[str] | None = None):
    def get_prompt(name: str):  # `only` limits `alias` to some prompts; the rest stay on production
        version = hub.prompts.get_by_alias(name, alias if not only or name in only else "production")
        return version.messages, {"acx_prompt_version": version.id}  # links the call to the version

    return build_app(get_prompt, client, step)
# --- end instrumentation -------------------------------------------------------------------


def _step_noting_trace(name: str, kind: str):
    """Harness, not instrumentation: the experiment upload needs each item's trace id."""
    traced = hub.traces.step(name, kind=kind)

    def decorate(fn):
        @functools.wraps(fn)
        def noting(*args, **kwargs):
            base.last.trace_id = traced.trace_id  # the step open in this thread
            return fn(*args, **kwargs)
        return traced(noting)
    return decorate


step = _step_noting_trace  # make_app reads `step` when it is called
base.make_app = make_app   # the commands in acruxcore_leg.py now run this leg's app

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run"); p.add_argument("--id", default="msg-06")
    p = sub.add_parser("experiment"); p.add_argument("--alias", default="production"); p.add_argument("--name", required=True)
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--only", help="comma-separated prompts that use --alias; others use production")
    p = sub.add_parser("live"); p.add_argument("--alias", default="production")
    a = parser.parse_args()
    if a.cmd == "run": base.run_one(a.id)
    elif a.cmd == "experiment": base.experiment(a.alias, a.name, a.concurrency, set(a.only.split(",")) if a.only else None)
    elif a.cmd == "live": base.live(a.alias)
    hub.close()
