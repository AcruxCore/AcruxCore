#!/usr/bin/env bash
# space_postgres.sh <postgres container> <user> <label> : data dir, WAL written + WAL files, largest tables and indexes per database (skips the "postgres" db; query it by hand for Phoenix)
C=$1; U=$2; echo "== $3 $(date +%T) [$C]"
docker exec $C sh -c 'du -sk "$PGDATA" "$PGDATA/pg_wal" "$PGDATA/base"' | awk '{n=$2; sub(/.*\//,"",n); printf "%s %.1f MiB\n", n, $1/1024}'
docker exec $C psql -U $U -d postgres -tAc "select 'wal written: ' || pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')) || ', wal files: ' || (select count(*) from pg_ls_waldir() where size=16777216)"
for db in $(docker exec $C psql -U $U -d postgres -tAc "select datname from pg_database where not datistemplate and datname<>'postgres'"); do
  docker exec $C psql -U $U -d $db -tAc "select '$db', c.relname,
    round(pg_table_size(c.oid)/1048576.0,2) as table_mib, round(pg_indexes_size(c.oid)/1048576.0,2) as index_mib, c.reltuples::bigint
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema')
    order by pg_total_relation_size(c.oid) desc limit 4" | awk -F'|' '$3+$4>0.1 {printf "  %s.%s table %s MiB, indexes %s MiB, ~%s rows\n",$1,$2,$3,$4,$5}'
done
