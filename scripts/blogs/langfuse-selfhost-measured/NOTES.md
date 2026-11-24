# Notes: self-hosting Langfuse vs lighter alternatives, measured (2026-11-13)

Method notes behind the blog post `apps/docs/blog/2026-11-24-self-hosting-langfuse-100k-traces.md`
(first drafted for SitePoint, then published on acruxcore.com/blog instead). `README.md` has the
reader-facing run steps. Spec: `syndication/langfuse-selfhost-measured/spec.md`.

The post labels AcruxCore with the current published image, 2026.11.11. The readings were taken on
images built from staging `241f233` before that code was released; everything in it shipped in
2026.11.9, together with the #856 fix (worker skips online-eval work for a team with no rules).

## How to rerun

```bash
source ~/venv/bin/activate              # needs opentelemetry-sdk + otlp http exporter
git clone --depth 1 https://github.com/langfuse/langfuse    $UP/langfuse   # 6decf5a
git clone --depth 1 https://github.com/Arize-ai/phoenix     $UP/phoenix    # 588d0e8
git clone --depth 1 https://github.com/mlflow/mlflow        $UP/mlflow     # b355c42
git clone --depth 1 https://github.com/comet-ml/opik        $UP/opik       # c722c7d
UP=$UP PY=$(which python) ./run_all.sh  # full runs, then capped runs
python summarize.py                     # article tables
```

- `compose.sh` — the exact compose command per tool (official file + `overrides/<tool>.yml`).
- `load.py` — 3-span synthetic agent traces over OTLP/HTTP, 4 processes, synchronous batches of
  100 traces with retry, so no client-side drops (a BatchSpanProcessor drops when its queue fills).
- `bench.py full <tool>` / `bench.py cap <tool> <GB> <CPUs>` — see the docstring.
- `measure.py` — memory (`docker stats`, cache excluded) and disk (`du` of volumes + writable layers).
- `results/*.jsonl` — every reading; `*.samples.jsonl` — every `docker stats` sample during ingest;
  `host-vmstat.log` — host I/O every 10 s (another job could download on this host).

Host: 24 cores, 62 GiB, NVMe, Fedora (kernel 7.2), Docker 29.9.2. All other Docker stacks on the
host were stopped for the run (owner approved, 2026-11-13); their names are in the session scratchpad.

## Overrides (the only changes to each official setup)

- All: host ports moved, a fixed subnet (`10.251.N.0/24`, the host had used up Docker's default
  address pools), version pinned to the latest release on 2026-11-13.
- Langfuse 4.79.0: headless init (org, project, keys) so a script can send traces.
- Phoenix 21.0.0: published image instead of a source build (as the docs show); `PHOENIX_SECRET` +
  `PHOENIX_ADMIN_SECRET` because 21.0 turns auth on by default for non-loopback hosts (BREAKING in the
  21.0.0 changelog, "enable auth by default without requiring PHOENIX_SECRET"). Auth left on.
- MLflow 3.18.0: `.env.dev.example` with `MLFLOW_VERSION` and port set. The compose now installs
  `psycopg[binary]` itself, so the October fix is no longer needed.
- Opik 2.2.143: `--profile opik`, as `./opik.sh` runs.
- AcruxCore: README quick start compose. The article's AcruxCore numbers come from images built
  from staging `241f233` (`docker build` of `Dockerfile` targets `api`/`worker` and
  `apps/web/Dockerfile` target `web`, tagged `staging-241f233`), which holds the fix for issue
  #851 (PR #854). That commit is the next release; set `ACX_VERSION` in the draft to its tag. The
  first AcruxCore runs (`lfm-acrux*.jsonl` without `-851`) measured the published 2026.11.7
  images and are superseded. Rerun: `rerun_acrux_851.sh`; the override takes `ACX_IMAGE_TAG`.

## Evidence ledger

