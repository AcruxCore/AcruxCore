"""Langfuse Cloud checks for the AcruxCore vs Langfuse post (run 2 November 2026).

Each check prints what Langfuse returned, so the output can be pasted into RUNLOG.md.

1. Two versions of one chat prompt, a custom label, and which version each read returns.
2. A text prompt that references another prompt with @@@langfusePrompt:...@@@.
3. What compile() does with Jinja-style {% if %} text.
4. One call through the drop-in OpenAI wrapper with no decorator or context manager,
   then the trace read back through the public API.

Needs LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST and OPENROUTER_KEY in the
environment (for example from a .env file). Prompt names start with `acxlf-`.
"""

import json
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(os.environ.get("ENV_FILE", ".env"))

from langfuse import Langfuse, get_client  # noqa: E402
from langfuse.openai import openai  # noqa: E402

PROMPTS = Path(__file__).resolve().parents[2] / "acruxcore-vs-langfuse-vs-langsmith" / "prompts"
NAME = "acxlf-scope-extract"

langfuse = Langfuse()


def check_versions() -> None:
    print("== 1. two versions, a custom label")
    for version, labels in ((1, ["production"]), (2, ["candidate"])):
        messages = json.loads((PROMPTS / f"scope-extract.v{version}.json").read_text())
        p = langfuse.create_prompt(
            name=NAME, type="chat", prompt=messages, labels=labels,
            commit_message=f"v{version} from scope-extract.v{version}.json",
        )
        print(f"created version {p.version}, labels {p.labels}")
    for label in (None, "production", "candidate", "latest"):
        kwargs = {"label": label} if label else {}
        p = langfuse.get_prompt(NAME, type="chat", cache_ttl_seconds=0, **kwargs)
        print(f"get_prompt(label={label!r}) -> version {p.version}, labels {p.labels}")


def check_reference() -> None:
    print("== 2. prompt reference")
    langfuse.create_prompt(
        name="acxlf-rate-card", type="text", labels=["production"],
        prompt="Extra page: $300. Extra language: $400. Newsletter signup: $150.",
    )
    langfuse.create_prompt(
        name="acxlf-price", type="text", labels=["production"],
        prompt="Price each request with this rate card:\n"
               "@@@langfusePrompt:name=acxlf-rate-card|label=production@@@\n\nRequest: {{request}}",
    )
    p = langfuse.get_prompt("acxlf-price", cache_ttl_seconds=0)
    print("stored text as served:", repr(p.prompt))
    print("compiled:", repr(p.compile(request="Add a Spanish version")))


def check_jinja() -> None:
    print("== 3. Jinja-style text in compile()")
    langfuse.create_prompt(
        name="acxlf-jinja-check", type="text", labels=["production"],
        prompt="{% if vip %}VIP customer. {% endif %}Hello {{name}}.",
    )
    p = langfuse.get_prompt("acxlf-jinja-check", cache_ttl_seconds=0)
    print("compiled:", repr(p.compile(vip="true", name="Ada")))


def check_wrapper_trace() -> None:
    print("== 4. drop-in OpenAI wrapper, no context manager")
    client = openai.OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_KEY"])
    r = client.chat.completions.create(
        model="openai/gpt-4o-mini", temperature=0, max_tokens=20,
        messages=[{"role": "user", "content": "Say OK."}],
        name="acxlf-wrapper-check",
    )
    print("reply:", r.choices[0].message.content)
    get_client().flush()
    host = os.environ["LANGFUSE_HOST"]
    auth = (os.environ["LANGFUSE_PUBLIC_KEY"], os.environ["LANGFUSE_SECRET_KEY"])
    for _ in range(12):
        time.sleep(5)
        data = httpx.get(f"{host}/api/public/traces", auth=auth,
                         params={"name": "acxlf-wrapper-check", "limit": 1}).json()["data"]
        if data:
            t = data[0]
            print("trace found:", t["id"], "name", t["name"], "observations", len(t.get("observations", [])))
            return
    print("no trace found after 60 s")


if __name__ == "__main__":
    import langfuse as lf_pkg
    print("langfuse", lf_pkg.__version__, "openai", openai.__version__, "host", os.environ["LANGFUSE_HOST"])
    import sys
    checks = {"versions": check_versions, "reference": check_reference,
              "jinja": check_jinja, "wrapper": check_wrapper_trace}
    for name in sys.argv[1:] or list(checks):
        checks[name]()
    langfuse.flush()
