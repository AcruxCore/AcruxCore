# Self-hosting Langfuse vs four alternatives at 100,000 traces

The harness and raw readings behind
[Self-hosting Langfuse vs four alternatives at 100,000 traces](https://acruxcore.com/blog/self-hosting-langfuse-100k-traces).
It starts each tool from its official Docker Compose file, sends synthetic agent traces over
OTLP/HTTP, and records boot time, memory, disk, ingest time and API read latency.

## Run it

You need Docker with Compose, Python 3.10 or newer, and at least 20 GB of memory for Opik.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# The upstream Compose files, at the commits we measured.
export UP=$PWD/upstream && mkdir -p "$UP"
git clone https://github.com/langfuse/langfuse "$UP/langfuse" && git -C "$UP/langfuse" checkout 6decf5a
git clone https://github.com/Arize-ai/phoenix  "$UP/phoenix"  && git -C "$UP/phoenix"  checkout 588d0e8
git clone https://github.com/mlflow/mlflow     "$UP/mlflow"   && git -C "$UP/mlflow"   checkout b355c42
git clone https://github.com/comet-ml/opik     "$UP/opik"     && git -C "$UP/opik"     checkout c722c7d

# AcruxCore runs from this repository's docker-compose.local.yml with the published images.
export REPO=$(git rev-parse --show-toplevel)

./run_all.sh            # every full run, then every capped run, one tool at a time
python summarize.py     # prints the post's tables from results/
```

To test one tool: `python bench.py full <tool>` or `python bench.py cap <tool> <GB> <CPUs>`,
where `<tool>` is `langfuse`, `phoenix`, `mlflow`, `opik` or `acrux`. Set `ACX_IMAGE_TAG` to
test another AcruxCore release.

## Files

- `bench.py`: the test steps; its docstring says what each phase measures.
- `load.py`: the trace sender, 4 processes with synchronous batches and retry.
- `measure.py`: memory from `docker stats` and disk from volume sizes.
- `compose.sh`: the exact Compose command for each tool.
- `overrides/`: every change made to each official setup (ports, subnet, pinned version, login).
- `results/`: every reading as JSON lines, plus every `docker stats` sample during ingest.
- `NOTES.md`: method notes, the evidence behind each claim, and incidents during the run.

If your numbers differ from ours, open an issue with your `results/` files.
