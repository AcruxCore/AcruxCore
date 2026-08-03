-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';

-- CreateTable
CREATE TABLE "gateway_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "virtual_key_id" UUID,
    "provider_connection_id" UUID,
    "provider" TEXT,
    "requested_model" TEXT NOT NULL,
    "resolved_model" TEXT,
    "status" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6),
    "latency_ms" INTEGER,
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "prompt_version_id" UUID,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_gateway_requests_team_time" ON "gateway_requests"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_gateway_requests_key_time" ON "gateway_requests"("virtual_key_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "gateway_requests" ADD CONSTRAINT "gateway_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_requests" ADD CONSTRAINT "gateway_requests_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_requests" ADD CONSTRAINT "gateway_requests_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
