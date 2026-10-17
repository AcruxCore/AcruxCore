#!/usr/bin/env bash
# bench.sh up    <project> <ready-url> <compose args...>  : cold start, 5 min idle, idle memory + disk
# bench.sh after <project>                                : 2 min after load, memory + disk + images;
#                                                           ~15 min after load, disk + memory again ("settled")
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-python3}
cmd=$1; project=$2; shift 2
case $cmd in
  up)
    url=$1; shift
    t0=$(date +%s)
    docker compose -p "$project" "$@" up -d > results/$project.compose.log 2>&1
    r=$(./ready.sh "$url" 900)
    echo "{\"project\":\"$project\",\"kind\":\"cold_start\",\"compose_up_returned_s\":$(( $(date +%s) - t0 )),\"$(echo $r | sed 's/ready_seconds=\([0-9.]*\).*/ready_after_up_s\":\1/')}" | tee -a results/$project.jsonl
    sleep 300
    $PY measure.py memory "$project" idle
    $PY measure.py disk "$project" idle
    ;;
  after)
    sleep 120
    $PY measure.py memory "$project" after_load
    $PY measure.py disk "$project" after_load
    $PY measure.py images "$project"
    # ClickHouse keeps merged-away parts for ~8 min; re-read disk once they are gone.
    sleep 600
    $PY measure.py disk "$project" settled
    $PY measure.py memory "$project" settled --samples 6
    ;;
esac
