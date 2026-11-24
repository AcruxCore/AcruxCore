## Full runs

| Tool | Boot s (3 runs) | Idle GiB | 10k: accept s / visible s / peak GiB | Settled 10k GiB | 90k: accept s / visible s / peak GiB | Settled 100k GiB | Disk idle→100k MiB | MiB per 1k traces | List 50 @100k ms (p50/p95) | Get 1 @100k ms (p50/p95) |
|---|---|---|---|---|---|---|---|---|---|---|
| Langfuse | 29.3, 28.6, 28.6 (median 28.6) | 1.82 | 1.7 / 8.0 / 2.73 | 2.42 | 10.1 / 48.0 / 3.70 | 2.54 | 93 → 682 | 5.9 | 31.0 / 34.9 | 14.1 / 16.8 |
| Phoenix | 14.8, 14.8, 14.8 (median 14.8) | 0.49 | 2.6 / 95.6 / 0.66 | 0.65 | 790.9 / 853.2 / 0.81 | 0.77 | 140 → 1016 | 8.8 | 4.3 / 4.6 | 4.2 / 5.0 |
| MLflow | 26.9, 25.0, 26.8 (median 26.8) | 2.61 | 12.5 / 12.6 / 2.84 | 2.84 | 102.1 / 102.2 / 2.95 | 2.91 | 104 → 1780 | 16.8 | 8.4 / 9.9 | 6.2 / 8.8 |
| AcruxCore | 12.2, 12.2, 12.2 (median 12.2) | 0.25 | 20.8 / 20.8 / 0.64 | 0.38 | 188.0 / 188.1 / 0.87 | 0.58 | 51 → 1100 | 10.5 | 5.6 / 6.7 | 7.9 / 11.4 |
| Opik | 55.3, 55.1, 55.6 (median 55.3) | 3.06 | 54.4 / 54.5 / 11.94 | 9.58 | 566.5 / 566.7 / 17.87 | 12.18 | 312 → 4404 | 40.9 | 177.8 / 182.4 | 63.1 / 65.7 |

## Where the 100k-trace disk goes (per volume, MiB)

- Langfuse: langfuse_clickhouse_data 248.2, langfuse_clickhouse_logs 9.8, langfuse_minio_data 379.0, langfuse_postgres_data 44.5, langfuse_redis_data 0.1
- Phoenix: database_data 920.0
- MLflow: pgdata 1724.5, storage-data 0.1
- AcruxCore: acruxcore-local-pgdata 1097.3
- Opik: clickhouse 3259.4, clickhouse-config 0.0, clickhouse-server 661.9, minio-data 0.1, mysql 227.5, redis-data 15.4, zookeeper 239.7

## Capped runs

| Tool | Cap | Booted (s) | 10k stored | Accept s / visible s | Peak GiB (docker stats) | OOM kills | Restarts / exited |
|---|---|---|---|---|---|---|---|
| Langfuse | 2 GB / 1 CPU | 44.0 | 10000 | 13.6 / 1034.9 | 2.00 | 2 | 2 / none |
| Langfuse | 4 GB / 2 CPU | 39.5 | 10000 | 2.9 / 9.2 | 2.70 | 0 | 0 / none |
| Langfuse | 8 GB / 4 CPU | 28.8 | 10000 | 1.9 / 8.2 | 2.93 | 0 | 0 / none |
| Phoenix | 2 GB / 1 CPU | 16.9 | 10000 | 2.9 / 101.4 | 0.67 | 0 (see note) | 0 / none |
| Phoenix | 4 GB / 2 CPU | 14.7 | 10000 | 2.6 / 93.6 | 0.66 | 0 | 0 / none |
| Phoenix | 8 GB / 4 CPU | 15.8 | 10000 | 2.9 / 104.6 | 0.65 | 0 | 0 / none |
| MLflow | 2 GB / 1 CPU | 40.3 | 0 | 984.0 / None | 0.18 | 1 | 0 / mlflow-1 |
| MLflow | 4 GB / 2 CPU | 30.3 | 10000 | 22.8 / 22.8 | 2.83 | 0 | 0 / none |
| MLflow | 8 GB / 4 CPU | 29.0 | 10000 | 13.1 / 13.2 | 2.84 | 0 | 0 / none |
| AcruxCore | 2 GB / 1 CPU | 12.3 | 10000 | 64.7 / 64.8 | 0.43 | 0 | 0 / none |
| AcruxCore | 4 GB / 2 CPU | 12.3 | 10000 | 33.7 / 33.8 | 0.61 | 0 | 0 / none |
| AcruxCore | 8 GB / 4 CPU | 12.2 | 10000 | 19.5 / 19.5 | 0.64 | 0 | 0 / none |
| Opik | 2 GB / 1 CPU | 89.2 | 0 | 1077.6 / None | 2.00 | 2 | 0 / backend-1, clickhouse-1 |
| Opik | 4 GB / 2 CPU | 59.3 | 0 | 801.7 / None | 4.00 | 1 | 0 / clickhouse-1 |
| Opik | 8 GB / 4 CPU | 55.0 | 10000 | 180.9 / 181.1 | 6.03 | 0 | 0 / none |
