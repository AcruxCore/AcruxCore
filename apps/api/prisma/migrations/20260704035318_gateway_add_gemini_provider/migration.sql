-- AlterEnum
ALTER TYPE "provider_kind" ADD VALUE 'gemini';

-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';
