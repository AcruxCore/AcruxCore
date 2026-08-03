-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'personal',
ALTER COLUMN "user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "team_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "roles" TEXT[],
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now() + interval '7 days',
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_invites_token_key" ON "team_invites"("token");

-- CreateIndex
CREATE INDEX "idx_team_invites_token" ON "team_invites"("token");

-- CreateIndex
CREATE INDEX "idx_team_invites_team_id" ON "team_invites"("team_id");

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
