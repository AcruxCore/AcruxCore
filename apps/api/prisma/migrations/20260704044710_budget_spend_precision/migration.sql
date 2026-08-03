-- AlterTable
ALTER TABLE "budgets" ALTER COLUMN "spend_usd" SET DATA TYPE DECIMAL(18,9);

-- AlterTable
ALTER TABLE "team_invites" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';
