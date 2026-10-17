#!/usr/bin/env bash
# Second Langfuse run with the full protocol (adds the settled readings).
set -uo pipefail
cd "$(dirname "$0")"
L=$1; export PY=$2
./bench.sh up shb-langfuse2 http://localhost:43000/api/public/health -f "$L/docker-compose.yml" -f overrides/langfuse.yml > results/shb-langfuse2.up.log 2>&1
AUTH=$(printf 'pk-lf-bench:sk-lf-bench' | base64 -w0)
$PY load.py --endpoint http://localhost:43000/api/public/otel/v1/traces --header "Authorization=Basic $AUTH" > results/shb-langfuse2.load.txt 2>&1
./bench.sh after shb-langfuse2 > results/shb-langfuse2.after.log 2>&1
echo finished
