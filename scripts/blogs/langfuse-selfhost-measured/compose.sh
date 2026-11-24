#!/usr/bin/env bash
# compose.sh <tool> <project> <compose args...> — the exact compose command per tool.
# UP = shallow clones of the upstream repos (see NOTES.md for commits); REPO = this repo.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
UP=${UP:?set UP to the folder holding the upstream clones}
REPO=${REPO:-$(cd "$D/../../.." && pwd)}
tool=$1; project=$2; shift 2
EXTRA=()
[[ -n "${CAP_FILE:-}" ]] && EXTRA=(-f "$CAP_FILE")
case $tool in
  langfuse) exec docker compose -p "$project" -f "$UP/langfuse/docker-compose.yml" -f "$D/overrides/langfuse.yml" "${EXTRA[@]}" "$@" ;;
  phoenix)  exec docker compose -p "$project" -f "$UP/phoenix/docker-compose.yml" -f "$D/overrides/phoenix.yml" "${EXTRA[@]}" "$@" ;;
  mlflow)   exec docker compose -p "$project" --env-file "$D/overrides/mlflow.env" -f "$UP/mlflow/docker-compose/docker-compose.yml" -f "$D/overrides/mlflow.yml" "${EXTRA[@]}" "$@" ;;
  opik)     OPIK_VERSION=2.2.143 exec docker compose -p "$project" -f "$UP/opik/deployment/docker-compose/docker-compose.yaml" -f "$D/overrides/opik.yml" "${EXTRA[@]}" --profile opik "$@" ;;
  acrux)    exec docker compose -p "$project" --project-directory "$REPO" -f "$REPO/docker-compose.local.yml" -f "$D/overrides/acruxcore.yml" "${EXTRA[@]}" "$@" ;;
esac
