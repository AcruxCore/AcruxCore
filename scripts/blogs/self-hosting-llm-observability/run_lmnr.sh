#!/usr/bin/env bash
# Full Laminar run: default (lite) compose with the repo's committed .env.
set -uo pipefail
cd "$(dirname "$0")"
L=$1; export PY=$2
export APP_SERVER_HOST_PORT=48000 APP_SERVER_GRPC_HOST_PORT=48001 APP_SERVER_RT_HOST_PORT=48002
./bench.sh up shb-lmnr http://localhost:5667/ --project-directory "$L" -f "$L/docker-compose.yml" -f overrides/lmnr.yml > results/shb-lmnr.up.log 2>&1
KEY=bench-laminar-project-key-0001
HASH=$(python3 -c "import hashlib;print(hashlib.sha3_256(b'$KEY').hexdigest())")
PG="docker exec shb-lmnr-postgres-1 psql -U postgres -d postgres -tAc"
$PG "insert into workspaces (id,name) values ('11111111-1111-1111-1111-111111111111','bench') on conflict do nothing;
     insert into projects (id,name,workspace_id) values ('22222222-2222-2222-2222-222222222222','bench','11111111-1111-1111-1111-111111111111') on conflict do nothing;
     insert into project_api_keys (name,project_id,shorthand,hash) values ('bench','22222222-2222-2222-2222-222222222222','bench','$HASH');" > results/shb-lmnr.load.txt 2>&1
$PY load.py --endpoint http://localhost:48000/v1/traces --header "Authorization=Bearer $KEY" >> results/shb-lmnr.load.txt 2>&1
./bench.sh after shb-lmnr > results/shb-lmnr.after.log 2>&1
echo finished
