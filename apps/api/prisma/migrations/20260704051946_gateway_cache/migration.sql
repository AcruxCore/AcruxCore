-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';

-- CreateTable
CREATE TABLE "gateway_cache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "cache_key" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "completion_tokens" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gateway_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_gateway_cache_expiry" ON "gateway_cache"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_gateway_cache_team_key" ON "gateway_cache"("team_id", "cache_key");

-- AddForeignKey
ALTER TABLE "gateway_cache" ADD CONSTRAINT "gateway_cache_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
