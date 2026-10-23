# Notes — self-hosting LLM observability, measured

Internal notes behind the blog post
`apps/docs/blog/2026-10-17-self-hosting-llm-observability.md`
(acruxcore.com/blog/self-hosting-llm-observability). Nothing here is shown
on the page. `header.html` renders the post's header image
(`apps/docs/static/img/blog/self-hosting-llm-observability/header.png`, 1200x630).

## What this is

A measurement of the official self-host setup of seven open-source LLM
observability tools, AcruxCore included, run with one harness on one machine.
It was first drafted as a HackerNoon original; on 2026-10-17 the owner moved it
to the AcruxCore blog instead. See cross-cutting FAQ Q108.

## Relation to PR #518

PR #518 holds an unpublished Medium draft from 2026-09-17 on the same subject
(includes AcruxCore and Braintrust, builds Helicone from source, sums compressed
`docker save` sizes). This post measures more (trace load, disk growth, settled
readings, the documented Helicone image, the MLflow compose failure). If #518 is
ever published, it should be reworked to link here rather than repeat these
numbers.

## Method (reproducible)

Everything is in this folder:

- `load.py` — 1,000 traces × 3 spans over OTLP/HTTP, deterministic content.
- `load_helicone.py` — 1,000 request logs (same prompt/answer) for Helicone.
  Helicone was measured but is not in the post (see "Helicone dropped" below).
- `measure.py` — images / memory (12× `docker stats`, median) / disk (`du` of
  each project volume + container writable layers).
- `bench.sh` — up → ready → 5 min idle → readings; after → 2 min → readings →
  10 more min → settled readings.
- `run_lmnr.sh`, `run_helicone.sh`, `run_langfuse2.sh`, `run_acruxcore.sh`, `run_agenta.sh` — per-tool pipelines.
- `overrides/` — the only changes made to each official setup (ports, pins,
  and the disclosed fixes).
- `results/*.jsonl` — every raw reading. `python3 summarize.py` prints the table.

Host: 24 cores, 62 GiB, Fedora (kernel 7.1), Docker 29.8.2, Compose 5.6.0.
Other unrelated stacks were running on the host throughout (same for all seven).
AcruxCore was measured on 2026-10-11, 00:57–01:20 PKT, Agenta on 2026-10-17,
21:33–21:56 PKT, the others on 2026-10-10.
Upstream repos were shallow-cloned on 2026-10-10 into the session scratchpad.

## Versions measured

| Tool | Setup used | Version |
|---|---|---|
| Phoenix | repo `docker-compose.yml` (Postgres), published image instead of source build, as the docs show | `arizephoenix/phoenix:version-20.20.0` |
| Langfuse | repo `docker-compose.yml` + headless init env | `4.56.0` web + worker |
| Opik | `deployment/docker-compose` + `--profile opik` (what `./opik.sh` runs) | `OPIK_VERSION=2.2.96` |
| MLflow | repo `docker-compose/` + `.env.dev.example` | `ghcr.io/mlflow/mlflow:v3.17.0` (= `latest`) |
| Laminar | repo default `docker-compose.yml` (lite) + committed `.env` | untagged `latest`, images built 2026-09-13 (release v0.2.5) |
| AcruxCore | README quickstart `docker-compose.local.yml`, published Docker Hub images | `acruxcore/{api,worker,web}:latest`, pulled 2026-10-11, api revision `97fe8ee` |
| Agenta | self-host quick start: `hosting/docker-compose/oss/docker-compose.gh.yml`, `--profile with-web --profile with-traefik`, `env.oss.gh.example` + custom-port section | `ghcr.io/agenta-ai/agenta-*:v0.122.7` (= `latest` on 2026-10-17), repo commit `a0fb9dd` |
| Helicone (not in post) | documented `docker run` of `helicone/helicone-all-in-one:latest`, as compose, with the documented volumes | image built 2025-08-21, digest `sha256:4da15718…b901` |

## Evidence ledger

