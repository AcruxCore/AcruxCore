#!/usr/bin/env bash
# Overnight driver: full runs one tool at a time, then the capped "small VPS" runs.
# Host disk activity is logged throughout (another job may be downloading on this host).
set -uo pipefail
cd "$(dirname "$0")"
export UP=${UP:?} PY=${PY:-python}
vmstat -t 10 >> results/host-vmstat.log 2>&1 &
VM=$!
space_ok() {
  local free
  free=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
  [[ $free -ge 100 ]] || { echo "STOP: only ${free}G free" | tee -a results/run_all.log; return 1; }
}
for t in ${TOOLS:-langfuse acrux phoenix mlflow opik}; do
  space_ok || break
  echo "$(date +%T) full $t" >> results/run_all.log
  $PY bench.py full "$t" >> results/run_all.log 2>&1 || echo "$(date +%T) full $t FAILED" >> results/run_all.log
done
CAPS_DEFAULT="langfuse:4:2 acrux:4:2 phoenix:4:2 mlflow:4:2 opik:4:2 langfuse:2:1 acrux:2:1 phoenix:2:1 mlflow:2:1 opik:2:1 langfuse:8:4 opik:8:4"
for spec in ${CAPS:-$CAPS_DEFAULT}; do
  space_ok || break
  IFS=: read -r t gb cpus <<< "$spec"
  echo "$(date +%T) cap $t ${gb}G ${cpus}cpu" >> results/run_all.log
  $PY bench.py cap "$t" "$gb" "$cpus" >> results/run_all.log 2>&1 || echo "$(date +%T) cap $spec FAILED" >> results/run_all.log
done
kill $VM
echo "$(date +%T) ALL DONE" >> results/run_all.log
