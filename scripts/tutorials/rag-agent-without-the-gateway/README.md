# RAG Agent Without the Gateway Tutorial

The runnable script for the [Build a RAG agent without the gateway](https://docs.acruxcore.com/docs/tutorials/build-a-rag-agent-without-the-gateway) tutorial — RAG over the Acrux Core docs, calling OpenRouter directly (BYO), with prompts, tools, and traces still going through Acrux Core.

## Prerequisites

- An Acrux Core API key and base URL
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
