# Langfuse AI Gateway vs LiteLLM vs AcruxCore, self-hosted

The scripts behind the blog post that measures three self-hosted LLM gateways on one
machine. Each gateway calls OpenAI `gpt-6-luna` with the same key, and a direct call to
OpenAI is the baseline.

| File | What it does |
|---|---|
| `latency-bench.mjs` | Interleaved rounds: non-streaming time and streaming time to first token, per path, with the added time against the direct call |
| `concurrency-bench.mjs` | N simultaneous streams through one gateway, with CPU and memory of its containers; also idle memory |
| `openai-edge-check.mjs` | Resolves `api.openai.com`, then measures connect time and a warm call through each of its addresses. Run it first, then pin one with `OPENAI_IP` |
| `set-tracing.sh` | Switches all three gateways to one tracing setting (`off`, `defaults`, `full`) |
| `litellm/` | LiteLLM proxy Compose file and its two configs (no logging, Langfuse logging) |
| `langfuse/compose.override.yml` | Frees the host ports Langfuse's own Compose file publishes for its databases |
| `acruxcore/compose.override.yml` | Runs AcruxCore's local Compose file in production mode |
| `results/` | The raw output of the runs in the post |

## Versions

- Langfuse `4.77.0` (web, worker and `ai-gateway`), from Langfuse's own `docker-compose.yml`.
- LiteLLM `ghcr.io/berriai/litellm:v1.108.4`, one worker, with Postgres. The benchmark calls it with a
  virtual key, so each call is checked against the database and its spend is written back.
- AcruxCore `2026.11.4` (the results were taken on an image built from the
  same code), from `docker-compose.local.yml` with `NODE_ENV=production`.

## Set up

1. **Langfuse.** Download its `docker-compose.yml`. Set `LANGFUSE_IMAGE_TAG=4.77.0`, the
   secrets it marks `CHANGEME`, `LANGFUSE_AI_GATEWAY_SERVICE_KEY` and
   `LANGFUSE_AI_GATEWAY_JWT_PRIVATE_KEY`, and the `LANGFUSE_INIT_*` variables. Then
   `docker compose -p lfbench up -d`. In **AI Gateway**, finish the setup, add an OpenAI
   credential and create a gateway key. The gateway listens on port 3031.
2. **LiteLLM.** `OPENAI_API_KEY=… docker compose -f litellm/docker-compose.yml up -d`.
   The master key is `sk-litellm-bench`, on port 4000. Create the virtual key the benchmark uses:
   `curl localhost:4000/key/generate -H 'Authorization: Bearer sk-litellm-bench' -d '{"models":["gpt-6-luna"]}'`.
3. **AcruxCore.** Follow
   [Self-host AcruxCore with Docker](https://docs.acruxcore.com/docs/getting-started/self-host-with-docker)
   with `WEB_PORT=8097`, `API_PORT=3097` and `ACRUXCORE_IMAGE_TAG` set to that release, and add
   `acruxcore/compose.override.yml`. Add an OpenAI credential, a model named
   `gpt-6-luna`, and an API key.

## Run

```bash
export OPENAI_API_KEY=… LANGFUSE_GW_KEY=… LITELLM_KEY=<virtual key> ACRUXCORE_KEY=…
export OPENAI_IP=162.159.140.245   # one api.openai.com address; see latency-bench.mjs
export LF_ORG=… LF_PROJECT_ID=… LF_EMAIL=… LF_PASSWORD=…

for mode in off defaults full; do
  ./set-tracing.sh $mode
  node latency-bench.mjs $mode 150 5
done

node concurrency-bench.mjs idle
for gw in langfuse litellm acruxcore; do
  docker update --cpus 2 "$(…the gateway container…)"
  node concurrency-bench.mjs $gw
done
```

The gateway containers are `lfbench-langfuse-ai-gateway-1`, `bench-litellm` and
`acruxcore-local-api`.

The tuned pass recreates each gateway with its `nofile.override.yml` (open-file limit 65,536;
LiteLLM also gets 2 workers) and runs the same loop. The results are the `-tuned` files.

The LiteLLM key-cache runs use `litellm/nofile-1-worker.override.yml`. Each run is
`node concurrency-bench.mjs litellm 500`, started either after 75 s with no calls (longer than
LiteLLM's 60 s in-memory key cache) or right after one call. They are collected in
`results/concurrency-litellm-key-cache.json`.

## Header image

`header.html` is the post's header, with the numbers above typed in by hand. To render it again:

```bash
google-chrome --headless=new --hide-scrollbars --window-size=1600,900 \
  --screenshot=header.png "file://$PWD/header.html"
```