| Claim | Kind | Source |
|---|---|---|
| Idle / after-load / settled memory, disk, image sizes | Observed | `results/*.jsonl` |
| All 1,000 traces arrived in every tool | Observed | Phoenix `traces`/`spans` 1000/3000; Langfuse `events_full` 3000 rows, 1000 trace ids; Opik bench project 1000/3000; MLflow `trace_info`/`spans` 1000/3000; Laminar `spans` 3000/1000; Helicone `request_response_rmt` 1001 (1000 + one test call); AcruxCore `traces`/`spans`/`span_payloads` 1000/3000/3000; Agenta `agenta_oss_tracing.spans` 3000 rows, 1000 trace ids |
| AcruxCore tables 4.6 MiB; data folder 37 MiB base + 33 MiB `pg_wal` after load | Observed | `pg_total_relation_size`; `du -sm` inside the Postgres container |
| AcruxCore survives `up --force-recreate` with user, key, 1000 traces; sign-in 200 | Observed | psql counts + `POST /auth/sign-in/email` after recreate |
| AcruxCore quickstart commits a default `GATEWAY_ENCRYPTION_KEY`, Postgres password `acruxcore` | Observed, documented as insecure in the file | `docker-compose.local.yml:20-31,51,93` |
| AcruxCore production compose fails without `mynetwork` | Observed | `docker compose up --no-start` → `network mynetwork declared as external, but could not be found`; README step added in this PR |
| AcruxCore sign-up open on a fresh instance | Observed | sign-up returned a session with no claim token |
| Langfuse two runs: idle 2.60 / 2.64 GiB | Observed | `shb-langfuse`, `shb-langfuse2` |
| Laminar first boot 4.7 / 4.8 min | Observed, two runs | container start → first 2xx/3xx; second run 289 s from `up` |
| MLflow ready 42 s / 33 s | Observed, two runs | first run overlapped a large image extraction on the host |
| Opik trace data 0.9 MiB; system tables 26 MiB active + 97 MiB inactive; 1,045 inactive parts on `opik.traces` right after load | Observed | `system.parts` queries |
| Laminar ClickHouse config disables telemetry logs, keeps query/error logs 3 days | Documented | lmnr README "Upgrading existing self-hosted installations" |
| MLflow: `ModuleNotFoundError: psycopg`; SQLAlchemy 2.1.3 in image; compose pip-installs psycopg2-binary + boto3 at boot | Observed | container logs; `python -c "import sqlalchemy"` in image |
| MLflow server = 15 Python processes (4 uvicorn workers, 7 huey consumers, job runner, …) | Observed | `docker top` |
| Helicone image last published 2025-08-21; last release `v2025.08.21-1`; Docker Hub workflow triggers only on tags/releases; repo commits to 2026-09-16 | Observed | Docker Hub API; `gh release list`; `.github/workflows/docker-push.yml`; `gh api commits` |
| Helicone ClickHouse migration blocks on `[y/N]` prompt; `--skip-confirmation` exists, not passed by `supervisord.conf` (image and repo main) | Observed | `/var/log/supervisor/clickhouse-migrate.out.log`; `ch_hcone.py:284,438`; repo `supervisord.conf:67`. Reproduced on the plain documented `docker run` (no volumes) too |
| Helicone `Region is missing` without `S3_REGION` | Observed | `/v1/trace/custom/log/typed` response. Same error was seen in the Aug 2026 Helicone comparison |
| Helicone documented Postgres volume path is not Postgres's data dir | Observed | `data_directory = '/var/lib/postgresql/17/main'`; mounted `/var/lib/postgresql/data` stayed 0 bytes; recreate wiped `user`/`helicone_api_keys` |
| Helicone `ai-gateway` FATAL: `couldn't chdir to /app/gateway: ENOENT` | Observed | supervisor logs |
| No existing Helicone issues for the three problems | Observed, 2026-10-11 | `gh search issues` for several phrasings |
| Langfuse hardware 4 cores / 16 GiB / 100 GiB; compose lacks HA/scaling/backups | Documented | langfuse.com/self-hosting/deployment/docker-compose |
| Langfuse 14 `# CHANGEME` lines | Observed | `grep -c` on compose file |
| Opik "not meant for production deployments"; 156 demo traces | Documented + observed | comet.com/docs/opik/self-host/local_deployment; ClickHouse count |
| Phoenix auth off by default (`PHOENIX_ENABLE_AUTH`, default False) | Observed | `src/phoenix/config.py` |
| Laminar `NEXTAUTH_SECRET: some_secret` hard-coded; `.env` committed | Observed | lmnr `docker-compose.yml:86`; `git ls-files .env` |
| Other four tools publish no hardware requirement | Documented (absence) | each tool's self-host page, read 2026-10-10 |

### Caveats stated in the article

- Image sizes are uncompressed and summed per distinct image (shared layers
  counted more than once; small effect here).
- Helicone received request logs, not 3-span traces (no OTLP intake).
- Phoenix's starting disk includes ~90 MiB of `.pyc` files in its layer.

### A wrong claim caught before it shipped

The first draft said Laminar's `pull_policy: always` added ~5 minutes to
startup. A re-timed registry check took 1.3 s; the 5 minutes was the 14 GB
Helicone image extracting on the same daemon at that moment. Removed.

## Agenta run (2026-10-17)

