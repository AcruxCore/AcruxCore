# Medical-Information QA Agent Tutorial

Runnable scripts for the [Build a Medical-Information QA Agent](https://docs.acruxcore.com/tutorials/build-a-medical-information-qa-agent) tutorial.

## Start here if you are new

`notebook/medical_information_qa.ipynb` is the whole tutorial as one notebook, written for a
first-timer. It differs from the scripts in three useful ways:

- **It writes the five fixtures itself**, so it runs from the `.ipynb` alone with no `data/`
  folder to copy.
- **It checks up front** that your model really honours a strict schema, rather than
  discovering it later when the answer comes back as prose.
- **It verifies every citation** the agent produces against the real `## ` headings in the
  fixtures. This matters: a schema constrains shape, not truth, and across runs the model
  produced near-miss anchors (`#approved_indications`, `#section-approved-indications`, or
  the file name with no anchor at all) that satisfy the schema and point nowhere.

It also triggers four failure modes on purpose, including the quiet one: adding a docstring
to `check_safety_policy` makes the next `tools.sync()` replace a compliance-approved
description with the code's own, with no error.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install acruxcore "pydantic>=2" jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
jupyter lab notebook/medical_information_qa.ipynb
```

Every cell is find-or-create, so running it twice is safe. The model must support structured
outputs — `gpt-4o-mini` does; set `MODEL` in the notebook if yours differs.

## Prerequisites

- An AcruxCore API key and base URL (see the tutorial's Step 2)
- The `medical-information-qa` prompt created in the dashboard
- The four tools synced via `create_tools.py` (see Step 3)

## Setup

```bash
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
```

## Python

```bash
cd python
pip install acruxcore          # or: pip install acruxcore[dev]  (includes pydantic for the typed path)
python run_agent.py "What is Cortiblex approved to treat?"
```

With pydantic installed, the script automatically uses the typed `pydantic_response_format()` path. Without it, it falls back to the plain JSON-schema dict.

## TypeScript / Node

```bash
cd typescript
npm install @acruxcoreai/sdk   # or: npm install  (if inside the monorepo)
node run_agent.mjs "What is Cortiblex approved to treat?"
```

To use the zod path instead of the dict, install zod and uncomment the `MedicalInformationAnswer` block in `run_agent.mjs`.

## Data

The `data/` folder at the tutorial root contains the shared fixtures both scripts load:

- `drugs.json` — two fictional drugs (Neuravex, Cortiblex)
- `neuravex-pi.md` / `cortiblex-pi.md` — prescribing information
- `safety-policy.md` — refusal, adverse-event, and PII policies
- `inquiries.json` — sample prior inquiry records
