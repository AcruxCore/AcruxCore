-- One copy of each distinct tool list a trace's gateway llm calls sent (PR #799 review).
-- A tool loop sends the same definitions on every round; storing them on each span payload
-- repeated them once per round.
CREATE TABLE "trace_tool_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trace_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "tools" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trace_tool_sets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trace_tool_sets_trace_id_hash_key" ON "trace_tool_sets"("trace_id", "hash");

ALTER TABLE "trace_tool_sets" ADD CONSTRAINT "trace_tool_sets_trace_id_fkey" FOREIGN KEY ("trace_id") REFERENCES "traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trace_tool_sets" ADD CONSTRAINT "trace_tool_sets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "span_payloads" ADD COLUMN "tool_set_id" UUID;
ALTER TABLE "span_payloads" ADD CONSTRAINT "span_payloads_tool_set_id_fkey" FOREIGN KEY ("tool_set_id") REFERENCES "trace_tool_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "idx_span_payloads_tool_set" ON "span_payloads"("tool_set_id");

-- Move any lists already stored inline (written by the previous migration) into sets.
INSERT INTO "trace_tool_sets" ("trace_id", "team_id", "hash", "tools")
SELECT DISTINCT ON (s.trace_id, md5(p.tools::text)) s.trace_id, p.team_id, 'md5:' || md5(p.tools::text), p.tools
FROM "span_payloads" p JOIN "spans" s ON s.id = p.span_id
WHERE p.tools IS NOT NULL AND p.tools <> '[]'::jsonb;

UPDATE "span_payloads" p SET "tool_set_id" = t.id
FROM "spans" s, "trace_tool_sets" t
WHERE s.id = p.span_id AND t.trace_id = s.trace_id AND t.hash = 'md5:' || md5(p.tools::text)
  AND p.tools IS NOT NULL;

ALTER TABLE "span_payloads" DROP COLUMN "tools";
