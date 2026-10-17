#!/usr/bin/env bash
# Full Agenta run: the self-host quick start (oss docker-compose.gh.yml, with-web + with-traefik),
# custom port 28080, images pinned to v0.122.7.
# Usage: run_agenta.sh <agenta repo checkout> <python with opentelemetry>
set -uo pipefail
cd "$(dirname "$0")"
A=$1; export PY=$2
O=$A/hosting/docker-compose/oss
cp $O/env.oss.gh.example $O/.env.oss.gh
grep -v '^#' overrides/agenta.env.patch | while IFS='=' read -r k v; do
  [ -z "$k" ] && continue
  if grep -q "^$k=" $O/.env.oss.gh; then sed -i "s|^$k=.*|$k=$v|" $O/.env.oss.gh; else echo "$k=$v" >> $O/.env.oss.gh; fi
done
export COMPOSE_PROJECT_NAME=shb-agenta  # traefik only routes containers of this project name
./bench.sh up shb-agenta http://localhost:28080/api/health --project-directory "$O" -f "$O/docker-compose.gh.yml" -f overrides/agenta.yml \
  --env-file "$O/.env.oss.gh" --profile with-web --profile with-traefik > results/shb-agenta.up.log 2>&1 || { echo "bench up failed, see results/shb-agenta.compose.log"; exit 1; }
# The admin API (Authorization: Access <AGENTA_AUTH_KEY>) creates a user, its org/workspace/project and an API key.
AUTH=$(grep '^AGENTA_AUTH_KEY=' $O/.env.oss.gh | cut -d= -f2-)
RESP=$(curl -s -H "Authorization: Access $AUTH" -H 'Content-Type: application/json' \
  -d '{"options":{"create_api_keys":true,"return_api_keys":true},"accounts":{"bench":{"user":{"email":"bench@example.com","name":"Bench"}}}}' \
  http://localhost:28080/api/admin/simple/accounts/)
KEY=$(echo "$RESP" | $PY -c 'import json,sys;d=json.load(sys.stdin);print(next(iter(d["accounts"]["bench"]["api_keys"].values())))')
[ -n "$KEY" ] || { echo "no API key: $RESP" > results/shb-agenta.load.txt; exit 1; }
echo "key prefix: ${KEY:0:6}" > results/shb-agenta.load.txt
$PY load.py --endpoint http://localhost:28080/api/otlp/v1/traces --header "Authorization=ApiKey $KEY" >> results/shb-agenta.load.txt 2>&1
./bench.sh after shb-agenta > results/shb-agenta.after.log 2>&1
docker exec shb-agenta-postgres-1 psql -U username -d agenta_oss_tracing -tAc \
  "select count(*) as spans, count(distinct trace_id) as traces from spans" >> results/shb-agenta.load.txt 2>&1
echo finished
