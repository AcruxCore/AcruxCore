"""Settings and data shared by every leg. Nothing in this file knows about any platform."""

import json
import os
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "data"
PROMPTS = ROOT / "prompts"

# Load the repo .env when run from the monorepo; a standalone copy reads its own .env or the shell.
load_dotenv(ROOT.parents[2] / ".env")
load_dotenv()

# One model for every call in every leg, the judge included. SCOPE_MODEL overrides it.
MODEL = os.getenv("SCOPE_MODEL", "glm-5.3")
# z.ai's OpenAI-compatible API. The general endpoint is https://api.z.ai/api/paas/v4/;
# the GLM Coding Plan endpoint below is the one our key can use.
BASE_URL = os.getenv("ZAI_BASE_URL", "https://api.z.ai/api/coding/paas/v4/")
API_KEY = os.getenv("ZAI_API_KEY") or os.getenv("Z_AI_TEMP_KEY")
# GLM-5.3 always thinks; "low" keeps it short. "disabled" is rejected on the general endpoint.
MODEL_PARAMS = {"reasoning_effort": "low"}

PROMPT_NAMES = ["scope-extract", "scope-classify", "scope-reply", "scope-judge"]


def load_scope() -> str:
    return (DATA / "scope.md").read_text()


def load_rate_card() -> dict:
    return json.loads((DATA / "rate_card.json").read_text())


def load_messages() -> list[dict]:
    return json.loads((DATA / "messages.json").read_text())


def load_prompt_file(name: str, version: int = 1) -> list[dict]:
    """Chat messages with {{variable}} placeholders, as stored in prompts/<name>.v<N>.json."""
    return json.loads((PROMPTS / f"{name}.v{version}.json").read_text())


def render(messages: list[dict], **variables) -> list[dict]:
    """Replace each {{name}} with its value. Plain substitution, no HTML escaping."""
    out = []
    for m in messages:
        content = m["content"]
        for key, value in variables.items():
            content = content.replace("{{" + key + "}}", str(value))
        out.append({"role": m["role"], "content": content})
    return out
