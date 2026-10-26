# Improve a RAG Agent from User Feedback

The runnable scripts for the
[Improve a RAG agent from user feedback](https://docs.acruxcore.com/docs/tutorials/improve-a-rag-agent-from-feedback)
tutorial. Brewline's support agent searches the shop's policies and looks up orders. You mark its
wrong answers, let the optimizer draft prompt rewrites, run the whole agent on each rewrite, and
promote the one that wins.

## Start here if you are new

`notebook/improve_rag_agent.ipynb` is the whole tutorial as one notebook. The policies, orders and
questions are inline. Each step shows the dashboard values and the code, and the checks read the
traces and run reports back from the API. It ends with four mistakes triggered on purpose.

It renders on GitHub with its saved output, so you can read it before running anything. To run it:

```bash
pip install --upgrade acruxcore "pymilvus[model]" jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export MILVUS_URI=http://localhost:19530
jupyter lab notebook/improve_rag_agent.ipynb
```

Every creating cell looks for what exists first, so running it twice is safe. A second run
reuses the first run's optimize run, and starts from the version you promoted.

## Prerequisites

- An AcruxCore API key and base URL
- A model provider connected under **Gateway → Credentials**, and two models under
  **Gateway → Models** (the scripts default to `gpt-4o-mini` and `gpt-4.1`)
- Python 3.9+ and `pip install acruxcore "pymilvus[model]"`
- A running [Milvus](https://milvus.io/docs/install-overview.md), the vector database that stores
  the policies. Set `MILVUS_URI` to its address; the default is `http://localhost:19530`.

## Setup

```bash
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export ACRUXCORE_MODEL=gpt-4o-mini           # runs the agent
export ACRUXCORE_STRONG_MODEL=gpt-4.1        # drafts rewrites and grades answers
export MILVUS_URI=http://localhost:19530
cd python
```

## Run, in order

```bash
python setup_prompt.py                                   # creates the brewline-support prompt
python index_policies.py                                 # stores the policy paragraphs in Milvus
python agent.py                                          # asks the six questions, prints trace ids
python leave_feedback.py <trace-id> "Wrong. ... Correct answer: ..."
python improve.py                                        # feedback -> dataset -> optimize run
python test_candidate.py <optimize-run-id>               # whole agent on production and each candidate
python promote.py <optimize-run-id> candidate-A          # moves production to the winner
```

## Files

- `data/policies/*.md` — the four policy files `index_policies.py` stores in Milvus
- `data/orders.json` — the orders `lookup_order` reads
- `data/questions.json` — the six questions `agent.py` asks
- `data/regression_checks.json` — questions the agent already answers well, with criteria
- `notebook/improve_rag_agent.ipynb` — the whole tutorial as one runnable notebook, with saved output
- `python/index_policies.py` — splits the policies into paragraphs and indexes them in Milvus
- `python/agent.py` — the Milvus search, the two tools and the agent
