# Run log: AcruxCore vs Langfuse, prompt checks on Langfuse Cloud

Run on 2 November 2026 against Langfuse Cloud, EU region (`https://cloud.langfuse.com`), the
same Hobby-plan project (`langfuse-vs-langsmith`) used for the October scope-check runs in
`scripts/blogs/langfuse-vs-langsmith/` and `scripts/blogs/acruxcore-vs-langfuse-vs-langsmith/`.
The Langfuse web UI reported version v4.72.0.

The measured comparison of the two platforms (tracing code, promotion, experiments, review,
live traffic) comes from those October runs. This run adds four checks that the AcruxCore vs
Langfuse post needed and that the October runs did not cover.

## Setup

- Python 3.12 through `uv run --no-project`, with `langfuse==5.1.0`, `openai==3.42.1`, `httpx`
  and `python-dotenv`.
- Keys from the repo `.env`: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` and
  `OPENROUTER_KEY`.
- Script: `python/langfuse_prompt_checks.py`. Every object it creates starts with `acxlf-`.

```bash
ENV_FILE=../../../.env uv run --no-project --python 3.12 \
  --with 'langfuse==5.1.0' --with 'openai==3.42.1' --with httpx --with python-dotenv \
  python python/langfuse_prompt_checks.py            # all four checks
```

## Check 1: two prompt versions, a custom label, and the diff view

`records/01-langfuse-prompt-checks.txt`.

- Created chat prompt `acxlf-scope-extract` from `scope-extract.v1.json` with the label
  `production`, then from `scope-extract.v2.json` with the label `candidate`. Langfuse added
  `latest` to each new version itself.
- `get_prompt(name)` with no label returned version 1 (`production`). `label="candidate"` and
  `label="latest"` returned version 2. So `candidate` is a label we named ourselves, and a read
  with no label serves production.
- In the UI, the prompt page has a "Compare with selected prompt" button. It opened "Changes
  v1 → v2": the stored messages side by side, removed text in red, added text in green, and a
  "Config" section ("No changes"). Screenshot:
  `apps/docs/static/img/blog/acruxcore-vs-langfuse/lf-prompt-diff-v1-v2.jpg`.

## Check 2: prompt references

- Created text prompt `acxlf-rate-card` and text prompt `acxlf-price`, whose text contains
  `@@@langfusePrompt:name=acxlf-rate-card|label=production@@@`.
- `get_prompt("acxlf-price")` returned the text with the rate card already filled in, and
  `compile(request=...)` then filled `{{request}}`. Langfuse resolves the reference on the
  server when the prompt is read.

## Check 3: `{% if %}` in a Langfuse template

- Created text prompt `acxlf-jinja-check` with the text
  `{% if vip %}VIP customer. {% endif %}Hello {{name}}.`
- `compile(vip="true", name="Ada")` returned `'{% if vip %}VIP customer. {% endif %}Hello Ada.'`.
  Langfuse fills `{{variables}}` and leaves `{% if %}` as plain text.

## Check 4: the drop-in OpenAI wrapper

`records/02-langfuse-wrapper-trace.txt`. The first attempt used the `OPENAI_API_KEY` in `.env`,
which OpenAI rejected with 401, so the check was re-run through OpenRouter
(`openai/gpt-4o-mini`).

- One `client.chat.completions.create(...)` call through `from langfuse.openai import openai`,
  with no `@observe` decorator and no context manager.
- The public API returned trace `f70444df876283b891144a096e7f8488`, named
  `acxlf-wrapper-check`, with one observation, within 5 seconds of `flush()`.
- So the wrapper creates one trace per call by default. A context manager or `@observe` is only
  needed to group several calls into one trace, which is what the October scope-check leg did.

## Prices and plan limits read the same day

Langfuse pricing (https://langfuse.com/pricing), read
2 November 2026: organization-level RBAC on every plan; project-level RBAC and enterprise SSO on
Pro with the Teams add-on ($300/month) or Enterprise; audit logs on Enterprise only; Hobby has
1 annotation queue and Core 3; additional usage $8 per 100,000 units. GitHub stars on 2 November
2026: `langfuse/langfuse` 36,881, `AcruxCore/AcruxCore` 12.
