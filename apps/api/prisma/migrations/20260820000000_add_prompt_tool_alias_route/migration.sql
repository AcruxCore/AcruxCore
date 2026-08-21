-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'prompt_tool_route_set';
ALTER TYPE "AuditEvent" ADD VALUE 'prompt_tool_route_removed';

-- CreateTable
CREATE TABLE "prompt_tool_alias_routes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prompt_id" UUID NOT NULL,
    "prompt_alias" TEXT NOT NULL,
    "tool_id" UUID NOT NULL,
    "tool_alias" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prompt_tool_alias_routes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_prompt_tool_alias_routes_lookup" ON "prompt_tool_alias_routes"("prompt_id", "prompt_alias");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_tool_alias_routes_prompt_id_prompt_alias_tool_id_key" ON "prompt_tool_alias_routes"("prompt_id", "prompt_alias", "tool_id");

-- AddForeignKey
ALTER TABLE "prompt_tool_alias_routes" ADD CONSTRAINT "prompt_tool_alias_routes_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_tool_alias_routes" ADD CONSTRAINT "prompt_tool_alias_routes_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_tool_alias_routes" ADD CONSTRAINT "prompt_tool_alias_routes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

