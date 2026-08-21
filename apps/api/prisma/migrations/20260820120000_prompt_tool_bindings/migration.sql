-- Replaces the version-scoped `prompt_version_tools` and its live override
-- table `prompt_tool_alias_routes` with one alias-keyed table (phase-4-faq Q53,
-- spec 2026-08-20-prompt-tool-binding-design.md).
--
-- `prompt_alias IS NULL` is the default every alias inherits. A row with both
-- `tool_alias` and `pinned_version_id` NULL means "this alias deliberately has
-- no such tool", which is needed because an absent row already means inherit.

-- CreateTable
CREATE TABLE "prompt_tool_bindings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prompt_id" UUID NOT NULL,
    "prompt_alias" TEXT,
    "tool_id" UUID NOT NULL,
    "tool_alias" TEXT,
    "pinned_version_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prompt_tool_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_prompt_tool_bindings_lookup" ON "prompt_tool_bindings"("prompt_id", "prompt_alias");

-- CreateIndex
CREATE INDEX "idx_prompt_tool_bindings_tool" ON "prompt_tool_bindings"("tool_id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_tool_bindings_prompt_id_prompt_alias_tool_id_key" ON "prompt_tool_bindings"("prompt_id", "prompt_alias", "tool_id");

-- CreateIndex
-- Postgres does not treat NULLs as equal, so the unique index above leaves the
-- default rows unconstrained. This partial index enforces one default per
-- (prompt, tool).
CREATE UNIQUE INDEX "uq_prompt_tool_bindings_default" ON "prompt_tool_bindings"("prompt_id", "tool_id") WHERE "prompt_alias" IS NULL;

-- AddForeignKey
ALTER TABLE "prompt_tool_bindings" ADD CONSTRAINT "prompt_tool_bindings_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_tool_bindings" ADD CONSTRAINT "prompt_tool_bindings_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_tool_bindings" ADD CONSTRAINT "prompt_tool_bindings_pinned_version_id_fkey" FOREIGN KEY ("pinned_version_id") REFERENCES "tool_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_tool_bindings" ADD CONSTRAINT "prompt_tool_bindings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill. Preserves what every existing prompt alias renders today.
-- Soft-deleted tools are skipped, matching the resolver, which excluded them.
-- ---------------------------------------------------------------------------

-- 1. Defaults: each prompt's newest version's attachments become the default
--    set, so a newly promoted alias inherits the author's latest intent.
INSERT INTO "prompt_tool_bindings" ("prompt_id", "prompt_alias", "tool_id", "tool_alias", "pinned_version_id", "position", "created_by", "updated_at")
SELECT pv."prompt_id",
       NULL,
       pvt."tool_id",
       CASE WHEN pvt."pinned_version_id" IS NULL THEN pvt."alias_name" ELSE NULL END,
       pvt."pinned_version_id",
       pvt."position",
       pv."created_by",
       CURRENT_TIMESTAMP
FROM "prompt_version_tools" pvt
JOIN "prompt_versions" pv ON pv."id" = pvt."prompt_version_id"
JOIN "tools" t ON t."id" = pvt."tool_id" AND t."deleted_at" IS NULL
JOIN (
    SELECT "prompt_id", MAX("version_number") AS vn
    FROM "prompt_versions"
    GROUP BY "prompt_id"
) newest ON newest."prompt_id" = pv."prompt_id" AND newest."vn" = pv."version_number";

-- 2. Per-alias rows from whatever version each alias actually serves, with any
--    existing live routing override folded in as that alias's tool alias.
INSERT INTO "prompt_tool_bindings" ("prompt_id", "prompt_alias", "tool_id", "tool_alias", "pinned_version_id", "position", "created_by", "updated_at")
SELECT pa."prompt_id",
       pa."alias",
       pvt."tool_id",
       CASE WHEN pvt."pinned_version_id" IS NOT NULL THEN NULL
            ELSE COALESCE(r."tool_alias", pvt."alias_name") END,
       pvt."pinned_version_id",
       pvt."position",
       pv."created_by",
       CURRENT_TIMESTAMP
FROM "prompt_aliases" pa
JOIN "prompt_versions" pv ON pv."id" = pa."version_id"
JOIN "prompt_version_tools" pvt ON pvt."prompt_version_id" = pa."version_id"
JOIN "tools" t ON t."id" = pvt."tool_id" AND t."deleted_at" IS NULL
LEFT JOIN "prompt_tool_alias_routes" r
       ON r."prompt_id" = pa."prompt_id"
      AND r."prompt_alias" = pa."alias"
      AND r."tool_id" = pvt."tool_id";

-- 3. Off rows: a tool in the default that this alias's served version does not
--    have. Without these the alias would newly inherit a tool it never called.
INSERT INTO "prompt_tool_bindings" ("prompt_id", "prompt_alias", "tool_id", "tool_alias", "pinned_version_id", "position", "created_by", "updated_at")
SELECT d."prompt_id", pa."alias", d."tool_id", NULL, NULL, d."position", d."created_by", CURRENT_TIMESTAMP
FROM "prompt_tool_bindings" d
JOIN "prompt_aliases" pa ON pa."prompt_id" = d."prompt_id"
WHERE d."prompt_alias" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM "prompt_version_tools" pvt
      WHERE pvt."prompt_version_id" = pa."version_id"
        AND pvt."tool_id" = d."tool_id"
  );

-- 4. Drop per-alias rows that say exactly what the default already says, so an
--    alias that never diverged ends with no rows and simply inherits. Purely a
--    tidy-up: leaving them would render identically, just with a needless
--    column per alias in the dashboard.
DELETE FROM "prompt_tool_bindings" a
USING "prompt_tool_bindings" d
WHERE a."prompt_alias" IS NOT NULL
  AND d."prompt_alias" IS NULL
  AND d."prompt_id" = a."prompt_id"
  AND d."tool_id" = a."tool_id"
  AND a."tool_alias" IS NOT DISTINCT FROM d."tool_alias"
  AND a."pinned_version_id" IS NOT DISTINCT FROM d."pinned_version_id";

-- 5. Drop off rows for tools the default does not hold either — nothing to
--    switch off, and an absent row already means absent.
DELETE FROM "prompt_tool_bindings" a
WHERE a."prompt_alias" IS NOT NULL
  AND a."tool_alias" IS NULL
  AND a."pinned_version_id" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM "prompt_tool_bindings" d
      WHERE d."prompt_alias" IS NULL
        AND d."prompt_id" = a."prompt_id"
        AND d."tool_id" = a."tool_id"
  );

-- DropTable
DROP TABLE "prompt_tool_alias_routes";

-- DropTable
DROP TABLE "prompt_version_tools";
