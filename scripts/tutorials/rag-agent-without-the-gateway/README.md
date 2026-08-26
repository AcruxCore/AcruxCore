# RAG Agent Without the Gateway Tutorial

The runnable script for the [Build a RAG agent without the gateway](https://docs.acruxcore.com/docs/tutorials/build-a-rag-agent-without-the-gateway) tutorial — RAG over the AcruxCore docs, calling OpenRouter directly (BYO), with prompts, tools, and traces still going through AcruxCore.

## Start here if you are new

`notebook/acrux_rag.ipynb` is the whole tutorial as one notebook, written for a first-timer: a
preflight cell that checks both keys and whether OpenRouter really serves embeddings (its own
model list says it does not); the two prompts created with the dashboard route beside the code;
the index built chunk by chunk; a live read of the traces both answering styles produce,
including the empty `costUsd` that BYO always has; and four real ways to get BYO wrong,
triggered on purpose so you can read the actual error.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install acruxcore chromadb requests beautifulsoup4 jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export OPENROUTER_API_KEY=<your OpenRouter key>
jupyter lab notebook/acrux_rag.ipynb
```

## Prerequisites

- An AcruxCore API key and base URL
- An OpenRouter API key
- Python 3.9+ (`pip install acruxcore chromadb requests beautifulsoup4`)

## Setup

```bash
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export OPENROUTER_API_KEY=sk-or-...
```

## Run

```bash
cd python
python acrux_rag.py --setup                                              # one-time: creates the two prompts
python acrux_rag.py "How do I register a new model on the gateway?"      # answers both linearly and agentically
```

## Expected output

The script indexes 5 docs pages into an in-memory Chroma collection, then
answers the question two ways: once by always retrieving first (`Linear RAG`),
once by letting the model call a `search_docs` tool as needed (`Agentic RAG`).
Both runs land in their own trace.
