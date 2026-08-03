-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'gateway_model_created';
ALTER TYPE "AuditEvent" ADD VALUE 'gateway_model_updated';
ALTER TYPE "AuditEvent" ADD VALUE 'gateway_model_deleted';

-- AlterTable
ALTER TABLE "gateway_requests" ADD COLUMN     "gateway_model_id" UUID;

-- CreateTable
CREATE TABLE "gateway_models" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "public_name" TEXT NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "credential_id" UUID NOT NULL,
    "input_price_per_m" DECIMAL(12,4),
    "output_price_per_m" DECIMAL(12,4),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_model_fallbacks" (
    "model_id" UUID NOT NULL,
    "fallback_model_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "gateway_model_fallbacks_pkey" PRIMARY KEY ("model_id","fallback_model_id")
);

-- CreateIndex
CREATE INDEX "idx_gateway_models_team" ON "gateway_models"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_models_team_id_public_name_key" ON "gateway_models"("team_id", "public_name");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_model_fallbacks_model_id_position_key" ON "gateway_model_fallbacks"("model_id", "position");

-- AddForeignKey
ALTER TABLE "gateway_models" ADD CONSTRAINT "gateway_models_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_models" ADD CONSTRAINT "gateway_models_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_models" ADD CONSTRAINT "gateway_models_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_model_fallbacks" ADD CONSTRAINT "gateway_model_fallbacks_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "gateway_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_model_fallbacks" ADD CONSTRAINT "gateway_model_fallbacks_fallback_model_id_fkey" FOREIGN KEY ("fallback_model_id") REFERENCES "gateway_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_requests" ADD CONSTRAINT "gateway_requests_gateway_model_id_fkey" FOREIGN KEY ("gateway_model_id") REFERENCES "gateway_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
