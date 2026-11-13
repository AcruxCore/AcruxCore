-- A caller-chosen trace id names a trace within one team. When another team already holds
-- the id as its `traces.id`, the new trace gets a server-generated id and records the
-- caller's id here. Nullable with no default, so adding it is a catalog-only change: no
-- table rewrite, and every existing row keeps its id.
ALTER TABLE "traces" ADD COLUMN "client_trace_id" UUID;
