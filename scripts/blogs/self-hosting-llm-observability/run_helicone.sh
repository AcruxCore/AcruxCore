#!/usr/bin/env bash
# Helicone after workarounds: 5 min idle, idle readings, 1,000 logs, after-load readings.
set -uo pipefail
cd "$(dirname "$0")"
export PY=$1
sleep 300
$PY measure.py memory shb-helicone idle
$PY measure.py disk shb-helicone idle
$PY load_helicone.py --base http://localhost:48585 --key sk-helicone-bench-0000000-0000000-0000000 > results/shb-helicone.load.txt 2>&1
./bench.sh after shb-helicone > results/shb-helicone.after.log 2>&1
echo finished
