-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'tool_created';
ALTER TYPE "AuditEvent" ADD VALUE 'tool_version_committed';
ALTER TYPE "AuditEvent" ADD VALUE 'tool_alias_promoted';

-- CreateTable
CREATE TABLE "tools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "team_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tool_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "description" TEXT,
    "parameters_schema" JSONB NOT NULL,
    "executor" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_aliases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tool_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "version_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_tools_team_id" ON "tools"("team_id");

-- CreateIndex
CREATE INDEX "idx_tools_team_name" ON "tools"("team_id", "name");

-- CreateIndex
CREATE INDEX "idx_tools_team_deleted_at" ON "tools"("team_id", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_tool_versions_lookup" ON "tool_versions"("tool_id", "version_number");

-- CreateIndex
CREATE INDEX "idx_tool_versions_list" ON "tool_versions"("tool_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tool_versions_tool_id_version_number_key" ON "tool_versions"("tool_id", "version_number");

-- CreateIndex
CREATE INDEX "idx_tool_aliases_lookup" ON "tool_aliases"("tool_id", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "tool_aliases_tool_id_alias_key" ON "tool_aliases"("tool_id", "alias");

-- AddForeignKey
ALTER TABLE "tools" ADD CONSTRAINT "tools_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tools" ADD CONSTRAINT "tools_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_versions" ADD CONSTRAINT "tool_versions_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_versions" ADD CONSTRAINT "tool_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_aliases" ADD CONSTRAINT "tool_aliases_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_aliases" ADD CONSTRAINT "tool_aliases_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "tool_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
