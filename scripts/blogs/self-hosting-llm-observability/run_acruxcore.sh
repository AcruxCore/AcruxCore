#!/usr/bin/env bash
# Full AcruxCore run: the README quickstart compose (docker-compose.local.yml), published images.
set -uo pipefail
cd "$(dirname "$0")"
REPO=$1; export PY=$2
./bench.sh up shb-acrux http://localhost:43001/api/v1/health --project-directory "$REPO" -f "$REPO/docker-compose.local.yml" -f overrides/acruxcore.yml > results/shb-acrux.up.log 2>&1
API=http://localhost:43001/api/v1
CK=$(curl -s -D - -o /dev/null -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
  -d '{"email":"bench@example.com","password":"bench-password-0001","name":"Bench"}' $API/auth/sign-up/email \
  | grep -i '^set-cookie:.*session_token' | head -1 | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//')
KEY=$(curl -s -H "Cookie: $CK" -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' -d '{"name":"bench"}' $API/api-keys | $PY -c 'import json,sys;print(json.load(sys.stdin)["key"])')
echo "key prefix: ${KEY:0:10}" > results/shb-acrux.load.txt
$PY load.py --endpoint $API/traces/otlp --header "Authorization=Bearer $KEY" >> results/shb-acrux.load.txt 2>&1
./bench.sh after shb-acrux > results/shb-acrux.after.log 2>&1
echo finished
