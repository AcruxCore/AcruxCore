-- One trace per (team, caller-chosen id). Partial, so it holds only the rare rows that
-- carry a client_trace_id and stays tiny. CONCURRENTLY so building it does not block
-- writes to traces; it must be the only statement in its migration, because CONCURRENTLY
-- cannot run inside a transaction block.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_traces_team_client_trace_id"
  ON "traces" ("team_id", "client_trace_id")
  WHERE "client_trace_id" IS NOT NULL;
