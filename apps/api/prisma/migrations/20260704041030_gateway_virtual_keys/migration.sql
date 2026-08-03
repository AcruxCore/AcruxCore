-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'virtual_key_created';
ALTER TYPE "AuditEvent" ADD VALUE 'virtual_key_revoked';

-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';

-- CreateTable
CREATE TABLE "virtual_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_last_four" TEXT NOT NULL,
    "allowed_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_rpm" INTEGER,
    "max_tpm" INTEGER,
    "cache_ttl_seconds" INTEGER,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "virtual_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idx_virtual_keys_hash" ON "virtual_keys"("key_hash");

-- CreateIndex
CREATE INDEX "idx_virtual_keys_team" ON "virtual_keys"("team_id");

-- AddForeignKey
ALTER TABLE "gateway_requests" ADD CONSTRAINT "gateway_requests_virtual_key_id_fk" FOREIGN KEY ("virtual_key_id") REFERENCES "virtual_keys"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
