#!/usr/bin/env bash
# ready.sh <url> [max_seconds] — prints seconds until <url> answers HTTP 2xx/3xx.
url=$1; max=${2:-900}; t0=$(date +%s.%N)
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url")
  if [[ $code =~ ^[23] ]]; then echo "ready_seconds=$(echo "$(date +%s.%N) - $t0" | bc | xargs printf '%.1f') code=$code"; exit 0; fi
  if (( $(echo "$(date +%s.%N) - $t0 > $max" | bc) )); then echo "TIMEOUT last_code=$code"; exit 1; fi
  sleep 1
done
