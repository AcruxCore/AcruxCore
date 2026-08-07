# Tag & Filter Traces Tutorial

Runnable scripts for the [Tag & filter traces](https://docs.acruxcore.com/docs/guides/tag-and-filter-traces) guide.

Each script walks the same five steps:

1. **Trace tags via `chat()`** -- attach `tags` + `metadata` to a trace through the SDK's `trace` option.
2. **Trace tags via `runToolLoop()`** -- a second call with the same `trace` option, tags + metadata on the trace.
3. **Read the trace back** with `getTrace()` / `get_trace()` to confirm the tags landed.
4. **Filter traces by tag and metadata** over REST (the SDK's `listTraces()` / `list_traces()` has no tag/metadata filters yet).
5. **List tag and metadata facets** over REST.

## Prerequisites

- An AcruxCore API key and base URL
- A model alias configured on your gateway
- Python 3.11+ or Node 22+

## Setup

```bash
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=http://localhost:3001/api/v1   # or https://api.acruxcore.com/api/v1
export ACRUXCORE_MODEL=mimo-v2.5                          # any alias on your gateway
```

## Python

```bash
cd python
pip install acruxcore requests
python tag_traces.py
```

## TypeScript / Node

```bash
cd typescript
npm install @acruxcoreai/sdk
node tag-traces.mjs
```

## Expected output

Both scripts print five numbered sections. Step 3 confirms the tags round-tripped:

```
3. Read the trace back (getTrace)
trace tags     : [ 'prod', 'tag-filter-demo' ]
trace metadata : { env: 'prod', requestId: '...' }
```

Steps 4 and 5 show the trace you just tagged showing up in the tag/metadata filters and the facets lists.
