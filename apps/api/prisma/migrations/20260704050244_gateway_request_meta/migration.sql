-- AlterTable
ALTER TABLE "gateway_requests" ADD COLUMN     "meta" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';
