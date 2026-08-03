# Medical-Information QA Agent Tutorial

Runnable scripts for the [Build a Medical-Information QA Agent](https://docs.acruxcore.com/tutorials/build-a-medical-information-qa-agent) tutorial.

## Prerequisites

- An Acrux Core API key and base URL (see the tutorial's Step 2)
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
