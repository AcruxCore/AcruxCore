-- CreateEnum
CREATE TYPE "provider_kind" AS ENUM ('openai', 'anthropic', 'openai_compatible');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'provider_connection_created';
ALTER TYPE "AuditEvent" ADD VALUE 'provider_connection_deleted';

-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';

-- CreateTable
CREATE TABLE "provider_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "provider" "provider_kind" NOT NULL,
    "label" TEXT NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "key_last_four" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_provider_connections_team" ON "provider_connections"("team_id");

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
