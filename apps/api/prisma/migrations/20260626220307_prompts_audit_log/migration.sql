-- CreateEnum
CREATE TYPE "AuditEvent" AS ENUM ('prompt_created', 'prompt_renamed', 'prompt_updated', 'prompt_deleted', 'version_committed', 'alias_promoted', 'api_key_generated', 'api_key_revoked', 'member_invited', 'member_role_updated', 'member_removed');

-- CreateTable
CREATE TABLE "prompts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "team_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "prompt_id" UUID,
    "actor_id" UUID NOT NULL,
    "event" "AuditEvent" NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_prompts_team_id" ON "prompts"("team_id");

-- CreateIndex
CREATE INDEX "idx_prompts_team_name" ON "prompts"("team_id", "name");

-- CreateIndex
CREATE INDEX "idx_prompts_team_deleted_at" ON "prompts"("team_id", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_audit_log_team_prompt" ON "audit_log"("team_id", "prompt_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_log_team" ON "audit_log"("team_id", "created_at");

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
