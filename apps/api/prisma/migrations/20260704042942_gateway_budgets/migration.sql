-- CreateEnum
CREATE TYPE "budget_period" AS ENUM ('day', 'week', 'month', 'total');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'budget_created';
ALTER TYPE "AuditEvent" ADD VALUE 'budget_updated';

-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "virtual_key_id" UUID,
    "period" "budget_period" NOT NULL,
    "limit_usd" DECIMAL(12,4) NOT NULL,
    "spend_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "resets_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_budgets_team" ON "budgets"("team_id");

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_virtual_key_id_fkey" FOREIGN KEY ("virtual_key_id") REFERENCES "virtual_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
