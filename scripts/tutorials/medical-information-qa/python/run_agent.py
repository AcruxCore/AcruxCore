"""
Medical-information QA agent -- Python, over the gateway.

One run_tool_loop() call with both tools and response_format set. result.content is the
shaped MedicalInformationAnswer JSON; result.iterations counts the tool-gathering rounds.
Supports both a plain JSON-schema dict (zero deps) and a pydantic BaseModel (typed, with
field descriptions the model reads) — the SDK accepts either interchangeably.
"""
import asyncio, json, re, sys
from pathlib import Path

from acruxcore import AcruxCore, acrux

DATA_DIR = Path(__file__).parent.parent / "data"
STOPWORDS = {"a", "an", "and", "any", "for", "in", "is", "it", "of", "on", "or", "the", "to", "with"}


def _tokens(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOPWORDS and len(w) > 2}


def _slugify(heading: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", heading.lower()).strip("-")


def _load_sections(filenames):
    sections = []
    for filename in filenames:
        text = (DATA_DIR / filename).read_text()
        for block in re.split(r"(?m)^## ", text)[1:]:
            heading, _, body = block.partition("\n")
            sections.append({"file": filename, "heading": heading.strip(), "slug": _slugify(heading.strip()), "body": body.strip()})
    return sections


@acrux.tool
async def get_drug_profile(query: str) -> dict:
    """Look up one of the team's committed synthetic drugs by id, brand name, or generic name.

    Args:
        query (str): A drug id (e.g. "NVX"), brand name (e.g. "Neuravex"), or
            generic name (e.g. "vexaline hydrochloride"). Case-insensitive.
    """
    q = query.strip().lower()
    drugs = json.loads((DATA_DIR / "drugs.json").read_text())
    for drug in drugs:
        if q in (drug["id"].lower(), drug["brand_name"].lower(), drug["generic_name"].lower()):
            return drug
    return {"error": f"No drug found matching '{query}'."}


@acrux.tool
async def get_inquiry(inquiry_id: str) -> dict:
    """Look up a synthetic prior medical-information inquiry record by its id.

    Args:
        inquiry_id (str): An inquiry id, e.g. "MIQ-101".
    """
    inquiries = json.loads((DATA_DIR / "inquiries.json").read_text())
    for inquiry in inquiries:
        if inquiry["id"].lower() == inquiry_id.strip().lower():
            return inquiry
    return {"error": f"No inquiry found with id '{inquiry_id}'."}


@acrux.tool
async def search_prescribing_info(query: str) -> list:
    """Token-overlap search over every committed markdown PI/policy fixture.

    Splits each file into '## '-delimited sections, scores each section by how
    many of the query's tokens it shares, and returns up to 3 top matches cited
    as `[source: filename.md#section-slug]`.

    Args:
        query (str): Free-text search query, e.g. drug name plus topic.
    """
    sections = _load_sections(["neuravex-pi.md", "cortiblex-pi.md", "safety-policy.md"])
    q_tokens = _tokens(query)
    scored = []
    for s in sections:
        overlap = len(q_tokens & _tokens(s["heading"] + " " + s["body"]))
        if overlap > 0:
            scored.append((overlap, s))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [{"source": f"{s['file']}#{s['slug']}", "snippet": s["body"][:400]} for _, s in scored[:3]]


_POLICY_TOPIC_SLUGS = {
    "response": "response-policy",
    "refusal": "refusal-policy",
    "adverse_event": "adverse-event-escalation-policy",
    "pii": "pii-redaction-policy",
}


@acrux.tool
async def check_safety_policy(topic: str) -> dict:
    # No docstring on purpose: the model-facing description is set in the dashboard
    # (Step 3), not in code. The code still owns this tool's *schema* (name + parameters),
    # so a sync commits the signature and sends no description, leaving the dashboard's
    # wording untouched.
    slug = _POLICY_TOPIC_SLUGS.get(topic)
    if slug is None:
        return {"error": f"Unknown policy topic '{topic}'. Valid: {list(_POLICY_TOPIC_SLUGS)}"}
    for s in _load_sections(["safety-policy.md"]):
        if s["slug"] == slug:
            return {"source": f"safety-policy.md#{slug}", "snippet": s["body"]}
    return {"error": f"Policy section '{slug}' not found."}


ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "disposition": {
            "type": "string",
            "enum": ["answer", "answer_with_limitations", "refuse_off_label", "refuse_personal_advice", "escalate_adverse_event"],
        },
        "answer": {"type": "string"},
        "safety_flags": {
            "type": "array",
            "items": {"type": "string", "enum": ["off_label", "personal_medical_advice", "adverse_event", "pii_redacted", "unsupported_claim"]},
        },
        "escalate_adverse_event": {"type": "boolean"},
        "pii_redacted": {"type": "boolean"},
        "redaction_notes": {"type": "array", "items": {"type": "string"}},
        "citations": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["disposition", "answer", "safety_flags", "escalate_adverse_event", "pii_redacted", "redaction_notes", "citations"],
    "additionalProperties": False,
}

