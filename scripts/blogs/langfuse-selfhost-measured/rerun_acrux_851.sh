#!/usr/bin/env bash
# Re-measure AcruxCore after issue #851 on images built from staging 241f233 (owner: release to main after the article).
set -u
D=$(cd "$(dirname "$0")" && pwd); cd "$D"
export UP=${UP:?set UP to the upstream clones} PY=${PY:-python} PYTHONUNBUFFERED=1 ACX_IMAGE_TAG=staging-241f233 REPO=${REPO:?set REPO to an AcruxCore checkout at 241f233} RUN_TAG=-851 CAP_TAG=-v2-851
L=results/run_all.log
echo "$(date +%T) RERUN851 START" >> $L
python bench.py full acrux >> $L 2>&1 || echo "$(date +%T) FAILED full acrux" >> $L
python bench.py cap acrux 2 1 >> $L 2>&1 || echo "$(date +%T) FAILED cap acrux 2 1" >> $L
python bench.py cap acrux 4 2 >> $L 2>&1 || echo "$(date +%T) FAILED cap acrux 4 2" >> $L
echo "$(date +%T) FOLLOWUP DONE" >> $L
