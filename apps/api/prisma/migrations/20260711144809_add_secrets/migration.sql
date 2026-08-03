-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'secret_created';
ALTER TYPE "AuditEvent" ADD VALUE 'secret_rotated';
ALTER TYPE "AuditEvent" ADD VALUE 'secret_deleted';

-- CreateTable
CREATE TABLE "secrets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "last_four" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_secrets_team" ON "secrets"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_team_id_name_key" ON "secrets"("team_id", "name");

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