| Claim | Kind | Source |
|---|---|---|
| 14 running + 1 exited (alembic) containers; images 12.5 GB; runner image 6,856 MB | Observed | `results/shb-agenta.jsonl` images row |
| Ready 47 s (compose up returned 35 s + 11.7 s to `/api/health` 200) | Observed | cold_start row |
| Idle 2.62 GiB (api 870, services 442, worker-queues 315, supertokens 285, worker-streams 280 MiB); after load 2.67; settled 2.67 | Observed | memory rows |
| API = gunicorn master + 2 workers at ~460 MB RSS each | Observed | `docker top shb-agenta-api-1` |
| Disk 92.4 MiB idle → 109.4 settled (+17 MiB); `spans` table 13 MB | Observed | disk rows; `pg_total_relation_size('spans')` |
| API refuses to start with `AGENTA_SERVICES_INTERNAL_KEY=replace-me` | Documented | self-host quick start step 3 (not tested) |
| Stack starts with `AGENTA_AUTH_KEY`, `AGENTA_CRYPT_KEY`, `AGENTA_RUNNER_TOKEN`, store keys left at `replace-me`; admin API (`Authorization: Access replace-me`) created the bench account | Observed | `run_agenta.sh` |
| No host hardware requirement in Agenta's self-host docs (only Daytona sandbox sizes) | Documented (absence) | `docs/docs/self-host`, grep, 2026-10-17 |

The first Agenta attempt failed and was discarded: Traefik could not bind host port 49080
("address already in use"), which is inside this host's ephemeral range (32768–60999).
The run used 28080 instead. `bench.sh` now keeps compose output in
`results/<project>.compose.log` instead of discarding it.

## Trace space vs disk growth (second runs, 2026-10-17)

Each stack was started again with the same images and the same 1,000 traces, and the
trace tables were measured directly (ClickHouse `system.parts`, Postgres
`pg_table_size` + `pg_indexes_size`). These runs only fill the "space the 1,000 traces
take" column; the growth column is still the original benchmark run.

| Tool | Trace tables (MiB) | Notes |
|---|---|---|
| Laminar | spans 0.65 + traces_agg 0.09 + traces_static 0.07 = 0.81 | data dir 7.5 → 9.6 → 6.1 MiB (idle → +20 s → +12 min); only `query_log` among system tables |
| Opik | 0.9 | original run, `system.parts` |
| Langfuse | events_full 0.69 + events_core 0.37 = 1.06 | data dir 50.5 → 103.3 MiB in 15 min; growth is metric_log, trace_log, text_log, asynchronous_metric_log, part_log (rows grow with time, e.g. metric_log 318 → 1,216) |
| AcruxCore | spans 1.96 + span_payloads 2.15 + traces 0.50 = 4.61 (indexes 1.26) | pg_wal 16 → 32 MiB (1 → 2 WAL files) |
| Phoenix | spans 3.57 + traces 0.64 + span_cost_details 0.36 + span_costs 0.35 = 4.92 | WAL files 1 → 2; `token_prices`/`generative_models` are seed data, excluded |
| MLflow | spans 4.80 + trace_info 1.68 + trace_tags 1.06 = 7.54 | WAL files 1 → 2 |
| Agenta | spans 3.71 + indexes 9.82 = 13.53 | GIN indexes: full-text on attributes 4.4 MB, JSONB attributes 3.2 MB. Postgres volume grew 13.7 MiB ≈ table growth, so no new WAL file (2 files after load; idle count inferred, not read) |

All four Postgres stacks: `max_wal_size` 1GB, `min_wal_size` 80MB, `wal_compression` off.
Scripts: `space_clickhouse.sh` and `space_postgres.sh` in this folder, run before the load and 2 and 15 min after it.

## Helicone dropped (2026-10-17)

The owner replaced Helicone with Agenta. Reasons: Helicone has no OTLP intake (it got
request logs, not the same traces), its self-host image dates from 2025-08-21, and it
has been in maintenance mode since joining Mintlify. Its raw readings and scripts stay
here; the draft issues below still apply.

## Draft upstream issues (owner decides whether to file — outward-facing)

1. **Helicone — all-in-one ClickHouse migrations block on an interactive
   prompt.** `supervisord.conf` runs `ch_hcone.py --upgrade` without
   `--skip-confirmation`; the script waits at `Do you want to apply these 65
   migration(s)? [y/N]:` forever, so no ClickHouse tables exist and every
   log call 500s (`UNKNOWN_TABLE default.jawn_http_logs`). Repro: the documented
   `docker run … helicone/helicone-all-in-one:latest`, then
   `tail /var/log/supervisor/clickhouse-migrate.out.log`.
2. **Helicone — docs' Postgres volume path doesn't persist data.** Docs mount
   `/var/lib/postgresql/data`; Postgres uses `/var/lib/postgresql/17/main`.
   Recreating the container deletes users, orgs and API keys.
3. **Helicone — `S3_REGION` unset in all-in-one** → custom log returns
   `Region is missing`.
4. **MLflow — `docker-compose/` fails on 3.17.0** with
   `ModuleNotFoundError: psycopg`; fix: install `psycopg[binary]` or use
   `postgresql+psycopg2://` in `.env.dev.example`.

## Owner still needs to

1. Decide whether to file the four upstream issues above. The post reads the
   same either way; it could link them once filed.
2. Decide what happens to PR #518 (section above).