# --- Alternative: pydantic class (typed, with field descriptions) ---
# Requires: pip install pydantic>=2
# The SDK converts this to the same wire dict as ANSWER_SCHEMA above.
# Field descriptions via Field(description=...) reach the model as per-field guidance.
try:
    from pydantic import BaseModel, Field
    from typing import Literal
    from acruxcore import pydantic_response_format

    class MedicalInformationAnswer(BaseModel):
        disposition: Literal[
            "answer", "answer_with_limitations", "refuse_off_label",
            "refuse_personal_advice", "escalate_adverse_event",
        ] = Field(description="The agent's decision: answer, refuse, or escalate.")
        answer: str = Field(description="The text the end user sees — a cited answer, a refusal, or an escalation notice.")
        safety_flags: list[str] = Field(description="Policy flags triggered on this turn, e.g. off_label, adverse_event, pii_redacted.")
        escalate_adverse_event: bool = Field(description="True when the question describes a suspected adverse event that must be escalated.")
        pii_redacted: bool = Field(description="True when personally identifiable information was found and redacted from the answer.")
        redaction_notes: list[str] = Field(description="What was redacted and why, one string per redaction.")
        citations: list[str] = Field(description="Source references, e.g. 'cortiblex-pi.md#approved-indications'.")

    _HAS_PYDANTIC = True
except ImportError:
    _HAS_PYDANTIC = False


async def main() -> None:
    question = sys.argv[1] if len(sys.argv) > 1 else (
        "What is Cortiblex approved to treat, and is it safe for someone with a fungal infection?"
    )
    tools = [get_drug_profile, get_inquiry, search_prescribing_info, check_safety_policy]

    async with AcruxCore() as hub:  # reads ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL
        rendered = await hub.prompts.render("medical-information-qa", "production", {"question": question})

        # One call, tools and response_format set together. result.content is the shaped
        # MedicalInformationAnswer JSON; result.iterations counts the tool-gathering rounds.
        #
        # Two ways to pass response_format — pick one:
        #   Dict (zero deps):   response_format={"type":"json_schema","json_schema":{...}}
        #   Pydantic (typed):   response_format=pydantic_response_format(MedicalInformationAnswer, name="medical_information_answer")
        if _HAS_PYDANTIC:
            response_format = pydantic_response_format(MedicalInformationAnswer, name="medical_information_answer")
        else:
            response_format = {
                "type": "json_schema",
                "json_schema": {"name": "medical_information_answer", "schema": ANSWER_SCHEMA, "strict": True},
            }
        result = await hub.gateway.run_tool_loop(
            rendered.model,
            [*rendered.messages],
            tools=tools,
            response_format=response_format,
            sync=False,  # already synced by create_tools.py
            prompt_version_id=rendered.version_id,
        )

        print(f"Question: {question}")
        print(f"(gathered over {result.iterations} tool round(s), trace {result.trace_id})\n")
        print(json.dumps(json.loads(result.content), indent=2))


if __name__ == "__main__":
    asyncio.run(main())
