#!/usr/bin/env bash
# After the overnight driver:
# 1. 4 GB capped runs again with per-container visible limits (v2 method; the first 4 GB runs used
#    the slice only, so JVM and ClickHouse sized themselves from the host's 62 GiB).
# 2. A second Langfuse full run for the ClickHouse space breakdown.
# AcruxCore is left out on purpose (owner, 2026-11-13): issue #851 gets fixed first, then AcruxCore
# is measured again on the released image (full, 2 GB and 4 GB runs).
set -uo pipefail
cd "$(dirname "$0")"
until grep -q "ALL DONE" results/run_all.log; do sleep 30; done
for t in langfuse phoenix mlflow opik; do
  echo "$(date +%T) followup cap $t 4G 2cpu" >> results/run_all.log
  $PY bench.py cap $t 4 2 >> results/run_all.log 2>&1 || echo "$(date +%T) followup cap $t FAILED" >> results/run_all.log
done
echo "$(date +%T) followup langfuse" >> results/run_all.log
RUN_TAG=-r2 $PY bench.py full langfuse >> results/run_all.log 2>&1
echo "$(date +%T) FOLLOWUP DONE" >> results/run_all.log