| Claim in the article | Kind | Source |
|---|---|---|
| Langfuse docs: at least 4 cores and 16 GiB | Documented | langfuse.com/self-hosting/deployment/docker-compose (read 2026-11-13) |
| Langfuse cannot run without ClickHouse | Documented | langfuse.com/self-hosting/deployment/infrastructure/clickhouse FAQ |
| Langfuse ingest: web writes batch to S3, reference in Redis, worker loads into ClickHouse | Documented | langfuse.com/self-hosting ("Queued trace ingestion") |
| Self-hosted data retention is an enterprise entitlement | Observed in source | `web/src/features/entitlements/constants/entitlements.ts` lines 38-49 at 6decf5a (`selfHostedEnterpriseEntitlements` has `data-retention`; `oss` uses `selfHostedAllPlansEntitlements`) |
| Phoenix queue limit 20,000 spans, then asks the sender to retry | Observed in source + run | `phoenix/config.py` `get_env_max_spans_queue_size` default 20_000; `db/bulk_inserter.py is_full`; sender recorded 48 retries |
| Phoenix writer near 100% of one core | Observed | `lfm-phoenix.samples.jsonl` median 93.9% total during the 90k batch |
| MLflow server ~15 Python processes | Observed in October | earlier measurement NOTES (`docker top`); idle 2,614 MiB in this run |
| Opik local Docker "not meant for production" | Documented | comet.com/docs/opik/self-host/local_deployment |
| Every number in the tables | Observed | `results/lfm-*.jsonl`, printed by `summarize.py` |
| AcruxCore API ~1.4 cores, Postgres ~1.3 during ingest | Observed | three `docker stats` snapshots at 13:50 during the `-851-r2` 90k batch (api 140-145%, postgres 123-128%, worker 77-80%) |
| AcruxCore list/get at 100k (5.6 / 7.9 ms run 1; 3.2 / 4.3 ms run 2) | Observed | `lfm-acrux-851.jsonl`, `lfm-acrux-851-r2.jsonl` |

## Incidents during the run

- 06:03 Phoenix 4 GB cap: `address already in use` on host port 46006 right after the previous
  stack stopped; the Phoenix container stayed in Created with a broken network (DNS failed, migration
  error). Recreated by hand at 06:11:10, ready in 15.2 s. Its recorded `ready_s` 436.3 is not a boot
  time (note row in `lfm-phoenix-4g.jsonl`). `fresh_up` now recreates a stuck container once.
- The disk-space breakdown (`space` rows) was added after the Langfuse and AcruxCore full runs, so
  those two have `-r2` follow-up runs for it.
- 06:33 method fix for the capped runs. The first capped runs (files `lfm-<tool>-4g.*`, "v1") put
  every container in a systemd slice with `memory.max` but gave containers no limit of their own.
  Inside that slice the Opik JVM reported `Memory Limit: Unlimited`, `MaxHeapSize` 15.7 GiB, and
  ClickHouse set `max_server_memory_usage` to 56 GiB (90% of the host), so both overcommitted.
  On a real VPS every process sees the machine's RAM and sizes itself from it. v2 (`-v2` files)
  adds `mem_limit`/`memswap_limit` = the cap and `cpus` = the CPU count on every container, while
  the slice still caps the total. Checked: JVM then reports `Memory Limit: 4.00G`, 2 CPUs, 1 GiB
  heap. v1 results are superseded and not used in the article; v1 Opik 4 GB had its backend killed
  with exit 137 about a minute after start. `nproc` still reports 24 inside a container (a CPU
  quota, not CPU pinning); runtimes that read the cgroup quota see 2.
| Postgres WAL share of disk at 100k | Observed | `space` rows: AcruxCore `_wal` 656 MiB, MLflow 960, Phoenix 464 |
| Opik ClickHouse `system` db 1,754 MiB, `opik` db 47.5 MiB | Observed | `space` row in `lfm-opik.jsonl` |
| Langfuse ClickHouse tables 76.5 MiB | Observed | `space` row in `lfm-langfuse-r2.jsonl` |

## Re-measure after issue #851 (2026-11-13, afternoon)

- 11:58 first start sat idle: `compose.sh` needs `UP` set even for AcruxCore. Restarted 12:04.
- 12:04-12:49 `full acrux` (`-851`), `cap acrux 2 1`, `cap acrux 4 2` (`-v2-851`).
- 12:49-13:10 8 GB / 4 CPU for Phoenix, MLflow and AcruxCore (`bench.py cap <tool> 8 4`), so every tool
  has all three caps. Phoenix 8 GB was not faster than 4 GB: one writer process.
- 13:14-14:03 `full acrux` repeat (`-851-r2`, `IDLE_MIN=1`, `KEEP_UP=1`) to check get-one-trace
  (7.9 ms in run 1). Run 2: 90k stored in 154.2 s (run 1: 188.0 s), list 3.2 ms, get 4.3 ms.
  The article's tables use run 1 and mention run 2.
- The worker used ~78% CPU during ingest with no eval rules configured: issue #856.

