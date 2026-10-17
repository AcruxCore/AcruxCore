#!/usr/bin/env bash
# space_clickhouse.sh <label> <clickhouse container> : per-table parts (active vs old) + data dir size
C=${2:-diag-lmnr-clickhouse-1}
echo "== $1 $(date +%T)"
docker exec $C sh -c 'clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -q "
select database, table, countIf(active) act_parts, countIf(not active) old_parts,
 round(sumIf(bytes_on_disk, active)/1048576,2) act_mib, round(sumIf(bytes_on_disk, not active)/1048576,2) old_mib,
 sumIf(rows, active) rows
from system.parts group by database, table having act_mib+old_mib > 0.01 order by act_mib+old_mib desc format PrettyCompactMonoBlock"'
docker exec $C du -sk /var/lib/clickhouse | awk '{printf "data dir: %.1f MiB\n", $1/1024}'
